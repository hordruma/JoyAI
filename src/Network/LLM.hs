{-# LANGUAGE DeriveGeneric     #-}
{-# LANGUAGE OverloadedStrings #-}

-- | LLM inversion engine, backed by any OpenAI-compatible
-- chat-completions API (GLM \/ Z.ai by default; Kimi \/ Moonshot,
-- DeepSeek, OpenRouter, etc. via configuration).
--
-- Each comment is submitted with JSON-object response mode and a strict
-- schema in the system prompt, so the response matches the inversion
-- contract:
--
-- > { "original_sentiment": "Positive",
-- >   "sentiment_score": 0.85,
-- >   "inverted_meaning_text": "...",
-- >   "toki_pona_text": "..." }
module Network.LLM
  ( LLMConfig (..)
  , invertComment
  ) where

import Control.Monad.Except (ExceptT, throwError)
import Data.Aeson
import qualified Data.ByteString.Lazy as LBS
import Data.Maybe           (listToMaybe, mapMaybe)
import qualified Data.Text as T
import Data.Text            (Text)
import qualified Data.Text.Encoding as TE
import GHC.Generics         (Generic)
import Network.HTTP.Simple

import Logic          (buildPayload)
import Network.Tavily (httpOrThrow, parseRequestSafe)
import Types

-- | Connection settings for the chat-completions endpoint.
data LLMConfig = LLMConfig
  { llmEndpoint :: !Text  -- ^ full chat-completions URL
  , llmApiKey   :: !Text  -- ^ bearer token
  , llmModel    :: !Text  -- ^ model identifier, e.g. @glm-4.5-air@ or @kimi-k2-0905-preview@
  } deriving (Show)

-- | Structured response demanded from the LLM (section 4.2 of the spec).
data LLMInversion = LLMInversion
  { original_sentiment    :: Text
  , sentiment_score       :: Double
  , inverted_meaning_text :: Text
  , toki_pona_text        :: Maybe Text
  } deriving (Show, Generic)

instance FromJSON LLMInversion

-- | Minimal projection of an OpenAI-compatible chat completion.
newtype ChatChoice = ChatChoice
  { choiceContent :: Maybe Text
  } deriving (Show)

instance FromJSON ChatChoice where
  parseJSON = withObject "ChatChoice" $ \o -> do
    message <- o .: "message"
    ChatChoice <$> message .:? "content"

newtype ChatResponse = ChatResponse
  { respChoices :: [ChatChoice]
  } deriving (Show)

instance FromJSON ChatResponse where
  parseJSON = withObject "ChatResponse" $ \o ->
    ChatResponse <$> o .: "choices"

systemPrompt :: Text
systemPrompt = T.unlines
  [ "You process internet comments about generative AI for an art"
  , "installation. For each comment: score its sentiment toward AI"
  , "(Positive, Negative, or Neutral, with a 0-1 intensity score),"
  , "then write inverted_meaning_text expressing the OPPOSITE"
  , "sentiment. Negative comments become manic, hyper-joyful text;"
  , "positive comments become weeping, existential despair. Then"
  , "translate the inverted text into Toki Pona as toki_pona_text."
  , ""
  , "Respond with ONLY a JSON object, no prose, in exactly this shape:"
  , "{\"original_sentiment\": \"Positive\" | \"Negative\" | \"Neutral\","
  , " \"sentiment_score\": <number between 0 and 1>,"
  , " \"inverted_meaning_text\": \"<inverted text>\","
  , " \"toki_pona_text\": \"<toki pona translation>\"}"
  ]

-- | Run one comment through the inversion engine and assemble the
-- outbound payload. Avatar routing comes from the pure logic core, not
-- from the LLM.
invertComment
  :: LLMConfig
  -> Text  -- ^ cleaned comment text
  -> ExceptT PipelineError IO InvertedPayload
invertComment config comment = do
  baseReq <- parseRequestSafe ("POST " <> T.unpack (llmEndpoint config))
  let requestBody = object
        [ "model" .= llmModel config
        , "temperature" .= (0.7 :: Double)
        , "response_format" .= object ["type" .= ("json_object" :: Text)]
        , "messages" .=
            [ object
                [ "role" .= ("system" :: Text)
                , "content" .= systemPrompt
                ]
            , object
                [ "role" .= ("user" :: Text)
                , "content" .= comment
                ]
            ]
        ]
      request = setRequestHeader "Authorization"
                  ["Bearer " <> TE.encodeUtf8 (llmApiKey config)]
              $ setRequestHeader "Content-Type" ["application/json"]
              $ setRequestBodyJSON requestBody
                baseReq
  response <- httpOrThrow request
  let status = getResponseStatusCode response
  if status /= 200
    then throwError (HttpError ("LLM API returned HTTP " <> T.pack (show status)))
    else decodeInversion comment (getResponseBody response)

decodeInversion
  :: Text
  -> LBS.ByteString
  -> ExceptT PipelineError IO InvertedPayload
decodeInversion comment body = case eitherDecode body of
  Left err -> throwError (ParseError ("LLM response: " <> T.pack err))
  Right resp ->
    case firstContent resp of
      Nothing -> throwError (LLMError "LLM response contained no message content")
      Just t  -> case eitherDecode (LBS.fromStrict (TE.encodeUtf8 (stripFences t))) of
        Left err  -> throwError (ParseError ("Inversion JSON: " <> T.pack err))
        Right inv -> pure (toPayload comment inv)
  where
    firstContent = listToMaybe . mapMaybe choiceContent . respChoices

-- | Some models wrap JSON-mode output in Markdown code fences anyway.
stripFences :: Text -> Text
stripFences t =
  let stripped = T.strip t
      unfenced = case T.stripPrefix "```json" stripped of
        Just rest -> rest
        Nothing   -> case T.stripPrefix "```" stripped of
          Just rest -> rest
          Nothing   -> stripped
  in T.strip (maybe unfenced id (T.stripSuffix "```" (T.strip unfenced)))

toPayload :: Text -> LLMInversion -> InvertedPayload
toPayload comment inv =
  buildPayload comment sentiment (inverted_meaning_text inv) tokiPona
  where
    sentiment = case original_sentiment inv of
      "Positive" -> Positive (sentiment_score inv)
      "Negative" -> Negative (sentiment_score inv)
      _          -> Neutral
    tokiPona = case toki_pona_text inv of
      Just t | not (T.null t) -> Just t
      _                       -> Nothing
