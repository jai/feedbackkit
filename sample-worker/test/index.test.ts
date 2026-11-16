import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyToken } from "../../worker/src/token.ts";
import { type SampleEnv, serveSample } from "../src/index.ts";

const env: SampleEnv = {
  APP: "feedbackkit-demo",
  APP_KEY: "demo-key-0123456789abcdef",
  FEEDBACKKIT_URL: "https://kit.example/",
  USER_TOKEN: "sign-in",
  USER_LOGIN: "jai",
  USER_NAME: "Jai",
};
const ask = (bearer?: string, method = "POST") =>
  serveSample(
    new Request("https://sample.example/feedback/token", {
      method,
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    }),
    env,
    Date.parse("2026-11-15T08:00:00Z"),
  );

test("a signed-in user gets a FeedbackKit token FeedbackKit's Worker accepts, and where to use it", async () => {
  const answer = (await (await ask("sign-in")).json()) as { token: string; expiresAt: string; feedbackkit: string };
  assert.equal(answer.feedbackkit, "https://kit.example/v2");
  assert.equal(answer.expiresAt, "2026-11-15T08:15:00.000Z");
  assert.deepEqual(
    await verifyToken(answer.token, { "feedbackkit-demo": env.APP_KEY }, Date.parse("2026-11-15T08:01:00Z")),
    { app: "feedbackkit-demo", login: "jai", name: "Jai" },
  );
});

test("nobody else gets one", async () => {
  assert.equal((await ask()).status, 401);
  assert.equal((await ask("guess")).status, 401);
  assert.equal((await ask("sign-in", "GET")).status, 404);
  assert.equal(
    (
      await serveSample(
        new Request("https://sample.example/feedback/token", {
          method: "POST",
          headers: { Authorization: "Bearer sign-in" },
        }),
        { ...env, APP_KEY: "" },
      )
    ).status,
    503,
  );
});
