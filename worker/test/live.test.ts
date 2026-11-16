import assert from "node:assert/strict";
import { test } from "node:test";
import { isRefusal, type StateUpdate } from "@jai/agentchat-live";
import { type FeatureKitEnv, serveFeatureKit } from "../src/featurekit.ts";
import { addFeedback, parseFeedbackInput, pendingWork, runnerClaim, senderStore } from "../src/feedback.ts";
import { liveAdapter, type LiveWho } from "../src/live.ts";
import { memoryBucket, memoryD1 } from "./d1.ts";

const JAI: LiveWho = { app: "pager", login: "jai", name: "Jai" };
const PNG = "iVBORw0KGgoAAAANSUhEUg==";

function world(clock = { now: 1_000_000 }) {
  const db = memoryD1();
  const bucket = memoryBucket();
  const adapter = liveAdapter({
    db,
    bucket,
    now: () => clock.now,
    verify: async (request) => (request.headers.get("Authorization") === "Bearer jai" ? JAI : null),
    sent: async () => {},
  });
  return { db, bucket, adapter, clock, store: senderStore(db, bucket, "pager", "jai", "Jai") };
}

const read = async (adapter: ReturnType<typeof liveAdapter>, chat: string, cursor: string | null) => {
  const answer = await adapter.read(JAI, chat, cursor);
  assert.ok(!answer.expired);
  return answer;
};

test("the state takes its own seq when it moves, once, however many reads see it move", async () => {
  const { db, adapter, store, clock } = world();
  const chat = (await addFeedback(store, null, parseFeedbackInput({ text: "Bigger clock" })!, clock.now))!;
  const first = await read(adapter, chat, null);
  assert.equal((first.state as StateUpdate).state, "running", "pending: the agent is starting");
  const place = first.cursor;
  const [work] = await pendingWork(store);
  await runnerClaim(store, chat, work.message, clock.now);
  const [a, b] = await Promise.all([read(adapter, chat, place), read(adapter, chat, place)]);
  const kinds = (answer: typeof a) => answer.updates.map(({ update }) => update.sessionUpdate);
  assert.deepEqual(kinds(a), ["user_message"], "a claim changes the message; the state (still working) did not move");
  assert.deepEqual(kinds(b), ["user_message"]);
  assert.equal(a.cursor, b.cursor);
  assert.equal(db.sqlite.prepare("SELECT seq FROM chats WHERE id = ?").get(chat)!.seq, Number(a.cursor));
});

test("a delivery stuck 15 minutes reaches the state with no write: the room's refresh reads it", async () => {
  const { adapter, store, clock } = world();
  const chat = (await addFeedback(store, null, parseFeedbackInput({ text: "x" })!, clock.now))!;
  const [work] = await pendingWork(store);
  await runnerClaim(store, chat, work.message, clock.now);
  const before = await read(adapter, chat, null);
  clock.now += 15 * 60_000 + 1;
  const after = await read(adapter, chat, before.cursor);
  const state = after.updates
    .map(({ update }) => update)
    .find((update) => update.sessionUpdate === "state_update") as StateUpdate;
  assert.equal(state.state, "idle");
  assert.match(String(state._meta?.agentchatkit?.problem), /stopped while passing this on/);
  assert.ok(Number(after.cursor) > Number(before.cursor));
});

test("the person's message carries its status, sender and screenshots as links; the agent's words follow", async () => {
  const { adapter, store, db } = world();
  const chat = (await addFeedback(
    store,
    null,
    parseFeedbackInput({
      text: "See this",
      images: [{ media_type: "image/png", data: PNG }],
    })!,
    Date.parse("2026-11-15T06:00:00Z"),
  ))!;
  db.sqlite
    .prepare(
      "INSERT INTO agent_messages (chat, id, seq, text, at) VALUES (?, 'a1', 99, 'On it.', '2026-11-15T06:00:05Z')",
    )
    .run(chat);
  db.sqlite.prepare("UPDATE chats SET seq = 99 WHERE id = ?").run(chat);
  const { updates } = await read(adapter, chat, null);
  const [mine, theirs] = updates.map(({ update }) => update);
  assert.equal(mine.sessionUpdate, "user_message");
  assert.ok(mine.sessionUpdate === "user_message");
  const message = (db.sqlite.prepare("SELECT id FROM messages WHERE chat = ?").get(chat) as { id: string }).id;
  assert.deepEqual(mine.content, [
    { type: "text", text: "See this" },
    {
      type: "resource_link",
      name: "Screenshot 1",
      mimeType: "image/png",
      uri: `/v2/feedback/${chat}/images/${message}/0`,
    },
  ]);
  assert.deepEqual(mine._meta?.agentchatkit, {
    at: "2026-11-15T06:00:00.000Z",
    sender: { login: "jai", name: "Jai" },
    status: "pending",
    detail: null,
  });
  assert.deepEqual(theirs, {
    sessionUpdate: "agent_message",
    messageId: "a1",
    content: [{ type: "text", text: "On it." }],
    _meta: { agentchatkit: { at: "2026-11-15T06:00:05Z" } },
  });
});

test("another person's chat, an issue chat, or no token: refused alike", async () => {
  const { adapter, store, db } = world();
  const chat = (await addFeedback(store, null, parseFeedbackInput({ text: "x" })!, 1))!;
  db.sqlite.exec(
    "INSERT INTO chats (id, app, login, kind, title, created_at) VALUES ('fb_1111111111111111', 'pager', 'jai', 'issue', 'An issue', 1)",
  );
  const ask = (bearer: string | null, id: string) =>
    adapter.authorize(
      new Request("https://kit.example/v2/acp", { headers: bearer ? { Authorization: bearer } : {} }),
      id,
    );
  assert.deepEqual(await ask("Bearer jai", chat), JAI);
  const refused = async (bearer: string | null, id: string) => {
    const answer = await ask(bearer, id);
    return isRefusal(answer) ? answer.refusal.status : 200;
  };
  assert.equal(await refused("Bearer jai", "fb_1111111111111111"), 404, "an issue chat has no live");
  assert.equal(await refused("Bearer jai", "fb_0000000000000000"), 404);
  assert.equal(await refused(null, chat), 401);
  assert.deepEqual(await adapter.read(JAI, chat, "not-a-cursor"), { expired: true });
  assert.deepEqual(await adapter.read(JAI, chat, "999"), { expired: true }, "a cursor from another history");
});

test("every change the runner reports tells the chat's live room", async () => {
  const told: string[] = [];
  const rooms = {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      fetch: async (request: Request) => {
        told.push(`${new URL(request.url).pathname} ${id}`);
        return new Response(null);
      },
    }),
  } as unknown as DurableObjectNamespace;
  const e: FeatureKitEnv = {
    FEEDBACK: memoryBucket(),
    DB: memoryD1(),
    CALLER_TOKEN: "caller",
    RUNNER_TOKEN: "runner",
    LIVE_ROOMS: rooms,
    APPS: JSON.stringify({ pager: { repo: "acme/pager", owners: ["jai"] } }),
  };
  const sent = await serveFeatureKit(
    new Request("https://kit.example/feedback", {
      method: "POST",
      body: JSON.stringify({ text: "Bigger clock" }),
      headers: { Authorization: "Bearer caller", "X-FeedbackKit-App": "pager", "X-FeedbackKit-Login": "jai" },
    }),
    e,
  );
  const chat = ((await sent.json()) as { id: string }).id;
  const runner = (kind: string, body: unknown) =>
    serveFeatureKit(
      new Request(`https://kit.example/runner/${kind}`, {
        method: "POST",
        headers: { Authorization: "Bearer runner" },
        body: JSON.stringify(body),
      }),
      e,
    );
  const { work } = (await (await runner("poll", { orca: true })).json()) as { work: Array<{ message: string }> };
  const whose = { app: "pager", login: "jai", chat };
  await runner("claim", { ...whose, message: work[0].message });
  await runner("result", { ...whose, message: work[0].message, status: "delivered" });
  await runner("agent", { ...whose, messages: [], isWorking: true, activity: null, thread: null });
  assert.equal(told.length, 4);
  assert.ok(
    told.every((one) => one.endsWith(` ${chat}`)),
    told.join(", "),
  );
});
