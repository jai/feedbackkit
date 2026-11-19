import assert from "node:assert/strict";

import { test } from "node:test";

import { type FeatureKitEnv, parseApps, serveFeatureKit } from "../../src/featurekit.ts";

import { issueToken } from "../../src/token.ts";

import { memoryBucket, memoryD1 } from "./d1.ts";

const APPS = JSON.stringify({
  e2e: { repo: "acme/kit", owners: ["tester"], issues: true, echo: true },
  pager: { repo: "acme/pager", owners: ["octocat"] },
});

const KEYS = { e2e: "e2e-key-0123456789abcdef", pager: "pager-key-0123456789abcdef" };

const PNG = { media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" };

function env() {
  return {
    FEEDBACK: memoryBucket(),
    DB: memoryD1(),
    APPS,
    CALLER_TOKEN: "caller",
    RUNNER_TOKEN: "runner",
    APP_KEYS: JSON.stringify(KEYS),
  } satisfies FeatureKitEnv;
}

async function call(e: FeatureKitEnv, path: string, bearer: string, method = "GET", body?: unknown) {
  return serveFeatureKit(
    new Request(`https://kit.example${path}`, {
      method,
      headers: { Authorization: `Bearer ${bearer}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    e,
  );
}

const count = (e: ReturnType<typeof env>, table: string) =>
  Number((e.DB.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);

const tester = () => issueToken(KEYS.e2e, "e2e", "tester", null, Date.now());

test("a test app never opens issues, and the runner sees its work as echo work", async () => {
  assert.equal(parseApps(APPS).e2e.issues, false, "echo wins over issues");
  assert.equal(parseApps(APPS).pager.echo, false);
  const e = env();
  const stranger = await issueToken(KEYS.e2e, "e2e", "someone", null, Date.now());
  assert.equal((await call(e, "/v2/feedback", stranger, "POST", { text: "hi" })).status, 403, "only its owners send");
  await call(e, "/v2/feedback", await tester(), "POST", { text: "ping" });
  await call(e, "/v2/feedback", await issueToken(KEYS.pager, "pager", "octocat", null, Date.now()), "POST", {
    text: "real",
  });
  const { work } = (await (await call(e, "/runner/poll", "runner", "POST", { orca: true })).json()) as {
    work: Array<{ app: string; echo?: boolean }>;
  };
  assert.deepEqual(
    work.map((item) => [item.app, item.echo]),
    [
      ["e2e", true],
      ["pager", undefined],
    ],
  );
});

test("a test app's chat is deleted with its messages, the agent's words and its screenshots", async () => {
  const e = env();
  const bearer = await tester();
  const chat = (await (
    await call(e, "/v2/feedback", bearer, "POST", { text: "ping", images: [PNG], client_ref: "r1" })
  ).json()) as { id: string; messages: Array<{ id: string }> };
  const message = chat.messages[0].id;
  const agent = await call(e, "/runner/agent", "runner", "POST", {
    app: "e2e",
    login: "tester",
    chat: chat.id,
    isWorking: false,
    activity: null,
    messages: [{ id: `echo-${message}`, text: "echo: ping", at: new Date().toISOString() }],
  });
  assert.equal(agent.status, 200);
  assert.ok(e.FEEDBACK.objects.size > 0, "the screenshot is kept");

  assert.equal((await call(e, `/v2/feedback/${chat.id}`, bearer, "DELETE")).status, 200);
  assert.equal((await call(e, `/v2/feedback/${chat.id}`, bearer)).status, 404);
  for (const table of ["chats", "messages", "images", "agent_messages", "refs"]) {
    assert.equal(count(e, table), 0, table);
  }
  assert.equal(e.FEEDBACK.objects.size, 0, "the screenshot is gone");
  assert.equal((await call(e, `/v2/feedback/${chat.id}`, bearer, "DELETE")).status, 404, "gone already");
  assert.equal((await call(e, "/v2/feedback", bearer, "DELETE")).status, 404, "no chat named");
});

test("another app's chat is never deleted, by its sender or through the app Workers' route", async () => {
  const e = env();
  const bearer = await issueToken(KEYS.pager, "pager", "octocat", null, Date.now());
  const chat = (await (await call(e, "/v2/feedback", bearer, "POST", { text: "real" })).json()) as { id: string };
  assert.equal((await call(e, `/v2/feedback/${chat.id}`, bearer, "DELETE")).status, 403);
  const forwarded = await serveFeatureKit(
    new Request(`https://kit.example/feedback/${chat.id}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer caller", "X-FeedbackKit-App": "pager", "X-FeedbackKit-Login": "octocat" },
    }),
    e,
  );
  assert.equal(forwarded.status, 403);
  assert.equal((await call(e, `/v2/feedback/${chat.id}`, bearer)).status, 200, "still there");
  const testers = await tester();
  assert.equal((await call(e, `/v2/feedback/${chat.id}`, testers, "DELETE")).status, 404, "not the tester's chat");
  assert.equal((await call(e, `/v2/feedback/${chat.id}`, bearer)).status, 200, "still there");
});

test("the app Workers' route deletes a test app's chat too", async () => {
  const e = env();
  const headers = { Authorization: "Bearer caller", "X-FeedbackKit-App": "e2e", "X-FeedbackKit-Login": "tester" };
  const sent = await serveFeatureKit(
    new Request("https://kit.example/feedback", {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "ping" }),
    }),
    e,
  );
  const { id } = (await sent.json()) as { id: string };
  const gone = await serveFeatureKit(
    new Request(`https://kit.example/feedback/${id}`, { method: "DELETE", headers }),
    e,
  );
  assert.equal(gone.status, 200);
  assert.equal(count(e, "chats"), 0);
});
