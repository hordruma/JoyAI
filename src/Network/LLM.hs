{-# LANGUAGE DeriveGeneric     #-}
{-# LANGUAGE OverloadedStrings #-}

-- | LLM annotation engine, backed by any OpenAI-compatible
-- chat-completions API (GLM \/ Z.ai by default; Kimi \/ Moonshot,
-- DeepSeek, OpenRouter, etc. via configuration).
--
-- The LLM never rewrites the comment — it only scores sentiment and
-- produces a faithful Toki Pona translation:
--
-- > { "sentiment": "Positive",
-- >   "sentiment_score": 0.85,
-- >   "toki_pona_text": "..." }
module Network.LLM
  ( LLMConfig (..)
  , annotateComment
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

-- | Structured annotation demanded from the LLM.
data LLMAnnotation = LLMAnnotation
  { annotated_sentiment :: Text
  , sentiment_score     :: Double
  , toki_pona_text      :: Maybe Text
  } deriving (Show, Generic)

instance FromJSON LLMAnnotation where
  parseJSON = withObject "LLMAnnotation" $ \o ->
    LLMAnnotation
      <$> o .: "sentiment"
      <*> o .: "sentiment_score"
      <*> o .:? "toki_pona_text"

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
  [ "You annotate internet comments about generative AI for an art"
  , "installation. For each comment do exactly two things:"
  , ""
  , "1. Score the comment's sentiment toward AI: Positive, Negative,"
  , "   or Neutral, with a 0-1 intensity score."
  , "2. Translate the comment into Toki Pona as faithfully as possible."
  , "   Do NOT soften, invert, or editorialize — preserve the meaning."
  , ""
  , "Respond with ONLY a JSON object, no prose, in exactly this shape:"
  , "{\"sentiment\": \"Positive\" | \"Negative\" | \"Neutral\","
  , " \"sentiment_score\": <number between 0 and 1>,"
  , " \"toki_pona_text\": \"<faithful toki pona translation>\"}"
  ]

-- | Run one comment through the annotation engine and assemble the
-- outbound payload. The comment text passes through verbatim; avatar
-- routing (the intonation juxtaposition) comes from the pure logic
-- core, not from the LLM.
annotateComment
  :: LLMConfig
  -> Text  -- ^ cleaned comment text
  -> ExceptT PipelineError IO CommentPayload
annotateComment config comment = do
  baseReq <- parseRequestSafe ("POST " <> T.unpack (llmEndpoint config))
  let requestBody = object
        [ "model" .= llmModel config
        , "temperature" .= (0.3 :: Double)
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
    else decodeAnnotation comment (getResponseBody response)

decodeAnnotation
  :: Text
  -> LBS.ByteString
  -> ExceptT PipelineError IO CommentPayload
decodeAnnotation comment body = case eitherDecode body of
  Left err -> throwError (ParseError ("LLM response: " <> T.pack err))
  Right resp ->
    case firstContent resp of
      Nothing -> throwError (LLMError "LLM response contained no message content")
      Just t  -> case eitherDecode (LBS.fromStrict (TE.encodeUtf8 (stripFences t))) of
        Left err  -> throwError (ParseError ("Annotation JSON: " <> T.pack err))
        Right ann -> pure (toPayload comment ann)
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

toPayload :: Text -> LLMAnnotation -> CommentPayload
toPayload comment ann = buildPayload comment score tokiPona
  where
    score = case annotated_sentiment ann of
      "Positive" -> Positive (sentiment_score ann)
      "Negative" -> Negative (sentiment_score ann)
      _          -> Neutral
    tokiPona = case toki_pona_text ann of
      Just t | not (T.null t) -> Just t
      _                       -> Nothing
