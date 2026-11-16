import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  addFeedback,
  parseAgentSide,
  parseFeedbackInput,
  pendingWork,
  runnerAgent,
  runnerClaim,
  runnerResult,
  senderStore,
} from "../src/feedback.ts";
import { memoryBucket, memoryD1 } from "./d1.ts";

/** The chat's seq, and each item's: the sender's messages and the agent's. */
function seqs(db: ReturnType<typeof memoryD1>, chat: string) {
  const one = (sql: string) =>
    db.sqlite
      .prepare(sql)
      .all(chat)
      .map((row) => ({ ...row }));
  return {
    chat: (db.sqlite.prepare("SELECT seq FROM chats WHERE id = ?").get(chat) as { seq: number }).seq,
    messages: one("SELECT text, status, seq FROM messages WHERE chat = ? ORDER BY at"),
    agent: one("SELECT id, seq FROM agent_messages WHERE chat = ? ORDER BY seq"),
  };
}

test("every change moves the chat's seq on, and the item changed takes it", async () => {
  const db = memoryD1();
  const store = senderStore(db, memoryBucket(), "pager", "octocat");
  const chat = (await addFeedback(store, null, parseFeedbackInput({ text: "Bigger clock" })!, 1_000))!;
  assert.deepEqual(seqs(db, chat).chat, 1);
  const [work] = await pendingWork(store);
  await runnerClaim(store, chat, work.message, 2_000);
  assert.deepEqual(seqs(db, chat).messages, [{ text: "Bigger clock", status: "delivering", seq: 2 }]);
  assert.equal((await runnerClaim(store, chat, work.message, 2_001)).ok, false);
  assert.equal(seqs(db, chat).chat, 2, "a claim that loses its race moves nothing");
  await runnerResult(store, chat, work.message, true, null);
  const side = (messages: Array<{ id: string; text: string }>, isWorking: boolean, at: number) =>
    parseAgentSide(
      {
        messages: messages.map((one) => ({ ...one, at: "2026-11-15T06:00:00Z" })),
        isWorking,
        activity: null,
        thread: { host: "borg-cube-03", id: "orca-codex:1" },
      },
      at,
    )!;
  await runnerAgent(store, chat, side([{ id: "a1", text: "On it" }], true, 4_000));
  assert.deepEqual(
    seqs(db, chat),
    {
      chat: 5,
      messages: [{ text: "Bigger clock", status: "delivered", seq: 3 }],
      agent: [{ id: "a1", seq: 4 }],
    },
    "a new agent message takes 4; the state (working, its thread) takes 5",
  );
  await runnerAgent(store, chat, side([{ id: "a1", text: "On it" }], true, 5_000));
  assert.equal(seqs(db, chat).chat, 5, "the runner's resend of the same side moves nothing");
  await runnerAgent(
    store,
    chat,
    side(
      [
        { id: "a1", text: "On it" },
        { id: "a2", text: "Done." },
      ],
      false,
      6_000,
    ),
  );
  assert.deepEqual(seqs(db, chat).agent, [
    { id: "a1", seq: 4 },
    { id: "a2", seq: 6 },
  ]);
  assert.equal(seqs(db, chat).chat, 7);
  await addFeedback(store, chat, parseFeedbackInput({ text: "And the badge" })!, 7_000);
  assert.deepEqual(seqs(db, chat).messages.at(-1), { text: "And the badge", status: "pending", seq: 8 });
});

test("chats from before seq get one: their messages in time order, then the agent's, then the chat's own", () => {
  const db = memoryD1("0003");
  db.sqlite.exec(`
    INSERT INTO chats (id, app, login, kind, title, created_at, agent) VALUES ('fb_0000000000000001', 'pager', 'jai', 'agent', 'x', 1,
      '{"messages":[{"id":"a1","text":"On it","at":null},{"id":"a2","text":"Done","at":"2026-11-15T00:00:00Z"}],"isWorking":false,"activity":null,"thread":null,"updatedAt":5}');
    INSERT INTO chats (id, app, login, kind, title, created_at) VALUES ('fb_0000000000000002', 'pager', 'jai', 'issue', 'y', 2);
    INSERT INTO messages (id, chat, at, text, status) VALUES ('m_2', 'fb_0000000000000001', 20, 'second', 'delivered'),
      ('m_1', 'fb_0000000000000001', 10, 'first', 'delivered'), ('m_3', 'fb_0000000000000002', 30, 'issue', NULL);
  `);
  db.sqlite.exec(readFileSync(new URL("../migrations/0003_seq.sql", import.meta.url), "utf8"));
  assert.deepEqual(seqs(db, "fb_0000000000000001"), {
    chat: 5,
    messages: [
      { text: "first", status: "delivered", seq: 1 },
      { text: "second", status: "delivered", seq: 2 },
    ],
    agent: [
      { id: "a1", seq: 3 },
      { id: "a2", seq: 4 },
    ],
  });
  assert.equal(seqs(db, "fb_0000000000000002").chat, 2);
});
