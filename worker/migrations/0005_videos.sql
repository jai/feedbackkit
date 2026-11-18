-- Videos on a message (jai/feedbackkit#4): too large for a JSON body, each goes up first.
-- - `uploads`: room the app asked for (`POST /v2/feedback/uploads`), its bytes once `PUT` (`put_at`), and the message
--   that took it (`message`), at most once. The bytes are raw in R2 under the sender's prefix (`r2_key`).
-- - `images` keeps a message's videos after its pictures, with their size and length.

CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  app TEXT NOT NULL,
  login TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  put_at INTEGER,
  r2_key TEXT NOT NULL,
  message TEXT
);
CREATE INDEX uploads_by_sender ON uploads (app, login, created_at);

ALTER TABLE images ADD COLUMN size INTEGER;
ALTER TABLE images ADD COLUMN duration_ms INTEGER;
