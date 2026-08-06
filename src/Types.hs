{-# LANGUAGE DeriveGeneric     #-}
{-# LANGUAGE OverloadedStrings #-}

-- | Core algebraic data types for the Joy AI pipeline.
--
-- Domain constraints are enforced through ADTs rather than primitive
-- string types.
module Types
  ( SentimentScore (..)
  , AvatarTarget (..)
  , CommentPayload (..)
  , PipelineError (..)
  ) where

import Data.Aeson   (FromJSON, ToJSON)
import Data.Text    (Text)
import GHC.Generics (Generic)

-- | Represents structured sentiment evaluation
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

-- | Core domain record for processed comment payloads.
--
-- The comment text is never altered — the juxtaposition happens in the
-- delivery: 'targetAvatar' selects which face (and which intonation)
-- reads the comment aloud, always the opposite affect of the comment
-- itself.
data CommentPayload = CommentPayload
  { originalComment     :: !Text
  , sentiment           :: !SentimentScore
  , tokiPonaTranslation :: !(Maybe Text)
  , targetAvatar        :: !AvatarTarget
  } deriving (Show, Eq, Generic)

instance ToJSON CommentPayload
instance FromJSON CommentPayload

-- | Failure paths for the exceptional (IO) boundary of the pipeline.
-- Network errors and rate limits are carried in 'ExceptT' so a failed
-- poll cycle never kills the WebSocket server thread.
data PipelineError
  = HttpError Text   -- ^ Transport-level failure (timeouts, refused, non-2xx)
  | ParseError Text  -- ^ Payload did not decode into the expected ADT
  | LLMError Text    -- ^ The LLM declined or returned an unusable response
  deriving (Show, Eq, Generic)

instance ToJSON PipelineError
