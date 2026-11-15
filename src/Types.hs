{-# LANGUAGE DeriveGeneric     #-}
{-# LANGUAGE OverloadedStrings #-}

-- | Core algebraic data types for the Joy AI pipeline.
--
-- Domain constraints are enforced through ADTs rather than primitive
-- string types.
module Types
  ( SentimentScore (..)
  , AvatarTarget (..)
  , RawComment (..)
  , Voice (..)
  , CommentPayload (..)
  , PipelineError (..)
  ) where

import Data.Aeson   (FromJSON, ToJSON)
import Data.Text    (Text)
import GHC.Generics (Generic)

-- | Structured sentiment evaluation. The 'Double' is an intensity in
-- @[0, 1]@; the frontend uses it to decide how hard the performance is
-- to hold together.
data SentimentScore
  = Positive Double
  | Negative Double
  | Neutral
  deriving (Show, Eq, Generic)

instance ToJSON SentimentScore
instance FromJSON SentimentScore

-- | Target output destination avatar
data AvatarTarget
  = HappyAvatar
  | SadAvatar
  deriving (Show, Eq, Generic)

instance ToJSON AvatarTarget
instance FromJSON AvatarTarget

-- | A comment as ingested: cleaned text, and where it was found.
data RawComment = RawComment
  { rawText   :: !Text
  , rawSource :: !(Maybe Text)  -- ^ host name of the page it came from
  } deriving (Show, Eq)

-- | A recorded reading of a comment: where the frontend can fetch the
-- audio, and when each whitespace-separated word of the spoken text
-- starts and ends in it (seconds), so captions and lips can follow.
data Voice = Voice
  { audioUrl  :: !Text
  , wordTimes :: ![(Double, Double)]
  } deriving (Show, Eq, Generic)

instance ToJSON Voice
instance FromJSON Voice

-- | Core domain record for processed comment payloads. This is the wire
-- format: the frontend consumes its generically derived JSON as-is.
--
-- The comment text is never altered — the juxtaposition happens in the
-- delivery: 'targetAvatar' selects which face (and which intonation)
-- reads the comment aloud, always the opposite affect of the comment
-- itself.
data CommentPayload = CommentPayload
  { originalComment    :: !Text
  , sentiment          :: !SentimentScore
  , englishTranslation :: !(Maybe Text)  -- ^ only when the source isn't English
  , targetAvatar       :: !AvatarTarget
  , source             :: !(Maybe Text)  -- ^ host name the comment came from
  , voice              :: !(Maybe Voice) -- ^ absent: the browser's own voice reads it
  } deriving (Show, Eq, Generic)

instance ToJSON CommentPayload
instance FromJSON CommentPayload

-- | Failure paths for the exceptional (IO) boundary of the pipeline.
-- Network errors and rate limits are carried in 'ExceptT' so a failed
-- poll cycle never kills the server.
data PipelineError
  = HttpError Text   -- ^ Transport-level failure (timeouts, refused, non-2xx)
  | ParseError Text  -- ^ Payload did not decode into the expected ADT
  | LLMError Text    -- ^ The LLM declined or returned an unusable response
  | VoiceError Text  -- ^ The voice service could not read the comment
  deriving (Show, Eq, Generic)

instance ToJSON PipelineError
