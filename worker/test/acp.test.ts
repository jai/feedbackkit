import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionUpdate } from "@jai/agentchat-live";
import { conformanceCases } from "@jai/agentchat-live/conformance";
import { newId } from "../src/feedback.ts";
import { liveAdapter, type LiveWho } from "../src/live.ts";
import { memoryBucket, memoryD1 } from "./d1.ts";

/**
 * The live protocol's conformance suite (agentchatkit, `@jai/agentchat-live/conformance`) against FeedbackKit's own
 * adapter and storage: D1 on SQLite with this Worker's migrations. `apply` writes an update as FeedbackKit would hold
 * it: the person's messages as rows, the agent's words as its messages, the state as the agent side the runner sends.
 */
const db = memoryD1();
const bucket = memoryBucket();
const people: Record<string, LiveWho> = {
  "Bearer owner": { app: "pager", login: "jai", name: "Jai" },
  "Bearer stranger": { app: "pager", login: "someone", name: null },
};
const adapter = liveAdapter({
  db,
  bucket,
  verify: async (request) => people[request.headers.get("Authorization") ?? ""] ?? null,
  sent: async () => {},
});

const bump = (chat: string) =>
  db.sqlite.prepare("UPDATE chats SET seq = seq + 1 WHERE id = ? RETURNING seq").get(chat) as { seq: number };
const text = (update: { content: Array<{ type: string; text?: string }> }) =>
  update.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");

async function apply(chat: string, update: SessionUpdate): Promise<void> {
  const meta = update._meta?.agentchatkit ?? {};
  if (update.sessionUpdate === "user_message") {
    const { seq } = bump(chat);
    const at = meta.at ? Date.parse(meta.at) : Date.now();
    db.sqlite
      .prepare(
        "INSERT INTO messages (id, chat, at, text, status, detail, seq, client_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)" +
          " ON CONFLICT (id) DO UPDATE SET text = excluded.text, status = excluded.status, detail = excluded.detail, seq = excluded.seq",
      )
      .run(
        update.messageId,
        chat,
        at,
        text(update),
        meta.status ?? "delivered",
        meta.detail ?? null,
        seq,
        meta.clientRef ?? null,
      );
  } else if (update.sessionUpdate === "agent_message") {
    const { seq } = bump(chat);
    db.sqlite
      .prepare(
        "INSERT INTO agent_messages (chat, id, seq, text, at) VALUES (?, ?, ?, ?, ?)" +
          " ON CONFLICT (chat, id) DO UPDATE SET seq = excluded.seq, text = excluded.text, at = excluded.at",
      )
      .run(chat, update.messageId, seq, text(update), meta.at ?? null);
  } else if (update.sessionUpdate === "state_update") {
    // The runner's side: whether the agent works and at what. Later than every message, so none counts as unseen.
    const latest =
      (db.sqlite.prepare("SELECT max(at) AS at FROM messages WHERE chat = ?").get(chat) as { at: number | null }).at ??
      0;
    const side = {
      messages: [],
      isWorking: update.state === "running",
      activity: meta.activity ?? null,
      thread: null,
      updatedAt: Math.max(Date.now(), latest + 1),
    };
    db.sqlite.prepare("UPDATE chats SET agent = ? WHERE id = ?").run(JSON.stringify(side), chat);
  } else {
    throw new Error(`FeedbackKit holds no ${update.sessionUpdate}`);
  }
}

const cases = conformanceCases<LiveWho>({
  adapter,
  capabilities: {
    queues: false,
    edit: true,
    remove: true,
    answer: false,
    updates: ["user_message", "agent_message", "state_update"],
  },
  async reset() {
    const chat = newId("fb");
    db.sqlite
      .prepare(
        "INSERT INTO chats (id, app, login, kind, title, created_at) VALUES (?, 'pager', 'jai', 'agent', 'A chat', 0)",
      )
      .run(chat);
    return chat;
  },
  apply,
  request(url, init, auth = "owner") {
    const headers = new Headers(init?.headers);
    if (auth !== "none") {
      headers.set("Authorization", auth === "owner" ? "Bearer owner" : "Bearer stranger");
    }
    return new Request(url, { ...init, headers });
  },
  // FeedbackKit's cursors never expire; one past the chat's seq is from another history, and must be refused.
  staleCursor: async (_chat, current) => String(Number(current) + 1_000),
  strangerStatus: 404,
});

for (const one of cases) {
  test(`conformance: ${one.name}`, { skip: one.skip }, () => one.run());
}

test("only questions are skipped: FeedbackKit asks none", () => {
  assert.deepEqual(
    cases.filter((one) => one.skip).map((one) => one.name.split(":")[0]),
    ["question.json"],
  );
  assert.equal(cases.filter((one) => !one.skip).length, 7);
});
