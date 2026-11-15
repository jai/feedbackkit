import assert from "node:assert/strict";
import { test } from "node:test";
import { type FeatureKitEnv, serveFeatureKit } from "../src/featurekit.ts";
import { issueToken, MAX_LIFETIME_SECONDS, verifyToken } from "../src/token.ts";
import { memoryBucket, memoryD1 } from "./d1.ts";

const APPS = JSON.stringify({
  pager: { repo: "acme/pager", owners: ["octocat"] },
  prhub: { repo: "acme/app", owners: ["octocat"], builders: [], issues: false },
});
const KEYS = { pager: "pager-key-0123456789abcdef", prhub: "prhub-key-0123456789abcdef" };

function env(): FeatureKitEnv & { DB: ReturnType<typeof memoryD1> } {
  return {
    FEEDBACK: memoryBucket(), DB: memoryD1(), APPS, CALLER_TOKEN: "caller", RUNNER_TOKEN: "runner",
    APP_KEYS: JSON.stringify(KEYS),
  };
}

async function token(app = "pager", login = "Octocat", name: string | null = "Octo Cat", key = KEYS.pager) {
  return issueToken(key, app, login, name, Date.now());
}

async function direct(e: FeatureKitEnv, path: string, bearer: string, body?: unknown, method?: string) {
  return serveFeatureKit(new Request(`https://kit.example${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { Authorization: `Bearer ${bearer}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), e);
}

test("a token names its app, sender and name, and only while its app's key signed it and it is current", async () => {
  const now = Date.parse("2026-11-15T06:00:00Z");
  const good = await issueToken(KEYS.pager, "pager", "octocat", "Octo Cat", now);
  assert.deepEqual(await verifyToken(good, KEYS, now), { app: "pager", login: "octocat", name: "Octo Cat" });
  assert.deepEqual(await verifyToken(await issueToken(KEYS.pager, "pager", "octocat", null, now), KEYS, now),
    { app: "pager", login: "octocat", name: null });
  assert.equal(await verifyToken(good, KEYS, now + MAX_LIFETIME_SECONDS * 1000), null, "expired");
  assert.equal(await verifyToken(await issueToken(KEYS.prhub, "pager", "octocat", null, now), KEYS, now), null,
    "signed with another app's key");
  assert.equal(await verifyToken(await issueToken(KEYS.pager, "pager", "octocat", null, now, 3_600), KEYS, now), null,
    "lives longer than 15 minutes");
  assert.equal(await verifyToken(await issueToken(KEYS.pager, "nope", "octocat", null, now), KEYS, now), null, "unknown app");
  const [header, , signature] = good.split(".");
  const forged = btoa(JSON.stringify({ iss: "pager", sub: "someone", aud: "feedbackkit", iat: now / 1000, exp: now / 1000 + 60 }))
    .replaceAll("=", "");
  assert.equal(await verifyToken(`${header}.${forged}.${signature}`, KEYS, now), null, "a changed body");
  assert.equal(await verifyToken("not.a.token", KEYS, now), null);
});

test("the app talks to FeedbackKit directly with its token: the same chats, the name kept for the runner", async () => {
  const e = env();
  const bearer = await token();
  const sent = await direct(e, "/v2/feedback", bearer, { text: "Bigger clock", client_ref: "r1" });
  assert.equal(sent.status, 200);
  const chat = await sent.json() as { id: string; messages: Array<{ status: string }> };
  assert.equal(chat.messages[0].status, "pending", "kept: one checkmark");
  const again = await (await direct(e, "/v2/feedback", bearer, { text: "Bigger clock", client_ref: "r1" })).json() as { id: string };
  assert.equal(again.id, chat.id, "a retry is the same message");
  const list = await (await direct(e, "/v2/feedback", bearer)).json() as { threads: Array<{ id: string }> };
  assert.deepEqual(list.threads.map((one) => one.id), [chat.id]);
  const old = await serveFeatureKit(new Request("https://kit.example/feedback", {
    headers: { Authorization: "Bearer caller", "X-FeedbackKit-App": "pager", "X-FeedbackKit-Login": "octocat" },
  }), e);
  assert.deepEqual((await old.json() as { threads: Array<{ id: string }> }).threads.map((one) => one.id), [chat.id],
    "the app's Worker's forwarded routes see the same store");
  const poll = await serveFeatureKit(new Request("https://kit.example/runner/poll", {
    method: "POST", headers: { Authorization: "Bearer runner" }, body: JSON.stringify({ orca: true }),
  }), e);
  const { work } = await poll.json() as { work: Array<{ chat: string; name: string }> };
  assert.deepEqual(work.map((item) => [item.chat, item.name]), [[chat.id, "Octo Cat"]]);
});

test("no token, a bad one, or another app's sender's chat: nothing", async () => {
  const e = env();
  const mine = await (await direct(e, "/v2/feedback", await token(), { text: "x" })).json() as { id: string };
  assert.equal((await direct(e, "/v2/feedback", "nope")).status, 401);
  assert.equal((await serveFeatureKit(new Request("https://kit.example/v2/feedback"), e)).status, 401);
  assert.equal((await direct(e, "/v2/feedback", "caller")).status, 401, "the app Workers' bearer is not a token");
  const other = await token("prhub", "octocat", null, KEYS.prhub);
  assert.equal((await direct(e, `/v2/feedback/${mine.id}`, other)).status, 404, "another app's chats are not this one's");
  const without = { ...e, APP_KEYS: undefined };
  assert.equal((await direct(without, "/v2/feedback", await token())).status, 401, "no keys, no direct route");
});

test("a sender registers their devices for pushes, and forgets one", async () => {
  const e = env();
  const bearer = await token();
  const device = "a".repeat(64);
  assert.equal((await direct(e, "/v2/devices", bearer, { token: device, environment: "sandbox" })).status, 200);
  assert.equal((await direct(e, "/v2/devices", bearer, { token: device.toUpperCase(), environment: "production" })).status, 200);
  assert.deepEqual(e.DB.sqlite.prepare("SELECT token, app, login, environment FROM devices").all().map((row) => ({ ...row })),
    [{ token: device, app: "pager", login: "octocat", environment: "production" }]);
  assert.equal((await direct(e, "/v2/devices", bearer, { token: "xyz", environment: "production" })).status, 400);
  assert.equal((await direct(e, `/v2/devices/${device}`, bearer, undefined, "DELETE")).status, 200);
  assert.equal(e.DB.sqlite.prepare("SELECT count(*) AS n FROM devices").get()!.n, 0);
});
