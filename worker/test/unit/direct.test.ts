import assert from "node:assert/strict";
import { test } from "node:test";
import { issueToken, MAX_LIFETIME_SECONDS, verifyToken } from "../../src/token.ts";

const KEYS = { pager: "pager-key-0123456789abcdef", prhub: "prhub-key-0123456789abcdef" };

test("a token names its app, sender and name, and only while its app's key signed it and it is current", async () => {
  const now = Date.parse("2026-11-15T06:00:00Z");
  const good = await issueToken(KEYS.pager, "pager", "octocat", "Octo Cat", now);
  assert.deepEqual(await verifyToken(good, KEYS, now), { app: "pager", login: "octocat", name: "Octo Cat" });
  assert.deepEqual(await verifyToken(await issueToken(KEYS.pager, "pager", "octocat", null, now), KEYS, now), {
    app: "pager",
    login: "octocat",
    name: null,
  });
  assert.equal(await verifyToken(good, KEYS, now + MAX_LIFETIME_SECONDS * 1000), null, "expired");
  assert.equal(
    await verifyToken(await issueToken(KEYS.prhub, "pager", "octocat", null, now), KEYS, now),
    null,
    "signed with another app's key",
  );
  assert.equal(
    await verifyToken(await issueToken(KEYS.pager, "pager", "octocat", null, now, 3_600), KEYS, now),
    null,
    "lives longer than 15 minutes",
  );
  assert.equal(
    await verifyToken(await issueToken(KEYS.pager, "nope", "octocat", null, now), KEYS, now),
    null,
    "unknown app",
  );
  const [header, , signature] = good.split(".");
  const forged = btoa(
    JSON.stringify({ iss: "pager", sub: "someone", aud: "feedbackkit", iat: now / 1000, exp: now / 1000 + 60 }),
  ).replaceAll("=", "");
  assert.equal(await verifyToken(`${header}.${forged}.${signature}`, KEYS, now), null, "a changed body");
  assert.equal(await verifyToken("not.a.token", KEYS, now), null);
});
