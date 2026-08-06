-- | Pure logic core: intonation juxtaposition rules.
--
-- This module MUST remain free of IO imports. Routing is strictly pure
-- and completely decoupled from side effects.
module Logic
  ( juxtapose
  , buildPayload
  ) where

import Data.Text (Text)

import Types

-- | Pure function: maps a comment's sentiment to the avatar whose
-- delivery contradicts it. The words are never changed — only the
-- intonation.
--
-- Anti-AI \/ negative comments are read by the 'HappyAvatar' in a
-- gleeful, cheerful voice; pro-AI \/ positive comments are read by the
-- 'SadAvatar' in a somber, mournful voice.
juxtapose :: SentimentScore -> AvatarTarget
juxtapose score = case score of
  Positive _ -> SadAvatar   -- Pro-AI comments read mournfully
  Negative _ -> HappyAvatar -- Anti-AI comments read gleefully
  Neutral    -> SadAvatar   -- Default fallback

-- | Assemble the outbound payload. Pure: the avatar routing is derived
-- here, not taken from the LLM.
buildPayload
  :: Text            -- ^ original comment, verbatim
  -> SentimentScore  -- ^ sentiment as scored by the LLM
  -> Maybe Text      -- ^ English translation, only for non-English comments
  -> CommentPayload
buildPayload original score english = CommentPayload
  { originalComment    = original
  , sentiment          = score
  , englishTranslation = english
  , targetAvatar       = juxtapose score
  }
