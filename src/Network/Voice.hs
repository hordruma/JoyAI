{-# LANGUAGE OverloadedStrings #-}

-- | Client for the Joy AI voice service (@tts/server.py@), which reads
-- a comment aloud with Piper in the delivery that belongs to a face.
--
-- The service is optional. Without it, payloads go out with no
-- recording and the frontend falls back to the browser's own voices.
module Network.Voice
  ( VoiceConfig (..)
  , Clip (..)
  , synthesize
  ) where

import Control.Monad.Except (ExceptT, throwError)
import Data.Aeson           (eitherDecodeStrict, object, (.=))
import qualified Data.ByteString.Lazy as LBS
import Data.Maybe           (listToMaybe)
import qualified Data.Text as T
import Data.Text            (Text)
import Network.HTTP.Client   (responseTimeoutMicro)
import Network.HTTP.Simple

import Network.Tavily (httpOrThrow, parseRequestSafe)
import Types

-- | Where the voice service listens.
newtype VoiceConfig = VoiceConfig
  { voiceEndpoint :: Text  -- ^ full URL of its @/speak@ endpoint
  }

-- | One reading: the audio itself and its word timings.
data Clip = Clip
  { clipAudio :: !LBS.ByteString        -- ^ a complete WAV file
  , clipWords :: ![(Double, Double)]    -- ^ start and end of each word, seconds
  }

-- | Have a face read a text aloud.
synthesize
  :: VoiceConfig
  -> AvatarTarget
  -> Text  -- ^ what to say
  -> ExceptT PipelineError IO Clip
synthesize config avatar text = do
  baseReq <- parseRequestSafe ("POST " <> T.unpack (voiceEndpoint config))
  let request = setRequestBodyJSON (object
                  [ "text" .= text
                  , "avatar" .= avatar
                  ])
              -- Synthesis is CPU-bound and slower than real time on a
              -- small machine; give it room.
              $ setRequestResponseTimeout (responseTimeoutMicro 120000000)
                baseReq
  response <- httpOrThrow request
  let status = getResponseStatusCode response
      audio  = getResponseBody response
  if status /= 200
    then throwError (VoiceError ("voice service returned HTTP " <> T.pack (show status)))
    else if LBS.null audio
      then throwError (VoiceError "voice service returned no audio")
      else case listToMaybe (getResponseHeader "X-Joyai-Words" response) of
        -- Timings are a refinement: without them the frontend
        -- estimates.
        Nothing  -> pure (Clip audio [])
        Just raw -> case eitherDecodeStrict raw of
          Right times -> pure (Clip audio times)
          Left err    -> throwError (ParseError ("word timings: " <> T.pack err))
