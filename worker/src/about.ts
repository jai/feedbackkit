/**
 * Live visual-first architecture dashboard (`GET /about`), sanitized status API
 * (`GET /about/status.json`), and Rex runner heartbeat ingest (`POST /runner/rex-status`).
 *
 * Strictly public-safe on `/about/status.json`: exposes operational counts, component
 * build states, and sanitized slugs only — never chat text, emails, local paths, or tokens.
 * Authenticated live thread titles & terminal captures hydrate via `/about/threads.json`
 * and `/about/inspect` behind Cloudflare Access.
 */

import type { AppConfig, FeatureKitEnv } from "./featurekit.ts";

const REX_STATUS_KEY = "rex/status.json";
const REX_INSPECT_KEY = "rex/inspect.json";
const MAX_INSPECT_BYTES = 512 * 1024;
const MAX_STORED_RUNS = 64;
const MAX_STORED_PANES = 32;
const ORCA_FRESH_MS = 90_000;
const REX_FRESH_MS = 120_000;
const SLUG_RE = /^[a-zA-Z0-9._-]{1,48}$/;
const STATE_RE = /^[a-z_]{1,24}$/;

export interface RexRunSnapshot {
  chat_id: string;
  app: string;
  agent: string;
  status: string;
  updated_at_ms: number;
}

export interface StoredRexStatus {
  reported_at_ms: number;
  session_name: string;
  session_active: boolean;
  coordinator_active: boolean;
  coordinator_state: string;
  inbox_pending: number;
  daemon_running?: boolean;
  claim_apps: string[];
  runs: RexRunSnapshot[];
}

export interface StoredRexInspectPane {
  id: string;
  label: string;
  kind: string;
  status: string;
  agent?: string;
  app?: string;
  capture: string;
}

export interface StoredRexInspect {
  reported_at_ms: number;
  session_name: string;
  panes: StoredRexInspectPane[];
  recent_inbox: Array<{
    id: string;
    kind: string;
    chat_id?: string;
    app?: string;
    status?: string;
    summary: string;
    created_at?: string;
  }>;
}

export type ComponentBuildState = "live" | "standby" | "offline" | "unbuilt";

function safeSlug(v: unknown, fallback = ""): string {
  return typeof v === "string" && SLUG_RE.test(v) ? v : fallback;
}

function safeState(v: unknown, fallback: string): string {
  return typeof v === "string" && STATE_RE.test(v) ? v : fallback;
}

function safeInt(v: unknown, min = 0, max = 100_000): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.trunc(v))) : min;
}

function runPriority(status: string): number {
  if (status === "active" || status === "progress") return 0;
  if (status === "blocked") return 1;
  if (status === "done") return 2;
  if (status === "reaped") return 3;
  return 4;
}

function isRunActive(status: string): boolean {
  return status === "active" || status === "progress" || status === "blocked";
}

function sortRuns(runs: RexRunSnapshot[]): RexRunSnapshot[] {
  return [...runs].sort((a, b) => {
    const p = runPriority(a.status) - runPriority(b.status);
    if (p !== 0) return p;
    return b.updated_at_ms - a.updated_at_ms;
  });
}

/** Validates and stores a sanitized snapshot pushed by `rex-runner` into R2. */
export async function putRexStatus(request: Request, env: FeatureKitEnv, now: number): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return Response.json({ error: "Expected JSON object." }, { status: 400 });
  }
  const obj = raw as Record<string, unknown>;
  const claimAppsRaw = Array.isArray(obj.claim_apps) ? obj.claim_apps : [];
  const claimApps = claimAppsRaw
    .map((item) => safeSlug(item))
    .filter((slug) => slug !== "")
    .slice(0, 20);

  const runsRaw = Array.isArray(obj.runs) ? obj.runs : [];
  const parsedRuns: RexRunSnapshot[] = [];
  for (const item of runsRaw.slice(0, 200)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const r = item as Record<string, unknown>;
    const chatId = safeSlug(r.chat_id);
    if (!chatId) {
      continue;
    }
    parsedRuns.push({
      chat_id: chatId,
      app: safeSlug(r.app, "unknown"),
      agent: safeSlug(r.agent, "claude"),
      status: safeState(r.status, "active"),
      updated_at_ms: typeof r.updated_at_ms === "number" && Number.isFinite(r.updated_at_ms) ? r.updated_at_ms : now,
    });
  }
  const runs = sortRuns(parsedRuns).slice(0, MAX_STORED_RUNS);

  const snapshot: StoredRexStatus = {
    reported_at_ms: now,
    session_name: safeSlug(obj.session_name, "feedback-loop"),
    session_active: obj.session_active === true,
    coordinator_active: obj.coordinator_active === true,
    coordinator_state: safeState(obj.coordinator_state, "idle"),
    inbox_pending: safeInt(obj.inbox_pending, 0, 10_000),
    daemon_running: obj.daemon_running === true,
    claim_apps: claimApps,
    runs,
  };

  await env.FEEDBACK.put(REX_STATUS_KEY, JSON.stringify(snapshot), {
    httpMetadata: { contentType: "application/json" },
  });
  return Response.json({ ok: true, reported_at_ms: now });
}

/** Stores authenticated live Rex terminal captures & recent inbox events in R2 for dashboard drill-down. */
export async function putRexInspect(request: Request, env: FeatureKitEnv, now: number): Promise<Response> {
  const rawText = await request.text();
  if (rawText.length > MAX_INSPECT_BYTES) {
    return Response.json({ error: "Inspect payload too large." }, { status: 413 });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return Response.json({ error: "Expected JSON object." }, { status: 400 });
  }
  const obj = raw as Record<string, unknown>;
  const panesRaw = Array.isArray(obj.panes) ? obj.panes : [];
  const parsedPanes: StoredRexInspectPane[] = [];
  for (const item of panesRaw.slice(0, 64)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const p = item as Record<string, unknown>;
    const id = safeSlug(p.id);
    if (!id) {
      continue;
    }
    parsedPanes.push({
      id,
      label: typeof p.label === "string" ? p.label.slice(0, 80) : id,
      kind: safeState(p.kind, "builder"),
      status: safeState(p.status, "active"),
      agent: typeof p.agent === "string" ? safeSlug(p.agent) : undefined,
      app: typeof p.app === "string" ? safeSlug(p.app) : undefined,
      capture: typeof p.capture === "string" ? p.capture.slice(-10_000) : "",
    });
  }
  parsedPanes.sort((a, b) => {
    const ka = a.kind === "coordinator" ? -1 : runPriority(a.status);
    const kb = b.kind === "coordinator" ? -1 : runPriority(b.status);
    return ka - kb;
  });
  const panes = parsedPanes.slice(0, MAX_STORED_PANES);

  const inboxRaw = Array.isArray(obj.recent_inbox) ? obj.recent_inbox : [];
  const recentInbox = inboxRaw
    .slice(-20)
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
    .map((ev) => ({
      id: typeof ev.id === "string" ? ev.id.slice(0, 64) : "",
      kind: safeState(ev.kind, "event"),
      chat_id: typeof ev.chat_id === "string" ? safeSlug(ev.chat_id) : undefined,
      app: typeof ev.app === "string" ? safeSlug(ev.app) : undefined,
      status: typeof ev.status === "string" ? safeState(ev.status, "") : undefined,
      summary: typeof ev.summary === "string" ? ev.summary.slice(0, 400) : "",
      created_at: typeof ev.created_at === "string" ? ev.created_at.slice(0, 40) : undefined,
    }));

  const stored: StoredRexInspect = {
    reported_at_ms: now,
    session_name: safeSlug(obj.session_name, "feedback-loop"),
    panes,
    recent_inbox: recentInbox,
  };
  await env.FEEDBACK.put(REX_INSPECT_KEY, JSON.stringify(stored), {
    httpMetadata: { contentType: "application/json" },
  });
  return Response.json({ ok: true, panes: panes.length, reported_at_ms: now });
}

/** Serves authenticated live terminal captures & inbox events for `/about` drill-down. */
export async function aboutInspectResponse(env: FeatureKitEnv): Promise<Response> {
  const obj = await env.FEEDBACK.get(REX_INSPECT_KEY);
  if (!obj) {
    return Response.json(
      { reported_at_ms: null, session_name: "feedback-loop", panes: [], recent_inbox: [] },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const data = await obj.json();
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Corrupt inspect snapshot." }, { status: 500 });
  }
}

interface AppCountRow {
  app: string;
  chats: number;
}

interface StatusCountRow {
  status: string;
  cnt: number;
}

interface BeatRow {
  at: number;
  orca: number;
  detail: string | null;
}

/** Serves real live Worker D1 + Rex R2 operational telemetry for the `/about` dashboard. */
export async function aboutStatusResponse(
  env: FeatureKitEnv,
  apps: Record<string, AppConfig>,
  now: number,
): Promise<Response> {
  const [appRows, msgRows, beatRow, rexObj] = await Promise.all([
    env.DB.prepare("SELECT app, COUNT(*) AS chats FROM chats WHERE kind = 'agent' GROUP BY app").all<AppCountRow>(),
    env.DB.prepare(
      "SELECT status, COUNT(*) AS cnt FROM messages WHERE status IN ('pending', 'delivering', 'failed') GROUP BY status",
    ).all<StatusCountRow>(),
    env.DB.prepare("SELECT at, orca, detail FROM runner_beat WHERE id = 1").first<BeatRow>(),
    env.FEEDBACK.get(REX_STATUS_KEY),
  ]);

  const countsByApp = new Map<string, number>();
  for (const row of appRows.results ?? []) {
    countsByApp.set(row.app, Number(row.chats) || 0);
  }
  const appSummary = Object.entries(apps)
    .filter(([, cfg]) => !cfg.echo)
    .map(([slug]) => ({ app: slug, chats: countsByApp.get(slug) ?? 0 }));
  const totalChats = appSummary.reduce((sum, item) => sum + item.chats, 0);

  let pendingMessages = 0;
  let deliveringMessages = 0;
  let failedMessages = 0;
  for (const row of msgRows.results ?? []) {
    const n = Number(row.cnt) || 0;
    if (row.status === "pending") {
      pendingMessages = n;
    } else if (row.status === "delivering") {
      deliveringMessages = n;
    } else if (row.status === "failed") {
      failedMessages = n;
    }
  }

  const orcaBeatMs = beatRow?.at ? Number(beatRow.at) : null;
  const orcaAgeSec = orcaBeatMs !== null ? Math.max(0, Math.floor((now - orcaBeatMs) / 1000)) : null;
  const orcaOnline = orcaBeatMs !== null && now - orcaBeatMs <= ORCA_FRESH_MS && beatRow?.orca === 1;

  let rex: StoredRexStatus | null = null;
  if (rexObj) {
    try {
      rex = (await rexObj.json()) as StoredRexStatus;
    } catch {
      rex = null;
    }
  }
  const sortedRuns = rex ? sortRuns(rex.runs ?? []) : [];
  const rexAgeSec = rex ? Math.max(0, Math.floor((now - rex.reported_at_ms) / 1000)) : null;
  const rexFresh = rex !== null && now - rex.reported_at_ms <= REX_FRESH_MS;
  const activeRexRuns = sortedRuns.filter((r) => isRunActive(r.status));

  const components: Record<string, ComponentBuildState> = {
    apps: "live",
    menubar_about: "unbuilt",
    worker: "live",
    orca_runner: orcaOnline ? "live" : orcaBeatMs !== null ? "offline" : "standby",
    orca_worktrees: orcaOnline ? "live" : "standby",
    go_runner: rexFresh ? "live" : rex ? "standby" : "standby",
    worker_rex_claim: rex && rex.claim_apps.length > 0 ? "live" : "unbuilt",
    launchd_boot: rexFresh && rex?.daemon_running ? "live" : "unbuilt",
    inbox: rexFresh ? "live" : "standby",
    fable: rex?.coordinator_active ? (rexFresh ? "live" : "standby") : "standby",
    reaper: rexFresh && rex?.daemon_running ? "live" : "standby",
    builder_tabs: activeRexRuns.length > 0 ? "live" : "unbuilt",
    builder_auto_report: "unbuilt",
  };

  const cfAccount = safeSlug(env.CF_ACCOUNT_ID);
  const d1Id = safeSlug(env.D1_DATABASE_ID);
  const links = cfAccount
    ? {
        worker: `https://dash.cloudflare.com/${cfAccount}/workers/services/view/featurekit/production/metrics`,
        d1: d1Id
          ? `https://dash.cloudflare.com/${cfAccount}/workers/d1/databases/${d1Id}`
          : `https://dash.cloudflare.com/${cfAccount}/workers/d1`,
        r2: `https://dash.cloudflare.com/${cfAccount}/r2/default/buckets/featurekit`,
      }
    : null;

  return Response.json(
    {
      now_ms: now,
      worker: {
        apps: appSummary,
        total_chats: totalChats,
        pending_messages: pendingMessages,
        delivering_messages: deliveringMessages,
        failed_messages: failedMessages,
        links,
      },
      orca: {
        online: orcaOnline,
        last_beat_ms: orcaBeatMs,
        age_seconds: orcaAgeSec,
      },
      rex: rex
        ? {
            connected: rexFresh,
            reported_at_ms: rex.reported_at_ms,
            age_seconds: rexAgeSec,
            session_name: rex.session_name,
            session_active: rex.session_active,
            coordinator_active: rex.coordinator_active,
            coordinator_state: rex.coordinator_state,
            inbox_pending: rex.inbox_pending,
            claim_apps: rex.claim_apps,
            runs: sortedRuns,
          }
        : {
            connected: false,
            reported_at_ms: null,
            age_seconds: null,
            session_name: "feedback-loop",
            session_active: false,
            coordinator_active: false,
            coordinator_state: "unknown",
            inbox_pending: 0,
            claim_apps: [],
            runs: [],
          },
      components,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

const ABOUT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>FeedbackKit — Live System Dashboard</title>
<style>
  /* Eye-comfort palette & pure rem typography: soft contrast (no halation),
     no background grid, diagram first with readable HTML nodes, compact status bar,
     and clear per-app grouping for live threads. */
  :root {
    --bg: #f6f4ef;
    --surface: #fffdf9;
    --surface-2: #efece5;
    --border: #d6d1c7;
    --border-strong: #8a8378;
    --text: #1f2328;
    --text-dim: #4b5159;
    --accent: #1f4fbf;
    --accent-soft: rgba(31, 79, 191, 0.10);
    --live: #1d6b4a;
    --live-soft: rgba(29, 107, 74, 0.11);
    --standby: #9a4a00;
    --standby-soft: rgba(154, 74, 0, 0.12);
    --unbuilt: #7a7368;
    --unbuilt-bg: #efece5;
    --offline: #a8261c;
    --offline-soft: rgba(168, 38, 28, 0.11);
    --term-bg: #222529;
    --term-fg: #dcdfe3;
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
    --shadow: 0 8px 24px rgba(31, 35, 40, 0.07);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #1a1c1f;
      --surface: #222529;
      --surface-2: #2b2f34;
      --border: #3a3f46;
      --border-strong: #7d848d;
      --text: #dcdfe3;
      --text-dim: #aab0b8;
      --accent: #8db4ff;
      --accent-soft: rgba(141, 180, 255, 0.14);
      --live: #7fd3a8;
      --live-soft: rgba(127, 211, 168, 0.14);
      --standby: #f0b35a;
      --standby-soft: rgba(240, 179, 90, 0.15);
      --unbuilt: #8e96a0;
      --unbuilt-bg: #1f2226;
      --offline: #ff9b8f;
      --offline-soft: rgba(255, 155, 143, 0.15);
      --term-bg: #16181b;
      --term-fg: #dcdfe3;
      --shadow: 0 10px 28px rgba(0, 0, 0, 0.34);
    }
  }
  :root[data-theme="dark"] {
    --bg: #1a1c1f;
    --surface: #222529;
    --surface-2: #2b2f34;
    --border: #3a3f46;
    --border-strong: #7d848d;
    --text: #dcdfe3;
    --text-dim: #aab0b8;
    --accent: #8db4ff;
    --accent-soft: rgba(141, 180, 255, 0.14);
    --live: #7fd3a8;
    --live-soft: rgba(127, 211, 168, 0.14);
    --standby: #f0b35a;
    --standby-soft: rgba(240, 179, 90, 0.15);
    --unbuilt: #8e96a0;
    --unbuilt-bg: #1f2226;
    --offline: #ff9b8f;
    --offline-soft: rgba(255, 155, 143, 0.15);
    --term-bg: #16181b;
    --term-fg: #dcdfe3;
    --shadow: 0 10px 28px rgba(0, 0, 0, 0.34);
  }
  html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
  :root[data-size="large"] { font-size: 118%; }
  :root[data-size="huge"] { font-size: 136%; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: var(--sans);
    font-size: 1.125rem;
    line-height: 1.55;
    color: var(--text);
    background-color: var(--bg);
    background-image: none;
    -webkit-font-smoothing: antialiased;
  }
  em, i { font-style: normal; font-weight: 600; }
  p, li { max-width: 68ch; }
  a:focus-visible, button:focus-visible, input:focus-visible, summary:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 3px;
  }
  .shell {
    max-width: 86rem;
    margin: 0 auto;
    padding: 0.9rem max(1.1rem, env(safe-area-inset-right, 0px)) 5rem max(1.1rem, env(safe-area-inset-left, 0px));
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }

  /* Compact top header */
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.7rem 1rem;
    padding-bottom: 0.7rem;
    border-bottom: 1px solid var(--border);
  }
  .title-block { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.45rem 0.75rem; }
  h1 { margin: 0; font-size: 1.45rem; font-weight: 650; line-height: 1.25; }
  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 0.45rem; }
  .size-group {
    display: inline-flex;
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    overflow: hidden;
    background: var(--surface);
  }
  .size-group button.btn { border: none; border-right: 1px solid var(--border); border-radius: 0; padding: 0.35rem 0.65rem; }
  .size-group button.btn:last-child { border-right: none; }
  button.btn, a.btn {
    font-family: var(--sans);
    font-size: 0.92rem;
    font-weight: 500;
    min-height: 2.5rem;
    padding: 0.35rem 0.8rem;
    border-radius: 8px;
    border: 1px solid var(--border-strong);
    background: var(--surface);
    color: var(--text);
    text-decoration: none;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  button.btn:hover, a.btn:hover { border-color: var(--accent); color: var(--accent); }
  a.btn.worldview, button.btn[aria-pressed="true"] {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 650;
  }
  #openInspectorBtn { display: none; }

  .pill {
    font-size: 0.85rem;
    font-weight: 650;
    padding: 0.14rem 0.55rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    white-space: nowrap;
  }
  .pill.live { border-color: var(--live); color: var(--live); background: var(--live-soft); }
  .pill.standby { border-color: var(--standby); color: var(--standby); background: var(--standby-soft); }
  .pill.accent { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
  .pill.unbuilt { border-color: var(--unbuilt); color: var(--unbuilt); background: var(--unbuilt-bg); border-style: dashed; }
  .pill.offline { border-color: var(--offline); color: var(--offline); background: var(--offline-soft); }
  .dot { width: 0.48rem; height: 0.48rem; border-radius: 50%; display: inline-block; background: currentColor; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  @media (prefers-reduced-motion: no-preference) { .dot.pulsing { animation: pulse 2.4s ease-in-out infinite; } }

  /* Compact single-bar status strip (~25% height of old 5-card KPI grid) */
  .status-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.45rem 1rem;
    padding: 0.55rem 0.9rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    font-size: 0.94rem;
    font-variant-numeric: tabular-nums;
  }
  .sb-item { display: inline-flex; align-items: center; gap: 0.4rem; color: var(--text-dim); }
  .sb-item strong { color: var(--text); font-weight: 650; }
  .sb-sep { color: var(--border-strong); user-select: none; }
  .sb-time { margin-left: auto; color: var(--text-dim); font-size: 0.88rem; }

  .terms-drawer {
    display: none;
    background: var(--surface);
    border: 1px solid var(--accent);
    border-radius: 10px;
    padding: 1rem 1.15rem;
  }
  .terms-drawer.open { display: block; }
  .terms-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr)); gap: 0.8rem 1.2rem; font-size: 0.96rem; }
  .terms-grid dt { font-family: var(--mono); font-size: 0.94rem; font-weight: 700; color: var(--accent); }
  .terms-grid dd { margin: 0.2rem 0 0; color: var(--text-dim); }

  /* Main workspace: Eye-comfort Diagram FIRST + Inspector */
  .workspace {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 23rem;
    gap: 1.1rem;
    align-items: start;
  }
  .inspector-backdrop { display: none; }
  .ins-close { display: none; }
  .inspector-dock { display: none; }

  @media (max-width: 1180px) {
    .workspace { grid-template-columns: 1fr; }
    #openInspectorBtn { display: inline-flex; }
    .inspector-dock {
      display: inline-flex;
      position: fixed;
      right: 1rem;
      bottom: max(1rem, env(safe-area-inset-bottom, 0px));
      z-index: 40;
      box-shadow: var(--shadow);
      border-color: var(--accent) !important;
      background: var(--surface) !important;
      color: var(--accent) !important;
      font-weight: 650 !important;
    }
    .inspector-backdrop.open {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 49;
      background: rgba(20, 22, 26, 0.48);
    }
    aside.inspector {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      width: min(30rem, 100vw);
      max-height: 100vh;
      overflow-y: auto;
      z-index: 50;
      border-radius: 12px 0 0 12px;
      transform: translateX(105%);
      transition: transform 180ms ease;
    }
    aside.inspector.drawer-open { transform: translateX(0); }
    .ins-close { display: inline-flex; margin-left: auto; }
  }

  /* Native eye-comfort HTML flow diagram */
  .diagram {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1rem 1.1rem 1.15rem;
    box-shadow: var(--shadow);
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }
  .diagram-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding-bottom: 0.6rem;
    border-bottom: 1px solid var(--border);
  }
  .diagram-title { font-size: 1.05rem; font-weight: 650; color: var(--text); }
  .mode-group { display: flex; flex-wrap: wrap; gap: 0.4rem; }

  .rank {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }
  .rank-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    font-size: 0.9rem;
    font-weight: 650;
    color: var(--text-dim);
  }
  .rank-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
    gap: 0.7rem;
  }
  .rank-row.single { grid-template-columns: minmax(0, 1fr); }
  .rank-row.two-col { grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.35fr); }
  @media (max-width: 760px) { .rank-row.two-col { grid-template-columns: 1fr; } }

  .flow-arrow {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.55rem;
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text-dim);
    padding: 0.05rem 0;
  }
  .flow-arrow::before, .flow-arrow::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--border);
  }
  .flow-arrow.hot { color: var(--accent); }
  .flow-arrow.live { color: var(--live); }

  .node-card {
    text-align: left;
    font: inherit;
    color: var(--text);
    background: var(--bg);
    border: 2px solid var(--border-strong);
    border-radius: 10px;
    padding: 0.75rem 0.9rem;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    transition: border-color 140ms ease, background 140ms ease;
    width: 100%;
  }
  .node-card:hover { border-color: var(--accent); background: var(--surface-2); }
  .node-card.is-selected { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
  .node-card.state-live { border-color: var(--live); }
  .node-card.state-standby { border-color: var(--standby); }
  .node-card.state-offline { border-color: var(--offline); }
  .node-card.state-unbuilt { border-color: var(--unbuilt); border-style: dashed; background: var(--unbuilt-bg); color: var(--text-dim); }

  .nc-top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.4rem; }
  .nc-kicker { font-size: 0.86rem; font-weight: 600; color: var(--text-dim); }
  .nc-title { font-size: 1.08rem; font-weight: 650; line-height: 1.3; }
  .nc-metric { font-size: 0.95rem; font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
  .nc-sub { font-size: 0.9rem; color: var(--text-dim); overflow-wrap: anywhere; }

  .cf-links-bar { display: flex; flex-wrap: wrap; gap: 0.45rem; margin-top: 0.3rem; }
  .cf-links-bar a {
    font-size: 0.88rem;
    font-weight: 600;
    color: var(--accent);
    background: var(--accent-soft);
    border: 1px solid var(--accent);
    border-radius: 6px;
    padding: 0.2rem 0.6rem;
    text-decoration: none;
  }
  .cf-links-bar a:hover { background: var(--accent); color: var(--surface); }

  /* Rex session dashed boundary */
  .rex-box {
    border: 2px dashed var(--border-strong);
    border-radius: 12px;
    padding: 0.85rem;
    background: var(--surface-2);
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }
  .rex-box-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    font-size: 0.94rem;
    font-weight: 650;
    color: var(--text);
  }
  .coord-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.65rem;
  }
  @media (max-width: 820px) { .coord-grid { grid-template-columns: 1fr; } }

  /* Dynamic R4 Builder Threads inside the diagram */
  .builder-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(16.5rem, 1fr));
    gap: 0.65rem;
  }
  .builder-node {
    text-align: left;
    font: inherit;
    color: var(--text);
    background: var(--surface);
    border: 2px solid var(--border);
    border-left: 5px solid var(--live);
    border-radius: 9px;
    padding: 0.7rem 0.85rem;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 0.28rem;
    width: 100%;
  }
  .builder-node:hover { border-color: var(--accent); background: var(--bg); }
  .builder-node.is-selected { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
  .builder-node.st-needs_you, .builder-node.st-blocked { border-left-color: var(--standby); }
  .builder-node.st-queued { border-left-color: var(--accent); }
  .builder-node.st-failed { border-left-color: var(--offline); }
  .builder-node.st-done { border-left-color: var(--unbuilt); opacity: 0.82; }
  .bn-top { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; font-size: 0.85rem; color: var(--text-dim); }
  .bn-age { margin-left: auto; font-size: 0.85rem; color: var(--text-dim); font-variant-numeric: tabular-nums; }
  .bn-title { font-size: 1rem; font-weight: 650; line-height: 1.32; }
  .bn-meta { font-size: 0.88rem; color: var(--text-dim); overflow-wrap: anywhere; }

  .mode-recovery .only-flow { opacity: 0.32; }
  .mode-flow .only-recovery { opacity: 0.45; }
  .mode-lanes .lane-dim { opacity: 0.45; }

  /* Inspector panel */
  aside.inspector {
    position: sticky;
    top: 1rem;
    max-height: calc(100vh - 2rem);
    overflow-y: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.1rem;
    box-shadow: var(--shadow);
  }
  .ins-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.35rem; }
  .ins-kicker { font-size: 0.9rem; font-weight: 600; color: var(--text-dim); margin: 0; }
  .ins-title { margin: 0.2rem 0 0.45rem; font-size: 1.25rem; font-weight: 650; line-height: 1.3; overflow-wrap: anywhere; }
  .ins-summary { margin: 0 0 0.8rem; font-size: 0.98rem; color: var(--text-dim); }
  .kv { border-top: 1px solid var(--border); padding: 0.7rem 0; }
  .kv-label { font-size: 0.9rem; font-weight: 650; color: var(--text-dim); margin-bottom: 0.28rem; }
  .kv-val { font-size: 0.98rem; color: var(--text); overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .kv-val code { font-family: var(--mono); font-size: 0.9em; background: var(--surface-2); padding: 0.08rem 0.35rem; border-radius: 4px; }
  ul.checklist { list-style: none; padding: 0; margin: 0.3rem 0 0; font-size: 0.95rem; }
  ul.checklist li { display: flex; gap: 0.5rem; padding: 0.18rem 0; }
  ul.checklist li.done { color: var(--text); }
  ul.checklist li.todo { color: var(--unbuilt); }
  ul.checklist .mark { font-family: var(--mono); font-weight: 700; width: 1rem; flex-shrink: 0; }
  ul.checklist li.done .mark { color: var(--live); }
  .inspect-box { border-top: 1px solid var(--border); padding-top: 0.8rem; margin-top: 0.3rem; }
  .inspect-controls { display: flex; gap: 0.45rem; margin-top: 0.45rem; flex-wrap: wrap; }
  .inspect-controls input {
    flex: 1 1 9rem;
    min-height: 2.5rem;
    font-family: var(--mono);
    font-size: 0.92rem;
    padding: 0.4rem 0.65rem;
    border-radius: 8px;
    border: 1px solid var(--border-strong);
    background: var(--surface-2);
    color: var(--text);
  }
  pre.term-dump {
    margin: 0.6rem 0 0;
    padding: 0.8rem;
    background: var(--term-bg);
    color: var(--term-fg);
    border: 1px solid var(--border);
    border-radius: 8px;
    font-family: var(--mono);
    font-size: 0.88rem;
    line-height: 1.48;
    max-height: 22rem;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* Live Threads Grouped by App (below the diagram, clear visual separation per app) */
  .apps-section {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    margin-top: 0.3rem;
  }
  .apps-section-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
  }
  .apps-section-head h2 { margin: 0; font-size: 1.35rem; font-weight: 650; }
  .app-group {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 0.95rem 1.1rem 1.05rem;
    box-shadow: var(--shadow);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .app-group.quiet { padding: 0.75rem 1.1rem; background: var(--surface-2); box-shadow: none; }
  .app-group-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem 0.9rem;
    padding-bottom: 0.55rem;
    border-bottom: 1px solid var(--border);
  }
  .app-group.quiet .app-group-head { padding-bottom: 0; border-bottom: none; }
  .app-group-title {
    margin: 0;
    font-size: 1.22rem;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
  }
  .app-group-pills { display: flex; flex-wrap: wrap; align-items: center; gap: 0.45rem; }
  .app-thread-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr));
    gap: 0.7rem;
  }
  .app-thread-card {
    display: flex;
    flex-direction: column;
    gap: 0.32rem;
    padding: 0.8rem 0.95rem;
    border-radius: 10px;
    border: 1px solid var(--border);
    border-left: 5px solid var(--border-strong);
    background: var(--bg);
    color: var(--text);
    text-decoration: none;
    transition: border-color 140ms ease, background 140ms ease;
  }
  .app-thread-card:hover { border-color: var(--accent); background: var(--surface-2); }
  .app-thread-card.st-needs_you { border-left-color: var(--standby); }
  .app-thread-card.st-working { border-left-color: var(--live); }
  .app-thread-card.st-queued { border-left-color: var(--accent); }
  .app-thread-card.st-failed { border-left-color: var(--offline); }
  .atc-top { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; font-size: 0.88rem; color: var(--text-dim); }
  .atc-age { margin-left: auto; font-variant-numeric: tabular-nums; }
  .atc-title { font-size: 1.05rem; font-weight: 650; line-height: 1.35; }
  .atc-act { font-size: 0.92rem; color: var(--accent); font-weight: 600; }
  .atc-prev { font-size: 0.92rem; color: var(--text-dim); }
</style>
</head>
<body>
<div class="shell">
  <header>
    <div class="title-block">
      <h1>Feedback Loop — Mathematical Tree</h1>
      <span class="pill live" id="liveBadge"><span class="dot pulsing"></span>Live · 10s</span>
    </div>
    <div class="controls">
      <a class="btn" href="https://systems-floorplan.pages.dev/">← Systems Home</a>
      <a class="btn worldview" href="/about/threads">Full Tracker →</a>
      <a class="btn" href="/about/worldview">Mental Model (30s)</a>
      <button class="btn" id="openInspectorBtn" type="button">Inspector</button>
      <button class="btn" id="termsBtn" type="button" aria-expanded="false">Terms</button>
      <div class="size-group" role="group" aria-label="Text size">
        <button class="btn size-btn" data-size="normal" aria-pressed="true" type="button">A</button>
        <button class="btn size-btn" data-size="large" aria-pressed="false" type="button">A+</button>
        <button class="btn size-btn" data-size="huge" aria-pressed="false" type="button">A++</button>
      </div>
      <button class="btn" id="refreshBtn" type="button">Refresh</button>
      <button class="btn" id="themeBtn" type="button">Theme</button>
    </div>
  </header>

  <section class="status-bar" aria-label="Live telemetry summary">
    <span class="sb-item"><strong>Worker</strong> <span id="sbChats">—</span></span>
    <span class="sb-sep">·</span>
    <span class="sb-item"><span class="pill standby" id="sbOrcaPill">Orca —</span></span>
    <span class="sb-sep">·</span>
    <span class="sb-item"><span class="pill standby" id="sbRexPill">Rex —</span></span>
    <span class="sb-sep">·</span>
    <span class="sb-item"><strong>Fable</strong> <span id="sbFable">—</span></span>
    <span class="sb-sep">·</span>
    <span class="sb-item"><strong>Live threads</strong> <span id="sbActive">—</span></span>
    <span class="sb-time" id="lastUpdated">Syncing…</span>
  </section>

  <section class="terms-drawer" id="termsDrawer" aria-label="Glossary of system terms">
    <dl class="terms-grid" id="termsGrid"></dl>
  </section>

  <div class="workspace">
    <section class="diagram mode-flow" id="diagramRoot" aria-label="Live FeedbackKit system flow diagram">
      <div class="diagram-toolbar">
        <span class="diagram-title">Live System Flow (click any box or thread to inspect)</span>
        <div class="mode-group">
          <button class="btn mode-btn" data-mode="flow" aria-pressed="true" type="button">1 · Flow</button>
          <button class="btn mode-btn" data-mode="recovery" aria-pressed="false" type="button">2 · Reboot</button>
          <button class="btn mode-btn" data-mode="lanes" aria-pressed="false" type="button">3 · Orca vs Rex</button>
        </div>
      </div>

      <!-- Rank 0: Client Apps -->
      <div class="rank">
        <div class="rank-head"><span>R0 · Client Apps</span><span>FeedbackKit SDK → POST /v2/feedback</span></div>
        <div class="rank-row">
          <button class="node-card state-live" data-id="apps" type="button">
            <div class="nc-top"><span class="nc-kicker">Client Apps (iOS / macOS)</span><span class="pill live">Live</span></div>
            <div class="nc-title">Agent Pager · PR Hub · Trips · Demo</div>
            <div class="nc-metric" id="nodeAppsMetric">Loading app counts…</div>
          </button>
          <button class="node-card state-unbuilt only-flow" data-id="menubar_about" type="button">
            <div class="nc-top"><span class="nc-kicker">Menu Bar Item</span><span class="pill unbuilt">Unbuilt</span></div>
            <div class="nc-title">Menu Bar → /about Link</div>
            <div class="nc-sub">Not wired in MenuBar Swift app yet</div>
          </button>
        </div>
      </div>

      <div class="flow-arrow hot">↓ POST /v2/feedback · ↑ ACP live + APNs push</div>

      <!-- Rank 1: Cloudflare Worker -->
      <div class="rank">
        <div class="rank-head"><span>R1 · Cloudflare Worker</span><span>Single D1 queue + R2 media + DO live rooms</span></div>
        <div class="rank-row single">
          <div class="node-card state-live is-selected" data-id="worker" role="button" tabindex="0">
            <div class="nc-top"><span class="nc-kicker">Cloudflare Worker</span><span class="pill live">Live</span></div>
            <div class="nc-title">featurekit Worker + D1 + R2</div>
            <div class="nc-metric" id="nodeWorkerMetric">Loading D1 telemetry…</div>
            <div class="cf-links-bar" id="nodeWorkerLinks" style="display:none">
              <a id="cardLinkWorker" href="#" target="_blank" rel="noopener noreferrer">Worker ↗</a>
              <a id="cardLinkD1" href="#" target="_blank" rel="noopener noreferrer">D1 ↗</a>
              <a id="cardLinkR2" href="#" target="_blank" rel="noopener noreferrer">R2 ↗</a>
            </div>
          </div>
        </div>
      </div>

      <div class="flow-arrow live" id="arrowWorkerRunners">↓ /runner/poll (Orca skips rex-apps.json) · ↓ /runner/claim (Rex Go)</div>

      <!-- Rank 2: Two Isolated Runners -->
      <div class="rank">
        <div class="rank-head"><span>R2 · Runners (No Race)</span><span>Orca keeps legacy chats · Rex takes opted-in apps</span></div>
        <div class="rank-row two-col">
          <button class="node-card state-standby" id="nodeOrcaRunner" data-id="orca_runner" type="button">
            <div class="nc-top"><span class="nc-kicker">Orca Lane (Python)</span><span class="pill standby" id="chipOrca">Wait</span></div>
            <div class="nc-title">Orca Runner + Worktrees</div>
            <div class="nc-metric" id="nodeOrcaMetric">Checking beat…</div>
            <div class="nc-sub">Untouched · skips rex-apps.json</div>
          </button>

          <button class="node-card state-standby" id="nodeGoRunner" data-id="go_runner" type="button">
            <div class="nc-top"><span class="nc-kicker">Rex Lane (Go Binary)</span><span class="pill standby" id="chipRex">Idle</span></div>
            <div class="nc-title">rex-runner (LaunchAgent + Watchdog)</div>
            <div class="nc-metric" id="nodeRexMetric">Checking Rex heartbeat…</div>
            <div class="nc-sub" id="nodeRexSub">claude-switch watchdog · OSC 7501</div>
          </button>
        </div>
      </div>

      <div class="flow-arrow hot">↓ enqueue inbox.jsonl → drain when Fable is idle</div>

      <!-- Rank 3 & 4: Rex Session feedback-loop -->
      <div class="rex-box">
        <div class="rex-box-head">
          <span id="rexBoundaryTag">R3–R4 · Rex Session: feedback-loop</span>
          <span class="pill accent" id="rexRunsBadge">Loading threads…</span>
        </div>

        <div class="coord-grid">
          <button class="node-card state-standby" id="nodeInbox" data-id="inbox" type="button">
            <div class="nc-top"><span class="nc-kicker">FIFO Queue</span><span class="pill standby" id="chipInbox">Idle</span></div>
            <div class="nc-title">Coordinator Inbox</div>
            <div class="nc-metric" id="nodeInboxMetric">0 pending</div>
            <div class="nc-sub">inbox.jsonl + flock</div>
          </button>

          <button class="node-card state-standby" id="nodeFable" data-id="fable" type="button">
            <div class="nc-top"><span class="nc-kicker">Tab 1 (Pinned UUID)</span><span class="pill standby" id="chipFable">Idle</span></div>
            <div class="nc-title">Fable 5.2 Coordinator</div>
            <div class="nc-metric" id="nodeFableMetric">Checking Tab 1…</div>
            <div class="nc-sub">claude-switch failover</div>
          </button>

          <button class="node-card state-standby" id="nodeReaper" data-id="reaper" type="button">
            <div class="nc-top"><span class="nc-kicker">Cleanup</span><span class="pill standby" id="chipReaper">Idle</span></div>
            <div class="nc-title">Reaper (reap)</div>
            <div class="nc-metric" id="nodeReaperMetric">Clean git guard</div>
            <div class="nc-sub">24h idle TTL</div>
          </button>
        </div>

        <div class="rank-head" style="margin-top:0.2rem">
          <span id="r4Heading">R4 · Live Builder &amp; Active Threads</span>
          <button class="btn" id="toggleDoneBtn" type="button" aria-pressed="false" style="min-height:2.1rem;padding:0.2rem 0.65rem;font-size:0.86rem">Show recent done</button>
        </div>
        <div class="builder-grid" id="builderGrid">
          <div class="nc-sub">Loading live threads…</div>
        </div>
      </div>
    </section>

    <div class="inspector-backdrop" id="inspectorBackdrop" aria-hidden="true"></div>
    <aside class="inspector" id="inspectorPanel" aria-live="polite">
      <div class="ins-head">
        <p class="ins-kicker" id="insKicker">R1 · Cloudflare Worker</p>
        <span class="pill live" id="insBadge">Live</span>
        <button class="btn ins-close" id="closeInspectorBtn" type="button" aria-label="Close inspector">Close ×</button>
      </div>
      <h2 class="ins-title" id="insTitle">featurekit Worker</h2>
      <p class="ins-summary" id="insSummary"></p>
      <div class="kv">
        <div class="kv-label">Live Telemetry</div>
        <div class="kv-val" id="insLive">Syncing…</div>
        <div class="cf-links-bar" id="insLinks" style="display:none"></div>
      </div>
      <div class="kv">
        <div class="kv-label">Build Checklist</div>
        <ul class="checklist" id="insChecklist"></ul>
      </div>
      <div class="kv">
        <div class="kv-label">Failure &amp; Reboot Recovery</div>
        <div class="kv-val" id="insRecovery"></div>
      </div>
      <div class="inspect-box" id="inspectBox">
        <div class="kv-label">Live Thread / Terminal Dump</div>
        <div class="inspect-controls" id="inspectAuthRow">
          <input type="password" id="inspectTokenInput" placeholder="Runner or Admin token…"/>
          <button class="btn" id="inspectUnlockBtn" type="button">Unlock</button>
          <button class="btn" id="inspectClearBtn" type="button" style="display:none">Lock</button>
        </div>
        <div class="kv-val" id="inspectMeta" style="margin-top:0.45rem;font-size:0.92rem;color:var(--text-dim)">Auto-unlocks behind Cloudflare Access (or enter runner token once).</div>
        <pre class="term-dump" id="inspectDump" style="display:none"></pre>
      </div>
    </aside>
  </div>

  <!-- Live Threads Grouped Clearly by App -->
  <section class="apps-section" id="liveThreadsPanel" aria-label="Live feedback threads grouped by app">
    <div class="apps-section-head">
      <h2>Live Threads by App</h2>
      <div class="controls">
        <button class="btn" id="toggleQuietAppsBtn" type="button" aria-pressed="false">Show quiet apps</button>
        <a class="btn worldview" href="/about/threads">Open Full Tracker →</a>
      </div>
    </div>
    <div id="liveThreadsBody" class="nc-sub">Loading live threads…</div>
  </section>
</div>
<button class="btn inspector-dock" id="inspectorDock" type="button">Inspector: featurekit Worker</button>

<script>
let LATEST = null;
let THREADS = null;
let INSPECT = null;
let SELECTED = "worker";
let SHOW_DONE_IN_DIAGRAM = false;
let SHOW_QUIET_APPS = false;
const TOKEN_KEY = "fk_about_inspect_token";
const SIZE_KEY = "fk_text_size";

const APP_LABELS = {
  "agent-pager": "Agent Pager",
  "prhub": "PR Hub",
  "trips": "Trips",
  "feedbackkit-demo": "FeedbackKit Demo"
};
function appDisplayName(slug) {
  return APP_LABELS[slug] || slug;
}

const ABOUT_TERMS = {
  runner: "Local Mac daemon (Python runner/ for Orca, Go rex-runner for Rex) bridging the Worker and your Mac.",
  agent: "The AI model coordinating or coding (Fable 5.2, Claude Opus, Codex, or Antigravity).",
  worker: "featurekit Cloudflare Worker storing chats (D1), media (R2), live rooms (DO), and this dashboard.",
  fable: "Claude Fable 5.2 in Tab 1 of Rex session feedback-loop — coordinates & validates, never edits app code directly.",
  inbox: "File-locked FIFO queue (inbox.jsonl) drained into Fable only when OSC 7501 reports idle/done.",
  reaper: "Deterministic cleanup (rex-runner reap) verifying clean git + pushed commits before closing tabs.",
  "claude-switch": "Go binary from jai/tools rotating Fable across Claude accounts on usage limits without shell scripts.",
  "OSC 7501": "Rex Program Status Protocol escape sequence reporting live idle/working/blocked/done/error states.",
  "run.json": "Per-chat manifest in each builder subfolder enabling exact session resume after reboot."
};

const termsGridEl = document.getElementById("termsGrid");
for (const [k, def] of Object.entries(ABOUT_TERMS)) {
  const wrap = document.createElement("div");
  wrap.innerHTML = "<dt>" + k + "</dt><dd>" + def + "</dd>";
  termsGridEl.appendChild(wrap);
}
const termsBtnEl = document.getElementById("termsBtn");
const termsDrawerEl = document.getElementById("termsDrawer");
termsBtnEl.addEventListener("click", () => {
  const open = termsDrawerEl.classList.toggle("open");
  termsBtnEl.setAttribute("aria-expanded", String(open));
});

function escHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtAge(sec) {
  if (sec === null || sec === undefined) return "never";
  if (sec < 60) return sec + "s ago";
  if (sec < 3600) return Math.floor(sec / 60) + "m ago";
  if (sec < 86400) return Math.floor(sec / 3600) + "h ago";
  return Math.floor(sec / 86400) + "d ago";
}

function setNodeState(el, state) {
  if (!el) return;
  el.classList.remove("state-live", "state-standby", "state-offline", "state-unbuilt");
  el.classList.add("state-" + state);
}

function stateLabel(state) {
  if (state === "standby") return "Idle";
  if (state === "live") return "Live";
  if (state === "offline") return "Offline";
  if (state === "unbuilt") return "Unbuilt";
  return state;
}

function setPill(el, state, label) {
  if (!el) return;
  el.className = "pill " + state;
  el.textContent = label || stateLabel(state);
}

function getInspectToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}

function authHeaders() {
  const t = getInspectToken();
  return t ? { Authorization: "Bearer " + t } : {};
}

function threadById(chatId) {
  if (!THREADS || !Array.isArray(THREADS.apps)) return null;
  for (const g of THREADS.apps) {
    for (const t of g.threads || []) {
      if (t.id === chatId) return t;
    }
  }
  return null;
}

function runById(chatId) {
  if (!LATEST || !LATEST.rex || !Array.isArray(LATEST.rex.runs)) return null;
  return LATEST.rex.runs.find((r) => r.chat_id === chatId) || null;
}

/** Merges ALL live Rex builder runs + live D1 threads so the diagram never hides active work. */
function collectDiagramThreads() {
  const byId = new Map();
  const runs = (LATEST && LATEST.rex && Array.isArray(LATEST.rex.runs)) ? LATEST.rex.runs : [];
  for (const r of runs) {
    const isLive = r.status === "active" || r.status === "progress" || r.status === "blocked";
    if (!isLive && !(SHOW_DONE_IN_DIAGRAM && r.status === "done")) continue;
    byId.set(r.chat_id, {
      id: r.chat_id,
      app: r.app,
      title: r.chat_id,
      state: r.status === "blocked" ? "blocked" : (isLive ? "working" : "done"),
      rawStatus: r.status,
      agent: r.agent,
      lane: "rex",
      activity: r.agent + " · " + r.status,
      updatedAt: r.updated_at_ms
    });
  }
  if (THREADS && Array.isArray(THREADS.apps)) {
    for (const g of THREADS.apps) {
      for (const t of g.threads || []) {
        const isLive = t.state === "needs_you" || t.state === "working" || t.state === "queued" || t.state === "failed";
        const existing = byId.get(t.id);
        if (existing) {
          existing.title = t.title || existing.title;
          if (t.state === "needs_you" || t.state === "failed" || t.state === "queued") {
            existing.state = t.state;
          }
          if (t.activity) existing.activity = t.activity;
          existing.asks = t.asks;
          existing.updatedAt = Math.max(existing.updatedAt || 0, t.updated_at || 0);
        } else if (isLive) {
          byId.set(t.id, {
            id: t.id,
            app: t.app,
            title: t.title || t.id,
            state: t.state,
            rawStatus: t.state,
            agent: t.builder ? t.builder.agent : (t.lane === "rex" ? "fable" : t.lane),
            lane: t.lane,
            asks: t.asks,
            activity: t.activity || (t.lane === "rex" ? "Coordinator / Rex" : t.lane),
            updatedAt: t.updated_at
          });
        }
      }
    }
  }
  const order = { needs_you: 0, blocked: 1, working: 2, queued: 3, failed: 4, done: 5 };
  return Array.from(byId.values()).sort((a, b) => {
    const oa = order[a.state] ?? 9;
    const ob = order[b.state] ?? 9;
    if (oa !== ob) return oa - ob;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

function badgeForThreadState(state, asks) {
  if (state === "needs_you") return ["standby", asks ? "Needs answer" : "Needs you"];
  if (state === "blocked") return ["standby", "Blocked"];
  if (state === "working") return ["live", "Working"];
  if (state === "queued") return ["accent", "Queued"];
  if (state === "failed") return ["offline", "Failed"];
  return ["unbuilt", "Done"];
}

function renderDiagramBuilders() {
  const grid = document.getElementById("builderGrid");
  const items = collectDiagramThreads();
  const liveCount = items.filter((x) => x.state !== "done").length;
  document.getElementById("sbActive").textContent = String(liveCount);
  document.getElementById("rexRunsBadge").textContent = liveCount + " live thread" + (liveCount === 1 ? "" : "s");
  document.getElementById("r4Heading").textContent = "R4 · Live Builder & Active Threads (" + items.length + " shown)";

  if (items.length === 0) {
    grid.innerHTML = '<div class="nc-sub">All quiet — 0 active builder threads right now.</div>';
    return;
  }
  let html = "";
  for (const item of items) {
    const [pillCls, pillTxt] = badgeForThreadState(item.state, item.asks);
    const sel = SELECTED === ("chat:" + item.id) ? " is-selected" : "";
    const ageSec = item.updatedAt ? Math.max(0, Math.floor((Date.now() - item.updatedAt) / 1000)) : null;
    html += '<button class="builder-node st-' + escHtml(item.state) + sel + '" data-id="chat:' + escHtml(item.id) + '" type="button">' +
      '<div class="bn-top">' +
        '<span class="pill ' + pillCls + '">' + (item.state === "working" ? '<span class="dot pulsing"></span>' : '') + escHtml(pillTxt) + '</span>' +
        '<span class="pill accent">' + escHtml(appDisplayName(item.app)) + '</span>' +
        '<span class="bn-age">' + escHtml(fmtAge(ageSec)) + '</span>' +
      '</div>' +
      '<div class="bn-title">' + escHtml(item.title) + '</div>' +
      '<div class="bn-meta">' + escHtml(item.activity || item.agent) + ' · ' + escHtml(item.id) + '</div>' +
    '</button>';
  }
  grid.innerHTML = html;
  grid.querySelectorAll(".builder-node").forEach((btn) => {
    btn.addEventListener("click", () => selectNode(btn.dataset.id));
  });
}

function renderGroupedThreads() {
  const box = document.getElementById("liveThreadsBody");
  if (!THREADS) return;
  if (THREADS.error === "HTTP 401") {
    box.innerHTML = 'Sign in via Cloudflare Access or unlock with your runner token to view live threads. <a href="/about/threads">Open tracker →</a>';
    return;
  }
  if (THREADS.error) {
    box.textContent = "Live threads sync error: " + THREADS.error;
    return;
  }
  const groups = [...(THREADS.apps || [])].sort((a, b) => {
    const aLive = a.needs_you + a.working + a.queued + a.failed;
    const bLive = b.needs_you + b.working + b.queued + b.failed;
    if (aLive !== bLive) return bLive - aLive;
    return b.total - a.total;
  });

  let html = "";
  let rendered = 0;
  for (const g of groups) {
    const active = (g.threads || []).filter((t) =>
      t.state === "needs_you" || t.state === "working" || t.state === "queued" || t.state === "failed"
    );
    const isQuiet = active.length === 0;
    if (isQuiet && !SHOW_QUIET_APPS) continue;
    rendered++;
    html += '<article class="app-group' + (isQuiet ? ' quiet' : '') + '">';
    html += '<div class="app-group-head">';
    html += '<h3 class="app-group-title">' + escHtml(appDisplayName(g.app)) +
      ' <span class="pill ' + (g.lane_default === "rex" ? "accent" : "unbuilt") + '">' + (g.lane_default === "rex" ? "Rex / Fable" : "Orca") + '</span></h3>';
    html += '<div class="app-group-pills">' +
      (g.needs_you ? '<span class="pill standby">' + g.needs_you + ' needs you</span>' : '') +
      (g.working ? '<span class="pill live">' + g.working + ' working</span>' : '') +
      (g.queued ? '<span class="pill accent">' + g.queued + ' queued</span>' : '') +
      (g.failed ? '<span class="pill offline">' + g.failed + ' failed</span>' : '') +
      '<span class="pill unbuilt">' + g.total + ' total</span>' +
      '<a class="btn" href="/about/threads" style="min-height:2rem;padding:0.2rem 0.65rem;font-size:0.86rem">Tracker →</a>' +
      '</div></div>';

    if (!isQuiet) {
      html += '<div class="app-thread-grid">';
      for (const t of active) {
        const [pillCls, pillTxt] = badgeForThreadState(t.state, t.asks);
        const ageSec = t.updated_at ? Math.max(0, Math.floor((Date.now() - t.updated_at) / 1000)) : null;
        html += '<a class="app-thread-card st-' + escHtml(t.state) + '" href="/about/threads#chat=' + escHtml(t.id) + '">' +
          '<div class="atc-top">' +
            '<span class="pill ' + pillCls + '">' + (t.state === "working" ? '<span class="dot pulsing"></span>' : '') + escHtml(pillTxt) + '</span>' +
            '<span>' + escHtml(t.lane === "rex" ? "Rex" : t.lane) + ' · ' + escHtml(t.id) + '</span>' +
            '<span class="atc-age">' + escHtml(fmtAge(ageSec)) + '</span>' +
          '</div>' +
          '<div class="atc-title">' + escHtml(t.title) + '</div>' +
          (t.activity ? '<div class="atc-act">' + escHtml(t.activity) + '</div>' : '') +
          (t.latest_preview && t.latest_preview !== t.title ? '<div class="atc-prev">' + escHtml(t.latest_preview) + '</div>' : '') +
        '</a>';
      }
      html += '</div>';
    }
    html += '</article>';
  }

  const quietCount = groups.filter((g) => (g.needs_you + g.working + g.queued + g.failed) === 0).length;
  const qBtn = document.getElementById("toggleQuietAppsBtn");
  qBtn.textContent = SHOW_QUIET_APPS ? ("Hide quiet apps (" + quietCount + ")") : ("Show quiet apps (" + quietCount + ")");
  qBtn.style.display = quietCount > 0 ? "inline-flex" : "none";

  if (rendered === 0) {
    const total = groups.reduce((n, g) => n + g.total, 0);
    html = '<div class="app-group quiet">All quiet — 0 active or waiting threads (' + total + ' total across ' + groups.length + ' apps). <a href="/about/threads">Browse all threads →</a></div>';
  }
  box.innerHTML = html;
}

function metaFor(id, data) {
  const w = data ? data.worker : null;
  const o = data ? data.orca : null;
  const r = data ? data.rex : null;
  const c = data ? data.components : {};

  if (id && id.startsWith("chat:")) {
    const chatId = id.slice(5);
    const t = threadById(chatId);
    const run = runById(chatId);
    const st = t
      ? (t.state === "working" ? "live" : (t.state === "failed" ? "offline" : "standby"))
      : (run && (run.status === "active" || run.status === "progress") ? "live" : "standby");
    return {
      kicker: "R4 · " + appDisplayName((t && t.app) || (run && run.app) || "thread"),
      title: (t && t.title) || chatId,
      state: st,
      summary: (t && t.latest_preview) || "Live feedback thread tracked inside Rex session feedback-loop.",
      live: (t && t.activity ? t.activity + " · " : "") + "chat=" + chatId + (run ? " · agent=" + run.agent + " (" + run.status + ")" : ""),
      links: [["Open full thread in Tracker ↗", "/about/threads#chat=" + chatId]],
      checklist: [
        [true, "Tracked in Worker D1 (" + chatId + ")"],
        [Boolean(run), "Isolated Rex builder subfolder + run.json"],
        [Boolean(t && t.shipped), "Shipped commit / PR / release linked"]
      ],
      recovery: "rex-runner boot reads run.json and resumes the builder session cleanly after a reboot."
    };
  }

  const catalog = {
    apps: {
      kicker: "R0 · Client Apps",
      title: "Agent Pager · PR Hub · Trips · Demo",
      state: c.apps || "live",
      summary: "Apps embedding FeedbackKit SDK. Owners ship fixes; builders open PRs; everyone else files a GitHub issue.",
      live: w ? w.apps.map((a) => appDisplayName(a.app) + ": " + a.chats).join(" · ") : "Loading…",
      checklist: [
        [true, "FeedbackKit SDK integrated in apps"],
        [true, "Live ACP updates + APNs push"],
        [Boolean(r && r.claim_apps && r.claim_apps.length > 0), "Apps opted into Rex lane (" + (r && r.claim_apps ? r.claim_apps.join(", ") : "none") + ")"]
      ],
      recovery: "DurableNetworking buffers messages offline and replays idempotently via client_ref."
    },
    menubar_about: {
      kicker: "R0 · Menu Bar Item",
      title: "Menu Bar → /about Link",
      state: c.menubar_about || "unbuilt",
      summary: "Menu bar entry that opens this live dashboard directly from macOS.",
      live: "Unbuilt — open this URL directly in browser for now.",
      checklist: [
        [true, "Live /about + /about/threads dashboards deployed on Worker"],
        [false, "Add About menu item in runner/MenuBar Swift app"]
      ],
      recovery: "Stateless URL launcher; falls back to browser bookmark."
    },
    worker: {
      kicker: "R1 · Cloudflare Worker",
      title: "featurekit Worker + D1 + R2",
      state: c.worker || "live",
      summary: "Cloudflare Worker holding every app's chats, media, wake-up Durable Object, and these live dashboards.",
      live: w ? (w.total_chats + " chats · " + w.pending_messages + " pending · " + w.delivering_messages + " delivering · " + w.failed_messages + " failed") : "Loading…",
      checklist: [
        [true, "D1 chats + messages + runner_beat live"],
        [true, "GET /about + /about/threads + /about/status.json live"],
        [true, "Cloudflare Access JWT auto-unlock persisted as Worker secrets"]
      ],
      recovery: "Stateless edge Worker over D1 & R2. Unclaimed messages wait safely until claimed."
    },
    orca_runner: {
      kicker: "R2 · Orca Lane (Python)",
      title: "Orca Runner + Worktrees",
      state: c.orca_runner || "standby",
      summary: "Existing production Python runner kept untouched for existing Orca chats; skips Rex apps via rex-apps.json.",
      live: o ? (o.online ? "Online · last poll " + fmtAge(o.age_seconds) : "Offline · last poll " + fmtAge(o.age_seconds)) : "Loading…",
      checklist: [
        [true, "Production LaunchAgent running"],
        [true, "Skips Rex apps via rex-apps.json (zero race)"]
      ],
      recovery: "launchd restarts automatically; claimed messages are journaled before delivery."
    },
    go_runner: {
      kicker: "R2 · Rex Lane (Go Binary)",
      title: "rex-runner (Go Daemon)",
      state: c.go_runner || "standby",
      summary: "Single Go binary for Rex session boot, claude-switch coordinator watchdog, FIFO inbox drain, reap, and Worker claiming.",
      live: r && r.reported_at_ms
        ? ("Heartbeat " + fmtAge(r.age_seconds) + " · session " + r.session_name + " · apps: " + (r.claim_apps.length ? r.claim_apps.join(", ") : "none"))
        : "Waiting for heartbeat…",
      checklist: [
        [true, "Go binary installed (boot, spawn, report, reply, drain, reap, serve)"],
        [true, "Pure-Go claude-switch watchdog + modal auto-dismiss (start.sh deleted)"],
        [Boolean(r && r.connected), "macOS LaunchAgent keeping rex-runner serve alive"],
        [Boolean(r && r.claim_apps && r.claim_apps.length > 0), "Opt-in claim_apps routing active"]
      ],
      recovery: "30s watchdog detects dead/rate-limited Tab 1 and relaunches via claude-switch resume --next."
    },
    inbox: {
      kicker: "R3 · Serialized Queue",
      title: "Coordinator Inbox (FIFO)",
      state: c.inbox || "standby",
      summary: "File-locked append-only inbox.jsonl drained into Fable only when Rex OSC 7501 reports idle/done.",
      live: r ? (r.inbox_pending + " pending event(s) queued for Fable") : "Loading…",
      checklist: [
        [true, "Flocked inbox.jsonl + atomic cursor ack built in Go"],
        [true, "OSC 7501 stream watcher + dialog guard active"]
      ],
      recovery: "Unacknowledged events stay on disk across crashes and drain cleanly once Fable returns to idle."
    },
    fable: {
      kicker: "R3 · Tab 1 (Pinned UUID)",
      title: "Fable 5.2 Coordinator",
      state: c.fable || "standby",
      summary: "Strictly coordinates and validates across apps and shared kit repos from its own isolated folder.",
      live: r ? ((r.coordinator_active ? "Tab 1 Active" : "Tab 1 Offline") + " · state: " + r.coordinator_state) : "Loading…",
      checklist: [
        [true, "Dedicated feedback-coordinator/ folder with pinned UUID"],
        [true, "Managed by rex-runner + claude-switch (zero shell scripts)"],
        [true, "Auto-dismisses Claude Code nag modals"]
      ],
      recovery: "On exit or usage limit, rex-runner watchdog resumes the pinned UUID on the next available Claude account."
    },
    reaper: {
      kicker: "R3 · Cleanup",
      title: "Deterministic Reaper",
      state: c.reaper || "standby",
      summary: "Verifies clean git status, zero unpushed commits, and idle TTL before closing finished Rex tabs.",
      live: r ? (r.runs.filter((x) => x.status === "reaped").length + " reaped · " + r.runs.filter((x) => x.status === "done").length + " done") : "Standby",
      checklist: [
        [true, "rex-runner reap subcommand + git safety tests built"],
        [Boolean(r && r.connected), "Periodic reap running inside LaunchAgent serve"]
      ],
      recovery: "Never deletes dirty or unpushed folders — marks kept and notifies Fable."
    }
  };
  return catalog[id] || catalog.worker;
}

function renderInspector() {
  const info = metaFor(SELECTED, LATEST);
  document.getElementById("insKicker").textContent = info.kicker;
  document.getElementById("insTitle").textContent = info.title;
  document.getElementById("inspectorDock").textContent = "Inspector: " + info.title;
  document.getElementById("openInspectorBtn").textContent = "Inspector";
  document.getElementById("insSummary").textContent = info.summary;
  document.getElementById("insLive").textContent = info.live;
  document.getElementById("insRecovery").textContent = info.recovery;
  setPill(document.getElementById("insBadge"), info.state, stateLabel(info.state));

  const linksBar = document.getElementById("insLinks");
  linksBar.innerHTML = "";
  const linkItems = [];
  if (SELECTED === "worker" && LATEST && LATEST.worker && LATEST.worker.links) {
    const cf = LATEST.worker.links;
    linkItems.push(["Cloudflare Worker ↗", cf.worker], ["D1 (feedbackkit) ↗", cf.d1], ["R2 (featurekit) ↗", cf.r2]);
  }
  if (Array.isArray(info.links)) {
    for (const pair of info.links) linkItems.push(pair);
  }
  if (linkItems.length > 0) {
    linksBar.style.display = "flex";
    for (const [label, url] of linkItems) {
      const a = document.createElement("a");
      a.href = url;
      if (url.startsWith("http")) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
      a.textContent = label;
      linksBar.appendChild(a);
    }
  } else {
    linksBar.style.display = "none";
  }

  const ul = document.getElementById("insChecklist");
  ul.innerHTML = "";
  for (const [done, label] of info.checklist) {
    const li = document.createElement("li");
    li.className = done ? "done" : "todo";
    li.innerHTML = '<span class="mark">' + (done ? "✓" : "○") + "</span><span>" + escHtml(label) + "</span>";
    ul.appendChild(li);
  }
  renderInspectDump();
}

function renderInspectDump() {
  const token = getInspectToken();
  const input = document.getElementById("inspectTokenInput");
  const unlockBtn = document.getElementById("inspectUnlockBtn");
  const clearBtn = document.getElementById("inspectClearBtn");
  const meta = document.getElementById("inspectMeta");
  const dump = document.getElementById("inspectDump");
  if (!INSPECT) {
    input.style.display = token ? "none" : "inline-block";
    unlockBtn.style.display = token ? "none" : "inline-block";
    clearBtn.style.display = token ? "inline-block" : "none";
    meta.textContent = "Fetching live Rex terminal snapshot…";
    dump.style.display = "none";
    return;
  }
  if (INSPECT.error === "HTTP 401") {
    input.style.display = "inline-block";
    unlockBtn.style.display = "inline-block";
    clearBtn.style.display = token ? "inline-block" : "none";
    dump.style.display = "none";
    meta.textContent = "Sign in behind Cloudflare Access or enter your runner token once to inspect live Rex panes.";
    return;
  }
  input.style.display = "none";
  unlockBtn.style.display = "none";
  clearBtn.style.display = token ? "inline-block" : "none";
  if (INSPECT.error) {
    meta.textContent = "Inspect auth/fetch error: " + INSPECT.error;
    dump.style.display = "none";
    return;
  }
  const age = INSPECT.reported_at_ms ? fmtAge(Math.max(0, Math.floor((Date.now() - INSPECT.reported_at_ms) / 1000))) : "never";
  if (SELECTED === "inbox") {
    meta.textContent = "Recent inbox.jsonl events (updated " + age + ")";
    const rows = (INSPECT.recent_inbox || []).map((e) => "[" + (e.created_at || "") + "] " + e.kind + (e.chat_id ? " chat=" + e.chat_id : "") + " — " + e.summary);
    dump.textContent = rows.length ? rows.join("\\n") : "(inbox empty)";
    dump.style.display = "block";
    return;
  }
  let targetPane = null;
  if (SELECTED.startsWith("chat:")) {
    const chatId = SELECTED.slice(5);
    targetPane = (INSPECT.panes || []).find((p) => p.id === chatId) || null;
  } else if (SELECTED === "fable" || SELECTED === "go_runner" || SELECTED === "worker") {
    targetPane = (INSPECT.panes || []).find((p) => p.kind === "coordinator") || (INSPECT.panes || [])[0];
  }
  if (!targetPane) {
    meta.textContent = "No live Rex terminal capture for this node yet (snapshot " + age + "). Click Fable 5.2 or an active builder thread.";
    dump.style.display = "none";
    return;
  }
  meta.textContent = "Live Rex pane: " + targetPane.label + " [" + targetPane.status + "] · captured " + age;
  dump.textContent = targetPane.capture || "(empty pane)";
  dump.style.display = "block";
}

function applyStatus(data) {
  LATEST = data;
  const w = data.worker;
  const o = data.orca;
  const r = data.rex;
  const c = data.components;

  // Compact status bar
  document.getElementById("sbChats").textContent = w.total_chats + " chats" + (w.pending_messages > 0 ? " (" + w.pending_messages + " pending)" : "");
  setPill(document.getElementById("sbOrcaPill"), c.orca_runner, "Orca " + (o.online ? "Online" : "Offline"));
  setPill(document.getElementById("sbRexPill"), c.go_runner, "Rex " + (r.connected ? ("Live · " + r.claim_apps.length + " apps") : "Idle"));
  document.getElementById("sbFable").textContent = (r.coordinator_active ? r.coordinator_state : "offline") + " · " + r.inbox_pending + " inbox";

  // Diagram nodes
  document.getElementById("nodeAppsMetric").textContent =
    w.apps.map((a) => appDisplayName(a.app) + ": " + a.chats).join(" · ") || "No apps configured";
  document.getElementById("nodeWorkerMetric").textContent =
    w.total_chats + " chats · " + w.pending_messages + " pending · " + w.delivering_messages + " delivering · " + w.failed_messages + " failed";

  const linksGroup = document.getElementById("nodeWorkerLinks");
  if (w.links) {
    linksGroup.style.display = "flex";
    document.getElementById("cardLinkWorker").setAttribute("href", w.links.worker);
    document.getElementById("cardLinkD1").setAttribute("href", w.links.d1);
    document.getElementById("cardLinkR2").setAttribute("href", w.links.r2);
  } else {
    linksGroup.style.display = "none";
  }

  setNodeState(document.getElementById("nodeOrcaRunner"), c.orca_runner);
  document.getElementById("nodeOrcaMetric").textContent = o.online ? ("Online · beat " + fmtAge(o.age_seconds)) : ("Offline · " + fmtAge(o.age_seconds));
  setPill(document.getElementById("chipOrca"), c.orca_runner, o.online ? "Live" : "Offline");

  setNodeState(document.getElementById("nodeGoRunner"), c.go_runner);
  document.getElementById("nodeRexMetric").textContent = r.reported_at_ms
    ? ("Beat " + fmtAge(r.age_seconds) + " · " + r.runs.length + " recorded run(s)")
    : "Built · awaiting daemon";
  document.getElementById("nodeRexSub").textContent = r.connected
    ? ("LaunchAgent live · " + (r.claim_apps.length ? r.claim_apps.join(", ") : "observe only"))
    : "LaunchAgent idle";
  setPill(document.getElementById("chipRex"), c.go_runner, r.connected ? "Live" : "Idle");

  setNodeState(document.getElementById("nodeInbox"), c.inbox);
  document.getElementById("nodeInboxMetric").textContent = r.inbox_pending + " pending event(s)";
  setPill(document.getElementById("chipInbox"), c.inbox, c.inbox === "live" ? "Live" : "Idle");

  setNodeState(document.getElementById("nodeFable"), c.fable);
  document.getElementById("nodeFableMetric").textContent = r.coordinator_active ? ("Active · " + r.coordinator_state) : "Offline";
  setPill(document.getElementById("chipFable"), c.fable, r.coordinator_active ? (r.connected ? "Live" : "Idle") : "Off");

  setNodeState(document.getElementById("nodeReaper"), c.reaper);
  document.getElementById("nodeReaperMetric").textContent =
    r.runs.filter((x) => x.status === "reaped").length + " reaped · " + r.runs.filter((x) => x.status === "done").length + " done";
  setPill(document.getElementById("chipReaper"), c.reaper, c.reaper === "live" ? "Live" : "Idle");

  document.getElementById("rexBoundaryTag").textContent =
    "R3–R4 · Rex Session: " + r.session_name + (r.session_active ? " (Active)" : " (Offline)");
  document.getElementById("arrowWorkerRunners").textContent = r.claim_apps.length
    ? ("↓ Orca (legacy chats) · ↓ Rex claims: " + r.claim_apps.map(appDisplayName).join(", "))
    : "↓ /runner/poll (Orca) · Rex observe-only";

  document.getElementById("lastUpdated").textContent = "Updated " + new Date(data.now_ms).toLocaleTimeString();
  renderDiagramBuilders();
  renderInspector();
}

const inspectorPanel = document.getElementById("inspectorPanel");
const inspectorBackdrop = document.getElementById("inspectorBackdrop");
function setDrawer(open) {
  inspectorPanel.classList.toggle("drawer-open", open);
  inspectorBackdrop.classList.toggle("open", open);
}
function selectNode(id) {
  SELECTED = id;
  document.querySelectorAll(".node-card, .builder-node").forEach((x) => {
    x.classList.toggle("is-selected", x.dataset.id === SELECTED);
  });
  renderInspector();
  if (window.matchMedia("(max-width: 1180px)").matches) setDrawer(true);
}

document.querySelectorAll(".node-card").forEach((n) => {
  n.addEventListener("click", (e) => {
    if (e.target && e.target.closest && e.target.closest("a")) return;
    selectNode(n.dataset.id);
  });
});

document.getElementById("openInspectorBtn").addEventListener("click", () => setDrawer(true));
document.getElementById("inspectorDock").addEventListener("click", () => setDrawer(true));
document.getElementById("closeInspectorBtn").addEventListener("click", () => setDrawer(false));
inspectorBackdrop.addEventListener("click", () => setDrawer(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") setDrawer(false); });

document.getElementById("toggleDoneBtn").addEventListener("click", (e) => {
  SHOW_DONE_IN_DIAGRAM = !SHOW_DONE_IN_DIAGRAM;
  e.currentTarget.setAttribute("aria-pressed", String(SHOW_DONE_IN_DIAGRAM));
  renderDiagramBuilders();
});
document.getElementById("toggleQuietAppsBtn").addEventListener("click", (e) => {
  SHOW_QUIET_APPS = !SHOW_QUIET_APPS;
  e.currentTarget.setAttribute("aria-pressed", String(SHOW_QUIET_APPS));
  renderGroupedThreads();
});

document.querySelectorAll(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const root = document.getElementById("diagramRoot");
    root.classList.remove("mode-flow", "mode-recovery", "mode-lanes");
    root.classList.add("mode-" + btn.dataset.mode);
    document.querySelectorAll(".mode-btn").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
  });
});

function applySize(size) {
  const valid = size === "large" || size === "huge" ? size : "normal";
  if (valid === "normal") document.documentElement.removeAttribute("data-size");
  else document.documentElement.setAttribute("data-size", valid);
  document.querySelectorAll(".size-btn").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.size === valid)));
  try { localStorage.setItem(SIZE_KEY, valid); } catch {}
}
document.querySelectorAll(".size-btn").forEach((btn) => btn.addEventListener("click", () => applySize(btn.dataset.size)));
try { applySize(localStorage.getItem(SIZE_KEY) || "normal"); } catch {}

document.getElementById("themeBtn").addEventListener("click", () => {
  const root = document.documentElement;
  const current = root.getAttribute("data-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.setAttribute("data-theme", current ? (current === "dark" ? "light" : "dark") : (prefersDark ? "light" : "dark"));
});

document.getElementById("inspectUnlockBtn").addEventListener("click", () => {
  const val = document.getElementById("inspectTokenInput").value.trim();
  if (!val) return;
  try { localStorage.setItem(TOKEN_KEY, val); } catch {}
  document.getElementById("inspectTokenInput").value = "";
  pollAll();
});
document.getElementById("inspectClearBtn").addEventListener("click", () => {
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
  INSPECT = null;
  renderInspectDump();
});

async function pollStatus() {
  try {
    const res = await fetch("/about/status.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    applyStatus(await res.json());
  } catch (err) {
    document.getElementById("lastUpdated").textContent = "Sync error: " + err.message;
  }
}

async function pollInspect() {
  try {
    const res = await fetch("/about/inspect", { headers: authHeaders(), cache: "no-store" });
    if (!res.ok) { INSPECT = { error: "HTTP " + res.status }; renderInspectDump(); return; }
    INSPECT = await res.json();
    renderInspectDump();
  } catch (err) {
    INSPECT = { error: err.message };
    renderInspectDump();
  }
}

async function pollThreads() {
  try {
    const res = await fetch("/about/threads.json", { headers: authHeaders(), cache: "no-store" });
    if (!res.ok) {
      THREADS = { error: "HTTP " + res.status };
      renderGroupedThreads();
      return;
    }
    THREADS = await res.json();
    renderDiagramBuilders();
    renderGroupedThreads();
    renderInspector();
  } catch (err) {
    THREADS = { error: err.message };
    renderGroupedThreads();
  }
}

function pollAll() {
  pollStatus();
  pollInspect();
  pollThreads();
}

document.getElementById("refreshBtn").addEventListener("click", pollAll);
renderInspector();
pollAll();
document.addEventListener("visibilitychange", () => { if (!document.hidden) pollAll(); });
setInterval(() => { if (!document.hidden) pollAll(); }, 10000);
</script>
</body>
</html>
`;

export function aboutResponse(): Response {
  return new Response(ABOUT_HTML, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=60",
    },
  });
}
