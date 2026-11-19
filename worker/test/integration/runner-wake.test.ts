import assert from "node:assert/strict";

import { test } from "node:test";

import { type FeatureKitEnv, serveFeatureKit } from "../../src/featurekit.ts";

import { RunnerWake, WAIT_MS } from "../../src/runner-wake.ts";

import { memoryBucket, memoryD1 } from "./d1.ts";

/** The binding as the Worker sees it, over one RunnerWake. */
function namespace(wake: RunnerWake): DurableObjectNamespace {
  return {
    idFromName: (name: string) => name,
    get: () => ({ fetch: (url: string, init?: RequestInit) => wake.fetch(new Request(url, init)) }),
  } as unknown as DurableObjectNamespace;
}

const APPS = JSON.stringify({ prhub: { repo: "acme/app", owners: ["octocat"], builders: [], issues: false } });

function env(wake?: RunnerWake): FeatureKitEnv {
  return {
    FEEDBACK: memoryBucket(),
    DB: memoryD1(),
    APPS,
    CALLER_TOKEN: "caller",
    RUNNER_TOKEN: "runner",
    RUNNER_WAKE: wake ? namespace(wake) : undefined,
  };
}

function wait(e: FeatureKitEnv, since: number | null, ms: number) {
  return serveFeatureKit(
    new Request("https://kit.example/runner/wait", {
      method: "POST",
      headers: { Authorization: "Bearer runner" },
      body: JSON.stringify({ since, ms }),
    }),
    e,
  );
}

test("a message sent wakes the runner's long poll; a Worker without the binding has none", async () => {
  const wake = new RunnerWake();
  const e = env(wake);
  const { seq } = (await (await wait(e, null, 0)).json()) as { seq: number };
  const held = wait(e, seq, WAIT_MS);
  const sent = await serveFeatureKit(
    new Request("https://kit.example/feedback", {
      method: "POST",
      headers: { Authorization: "Bearer caller", "X-FeedbackKit-App": "prhub", "X-FeedbackKit-Login": "octocat" },
      body: JSON.stringify({ text: "Bigger diff font" }),
    }),
    e,
  );
  assert.equal(sent.status, 200);
  assert.deepEqual(await (await held).json(), { seq: seq + 1 });
  assert.equal((await wait(env(), null, 0)).status, 404);
});

test("only the runner may wait", async () => {
  const response = await serveFeatureKit(
    new Request("https://kit.example/runner/wait", { method: "POST", body: "{}" }),
    env(new RunnerWake()),
  );
  assert.equal(response.status, 401);
});
