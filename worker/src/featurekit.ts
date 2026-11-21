/**
 * The FeedbackKit Worker (docs/worker.md): one Worker that keeps every app's feedback. An app's own Worker checks
 * who is asking, as it does for every route, and forwards `/feedback` here with the app and the sender's GitHub login.
 * Per app, the config names who builds: an owner's feedback goes to a coding agent that ships, a builder's to one that
 * opens a pull request, and anyone else's opens a public issue. The runner on Jai's Mac takes the agents' work.
 */
import { aboutResponse, aboutStatusResponse, putRexStatus } from "./about.ts";
import { worldviewResponse } from "./worldview.ts";
import {
  addFeedback,
  chatOfRef,
  chatSide,
  deleteChat,
  messageImage,
  newUpload,
  putUpload,
  uploadRoom,
  videosReady,
  feedbackChat,
  feedbackList,
  type FeedbackStore,
  isFeedbackId,
  keepRef,
  listServedLog,
  parseAgentSide,
  parseFeedbackInput,
  pendingWork,
  runnerAgent,
  runnerBeat,
  runnerClaim,
  runnerResult,
  senderStore,
} from "./feedback.ts";
import {
  addIssueFeedback,
  gitHubIssues,
  type IssueFeedback,
  issueChat,
  issuesNotice,
  issueThreads,
  isImageName,
} from "./feedback-issues.ts";
import { createLiveRoom, handleAcp, type LiveRooms, notifyChat } from "@jai/agentchat-live";
import { liveAdapter, type LiveWho } from "./live.ts";
import { migrate } from "./migrate.ts";
import { agentPush, type ApnsKey, checkKey, type Device, type Push, sendPush } from "./push.ts";
import { runnerWake, wakeRunner } from "./runner-wake.ts";
import { verifyToken } from "./token.ts";
import { clientRefOf, sha256Hex } from "./util.ts";

/** Live mode: one room per followed chat (live.ts, the package `@jai/agentchat-live`). Read again every 15 s while
 * followed, for changes no write makes. */
export const FeedbackLiveRoom = createLiveRoom((env: FeatureKitEnv) => liveAdapter(liveDeps(env)), {
  refreshEvery: 15_000,
});
export { RunnerWake } from "./runner-wake.ts";

export interface FeatureKitEnv {
  /** Screenshots: each message's, and the public ones issues link to. */
  FEEDBACK: R2Bucket;
  /** Every chat, message, delivery state and coding thread (migrations/0001_feedback.sql). */
  DB: D1Database;
  /** `{"<app>": {"repo": "owner/name", "owners": [logins], "builders": [logins], "issues": true}}`. */
  APPS: string;
  /** The app Workers' bearer: they have checked the sender, and say who it is. */
  CALLER_TOKEN: string;
  /** The runner's bearer. */
  RUNNER_TOKEN: string;
  /** Where the screenshots are served, for issue links: a request through a service binding names no public host. */
  PUBLIC_URL?: string;
  /** Opens the public issues: a token that can open issues on each app's repo. */
  ISSUES_TOKEN?: string;
  /** Each app's key for FeedbackKit tokens (token.ts): `{"<app>": "<key>"}`. Without one, an app has no /v2. */
  APP_KEYS?: string;
  /** The team's APNs key (push.ts): one key pushes to every app's `topic`. Without all three, no pushes. */
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_KEY_P8?: string;
  /** Runs the move from R2 to D1 (`POST /admin/migrate`, migrate.ts); without it that route is `404`. */
  ADMIN_TOKEN?: string;
  /** Live mode (live.ts): the rooms, and the secret that signs ACP connection ids. Without both, `/v2/acp` is `404`. */
  LIVE_ROOMS?: DurableObjectNamespace;
  ACP_SECRET?: string;
  /** The runner's long poll (runner-wake.ts). Without it `/runner/wait` is `404` and the runner polls every 15 s. */
  RUNNER_WAKE?: DurableObjectNamespace;
  /** Optional Cloudflare IDs used to render deep links on `/about`. */
  CF_ACCOUNT_ID?: string;
  D1_DATABASE_ID?: string;
}

export type Role = "owner" | "builder" | "issue";

export interface AppConfig {
  repo: string;
  owners: string[];
  builders: string[];
  issues: boolean;
  /** How the app names a sender ("jai": "Jai") when its Worker sends no `X-FeedbackKit-Name`. */
  names: Record<string, string>;
  /** The app's bundle id: where its pushes go. None: no pushes. */
  topic: string | null;
  /**
   * A test app (docs/api.md#the-test-app): the runner answers each message itself with an echo, never a coding agent,
   * an issue or a brief, and its chats may be deleted. Never true for an app people use.
   */
  echo: boolean;
}

const APP_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;

export function parseApps(raw: string): Record<string, AppConfig> {
  const parsed = JSON.parse(raw) as Record<string, Partial<AppConfig>>;
  const lower = (logins: unknown) =>
    Array.isArray(logins)
      ? logins.filter((login): login is string => typeof login === "string").map((login) => login.toLowerCase())
      : [];
  return Object.fromEntries(
    Object.entries(parsed)
      .filter(
        ([name, app]) => APP_NAME.test(name) && typeof app?.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(app.repo),
      )
      .map(([name, app]) => [
        name,
        {
          repo: app.repo!,
          owners: lower(app.owners),
          builders: lower(app.builders),
          issues: app.issues === true && app.echo !== true,
          names: Object.fromEntries(
            Object.entries(app.names ?? {})
              .filter(([, name]) => typeof name === "string" && senderName(name) !== null)
              .map(([login, name]) => [login.toLowerCase(), name]),
          ),
          topic: typeof app.topic === "string" && /^[\w.-]{1,155}$/.test(app.topic) ? app.topic : null,
          echo: app.echo === true,
        },
      ]),
  );
}

export function roleOf(app: AppConfig, login: string): Role | null {
  const name = login.toLowerCase();
  return app.owners.includes(name) ? "owner" : app.builders.includes(name) ? "builder" : app.issues ? "issue" : null;
}

/** One sender's own corner of R2, where their screenshots are. */
export function senderPrefix(app: string, login: string): string {
  return `apps/${app}/users/${login.toLowerCase()}/`;
}

/** How the app names the sender ("Jai"), from `X-FeedbackKit-Name`: at most 60 characters, no line breaks. */
export function senderName(value: string | null): string | null {
  const name = value?.trim() ?? "";
  return name && name.length <= 60 && !/[\r\n]/.test(name) ? name : null;
}

/** New issues one sender may open in 24 hours; replies on them do not count. */
const ISSUES_PER_DAY = 10;

/**
 * Takes one of the sender's new issues for today, or answers false when they have none left. One statement counts
 * and takes, so sends at once each take their own place.
 */
export async function takeIssue(store: FeedbackStore, now: number): Promise<boolean> {
  const taken = await store.db
    .prepare(
      "INSERT INTO issue_opens (app, login, at) SELECT ?1, ?2, ?3 WHERE" +
        " (SELECT count(*) FROM issue_opens WHERE app = ?1 AND login = ?2 AND at > ?4) < ?5",
    )
    .bind(store.app, store.login, now, now - 86_400_000, ISSUES_PER_DAY)
    .run();
  return taken.meta.changes === 1;
}

const IMAGES = "images/";
const IMAGE_PATH = /^\/images\/([^/]+)$/;
const FEEDBACK_PATH = /^\/feedback(?:\/([^/]+))?$/;
/** The app's own routes on FeedbackKit's Worker, with a FeedbackKit token (docs/api.md#direct). */
const DIRECT_FEEDBACK_PATH = /^\/v2\/feedback(?:\/([^/]+))?$/;
/** A screenshot of the sender's own, for the live protocol's `resource_link` (agentchatkit docs/live-protocol.md). */
const IMAGE_OF_CHAT_PATH = /^\/v2\/feedback\/([^/]+)\/images\/([^/]+)\/(\d{1,2})$/;
/** A video's room (`POST`), and its bytes (`PUT .../{id}`), before the message that names it (docs/api.md#videos). */
const UPLOADS_PATH = /^\/v2\/feedback\/uploads(?:\/([^/]+))?$/;
const DEVICES_PATH = /^\/v2\/devices(?:\/([0-9a-f]{64,200}))?$/;
const APNS_TOKEN = /^[0-9a-f]{64,200}$/;
const RUNNER_PATH = /^\/runner\/(poll|claim|result|agent|wait|media)$/;

function hasBearer(request: Request, token: string | undefined): boolean {
  return !!token && request.headers.get("Authorization") === `Bearer ${token}`;
}

async function bodyOf(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

const notFound = () => Response.json({ error: "Not found." }, { status: 404 });

/** The sender's chats: an agent's (owner, builder) or issues, by their role in the app. */
async function feedbackRoute(
  id: string | undefined,
  request: Request,
  env: FeatureKitEnv,
  app: string,
  config: AppConfig,
  login: string,
  name: string | null,
): Promise<Response> {
  if (id !== undefined && !isFeedbackId(id)) {
    return notFound();
  }
  const role = roleOf(config, login);
  if (!role) {
    return Response.json({ error: "Feedback is not open to you in this app." }, { status: 403 });
  }
  const store = senderStore(env.DB, env.FEEDBACK, app, login, name);
  if (request.method === "DELETE") {
    return config.echo
      ? deleteRoute(id, store, env)
      : Response.json({ error: "Only the test app's chats can be deleted." }, { status: 403 });
  }
  const now = Date.now();
  let refusedVideo = false;
  if (role !== "issue") {
    if (request.method !== "POST") {
      if (!id) {
        const { threads, builderOnline, builderStatus } = await feedbackList(store, now);
        console.log(listServedLog(builderStatus, threads.length, now));
        return Response.json({ threads, builderOnline });
      }
      const chat = await feedbackChat(store, id, now);
      return chat ? Response.json(chat) : notFound();
    }
    const body = await bodyOf(request);
    const input = parseFeedbackInput(body);
    if (!input) {
      return Response.json({ error: "That feedback can't be sent." }, { status: 400 });
    }
    // A retry of a message that went names uploads it took already: its receipt answers before they are checked.
    const target = await once(store, id, body, async () => {
      if (!(await videosReady(store, input))) {
        refusedVideo = true;
        return null;
      }
      return addFeedback(store, id ?? null, input, now);
    });
    if (refusedVideo) {
      return Response.json({ error: "A video on this message has not been uploaded." }, { status: 400 });
    }
    if (target) {
      await Promise.all([wakeRunner(env.RUNNER_WAKE), chatChanged(env, target)]);
    }
    const chat = target ? await feedbackChat(store, target, now) : null;
    return chat ? Response.json(chat) : notFound();
  }
  if (!env.ISSUES_TOKEN) {
    return Response.json({ error: "Feedback issues are not set up." }, { status: 503 });
  }
  const context: IssueFeedback = {
    store,
    images: {
      async put(name, image) {
        const bytes = Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0));
        await env.FEEDBACK.put(`${IMAGES}${name}`, bytes, { httpMetadata: { contentType: image.media_type } });
      },
    },
    issues: gitHubIssues(config.repo, env.ISSUES_TOKEN),
    login,
    origin: env.PUBLIC_URL?.replace(/\/$/, "") || new URL(request.url).origin,
    imagePath: "/images/",
    repo: config.repo,
    now: Date.now,
  };
  if (request.method !== "POST") {
    if (!id) {
      return Response.json({
        threads: await issueThreads(store),
        builderOnline: true,
        notice: issuesNotice(config.repo),
      });
    }
    const chat = await issueChat(context, id);
    return chat ? Response.json(chat) : notFound();
  }
  const body = await bodyOf(request);
  const input = parseFeedbackInput(body);
  if (!input || input.videos?.length) {
    return Response.json(
      { error: input ? "Videos can't go on a public issue." : "That feedback can't be sent." },
      { status: 400 },
    );
  }
  let limited = false;
  const target = await once(store, id, body, async () => {
    if (!id && !(await takeIssue(store, now))) {
      limited = true;
      return null;
    }
    try {
      return await addIssueFeedback(context, id ?? null, input);
    } catch (error) {
      if (!id) {
        await giveBackIssue(store, now);
      }
      throw error;
    }
  });
  if (limited) {
    return Response.json(
      { error: `You can open ${ISSUES_PER_DAY} feedback issues a day. Try again tomorrow.` },
      { status: 429 },
    );
  }
  const chat = target ? await issueChat(context, target) : null;
  return chat ? Response.json(chat) : notFound();
}

/** A test app's chat, gone with its messages and screenshots (`DELETE /feedback/{id}`, docs/api.md#the-test-app). */
async function deleteRoute(id: string | undefined, store: FeedbackStore, env: FeatureKitEnv): Promise<Response> {
  const screenshots = id ? await deleteChat(store, id) : null;
  if (!id || !screenshots) {
    return notFound();
  }
  if (screenshots.length) {
    await env.FEEDBACK.delete(screenshots);
  }
  await chatChanged(env, id);
  return Response.json({ ok: true });
}

/**
 * A send with a `client_ref` is kept once: a retry answers the chat its first try made, and sends nothing again.
 * Two tries at the same moment can both go; the app's outbox sends one at a time.
 */
async function once(
  store: FeedbackStore,
  id: string | undefined,
  body: unknown,
  send: () => Promise<string | null>,
): Promise<string | null> {
  const ref = clientRefOf(body);
  const key = ref ? await sha256Hex(`${id ?? "new"}:${ref}`) : null;
  const seen = key ? await chatOfRef(store, key) : null;
  if (seen) {
    return seen;
  }
  const chat = await send();
  if (key && chat) {
    // Sent already: a receipt that can't be kept must not answer an error, or the app sends it again.
    await keepRef(store, key, chat).catch((error) => console.error("feedback receipt not kept", error));
  }
  return chat;
}

/** An issue that was not opened: its place under the cap goes back. */
async function giveBackIssue(store: FeedbackStore, at: number): Promise<void> {
  await store.db
    .prepare(
      "DELETE FROM issue_opens WHERE rowid IN" +
        " (SELECT rowid FROM issue_opens WHERE app = ? AND login = ? AND at = ? LIMIT 1)",
    )
    .bind(store.app, store.login, at)
    .run();
}

/** Which chats a runner message is about: the app, the sender and their store, from the body. */
function senderOf(body: Record<string, unknown> | null, apps: Record<string, AppConfig>, env: FeatureKitEnv) {
  const app = typeof body?.app === "string" ? body.app : "";
  const login = typeof body?.login === "string" ? body.login : "";
  const config = apps[app];
  const role = config && LOGIN.test(login) ? roleOf(config, login) : null;
  return config && role && role !== "issue"
    ? { app, login: login.toLowerCase(), config, role, store: senderStore(env.DB, env.FEEDBACK, app, login) }
    : null;
}

async function runnerRoute(
  kind: string,
  request: Request,
  env: FeatureKitEnv,
  apps: Record<string, AppConfig>,
  later: Later,
) {
  if (kind === "wait") {
    return env.RUNNER_WAKE
      ? runnerWake(env.RUNNER_WAKE).fetch("https://runner-wake/wait", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: await request.text(),
        })
      : Response.json({ error: "no long poll here" }, { status: 404 });
  }
  const body = (await bodyOf(request)) as Record<string, unknown> | null;
  const now = Date.now();
  if (kind === "poll") {
    const detail = typeof body?.detail === "string" ? body.detail : null;
    const senders = Object.entries(apps).flatMap(([app, config]) =>
      [...config.owners, ...config.builders].map((login) => ({ app, login, config, role: roleOf(config, login)! })),
    );
    await runnerBeat(env.DB, body?.orca === true, now, detail);
    const work = await Promise.all(
      senders.map(async ({ app, login, config, role }) =>
        (await pendingWork(senderStore(env.DB, env.FEEDBACK, app, login))).map((item) => ({
          ...item,
          app,
          login: login.toLowerCase(),
          repo: config.repo,
          role,
          name: item.name ?? config.names[login.toLowerCase()] ?? null,
          ...(config.echo ? { echo: true } : {}),
        })),
      ),
    );
    return Response.json({ work: work.flat().sort((a, b) => a.at - b.at) });
  }
  const sender = senderOf(body, apps, env);
  if (!sender) {
    return Response.json({ error: "no such app or sender" }, { status: 404 });
  }
  const chat = typeof body?.chat === "string" ? body.chat : "";
  const message = typeof body?.message === "string" ? body.message : "";
  if (kind === "claim") {
    const claimed = await runnerClaim(sender.store, chat, message, now);
    if (claimed.ok) {
      await chatChanged(env, chat);
      await later(
        pushTo(env, sender, { alert: null, data: { chat, app: sender.app, kind: "status", status: "delivering" } }),
      );
    }
    return claimed.ok
      ? Response.json({ ...claimed, app: sender.app, login: sender.login, repo: sender.config.repo, role: sender.role })
      : Response.json(
          { error: claimed.status === 404 ? "no such message" : "not pending" },
          { status: claimed.status },
        );
  }
  if (kind === "media") {
    const index = typeof body?.index === "number" ? body.index : -1;
    const found = await messageImage(sender.store, chat, message, index);
    return found ? attachmentResponse(found, "no-store") : Response.json({ error: "no such media" }, { status: 404 });
  }
  if (kind === "result") {
    const delivered = body?.status === "delivered";
    if (!delivered && body?.status !== "failed") {
      return Response.json({ error: "status is delivered or failed" }, { status: 400 });
    }
    const detail = typeof body?.detail === "string" ? body.detail.slice(0, 300) : null;
    const status = await runnerResult(sender.store, chat, message, delivered, detail);
    if (status === 200) {
      await chatChanged(env, chat);
      const state = delivered ? "delivered" : "failed";
      await later(pushTo(env, sender, { alert: null, data: { chat, app: sender.app, kind: "status", status: state } }));
    }
    return Response.json(
      status === 200 ? { ok: true } : { error: status === 404 ? "no such message" : "not delivering" },
      { status },
    );
  }
  const agent = parseAgentSide(body, now);
  if (!agent) {
    return Response.json({ error: "not an agent side" }, { status: 400 });
  }
  const before = await chatSide(sender.store, chat);
  const status = await runnerAgent(sender.store, chat, agent);
  if (status === 200) {
    await chatChanged(env, chat);
    const push = before ? agentPush(sender.app, chat, before.title, before.agent, agent) : null;
    if (push) {
      await later(pushTo(env, sender, push));
    }
  }
  return Response.json(status === 200 ? { ok: true } : { error: "no such chat" }, { status });
}

async function imageRoute(name: string, env: FeatureKitEnv): Promise<Response> {
  const object = isImageName(name) ? await env.FEEDBACK.get(`${IMAGES}${name}`) : null;
  return object
    ? new Response(object.body, {
        headers: {
          "Content-Type": object.httpMetadata?.contentType ?? "image/jpeg",
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      })
    : new Response("not found\n", { status: 404 });
}

/** Work that may finish after the answer: `waitUntil` in a Worker, awaited where there is none (tests). */
type Later = (work: Promise<unknown>) => Promise<void>;

export async function serveFeatureKit(request: Request, env: FeatureKitEnv, ctx?: ExecutionContext): Promise<Response> {
  const later: Later = ctx
    ? async (work) => ctx.waitUntil(work)
    : async (work) => {
        await work;
      };
  const { pathname } = new URL(request.url);
  if (pathname === "/about" && request.method === "GET") {
    return aboutResponse();
  }
  if (pathname === "/about/worldview" && request.method === "GET") {
    return worldviewResponse();
  }
  if (pathname === "/about/status.json" && request.method === "GET") {
    return aboutStatusResponse(env, parseApps(env.APPS), Date.now());
  }
  if (pathname === "/runner/rex-status" && request.method === "POST") {
    return hasBearer(request, env.RUNNER_TOKEN)
      ? putRexStatus(request, env, Date.now())
      : new Response("unauthorized\n", { status: 401 });
  }
  const image = IMAGE_PATH.exec(pathname);
  if (image && request.method === "GET") {
    return imageRoute(image[1], env);
  }
  if (pathname === "/admin/migrate" && request.method === "POST" && env.ADMIN_TOKEN) {
    return hasBearer(request, env.ADMIN_TOKEN)
      ? Response.json(await migrate(env.FEEDBACK, env.DB))
      : new Response("unauthorized\n", { status: 401 });
  }
  if (pathname === "/admin/apns-check" && request.method === "POST" && env.ADMIN_TOKEN) {
    if (!hasBearer(request, env.ADMIN_TOKEN)) {
      return new Response("unauthorized\n", { status: 401 });
    }
    const topic = new URL(request.url).searchParams.get("topic") ?? "";
    return env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_KEY_P8 && topic
      ? Response.json(
          await checkKey({ keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, p8: env.APNS_KEY_P8 }, topic, Date.now()),
        )
      : Response.json({ error: "no APNs key, or no topic" }, { status: 400 });
  }
  const apps = parseApps(env.APPS);
  const runner = RUNNER_PATH.exec(pathname);
  if (runner && request.method === "POST") {
    return hasBearer(request, env.RUNNER_TOKEN)
      ? runnerRoute(runner[1], request, env, apps, later)
      : new Response("unauthorized\n", { status: 401 });
  }
  const feedback = FEEDBACK_PATH.exec(pathname);
  if (feedback) {
    if (!hasBearer(request, env.CALLER_TOKEN)) {
      return new Response("unauthorized\n", { status: 401 });
    }
    const app = request.headers.get("X-FeedbackKit-App") ?? "";
    const login = request.headers.get("X-FeedbackKit-Login") ?? "";
    const config = apps[app];
    if (!config || !LOGIN.test(login)) {
      return Response.json({ error: "Unknown app or sender." }, { status: 400 });
    }
    return guarded(() =>
      feedbackRoute(
        feedback[1],
        request,
        env,
        app,
        config,
        login,
        senderName(request.headers.get("X-FeedbackKit-Name")),
      ),
    );
  }
  const uploads = UPLOADS_PATH.exec(pathname);
  if (uploads) {
    const sender = await tokenSender(request, env, apps);
    if (!sender) {
      return Response.json({ error: "Sign in again." }, { status: 401 });
    }
    return guarded(() => uploadRoute(uploads[1], request, env, sender));
  }
  const picture = IMAGE_OF_CHAT_PATH.exec(pathname);
  if (picture && request.method === "GET") {
    const sender = await tokenSender(request, env, apps);
    if (!sender) {
      return Response.json({ error: "Sign in again." }, { status: 401 });
    }
    const found = await messageImage(
      senderStore(env.DB, env.FEEDBACK, sender.app, sender.login),
      picture[1],
      picture[2],
      Number(picture[3]),
    );
    return found ? attachmentResponse(found, "private, max-age=86400, immutable") : notFound();
  }
  if (pathname === "/v2/acp") {
    return env.LIVE_ROOMS && env.ACP_SECRET
      ? handleAcp(request, {
          adapter: liveAdapter(liveDeps(env)),
          rooms: liveRooms(env.LIVE_ROOMS),
          secret: env.ACP_SECRET,
        })
      : notFound();
  }
  const direct = DIRECT_FEEDBACK_PATH.exec(pathname);
  const devices = DEVICES_PATH.exec(pathname);
  if (direct || devices) {
    const sender = await tokenSender(request, env, apps);
    if (!sender) {
      return Response.json({ error: "Sign in again." }, { status: 401 });
    }
    if (devices) {
      return guarded(() => devicesRoute(devices[1], request, env, sender.app, sender.login));
    }
    return guarded(() => feedbackRoute(direct![1], request, env, sender.app, sender.config, sender.login, sender.name));
  }
  return new Response("not found\n", { status: 404 });
}

/** A screenshot's or a video's bytes, with their type and, for a video, their length. */
function attachmentResponse(
  found: { bytes: Uint8Array | ReadableStream | string; mediaType: string; size?: number },
  cache: string,
): Response {
  const headers: Record<string, string> = { "Content-Type": found.mediaType, "Cache-Control": cache };
  if (found.size !== undefined) {
    headers["Content-Length"] = String(found.size);
  }
  return new Response(found.bytes as BodyInit, { headers });
}

/**
 * A video before its message (docs/api.md#videos): `POST /v2/feedback/uploads {name, mimeType, size}` asks for room and
 * answers the ticket; `PUT /v2/feedback/uploads/{id}` sends its bytes, with the same token. Owners and builders only:
 * an issue takes no videos.
 */
async function uploadRoute(
  id: string | undefined,
  request: Request,
  env: FeatureKitEnv,
  sender: { app: string; login: string; config: AppConfig },
): Promise<Response> {
  const role = roleOf(sender.config, sender.login);
  if (role === null || role === "issue") {
    return Response.json({ error: "Videos can't be sent here." }, { status: 403 });
  }
  const store = senderStore(env.DB, env.FEEDBACK, sender.app, sender.login);
  const now = Date.now();
  if (request.method === "POST" && id === undefined) {
    const ticket = await newUpload(store, await bodyOf(request), now);
    return "status" in ticket
      ? Response.json({ error: ticket.error }, { status: ticket.status })
      : Response.json(ticket);
  }
  if (request.method !== "PUT" || id === undefined) {
    return notFound();
  }
  // More than it asked room for is refused before a byte is read, when the request says its length.
  const room = await uploadRoom(store, id);
  const length = Number(request.headers.get("Content-Length") ?? NaN);
  if (room !== null && length > room) {
    return Response.json({ error: "That is more than this upload asked room for." }, { status: 413 });
  }
  const status =
    room === null
      ? await putUpload(store, id, new ArrayBuffer(0), now)
      : await putUpload(store, id, await request.arrayBuffer(), now);
  const words: Record<number, string> = {
    200: "",
    400: "An upload needs its bytes.",
    404: "No such upload.",
    409: "That upload is on a message already.",
    413: "That is more than this upload asked room for.",
  };
  return status === 200 ? Response.json({ ok: true }) : Response.json({ error: words[status] }, { status });
}

/** A push to the sender's devices, when the app has a topic and the Worker the team key; gone devices forgotten. */
async function pushTo(env: FeatureKitEnv, sender: { app: string; login: string; config: AppConfig }, push: Push) {
  const key: ApnsKey | null =
    env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_KEY_P8
      ? { keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, p8: env.APNS_KEY_P8 }
      : null;
  if (!key || !sender.config.topic) {
    return;
  }
  const { results } = await env.DB.prepare("SELECT token, environment FROM devices WHERE app = ? AND login = ?")
    .bind(sender.app, sender.login.toLowerCase())
    .all<Device>();
  const gone = await sendPush(key, sender.config.topic, results, push, Date.now());
  if (gone.length) {
    await env.DB.batch(gone.map((token) => env.DB.prepare("DELETE FROM devices WHERE token = ?").bind(token)));
  }
}

function liveRooms(namespace: DurableObjectNamespace): LiveRooms {
  return namespace as unknown as LiveRooms;
}

/** Tells the chat's live room it changed. A failure is logged by the package, never answered. */
async function chatChanged(env: FeatureKitEnv, chat: string): Promise<void> {
  if (env.LIVE_ROOMS) {
    await notifyChat(liveRooms(env.LIVE_ROOMS), chat);
  }
}

/** What live.ts needs of the Worker: D1, R2, who a token names, and the runner's wake. */
function liveDeps(env: FeatureKitEnv) {
  return {
    db: env.DB,
    bucket: env.FEEDBACK,
    verify: async (request: Request): Promise<LiveWho | null> => {
      const sender = await tokenSender(request, env, parseApps(env.APPS));
      return sender && roleOf(sender.config, sender.login) !== "issue" && roleOf(sender.config, sender.login) !== null
        ? { app: sender.app, login: sender.login.toLowerCase(), name: sender.name }
        : null;
    },
    sent: async () => wakeRunner(env.RUNNER_WAKE),
  };
}

async function guarded(route: () => Promise<Response>): Promise<Response> {
  try {
    return await route();
  } catch (error) {
    console.error("feedback failed", error);
    return Response.json({ error: "Your feedback couldn't be kept. Try again." }, { status: 502 });
  }
}

/** The sender a request's FeedbackKit token names, when its app's key signed it, it is current and the app is known. */
async function tokenSender(request: Request, env: FeatureKitEnv, apps: Record<string, AppConfig>) {
  const bearer = /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
  let keys: Record<string, string> = {};
  try {
    keys = JSON.parse(env.APP_KEYS ?? "{}") as Record<string, string>;
  } catch {
    console.error("APP_KEYS is not JSON");
  }
  const claims = bearer ? await verifyToken(bearer, keys, Date.now()) : null;
  const config = claims ? apps[claims.app] : undefined;
  return claims && config ? { ...claims, config } : null;
}

/**
 * The sender's devices, for pushes: `POST /v2/devices {token, environment}` keeps one (a token moves to whoever
 * registers it last), `DELETE /v2/devices/{token}` forgets it.
 */
async function devicesRoute(
  token: string | undefined,
  request: Request,
  env: FeatureKitEnv,
  app: string,
  login: string,
): Promise<Response> {
  const lower = login.toLowerCase();
  if (request.method === "DELETE" && token) {
    await env.DB.prepare("DELETE FROM devices WHERE token = ? AND app = ? AND login = ?").bind(token, app, lower).run();
    return Response.json({ ok: true });
  }
  if (request.method !== "POST" || token) {
    return notFound();
  }
  const body = (await bodyOf(request)) as { token?: unknown; environment?: unknown } | null;
  const device = typeof body?.token === "string" ? body.token.toLowerCase() : "";
  const environment =
    body?.environment === "sandbox" ? "sandbox" : body?.environment === "production" ? "production" : null;
  if (!APNS_TOKEN.test(device) || !environment) {
    return Response.json(
      { error: "token (hex) and environment (production or sandbox) are required" },
      { status: 400 },
    );
  }
  await env.DB.prepare(
    "INSERT INTO devices (token, app, login, environment, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (token)" +
      " DO UPDATE SET app = excluded.app, login = excluded.login, environment = excluded.environment," +
      " updated_at = excluded.updated_at",
  )
    .bind(device, app, lower, environment, Date.now())
    .run();
  return Response.json({ ok: true });
}

export default {
  fetch: (request: Request, env: FeatureKitEnv, ctx: ExecutionContext) => serveFeatureKit(request, env, ctx),
};
