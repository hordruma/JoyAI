{-# LANGUAGE DeriveGeneric     #-}
{-# LANGUAGE OverloadedStrings #-}

-- | Tavily search ingestion: POSTs against the Tavily search API,
-- parses the payload strictly via Aeson, and strips dirty HTML\/URLs to
-- construct clean text streams.
module Network.Tavily
  ( fetchComments
  , cleanText
  , httpOrThrow
  , parseRequestSafe
  ) where

import Control.Exception      (try)
import Control.Monad.Except   (ExceptT, throwError)
import Control.Monad.IO.Class (liftIO)
import Data.Aeson             (FromJSON, eitherDecode, object, (.=))
import qualified Data.ByteString.Lazy as LBS
import Data.Char              (isSpace)
import qualified Data.Text as T
import Data.Text              (Text)
import GHC.Generics           (Generic)
import Network.HTTP.Simple

import Types

newtype TavilyResult = TavilyResult
  { content :: Text
  } deriving (Show, Generic)

instance FromJSON TavilyResult

newtype TavilyResponse = TavilyResponse
  { results :: [TavilyResult]
  } deriving (Show, Generic)

instance FromJSON TavilyResponse

-- | Query Tavily for real-time commentary and return cleaned comment
-- texts. All failure paths surface as 'PipelineError' in 'ExceptT'.
fetchComments
  :: Text  -- ^ Tavily API key
  -> Text  -- ^ search query (AI-controversy focused)
  -> ExceptT PipelineError IO [Text]
fetchComments apiKey query = do
  baseReq <- parseRequestSafe "POST https://api.tavily.com/search"
  let request = setRequestBodyJSON body
              $ setRequestHeader "Content-Type" ["application/json"]
                baseReq
      body = object
        [ "api_key" .= apiKey
        , "query" .= query
        , "search_depth" .= ("basic" :: Text)
        ]
  response <- httpOrThrow request
  let status = getResponseStatusCode response
  if status /= 200
    then throwError (HttpError ("Tavily returned HTTP " <> T.pack (show status)))
    else case eitherDecode (getResponseBody response) of
      Left err -> throwError (ParseError ("Tavily payload: " <> T.pack err))
      Right (TavilyResponse rs) ->
        pure (filter (not . T.null) (fmap (cleanText . content) rs))

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

-- | Strip HTML tags and URLs from raw comment text, collapsing the
-- leftover whitespace. Pure.
cleanText :: Text -> Text
cleanText = collapseSpaces . dropUrls . dropTags
  where
    dropTags t = case T.breakOn "<" t of
      (before, rest)
        | T.null rest -> before
        | otherwise   ->
            let (_, after) = T.breakOn ">" rest
            in before <> dropTags (T.drop 1 after)
    dropUrls =
      T.unwords . filter (not . isUrl) . T.words
    isUrl w =
      "http://" `T.isPrefixOf` w || "https://" `T.isPrefixOf` w
    collapseSpaces =
      T.unwords . T.words . T.map (\c -> if isSpace c then ' ' else c)
