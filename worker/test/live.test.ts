import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatRoom } from "../src/chat-room.ts";
import { type FeatureKitEnv, serveFeatureKit } from "../src/featurekit.ts";
import { addFeedback, parseFeedbackInput, senderStore } from "../src/feedback.ts";
import { issueToken } from "../src/token.ts";
import { memoryBucket, memoryD1 } from "./d1.ts";

// What the Workers runtime has and Node does not: only what ChatRoom's constructor touches.
(globalThis as Record<string, unknown>).WebSocketRequestResponsePair ??= class {};

const APPS = JSON.stringify({ pager: { repo: "acme/pager", owners: ["octocat"] } });
const KEYS = { pager: "pager-key-0123456789abcdef" };

/** The rooms binding, recording each call: which chat's room, which path, and for whom. */
function rooms() {
  const calls: Array<{ room: string; path: string; app: string | null; login: string | null; chat: string | null; upgrade: string | null }> = [];
  const namespace = {
    idFromName: (name: string) => name,
    get: (room: string) => ({
      async fetch(url: string, init?: RequestInit) {
        const headers = new Headers(init?.headers);
        calls.push({
          room, path: new URL(url).pathname, app: headers.get("X-FeedbackKit-App"), login: headers.get("X-FeedbackKit-Login"),
          chat: headers.get("X-FeedbackKit-Chat"), upgrade: headers.get("Upgrade"),
        });
        return new Response(null, { status: 200 });
      },
    }),
  } as unknown as DurableObjectNamespace;
  return { namespace, calls };
}

function env() {
  const room = rooms();
  const e: FeatureKitEnv = {
    FEEDBACK: memoryBucket(), DB: memoryD1(), APPS, CALLER_TOKEN: "caller", RUNNER_TOKEN: "runner",
    APP_KEYS: JSON.stringify(KEYS), CHAT_ROOMS: room.namespace,
  };
  return { e, calls: room.calls };
}

const runner = (e: FeatureKitEnv, kind: string, body: unknown) => serveFeatureKit(new Request(`https://kit.example/runner/${kind}`, {
  method: "POST", headers: { Authorization: "Bearer runner" }, body: JSON.stringify(body),
}), e);

test("every change to a chat tells its room: the send, the claim, the result and the agent's side", async () => {
  const { e, calls } = env();
  const bearer = await issueToken(KEYS.pager, "pager", "octocat", null, Date.now());
  const chat = await (await serveFeatureKit(new Request("https://kit.example/v2/feedback", {
    method: "POST", headers: { Authorization: `Bearer ${bearer}` }, body: JSON.stringify({ text: "Bigger clock" }),
  }), e)).json() as { id: string };
  const { work } = await (await runner(e, "poll", { orca: true })).json() as { work: Array<{ message: string }> };
  const whose = { app: "pager", login: "octocat", chat: chat.id };
  await runner(e, "claim", { ...whose, message: work[0].message });
  await runner(e, "result", { ...whose, message: work[0].message, status: "delivered" });
  await runner(e, "agent", { ...whose, messages: [], isWorking: true, activity: null, thread: null });
  assert.deepEqual(calls.map(({ room, path, app, login, chat: one }) => [room, path, app, login, one]),
    Array.from({ length: 4 }, () => [chat.id, "/changed", "pager", "octocat", chat.id]));
});

test("the live socket is only for the token's own chat, and only as a WebSocket upgrade", async () => {
  const { e, calls } = env();
  const store = senderStore(e.DB, e.FEEDBACK, "pager", "octocat");
  const chat = (await addFeedback(store, null, parseFeedbackInput({ text: "x" })!, Date.now()))!;
  const bearer = await issueToken(KEYS.pager, "pager", "octocat", null, Date.now());
  const live = (path: string, headers: Record<string, string>) =>
    serveFeatureKit(new Request(`https://kit.example${path}`, { headers }), e);
  assert.equal((await live(`/v2/feedback/${chat}/live`, { Upgrade: "websocket" })).status, 401);
  const someone = await issueToken(KEYS.pager, "pager", "someone", null, Date.now());
  assert.equal((await live(`/v2/feedback/${chat}/live`, { Authorization: `Bearer ${someone}`, Upgrade: "websocket" })).status, 404);
  assert.equal((await live("/v2/feedback/fb_0000000000000000/live", { Authorization: `Bearer ${bearer}`, Upgrade: "websocket" })).status, 404);
  assert.equal((await live(`/v2/feedback/${chat}/live`, { Authorization: `Bearer ${bearer}` })).status, 426);
  (e.DB as ReturnType<typeof memoryD1>).sqlite.exec("INSERT INTO chats (id, app, login, kind, title, created_at, issue_number, issue_url)"
    + " VALUES ('fb_1111111111111111', 'pager', 'octocat', 'issue', 'An issue', 1, 7, 'https://github.com/acme/pager/issues/7')");
  assert.equal((await live("/v2/feedback/fb_1111111111111111/live", { Authorization: `Bearer ${bearer}`, Upgrade: "websocket" })).status, 404,
    "an issue chat has no change source, so no live");
  assert.equal((await live(`/v2/feedback/${chat}/live`, { Authorization: `Bearer ${bearer}`, Upgrade: "websocket" })).status, 200);
  assert.deepEqual(calls.map(({ room, path, chat: one, upgrade }) => [room, path, one, upgrade]),
    [[chat, "/connect", chat, "websocket"]]);
});

test("a room sends the chat as it stands to each socket, and reads nothing while none is open", async () => {
  const db = memoryD1();
  const bucket = memoryBucket();
  const chat = (await addFeedback(senderStore(db, bucket, "pager", "octocat"), null, parseFeedbackInput({ text: "Bigger clock" })!, Date.now()))!;
  const sent: string[][] = [[], []];
  let sockets: unknown[] = [];
  const state = {
    setWebSocketAutoResponse() {},
    getWebSockets: () => sockets,
  } as unknown as DurableObjectState;
  const room = new ChatRoom(state, { DB: db, FEEDBACK: bucket });
  const watching = { app: "pager", login: "octocat", chat };
  let reads = 0;
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    reads += 1;
    return prepare(sql);
  }) as typeof db.prepare;
  assert.equal(await room.broadcast(watching), 0);
  assert.equal(reads, 0, "no socket, no read");
  sockets = sent.map((frames) => ({ send: (frame: string) => frames.push(frame) }));
  assert.equal(await room.broadcast(watching), 2);
  for (const frames of sent) {
    const frame = JSON.parse(frames[0]) as { type: string; chat: { id: string; messages: Array<{ text: string; status: string }> } };
    assert.equal(frame.type, "chat");
    assert.equal(frame.chat.id, chat);
    assert.deepEqual(frame.chat.messages.map(({ text, status }) => [text, status]), [["Bigger clock", "pending"]]);
  }
});
