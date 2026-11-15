/**
 * The FeedbackKit Worker (docs/worker.md): one Worker that keeps every app's feedback. An app's own Worker checks
 * who is asking, as it does for every route, and forwards `/feedback` here with the app and the sender's GitHub login.
 * Per app, the config names who builds: an owner's feedback goes to a coding agent that ships, a builder's to one that
 * opens a pull request, and anyone else's opens a public issue. The runner on Jai's Mac takes the agents' work.
 */
import {
  addFeedback, chatOfRef, feedbackChat, feedbackList, type FeedbackStore, isFeedbackId, keepRef, listServedLog,
  parseAgentSide, parseFeedbackInput, pendingWork, runnerAgent, runnerBeat, runnerClaim, runnerResult, senderStore,
} from "./feedback.ts";
import {
  addIssueFeedback, gitHubIssues, type IssueFeedback, issueChat, issuesNotice, issueThreads, isImageName,
} from "./feedback-issues.ts";
import { migrate } from "./migrate.ts";
import { runnerWake, wakeRunner } from "./runner-wake.ts";
import { clientRefOf, sha256Hex } from "./util.ts";

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
  /** Runs the move from R2 to D1 (`POST /admin/migrate`, migrate.ts); without it that route is `404`. */
  ADMIN_TOKEN?: string;
  /** The runner's long poll (runner-wake.ts). Without it `/runner/wait` is `404` and the runner polls every 15 s. */
  RUNNER_WAKE?: DurableObjectNamespace;
}

export type Role = "owner" | "builder" | "issue";

export interface AppConfig {
  repo: string;
  owners: string[];
  builders: string[];
  issues: boolean;
  /** How the app names a sender ("jai": "Jai") when its Worker sends no `X-FeedbackKit-Name`. */
  names: Record<string, string>;
}

const APP_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;

export function parseApps(raw: string): Record<string, AppConfig> {
  const parsed = JSON.parse(raw) as Record<string, Partial<AppConfig>>;
  const lower = (logins: unknown) => Array.isArray(logins)
    ? logins.filter((login): login is string => typeof login === "string").map((login) => login.toLowerCase()) : [];
  return Object.fromEntries(Object.entries(parsed).filter(([name, app]) => APP_NAME.test(name)
    && typeof app?.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(app.repo)).map(([name, app]) => [name, {
    repo: app.repo!, owners: lower(app.owners), builders: lower(app.builders), issues: app.issues === true,
    names: Object.fromEntries(Object.entries(app.names ?? {})
      .filter(([, name]) => typeof name === "string" && senderName(name) !== null)
      .map(([login, name]) => [login.toLowerCase(), name])),
  }]));
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
  const taken = await store.db.prepare(
    "INSERT INTO issue_opens (app, login, at) SELECT ?1, ?2, ?3 WHERE"
      + " (SELECT count(*) FROM issue_opens WHERE app = ?1 AND login = ?2 AND at > ?4) < ?5",
  ).bind(store.app, store.login, now, now - 86_400_000, ISSUES_PER_DAY).run();
  return taken.meta.changes === 1;
}

const IMAGES = "images/";
const IMAGE_PATH = /^\/images\/([^/]+)$/;
const FEEDBACK_PATH = /^\/feedback(?:\/([^/]+))?$/;
const RUNNER_PATH = /^\/runner\/(poll|claim|result|agent|wait)$/;

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
  id: string | undefined, request: Request, env: FeatureKitEnv, app: string, config: AppConfig, login: string,
): Promise<Response> {
  if (id !== undefined && !isFeedbackId(id)) {
    return notFound();
  }
  const role = roleOf(config, login);
  if (!role) {
    return Response.json({ error: "Feedback is not open to you in this app." }, { status: 403 });
  }
  const store = senderStore(env.DB, env.FEEDBACK, app, login, senderName(request.headers.get("X-FeedbackKit-Name")));
  const now = Date.now();
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
    const target = await once(store, id, body, () => addFeedback(store, id ?? null, input, now));
    if (target) {
      await wakeRunner(env.RUNNER_WAKE);
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
      return Response.json({ threads: await issueThreads(store), builderOnline: true, notice: issuesNotice(config.repo) });
    }
    const chat = await issueChat(context, id);
    return chat ? Response.json(chat) : notFound();
  }
  const body = await bodyOf(request);
  const input = parseFeedbackInput(body);
  if (!input) {
    return Response.json({ error: "That feedback can't be sent." }, { status: 400 });
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
    return Response.json({ error: `You can open ${ISSUES_PER_DAY} feedback issues a day. Try again tomorrow.` },
      { status: 429 });
  }
  const chat = target ? await issueChat(context, target) : null;
  return chat ? Response.json(chat) : notFound();
}

/**
 * A send with a `client_ref` is kept once: a retry answers the chat its first try made, and sends nothing again.
 * Two tries at the same moment can both go; the app's outbox sends one at a time.
 */
async function once(
  store: FeedbackStore, id: string | undefined, body: unknown, send: () => Promise<string | null>,
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
  await store.db.prepare("DELETE FROM issue_opens WHERE rowid IN"
    + " (SELECT rowid FROM issue_opens WHERE app = ? AND login = ? AND at = ? LIMIT 1)")
    .bind(store.app, store.login, at).run();
}

/** Which chats a runner message is about: the app, the sender and their store, from the body. */
function senderOf(body: Record<string, unknown> | null, apps: Record<string, AppConfig>, env: FeatureKitEnv) {
  const app = typeof body?.app === "string" ? body.app : "";
  const login = typeof body?.login === "string" ? body.login : "";
  const config = apps[app];
  const role = config && LOGIN.test(login) ? roleOf(config, login) : null;
  return config && role && role !== "issue"
    ? { app, login: login.toLowerCase(), config, role, store: senderStore(env.DB, env.FEEDBACK, app, login) } : null;
}

async function runnerRoute(kind: string, request: Request, env: FeatureKitEnv, apps: Record<string, AppConfig>) {
  if (kind === "wait") {
    return env.RUNNER_WAKE ? runnerWake(env.RUNNER_WAKE).fetch("https://runner-wake/wait", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: await request.text(),
    }) : Response.json({ error: "no long poll here" }, { status: 404 });
  }
  const body = (await bodyOf(request)) as Record<string, unknown> | null;
  const now = Date.now();
  if (kind === "poll") {
    const detail = typeof body?.detail === "string" ? body.detail : null;
    const senders = Object.entries(apps).flatMap(([app, config]) => [...config.owners, ...config.builders]
      .map((login) => ({ app, login, config, role: roleOf(config, login)! })));
    await runnerBeat(env.DB, body?.orca === true, now, detail);
    const work = await Promise.all(senders.map(async ({ app, login, config, role }) =>
      (await pendingWork(senderStore(env.DB, env.FEEDBACK, app, login)))
        .map((item) => ({
          ...item, app, login: login.toLowerCase(), repo: config.repo, role,
          name: item.name ?? config.names[login.toLowerCase()] ?? null,
        }))));
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
    return claimed.ok ? Response.json({ ...claimed, app: sender.app, login: sender.login, repo: sender.config.repo, role: sender.role })
      : Response.json({ error: claimed.status === 404 ? "no such message" : "not pending" }, { status: claimed.status });
  }
  if (kind === "result") {
    const delivered = body?.status === "delivered";
    if (!delivered && body?.status !== "failed") {
      return Response.json({ error: "status is delivered or failed" }, { status: 400 });
    }
    const detail = typeof body?.detail === "string" ? body.detail.slice(0, 300) : null;
    const status = await runnerResult(sender.store, chat, message, delivered, detail);
    return Response.json(status === 200 ? { ok: true } : { error: status === 404 ? "no such message" : "not delivering" },
      { status });
  }
  const agent = parseAgentSide(body, now);
  if (!agent) {
    return Response.json({ error: "not an agent side" }, { status: 400 });
  }
  const status = await runnerAgent(sender.store, chat, agent);
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

export async function serveFeatureKit(request: Request, env: FeatureKitEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  const image = IMAGE_PATH.exec(pathname);
  if (image && request.method === "GET") {
    return imageRoute(image[1], env);
  }
  if (pathname === "/admin/migrate" && request.method === "POST" && env.ADMIN_TOKEN) {
    return hasBearer(request, env.ADMIN_TOKEN) ? Response.json(await migrate(env.FEEDBACK, env.DB))
      : new Response("unauthorized\n", { status: 401 });
  }
  const apps = parseApps(env.APPS);
  const runner = RUNNER_PATH.exec(pathname);
  if (runner && request.method === "POST") {
    return hasBearer(request, env.RUNNER_TOKEN) ? runnerRoute(runner[1], request, env, apps)
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
    try {
      return await feedbackRoute(feedback[1], request, env, app, config, login);
    } catch (error) {
      console.error("feedback failed", error);
      return Response.json({ error: "Your feedback couldn't be kept. Try again." }, { status: 502 });
    }
  }
  return new Response("not found\n", { status: 404 });
}

export default { fetch: serveFeatureKit };
