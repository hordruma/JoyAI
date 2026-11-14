{-# LANGUAGE OverloadedStrings #-}

-- | Pure logic core: intonation juxtaposition rules and the small text
-- decisions around them.
--
-- This module MUST remain free of IO imports. Routing is strictly pure
-- and completely decoupled from side effects.
module Logic
  ( juxtapose
  , buildPayload
  , clampScore
  , excerpt
  , sourceHost
  ) where

import Data.Maybe (listToMaybe)
import Data.Text  (Text)
import qualified Data.Text as T

import Types

-- | Pure function: maps a comment's sentiment to the avatar whose
-- delivery contradicts it. The words are never changed — only the
-- intonation.
--
-- Anti-AI \/ negative comments are read by the 'HappyAvatar' in a
-- gleeful, cheerful voice; pro-AI \/ positive comments are read by the
-- 'SadAvatar' in a somber, mournful voice. A neutral comment carries no
-- feeling to contradict, so it has no place in the piece.
juxtapose :: SentimentScore -> Maybe AvatarTarget
juxtapose score = case score of
  Positive _ -> Just SadAvatar    -- Pro-AI comments read mournfully
  Negative _ -> Just HappyAvatar  -- Anti-AI comments read gleefully
  Neutral    -> Nothing

-- | Assemble the outbound payload, or 'Nothing' when the comment has no
-- sentiment to play against. Pure: the avatar routing is derived here,
-- not taken from the LLM.
buildPayload
  :: RawComment      -- ^ the comment, verbatim, and where it came from
  -> SentimentScore  -- ^ sentiment as scored by the LLM
  -> Maybe Text      -- ^ English translation, only for non-English comments
  -> Maybe CommentPayload
buildPayload comment score english = do
  avatar <- juxtapose score
  pure CommentPayload
    { originalComment    = rawText comment
    , sentiment          = clampScore score
    , englishTranslation = english
    , targetAvatar       = avatar
    , source             = rawSource comment
    }

-- | Keep intensities inside @[0, 1]@ whatever the model returned.
clampScore :: SentimentScore -> SentimentScore
clampScore score = case score of
  Positive x -> Positive (unit x)
  Negative x -> Negative (unit x)
  Neutral    -> Neutral
  where
    unit x
      | isNaN x   = 0.5
      | otherwise = max 0 (min 1 x)

-- | Cut a comment down to something a voice can read in one breath,
-- without rewording it: the longest run of whole opening sentences that
-- fits in @limit@ characters. If even the first sentence is too long,
-- cut at a word boundary and mark the cut with an ellipsis.
--
-- Expects whitespace to be collapsed already (see
-- 'Network.Tavily.cleanText').
excerpt :: Int -> Text -> Text
excerpt limit t
  | T.length t <= limit = t
  | otherwise = case listToMaybe (reverse (filter endsSentence prefixes)) of
      Just whole | T.length whole * 3 >= limit -> whole
      _ -> case listToMaybe (reverse prefixes) of
        Just cut -> T.dropWhileEnd (`elem` trailing) cut <> "\8230"
        Nothing  -> T.take limit t <> "\8230"
  where
    prefixes = takeWhile ((<= limit) . T.length) (growing (T.words t))
    growing ws = drop 1 (scanl join "" ws)
    join acc w = if T.null acc then w else acc <> " " <> w
    endsSentence p =
      case T.unsnoc (T.dropWhileEnd (`elem` closers) p) of
        Just (_, c) -> c `elem` (".!?\8230" :: String)
        Nothing     -> False
    closers  = "\"')]\8221\8217" :: String
    trailing = ",;:-\8212\8211 " :: String

-- | The host a URL points at, for attribution: @reddit.com@ rather than
-- the whole address. 'Nothing' if there is no host to speak of.
sourceHost :: Text -> Maybe Text
sourceHost url
  | T.null host = Nothing
  | otherwise   = Just host
  where
    afterScheme = case T.breakOn "://" url of
      (_, rest) | not (T.null rest) -> T.drop 3 rest
      _                             -> url
    authority = T.takeWhile (`notElem` ("/?#" :: String)) afterScheme
    noUser    = snd (T.breakOnEnd "@" authority)
    noPort    = T.takeWhile (/= ':') noUser
    lower     = T.toLower (T.strip noPort)
    host      = maybe lower id (T.stripPrefix "www." lower)
