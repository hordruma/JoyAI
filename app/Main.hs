{-# LANGUAGE OverloadedStrings #-}

-- | Joy AI entry point.
--
-- One port serves everything: the frontend as static files, a health
-- endpoint, and a WebSocket feed (any path; the frontend uses @/ws@).
-- Behind it runs a polling loop: each cycle fetches a batch of comments
-- from Tavily, annotates the ones not seen before (sentiment, plus an
-- English translation when needed) through the LLM engine, and
-- broadcasts the resulting 'CommentPayload' JSON frames to every
-- connected viewer. New viewers are first sent the most recent frames,
-- so the piece has something to say the moment it opens.
--
-- Without API keys the server still runs and serves the piece, which
-- can then be performed from its built-in rehearsal material.
module Main (main) where

import Control.Concurrent       (forkIO, threadDelay)
import Control.Concurrent.MVar
import Control.Exception        (SomeAsyncException, SomeException,
                                 finally, fromException, throwIO, try)
import Control.Monad            (foldM, forever, forM_, unless, void, when)
import Control.Monad.Except     (runExceptT)
import qualified Data.Aeson as Aeson
import qualified Data.ByteString.Lazy as LBS
import qualified Data.Map.Strict as Map
import Data.Maybe               (fromMaybe, listToMaybe)
import qualified Data.Set as Set
import Data.Text                (Text)
import qualified Data.Text as T
import qualified Data.Text.IO as TIO
import Network.HTTP.Types       (hCacheControl, hContentType, status200,
                                 status404)
import Network.Mime             (defaultMimeMap, defaultMimeType, mimeByExt)
import qualified Network.Wai as Wai
import Network.Wai.Application.Static
                                (defaultFileServerSettings, ssGetMimeType,
                                 ssListing, staticApp)
import qualified Network.Wai.Handler.Warp as Warp
import Network.Wai.Handler.WebSockets (websocketsOr)
import Network.Wai.Middleware.Gzip
                                (GzipFiles (GzipCompress), defaultGzipSettings,
                                 gzip, gzipFiles)
import qualified Network.WebSockets as WS
import System.Environment       (lookupEnv)
import System.IO                (BufferMode (LineBuffering), hSetBuffering,
                                 stdout)
import Text.Read                (readMaybe)
import WaiAppStatic.Types       (fileName, fromPiece)

import Logic          (spokenText)
import Network.LLM    (Dialect (..), LLMConfig (..), annotateComment)
import Network.Tavily (TavilyConfig (..), fetchComments)
import Network.Voice  (Clip (..), VoiceConfig (..), synthesize)
import Types

-- | Everything the broadcast side needs, behind one lock.
data Hub = Hub
  { hubClients :: !(Map.Map Int WS.Connection)
  , hubNextId  :: !Int
  , hubRecent  :: ![LBS.ByteString]  -- ^ newest first, bounded
  , hubClips   :: !(Map.Map Int LBS.ByteString)  -- ^ recorded readings, by number
  , hubNextClip :: !Int
  }

-- | How many recent frames a new viewer is caught up with.
replayDepth :: Int
replayDepth = 24

-- | How many recorded readings are kept in memory to be fetched. Enough
-- to cover the replay and some reprises; at a few hundred kilobytes
-- each this stays small.
clipDepth :: Int
clipDepth = 64

-- | New comments annotated per poll cycle. Bounds LLM spend.
perCycle :: Int
perCycle = 5

-- | The questions put to the internet, asked in rotation. Half are
-- phrased to find people who are angry or afraid, half to find people
-- who are delighted, so that both faces have something to read.
searchQueries :: [Text]
searchQueries =
  [ "generative AI controversy opinions comments"
  , "why I love using AI tools every day"
  , "artists react to AI art opinion"
  , "AI changed my life for the better"
  , "AI is taking jobs workers angry"
  , "AI will make the world better optimism"
  , "AI slop is ruining the internet"
  , "what do people honestly think about ChatGPT"
  ]

-- | Default to GLM (Z.ai) — the cheapest usable tier for this workload.
-- Point LLM_BASE_URL/LLM_MODEL at Kimi (Moonshot), DeepSeek, OpenRouter,
-- or any other OpenAI-compatible endpoint to switch providers.
defaultLLMEndpoint :: Text
defaultLLMEndpoint = "https://api.z.ai/api/paas/v4/chat/completions"

defaultLLMModel :: Text
defaultLLMModel = "glm-4.5-air"

-- | With @LLM_PROVIDER=anthropic@ the backend speaks the Claude Messages
-- API instead.
claudeEndpoint :: Text
claudeEndpoint = "https://api.anthropic.com/v1/messages"

claudeModel :: Text
claudeModel = "claude-opus-5-5"

defaultTavilyEndpoint :: Text
defaultTavilyEndpoint = "https://api.tavily.com/search"

main :: IO ()
main = do
  hSetBuffering stdout LineBuffering
  port        <- fromMaybe 8080 . (>>= readMaybe) <$> lookupEnv "PORT"
  pollSeconds <- max 5 . fromMaybe 60 . (>>= readMaybe) <$> lookupEnv "POLL_SECONDS"
  frontendDir <- fromMaybe "frontend" <$> lookupEnv "FRONTEND_DIR"
  tavilyKey   <- envText "TAVILY_API_KEY"
  provider    <- maybe "" T.toLower <$> envText "LLM_PROVIDER"
  let dialect = if provider `elem` ["anthropic", "claude"]
                  then ClaudeMessages else ChatCompletions
      (endpoint0, model0) = case dialect of
        ClaudeMessages  -> (claudeEndpoint, claudeModel)
        ChatCompletions -> (defaultLLMEndpoint, defaultLLMModel)
  genericKey  <- envText "LLM_API_KEY"
  claudeKey   <- envText "ANTHROPIC_API_KEY"
  let llmKey = case dialect of
        ClaudeMessages  -> maybe claudeKey Just genericKey
        ChatCompletions -> genericKey
  tavilyUrl   <- fromMaybe defaultTavilyEndpoint <$> envText "TAVILY_BASE_URL"
  endpoint    <- fromMaybe endpoint0 <$> envText "LLM_BASE_URL"
  model       <- fromMaybe model0 <$> envText "LLM_MODEL"
  voiceConfig <- fmap VoiceConfig <$> envText "TTS_URL"

  hub <- newMVar (Hub Map.empty 0 [] Map.empty 0)
  case (tavilyKey, llmKey) of
    (Just tk, Just lk) -> do
      let tavily = TavilyConfig { tavilyEndpoint = tavilyUrl, tavilyApiKey = tk }
          llm    = LLMConfig { llmDialect = dialect, llmEndpoint = endpoint
                             , llmApiKey = lk, llmModel = model }
      logLine ("LLM engine: " <> model <> " @ " <> endpoint)
      logLine (maybe "Voice: the browser's own (TTS_URL not set)"
                     (("Voice service: " <>) . voiceEndpoint) voiceConfig)
      void (forkIO (pipelineLoop pollSeconds tavily llm voiceConfig hub))
    _ -> logLine "TAVILY_API_KEY / LLM_API_KEY not set: no live feed, \
                 \serving the piece for rehearsal only"

  logLine ("Listening on port " <> T.pack (show port))
  Warp.runSettings (Warp.setPort port Warp.defaultSettings)
    (websocketsOr WS.defaultConnectionOptions (serveViewer hub) (httpApp hub frontendDir))

-- | A set, non-empty environment variable.
envText :: String -> IO (Maybe Text)
envText name = do
  value <- lookupEnv name
  pure $ case value of
    Just v | not (null v) -> Just (T.pack v)
    _                     -> Nothing

-- | Plain HTTP: a health check, recorded readings, and the frontend
-- directory. The static handler refuses paths that leave its root.
httpApp :: MVar Hub -> FilePath -> Wai.Application
httpApp hub dir = \request respond -> case Wai.pathInfo request of
  ["health"] -> respond (Wai.responseLBS status200
    [(hContentType, "application/json")] "{\"status\":\"ok\"}")
  ["voice", name] -> do
    clips <- hubClips <$> readMVar hub
    respond $ case T.stripSuffix ".wav" name >>= readMaybe . T.unpack >>= (`Map.lookup` clips) of
      Just audio -> Wai.responseLBS status200
        [ (hContentType, "audio/wav")
        , (hCacheControl, "public, max-age=86400, immutable") ] audio
      Nothing -> Wai.responseLBS status404
        [(hContentType, "text/plain")] "no such reading"
  _ -> static request respond
  where
    static = gzip defaultGzipSettings { gzipFiles = GzipCompress }
           $ staticApp settings
    settings = (defaultFileServerSettings dir)
      { ssListing     = Nothing
      , ssGetMimeType = pure . mimeByExt mimeMap defaultMimeType
                             . fromPiece . fileName
      }
    -- Browsers refuse a module script or a streamed WebAssembly module
    -- served with the wrong type.
    mimeMap = Map.union
      (Map.fromList
        [ ("js",   "text/javascript; charset=utf-8")
        , ("wasm", "application/wasm")
        , ("glb",  "model/gltf-binary")
        ])
      defaultMimeMap

-- | Register a viewer, catch them up, and hold the connection open
-- until it drops.
serveViewer :: MVar Hub -> WS.ServerApp
serveViewer hub pending = do
  connection <- WS.acceptRequest pending
  (viewer, backlog) <- modifyMVar hub $ \h ->
    let n = hubNextId h
    in pure ( h { hubClients = Map.insert n connection (hubClients h)
                , hubNextId  = n + 1 }
            , (n, reverse (hubRecent h)) )
  logLine ("Viewer " <> T.pack (show viewer) <> " connected")
  -- Ping well inside Warp's 30-second idle timeout, or it reaps the
  -- socket of anyone watching a quiet stretch.
  flip finally (leave viewer) $
    WS.withPingThread connection 15 (pure ()) $ do
      forM_ backlog (WS.sendTextData connection)
      -- Nothing is expected from viewers; reading is how we notice
      -- them leave.
      forever (void (WS.receiveDataMessage connection))
  where
    leave viewer = do
      modifyMVar_ hub (\h -> pure h { hubClients = Map.delete viewer (hubClients h) })
      logLine ("Viewer " <> T.pack (show viewer) <> " disconnected")

-- | The ingest → annotate → broadcast loop. Errors are logged and the
-- loop continues; nothing here can take the server down.
pipelineLoop
  :: Int -> TavilyConfig -> LLMConfig -> Maybe VoiceConfig -> MVar Hub -> IO ()
pipelineLoop pollSeconds tavily llm voiceConfig hub = go (0 :: Int) Set.empty
  where
    go n seen = do
      outcome <- try (pollOnce (queryFor n) seen)
      seen' <- case outcome of
        Right s -> pure s
        Left e
          | Just async <- fromException e -> throwIO (async :: SomeAsyncException)
          | otherwise -> do
              logLine ("Poll cycle failed: " <> T.pack (show (e :: SomeException)))
              pure seen
      threadDelay (pollSeconds * 1000000)
      -- Forget old material eventually rather than grow without bound.
      go (n + 1) (if Set.size seen' > 5000 then Set.empty else seen')

    queryFor n = fromMaybe "generative AI opinions"
      (listToMaybe (drop (n `mod` max 1 (length searchQueries)) searchQueries))

    pollOnce query seen = do
      result <- runExceptT (fetchComments tavily query)
      case result of
        Left err -> do
          logLine ("Ingest failed: " <> T.pack (show err))
          pure seen
        Right comments -> do
          let fresh = filter ((`Set.notMember` seen) . rawText) comments
          when (null fresh) (logLine ("Nothing new for: " <> query))
          foldM annotateOne seen (take perCycle fresh)

    -- A comment counts as seen once the LLM has ruled on it; one that
    -- failed in transit gets another chance on a later cycle.
    annotateOne seen comment = do
      processed <- runExceptT (annotateComment llm comment)
      case processed of
        Left err -> do
          logLine ("Annotation failed: " <> T.pack (show err))
          pure seen
        Right Nothing -> do
          logLine ("Neutral, left out: " <> T.take 70 (rawText comment))
          pure (Set.insert (rawText comment) seen)
        Right (Just payload) -> do
          voiced <- maybe (pure payload) (\vc -> record vc hub payload) voiceConfig
          broadcast hub voiced
          pure (Set.insert (rawText comment) seen)

-- | Have the comment read aloud and attach the recording. A voice that
-- fails costs the comment its recording, not its place in the piece.
record :: VoiceConfig -> MVar Hub -> CommentPayload -> IO CommentPayload
record config hub payload = do
  result <- runExceptT (synthesize config (targetAvatar payload) (spokenText payload))
  case result of
    Left err -> do
      logLine ("Voice failed: " <> T.pack (show err))
      pure payload
    Right clip -> do
      n <- modifyMVar hub $ \h ->
        let n = hubNextClip h
            kept = Map.insert n (clipAudio clip) (hubClips h)
            -- Numbers only go up, so the smallest keys are the oldest.
            trimmed = Map.drop (Map.size kept - clipDepth) kept
        in pure (h { hubClips = trimmed, hubNextClip = n + 1 }, n)
      pure payload
        { voice = Just Voice
            { audioUrl  = "/voice/" <> T.pack (show n) <> ".wav"
            , wordTimes = clipWords clip
            }
        }

-- | Serialize a payload, remember it for latecomers, and send it to
-- everyone connected. A viewer whose socket fails is dropped.
broadcast :: MVar Hub -> CommentPayload -> IO ()
broadcast hub payload = do
  let frame = Aeson.encode payload
  viewers <- modifyMVar hub $ \h ->
    pure ( h { hubRecent = take replayDepth (frame : hubRecent h) }
         , Map.toList (hubClients h) )
  failed <- fmap concat . mapM (send frame) $ viewers
  unless (null failed) $
    modifyMVar_ hub $ \h ->
      pure h { hubClients = foldr Map.delete (hubClients h) failed }
  logLine ("Broadcast for " <> T.pack (show (targetAvatar payload))
           <> " to " <> T.pack (show (length viewers - length failed))
           <> " viewer(s)")
  where
    send frame (viewer, connection) = do
      outcome <- try (WS.sendTextData connection frame)
      pure $ case outcome of
        Left e | Just async <- fromException e ->
                   const [viewer] (async :: SomeAsyncException)
               | otherwise -> const [viewer] (e :: SomeException)
        Right () -> []

logLine :: Text -> IO ()
logLine = TIO.putStrLn . ("[joyai] " <>)
