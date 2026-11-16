import assert from "node:assert/strict";
import { test } from "node:test";
import { type FeatureKitEnv, serveFeatureKit } from "../src/featurekit.ts";
import { parseShipped, type Shipped } from "../src/shipped.ts";
import { issueToken } from "../src/token.ts";
import { memoryBucket, memoryD1 } from "./d1.ts";

const KEY = "pager-key-0123456789abcdef";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHIPPED: Shipped = {
  commits: [
    {
      sha: SHA,
      title: "Bigger clock",
      at: "2026-11-15T10:00:00Z",
      url: `https://github.com/acme/pager/commit/${SHA}`,
      ci: "success",
      release: {
        tag: "v1.2.0",
        name: "v1.2.0",
        url: "https://github.com/acme/pager/releases/tag/v1.2.0",
        prerelease: false,
      },
    },
  ],
  prs: [{ number: 7, title: "Bigger clock", url: "https://github.com/acme/pager/pull/7", state: "merged", ci: null }],
};

function env() {
  return {
    FEEDBACK: memoryBucket(),
    DB: memoryD1(),
    CALLER_TOKEN: "caller",
    RUNNER_TOKEN: "runner",
    APPS: JSON.stringify({ pager: { repo: "acme/pager", owners: ["octocat"] } }),
    APP_KEYS: JSON.stringify({ pager: KEY }),
  } satisfies FeatureKitEnv;
}

async function call(e: FeatureKitEnv, path: string, bearer: string, body?: unknown) {
  return serveFeatureKit(
    new Request(`https://kit.example${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${bearer}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    e,
  );
}

const side = (chat: string, shipped?: unknown) => ({
  app: "pager",
  login: "octocat",
  chat,
  messages: [],
  isWorking: false,
  activity: null,
  thread: null,
  ...(shipped === undefined ? {} : { shipped }),
});

test("shipped is checked part by part: commits, pull requests, releases and links to GitHub", () => {
  assert.deepEqual(parseShipped(SHIPPED), SHIPPED);
  assert.deepEqual(parseShipped({ commits: [], prs: [] }), { commits: [], prs: [] });
  const commit = SHIPPED.commits[0];
  for (const bad of [
    { commits: "no", prs: [] },
    { commits: [{ ...commit, sha: "abc" }], prs: [] },
    { commits: [{ ...commit, url: "https://example.com/x" }], prs: [] },
    { commits: [{ ...commit, ci: "green" }], prs: [] },
    { commits: [{ ...commit, at: "soon" }], prs: [] },
    { commits: [{ ...commit, release: { tag: "", name: "x", url: commit.url, prerelease: false } }], prs: [] },
    { commits: Array(21).fill(commit), prs: [] },
    { commits: [], prs: [{ ...SHIPPED.prs[0], state: "draft" }] },
    { commits: [], prs: [{ ...SHIPPED.prs[0], number: 0 }] },
  ]) {
    assert.equal(parseShipped(bad), undefined, JSON.stringify(bad).slice(0, 80));
  }
});

test("what the runner says shipped is on the chat's row and on the chat, and a bad one is refused", async () => {
  const e = env();
  const bearer = await issueToken(KEY, "pager", "octocat", null, Date.now());
  const { id } = (await (await call(e, "/v2/feedback", bearer, { text: "Bigger clock" })).json()) as { id: string };
  const list = async () =>
    ((await (await call(e, "/v2/feedback", bearer)).json()) as { threads: Array<{ shipped: unknown }> }).threads[0]
      .shipped;
  const chat = async () =>
    ((await (await call(e, `/v2/feedback/${id}`, bearer)).json()) as { shipped: unknown }).shipped;
  assert.equal(await list(), null, "nothing yet");
  assert.equal(await chat(), null);

  assert.equal((await call(e, "/runner/agent", "runner", side(id, SHIPPED))).status, 200);
  assert.deepEqual(await list(), SHIPPED);
  assert.deepEqual(await chat(), SHIPPED);

  assert.equal((await call(e, "/runner/agent", "runner", side(id, { commits: [{ sha: "x" }], prs: [] }))).status, 400);
  assert.deepEqual(await chat(), SHIPPED, "kept as it was");
});

test("a change to what shipped moves the chat on, so the live screen hears of it", async () => {
  const e = env();
  const bearer = await issueToken(KEY, "pager", "octocat", null, Date.now());
  const { id } = (await (await call(e, "/v2/feedback", bearer, { text: "Bigger clock" })).json()) as { id: string };
  const seq = () => Number((e.DB.sqlite.prepare("SELECT seq FROM chats WHERE id = ?").get(id) as { seq: number }).seq);
  await call(e, "/runner/agent", "runner", side(id));
  const before = seq();
  await call(e, "/runner/agent", "runner", side(id));
  assert.equal(seq(), before, "the same side again moves nothing");
  await call(e, "/runner/agent", "runner", side(id, SHIPPED));
  assert.equal(seq(), before + 1);
  const released = { ...SHIPPED, commits: [{ ...SHIPPED.commits[0], ci: "failure" as const }] };
  await call(e, "/runner/agent", "runner", side(id, released));
  assert.equal(seq(), before + 2);
});
