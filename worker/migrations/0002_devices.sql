-- Where FeedbackKit pushes (docs/api.md#pushes): each sender's devices, by their APNs token. A token APNs refuses as
-- gone is deleted.
CREATE TABLE devices (
  token TEXT PRIMARY KEY,
  app TEXT NOT NULL,
  login TEXT NOT NULL,
  -- production or sandbox: which APNs host takes the token.
  environment TEXT NOT NULL CHECK (environment IN ('production', 'sandbox')),
  updated_at INTEGER NOT NULL
);
CREATE INDEX devices_by_sender ON devices (app, login);
