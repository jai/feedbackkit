import assert from "node:assert/strict";
import { test } from "node:test";
import { agentPush, type ApnsKey, payload, providerToken, sendPush } from "../../src/push.ts";

/** A throwaway P-256 key as a .p8, and its public half to check signatures with. */
async function teamKey(keyId = "KEY1234567"): Promise<{ key: ApnsKey; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const body = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n");
  return {
    key: {
      keyId,
      teamId: "TEAM123456",
      p8: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`,
    },
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
  assert.deepEqual(JSON.parse(new TextDecoder().decode(fromBase64url(claims))), {
    iss: "TEAM123456",
    iat: Date.parse("2026-11-15T07:00:00Z") / 1000,
  });
  assert.equal(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      fromBase64url(signature),
      new TextEncoder().encode(`${header}.${claims}`),
    ),
    true,
  );
});

test("a push goes to each device's APNs host with the app's topic; a gone device is named", async () => {
  const { key } = await teamKey("PUSH123456");
  const sent: Array<{ url: string; headers: Headers; body: unknown }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return url.includes("dead")
      ? Response.json({ reason: "Unregistered" }, { status: 410 })
      : new Response(null, { status: 200 });
  }) as typeof fetch;
  const push = {
    alert: { title: "Bigger clock", body: "Done: the clock is 20% bigger." },
    data: { chat: "fb_1", app: "pager", kind: "reply" as const },
  };
  const gone = await sendPush(
    key,
    "com.example.pager",
    [
      { token: "aa", environment: "production" },
      { token: "dead", environment: "sandbox" },
    ],
    push,
    Date.parse("2026-11-15T07:00:00Z"),
    fetcher,
  );
  assert.deepEqual(gone, ["dead"]);
  assert.deepEqual(
    sent.map(({ url }) => url),
    ["https://api.push.apple.com/3/device/aa", "https://api.sandbox.push.apple.com/3/device/dead"],
  );
  assert.equal(sent[0].headers.get("apns-topic"), "com.example.pager");
  assert.equal(sent[0].headers.get("apns-push-type"), "alert");
  assert.match(sent[0].headers.get("authorization") ?? "", /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  assert.deepEqual(sent[0].body, payload(push));
  assert.deepEqual(
    payload({ alert: null, data: { chat: "fb_1", app: "pager", kind: "status", status: "delivered" } }),
    {
      aps: { "content-available": 1 },
      feedbackkit: { chat: "fb_1", app: "pager", kind: "status", status: "delivered" },
    },
  );
});

test("an agent side is worth a push when it is the agent's first thread or has new words, and not a resend", () => {
  const thread = { host: "borg-cube-03", id: "orca-codex:1" };
  assert.deepEqual(
    agentPush("pager", "fb_1", "Clock", { messages: [], thread: null }, { messages: [], thread })?.data.kind,
    "taken",
  );
  const reply = agentPush(
    "pager",
    "fb_1",
    "Clock",
    { messages: [{ id: "a" }], thread },
    {
      messages: [
        { id: "a", text: "On it" },
        { id: "b", text: "Done.\n\nThe clock is bigger." },
      ],
      thread,
    },
  );
  assert.deepEqual(reply, {
    alert: { title: "Clock", body: "Done. The clock is bigger." },
    data: { chat: "fb_1", app: "pager", kind: "reply" },
  });
  assert.equal(
    agentPush(
      "pager",
      "fb_1",
      "Clock",
      { messages: [{ id: "a" }], thread },
      { messages: [{ id: "a", text: "On it" }], thread },
    ),
    null,
  );
});
