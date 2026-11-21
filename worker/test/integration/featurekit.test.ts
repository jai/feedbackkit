import assert from "node:assert/strict";

import { test } from "node:test";

import { type FeatureKitEnv, serveFeatureKit, takeIssue } from "../../src/featurekit.ts";

import { senderStore } from "../../src/feedback.ts";

import { memoryBucket, memoryD1 } from "./d1.ts";

const APPS = JSON.stringify({
  prhub: { repo: "acme/app", owners: ["Octocat"], builders: ["hubot"], issues: true },
  pager: { repo: "acme/pager", owners: ["octocat"] },
});

function env(): FeatureKitEnv {
  return { FEEDBACK: memoryBucket(), DB: memoryD1(), APPS, CALLER_TOKEN: "caller", RUNNER_TOKEN: "runner" };
}

function fromApp(e: FeatureKitEnv, path: string, login: string, body?: unknown, app = "prhub") {
  return serveFeatureKit(
    new Request(`https://kit.example${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: "Bearer caller", "X-FeedbackKit-App": app, "X-FeedbackKit-Login": login },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    e,
  );
}

function fromRunner(e: FeatureKitEnv, kind: string, body: unknown) {
  return serveFeatureKit(
    new Request(`https://kit.example/runner/${kind}`, {
      method: "POST",
      headers: { Authorization: "Bearer runner" },
      body: JSON.stringify(body),
    }),
    e,
  );
}

test("an owner's and a builder's feedback each wait for the runner as their own chats, with the app's repo", async () => {
  const e = env();
  const mine = await (await fromApp(e, "/feedback", "octocat", { text: "Bigger diff font", client_ref: "a" })).json();
  const theirs = await (await fromApp(e, "/feedback", "hubot", { text: "Dark mode" })).json();
  const again = await (await fromApp(e, "/feedback", "octocat", { text: "Bigger diff font", client_ref: "a" })).json();
  assert.equal(again.id, mine.id);
  const list = await (await fromApp(e, "/feedback", "octocat")).json();
  assert.deepEqual(
    list.threads.map((thread: { id: string }) => thread.id),
    [mine.id],
  );
  const { work } = await (await fromRunner(e, "poll", { orca: true })).json();
  assert.deepEqual(
    work.map((item: Record<string, string>) => [item.chat, item.login, item.repo, item.role]),
    [
      [mine.id, "octocat", "acme/app", "owner"],
      [theirs.id, "hubot", "acme/app", "builder"],
    ],
  );
  const claim = await (
    await fromRunner(e, "claim", { app: "prhub", login: "hubot", chat: theirs.id, message: work[1].message })
  ).json();
  assert.equal(claim.text, "Dark mode");
  assert.equal(claim.role, "builder");
  const wrong = await fromRunner(e, "claim", {
    app: "prhub",
    login: "octocat",
    chat: theirs.id,
    message: work[1].message,
  });
  assert.equal(wrong.status, 404);
});

test("nobody reaches feedback without the app Worker's or the runner's token, and an app with no issues refuses others", async () => {
  const e = env();
  const bare = await serveFeatureKit(
    new Request("https://kit.example/feedback", { headers: { "X-FeedbackKit-App": "prhub" } }),
    e,
  );
  assert.equal(bare.status, 401);
  const runner = await serveFeatureKit(new Request("https://kit.example/runner/poll", { method: "POST" }), e);
  assert.equal(runner.status, 401);
  assert.equal((await fromApp(e, "/feedback", "someone", undefined, "pager")).status, 403);
  assert.equal((await fromApp(e, "/feedback", "someone", { text: "hi" })).status, 503);
});

test("sends at once each take their own place under the daily issue cap", async () => {
  const store = senderStore(memoryD1(), memoryBucket(), "prhub", "octocat");
  const now = Date.parse("2026-11-12T10:00:00Z");
  const taken = await Promise.all(Array.from({ length: 14 }, () => takeIssue(store, now)));
  assert.equal(taken.filter(Boolean).length, 10);
  assert.equal(await takeIssue(store, now + 86_400_001), true, "a day later there is room again");
});

test("the app may name its sender; the runner's work carries the name, and the list each chat's thread", async () => {
  const e = env();
  const named = await serveFeatureKit(
    new Request("https://kit.example/feedback", {
      method: "POST",
      headers: {
        Authorization: "Bearer caller",
        "X-FeedbackKit-App": "pager",
        "X-FeedbackKit-Login": "Octocat",
        "X-FeedbackKit-Name": "Octo Cat",
      },
      body: JSON.stringify({ text: "Bigger clock" }),
    }),
    e,
  );
  const chat = await named.json();
  const { work } = await (await fromRunner(e, "poll", { orca: true })).json();
  assert.deepEqual(
    work.map((item: Record<string, unknown>) => [item.chat, item.login, item.name]),
    [[chat.id, "octocat", "Octo Cat"]],
  );
  await fromRunner(e, "agent", {
    app: "pager",
    login: "octocat",
    chat: chat.id,
    messages: [],
    isWorking: true,
    activity: null,
    thread: { host: "borg-cube-03", id: "orca-codex:1" },
  });
  const list = await (await fromApp(e, "/feedback", "octocat", undefined, "pager")).json();
  assert.deepEqual(
    list.threads.map((row: { id: string; thread: unknown }) => [row.id, row.thread]),
    [[chat.id, { host: "borg-cube-03", id: "orca-codex:1" }]],
  );
});

test("GET /about serves the live architecture dashboard HTML and sanitized status API", async () => {
  const e = env();
  const res = await serveFeatureKit(new Request("https://kit.example/about"), e);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type") ?? "", /^text\/html/);
  const html = await res.text();
  assert.match(html, /Feedback Loop — Mathematical Tree/);
  assert.match(html, /\/about\/status\.json/);

  await fromApp(e, "/feedback", "octocat", { text: "Secret user message should never leak" });
  await fromRunner(e, "poll", { orca: true });

  const unauthPush = await serveFeatureKit(
    new Request("https://kit.example/runner/rex-status", { method: "POST", body: "{}" }),
    e,
  );
  assert.equal(unauthPush.status, 401);

  const pushRes = await serveFeatureKit(
    new Request("https://kit.example/runner/rex-status", {
      method: "POST",
      headers: { Authorization: "Bearer runner", "Content-Type": "application/json" },
      body: JSON.stringify({
        session_name: "feedback-loop",
        session_active: true,
        coordinator_active: true,
        coordinator_state: "idle",
        inbox_pending: 2,
        claim_apps: [],
        runs: [{ chat_id: "fb-1a2b", app: "prhub", agent: "claude", status: "active" }],
      }),
    }),
    e,
  );
  assert.equal(pushRes.status, 200);

  const statusRes = await serveFeatureKit(new Request("https://kit.example/about/status.json"), e);
  assert.equal(statusRes.status, 200);
  const rawText = await statusRes.text();
  assert.doesNotMatch(rawText, /Secret user message/);
  const status = JSON.parse(rawText);
  assert.equal(status.worker.total_chats, 1);
  assert.equal(status.worker.pending_messages, 1);
  assert.equal(status.orca.online, true);
  assert.equal(status.rex.connected, true);
  assert.equal(status.rex.coordinator_active, true);
  assert.equal(status.rex.inbox_pending, 2);
  assert.equal(status.rex.runs.length, 1);
  assert.equal(status.components.menubar_about, "unbuilt");
  assert.equal(status.components.go_runner, "live");

  const wv = await serveFeatureKit(new Request("https://kit.example/about/worldview"), e);
  assert.equal(wv.status, 200);
  assert.match(wv.headers.get("Content-Type") ?? "", /^text\/html/);
  const wvHtml = await wv.text();
  assert.match(wvHtml, /30-Second Mental Model/);
  assert.match(wvHtml, /Copy Resume Prompt/);
  assert.match(wvHtml, /data-term="runner"/);

  const unauthInspect = await serveFeatureKit(new Request("https://kit.example/about/inspect"), e);
  assert.equal(unauthInspect.status, 401);
  const pushInspect = await serveFeatureKit(
    new Request("https://kit.example/runner/rex-inspect", {
      method: "POST",
      headers: { Authorization: "Bearer runner", "Content-Type": "application/json" },
      body: JSON.stringify({
        session_name: "feedback-loop",
        panes: [
          {
            id: "fable-coordinator",
            label: "Fable 5.2",
            kind: "coordinator",
            status: "idle",
            capture: "Fable prompt ready",
          },
        ],
        recent_inbox: [{ id: "ev-1", kind: "new_chat", chat_id: "fb-1a2b", summary: "Fix font" }],
      }),
    }),
    e,
  );
  assert.equal(pushInspect.status, 200);
  const inspectRes = await serveFeatureKit(
    new Request("https://kit.example/about/inspect", { headers: { Authorization: "Bearer runner" } }),
    e,
  );
  assert.equal(inspectRes.status, 200);
  const inspected = await inspectRes.json();
  assert.equal(inspected.panes.length, 1);
  assert.equal(inspected.panes[0].capture, "Fable prompt ready");
  assert.equal(inspected.recent_inbox.length, 1);
});
