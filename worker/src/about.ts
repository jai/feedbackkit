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
    overflow-x: clip;
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
  .ins-close { display: none; flex-shrink: 0; }
  .inspector-dock { display: none; }

  /* Eye-comfort 2D SVG Mathematical Tree Map */
  .map-panel {
    min-width: 0;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 0.9rem 1rem 1rem;
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
    padding-bottom: 0.55rem;
    border-bottom: 1px solid var(--border);
  }
  .map-filter-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.45rem;
  }
  .map-filter-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; }
  .map-filter-bar button.btn { min-height: 2.15rem; padding: 0.22rem 0.68rem; font-size: 0.88rem; }
  .diagram-title { font-size: 1.05rem; font-weight: 650; color: var(--text); display: inline-flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .mode-group { display: flex; flex-wrap: wrap; gap: 0.4rem; }
  .canvas-frame {
    overflow-x: auto;
    border-radius: 8px;
    background: var(--bg);
    border: 1px solid var(--border);
    padding: 0.65rem;
  }
  svg#tree { display: block; width: 100%; min-width: 960px; height: auto; user-select: none; }
  :root[data-size="large"] svg#tree { min-width: 1140px; }
  :root[data-size="huge"] svg#tree { min-width: 1320px; }

  .rank-label { font-family: var(--sans); font-size: 12.5px; font-weight: 700; fill: var(--text-dim); }
  .rank-rule { stroke: var(--border); stroke-width: 1.2; stroke-dasharray: 3 5; opacity: 0.7; }
  .boundary { fill: var(--surface-2); fill-opacity: 0.55; stroke: var(--border-strong); stroke-width: 1.8; stroke-dasharray: 7 5; rx: 12; }
  .boundary-tag { font-family: var(--sans); font-size: 13px; font-weight: 700; fill: var(--text); }

  .edge { fill: none; stroke-width: 2.3; stroke-linecap: round; stroke-linejoin: round; transition: opacity 180ms ease; }
  .edge-fwd { stroke: var(--accent); }
  .edge-ret { stroke: var(--live); stroke-dasharray: 7 5; }
  .edge-rec { stroke: var(--standby); stroke-dasharray: 4 5; }
  .edge-orca { stroke: var(--live); opacity: 0.85; }
  .edge-unbuilt { stroke: var(--unbuilt); stroke-dasharray: 4 4; opacity: 0.65; }
  .edge-label {
    font-family: var(--sans);
    font-size: 12.5px;
    font-weight: 650;
    fill: var(--text-dim);
    paint-order: stroke;
    stroke: var(--bg);
    stroke-width: 6px;
    stroke-linejoin: round;
  }
  .edge-label.in-rex { stroke: var(--surface-2); }
  .edge-label.fwd { fill: var(--accent); }
  .edge-label.ret { fill: var(--live); }
  .edge-label.rec { fill: var(--standby); }
  .edge-label.unbuilt { fill: var(--unbuilt); }

  @keyframes flowDash { from { stroke-dashoffset: 24; } to { stroke-dashoffset: 0; } }
  @media (prefers-reduced-motion: no-preference) {
    .mode-flow .edge-live-flow { stroke-dasharray: 9 5; animation: flowDash 1.9s linear infinite; }
    .mode-recovery .edge-rec { animation: flowDash 1.6s linear infinite; }
  }

  .node { cursor: pointer; transition: opacity 180ms ease; }
  .node rect.box { fill: var(--surface); stroke: var(--border-strong); stroke-width: 2; rx: 9; }
  .node:hover rect.box { stroke: var(--accent); stroke-width: 2.8; }
  .node.is-selected rect.box { stroke: var(--accent); stroke-width: 3.4; }
  .node.state-live rect.box { stroke: var(--live); stroke-width: 2.4; }
  .node.state-standby rect.box { stroke: var(--standby); stroke-width: 2.2; }
  .node.state-offline rect.box { stroke: var(--offline); stroke-width: 2.4; }
  .node.state-unbuilt rect.box { fill: url(#unbuilt-hatch); stroke: var(--unbuilt); stroke-width: 1.8; stroke-dasharray: 6 4; }
  .node.state-unbuilt .n-title, .node.state-unbuilt .n-sub, .node.state-unbuilt .n-metric { fill: var(--unbuilt); }

  .node .n-kicker { font-family: var(--sans); font-size: 11.5px; font-weight: 650; fill: var(--text-dim); }
  .node .n-title { font-family: var(--sans); font-size: 16px; font-weight: 700; fill: var(--text); }
  .node .n-metric { font-family: var(--sans); font-size: 13.5px; font-weight: 600; fill: var(--text); }
  .node .n-sub { font-family: var(--sans); font-size: 12.5px; fill: var(--text-dim); }
  .node .chip-bg { rx: 5; }
  .node .chip-txt { font-family: var(--sans); font-size: 11px; font-weight: 700; }
  .node a.cf-link rect { fill: var(--accent-soft); stroke: var(--accent); stroke-width: 1.4; rx: 5; }
  .node a.cf-link text { font-family: var(--sans); font-size: 12px; font-weight: 650; fill: var(--accent); }
  .node a.cf-link:hover rect { fill: var(--accent); }
  .node a.cf-link:hover text { fill: var(--surface); }

  .cf-links-bar { display: flex; flex-wrap: wrap; gap: 0.45rem; margin-top: 0.35rem; }
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

  .mode-flow .only-recovery { opacity: 0.16; }
  .mode-recovery .only-flow { opacity: 0.22; }
  .mode-lanes .only-recovery { opacity: 0.18; }
  .map-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem 1.2rem;
    font-size: 0.9rem;
    color: var(--text-dim);
  }
  .legend-item { display: inline-flex; align-items: center; gap: 0.45rem; }
  .swatch-box { width: 1rem; height: 0.7rem; border-radius: 3px; display: inline-block; }
  .swatch-box.live { border: 2px solid var(--live); background: var(--live-soft); }
  .swatch-box.standby { border: 2px solid var(--standby); background: var(--standby-soft); }
  .swatch-box.unbuilt { border: 2px dashed var(--unbuilt); background: var(--unbuilt-bg); }

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
  .ins-head {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.35rem;
  }
  .ins-kicker { font-size: 0.9rem; font-weight: 600; color: var(--text-dim); margin: 0; min-width: 0; }
  @media (max-width: 1180px) {
    .workspace { grid-template-columns: minmax(0, 1fr); }
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
      width: min(28rem, calc(100vw - 1.25rem));
      max-width: 100vw;
      max-height: 100dvh;
      overflow-y: auto;
      z-index: 50;
      border-radius: 12px 0 0 12px;
      transform: translateX(105%);
      visibility: hidden;
      pointer-events: none;
      transition: transform 180ms ease, visibility 0s linear 180ms;
    }
    aside.inspector.drawer-open {
      transform: translateX(0);
      visibility: visible;
      pointer-events: auto;
      transition: transform 180ms ease, visibility 0s linear 0s;
    }
    .ins-head {
      position: sticky;
      top: -1.1rem;
      z-index: 2;
      background: var(--surface);
      padding: 0.65rem 0 0.45rem;
      margin: -0.65rem 0 0.45rem;
      border-bottom: 1px solid var(--border);
    }
    .ins-close { display: inline-flex; margin-left: auto; }
  }
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
    <section class="map-panel" aria-label="Live FeedbackKit mathematical tree map">
      <div class="diagram-toolbar">
        <span class="diagram-title">
          <span>System Map (click any node or live thread)</span>
          <span class="pill accent" id="rexRunsBadge">Loading threads…</span>
        </span>
        <div class="mode-group">
          <button class="btn mode-btn" data-mode="flow" aria-pressed="true" type="button">1 · Flow</button>
          <button class="btn mode-btn" data-mode="recovery" aria-pressed="false" type="button">2 · Reboot</button>
          <button class="btn mode-btn" data-mode="lanes" aria-pressed="false" type="button">3 · Orca vs Rex</button>
        </div>
      </div>

      <div class="map-filter-bar" aria-label="Map thread density and app filters">
        <div class="map-filter-row" id="mapAppFilters"></div>
        <div class="map-filter-row">
          <button class="btn r4-mode-btn" data-r4="group" aria-pressed="false" type="button">📦 Group by app</button>
          <button class="btn r4-mode-btn" data-r4="threads" aria-pressed="false" type="button">🧵 All threads</button>
          <button class="btn r4-mode-btn" data-r4="collapsed" aria-pressed="false" type="button">➖ Collapse R4</button>
          <button class="btn" id="toggleDoneBtn" type="button" aria-pressed="false">✅ Show done</button>
        </div>
      </div>

      <div class="canvas-frame">
        <svg id="tree" class="mode-flow" viewBox="0 0 1160 800" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Live FeedbackKit mathematical tree">
          <defs>
            <pattern id="unbuilt-hatch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="10" height="10" fill="var(--unbuilt-bg)"/>
              <line x1="0" y1="0" x2="0" y2="10" stroke="var(--border)" stroke-width="3"/>
            </pattern>
            <marker id="arr-fwd" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
              <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="var(--accent)"/>
            </marker>
            <marker id="arr-live" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
              <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="var(--live)"/>
            </marker>
            <marker id="arr-rec" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
              <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="var(--standby)"/>
            </marker>
            <marker id="arr-unbuilt" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
              <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="var(--unbuilt)"/>
            </marker>
          </defs>

          <!-- Rank guide lines -->
          <text class="rank-label" x="18" y="42">R0 · Apps</text>
          <line class="rank-rule" x1="18" y1="112" x2="1142" y2="112"/>
          <text class="rank-label" x="18" y="154">R1 · Worker</text>
          <line class="rank-rule" x1="18" y1="254" x2="1142" y2="254"/>
          <text class="rank-label" x="18" y="306">R2 · Runners</text>
          <line class="rank-rule" x1="18" y1="406" x2="1142" y2="406"/>
          <text class="rank-label" x="18" y="458">R3 · Coord</text>
          <line class="rank-rule" x1="18" y1="600" x2="1142" y2="600"/>
          <text class="rank-label" x="18" y="646">R4 · Threads</text>

          <!-- Dashed Rex Session boundary (height expands dynamically for all live R4 threads) -->
          <rect class="boundary" id="rexBoundaryRect" x="352" y="438" width="790" height="342"/>
          <text class="boundary-tag" id="rexBoundaryTag" x="372" y="462">Rex Session: feedback-loop · OSC 7501 + claude-switch</text>

          <!-- R0 <-> R1 edges -->
          <path class="edge edge-fwd edge-live-flow only-flow" d="M 520 94 L 520 132" marker-end="url(#arr-fwd)"/>
          <path class="edge edge-ret edge-live-flow only-flow" d="M 575 132 L 575 94" marker-end="url(#arr-live)"/>
          <text class="edge-label fwd" x="380" y="119">POST /v2/feedback</text>
          <text class="edge-label ret" x="590" y="119">ACP live + APNs</text>

          <!-- R0 Menu Bar About (unbuilt) -> Worker /about -->
          <path class="edge edge-unbuilt" d="M 965 94 L 965 182 L 792 182" marker-end="url(#arr-unbuilt)"/>
          <text class="edge-label unbuilt" x="810" y="174">About link (unbuilt)</text>

          <!-- R1 -> R2 Orca (left lane) -->
          <path class="edge edge-orca edge-live-flow" d="M 465 234 L 465 262 L 175 262 L 175 286" marker-end="url(#arr-live)"/>
          <text class="edge-label ret" x="195" y="254">Orca /runner/poll (skips Rex apps)</text>

          <!-- R1 -> R2 Rex Runner (claim + status heartbeat) -->
          <path id="edgeWorkerRexClaim" class="edge edge-unbuilt" d="M 610 234 L 610 264 L 680 264 L 680 286" marker-end="url(#arr-unbuilt)"/>
          <path id="edgeRexPushStatus" class="edge edge-ret edge-live-flow" d="M 760 286 L 760 250 L 650 250 L 650 234" marker-end="url(#arr-live)"/>
          <text id="lblWorkerRexClaim" class="edge-label unbuilt" x="520" y="279">new chats: Orca</text>
          <text class="edge-label ret" x="772" y="255">POST /runner/rex-status</text>

          <!-- Orca lane R2 -> R3 -->
          <path class="edge edge-orca edge-live-flow" d="M 175 384 L 175 478" marker-end="url(#arr-live)"/>
          <text class="edge-label ret" x="48" y="432">orca worktree create</text>

          <!-- R2 Rex Runner -> R3 Inbox / Watchdog / Reaper -->
          <path class="edge edge-fwd edge-live-flow" d="M 625 384 L 625 418 L 480 418 L 480 478" marker-end="url(#arr-fwd)"/>
          <text class="edge-label fwd" x="455" y="411">enqueue inbox.jsonl</text>
          <path class="edge edge-fwd edge-live-flow" d="M 588 530 L 634 530" marker-end="url(#arr-fwd)"/>
          <text class="edge-label fwd in-rex" x="594" y="520">drain</text>
          <path class="edge edge-rec" d="M 830 384 L 830 418 L 1018 418 L 1018 478" marker-end="url(#arr-rec)"/>
          <text class="edge-label rec" x="875" y="411">rex-runner reap</text>
          <path class="edge edge-rec only-recovery" d="M 755 384 L 755 478" marker-end="url(#arr-rec)"/>
          <text class="edge-label rec only-recovery" x="765" y="432">claude-switch watchdog</text>

          <!-- Dynamic R3 -> R4 builder edges & nodes rendered by JS -->
          <g id="dynamicEdges"></g>
          <g id="dynamicBuilders"></g>

          <!-- STATIC ARCHITECTURE NODES -->
          <!-- R0: Client Apps -->
          <g class="node state-live" data-id="apps" transform="translate(340, 14)">
            <rect class="box" width="420" height="80"/>
            <text class="n-kicker" x="14" y="22">R0 · Client Apps (SDK)</text>
            <text class="n-title" x="14" y="46">Agent Pager · PR Hub · Trips · Demo</text>
            <text class="n-metric" id="nodeAppsMetric" x="14" y="68">Loading live app counts…</text>
            <rect class="chip-bg" x="358" y="10" width="48" height="20" fill="var(--live-soft)"/>
            <text class="chip-txt" x="369" y="24" fill="var(--live)">Live</text>
          </g>

          <!-- R0 Right: Menu Bar About Link (Unbuilt) -->
          <g class="node state-unbuilt only-flow" data-id="menubar_about" transform="translate(810, 14)">
            <rect class="box" width="310" height="80"/>
            <text class="n-kicker" x="14" y="22">R0 · Menu Bar Item</text>
            <text class="n-title" x="14" y="46">Menu Bar → /about Link</text>
            <text class="n-sub" x="14" y="68">Not wired in MenuBar yet</text>
            <rect class="chip-bg" x="234" y="10" width="64" height="20" fill="var(--surface)"/>
            <text class="chip-txt" x="244" y="24" fill="var(--unbuilt)">Unbuilt</text>
          </g>

          <!-- R1: Worker -->
          <g class="node state-live is-selected" data-id="worker" transform="translate(320, 134)">
            <rect class="box" width="470" height="100"/>
            <text class="n-kicker" x="14" y="22">R1 · Cloudflare Worker</text>
            <text class="n-title" x="14" y="46">featurekit Worker + D1 + R2</text>
            <text class="n-metric" id="nodeWorkerMetric" x="14" y="68">Loading D1 telemetry…</text>
            <g id="nodeWorkerLinks" style="display:none">
              <a id="svgLinkWorker" class="cf-link" href="#" target="_blank" rel="noopener noreferrer">
                <rect x="14" y="74" width="84" height="20"/>
                <text x="24" y="88">Worker ↗</text>
              </a>
              <a id="svgLinkD1" class="cf-link" href="#" target="_blank" rel="noopener noreferrer">
                <rect x="106" y="74" width="56" height="20"/>
                <text x="118" y="88">D1 ↗</text>
              </a>
              <a id="svgLinkR2" class="cf-link" href="#" target="_blank" rel="noopener noreferrer">
                <rect x="170" y="74" width="56" height="20"/>
                <text x="182" y="88">R2 ↗</text>
              </a>
            </g>
            <rect class="chip-bg" x="408" y="10" width="48" height="20" fill="var(--live-soft)"/>
            <text class="chip-txt" x="419" y="24" fill="var(--live)">Live</text>
          </g>

          <!-- R2 Left: Orca Runner -->
          <g class="node state-standby" id="nodeOrcaRunner" data-id="orca_runner" transform="translate(24, 286)">
            <rect class="box" width="302" height="98"/>
            <text class="n-kicker" x="14" y="22">R2 · Orca Lane (Python)</text>
            <text class="n-title" x="14" y="47">Orca Runner (Untouched)</text>
            <text class="n-metric" id="nodeOrcaMetric" x="14" y="70">Checking beat…</text>
            <text class="n-sub" x="14" y="88">runner.py · skips rex-apps.json</text>
            <rect class="chip-bg" id="chipOrcaBg" x="234" y="10" width="56" height="20" fill="var(--standby-soft)"/>
            <text class="chip-txt" id="chipOrcaTxt" x="245" y="24" fill="var(--standby)">Wait</text>
          </g>

          <!-- R3 Left: Orca Worktrees -->
          <g class="node state-standby" id="nodeOrcaWorktrees" data-id="orca_runner" transform="translate(24, 478)">
            <rect class="box" width="302" height="104"/>
            <text class="n-kicker" x="14" y="22">Orca Workstream</text>
            <text class="n-title" x="14" y="47">Per-Chat Orca Worktrees</text>
            <text class="n-sub" x="14" y="70">Legacy Orca chats stay live</text>
            <text class="n-sub" x="14" y="90">Zero race with Rex lane</text>
          </g>

          <!-- R2 Right: Go Rex Runner -->
          <g class="node state-standby" id="nodeGoRunner" data-id="go_runner" transform="translate(510, 286)">
            <rect class="box" width="430" height="98"/>
            <text class="n-kicker" x="14" y="22">R2 · Rex Lane (Go Binary)</text>
            <text class="n-title" x="14" y="47">rex-runner (LaunchAgent + Watchdog)</text>
            <text class="n-metric" id="nodeRexMetric" x="14" y="70">Checking Rex heartbeat…</text>
            <text class="n-sub" id="nodeRexSub" x="14" y="88">claude-switch failover · OSC 7501</text>
            <rect class="chip-bg" id="chipRexBg" x="366" y="10" width="52" height="20" fill="var(--standby-soft)"/>
            <text class="chip-txt" id="chipRexTxt" x="378" y="24" fill="var(--standby)">Idle</text>
          </g>

          <!-- R3 Inside Rex: Inbox -->
          <g class="node state-standby" id="nodeInbox" data-id="inbox" transform="translate(376, 478)">
            <rect class="box" width="212" height="104"/>
            <text class="n-kicker" x="12" y="22">R3 · FIFO Queue</text>
            <text class="n-title" x="12" y="47">Coordinator Inbox</text>
            <text class="n-metric" id="nodeInboxMetric" x="12" y="71">0 pending</text>
            <text class="n-sub" x="12" y="91">inbox.jsonl + flock</text>
            <rect class="chip-bg" id="chipInboxBg" x="154" y="10" width="48" height="20" fill="var(--standby-soft)"/>
            <text class="chip-txt" id="chipInboxTxt" x="165" y="24" fill="var(--standby)">Idle</text>
          </g>

          <!-- R3 Inside Rex: Fable 5.2 -->
          <g class="node state-standby" id="nodeFable" data-id="fable" transform="translate(634, 478)">
            <rect class="box" width="256" height="104"/>
            <text class="n-kicker" x="12" y="22">R3 · Tab 1 (Pinned)</text>
            <text class="n-title" x="12" y="47">Fable 5.2 Coordinator</text>
            <text class="n-metric" id="nodeFableMetric" x="12" y="71">Checking Tab 1…</text>
            <text class="n-sub" x="12" y="91">claude-switch · modal guard</text>
            <rect class="chip-bg" id="chipFableBg" x="196" y="10" width="48" height="20" fill="var(--standby-soft)"/>
            <text class="chip-txt" id="chipFableTxt" x="207" y="24" fill="var(--standby)">Idle</text>
          </g>

          <!-- R3 Inside Rex: Reaper -->
          <g class="node state-standby" id="nodeReaper" data-id="reaper" transform="translate(916, 478)">
            <rect class="box" width="204" height="104"/>
            <text class="n-kicker" x="12" y="22">R3 · Cleanup</text>
            <text class="n-title" x="12" y="47">Reaper / Kill</text>
            <text class="n-metric" id="nodeReaperMetric" x="12" y="71">Clean git guard</text>
            <text class="n-sub" x="12" y="91">24h idle TTL</text>
            <rect class="chip-bg" id="chipReaperBg" x="146" y="10" width="48" height="20" fill="var(--standby-soft)"/>
            <text class="chip-txt" id="chipReaperTxt" x="157" y="24" fill="var(--standby)">Idle</text>
          </g>
        </svg>
      </div>

      <div class="map-legend">
        <span class="legend-item"><span class="swatch-box live"></span>Live / Working</span>
        <span class="legend-item"><span class="swatch-box standby"></span>Idle / Needs you / Blocked</span>
        <span class="legend-item"><span class="swatch-box unbuilt"></span>Unbuilt / Done</span>
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
let MAP_APP_FILTER = "all";
let MAP_R4_MODE = "auto"; // "auto" | "group" | "threads" | "collapsed"
const TOKEN_KEY = "fk_about_inspect_token";
const SIZE_KEY = "fk_text_size";
const R4_MODE_KEY = "fk_map_r4_mode";
try {
  const savedR4 = localStorage.getItem(R4_MODE_KEY);
  if (savedR4 === "group" || savedR4 === "threads" || savedR4 === "collapsed") MAP_R4_MODE = savedR4;
} catch {}

const APP_LABELS = {
  "agent-pager": "📟 Agent Pager",
  "prhub": "🔀 PR Hub",
  "trips": "✈️ Trips",
  "feedbackkit-demo": "🧪 FeedbackKit Demo"
};
function appDisplayName(slug) {
  return APP_LABELS[slug] || ("📦 " + slug);
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
  if (state === "needs_you") return ["standby", asks ? "❓ Needs answer" : "🙋 Needs you"];
  if (state === "blocked") return ["standby", "🚧 Blocked"];
  if (state === "working") return ["live", "⚙️ Working"];
  if (state === "queued") return ["accent", "⏳ Queued"];
  if (state === "failed") return ["offline", "❌ Failed"];
  return ["unbuilt", "✅ Done"];
}

function setChip(bgEl, txtEl, state, label) {
  if (!bgEl || !txtEl) return;
  const styles = {
    live: ["var(--live-soft)", "var(--live)"],
    standby: ["var(--standby-soft)", "var(--standby)"],
    offline: ["var(--offline-soft)", "var(--offline)"],
    accent: ["var(--accent-soft)", "var(--accent)"],
    unbuilt: ["var(--surface)", "var(--unbuilt)"]
  };
  const [bg, fg] = styles[state] || styles.standby;
  bgEl.setAttribute("fill", bg);
  txtEl.setAttribute("fill", fg);
  txtEl.textContent = label;
}

function clipSvg(s, max) {
  const clean = String(s ?? "").replace(/\\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 1) + "…";
}

function renderMapAppFilterBar(allItems) {
  const bar = document.getElementById("mapAppFilters");
  const counts = new Map();
  for (const item of allItems) {
    counts.set(item.app, (counts.get(item.app) || 0) + 1);
  }
  const apps = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  let html = '<button class="btn map-app-btn" data-app="all" aria-pressed="' + (MAP_APP_FILTER === "all") + '" type="button">🌐 All (' + allItems.length + ')</button>';
  for (const [slug, cnt] of apps) {
    html += '<button class="btn map-app-btn" data-app="' + escHtml(slug) + '" aria-pressed="' + (MAP_APP_FILTER === slug) + '" type="button">' + escHtml(appDisplayName(slug)) + ' (' + cnt + ')</button>';
  }
  bar.innerHTML = html;
  bar.querySelectorAll(".map-app-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      MAP_APP_FILTER = btn.dataset.app;
      if (MAP_APP_FILTER !== "all" && MAP_R4_MODE !== "threads") {
        MAP_R4_MODE = "threads";
      }
      renderDiagramBuilders();
    });
  });
}

function effectiveR4Mode(filteredCount) {
  if (MAP_R4_MODE === "collapsed") return "collapsed";
  if (MAP_APP_FILTER !== "all") return "threads";
  if (MAP_R4_MODE === "group" || MAP_R4_MODE === "threads") return MAP_R4_MODE;
  return filteredCount > 6 ? "group" : "threads";
}

function renderDiagramBuilders() {
  const edgesG = document.getElementById("dynamicEdges");
  const nodesG = document.getElementById("dynamicBuilders");
  const svg = document.getElementById("tree");
  const boundary = document.getElementById("rexBoundaryRect");
  const allItems = collectDiagramThreads();
  const liveCount = allItems.filter((x) => x.state !== "done").length;
  document.getElementById("sbActive").textContent = String(liveCount);
  document.getElementById("rexRunsBadge").textContent = liveCount + " live thread" + (liveCount === 1 ? "" : "s");

  renderMapAppFilterBar(allItems);
  const items = MAP_APP_FILTER === "all" ? allItems : allItems.filter((x) => x.app === MAP_APP_FILTER);
  const mode = effectiveR4Mode(items.length);
  document.querySelectorAll(".r4-mode-btn").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.r4 === mode));
  });

  const startY = 636;
  const cardW = 236;
  const cardH = 112;
  const colXs = [376, 634, 892];
  const rowGap = 24;
  const rowStride = cardH + rowGap;

  if (items.length === 0) {
    edgesG.innerHTML =
      '<path class="edge edge-unbuilt" d="M 762 582 L 762 634" marker-end="url(#arr-unbuilt)"/>' +
      '<text class="edge-label unbuilt in-rex" x="774" y="614">rex-runner spawn (0 active)</text>';
    nodesG.innerHTML =
      '<g class="node state-unbuilt" transform="translate(562, 636)">' +
        '<rect class="box" width="400" height="92"/>' +
        '<text class="n-kicker" x="14" y="24">R4 · Ephemeral Builder Tabs</text>' +
        '<text class="n-title" x="14" y="50">All quiet — 0 active threads</text>' +
        '<text class="n-sub" x="14" y="74">New feedback threads branch here automatically</text>' +
      '</g>';
    boundary.setAttribute("height", "320");
    svg.setAttribute("viewBox", "0 0 1160 790");
    return;
  }

  // Collapsed R4: 1 compact summary bar on the map
  if (mode === "collapsed") {
    const appCount = new Set(items.map((x) => x.app)).size;
    const needs = items.filter((x) => x.state === "needs_you" || x.state === "blocked").length;
    const working = items.filter((x) => x.state === "working" || x.state === "queued").length;
    edgesG.innerHTML =
      '<path class="edge edge-fwd edge-live-flow" d="M 762 582 L 762 636" marker-end="url(#arr-fwd)"/>' +
      '<text class="edge-label fwd in-rex" x="776" y="614">rex-runner spawn (' + items.length + ' collapsed)</text>' +
      '<path class="edge edge-ret only-flow" d="M 540 684 L 364 684 L 364 530 L 376 530" marker-end="url(#arr-live)"/>';
    nodesG.innerHTML =
      '<g class="node state-live" id="expandR4Node" transform="translate(540, 636)">' +
        '<rect class="box" width="444" height="94"/>' +
        '<text class="n-kicker" x="16" y="24">R4 · Collapsed (' + appCount + ' app' + (appCount === 1 ? '' : 's') + ')</text>' +
        '<rect class="chip-bg" x="342" y="10" width="88" height="22" fill="var(--accent-soft)"/>' +
        '<text class="chip-txt" x="354" y="25" fill="var(--accent)">Expand ▾</text>' +
        '<text class="n-title" x="16" y="52">' + items.length + ' live thread' + (items.length === 1 ? '' : 's') + ' running</text>' +
        '<text class="n-metric" x="16" y="78">' + working + ' working · ' + needs + ' needs you / blocked · click to expand</text>' +
      '</g>';
    boundary.setAttribute("height", "316");
    svg.setAttribute("viewBox", "0 0 1160 778");
    document.getElementById("expandR4Node").addEventListener("click", () => {
      MAP_R4_MODE = items.length > 6 ? "group" : "threads";
      try { localStorage.setItem(R4_MODE_KEY, MAP_R4_MODE); } catch {}
      renderDiagramBuilders();
    });
    return;
  }

  // Group-by-app mode: 1 crisp summary node per app on the map; clicking zooms straight into that app's threads
  if (mode === "group") {
    const byApp = new Map();
    for (const item of items) {
      const arr = byApp.get(item.app) || [];
      arr.push(item);
      byApp.set(item.app, arr);
    }
    const groups = Array.from(byApp.entries()).sort((a, b) => b[1].length - a[1].length);
    const numRows = Math.ceil(groups.length / 3);
    const lastRowBottom = startY + (numRows - 1) * rowStride + cardH;
    const returnBusY = lastRowBottom + 28;
    const boundaryBottom = returnBusY + 28;
    boundary.setAttribute("height", String(boundaryBottom - 438));
    svg.setAttribute("viewBox", "0 0 1160 " + (boundaryBottom + 20));

    let edgesHtml = '<path class="edge edge-fwd edge-live-flow" d="M 762 582 L 762 608"/>';
    edgesHtml += '<text class="edge-label fwd in-rex" x="776" y="601">' + items.length + ' threads grouped by app (click an app to expand)</text>';
    const topCols = Math.min(3, groups.length);
    const leftX = colXs[0] + cardW / 2;
    const rightX = colXs[topCols - 1] + cardW / 2;
    if (topCols === 1) {
      edgesHtml += '<path class="edge edge-fwd edge-live-flow" d="M 762 608 L ' + leftX + ' 608 L ' + leftX + ' ' + startY + '" marker-end="url(#arr-fwd)"/>';
    } else {
      edgesHtml += '<path class="edge edge-fwd" d="M ' + leftX + ' 608 L ' + rightX + ' 608"/>';
      for (let c = 0; c < topCols; c++) {
        const cx = colXs[c] + cardW / 2;
        edgesHtml += '<path class="edge edge-fwd edge-live-flow" d="M ' + cx + ' 608 L ' + cx + ' ' + startY + '" marker-end="url(#arr-fwd)"/>';
      }
    }
    for (let i = 3; i < groups.length; i++) {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const cx = colXs[col] + cardW / 2;
      edgesHtml += '<path class="edge edge-fwd" d="M ' + cx + ' ' + (startY + (row - 1) * rowStride + cardH) + ' L ' + cx + ' ' + (startY + row * rowStride) + '" marker-end="url(#arr-fwd)"/>';
    }
    edgesHtml += '<path class="edge edge-ret only-flow" d="M ' + rightX + ' ' + lastRowBottom + ' L ' + rightX + ' ' + returnBusY + ' L 364 ' + returnBusY + ' L 364 530 L 376 530" marker-end="url(#arr-live)"/>';
    edgesHtml += '<text class="edge-label ret in-rex" x="540" y="' + (returnBusY + 18) + '">rex-runner report → inbox.jsonl</text>';
    edgesG.innerHTML = edgesHtml;

    let nodesHtml = "";
    for (let i = 0; i < groups.length; i++) {
      const [slug, list] = groups[i];
      const col = i % 3;
      const row = Math.floor(i / 3);
      const x = colXs[col];
      const y = startY + row * rowStride;
      const needs = list.filter((t) => t.state === "needs_you" || t.state === "blocked").length;
      const working = list.filter((t) => t.state === "working" || t.state === "queued").length;
      const nodeState = needs > 0 ? "standby" : "live";
      const chipBg = needs > 0 ? "var(--standby-soft)" : "var(--live-soft)";
      const chipFg = needs > 0 ? "var(--standby)" : "var(--live)";
      const chipTxt = list.length + " live ▾";
      const topTitle = list[0] ? clipSvg(list[0].title, 26) : "";
      nodesHtml += '<g class="node state-' + nodeState + ' app-group-node" data-app="' + escHtml(slug) + '" transform="translate(' + x + ', ' + y + ')">' +
        '<rect class="box" width="' + cardW + '" height="' + cardH + '"/>' +
        '<text class="n-kicker" x="12" y="23">App Group · Click to expand</text>' +
        '<rect class="chip-bg" x="' + (cardW - 76) + '" y="9" width="66" height="20" fill="' + chipBg + '"/>' +
        '<text class="chip-txt" x="' + (cardW - 67) + '" y="23" fill="' + chipFg + '">' + escHtml(chipTxt) + '</text>' +
        '<text class="n-title" x="12" y="51">' + escHtml(appDisplayName(slug)) + '</text>' +
        '<text class="n-metric" x="12" y="75" style="font-size:13px">' + working + ' working · ' + needs + ' needs you / blocked</text>' +
        '<text class="n-sub" x="12" y="97">' + escHtml(topTitle) + '</text>' +
      '</g>';
    }
    nodesG.innerHTML = nodesHtml;
    nodesG.querySelectorAll(".app-group-node").forEach((g) => {
      g.addEventListener("click", () => {
        MAP_APP_FILTER = g.dataset.app;
        MAP_R4_MODE = "threads";
        renderDiagramBuilders();
      });
    });
    return;
  }

  // Full per-thread mode: draw every live thread box with orthogonal branches
  const numRows = Math.ceil(items.length / 3);
  const lastRowBottom = startY + (numRows - 1) * rowStride + cardH;
  const returnBusY = lastRowBottom + 28;
  const boundaryBottom = returnBusY + 28;
  const totalHeight = boundaryBottom + 20;

  boundary.setAttribute("height", String(boundaryBottom - 438));
  svg.setAttribute("viewBox", "0 0 1160 " + totalHeight);

  let edgesHtml = "";
  const busY = 608;
  const topCols = Math.min(3, items.length);
  edgesHtml += '<path class="edge edge-fwd edge-live-flow" d="M 762 582 L 762 ' + busY + '"/>';
  edgesHtml += '<text class="edge-label fwd in-rex" x="776" y="601">rex-runner spawn (' + items.length + (MAP_APP_FILTER !== "all" ? (" in " + appDisplayName(MAP_APP_FILTER)) : " live") + ')</text>';

  if (topCols === 1) {
    const cx = colXs[0] + cardW / 2;
    edgesHtml += '<path class="edge edge-fwd edge-live-flow" d="M 762 ' + busY + ' L ' + cx + ' ' + busY + ' L ' + cx + ' ' + startY + '" marker-end="url(#arr-fwd)"/>';
  } else {
    const leftX = colXs[0] + cardW / 2;
    const rightX = colXs[topCols - 1] + cardW / 2;
    edgesHtml += '<path class="edge edge-fwd" d="M ' + leftX + ' ' + busY + ' L ' + rightX + ' ' + busY + '"/>';
    for (let c = 0; c < topCols; c++) {
      const cx = colXs[c] + cardW / 2;
      edgesHtml += '<path class="edge edge-fwd edge-live-flow" d="M ' + cx + ' ' + busY + ' L ' + cx + ' ' + startY + '" marker-end="url(#arr-fwd)"/>';
    }
  }

  for (let i = 3; i < items.length; i++) {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const cx = colXs[col] + cardW / 2;
    const prevBottom = startY + (row - 1) * rowStride + cardH;
    const nextTop = startY + row * rowStride;
    edgesHtml += '<path class="edge edge-fwd" d="M ' + cx + ' ' + prevBottom + ' L ' + cx + ' ' + nextTop + '" marker-end="url(#arr-fwd)"/>';
  }

  const leftmostX = colXs[0] + cardW / 2;
  const rightmostCol = Math.min(2, items.length - 1);
  const rightmostX = colXs[rightmostCol] + cardW / 2;
  edgesHtml += '<path class="edge edge-ret only-flow" d="M ' + rightmostX + ' ' + lastRowBottom + ' L ' + rightmostX + ' ' + returnBusY + ' L 364 ' + returnBusY + ' L 364 530 L 376 530" marker-end="url(#arr-live)"/>';
  if (items.length > 1) {
    edgesHtml += '<path class="edge edge-ret only-flow" d="M ' + leftmostX + ' ' + lastRowBottom + ' L ' + leftmostX + ' ' + returnBusY + '"/>';
  }
  edgesHtml += '<text class="edge-label ret in-rex" x="540" y="' + (returnBusY + 18) + '">rex-runner report → inbox.jsonl</text>';
  edgesG.innerHTML = edgesHtml;

  let nodesHtml = "";
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = colXs[col];
    const y = startY + row * rowStride;
    const nodeState = item.state === "working" ? "live"
      : (item.state === "failed" ? "offline"
      : (item.state === "done" ? "unbuilt" : "standby"));
    const [chipState, chipLabel] = badgeForThreadState(item.state, item.asks);
    const chipBg = chipState === "live" ? "var(--live-soft)"
      : chipState === "standby" ? "var(--standby-soft)"
      : chipState === "offline" ? "var(--offline-soft)"
      : chipState === "accent" ? "var(--accent-soft)" : "var(--surface-2)";
    const chipFg = chipState === "live" ? "var(--live)"
      : chipState === "standby" ? "var(--standby)"
      : chipState === "offline" ? "var(--offline)"
      : chipState === "accent" ? "var(--accent)" : "var(--unbuilt)";
    const sel = SELECTED === ("chat:" + item.id) ? " is-selected" : "";
    const ageSec = item.updatedAt ? Math.max(0, Math.floor((Date.now() - item.updatedAt) / 1000)) : null;
    const chipW = Math.max(68, chipLabel.length * 7.6 + 18);

    nodesHtml += '<g class="node state-' + nodeState + sel + '" data-id="chat:' + escHtml(item.id) + '" transform="translate(' + x + ', ' + y + ')">' +
      '<rect class="box" width="' + cardW + '" height="' + cardH + '"/>' +
      '<text class="n-kicker" x="12" y="23">' + escHtml(clipSvg(appDisplayName(item.app), 16)) + '</text>' +
      '<rect class="chip-bg" x="' + (cardW - chipW - 10) + '" y="9" width="' + chipW + '" height="20" fill="' + chipBg + '"/>' +
      '<text class="chip-txt" x="' + (cardW - chipW - 2) + '" y="23" fill="' + chipFg + '">' + escHtml(chipLabel) + '</text>' +
      '<text class="n-title" x="12" y="51" style="font-size:14.5px">' + escHtml(clipSvg(item.title, 25)) + '</text>' +
      '<text class="n-metric" x="12" y="75" style="font-size:12.5px">' + escHtml(clipSvg(item.activity || item.agent, 28)) + '</text>' +
      '<text class="n-sub" x="12" y="97">' + escHtml(clipSvg(item.id, 14) + ' · ' + fmtAge(ageSec)) + '</text>' +
    '</g>';
  }
  nodesG.innerHTML = nodesHtml;
  nodesG.querySelectorAll(".node").forEach((g) => {
    g.addEventListener("click", () => selectNode(g.dataset.id));
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
  setPill(document.getElementById("sbOrcaPill"), c.orca_runner, "🐋 Orca " + (o.online ? "Online" : "Offline"));
  setPill(document.getElementById("sbRexPill"), c.go_runner, "🦖 Rex " + (r.connected ? ("Live · " + r.claim_apps.length + " apps") : "Idle"));
  document.getElementById("sbFable").textContent = "🧭 " + (r.coordinator_active ? r.coordinator_state : "offline") + " · " + r.inbox_pending + " inbox";

  // Diagram nodes
  document.getElementById("nodeAppsMetric").textContent =
    w.apps.map((a) => appDisplayName(a.app) + " (" + a.chats + ")").join(" · ") || "No apps configured";
  document.getElementById("nodeWorkerMetric").textContent =
    w.total_chats + " chats · " + w.pending_messages + " pending · " + w.delivering_messages + " active";

  const linksGroup = document.getElementById("nodeWorkerLinks");
  if (w.links) {
    linksGroup.style.display = "inline";
    document.getElementById("svgLinkWorker").setAttribute("href", w.links.worker);
    document.getElementById("svgLinkD1").setAttribute("href", w.links.d1);
    document.getElementById("svgLinkR2").setAttribute("href", w.links.r2);
  } else {
    linksGroup.style.display = "none";
  }

  setNodeState(document.getElementById("nodeOrcaRunner"), c.orca_runner);
  setNodeState(document.getElementById("nodeOrcaWorktrees"), c.orca_worktrees);
  document.getElementById("nodeOrcaMetric").textContent = o.online ? ("Online · beat " + fmtAge(o.age_seconds)) : ("Offline · " + fmtAge(o.age_seconds));
  setChip(document.getElementById("chipOrcaBg"), document.getElementById("chipOrcaTxt"), c.orca_runner, o.online ? "Live" : "Offline");

  setNodeState(document.getElementById("nodeGoRunner"), c.go_runner);
  document.getElementById("nodeRexMetric").textContent = r.reported_at_ms
    ? ("Beat " + fmtAge(r.age_seconds) + " · " + r.runs.length + " run(s)")
    : "Built · awaiting daemon";
  document.getElementById("nodeRexSub").textContent = r.connected
    ? ("LaunchAgent live · " + (r.claim_apps.length ? r.claim_apps.length + " apps" : "observe only"))
    : "LaunchAgent idle";
  setChip(document.getElementById("chipRexBg"), document.getElementById("chipRexTxt"), c.go_runner, r.connected ? "Live" : "Idle");

  setNodeState(document.getElementById("nodeInbox"), c.inbox);
  document.getElementById("nodeInboxMetric").textContent = r.inbox_pending + " pending event(s)";
  setChip(document.getElementById("chipInboxBg"), document.getElementById("chipInboxTxt"), c.inbox, c.inbox === "live" ? "Live" : "Idle");

  setNodeState(document.getElementById("nodeFable"), c.fable);
  document.getElementById("nodeFableMetric").textContent = r.coordinator_active ? ("Active · " + r.coordinator_state) : "Offline";
  setChip(document.getElementById("chipFableBg"), document.getElementById("chipFableTxt"), c.fable, r.coordinator_active ? (r.connected ? "Live" : "Idle") : "Off");

  setNodeState(document.getElementById("nodeReaper"), c.reaper);
  document.getElementById("nodeReaperMetric").textContent =
    r.runs.filter((x) => x.status === "reaped").length + " reaped · " + r.runs.filter((x) => x.status === "done").length + " done";
  setChip(document.getElementById("chipReaperBg"), document.getElementById("chipReaperTxt"), c.reaper, c.reaper === "live" ? "Live" : "Idle");

  document.getElementById("rexBoundaryTag").textContent =
    "Rex Session: " + r.session_name + (r.session_active ? " (Active)" : " (Offline)") + " · OSC 7501 + claude-switch";

  const claimEdge = document.getElementById("edgeWorkerRexClaim");
  const claimLbl = document.getElementById("lblWorkerRexClaim");
  if (r.claim_apps.length > 0) {
    claimEdge.setAttribute("class", "edge edge-fwd edge-live-flow");
    claimEdge.setAttribute("marker-end", "url(#arr-fwd)");
    claimLbl.setAttribute("class", "edge-label fwd");
    claimLbl.textContent = "Rex claims: " + r.claim_apps.join(", ");
  } else {
    claimEdge.setAttribute("class", "edge edge-unbuilt");
    claimEdge.setAttribute("marker-end", "url(#arr-unbuilt)");
    claimLbl.setAttribute("class", "edge-label unbuilt");
    claimLbl.textContent = "new chats: Orca";
  }

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
  document.querySelectorAll(".node").forEach((x) => {
    x.classList.toggle("is-selected", x.dataset.id === SELECTED);
  });
  renderInspector();
  if (window.matchMedia("(max-width: 1180px)").matches) setDrawer(true);
}

document.querySelectorAll("svg#tree > .node").forEach((n) => {
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

document.querySelectorAll(".r4-mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    MAP_R4_MODE = btn.dataset.r4;
    if (MAP_R4_MODE === "group") MAP_APP_FILTER = "all";
    try { localStorage.setItem(R4_MODE_KEY, MAP_R4_MODE); } catch {}
    renderDiagramBuilders();
  });
});

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
    const svg = document.getElementById("tree");
    svg.classList.remove("mode-flow", "mode-recovery", "mode-lanes");
    svg.classList.add("mode-" + btn.dataset.mode);
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
