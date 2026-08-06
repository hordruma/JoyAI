-- | Pure logic core: sentiment inversion rules.
--
-- This module MUST remain free of IO imports. Inversion routing is
-- strictly pure and completely decoupled from side effects.
module Logic
  ( invertSentiment
  , buildPayload
  ) where

import Data.Text (Text)

import Types

-- | Pure function: Inverts sentiment and maps the target avatar.
--
-- Anti-AI \/ negative comments are routed to the 'HappyAvatar' (read as
-- manic, hyper-joyful text); pro-AI \/ positive comments are routed to
-- the 'SadAvatar' (read as weeping, existential despair).
invertSentiment :: SentimentScore -> AvatarTarget
invertSentiment score = case score of
  Positive _ -> SadAvatar   -- Pro-AI comments read by Sad Avatar
  Negative _ -> HappyAvatar -- Anti-AI comments read by Happy Avatar
  Neutral    -> SadAvatar   -- Default fallback

-- | Assemble the outbound payload from the original comment and the
-- LLM-produced inversion. Pure: the avatar routing is derived here, not
-- taken from the LLM.
buildPayload
  :: Text            -- ^ original comment
  -> SentimentScore  -- ^ sentiment as scored by the LLM
  -> Text            -- ^ inverted-meaning text
  -> Maybe Text      -- ^ Toki Pona translation, when available
  -> InvertedPayload
buildPayload original sentiment inverted tokiPona = InvertedPayload
  { originalComment     = original
  , originalSentiment   = sentiment
  , invertedText        = inverted
  , tokiPonaTranslation = tokiPona
  , targetAvatar        = invertSentiment sentiment
  }
