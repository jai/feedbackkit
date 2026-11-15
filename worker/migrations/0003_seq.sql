-- The live protocol's order (agentchatkit docs/live-protocol.md): a change counter per chat, and on each item the
-- counter's value at its latest change. `chats.seq` is also the seq of the chat's state, which moves with every change.
-- The agent's messages get their own rows, so each has a seq; `chats.agent` keeps the runner's whole side as well.

ALTER TABLE chats ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;

CREATE TABLE agent_messages (
  chat TEXT NOT NULL REFERENCES chats (id),
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  -- ISO 8601, as the transcript gave it; null when it gave none.
  at TEXT,
  PRIMARY KEY (chat, id)
);
CREATE INDEX agent_messages_by_seq ON agent_messages (chat, seq);

-- Chats from before seq: the sender's messages 1..n in time order, then the agent's in the order the runner sent them,
-- then the chat's own change.
UPDATE messages SET seq = (
  SELECT count(*) FROM messages AS earlier
  WHERE earlier.chat = messages.chat AND (earlier.at < messages.at OR (earlier.at = messages.at AND earlier.id <= messages.id))
);
INSERT OR IGNORE INTO agent_messages (chat, id, seq, text, at)
  SELECT chats.id, json_extract(side.value, '$.id'),
    (SELECT count(*) FROM messages WHERE messages.chat = chats.id) + side.key + 1,
    json_extract(side.value, '$.text'), json_extract(side.value, '$.at')
  FROM chats, json_each(chats.agent, '$.messages') AS side
  WHERE chats.agent IS NOT NULL;
UPDATE chats SET seq = 1 + coalesce((SELECT max(seq) FROM messages WHERE messages.chat = chats.id), 0)
  + coalesce((SELECT count(*) FROM agent_messages WHERE agent_messages.chat = chats.id), 0);
