-- Add indexes that support unread-message badges and conversation polling.
-- This migration does not modify or delete existing data.

CREATE INDEX IF NOT EXISTS "chat_participants_userId_idx"
  ON "chat_participants" ("userId");

CREATE INDEX IF NOT EXISTS "messages_chatId_createdAt_idx"
  ON "messages" ("chatId", "createdAt");

CREATE INDEX IF NOT EXISTS "messages_chatId_readAt_idx"
  ON "messages" ("chatId", "readAt");

CREATE INDEX IF NOT EXISTS "messages_senderId_idx"
  ON "messages" ("senderId");
