{-# LANGUAGE OverloadedStrings #-}

-- | Tests for the pure core: routing, text handling, and the wire
-- format the frontend depends on. Deliberately dependency-free: a list
-- of named checks and an exit code.
module Main (main) where

import Control.Monad   (unless)
import qualified Data.Aeson as Aeson
import Data.Aeson      (object, (.=))
import qualified Data.ByteString.Lazy as LBS
import Data.Either     (isLeft)
import Data.Text       (Text)
import qualified Data.Text as T
import System.Exit     (exitFailure)

import Logic
import Network.LLM     (decodeAnnotation, stripFences)
import Network.Tavily  (cleanText)
import Types

type Check = (String, Bool)

(==>) :: (Eq a) => a -> a -> Bool
(==>) = (==)

comment :: RawComment
comment = RawComment "AI art is soulless." (Just "example.com")

-- | A chat-completions body whose message content is the given text.
completion :: Text -> LBS.ByteString
completion content = Aeson.encode $ object
  [ "choices" .= [ object [ "message" .= object [ "content" .= content ] ] ] ]

checks :: [Check]
checks =
  [ ( "negative comments go to the happy face"
    , juxtapose (Negative 0.9) ==> Just HappyAvatar )
  , ( "positive comments go to the sad face"
    , juxtapose (Positive 0.9) ==> Just SadAvatar )
  , ( "neutral comments are not performed"
    , juxtapose Neutral ==> Nothing )
  , ( "payload keeps the comment verbatim"
    , fmap originalComment (buildPayload comment (Negative 0.9) Nothing)
        ==> Just "AI art is soulless." )
  , ( "payload carries its source"
    , (buildPayload comment (Negative 0.9) Nothing >>= source)
        ==> Just "example.com" )
  , ( "scores are clamped into [0, 1]"
    , fmap sentiment (buildPayload comment (Positive 7) Nothing)
        ==> Just (Positive 1) )

  -- The frontend reads these exact field names and tags.
  , ( "wire format"
    , fmap Aeson.toJSON (buildPayload comment (Negative 0.5) (Just "x"))
        ==> Just (object
              [ "originalComment" .= ("AI art is soulless." :: Text)
              , "sentiment" .= object
                  [ "tag" .= ("Negative" :: Text), "contents" .= (0.5 :: Double) ]
              , "englishTranslation" .= ("x" :: Text)
              , "targetAvatar" .= ("HappyAvatar" :: Text)
              , "source" .= ("example.com" :: Text)
              ]) )

  , ( "cleanText strips tags and urls"
    , cleanText "<p>Hello   <b>there</b></p> see https://example.com/x now"
        ==> "Hello there see now" )
  , ( "cleanText keeps a bare less-than sign"
    , cleanText "2 < 3 and that is all" ==> "2 < 3 and that is all" )
  , ( "cleanText decodes entities"
    , cleanText "it&#39;s &quot;fine&quot; &amp; good" ==> "it's \"fine\" & good" )

  , ( "excerpt leaves short text alone"
    , excerpt 80 "Short and sweet." ==> "Short and sweet." )
  , ( "excerpt keeps whole opening sentences"
    , excerpt 40 "One sentence here. Another one follows. And a third one."
        ==> "One sentence here. Another one follows." )
  , ( "excerpt marks a cut inside a sentence"
    , excerpt 20 "A very long sentence without any stop at all"
        ==> "A very long sentence\8230" )
  , ( "excerpt never exceeds its limit by more than the ellipsis"
    , T.length (excerpt 50 (T.replicate 40 "word ")) <= 51 )

  , ( "sourceHost strips scheme, www and path"
    , sourceHost "https://www.Reddit.com/r/x/comments/1?a=b" ==> Just "reddit.com" )
  , ( "sourceHost strips port and userinfo"
    , sourceHost "http://user@news.example.org:8080/" ==> Just "news.example.org" )
  , ( "sourceHost rejects emptiness"
    , sourceHost "" ==> Nothing )

  , ( "stripFences unwraps a fenced json block"
    , stripFences "```json\n{\"a\":1}\n```" ==> "{\"a\":1}" )
  , ( "annotation decodes to a routed payload"
    , fmap (fmap targetAvatar) (decodeAnnotation comment (completion
        "{\"sentiment\":\"negative\",\"sentiment_score\":0.8,\"english_translation\":null}"))
        ==> Right (Just HappyAvatar) )
  , ( "neutral annotation yields nothing to perform"
    , decodeAnnotation comment (completion
        "{\"sentiment\":\"Neutral\",\"sentiment_score\":0.1}")
        ==> Right Nothing )
  , ( "a translation that only repeats the original is dropped"
    , fmap (>>= englishTranslation) (decodeAnnotation comment (completion
        "{\"sentiment\":\"Negative\",\"sentiment_score\":0.8,\"english_translation\":\"AI art is soulless.\"}"))
        ==> Right Nothing )
  , ( "prose instead of json is an error, not a crash"
    , isLeft (decodeAnnotation comment (completion "I'd rather not.")) )
  , ( "an empty completion is an error, not a crash"
    , isLeft (decodeAnnotation comment "{\"choices\":[]}") )
  ]

main :: IO ()
main = do
  let failures = [name | (name, ok) <- checks, not ok]
  mapM_ (\(name, ok) -> putStrLn ((if ok then "  ok    " else "  FAIL  ") <> name)) checks
  unless (null failures) $ do
    putStrLn (show (length failures) <> " check(s) failed")
    exitFailure
  putStrLn ("all " <> show (length checks) <> " checks passed")
