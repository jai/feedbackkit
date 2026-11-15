-- The live protocol (agentchatkit docs/live-protocol.md, our ACP profile):
-- - the chat's state as last sent, and the seq of its own latest change (live.ts settles it on each read);
-- - each message's `clientRef`, so a repeated prompt answers the first message;
-- - `removed`, for a message the person took back before the runner claimed it.
-- SQLite cannot change a CHECK, so the messages table is made again with its rows, ids and seqs as they are.

PRAGMA defer_foreign_keys = true;

ALTER TABLE chats ADD COLUMN state TEXT;
ALTER TABLE chats ADD COLUMN state_seq INTEGER NOT NULL DEFAULT 0;

CREATE TABLE messages_new (
  id TEXT PRIMARY KEY,
  chat TEXT NOT NULL REFERENCES chats (id),
  at INTEGER NOT NULL,
  text TEXT NOT NULL,
  build TEXT,
  images INTEGER NOT NULL DEFAULT 0,
  first INTEGER NOT NULL DEFAULT 0,
  status TEXT CHECK (status IS NULL OR status IN ('pending', 'delivering', 'delivered', 'failed', 'removed')),
  claimed_at INTEGER,
  detail TEXT,
  seq INTEGER NOT NULL DEFAULT 0,
  client_ref TEXT
);
INSERT INTO messages_new (id, chat, at, text, build, images, first, status, claimed_at, detail, seq)
  SELECT id, chat, at, text, build, images, first, status, claimed_at, detail, seq FROM messages;
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;
CREATE INDEX messages_by_chat ON messages (chat, at);
CREATE INDEX messages_pending ON messages (at) WHERE status = 'pending';
CREATE INDEX messages_by_seq ON messages (chat, seq);
CREATE UNIQUE INDEX messages_by_client_ref ON messages (chat, client_ref) WHERE client_ref IS NOT NULL;
