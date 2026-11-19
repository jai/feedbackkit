import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isFeedbackId,
  listServedLog,
  parseAgentSide,
  parseFeedbackInput,
  threadAgentState,
  titleOf,
} from "../../src/feedback.ts";

const JPEG = "/9j/4AAQSkZJRg==";

test("feedback is words with the build it is about, and nothing else gets through", () => {
  assert.deepEqual(parseFeedbackInput({ text: "  The back button jumps  ", build: "142" }), {
    text: "The back button jumps",
    build: "142",
    images: [],
    videos: [],
  });
  assert.equal(parseFeedbackInput({ text: "   " }), null);
  assert.equal(parseFeedbackInput({ text: "x".repeat(8_001) }), null);
  assert.equal(parseFeedbackInput({ text: "ok", build: "1; rm -rf /" })?.build, null);
  assert.equal(isFeedbackId("fb_0123456789abcdef"), true);
  assert.equal(isFeedbackId("sesn_011CgjX"), false);
  assert.equal(isFeedbackId("../chats.json"), false);
  assert.equal(titleOf(`${"a".repeat(80)}\nsecond line`).length, 60);
  assert.equal(titleOf(""), "Screenshot");
});

test("only up to four JPEG or PNG screenshots of at most 1.5 MB get through", () => {
  const one = { media_type: "image/jpeg", data: JPEG };
  assert.equal(parseFeedbackInput({ text: "x", images: [one, one, one, one] })?.images.length, 4);
  for (const images of [
    [one, one, one, one, one],
    [{ media_type: "image/gif", data: JPEG }],
    [{ media_type: "image/png", data: JPEG }],
    [{ media_type: "image/jpeg", data: "/9j/ not base64" }],
    [{ media_type: "image/jpeg", data: `/9j/${"A".repeat(2_000_000)}` }],
    "nope",
  ]) {
    assert.equal(parseFeedbackInput({ text: "x", images }), null);
  }
});

test("the agent's side is checked before it is kept", () => {
  assert.equal(parseAgentSide({ messages: "no", isWorking: true, activity: null }, 0), null);
  assert.equal(
    parseAgentSide({ messages: [{ id: "a", text: "x", at: "soon" }], isWorking: true, activity: null }, 0),
    null,
  );
  assert.equal(parseAgentSide({ messages: [], isWorking: "yes", activity: null }, 0), null);
  assert.deepEqual(parseAgentSide({ messages: [], isWorking: false, activity: null, thread: { host: 1 } }, 5), {
    messages: [],
    isWorking: false,
    activity: null,
    thread: null,
    updatedAt: 5,
  });
});

test("a list read logs what the app was told about the builder", () => {
  const line = JSON.parse(
    listServedLog({ online: false, lastPollAt: new Date(1_000).toISOString(), detail: "Orca down" }, 2, 31_000),
  );
  assert.deepEqual(line, {
    event: "feedback_list_served",
    builderOnline: false,
    runnerPollAgeSeconds: 30,
    detail: "Orca down",
    threads: 2,
  });
});

test("a thread's state on the list: queued, working, needs you or idle", () => {
  const side = (isWorking: boolean, updatedAt: number, activity: string | null = null) => ({
    messages: [],
    isWorking,
    activity,
    thread: null,
    updatedAt,
  });
  assert.deepEqual(threadAgentState(null, null, null, false), { state: "idle", activity: null });
  assert.deepEqual(threadAgentState(null, 1000, null, true), { state: "working", activity: null, queued: true });
  assert.deepEqual(threadAgentState(side(true, 2000, "Running tests"), 1000, 1500, false), {
    state: "working",
    activity: "Running tests",
  });
  // A message after the agent's last look: it waits for the agent's turn.
  assert.deepEqual(threadAgentState(side(false, 1000), 2000, 900, false), {
    state: "working",
    activity: null,
    queued: true,
  });
  // The agent working wins over a message still waiting.
  assert.deepEqual(threadAgentState(side(true, 1000, "Building"), 2000, 900, true), {
    state: "working",
    activity: "Building",
  });
  // The agent spoke last and stopped: it waits on the sender.
  assert.deepEqual(threadAgentState(side(false, 3000), 1000, 2500, false), { state: "needs_you", activity: null });
  // The sender spoke last and the agent has seen it but said nothing: idle.
  assert.deepEqual(threadAgentState(side(false, 3000), 2000, 1500, false), { state: "idle", activity: null });
});
