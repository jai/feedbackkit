import assert from "node:assert/strict";

import { test } from "node:test";

import { type FeatureKitEnv, serveFeatureKit } from "../../src/featurekit.ts";

import { addFeedback, parseFeedbackInput, senderStore } from "../../src/feedback.ts";

import { type ApnsKey } from "../../src/push.ts";

import { memoryBucket, memoryD1 } from "./d1.ts";

/** A throwaway P-256 key as a .p8, and its public half to check signatures with. */
async function teamKey(): Promise<{ key: ApnsKey; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const body = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n");
  return {
    key: {
      keyId: "KEY1234567",
      teamId: "TEAM123456",
      p8: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`,
    },
    publicKey: pair.publicKey,
  };
}

test("the runner's claim, result and the agent's reply push to the sender's devices, and only theirs", async () => {
  const { key } = await teamKey();
  const db = memoryD1();
  const e: FeatureKitEnv = {
    FEEDBACK: memoryBucket(),
    DB: db,
    CALLER_TOKEN: "caller",
    RUNNER_TOKEN: "runner",
    APPS: JSON.stringify({ pager: { repo: "acme/pager", owners: ["octocat", "hubot"], topic: "com.example.pager" } }),
    APNS_KEY_ID: key.keyId,
    APNS_TEAM_ID: key.teamId,
    APNS_KEY_P8: key.p8,
  };
  db.sqlite.exec(
    "INSERT INTO devices VALUES ('aa', 'pager', 'octocat', 'production', 0), ('bb', 'pager', 'hubot', 'production', 0)",
  );
  const chat = (await addFeedback(
    senderStore(db, e.FEEDBACK, "pager", "octocat"),
    null,
    parseFeedbackInput({ text: "Bigger clock" })!,
    Date.now(),
  ))!;
  const pushes: Array<{
    device: string;
    type: string | null;
    body: { aps: Record<string, unknown>; feedbackkit: Record<string, unknown> };
  }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    pushes.push({
      device: url.split("/").at(-1)!,
      type: new Headers(init.headers).get("apns-push-type"),
      body: JSON.parse(String(init.body)),
    });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
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
    const whose = { app: "pager", login: "octocat", chat };
    await runner("claim", { ...whose, message: work[0].message });
    await runner("result", { ...whose, message: work[0].message, status: "delivered" });
    const thread = { host: "borg-cube-03", id: "orca-codex:1" };
    await runner("agent", { ...whose, messages: [], isWorking: true, activity: null, thread });
    await runner("agent", {
      ...whose,
      messages: [{ id: "a1", text: "Done: bigger clock.", at: null }],
      isWorking: false,
      activity: null,
      thread,
    });
    await runner("agent", {
      ...whose,
      messages: [{ id: "a1", text: "Done: bigger clock.", at: null }],
      isWorking: false,
      activity: null,
      thread,
    });
    await runner("agent", {
      ...whose,
      messages: [
        { id: "a1", text: "Done: bigger clock.", at: null },
        { id: "a2", text: "Bigger on the widget too?", at: null },
      ],
      isWorking: false,
      activity: null,
      thread,
      asks: true,
    });
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(
    pushes.map(({ device, type, body }) => [device, type, body.feedbackkit.kind, body.feedbackkit.status ?? null]),
    [
      ["aa", "background", "status", "delivering"],
      ["aa", "background", "status", "delivered"],
      ["aa", "alert", "taken", null],
      ["aa", "alert", "reply", null],
      ["aa", "alert", "reply", null],
    ],
    "hubot's device gets nothing, and the resent side pushes nothing",
  );
  assert.deepEqual(pushes[3].body.aps.alert, { title: "Bigger clock", body: "Done: bigger clock." });
  assert.deepEqual(
    [pushes[4].body.aps.alert, pushes[4].body.aps["interruption-level"], pushes[4].body.feedbackkit.asks],
    [{ title: "Bigger clock", subtitle: "Needs you", body: "Bigger on the widget too?" }, "time-sensitive", true],
    "a question says so",
  );
});
