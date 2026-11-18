import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContentBlock, UserMessageUpdate } from "@jai/agentchat-live";
import { type FeatureKitEnv, serveFeatureKit } from "../src/featurekit.ts";
import { liveAdapter } from "../src/live.ts";
import { issueToken } from "../src/token.ts";
import { memoryBucket, memoryD1 } from "./d1.ts";

const APPS = JSON.stringify({
  pager: { repo: "acme/pager", owners: ["octocat"], builders: ["builder"], issues: true },
  e2e: { repo: "acme/kit", owners: ["tester"], echo: true },
});
const KEYS = { pager: "pager-key-0123456789abcdef", e2e: "e2e-key-0123456789abcdef" };
const PNG = { media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" };
/** Bytes that stand for a QuickTime file: the Worker keeps and serves them as they came. */
const MOVIE = Uint8Array.from({ length: 4096 }, (_, index) => (index * 7) % 256);

function env() {
  return {
    FEEDBACK: memoryBucket(),
    DB: memoryD1(),
    APPS,
    CALLER_TOKEN: "caller",
    RUNNER_TOKEN: "runner",
    APP_KEYS: JSON.stringify(KEYS),
  } satisfies FeatureKitEnv;
}
type Env = ReturnType<typeof env>;

const token = (login = "octocat", app: "pager" | "e2e" = "pager") =>
  issueToken(KEYS[app], app, login, null, Date.now());

async function call(e: FeatureKitEnv, path: string, bearer: string, method = "GET", body?: unknown) {
  return serveFeatureKit(
    new Request(`https://kit.example${path}`, {
      method,
      headers: { Authorization: `Bearer ${bearer}` },
      body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
    }),
    e,
  );
}

interface Ticket {
  uploadUrl: string;
  uri: string;
  headers: Record<string, string>;
}

async function ticket(e: Env, bearer: string, size = MOVIE.byteLength, mimeType = "video/quicktime") {
  return call(e, "/v2/feedback/uploads", bearer, "POST", { name: "clip.mov", mimeType, size });
}

/** A video up, as the app sends one: room, then its bytes. Answers the `uri` a message names it by. */
async function uploaded(e: Env, bearer: string, bytes = MOVIE): Promise<string> {
  const room = (await (await ticket(e, bearer, bytes.byteLength)).json()) as Ticket;
  assert.equal((await call(e, room.uploadUrl, bearer, "PUT", bytes)).status, 200);
  return room.uri;
}

const count = (e: Env, sql: string) => Number((e.DB.sqlite.prepare(sql).get() as { n: number }).n);

test("an upload asks for room, its ticket says where its bytes go, and the bytes are kept raw with their type", async () => {
  const e = env();
  const bearer = await token();
  const answer = await ticket(e, bearer);
  assert.equal(answer.status, 200);
  const room = (await answer.json()) as Ticket;
  assert.match(room.uri, /^\/v2\/feedback\/uploads\/up_[0-9a-f]{16}$/);
  assert.equal(room.uploadUrl, room.uri);
  assert.deepEqual(room.headers, { "Content-Type": "video/quicktime" });
  assert.equal((await call(e, room.uploadUrl, bearer, "PUT", MOVIE)).status, 200);
  const [key, kept] = [...e.FEEDBACK.objects].find(([name]) => name.includes("/feedback/uploads/"))!;
  assert.ok(key.startsWith("apps/pager/users/octocat/"), "under the sender's own prefix");
  assert.deepEqual(kept.body, MOVIE);
  assert.equal(kept.contentType, "video/quicktime");
  assert.equal((await call(e, room.uploadUrl, bearer, "PUT", MOVIE)).status, 200, "a retried PUT is fine");
});

test("an upload is refused too large, of a type it won't take, with no size, with no token, or for an issue", async () => {
  const e = env();
  const bearer = await token();
  assert.equal((await ticket(e, bearer, 50 * 1024 * 1024 + 1)).status, 413);
  assert.equal((await ticket(e, bearer, 50 * 1024 * 1024)).status, 200, "50 MB is the most");
  assert.equal((await ticket(e, bearer, 10, "video/webm")).status, 415);
  assert.equal((await ticket(e, bearer, 10, "image/png")).status, 415);
  assert.equal((await ticket(e, bearer, 10, "video/mp4")).status, 200);
  assert.equal((await call(e, "/v2/feedback/uploads", bearer, "POST", { mimeType: "video/mp4" })).status, 400);
  assert.equal((await ticket(e, "nope")).status, 401);
  assert.equal((await ticket(e, await token("someone"))).status, 403, "everyone else's feedback is an issue");
  assert.equal((await ticket(e, await token("builder"))).status, 200, "a builder sends videos too");
  assert.equal((await call(e, "/v2/feedback/uploads", bearer)).status, 404, "GET is not a route");
});

test("a PUT is refused larger than it asked room for, for another sender's upload, or an unknown one", async () => {
  const e = env();
  const bearer = await token();
  const room = (await (await ticket(e, bearer, 100)).json()) as Ticket;
  assert.equal((await call(e, room.uploadUrl, bearer, "PUT", MOVIE)).status, 413);
  assert.equal(
    (await call(e, room.uploadUrl, await token("builder"), "PUT", MOVIE.slice(0, 100))).status,
    404,
    "another sender's upload",
  );
  assert.equal((await call(e, "/v2/feedback/uploads/up_0000000000000000", bearer, "PUT", MOVIE)).status, 404);
  assert.equal((await call(e, room.uploadUrl, bearer, "PUT", new Uint8Array(0))).status, 400);
  assert.equal(count(e, "SELECT count(*) AS n FROM uploads WHERE put_at IS NOT NULL"), 0, "nothing was put");
  assert.equal((await call(e, room.uploadUrl, bearer, "PUT", MOVIE.slice(0, 100))).status, 200);
});

test("a sender holds at most ten uploads no message took; a day later they are gone, bytes and all", async () => {
  const e = env();
  const bearer = await token();
  for (let index = 0; index < 10; index += 1) {
    await uploaded(e, bearer);
  }
  assert.equal((await ticket(e, bearer)).status, 429);
  e.DB.sqlite.prepare("UPDATE uploads SET created_at = created_at - 86400001").run();
  assert.equal((await ticket(e, bearer)).status, 200);
  assert.equal(count(e, "SELECT count(*) AS n FROM uploads"), 1);
  assert.equal([...e.FEEDBACK.objects.keys()].filter((key) => key.includes("/uploads/")).length, 0);
});

test("a message may be only a video: kept after its pictures, with its size and length, the upload taken once", async () => {
  const e = env();
  const bearer = await token();
  const uri = await uploaded(e, bearer);
  const sent = await call(e, "/v2/feedback", bearer, "POST", {
    text: "",
    videos: [{ uri, mimeType: "video/quicktime", size: MOVIE.byteLength, duration_ms: 10_000 }],
    client_ref: "v1",
  });
  assert.equal(sent.status, 200);
  const chat = (await sent.json()) as { id: string; messages: Array<{ images: number; videos?: number }> };
  assert.deepEqual(
    chat.messages.map(({ images, videos }) => ({ images, videos })),
    [{ images: 1, videos: 1 }],
    "an app from before videos still sees one attachment",
  );
  const list = (await (await call(e, "/v2/feedback", bearer)).json()) as { threads: Array<{ title: string }> };
  assert.equal(list.threads[0].title, "Video");
  const again = await call(e, "/v2/feedback", bearer, "POST", {
    text: "",
    videos: [{ uri, mimeType: "video/quicktime", size: MOVIE.byteLength }],
    client_ref: "v1",
  });
  assert.equal(((await again.json()) as { id: string }).id, chat.id, "a retry answers the first send");
  const reused = await call(e, `/v2/feedback/${chat.id}`, bearer, "POST", {
    text: "Same video again",
    videos: [{ uri, mimeType: "video/quicktime", size: MOVIE.byteLength }],
  });
  assert.equal(reused.status, 400, "an upload goes on one message");
  assert.equal((await call(e, uri, bearer, "PUT", MOVIE)).status, 409, "a taken upload's bytes stay");

  const picture = await uploaded(e, bearer);
  const mixed = (await (
    await call(e, `/v2/feedback/${chat.id}`, bearer, "POST", {
      text: "Both",
      images: [PNG],
      videos: [{ uri: picture, mimeType: "video/quicktime", size: MOVIE.byteLength, duration_ms: 1_500 }],
    })
  ).json()) as { messages: Array<{ id: string }> };
  const message = mixed.messages[1].id;
  const video = await call(e, `/v2/feedback/${chat.id}/images/${message}/1`, bearer);
  assert.equal(video.status, 200);
  assert.equal(video.headers.get("Content-Type"), "video/quicktime");
  assert.equal(video.headers.get("Content-Length"), String(MOVIE.byteLength));
  assert.deepEqual(new Uint8Array(await video.arrayBuffer()), MOVIE, "the raw bytes, not base64");
  assert.equal(
    (await call(e, `/v2/feedback/${chat.id}/images/${message}/0`, bearer)).headers.get("Content-Type"),
    "image/png",
  );
  assert.equal(
    (await call(e, `/v2/feedback/${chat.id}/images/${message}/1`, await token("builder"))).status,
    404,
    "served to its sender alone",
  );
});

test("a message's videos are refused unless each is the sender's own put upload, at most two", async () => {
  const e = env();
  const bearer = await token();
  const send = (videos: unknown) => call(e, "/v2/feedback", bearer, "POST", { text: "See", videos });
  const room = (await (await ticket(e, bearer)).json()) as Ticket;
  assert.equal((await send([{ uri: room.uri }])).status, 400, "room asked for, no bytes put");
  const theirs = await uploaded(e, await token("builder"));
  assert.equal((await send([{ uri: theirs }])).status, 400, "another sender's upload");
  assert.equal((await send([{ uri: "/v2/feedback/uploads/up_0000000000000000" }])).status, 400);
  assert.equal((await send([{ uri: "https://elsewhere.example/clip.mov" }])).status, 400);
  const [a, b, c] = [await uploaded(e, bearer), await uploaded(e, bearer), await uploaded(e, bearer)];
  assert.equal((await send([{ uri: a }, { uri: b }, { uri: c }])).status, 400, "three videos");
  assert.equal((await send([{ uri: a }, { uri: a }])).status, 400, "one video twice");
  assert.equal((await send([{ uri: a, duration_ms: -1 }])).status, 400);
  assert.equal(
    (
      await call(e, "/v2/feedback", bearer, "POST", {
        text: "",
        images: [PNG, PNG, PNG],
        videos: [{ uri: a }, { uri: b }],
      })
    ).status,
    400,
    "more than four attachments",
  );
  assert.equal(count(e, "SELECT count(*) AS n FROM messages"), 0);
  assert.equal(count(e, "SELECT count(*) AS n FROM uploads WHERE message IS NOT NULL"), 0);
  assert.equal((await send([{ uri: a }, { uri: b }])).status, 200);
  assert.equal(count(e, "SELECT count(*) AS n FROM uploads WHERE message IS NOT NULL"), 2);
  const issue = await call({ ...e, ISSUES_TOKEN: "issues" }, "/v2/feedback", await token("someone"), "POST", {
    text: "x",
    videos: [{ uri: c }],
  });
  assert.equal(issue.status, 400, "an issue takes no videos");
});

test("live: a video is a resource_link named Video N, with its size and length, after the screenshots", async () => {
  const e = env();
  const bearer = await token();
  const uri = await uploaded(e, bearer);
  const chat = (await (
    await call(e, "/v2/feedback", bearer, "POST", {
      text: "Look",
      images: [PNG],
      videos: [{ uri, mimeType: "video/quicktime", size: MOVIE.byteLength, duration_ms: 10_000 }],
    })
  ).json()) as { id: string };
  const who = { app: "pager", login: "octocat", name: null };
  const adapter = liveAdapter({ db: e.DB, bucket: e.FEEDBACK, verify: async () => who, sent: async () => {} });
  const answer = await adapter.read(who, chat.id, null);
  assert.ok(!answer.expired);
  const message = answer.updates.find(({ update }) => update.sessionUpdate === "user_message")!
    .update as UserMessageUpdate;
  const id = message.messageId;
  assert.deepEqual(message.content.slice(1) as ContentBlock[], [
    {
      type: "resource_link",
      name: "Screenshot 1",
      mimeType: "image/png",
      uri: `/v2/feedback/${chat.id}/images/${id}/0`,
    },
    {
      type: "resource_link",
      name: "Video 1",
      mimeType: "video/quicktime",
      uri: `/v2/feedback/${chat.id}/images/${id}/1`,
      size: MOVIE.byteLength,
      _meta: { agentchatkit: { durationMs: 10_000 } },
    },
  ]);
});

test("the runner's claim names a video, never inlines it, and the runner fetches it with its own token", async () => {
  const e = env();
  const bearer = await token();
  const uri = await uploaded(e, bearer);
  const chat = (await (
    await call(e, "/v2/feedback", bearer, "POST", {
      text: "Watch",
      images: [PNG],
      videos: [{ uri, mimeType: "video/quicktime", size: MOVIE.byteLength, duration_ms: 7_250 }],
    })
  ).json()) as { id: string };
  const { work } = (await (await call(e, "/runner/poll", "runner", "POST", { orca: true })).json()) as {
    work: Array<{ message: string }>;
  };
  const who = { app: "pager", login: "octocat", chat: chat.id, message: work[0].message };
  const claimed = (await (await call(e, "/runner/claim", "runner", "POST", who)).json()) as {
    images: unknown[];
    videos: unknown[];
  };
  assert.deepEqual(claimed.images, [PNG], "the picture inline, as before");
  assert.deepEqual(claimed.videos, [
    { index: 1, media_type: "video/quicktime", size: MOVIE.byteLength, duration_ms: 7_250 },
  ]);
  const media = await call(e, "/runner/media", "runner", "POST", { ...who, index: 1 });
  assert.equal(media.status, 200);
  assert.equal(media.headers.get("Content-Type"), "video/quicktime");
  assert.deepEqual(new Uint8Array(await media.arrayBuffer()), MOVIE);
  assert.equal((await call(e, "/runner/media", "runner", "POST", { ...who, index: 2 })).status, 404);
  assert.equal((await call(e, "/runner/media", bearer, "POST", { ...who, index: 1 })).status, 401, "a sender's token");
  assert.equal(
    (await call(e, "/runner/media", "runner", "POST", { ...who, login: "builder", index: 1 })).status,
    404,
    "another sender's chat",
  );
});

test("a test app's chat goes with its videos: their bytes and their uploads", async () => {
  const e = env();
  const bearer = await token("tester", "e2e");
  const uri = await uploaded(e, bearer);
  const chat = (await (await call(e, "/v2/feedback", bearer, "POST", { text: "", videos: [{ uri }] })).json()) as {
    id: string;
  };
  assert.equal([...e.FEEDBACK.objects.keys()].length, 1);
  assert.equal((await call(e, `/v2/feedback/${chat.id}`, bearer, "DELETE")).status, 200);
  assert.equal([...e.FEEDBACK.objects.keys()].length, 0, "the video's bytes are gone");
  assert.equal(count(e, "SELECT count(*) AS n FROM uploads"), 0);
  assert.equal(count(e, "SELECT count(*) AS n FROM images"), 0);
});
