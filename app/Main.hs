{-# LANGUAGE OverloadedStrings #-}

-- | Joy AI pipeline entry point.
--
-- Runs a WebSocket broadcast server on port 8080 and a polling event
-- loop: every cycle it fetches a batch of comments from Tavily,
-- annotates them (sentiment + Toki Pona) through the LLM engine, and
-- broadcasts the resulting 'CommentPayload' JSON frames to every
-- subscribed frontend client. The frontend and a health endpoint are
-- served on port 8081.
module Main (main) where

import Control.Concurrent       (forkIO, threadDelay)
import Control.Concurrent.MVar
import Control.Exception        (SomeException, try)
import Control.Monad            (forever, forM_, void, when)
import Control.Monad.Except     (runExceptT)
import qualified Data.Aeson as Aeson
import qualified Data.List as List
import Data.Text                (Text)
import qualified Data.Text as T
import qualified Data.Text.IO as TIO
import qualified Data.Text.Lazy as TL
import qualified Network.WebSockets as WS
import System.Environment       (lookupEnv)
import System.Exit              (exitFailure)
import System.FilePath          (takeFileName, (</>))
import System.IO                (hPutStrLn, stderr)
import Web.Scotty               (ActionM, file, get, json, param, scotty,
                                 setHeader)

import Network.LLM    (LLMConfig (..), annotateComment)
import Network.Tavily (fetchComments)
import Types

-- | Connected frontend clients, keyed for removal on disconnect.
type Clients = MVar [(Int, WS.Connection)]

wsPort :: Int
wsPort = 8080

httpPort :: Int
httpPort = 8081

pollIntervalSeconds :: Int
pollIntervalSeconds = 60

searchQuery :: Text
searchQuery = "generative AI controversy opinions comments"

-- | Default to GLM (Z.ai) — the cheapest usable tier for this workload.
-- Point LLM_BASE_URL/LLM_MODEL at Kimi (Moonshot), DeepSeek, OpenRouter,
-- or any other OpenAI-compatible endpoint to switch providers.
defaultLLMEndpoint :: Text
defaultLLMEndpoint = "https://api.z.ai/api/paas/v4/chat/completions"

defaultLLMModel :: Text
defaultLLMModel = "glm-4.5-air"

main :: IO ()
main = do
  tavilyKey <- requireEnv "TAVILY_API_KEY"
  llmKey    <- requireEnv "LLM_API_KEY"
  endpoint  <- envOrDefault "LLM_BASE_URL" defaultLLMEndpoint
  model     <- envOrDefault "LLM_MODEL" defaultLLMModel
  let llmConfig = LLMConfig
        { llmEndpoint = endpoint
        , llmApiKey   = llmKey
        , llmModel    = model
        }
  clients <- newMVar []
  nextId  <- newMVar (0 :: Int)
  void . forkIO $ scotty httpPort $ do
    get "/health" $ json (Aeson.object ["status" Aeson..= ("ok" :: Text)])
    get "/" $ do
      setHeader "Content-Type" "text/html; charset=utf-8"
      file "frontend/index.html"
    get "/vendor/:name" (serveStatic "frontend/vendor")
    get "/assets/:name" (serveStatic "frontend/assets")
  void . forkIO $ pipelineLoop tavilyKey llmConfig clients
  logLine ("LLM engine: " <> model <> " @ " <> endpoint)
  logLine ("Frontend on port " <> T.pack (show httpPort)
           <> ", WebSocket broadcast on port " <> T.pack (show wsPort))
  WS.runServer "0.0.0.0" wsPort (serveClient clients nextId)

-- | Serve one file from a fixed directory. 'takeFileName' collapses any
-- path components in the parameter, so traversal outside the directory
-- is impossible.
serveStatic :: FilePath -> ActionM ()
serveStatic dir = do
  requested <- param "name"
  let name = takeFileName requested
  setHeader "Content-Type" (mimeFor name)
  file (dir </> name)

mimeFor :: FilePath -> TL.Text
mimeFor name
  | ".js"   `List.isSuffixOf` name = "text/javascript; charset=utf-8"
  | ".wasm" `List.isSuffixOf` name = "application/wasm"
  | ".glb"  `List.isSuffixOf` name = "model/gltf-binary"
  | otherwise                      = "application/octet-stream"

requireEnv :: String -> IO Text
requireEnv name = do
  value <- lookupEnv name
  case value of
    Just v | not (null v) -> pure (T.pack v)
    _ -> do
      hPutStrLn stderr ("Missing required environment variable: " <> name)
      exitFailure

envOrDefault :: String -> Text -> IO Text
envOrDefault name fallback = do
  value <- lookupEnv name
  pure $ case value of
    Just v | not (null v) -> T.pack v
    _                     -> fallback

-- | Register a client and hold the connection open until it drops.
serveClient :: Clients -> MVar Int -> WS.ServerApp
serveClient clients nextId pending = do
  connection <- WS.acceptRequest pending
  clientId   <- modifyMVar nextId (\n -> pure (n + 1, n))
  modifyMVar_ clients (pure . ((clientId, connection) :))
  logLine ("Client " <> T.pack (show clientId) <> " connected")
  WS.withPingThread connection 30 (pure ()) $ do
    outcome <- try (forever (void (WS.receiveDataMessage connection)))
      :: IO (Either SomeException ())
    case outcome of
      Left _  -> pure ()
      Right _ -> pure ()
  modifyMVar_ clients (pure . filter ((/= clientId) . fst))
  logLine ("Client " <> T.pack (show clientId) <> " disconnected")

-- | The ingest → annotate → broadcast event loop. Errors are logged and
-- the loop continues; nothing here can kill the WebSocket server.
pipelineLoop :: Text -> LLMConfig -> Clients -> IO ()
pipelineLoop tavilyKey llmConfig clients = forever $ do
  result <- runExceptT (fetchComments tavilyKey searchQuery)
  case result of
    Left err -> logLine ("Ingest failed: " <> T.pack (show err))
    Right comments -> do
      when (null comments) (logLine "Ingest returned no usable comments")
      forM_ (take 5 comments) $ \comment -> do
        processed <- runExceptT (annotateComment llmConfig comment)
        case processed of
          Left err      -> logLine ("Annotation failed: " <> T.pack (show err))
          Right payload -> broadcast clients payload
  threadDelay (pollIntervalSeconds * 1000000)

-- | Serialize a payload and emit it to all subscribed clients, pruning
-- any connection that fails mid-send.
broadcast :: Clients -> CommentPayload -> IO ()
broadcast clients payload = do
  let frame = Aeson.encode payload
  subscribers <- readMVar clients
  forM_ subscribers $ \(clientId, connection) -> do
    outcome <- try (WS.sendTextData connection frame)
      :: IO (Either SomeException ())
    case outcome of
      Left _  -> modifyMVar_ clients (pure . filter ((/= clientId) . fst))
      Right _ -> pure ()
  logLine ("Broadcast payload for avatar " <> T.pack (show (targetAvatar payload))
           <> " to " <> T.pack (show (length subscribers)) <> " client(s)")

logLine :: Text -> IO ()
logLine = TIO.putStrLn . ("[joyai] " <>)
