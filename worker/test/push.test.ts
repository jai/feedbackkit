import assert from "node:assert/strict";
import { test } from "node:test";
import { type FeatureKitEnv, serveFeatureKit } from "../src/featurekit.ts";
import { addFeedback, parseFeedbackInput, senderStore } from "../src/feedback.ts";
import { agentPush, type ApnsKey, payload, providerToken, sendPush } from "../src/push.ts";
import { memoryBucket, memoryD1 } from "./d1.ts";

/** A throwaway P-256 key as a .p8, and its public half to check signatures with. */
async function teamKey(): Promise<{ key: ApnsKey; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey) as ArrayBuffer);
  const body = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n");
  return {
    key: { keyId: "KEY1234567", teamId: "TEAM123456", p8: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n` },
    publicKey: pair.publicKey,
  };
}

function fromBase64url(text: string): Uint8Array {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

test("the provider token is ES256 over the team and key, and APNs could check it", async () => {
  const { key, publicKey } = await teamKey();
  const token = await providerToken(key, Date.parse("2026-11-15T07:00:00Z"));
  const [header, claims, signature] = token.split(".");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(fromBase64url(header))), { alg: "ES256", kid: "KEY1234567" });
  assert.deepEqual(JSON.parse(new TextDecoder().decode(fromBase64url(claims))), { iss: "TEAM123456", iat: Date.parse("2026-11-15T07:00:00Z") / 1000 });
  assert.equal(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, fromBase64url(signature),
    new TextEncoder().encode(`${header}.${claims}`)), true);
});

test("a push goes to each device's APNs host with the app's topic; a gone device is named", async () => {
  const { key } = await teamKey();
  const sent: Array<{ url: string; headers: Headers; body: unknown }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return url.includes("dead") ? Response.json({ reason: "Unregistered" }, { status: 410 }) : new Response(null, { status: 200 });
  }) as typeof fetch;
  const push = { alert: { title: "Bigger clock", body: "Done: the clock is 20% bigger." }, data: { chat: "fb_1", app: "pager", kind: "reply" as const } };
  const gone = await sendPush(key, "com.example.pager", [
    { token: "aa", environment: "production" }, { token: "dead", environment: "sandbox" },
  ], push, Date.now(), fetcher);
  assert.deepEqual(gone, ["dead"]);
  assert.deepEqual(sent.map(({ url }) => url),
    ["https://api.push.apple.com/3/device/aa", "https://api.sandbox.push.apple.com/3/device/dead"]);
  assert.equal(sent[0].headers.get("apns-topic"), "com.example.pager");
  assert.equal(sent[0].headers.get("apns-push-type"), "alert");
  assert.match(sent[0].headers.get("authorization") ?? "", /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  assert.deepEqual(sent[0].body, payload(push));
  assert.deepEqual(payload({ alert: null, data: { chat: "fb_1", app: "pager", kind: "status", status: "delivered" } }),
    { aps: { "content-available": 1 }, feedbackkit: { chat: "fb_1", app: "pager", kind: "status", status: "delivered" } });
});

test("an agent side is worth a push when it is the agent's first thread or has new words, and not a resend", () => {
  const thread = { host: "borg-cube-03", id: "orca-codex:1" };
  assert.deepEqual(agentPush("pager", "fb_1", "Clock", { messages: [], thread: null }, { messages: [], thread })?.data.kind, "taken");
  const reply = agentPush("pager", "fb_1", "Clock", { messages: [{ id: "a" }], thread }, {
    messages: [{ id: "a", text: "On it" }, { id: "b", text: "Done.\n\nThe clock is bigger." }], thread,
  });
  assert.deepEqual(reply, { alert: { title: "Clock", body: "Done. The clock is bigger." }, data: { chat: "fb_1", app: "pager", kind: "reply" } });
  assert.equal(agentPush("pager", "fb_1", "Clock", { messages: [{ id: "a" }], thread }, { messages: [{ id: "a", text: "On it" }], thread }), null);
});

test("the runner's claim, result and the agent's reply push to the sender's devices, and only theirs", async () => {
  const { key } = await teamKey();
  const db = memoryD1();
  const e: FeatureKitEnv = {
    FEEDBACK: memoryBucket(), DB: db, CALLER_TOKEN: "caller", RUNNER_TOKEN: "runner",
    APPS: JSON.stringify({ pager: { repo: "acme/pager", owners: ["octocat", "hubot"], topic: "com.example.pager" } }),
    APNS_KEY_ID: key.keyId, APNS_TEAM_ID: key.teamId, APNS_KEY_P8: key.p8,
  };
  db.sqlite.exec("INSERT INTO devices VALUES ('aa', 'pager', 'octocat', 'production', 0), ('bb', 'pager', 'hubot', 'production', 0)");
  const chat = (await addFeedback(senderStore(db, e.FEEDBACK, "pager", "octocat"), null, parseFeedbackInput({ text: "Bigger clock" })!, Date.now()))!;
  const pushes: Array<{ device: string; type: string | null; body: { aps: Record<string, unknown>; feedbackkit: Record<string, unknown> } }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    pushes.push({ device: url.split("/").at(-1)!, type: new Headers(init.headers).get("apns-push-type"), body: JSON.parse(String(init.body)) });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    const runner = (kind: string, body: unknown) => serveFeatureKit(new Request(`https://kit.example/runner/${kind}`, {
      method: "POST", headers: { Authorization: "Bearer runner" }, body: JSON.stringify(body),
    }), e);
    const { work } = await (await runner("poll", { orca: true })).json() as { work: Array<{ message: string }> };
    const whose = { app: "pager", login: "octocat", chat };
    await runner("claim", { ...whose, message: work[0].message });
    await runner("result", { ...whose, message: work[0].message, status: "delivered" });
    const thread = { host: "borg-cube-03", id: "orca-codex:1" };
    await runner("agent", { ...whose, messages: [], isWorking: true, activity: null, thread });
    await runner("agent", { ...whose, messages: [{ id: "a1", text: "Done: bigger clock.", at: null }], isWorking: false, activity: null, thread });
    await runner("agent", { ...whose, messages: [{ id: "a1", text: "Done: bigger clock.", at: null }], isWorking: false, activity: null, thread });
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(pushes.map(({ device, type, body }) => [device, type, body.feedbackkit.kind, body.feedbackkit.status ?? null]), [
    ["aa", "background", "status", "delivering"],
    ["aa", "background", "status", "delivered"],
    ["aa", "alert", "taken", null],
    ["aa", "alert", "reply", null],
  ], "hubot's device gets nothing, and the resent side pushes nothing");
  assert.deepEqual(pushes[3].body.aps.alert, { title: "Bigger clock", body: "Done: bigger clock." });
});
