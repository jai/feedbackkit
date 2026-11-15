/**
 * FeedbackKit's sample app backend (README.md): the least an app's own Worker needs for FeedbackKit's direct path.
 * It signs its user in (here a single demo bearer stands in for a real sign-in) and issues them a short-lived
 * FeedbackKit token, signed with the app's key (docs/api.md#tokens). The app then talks to FeedbackKit's Worker
 * itself: its chats, its live socket and its device for pushes. This Worker keeps nothing.
 */
import { issueToken, MAX_LIFETIME_SECONDS } from "../../worker/src/token.ts";

export interface SampleEnv {
  /** The app's key in `APPS` on FeedbackKit's Worker ("feedbackkit-demo"). */
  APP: string;
  /** The app's FeedbackKit key: the same as FeedbackKit's Worker holds for it in `APP_KEYS`. */
  APP_KEY: string;
  /** FeedbackKit's Worker, e.g. https://featurekit.jai-f89.workers.dev. */
  FEEDBACKKIT_URL: string;
  /** The demo's sign-in: whoever has this bearer is USER_LOGIN. A real app checks its own session instead. */
  USER_TOKEN: string;
  USER_LOGIN: string;
  /** How the app names its user; the coding agent is told this name. */
  USER_NAME?: string;
}

function signedIn(request: Request, env: SampleEnv): boolean {
  return !!env.USER_TOKEN && request.headers.get("Authorization") === `Bearer ${env.USER_TOKEN}`;
}

export async function serveSample(request: Request, env: SampleEnv, now = Date.now()): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/" && request.method === "GET") {
    return new Response("FeedbackKit sample app backend: POST /feedback/token\n");
  }
  if (pathname !== "/feedback/token" || request.method !== "POST") {
    return new Response("not found\n", { status: 404 });
  }
  if (!signedIn(request, env)) {
    return Response.json({ error: "Sign in first." }, { status: 401 });
  }
  if (!env.APP_KEY || !env.APP || !env.FEEDBACKKIT_URL) {
    return Response.json({ error: "This backend has no FeedbackKit key." }, { status: 503 });
  }
  const token = await issueToken(env.APP_KEY, env.APP, env.USER_LOGIN, env.USER_NAME || null, now);
  return Response.json({
    token,
    expiresAt: new Date(now + MAX_LIFETIME_SECONDS * 1000).toISOString(),
    feedbackkit: `${env.FEEDBACKKIT_URL.replace(/\/$/, "")}/v2`,
  });
}

export default { fetch: (request: Request, env: SampleEnv) => serveSample(request, env) };
