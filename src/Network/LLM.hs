{-# LANGUAGE DeriveGeneric     #-}
{-# LANGUAGE OverloadedStrings #-}

-- | LLM inversion engine, backed by the Claude API.
--
-- Each comment is submitted to @POST \/v1\/messages@ with a JSON-schema
-- structured-output constraint, so the response is guaranteed to match
-- the inversion contract:
--
-- > { "original_sentiment": "Positive",
-- >   "sentiment_score": 0.85,
-- >   "inverted_meaning_text": "...",
-- >   "toki_pona_text": "..." }
module Network.LLM
  ( invertComment
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
import Network.Tavily (httpOrThrow)
import Types

-- | Structured response demanded from the LLM (section 4.2 of the spec).
data LLMInversion = LLMInversion
  { original_sentiment    :: Text
  , sentiment_score       :: Double
  , inverted_meaning_text :: Text
  , toki_pona_text        :: Maybe Text
  } deriving (Show, Generic)

instance FromJSON LLMInversion

-- | Minimal projection of a Claude Messages API response.
data ClaudeContentBlock = ClaudeContentBlock
  { blockType :: Text
  , blockText :: Maybe Text
  } deriving (Show)

instance FromJSON ClaudeContentBlock where
  parseJSON = withObject "ClaudeContentBlock" $ \o ->
    ClaudeContentBlock <$> o .: "type" <*> o .:? "text"

data ClaudeResponse = ClaudeResponse
  { respContent    :: [ClaudeContentBlock]
  , respStopReason :: Maybe Text
  } deriving (Show)

instance FromJSON ClaudeResponse where
  parseJSON = withObject "ClaudeResponse" $ \o ->
    ClaudeResponse <$> o .: "content" <*> o .:? "stop_reason"

systemPrompt :: Text
systemPrompt = T.unwords
  [ "You process internet comments about generative AI for an art"
  , "installation. For each comment: score its sentiment toward AI"
  , "(Positive, Negative, or Neutral, with a 0-1 intensity score),"
  , "then write inverted_meaning_text that expresses the OPPOSITE"
  , "sentiment. Negative comments become manic, hyper-joyful text;"
  , "positive comments become weeping, existential despair. Then"
  , "translate the inverted text into Toki Pona as toki_pona_text."
  ]

inversionSchema :: Value
inversionSchema = object
  [ "type" .= ("json_schema" :: Text)
  , "schema" .= object
      [ "type" .= ("object" :: Text)
      , "properties" .= object
          [ "original_sentiment" .= object
              [ "type" .= ("string" :: Text)
              , "enum" .= (["Positive", "Negative", "Neutral"] :: [Text])
              ]
          , "sentiment_score" .= object ["type" .= ("number" :: Text)]
          , "inverted_meaning_text" .= object ["type" .= ("string" :: Text)]
          , "toki_pona_text" .= object ["type" .= ("string" :: Text)]
          ]
      , "required" .=
          ([ "original_sentiment"
           , "sentiment_score"
           , "inverted_meaning_text"
           , "toki_pona_text"
           ] :: [Text])
      , "additionalProperties" .= False
      ]
  ]

-- | Run one comment through the inversion engine and assemble the
-- outbound payload. Avatar routing comes from the pure logic core, not
-- from the LLM.
invertComment
  :: Text  -- ^ Anthropic API key
  -> Text  -- ^ cleaned comment text
  -> ExceptT PipelineError IO InvertedPayload
invertComment apiKey comment = do
  let requestBody = object
        [ "model" .= ("claude-opus-5" :: Text)
        , "max_tokens" .= (2048 :: Int)
        , "system" .= systemPrompt
        , "output_config" .= object ["format" .= inversionSchema]
        , "messages" .=
            [ object
                [ "role" .= ("user" :: Text)
                , "content" .= comment
                ]
            ]
        ]
      request = setRequestMethod "POST"
              $ setRequestSecure True
              $ setRequestPort 443
              $ setRequestHost "api.anthropic.com"
              $ setRequestPath "/v1/messages"
              $ setRequestHeader "x-api-key" [TE.encodeUtf8 apiKey]
              $ setRequestHeader "anthropic-version" ["2023-06-01"]
              $ setRequestHeader "Content-Type" ["application/json"]
              $ setRequestBodyJSON requestBody
                defaultRequest
  response <- httpOrThrow request
  let status = getResponseStatusCode response
  if status /= 200
    then throwError (HttpError ("Claude API returned HTTP " <> T.pack (show status)))
    else decodeInversion comment (getResponseBody response)

decodeInversion
  :: Text
  -> LBS.ByteString
  -> ExceptT PipelineError IO InvertedPayload
decodeInversion comment body = case eitherDecode body of
  Left err -> throwError (ParseError ("Claude response: " <> T.pack err))
  Right resp
    | respStopReason resp == Just "refusal" ->
        throwError (LLMError "Claude declined this comment (stop_reason: refusal)")
    | otherwise ->
        case firstText resp of
          Nothing -> throwError (LLMError "Claude response contained no text block")
          Just t  -> case eitherDecode (LBS.fromStrict (TE.encodeUtf8 t)) of
            Left err -> throwError (ParseError ("Inversion JSON: " <> T.pack err))
            Right inv -> pure (toPayload comment inv)
  where
    firstText resp = listToMaybe
      (mapMaybe blockText (filter ((== "text") . blockType) (respContent resp)))

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
