{-# LANGUAGE OverloadedStrings #-}

-- | Tavily search ingestion: POSTs against the Tavily search API,
-- parses the payload strictly via Aeson, and strips dirty HTML\/URLs to
-- construct clean text streams.
module Network.Tavily
  ( TavilyConfig (..)
  , fetchComments
  , cleanText
  , httpOrThrow
  , parseRequestSafe
  ) where

import Control.Exception      (try)
import Control.Monad.Except   (ExceptT, throwError)
import Control.Monad.IO.Class (liftIO)
import Data.Aeson             (FromJSON (..), eitherDecode, object,
                               withObject, (.!=), (.:), (.:?), (.=))
import qualified Data.ByteString.Lazy as LBS
import Data.Char              (isAlpha, isSpace)
import qualified Data.Text as T
import Data.Text              (Text)
import qualified Data.Text.Encoding as TE
import Network.HTTP.Simple

import Logic (excerpt, sourceHost)
import Types

-- | Connection settings for the search endpoint.
data TavilyConfig = TavilyConfig
  { tavilyEndpoint :: !Text  -- ^ full search URL
  , tavilyApiKey   :: !Text  -- ^ bearer token
  }

data TavilyResult = TavilyResult
  { resultContent :: Text
  , resultUrl     :: Maybe Text
  }

instance FromJSON TavilyResult where
  parseJSON = withObject "TavilyResult" $ \o ->
    TavilyResult
      <$> o .:? "content" .!= ""
      <*> o .:? "url"

newtype TavilyResponse = TavilyResponse [TavilyResult]

instance FromJSON TavilyResponse where
  parseJSON = withObject "TavilyResponse" $ \o ->
    TavilyResponse <$> o .: "results"

-- | The longest thing a face will be asked to read.
speakableLength :: Int
speakableLength = 320

-- | Query Tavily for real-time commentary and return cleaned comments.
-- All failure paths surface as 'PipelineError' in 'ExceptT'.
fetchComments
  :: TavilyConfig
  -> Text  -- ^ search query (AI-opinion focused)
  -> ExceptT PipelineError IO [RawComment]
fetchComments config query = do
  baseReq <- parseRequestSafe ("POST " <> T.unpack (tavilyEndpoint config))
  let request = setRequestBodyJSON body
              $ setRequestHeader "Authorization"
                  ["Bearer " <> TE.encodeUtf8 (tavilyApiKey config)]
              $ setRequestHeader "Content-Type" ["application/json"]
                baseReq
      body = object
        [ "query" .= query
        , "search_depth" .= ("basic" :: Text)
        , "max_results" .= (8 :: Int)
        ]
  response <- httpOrThrow request
  let status = getResponseStatusCode response
  if status /= 200
    then throwError (HttpError ("Tavily returned HTTP " <> T.pack (show status)))
    else case eitherDecode (getResponseBody response) of
      Left err -> throwError (ParseError ("Tavily payload: " <> T.pack err))
      Right (TavilyResponse rs) ->
        pure (filter (not . T.null . rawText) (fmap toComment rs))
  where
    toComment r = RawComment
      { rawText   = excerpt speakableLength (cleanText (resultContent r))
      , rawSource = resultUrl r >>= sourceHost
      }

parseRequestSafe :: String -> ExceptT PipelineError IO Request
parseRequestSafe url = do
  result <- liftIO (try (parseRequest url)
    :: IO (Either HttpException Request))
  either (throwError . HttpError . T.pack . show) pure result

-- | Run an HTTP request, converting transport exceptions into
-- 'PipelineError' instead of letting them kill the calling thread.
httpOrThrow
  :: Request
  -> ExceptT PipelineError IO (Response LBS.ByteString)
httpOrThrow request = do
  result <- liftIO (try (httpLBS request)
    :: IO (Either HttpException (Response LBS.ByteString)))
  either (throwError . HttpError . T.pack . show) pure result

-- | Strip HTML tags and URLs from raw comment text, decode the common
-- entities, and collapse the leftover whitespace. Pure.
cleanText :: Text -> Text
cleanText = collapseSpaces . dropUrls . decodeEntities . dropTags
  where
    dropTags t = case T.breakOn "<" t of
      (before, rest)
        | T.null rest -> before
        | otherwise   -> case T.breakOn ">" rest of
            (tag, after)
              | not (T.null after) && looksLikeTag tag ->
                  before <> " " <> dropTags (T.drop 1 after)
              -- A bare "<" ("2 < 3") is text, not markup.
              | otherwise -> before <> "<" <> dropTags (T.drop 1 rest)
    looksLikeTag tag = case T.uncons (T.drop 1 tag) of
      Just (c, _) -> isAlpha c || c == '/' || c == '!'
      Nothing     -> False
    decodeEntities t = foldl (\acc (from, to) -> T.replace from to acc) t
      [ ("&nbsp;", " "), ("&quot;", "\""), ("&#39;", "'"), ("&apos;", "'")
      , ("&lt;", "<"), ("&gt;", ">"), ("&amp;", "&") ]
    dropUrls =
      T.unwords . filter (not . isUrl) . T.words
    isUrl w =
      "http://" `T.isPrefixOf` w || "https://" `T.isPrefixOf` w
    collapseSpaces =
      T.unwords . T.words . T.map (\c -> if isSpace c then ' ' else c)
