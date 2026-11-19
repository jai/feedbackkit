import assert from "node:assert/strict";

import { test } from "node:test";

import { feedbackChat, feedbackList, pendingWork, runnerClaim, senderStore } from "../../src/feedback.ts";

import { d1Counts, migrate } from "../../src/migrate.ts";

import { memoryBucket, memoryD1 } from "./d1.ts";

const CHAT = "fb_8ef88036d98cbb5f";

const OTHER = "fb_0123456789abcdef";

const M1 = "m_003c8a89e6c0088b";

const M2 = "m_c5c5d282b570ff16";

const M3 = "m_1111111111111111";

const P = "apps/agent-pager/users/jai/";

const PNG = "iVBORw0KGgoAAAANSUhEUg==";

/** R2 as the Worker left it before D1: a list, two chats, messages, a screenshot, an agent side, a receipt, a beat. */
function r2() {
  const bucket = memoryBucket();
  const put = (key: string, value: unknown) => bucket.objects.set(key, { body: JSON.stringify(value), etag: "v" });
  put(`${P}feedback/chats.json`, [
    { id: CHAT, title: "Runner cutover test", createdAt: "2026-11-15T04:32:07.000Z" },
    { id: OTHER, title: "Bigger clock", createdAt: "2026-11-14T01:00:00.000Z" },
  ]);
  const message = (id: string, at: number, status: string, first: boolean, images = 0) => ({
    id,
    at,
    text: `text of ${id}`,
    build: "181",
    images,
    first,
    status,
    claimedAt: status === "pending" ? null : at + 5,
    detail: null,
  });
  put(`${P}feedback/chats/${CHAT}/m/1794716927000-${M1}.json`, message(M1, 1794716927000, "delivered", true, 1));
  put(`${P}feedback/chats/${CHAT}/m/1794717294000-${M2}.json`, message(M2, 1794717294000, "delivered", false));
  put(`${P}feedback/chats/${CHAT}/img/${M1}/0.json`, { media_type: "image/png", data: PNG });
  put(`${P}feedback/chats/${CHAT}/agent.json`, {
    messages: [{ id: "a1", text: "ok", at: "2026-11-15T04:32:30.000Z" }],
    isWorking: false,
    activity: null,
    thread: { host: "borg-cube-03", id: "orca-codex:01a1" },
    updatedAt: 1794716960000,
  });
  put(`${P}feedback/chats/${OTHER}/m/1794700000000-${M3}.json`, message(M3, 1794700000000, "pending", true));
  put(`${P}refs/${"a".repeat(64)}.json`, { chat: CHAT });
  put(`${P}feedback/runner.json`, { at: 1794717300000, orca: true, detail: null });
  put(`${P}feedback/threads.json`, [{ id: "sesn_01Fmk", title: "old", createdAt: "2026-11-09T12:24:28.953Z" }]);
  put(`${P}feedback/pending/1794700000000-${OTHER}-${M3}`, { chat: OTHER, message: M3 });
  return { bucket, put };
}

test("every chat, message, state, screenshot, side and receipt moves, and the counts match R2", async () => {
  const { bucket } = r2();
  const db = memoryD1();
  const report = await migrate(bucket, db);
  const id = "agent-pager/jai";
  assert.deepEqual(report.r2[id], report.d1[id]);
  assert.deepEqual(report.d1[id], {
    chats: 2,
    issueChats: 0,
    messages: 3,
    statuses: { delivered: 2, pending: 1 },
    images: 1,
    refs: 1,
    withThread: 1,
  });
  assert.deepEqual(
    report.skipped.map(({ key }) => key.slice(P.length)),
    ["feedback/threads.json"],
    "only the old Managed Agents list, which the Worker never served, stays behind",
  );
  const store = senderStore(db, bucket, "agent-pager", "jai");
  const list = await feedbackList(store, 1794717300000 + 1_000);
  assert.deepEqual(
    list.threads.map(({ id: chat, title, thread }) => [chat, title, thread]),
    [
      [CHAT, "Runner cutover test", { host: "borg-cube-03", id: "orca-codex:01a1" }],
      [OTHER, "Bigger clock", null],
    ],
  );
  assert.equal(list.builderOnline, true, "the runner's last beat came across");
  const chat = (await feedbackChat(store, CHAT, 1794717300000))!;
  assert.deepEqual(
    chat.messages.map(({ role, text, status }) => [role, text, status]),
    [
      ["you", `text of ${M1}`, "delivered"],
      ["agent", "ok", undefined],
      ["you", `text of ${M2}`, "delivered"],
    ],
  );
  assert.deepEqual(
    (await pendingWork(store)).map(({ chat: one, message }) => [one, message]),
    [[OTHER, M3]],
  );
  const claimed = await runnerClaim(store, CHAT, M1, 0);
  assert.equal(claimed.ok, false, "a delivered message is never claimed again");
  assert.equal(bucket.objects.size, 10, "R2 is only read");
});

test("a second run is idempotent, moves states only forward and takes only a newer agent side", async () => {
  const { bucket, put } = r2();
  const db = memoryD1();
  await migrate(bucket, db);
  const store = senderStore(db, bucket, "agent-pager", "jai");
  // Since the first run: the runner claimed M3 in D1, and the old Worker wrote an older side and a new message to R2.
  assert.equal((await runnerClaim(store, OTHER, M3, 1794717400000)).ok, true);
  put(`${P}feedback/chats/${OTHER}/m/1794700000000-${M3}.json`, {
    id: M3,
    at: 1794700000000,
    text: `text of ${M3}`,
    build: "181",
    images: 0,
    first: true,
    status: "pending",
    claimedAt: null,
    detail: null,
  });
  put(`${P}feedback/chats/${CHAT}/agent.json`, {
    messages: [],
    isWorking: true,
    activity: "stale",
    thread: null,
    updatedAt: 1,
  });
  const M4 = "m_4444444444444444";
  put(`${P}feedback/chats/${CHAT}/m/1794717400000-${M4}.json`, {
    id: M4,
    at: 1794717400000,
    text: "late",
    build: null,
    images: 0,
    first: false,
    status: "pending",
    claimedAt: null,
    detail: null,
  });
  const again = await migrate(bucket, db);
  assert.deepEqual(again.d1["agent-pager/jai"].statuses, { delivered: 2, delivering: 1, pending: 1 });
  const chat = (await feedbackChat(store, CHAT, 1794717400001))!;
  assert.deepEqual(chat.thread, { host: "borg-cube-03", id: "orca-codex:01a1" }, "the older side did not replace it");
  assert.equal(chat.messages.at(-1)!.text, "late");
  assert.deepEqual(await d1Counts(db, "agent-pager", "jai"), again.d1["agent-pager/jai"]);
});
