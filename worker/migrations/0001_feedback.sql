-- FeedbackKit's one durable store (docs/worker.md#storage): every app's chats, messages, delivery states and each
-- chat's coding thread. Screenshots stay in R2, under the keys `images` names. Times are epoch milliseconds.

-- One chat: an agent's (an owner's or a builder's) or a public issue's (everyone else's), one sender's in one app.
CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  app TEXT NOT NULL,
  -- The sender's GitHub login, lower-case.
  login TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'issue')),
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- The sender's name as their app gives it ("Jai"); null: their login.
  sender_name TEXT,
  -- An issue chat's issue on the app's repo.
  issue_number INTEGER,
  issue_url TEXT,
  -- The agent's side, as the runner last sent it (JSON: messages, isWorking, activity, thread, updatedAt), and its
  -- coding thread on its own, to look chats up by.
  agent TEXT,
  thread_host TEXT,
  thread_id TEXT
);
CREATE INDEX chats_by_sender ON chats (app, login, created_at);

-- One message from the sender. Only a send writes one; only the runner's claim and result change an agent chat's.
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  chat TEXT NOT NULL REFERENCES chats (id),
  at INTEGER NOT NULL,
  text TEXT NOT NULL,
  build TEXT,
  images INTEGER NOT NULL DEFAULT 0,
  -- The chat's first message starts its agent.
  first INTEGER NOT NULL DEFAULT 0,
  -- pending, delivering, delivered or failed; null on an issue chat's message.
  status TEXT CHECK (status IS NULL OR status IN ('pending', 'delivering', 'delivered', 'failed')),
  claimed_at INTEGER,
  detail TEXT
);
CREATE INDEX messages_by_chat ON messages (chat, at);
CREATE INDEX messages_pending ON messages (at) WHERE status = 'pending';

-- A message's screenshots in R2 (`{media_type, data}` JSON), in order.
CREATE TABLE images (
  message TEXT NOT NULL REFERENCES messages (id),
  idx INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  media_type TEXT NOT NULL,
  PRIMARY KEY (message, idx)
);

-- Which chat a send with a `client_ref` made, so a retry answers that chat and sends nothing again.
CREATE TABLE refs (
  app TEXT NOT NULL,
  login TEXT NOT NULL,
  key TEXT NOT NULL,
  chat TEXT NOT NULL,
  PRIMARY KEY (app, login, key)
);

-- When each sender opened each issue, for the daily cap.
CREATE TABLE issue_opens (
  app TEXT NOT NULL,
  login TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX issue_opens_by_sender ON issue_opens (app, login, at);

-- The runner's last poll: one row.
CREATE TABLE runner_beat (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  at INTEGER NOT NULL,
  orca INTEGER NOT NULL,
  detail TEXT
);
