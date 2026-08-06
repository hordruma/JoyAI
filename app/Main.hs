{-# LANGUAGE OverloadedStrings #-}

-- | SadClown pipeline entry point.
--
-- Runs a WebSocket broadcast server on port 8080 and a polling event
-- loop: every cycle it fetches a batch of comments from Tavily, runs
-- them through the pure logic core and the LLM inversion engine, and
-- broadcasts the resulting 'InvertedPayload' JSON frames to every
-- subscribed frontend client. A Scotty health endpoint runs on 8081.
module Main (main) where

import Control.Concurrent       (forkIO, threadDelay)
import Control.Concurrent.MVar
import Control.Exception        (SomeException, try)
import Control.Monad            (forever, forM_, void, when)
import Control.Monad.Except     (runExceptT)
import qualified Data.Aeson as Aeson
import Data.Text                (Text)
import qualified Data.Text as T
import qualified Data.Text.IO as TIO
import qualified Network.WebSockets as WS
import System.Environment       (lookupEnv)
import System.Exit              (exitFailure)
import System.IO                (hPutStrLn, stderr)
import Web.Scotty               (get, json, scotty)

import Network.LLM    (invertComment)
import Network.Tavily (fetchComments)
import Types

-- | Connected frontend clients, keyed for removal on disconnect.
type Clients = MVar [(Int, WS.Connection)]

wsPort :: Int
wsPort = 8080

healthPort :: Int
healthPort = 8081

pollIntervalSeconds :: Int
pollIntervalSeconds = 60

searchQuery :: Text
searchQuery = "generative AI controversy opinions comments"

main :: IO ()
main = do
  tavilyKey    <- requireEnv "TAVILY_API_KEY"
  anthropicKey <- requireEnv "ANTHROPIC_API_KEY"
  clients      <- newMVar []
  nextId       <- newMVar (0 :: Int)
  void . forkIO $ scotty healthPort $
    get "/health" $ json (Aeson.object ["status" Aeson..= ("ok" :: Text)])
  void . forkIO $ pipelineLoop tavilyKey anthropicKey clients
  logLine ("WebSocket broadcast server listening on port " <> T.pack (show wsPort))
  WS.runServer "0.0.0.0" wsPort (serveClient clients nextId)

requireEnv :: String -> IO Text
requireEnv name = do
  value <- lookupEnv name
  case value of
    Just v | not (null v) -> pure (T.pack v)
    _ -> do
      hPutStrLn stderr ("Missing required environment variable: " <> name)
      exitFailure

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

-- | The ingest → invert → broadcast event loop. Errors are logged and
-- the loop continues; nothing here can kill the WebSocket server.
pipelineLoop :: Text -> Text -> Clients -> IO ()
pipelineLoop tavilyKey anthropicKey clients = forever $ do
  result <- runExceptT (fetchComments tavilyKey searchQuery)
  case result of
    Left err -> logLine ("Ingest failed: " <> T.pack (show err))
    Right comments -> do
      when (null comments) (logLine "Ingest returned no usable comments")
      forM_ (take 5 comments) $ \comment -> do
        processed <- runExceptT (invertComment anthropicKey comment)
        case processed of
          Left err      -> logLine ("Inversion failed: " <> T.pack (show err))
          Right payload -> broadcast clients payload
  threadDelay (pollIntervalSeconds * 1000000)

-- | Serialize a payload and emit it to all subscribed clients, pruning
-- any connection that fails mid-send.
broadcast :: Clients -> InvertedPayload -> IO ()
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
logLine = TIO.putStrLn . ("[sadclown] " <>)
