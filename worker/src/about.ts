/**
 * Live visual-first architecture dashboard (`GET /about`), sanitized status API
 * (`GET /about/status.json`), and Rex runner heartbeat ingest (`POST /runner/rex-status`).
 *
 * Strictly public-safe: exposes operational counts, component build states, and sanitized
 * slugs only — never chat text, emails, local paths, hostnames, or tokens.
 */

import type { AppConfig, FeatureKitEnv } from "./featurekit.ts";

const REX_STATUS_KEY = "rex/status.json";
const REX_INSPECT_KEY = "rex/inspect.json";
const MAX_INSPECT_BYTES = 256 * 1024;
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
  const runs: RexRunSnapshot[] = [];
  for (const item of runsRaw.slice(0, 24)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const r = item as Record<string, unknown>;
    const chatId = safeSlug(r.chat_id);
    if (!chatId) {
      continue;
    }
    runs.push({
      chat_id: chatId,
      app: safeSlug(r.app, "unknown"),
      agent: safeSlug(r.agent, "claude"),
      status: safeState(r.status, "active"),
      updated_at_ms: typeof r.updated_at_ms === "number" && Number.isFinite(r.updated_at_ms) ? r.updated_at_ms : now,
    });
  }

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
  const panes: StoredRexInspectPane[] = [];
  for (const item of panesRaw.slice(0, 16)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const p = item as Record<string, unknown>;
    const id = safeSlug(p.id);
    if (!id) {
      continue;
    }
    panes.push({
      id,
      label: typeof p.label === "string" ? p.label.slice(0, 80) : id,
      kind: safeState(p.kind, "builder"),
      status: safeState(p.status, "active"),
      agent: typeof p.agent === "string" ? safeSlug(p.agent) : undefined,
      app: typeof p.app === "string" ? safeSlug(p.app) : undefined,
      capture: typeof p.capture === "string" ? p.capture.slice(-12_000) : "",
    });
  }
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
  const rexAgeSec = rex ? Math.max(0, Math.floor((now - rex.reported_at_ms) / 1000)) : null;
  const rexFresh = rex !== null && now - rex.reported_at_ms <= REX_FRESH_MS;
  const activeRexRuns = rex ? rex.runs.filter((r) => r.status === "active" || r.status === "blocked") : [];

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
            runs: rex.runs,
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
     no background grid, generous line height, and zoomed-viewport drawer inspector. */
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
    --standby-soft: rgba(154, 74, 0, 0.11);
    --unbuilt: #7a7368;
    --unbuilt-bg: #efece5;
    --unbuilt-hatch: rgba(122, 115, 104, 0.14);
    --offline: #a8261c;
    --offline-soft: rgba(168, 38, 28, 0.11);
    --term-bg: #222529;
    --term-fg: #dcdfe3;
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
    --shadow: 0 8px 24px rgba(31, 35, 40, 0.08);
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
      --standby-soft: rgba(240, 179, 90, 0.14);
      --unbuilt: #8e96a0;
      --unbuilt-bg: #1f2226;
      --unbuilt-hatch: rgba(142, 150, 160, 0.12);
      --offline: #ff9b8f;
      --offline-soft: rgba(255, 155, 143, 0.15);
      --term-bg: #16181b;
      --term-fg: #dcdfe3;
      --shadow: 0 10px 28px rgba(0, 0, 0, 0.36);
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
    --standby-soft: rgba(240, 179, 90, 0.14);
    --unbuilt: #8e96a0;
    --unbuilt-bg: #1f2226;
    --unbuilt-hatch: rgba(142, 150, 160, 0.12);
    --offline: #ff9b8f;
    --offline-soft: rgba(255, 155, 143, 0.15);
    --term-bg: #16181b;
    --term-fg: #dcdfe3;
    --shadow: 0 10px 28px rgba(0, 0, 0, 0.36);
  }
  html {
    -webkit-text-size-adjust: 100%;
    text-size-adjust: 100%;
  }
  :root[data-size="large"] { font-size: 118%; }
  :root[data-size="huge"] { font-size: 136%; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: var(--sans);
    font-size: 1.125rem;
    line-height: 1.6;
    color: var(--text);
    background-color: var(--bg);
    background-image: none;
    -webkit-font-smoothing: antialiased;
  }
  em, i { font-style: normal; font-weight: 600; }
  p, li { max-width: 68ch; }
  a:focus-visible, summary:focus-visible, button:focus-visible, input:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 3px;
  }
  .shell {
    max-width: 84rem;
    margin: 0 auto;
    padding: 1.25rem max(1.1rem, env(safe-area-inset-right, 0px)) 5rem max(1.1rem, env(safe-area-inset-left, 0px));
  }

  header {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 1rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border);
  }
  .eyebrow {
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--text-dim);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.6rem;
  }
  .pill {
    font-size: 0.88rem;
    font-weight: 650;
    padding: 0.2rem 0.6rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    white-space: nowrap;
  }
  .pill.live { border-color: var(--live); color: var(--live); background: var(--live-soft); }
  .pill.standby { border-color: var(--standby); color: var(--standby); background: var(--standby-soft); }
  .pill.unbuilt { border-color: var(--unbuilt); color: var(--unbuilt); background: var(--unbuilt-bg); border-style: dashed; }
  .pill.offline { border-color: var(--offline); color: var(--offline); background: var(--offline-soft); }
  .dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; display: inline-block; background: currentColor; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  @media (prefers-reduced-motion: no-preference) { .dot.pulsing { animation: pulse 2.4s ease-in-out infinite; } }

  h1 { margin: 0.35rem 0 0.25rem; font-size: 1.65rem; font-weight: 650; line-height: 1.25; }
  .subtitle { margin: 0; font-size: 1rem; color: var(--text-dim); max-width: 65ch; }
  .subtitle code { font-family: var(--mono); font-size: 0.92em; background: var(--surface-2); padding: 0.08rem 0.35rem; border-radius: 4px; }

  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
  .size-group {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    background: var(--surface);
  }
  .size-group button.btn {
    border: none;
    border-right: 1px solid var(--border);
    border-radius: 0;
    padding: 0.45rem 0.7rem;
  }
  .size-group button.btn:last-child { border-right: none; }
  button.btn, a.btn {
    font-family: var(--sans);
    font-size: 0.95rem;
    font-weight: 500;
    min-height: 2.75rem;
    padding: 0.45rem 0.9rem;
    border-radius: 8px;
    border: 1px solid var(--border-strong);
    background: var(--surface);
    color: var(--text);
    text-decoration: none;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    transition: border-color 140ms ease, background 140ms ease;
  }
  button.btn:hover, a.btn:hover { border-color: var(--accent); color: var(--accent); }
  a.btn.worldview { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); font-weight: 600; }
  button.btn[aria-pressed="true"] {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 650;
  }
  #openInspectorBtn { display: none; }

  /* Instrument KPI strip */
  .kpi-strip {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(12.5rem, 1fr));
    gap: 0.75rem;
    margin: 1rem 0;
  }
  .kpi {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0.9rem 1rem;
    font-variant-numeric: tabular-nums;
  }
  .kpi-label {
    font-size: 0.92rem;
    font-weight: 600;
    color: var(--text-dim);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .kpi-val {
    font-size: 1.35rem;
    font-weight: 650;
    margin: 0.3rem 0 0.15rem;
    line-height: 1.25;
  }
  .kpi-sub { font-size: 0.92rem; color: var(--text-dim); overflow-wrap: anywhere; }
  .progress-bar {
    height: 0.45rem;
    background: var(--surface-2);
    border-radius: 4px;
    overflow: hidden;
    margin-top: 0.5rem;
  }
  .progress-fill { height: 100%; background: var(--live); transition: width 250ms ease; }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem 1.25rem;
    margin: 0 0 0.9rem;
    font-size: 0.95rem;
    color: var(--text-dim);
  }
  .legend-item { display: inline-flex; align-items: center; gap: 0.45rem; }
  .swatch-box { width: 1rem; height: 0.7rem; border-radius: 3px; display: inline-block; }
  .swatch-box.live { border: 2px solid var(--live); background: var(--live-soft); }
  .swatch-box.standby { border: 2px solid var(--standby); background: var(--standby-soft); }
  .swatch-box.unbuilt {
    border: 2px dashed var(--unbuilt);
    background: repeating-linear-gradient(-45deg, var(--unbuilt-bg), var(--unbuilt-bg) 4px, var(--unbuilt-hatch) 4px, var(--unbuilt-hatch) 8px);
  }

  .workspace {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 24rem;
    gap: 1.1rem;
    align-items: start;
  }
  .inspector-backdrop { display: none; }
  .ins-close { display: none; }
  .inspector-dock { display: none; }

  @media (max-width: 1120px) {
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
    aside.inspector.drawer-open {
      transform: translateX(0);
    }
    .ins-close {
      display: inline-flex;
      margin-left: auto;
    }
  }

  .canvas-frame {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: var(--shadow);
    overflow-x: auto;
    padding: 0.9rem;
  }
  svg#tree { display: block; width: 100%; min-width: 700px; height: auto; user-select: none; }

  .rank-label { font-family: var(--sans); font-size: 11px; font-weight: 650; fill: var(--text-dim); }
  .rank-rule { stroke: var(--border); stroke-width: 1; stroke-dasharray: 3 5; opacity: 0.65; }
  .boundary { fill: none; stroke: var(--border-strong); stroke-width: 1.5; stroke-dasharray: 6 4; rx: 8; }
  .boundary-tag { font-family: var(--sans); font-size: 11px; font-weight: 600; fill: var(--text-dim); }

  .edge { fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; transition: opacity 180ms ease; }
  .edge-fwd { stroke: var(--accent); }
  .edge-ret { stroke: var(--live); stroke-dasharray: 6 4; }
  .edge-rec { stroke: var(--standby); stroke-dasharray: 3 4; }
  .edge-orca { stroke: var(--live); opacity: 0.85; }
  .edge-unbuilt { stroke: var(--unbuilt); stroke-dasharray: 3 4; opacity: 0.65; }
  .edge-label {
    font-family: var(--sans);
    font-size: 11px;
    font-weight: 600;
    fill: var(--text-dim);
    paint-order: stroke;
    stroke: var(--surface);
    stroke-width: 5px;
    stroke-linejoin: round;
  }
  .edge-label.fwd { fill: var(--accent); }
  .edge-label.ret { fill: var(--live); }
  .edge-label.rec { fill: var(--standby); }
  .edge-label.unbuilt { fill: var(--unbuilt); }

  @keyframes flowDash { from { stroke-dashoffset: 24; } to { stroke-dashoffset: 0; } }
  @media (prefers-reduced-motion: no-preference) {
    .mode-flow .edge-live-flow { stroke-dasharray: 8 4; animation: flowDash 1.8s linear infinite; }
    .mode-recovery .edge-rec { animation: flowDash 1.6s linear infinite; }
  }

  /* Node visual states: LIVE vs IDLE vs UNBUILT vs OFFLINE */
  .node { cursor: pointer; transition: opacity 180ms ease; }
  .node rect.box { fill: var(--surface); stroke: var(--border-strong); stroke-width: 1.8; rx: 7; }
  .node:hover rect.box { stroke: var(--accent); stroke-width: 2.5; }
  .node.is-selected rect.box { stroke: var(--accent); stroke-width: 3; }

  .node.state-live rect.box { stroke: var(--live); stroke-width: 2.2; }
  .node.state-standby rect.box { stroke: var(--standby); stroke-width: 2; }
  .node.state-offline rect.box { stroke: var(--offline); stroke-width: 2; }
  .node.state-unbuilt rect.box {
    fill: url(#unbuilt-hatch);
    stroke: var(--unbuilt);
    stroke-width: 1.6;
    stroke-dasharray: 5 3;
  }
  .node.state-unbuilt .n-title,
  .node.state-unbuilt .n-sub,
  .node.state-unbuilt .n-metric { fill: var(--unbuilt); }

  .node .n-kicker { font-family: var(--sans); font-size: 10px; font-weight: 600; fill: var(--text-dim); }
  .node .n-title { font-family: var(--sans); font-size: 14px; font-weight: 700; fill: var(--text); }
  .node .n-sub { font-family: var(--sans); font-size: 11px; fill: var(--text-dim); }
  .node .n-metric { font-family: var(--sans); font-size: 11.5px; font-weight: 600; fill: var(--text); }
  .node .chip-bg { rx: 4; }
  .node .chip-txt { font-family: var(--sans); font-size: 9.5px; font-weight: 700; }
  .node a.cf-link rect { fill: var(--accent-soft); stroke: var(--accent); stroke-width: 1.2; rx: 4; }
  .node a.cf-link text { font-family: var(--sans); font-size: 10px; font-weight: 650; fill: var(--accent); }
  .node a.cf-link:hover rect { fill: var(--accent); }
  .node a.cf-link:hover text { fill: var(--surface); }
  .cf-links-bar { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.5rem; }
  .cf-links-bar a {
    font-size: 0.92rem;
    font-weight: 600;
    color: var(--accent);
    background: var(--accent-soft);
    border: 1px solid var(--accent);
    border-radius: 6px;
    padding: 0.3rem 0.65rem;
    text-decoration: none;
  }
  .cf-links-bar a:hover { background: var(--accent); color: var(--surface); }
  .terms-drawer {
    display: none;
    background: var(--surface);
    border: 1px solid var(--accent);
    border-radius: 10px;
    padding: 1rem 1.15rem;
    margin-bottom: 1rem;
  }
  .terms-drawer.open { display: block; }
  .terms-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr)); gap: 0.8rem 1.2rem; font-size: 0.98rem; }
  .terms-grid dt { font-family: var(--mono); font-size: 0.95rem; font-weight: 700; color: var(--accent); }
  .terms-grid dd { margin: 0.2rem 0 0; color: var(--text-dim); }
  .inspect-box { border-top: 1px solid var(--border); padding-top: 0.85rem; margin-top: 0.35rem; }
  .inspect-controls { display: flex; gap: 0.5rem; margin-top: 0.5rem; flex-wrap: wrap; }
  .inspect-controls input {
    flex: 1 1 10rem;
    min-height: 2.75rem;
    font-family: var(--mono);
    font-size: 0.95rem;
    padding: 0.45rem 0.7rem;
    border-radius: 8px;
    border: 1px solid var(--border-strong);
    background: var(--surface-2);
    color: var(--text);
  }
  pre.term-dump {
    margin: 0.65rem 0 0;
    padding: 0.85rem;
    background: var(--term-bg);
    color: var(--term-fg);
    border: 1px solid var(--border);
    border-radius: 8px;
    font-family: var(--mono);
    font-size: 0.9rem;
    line-height: 1.5;
    max-height: 22rem;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .mode-flow .only-recovery { opacity: 0.16; }
  .mode-recovery .only-flow { opacity: 0.22; }
  .mode-lanes .only-recovery { opacity: 0.18; }

  aside.inspector {
    position: sticky;
    top: 1rem;
    max-height: calc(100vh - 2rem);
    overflow-y: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1.15rem;
    box-shadow: var(--shadow);
  }
  .ins-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.35rem; }
  .ins-kicker { font-size: 0.9rem; font-weight: 600; color: var(--text-dim); margin: 0; }
  .ins-title { margin: 0.2rem 0 0.45rem; font-size: 1.3rem; font-weight: 650; line-height: 1.3; }
  .ins-summary { margin: 0 0 0.85rem; font-size: 1rem; color: var(--text-dim); }
  .kv { border-top: 1px solid var(--border); padding: 0.75rem 0; }
  .kv-label { font-size: 0.92rem; font-weight: 650; color: var(--text-dim); margin-bottom: 0.3rem; }
  .kv-val { font-size: 1rem; color: var(--text); overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .kv-val code { font-family: var(--mono); font-size: 0.92em; background: var(--surface-2); padding: 0.08rem 0.35rem; border-radius: 4px; }
  ul.checklist { list-style: none; padding: 0; margin: 0.35rem 0 0; font-size: 0.98rem; }
  ul.checklist li { display: flex; gap: 0.5rem; padding: 0.2rem 0; }
  ul.checklist li.done { color: var(--text); }
  ul.checklist li.todo { color: var(--unbuilt); }
  ul.checklist .mark { font-family: var(--mono); font-weight: 700; width: 1rem; flex-shrink: 0; }
  ul.checklist li.done .mark { color: var(--live); }
</style>
</head>
<body>
<div class="shell">
  <header>
    <div>
      <div class="eyebrow">
        <span>FeedbackKit · Live System Dashboard</span>
        <span class="pill live" id="liveBadge"><span class="dot pulsing"></span>Live · 10s poll</span>
      </div>
      <h1>Feedback Loop — Mathematical Tree</h1>
      <p class="subtitle">Real telemetry from Worker D1 and <code>rex-runner</code>. Click any box to inspect live state and terminal output.</p>
    </div>
    <div class="controls">
      <a class="btn" href="https://systems-floorplan.pages.dev/">← Systems Home</a>
      <a class="btn worldview" href="/about/worldview">Mental Model (30s) →</a>
      <button class="btn" id="openInspectorBtn" type="button">Inspector</button>
      <button class="btn" id="termsBtn" type="button" aria-expanded="false">Terms</button>
      <button class="btn mode-btn" data-mode="flow" aria-pressed="true">1 · Flow</button>
      <button class="btn mode-btn" data-mode="recovery" aria-pressed="false">2 · Reboot</button>
      <button class="btn mode-btn" data-mode="lanes" aria-pressed="false">3 · Orca vs Rex</button>
      <div class="size-group" role="group" aria-label="Text size">
        <button class="btn size-btn" data-size="normal" aria-pressed="true" type="button">A</button>
        <button class="btn size-btn" data-size="large" aria-pressed="false" type="button">A+</button>
        <button class="btn size-btn" data-size="huge" aria-pressed="false" type="button">A++</button>
      </div>
      <button class="btn" id="refreshBtn" type="button">Refresh</button>
      <button class="btn" id="themeBtn" type="button">Theme</button>
    </div>
  </header>

  <section class="kpi-strip" aria-label="Live telemetry summary">
    <div class="kpi">
      <div class="kpi-label"><span>Worker D1</span><span class="pill live">LIVE</span></div>
      <div class="kpi-val" id="kpiChats">—</div>
      <div class="kpi-sub" id="kpiQueue">loading queue…</div>
    </div>
    <div class="kpi">
      <div class="kpi-label"><span>Orca (Python)</span><span class="pill standby" id="kpiOrcaPill">—</span></div>
      <div class="kpi-val" id="kpiOrcaVal">—</div>
      <div class="kpi-sub" id="kpiOrcaSub">untouched production lane</div>
    </div>
    <div class="kpi">
      <div class="kpi-label"><span>Rex (Go Binary)</span><span class="pill standby" id="kpiRexPill">—</span></div>
      <div class="kpi-val" id="kpiRexVal">—</div>
      <div class="kpi-sub" id="kpiRexSub">claim-apps: none (safe)</div>
    </div>
    <div class="kpi">
      <div class="kpi-label"><span>Fable 5.2 Tab 1</span><span class="pill standby" id="kpiFablePill">—</span></div>
      <div class="kpi-val" id="kpiFableVal">—</div>
      <div class="kpi-sub" id="kpiFableSub">inbox: — pending</div>
    </div>
    <div class="kpi">
      <div class="kpi-label"><span>Build Progress</span><span class="pill live" id="kpiBuildPct">—</span></div>
      <div class="kpi-val" id="kpiBuildVal">—</div>
      <div class="progress-bar"><div class="progress-fill" id="kpiBuildBar" style="width:0%"></div></div>
    </div>
  </section>

  <section class="terms-drawer" id="termsDrawer" aria-label="Glossary of system terms">
    <dl class="terms-grid" id="termsGrid"></dl>
  </section>

  <div class="legend">
    <span class="legend-item"><span class="swatch-box live"></span>Live (running, fresh heartbeat)</span>
    <span class="legend-item"><span class="swatch-box standby"></span>Idle (built, not running right now)</span>
    <span class="legend-item"><span class="swatch-box unbuilt"></span>Unbuilt (greyed out)</span>
    <span class="legend-item" id="lastUpdated">Syncing…</span>
  </div>

  <div class="workspace">
    <div class="canvas-frame">
      <svg id="tree" class="mode-flow" viewBox="0 0 920 715" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Live FeedbackKit mathematical tree">
        <defs>
          <pattern id="unbuilt-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="8" height="8" fill="var(--unbuilt-bg)"/>
            <line x1="0" y1="0" x2="0" y2="8" stroke="var(--unbuilt-hatch)" stroke-width="3"/>
          </pattern>
          <marker id="arr-fwd" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="var(--accent)"/>
          </marker>
          <marker id="arr-live" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="var(--live)"/>
          </marker>
          <marker id="arr-rec" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="var(--standby)"/>
          </marker>
          <marker id="arr-unbuilt" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="var(--unbuilt)"/>
          </marker>
        </defs>

        <!-- Rank guide lines -->
        <text class="rank-label" x="14" y="34">R0 · APPS</text>
        <line class="rank-rule" x1="14" y1="86" x2="906" y2="86"/>
        <text class="rank-label" x="14" y="108">R1 · WORKER</text>
        <line class="rank-rule" x1="14" y1="186" x2="906" y2="186"/>
        <text class="rank-label" x="14" y="208">R2 · RUNNERS</text>
        <line class="rank-rule" x1="14" y1="308" x2="906" y2="308"/>
        <text class="rank-label" x="14" y="330">R3 · COORDINATOR</text>
        <line class="rank-rule" x1="14" y1="494" x2="906" y2="494"/>
        <text class="rank-label" x="14" y="516">R4 · BUILDERS</text>

        <!-- Rex session dashed boundary -->
        <rect class="boundary" x="278" y="318" width="626" height="382"/>
        <text class="boundary-tag" id="rexBoundaryTag" x="292" y="336">REX SESSION: feedback-loop · OSC 7501 STATUS</text>

        <!-- R0 <-> R1 edges -->
        <path class="edge edge-fwd edge-live-flow only-flow" d="M 445 74 L 445 104" marker-end="url(#arr-fwd)"/>
        <path class="edge edge-ret edge-live-flow only-flow" d="M 475 104 L 475 74" marker-end="url(#arr-live)"/>
        <text class="edge-label fwd" x="342" y="93">POST /v2/feedback</text>
        <text class="edge-label ret" x="486" y="93">ACP live + APNs</text>

        <!-- R0 Menu Bar About (unbuilt) -> Worker /about -->
        <path class="edge edge-unbuilt" d="M 736 74 L 736 138 L 634 138" marker-end="url(#arr-unbuilt)"/>
        <text class="edge-label unbuilt" x="646" y="132">About link (unbuilt)</text>

        <!-- R1 -> R2 Orca (LIVE untouched) -->
        <path class="edge edge-orca edge-live-flow" d="M 405 172 L 405 196 L 146 196 L 146 218" marker-end="url(#arr-live)"/>
        <text class="edge-label ret" x="158" y="191">LIVE /runner/poll (untouched)</text>

        <!-- R1 -> R2 Go Rex Runner: claim edge (unbuilt/opt-in off) + live status push -->
        <path id="edgeWorkerRexClaim" class="edge edge-unbuilt" d="M 515 172 L 515 196 L 568 196 L 568 218" marker-end="url(#arr-unbuilt)"/>
        <path id="edgeRexPushStatus" class="edge edge-ret edge-live-flow" d="M 612 218 L 612 190 L 538 190 L 538 172" marker-end="url(#arr-live)"/>
        <text id="lblWorkerRexClaim" class="edge-label unbuilt" x="424" y="212">new chats: Orca (Rex off)</text>
        <text class="edge-label ret" x="622" y="193">POST /runner/rex-status</text>

        <!-- Orca lane R2 -> R3 -->
        <path class="edge edge-orca edge-live-flow" d="M 146 292 L 146 360" marker-end="url(#arr-live)"/>
        <text class="edge-label ret" x="50" y="332">orca worktree create</text>

        <!-- R2 Go Runner -> R3 Inbox -> Fable -->
        <path class="edge edge-fwd edge-live-flow" d="M 530 292 L 530 350 L 418 350 L 418 368" marker-end="url(#arr-fwd)"/>
        <text class="edge-label fwd" x="374" y="346">enqueue inbox.jsonl</text>
        <path class="edge edge-fwd edge-live-flow" d="M 500 414 L 542 414" marker-end="url(#arr-fwd)"/>
        <text class="edge-label fwd" x="503" y="406">drain</text>

        <!-- R2 Go Runner -> Reaper -->
        <path class="edge edge-rec" d="M 650 292 L 650 350 L 818 350 L 818 368" marker-end="url(#arr-rec)"/>
        <text class="edge-label rec" x="692" y="346">rex-runner reap</text>

        <!-- Recovery edge: launchd auto-boot (unbuilt) -->
        <path class="edge edge-unbuilt only-recovery" d="M 595 292 L 595 368" marker-end="url(#arr-unbuilt)"/>
        <text class="edge-label unbuilt only-recovery" x="602" y="344">launchd boot (unbuilt)</text>

        <!-- R3 Fable -> R4 Builders -->
        <path id="edgeSpawn1" class="edge edge-unbuilt" d="M 615 458 L 615 512 L 385 512 L 385 540" marker-end="url(#arr-unbuilt)"/>
        <path id="edgeSpawn2" class="edge edge-unbuilt" d="M 615 458 L 615 540" marker-end="url(#arr-unbuilt)"/>
        <path id="edgeSpawn3" class="edge edge-unbuilt" d="M 615 458 L 615 512 L 800 512 L 800 540" marker-end="url(#arr-unbuilt)"/>
        <text id="lblSpawn" class="edge-label unbuilt" x="458" y="507">rex-runner spawn (0 active)</text>

        <!-- R4 Builders -> Return bus -> Inbox (auto-report hook unbuilt) -->
        <path class="edge edge-unbuilt only-flow" d="M 385 638 L 385 672 L 800 672 L 800 638"/>
        <path class="edge edge-unbuilt only-flow" d="M 595 638 L 595 672"/>
        <path class="edge edge-unbuilt only-flow" d="M 385 672 L 306 672 L 306 414 L 336 414" marker-end="url(#arr-unbuilt)"/>
        <text class="edge-label unbuilt" x="424" y="688">builder auto-report hook (unbuilt · manual rex-runner report works)</text>

        <!-- NODES -->
        <!-- R0: Apps -->
        <g class="node state-live" data-id="apps" transform="translate(300, 14)">
          <rect class="box" width="320" height="60"/>
          <text class="n-kicker" x="12" y="17">R0 · CLIENT APPS (SDK)</text>
          <text class="n-title" x="12" y="35">Agent Pager · PR Hub · Trips</text>
          <text class="n-metric" id="nodeAppsMetric" x="12" y="51">Loading live app counts…</text>
          <rect class="chip-bg" x="268" y="6" width="42" height="15" fill="var(--live-soft)"/>
          <text class="chip-txt" x="277" y="17" fill="var(--live)">LIVE</text>
        </g>

        <!-- R0 Right: Menu Bar About Link (UNBUILT) -->
        <g class="node state-unbuilt" data-id="menubar_about" transform="translate(650, 14)">
          <rect class="box" width="212" height="60"/>
          <text class="n-kicker" x="12" y="17">R0 · MENU BAR ITEM</text>
          <text class="n-title" x="12" y="35">About → /about Link</text>
          <text class="n-sub" x="12" y="51">Not wired in MenuBar yet</text>
          <rect class="chip-bg" x="148" y="6" width="54" height="15" fill="var(--surface)"/>
          <text class="chip-txt" x="155" y="17" fill="var(--unbuilt)">UNBUILT</text>
        </g>

        <!-- R1: Worker -->
        <g class="node state-live is-selected" data-id="worker" transform="translate(290, 96)">
          <rect class="box" width="340" height="82"/>
          <text class="n-kicker" x="12" y="16">R1 · CLOUDFLARE WORKER</text>
          <text class="n-title" x="12" y="34">featurekit Worker + D1 + R2</text>
          <text class="n-metric" id="nodeWorkerMetric" x="12" y="51">Loading D1 telemetry…</text>
          <g id="nodeWorkerLinks" style="display:none">
            <a id="svgLinkWorker" class="cf-link" href="#" target="_blank" rel="noopener noreferrer">
              <rect x="12" y="59" width="66" height="16"/>
              <text x="19" y="70">Worker ↗</text>
            </a>
            <a id="svgLinkD1" class="cf-link" href="#" target="_blank" rel="noopener noreferrer">
              <rect x="84" y="59" width="44" height="16"/>
              <text x="93" y="70">D1 ↗</text>
            </a>
            <a id="svgLinkR2" class="cf-link" href="#" target="_blank" rel="noopener noreferrer">
              <rect x="134" y="59" width="44" height="16"/>
              <text x="143" y="70">R2 ↗</text>
            </a>
          </g>
          <rect class="chip-bg" x="288" y="6" width="42" height="15" fill="var(--live-soft)"/>
          <text class="chip-txt" x="297" y="17" fill="var(--live)">LIVE</text>
        </g>

        <!-- R2 Left: Orca Runner -->
        <g class="node state-standby" id="nodeOrcaRunner" data-id="orca_runner" transform="translate(32, 218)">
          <rect class="box" width="228" height="74"/>
          <text class="n-kicker" x="12" y="17">R2 · ORCA LANE (UNTOUCHED)</text>
          <text class="n-title" x="12" y="36">Orca Runner (Python)</text>
          <text class="n-metric" id="nodeOrcaMetric" x="12" y="54">Checking beat…</text>
          <text class="n-sub" x="12" y="67">runner.py · untouched</text>
          <rect class="chip-bg" id="chipOrcaBg" x="168" y="6" width="50" height="15" fill="var(--standby-soft)"/>
          <text class="chip-txt" id="chipOrcaTxt" x="175" y="17" fill="var(--standby)">WAIT</text>
        </g>

        <!-- R3 Left: Orca Worktrees -->
        <g class="node state-standby" id="nodeOrcaWorktrees" data-id="orca_worktrees" transform="translate(32, 360)">
          <rect class="box" width="228" height="94"/>
          <text class="n-kicker" x="12" y="17">ORCA WORKSTREAM</text>
          <text class="n-title" x="12" y="37">Per-chat Orca Worktrees</text>
          <text class="n-sub" x="12" y="55">fb-&lt;8hex&gt; · Claude Opus</text>
          <text class="n-sub" x="12" y="70">agentSession.send queue</text>
          <text class="n-sub" x="12" y="85">Protected while Rex iterates</text>
        </g>

        <!-- R2 Right: Go Rex Runner -->
        <g class="node state-standby" id="nodeGoRunner" data-id="go_runner" transform="translate(432, 218)">
          <rect class="box" width="316" height="74"/>
          <text class="n-kicker" x="12" y="17">R2 · REX LANE (GO BINARY)</text>
          <text class="n-title" x="12" y="36">rex-runner (Wake-up &amp; Bridge)</text>
          <text class="n-metric" id="nodeRexMetric" x="12" y="54">Checking Rex heartbeat…</text>
          <text class="n-sub" id="nodeRexSub" x="12" y="68">LaunchAgent daemon</text>
          <rect class="chip-bg" id="chipRexBg" x="260" y="6" width="46" height="15" fill="var(--standby-soft)"/>
          <text class="chip-txt" id="chipRexTxt" x="270" y="17" fill="var(--standby)">IDLE</text>
        </g>

        <!-- R3 Inside Rex: Inbox -->
        <g class="node state-standby" id="nodeInbox" data-id="inbox" transform="translate(336, 368)">
          <rect class="box" width="164" height="90"/>
          <text class="n-kicker" x="10" y="17">R3 · SERIALIZED FIFO</text>
          <text class="n-title" x="10" y="36">Coordinator Inbox</text>
          <text class="n-metric" id="nodeInboxMetric" x="10" y="54">0 pending</text>
          <text class="n-sub" x="10" y="70">inbox.jsonl + flock</text>
          <text class="n-sub" x="10" y="83">OSC 7501 gated drain</text>
          <rect class="chip-bg" id="chipInboxBg" x="116" y="6" width="40" height="15" fill="var(--standby-soft)"/>
          <text class="chip-txt" id="chipInboxTxt" x="124" y="17" fill="var(--standby)">IDLE</text>
        </g>

        <!-- R3 Inside Rex: Fable 5.2 -->
        <g class="node state-standby" id="nodeFable" data-id="fable" transform="translate(542, 368)">
          <rect class="box" width="194" height="90"/>
          <text class="n-kicker" x="10" y="17">R3 · TAB 1 (PINNED)</text>
          <text class="n-title" x="10" y="36">Fable 5.2 Coordinator</text>
          <text class="n-metric" id="nodeFableMetric" x="10" y="54">Checking Tab 1…</text>
          <text class="n-sub" x="10" y="70">Pinned UUID · rotatable</text>
          <text class="n-sub" x="10" y="83">Strict coord &amp; validator</text>
          <rect class="chip-bg" id="chipFableBg" x="142" y="6" width="44" height="15" fill="var(--standby-soft)"/>
          <text class="chip-txt" id="chipFableTxt" x="151" y="17" fill="var(--standby)">IDLE</text>
        </g>

        <!-- R3 Inside Rex: Reaper -->
        <g class="node state-standby" id="nodeReaper" data-id="reaper" transform="translate(754, 368)">
          <rect class="box" width="136" height="90"/>
          <text class="n-kicker" x="10" y="17">R3 · CLEANUP</text>
          <text class="n-title" x="10" y="36">Reaper / Kill</text>
          <text class="n-sub" x="10" y="54">rex-runner reap</text>
          <text class="n-sub" x="10" y="69">Clean git check</text>
          <text class="n-sub" x="10" y="83">Built · manual</text>
          <rect class="chip-bg" id="chipReaperBg" x="90" y="6" width="38" height="15" fill="var(--standby-soft)"/>
          <text class="chip-txt" id="chipReaperTxt" x="97" y="17" fill="var(--standby)">IDLE</text>
        </g>

        <!-- R4 Inside Rex: 3 Builder Slots (greyed out when 0 active, light up dynamically from live runs) -->
        <g class="node state-unbuilt" id="slot0" data-id="builder_slot_0" transform="translate(296, 540)">
          <rect class="box" width="184" height="98"/>
          <text class="n-kicker" id="slot0Kicker" x="10" y="17">R4 · SLOT 1 (EPHEMERAL)</text>
          <text class="n-title" id="slot0Title" x="10" y="36">App Builder Tab</text>
          <text class="n-metric" id="slot0Metric" x="10" y="54">No active Rex run</text>
          <text class="n-sub" id="slot0Sub1" x="10" y="70">Claude / Codex subfolder</text>
          <text class="n-sub" id="slot0Sub2" x="10" y="85">Auto-claim: UNBUILT</text>
          <rect class="chip-bg" id="slot0ChipBg" x="122" y="6" width="52" height="15" fill="var(--surface)"/>
          <text class="chip-txt" id="slot0ChipTxt" x="128" y="17" fill="var(--unbuilt)">UNBUILT</text>
        </g>

        <g class="node state-unbuilt" id="slot1" data-id="builder_slot_1" transform="translate(502, 540)">
          <rect class="box" width="190" height="98"/>
          <text class="n-kicker" id="slot1Kicker" x="10" y="17">R4 · SLOT 2 (EPHEMERAL)</text>
          <text class="n-title" id="slot1Title" x="10" y="36">Shared Kit Builder</text>
          <text class="n-metric" id="slot1Metric" x="10" y="54">No active Rex run</text>
          <text class="n-sub" id="slot1Sub1" x="10" y="70">FeedbackKit · DurableNet</text>
          <text class="n-sub" id="slot1Sub2" x="10" y="85">AgentChatKit · PRKit</text>
          <rect class="chip-bg" id="slot1ChipBg" x="128" y="6" width="52" height="15" fill="var(--surface)"/>
          <text class="chip-txt" id="slot1ChipTxt" x="134" y="17" fill="var(--unbuilt)">UNBUILT</text>
        </g>

        <g class="node state-unbuilt" id="slot2" data-id="builder_slot_2" transform="translate(712, 540)">
          <rect class="box" width="178" height="98"/>
          <text class="n-kicker" id="slot2Kicker" x="10" y="17">R4 · SLOT 3 (EPHEMERAL)</text>
          <text class="n-title" id="slot2Title" x="10" y="36">Antigravity Builder</text>
          <text class="n-metric" id="slot2Metric" x="10" y="54">Hooks installed · 0 runs</text>
          <text class="n-sub" id="slot2Sub1" x="10" y="70">rex-antigravity-hooks</text>
          <text class="n-sub" id="slot2Sub2" x="10" y="85">OSC 7501 ready</text>
          <rect class="chip-bg" id="slot2ChipBg" x="116" y="6" width="52" height="15" fill="var(--surface)"/>
          <text class="chip-txt" id="slot2ChipTxt" x="122" y="17" fill="var(--unbuilt)">UNBUILT</text>
        </g>
      </svg>
    </div>

    <div class="inspector-backdrop" id="inspectorBackdrop" aria-hidden="true"></div>
    <aside class="inspector" id="inspectorPanel" aria-live="polite">
      <div class="ins-head">
        <p class="ins-kicker" id="insKicker">R1 · Cloudflare Worker</p>
        <span class="pill live" id="insBadge">LIVE</span>
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
        <div class="kv-label">Build Checklist (Built vs Unbuilt)</div>
        <ul class="checklist" id="insChecklist"></ul>
      </div>
      <div class="kv">
        <div class="kv-label">Failure &amp; Reboot Recovery</div>
        <div class="kv-val" id="insRecovery"></div>
      </div>
      <div class="inspect-box" id="inspectBox">
        <div class="kv-label">Live Thread / Terminal Dump (Token-Gated)</div>
        <div class="inspect-controls" id="inspectAuthRow">
          <input type="password" id="inspectTokenInput" placeholder="Runner or Admin token…"/>
          <button class="btn" id="inspectUnlockBtn" type="button">Unlock</button>
          <button class="btn" id="inspectClearBtn" type="button" style="display:none">Lock</button>
        </div>
        <div class="kv-val" id="inspectMeta" style="margin-top:0.5rem;font-size:0.95rem;color:var(--text-dim)">Enter your runner token once (stored locally in this browser) to inspect live Rex panes and inbox events.</div>
        <pre class="term-dump" id="inspectDump" style="display:none"></pre>
      </div>
    </aside>
  </div>
</div>
<button class="btn inspector-dock" id="inspectorDock" type="button">Inspector: featurekit Worker</button>

<script>
let LATEST = null;
let INSPECT = null;
let SELECTED = "worker";
const TOKEN_KEY = "fk_about_inspect_token";

const ABOUT_TERMS = {
  runner: "Local Mac daemon (Python runner/ for Orca, Go rex-runner for Rex) bridging the Worker and your Mac.",
  agent: "The AI model coordinating or coding (Fable 5.2, Claude Opus, Codex, or Antigravity).",
  worker: "featurekit Cloudflare Worker storing chats (D1), media (R2), live rooms (DO), and this dashboard.",
  fable: "Claude Fable 5.2 in Tab 1 of Rex session feedback-loop — coordinates & validates, never edits app code directly.",
  inbox: "File-locked FIFO queue (inbox.jsonl) drained into Fable only when OSC 7501 reports idle/done.",
  reaper: "Deterministic cleanup (rex-runner reap) verifying clean git + pushed commits before closing tabs.",
  "OSC 7501": "Rex Program Status Protocol escape sequence reporting live idle/working/blocked/done/error states.",
  "run.json": "Per-chat manifest in each builder subfolder enabling exact session resume after reboot.",
  "/runner/agent": "Endpoint where the runner posts agent replies & working status to D1 so your phone updates live.",
  "/v2/acp": "AgentChatKit live streaming protocol pushing updates to iOS/macOS apps."
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

function fmtAge(sec) {
  if (sec === null || sec === undefined) return "never";
  if (sec < 60) return sec + "s ago";
  if (sec < 3600) return Math.floor(sec / 60) + "m ago";
  return Math.floor(sec / 3600) + "h ago";
}

function setNodeState(el, state) {
  if (!el) return;
  el.classList.remove("state-live", "state-standby", "state-offline", "state-unbuilt");
  el.classList.add("state-" + state);
}

function stateLabel(state) {
  if (state === "standby") return "IDLE";
  return state.toUpperCase();
}

function setPill(el, state, label) {
  if (!el) return;
  el.className = "pill " + state;
  el.textContent = label || stateLabel(state);
}

function setChip(bgEl, txtEl, state, label) {
  if (!bgEl || !txtEl) return;
  const styles = {
    live: ["var(--live-soft)", "var(--live)"],
    standby: ["var(--standby-soft)", "var(--standby)"],
    offline: ["var(--offline-soft)", "var(--offline)"],
    unbuilt: ["var(--surface)", "var(--unbuilt)"]
  };
  const [bg, fg] = styles[state] || styles.standby;
  bgEl.setAttribute("fill", bg);
  txtEl.setAttribute("fill", fg);
  txtEl.textContent = label;
}

function metaFor(id, data) {
  const w = data ? data.worker : null;
  const o = data ? data.orca : null;
  const r = data ? data.rex : null;
  const c = data ? data.components : {};
  const runs = r ? r.runs : [];

  const catalog = {
    apps: {
      kicker: "R0 · CLIENT APPS",
      title: "Agent Pager · PR Hub · Trips",
      state: c.apps || "live",
      summary: "Apps embedding FeedbackKit SDK. Owners trigger coding fixes; builders open PRs; everyone else files a GitHub issue.",
      live: w ? w.apps.map((a) => a.app + ": " + a.chats + " chat(s)").join(" · ") : "Loading…",
      checklist: [
        [true, "FeedbackKit SDK integrated in apps"],
        [true, "Live ACP updates + APNs push"],
        [false, "Route selected apps into Rex lane via --claim-apps"]
      ],
      recovery: "DurableNetworking buffers messages offline and replays idempotently via client_ref."
    },
    menubar_about: {
      kicker: "R0 · MENU BAR ITEM",
      title: "Menu Bar About → /about Link",
      state: c.menubar_about || "unbuilt",
      summary: "Menu bar entry that opens this live dashboard directly from macOS.",
      live: "Unbuilt — open this URL directly in browser for now.",
      checklist: [
        [true, "Live /about dashboard deployed on Worker"],
        [false, "Add About menu item in runner/MenuBar Swift app"],
        [false, "Release updated Menu Bar build"]
      ],
      recovery: "Stateless URL launcher; falls back to browser bookmark."
    },
    worker: {
      kicker: "R1 · CLOUDFLARE WORKER",
      title: "featurekit Worker + D1 + R2",
      state: c.worker || "live",
      summary: "Cloudflare Worker holding every app's chats, media, wake-up Durable Object, and this live dashboard API.",
      live: w ? (w.total_chats + " chats · " + w.pending_messages + " pending · " + w.delivering_messages + " delivering · " + w.failed_messages + " failed") : "Loading…",
      checklist: [
        [true, "D1 chats + messages + runner_beat live"],
        [true, "GET /about + GET /about/status.json live"],
        [true, "POST /runner/rex-status heartbeat ingest live"]
      ],
      recovery: "Stateless edge Worker over D1 & R2. Unclaimed messages wait safely until claimed."
    },
    orca_runner: {
      kicker: "R2 · ORCA LANE (UNTOUCHED)",
      title: "Orca Runner (Python)",
      state: c.orca_runner || "standby",
      summary: "Existing production Python runner kept 100% untouched while the Go Rex runner iterates in parallel.",
      live: o ? (o.online ? "ONLINE · last poll " + fmtAge(o.age_seconds) : "OFFLINE · last poll " + fmtAge(o.age_seconds)) : "Loading…",
      checklist: [
        [true, "Production LaunchAgent running"],
        [true, "Protected from rex-runner (--claim-apps empty by default)"]
      ],
      recovery: "launchd restarts automatically; claimed messages are journaled before delivery."
    },
    orca_worktrees: {
      kicker: "ORCA WORKSTREAM",
      title: "Per-Chat Orca Worktrees",
      state: c.orca_worktrees || "standby",
      summary: "Existing per-chat Orca worktrees continuing to serve live app feedback with zero disruption.",
      live: o && o.online ? "Active production workstream" : "Waiting on Orca runner heartbeat",
      checklist: [
        [true, "Per-chat worktree creation & 24h tidy live"],
        [true, "Untouched by Rex iteration"]
      ],
      recovery: "Messages queue while a builder host is offline and replay once Orca answers."
    },
    go_runner: {
      kicker: "R2 · REX LANE (GO BINARY)",
      title: "rex-runner (Go Binary)",
      state: c.go_runner || "standby",
      summary: "Nondestructive single Go binary for Rex session boot, serialized inbox drain, deterministic reap, and opt-in Worker claiming.",
      live: r && r.reported_at_ms
        ? ("Heartbeat " + fmtAge(r.age_seconds) + " · session " + r.session_name + " · claim_apps: " + (r.claim_apps.length ? r.claim_apps.join(", ") : "none (observe only)"))
        : "Binary installed; run rex-runner push-status or serve to report live.",
      checklist: [
        [true, "Go binary built & installed (boot, spawn, report, reply, drain, reap, serve)"],
        [true, "Worker /runner/rex-status + /runner/rex-inspect telemetry push"],
        [Boolean(r && r.connected), "macOS LaunchAgent keeping rex-runner serve alive"],
        [Boolean(r && r.claim_apps && r.claim_apps.length > 0), "Opt-in claim_apps routing enabled (Orca skips listed apps via rex-apps.json)"]
      ],
      recovery: "On boot, rex-runner boot ensures feedback-loop + Fable Tab 1 and resumes unfinished run.json builder folders."
    },
    inbox: {
      kicker: "R3 · SERIALIZED QUEUE",
      title: "Coordinator Inbox (FIFO)",
      state: c.inbox || "standby",
      summary: "File-locked append-only inbox.jsonl drained into Fable only when Rex OSC 7501 reports idle/done.",
      live: r ? (r.inbox_pending + " pending event(s) queued for Fable") : "Loading…",
      checklist: [
        [true, "Flocked inbox.jsonl + atomic cursor ack built in Go"],
        [true, "OSC 7501 stream watcher in rex-runner serve"],
        [false, "Continuous serve daemon running via LaunchAgent"]
      ],
      recovery: "Unacknowledged events stay on disk across crashes and drain cleanly once Fable returns to idle."
    },
    fable: {
      kicker: "R3 · TAB 1 (PINNED)",
      title: "Fable 5.2 Coordinator",
      state: c.fable || "standby",
      summary: "Strictly coordinates and validates across apps and shared kit repos from its own isolated folder.",
      live: r ? ((r.coordinator_active ? "Tab 1 ACTIVE" : "Tab 1 NOT REPORTED") + " · state: " + r.coordinator_state) : "Loading…",
      checklist: [
        [true, "Dedicated feedback-coordinator/ folder with pinned UUID start.sh"],
        [true, "Transcript folder symlinked across account profiles for rotation"],
        [true, "Running Fable 5.2 in Rex session feedback-loop Tab 1"],
        [false, "End-to-end Worker → Inbox → Fable → Builder test run"]
      ],
      recovery: "start.sh automatically runs --resume <pinned-uuid> after any restart or account rotation."
    },
    reaper: {
      kicker: "R3 · CLEANUP",
      title: "Deterministic Reaper",
      state: c.reaper || "standby",
      summary: "Verifies clean git status, zero unpushed commits, and idle TTL before closing finished Rex tabs.",
      live: r ? (r.runs.filter((x) => x.status === "reaped").length + " reaped · " + r.runs.filter((x) => x.status === "kept").length + " kept") : "Standby",
      checklist: [
        [true, "rex-runner reap subcommand + git safety tests built"],
        [false, "Periodic reap running continuously inside LaunchAgent serve"]
      ],
      recovery: "Never deletes dirty or unpushed folders — marks kept and notifies Fable."
    }
  };

  for (let i = 0; i < 3; i++) {
    const run = runs[i];
    const slotKey = "builder_slot_" + i;
    if (run) {
      catalog[slotKey] = {
        kicker: "R4 · LIVE BUILDER TAB " + (i + 2),
        title: run.chat_id + " (" + run.app + ")",
        state: run.status === "active" || run.status === "blocked" ? "live" : "standby",
        summary: "Isolated builder subfolder tracked by run.json inside Rex session feedback-loop.",
        live: "agent=" + run.agent + " · status=" + run.status + " · updated " + fmtAge(data ? Math.max(0, Math.floor((data.now_ms - run.updated_at_ms) / 1000)) : null),
        checklist: [
          [true, "Isolated folder + run.json manifest"],
          [true, "Dedicated Rex tab in feedback-loop"],
          [false, "Automatic builder-to-Fable stop hook calling rex-runner report"]
        ],
        recovery: "rex-runner boot reads run.json and resumes " + run.agent + " with its saved session ID."
      };
    } else {
      const titles = ["App Builder Slot", "Shared Kit Builder Slot", "Antigravity Builder Slot"];
      catalog[slotKey] = {
        kicker: "R4 · EPHEMERAL BUILDER SLOT " + (i + 1),
        title: titles[i],
        state: "unbuilt",
        summary: "No active Rex builder tab in this slot yet. Lights up automatically once rex-runner spawns a fb-xxxx run.",
        live: "0 active runs in this slot",
        checklist: [
          [true, "rex-runner spawn + run.json manifest format built"],
          [true, "rex-antigravity-hooks plugin published & installed"],
          [false, "First live feedback chat routed through Rex builder tab"],
          [false, "Automatic builder Stop hook calling rex-runner report"]
        ],
        recovery: "Each spawned run gets its own folder + run.json so reboots resume exact agent history."
      };
    }
  }
  return catalog[id] || catalog.worker;
}

function renderInspector() {
  const info = metaFor(SELECTED, LATEST);
  document.getElementById("insKicker").textContent = info.kicker;
  document.getElementById("insTitle").textContent = info.title;
  document.getElementById("inspectorDock").textContent = "Inspector: " + info.title;
  document.getElementById("openInspectorBtn").textContent = "Inspector: " + info.title;
  document.getElementById("insSummary").textContent = info.summary;
  document.getElementById("insLive").textContent = info.live;
  document.getElementById("insRecovery").textContent = info.recovery;
  setPill(document.getElementById("insBadge"), info.state, stateLabel(info.state));

  const linksBar = document.getElementById("insLinks");
  linksBar.innerHTML = "";
  const cfLinks = SELECTED === "worker" && LATEST && LATEST.worker ? LATEST.worker.links : null;
  if (cfLinks) {
    linksBar.style.display = "flex";
    for (const [label, url] of [["Cloudflare Worker ↗", cfLinks.worker], ["D1 (feedbackkit) ↗", cfLinks.d1], ["R2 (featurekit) ↗", cfLinks.r2]]) {
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
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
    li.innerHTML = '<span class="mark">' + (done ? "✓" : "○") + "</span><span>" + label + "</span>";
    ul.appendChild(li);
  }
  renderInspectDump();
}

function getInspectToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}

function renderInspectDump() {
  const token = getInspectToken();
  const input = document.getElementById("inspectTokenInput");
  const unlockBtn = document.getElementById("inspectUnlockBtn");
  const clearBtn = document.getElementById("inspectClearBtn");
  const meta = document.getElementById("inspectMeta");
  const dump = document.getElementById("inspectDump");
  if (!token) {
    input.style.display = "inline-block";
    unlockBtn.style.display = "inline-block";
    clearBtn.style.display = "none";
    dump.style.display = "none";
    meta.textContent = "Enter your runner token once (stored only in this browser) to inspect live Rex panes and inbox events.";
    return;
  }
  input.style.display = "none";
  unlockBtn.style.display = "none";
  clearBtn.style.display = "inline-block";
  if (!INSPECT) {
    meta.textContent = "Fetching live Rex terminal snapshot…";
    dump.style.display = "none";
    return;
  }
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
  if (SELECTED === "fable" || SELECTED === "go_runner" || SELECTED === "worker") {
    targetPane = (INSPECT.panes || []).find((p) => p.kind === "coordinator") || (INSPECT.panes || [])[0];
  } else if (SELECTED.startsWith("builder_slot_")) {
    const idx = Number(SELECTED.replace("builder_slot_", ""));
    const builders = (INSPECT.panes || []).filter((p) => p.kind !== "coordinator");
    targetPane = builders[idx] || null;
  }
  if (!targetPane) {
    meta.textContent = "No live terminal capture for this node yet (snapshot " + age + "). Click Fable 5.2 or an active builder slot.";
    dump.style.display = "none";
    return;
  }
  meta.textContent = "Live Rex pane: " + targetPane.label + " [" + targetPane.status + "] · captured " + age;
  dump.textContent = targetPane.capture || "(empty pane)";
  dump.style.display = "block";
}

async function pollInspect() {
  const token = getInspectToken();
  if (!token) { INSPECT = null; renderInspectDump(); return; }
  try {
    const res = await fetch("/about/inspect", { headers: { Authorization: "Bearer " + token }, cache: "no-store" });
    if (!res.ok) { INSPECT = { error: "HTTP " + res.status }; renderInspectDump(); return; }
    INSPECT = await res.json();
    renderInspectDump();
  } catch (err) {
    INSPECT = { error: err.message };
    renderInspectDump();
  }
}

document.getElementById("inspectUnlockBtn").addEventListener("click", () => {
  const val = document.getElementById("inspectTokenInput").value.trim();
  if (!val) return;
  try { localStorage.setItem(TOKEN_KEY, val); } catch {}
  document.getElementById("inspectTokenInput").value = "";
  pollInspect();
});
document.getElementById("inspectClearBtn").addEventListener("click", () => {
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
  INSPECT = null;
  renderInspectDump();
});

function applyStatus(data) {
  LATEST = data;
  const w = data.worker;
  const o = data.orca;
  const r = data.rex;
  const c = data.components;

  // Top KPI Strip
  document.getElementById("kpiChats").textContent = w.total_chats + " chats";
  document.getElementById("kpiQueue").textContent =
    w.pending_messages + " pending · " + w.delivering_messages + " delivering · " + w.failed_messages + " failed";

  setPill(document.getElementById("kpiOrcaPill"), c.orca_runner, o.online ? "LIVE" : "OFFLINE");
  document.getElementById("kpiOrcaVal").textContent = o.online ? "Online" : "Offline";
  document.getElementById("kpiOrcaSub").textContent = "last poll " + fmtAge(o.age_seconds);

  setPill(document.getElementById("kpiRexPill"), c.go_runner, r.connected ? "LIVE" : "IDLE");
  document.getElementById("kpiRexVal").textContent = r.connected ? "Running" : (r.reported_at_ms ? "Idle" : "No beat");
  document.getElementById("kpiRexSub").textContent =
    (r.reported_at_ms ? "beat " + fmtAge(r.age_seconds) : "awaiting daemon") + " · new chats: " + (r.claim_apps.length ? r.claim_apps.join(",") : "Orca");

  setPill(document.getElementById("kpiFablePill"), c.fable, r.coordinator_active ? (r.connected ? "LIVE" : "IDLE") : "OFFLINE");
  document.getElementById("kpiFableVal").textContent = r.coordinator_active ? r.coordinator_state : "offline";
  document.getElementById("kpiFableSub").textContent = "inbox: " + r.inbox_pending + " pending";

  // Build Progress
  const keys = Object.keys(c);
  const builtCount = keys.filter((k) => c[k] === "live" || c[k] === "standby").length;
  const liveCount = keys.filter((k) => c[k] === "live").length;
  const pct = Math.round((builtCount / keys.length) * 100);
  document.getElementById("kpiBuildPct").textContent = pct + "%";
  document.getElementById("kpiBuildVal").textContent = liveCount + " live · " + (builtCount - liveCount) + " idle · " + (keys.length - builtCount) + " unbuilt";
  document.getElementById("kpiBuildBar").style.width = pct + "%";

  // Node labels & live states
  document.getElementById("nodeAppsMetric").textContent =
    w.apps.map((a) => a.app + " (" + a.chats + ")").join(" · ") || "No apps configured";
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
  setChip(document.getElementById("chipOrcaBg"), document.getElementById("chipOrcaTxt"), c.orca_runner, o.online ? "LIVE" : "OFFLINE");

  setNodeState(document.getElementById("nodeGoRunner"), c.go_runner);
  document.getElementById("nodeRexMetric").textContent = r.reported_at_ms
    ? ("Beat " + fmtAge(r.age_seconds) + " · " + r.runs.length + " run(s)")
    : "Built · daemon not started";
  document.getElementById("nodeRexSub").textContent = r.connected
    ? ("LaunchAgent live · " + (r.claim_apps.length ? r.claim_apps.length + " apps" : "observe only"))
    : "LaunchAgent idle";
  setChip(document.getElementById("chipRexBg"), document.getElementById("chipRexTxt"), c.go_runner, r.connected ? "LIVE" : "IDLE");

  setNodeState(document.getElementById("nodeInbox"), c.inbox);
  document.getElementById("nodeInboxMetric").textContent = r.inbox_pending + " pending event(s)";
  setChip(document.getElementById("chipInboxBg"), document.getElementById("chipInboxTxt"), c.inbox, c.inbox === "live" ? "LIVE" : "IDLE");

  setNodeState(document.getElementById("nodeFable"), c.fable);
  document.getElementById("nodeFableMetric").textContent = r.coordinator_active
    ? ("Tab 1 ACTIVE · " + r.coordinator_state)
    : "Tab 1 not detected";
  setChip(document.getElementById("chipFableBg"), document.getElementById("chipFableTxt"), c.fable, r.coordinator_active ? (r.connected ? "LIVE" : "IDLE") : "OFF");

  setNodeState(document.getElementById("nodeReaper"), c.reaper);
  setChip(document.getElementById("chipReaperBg"), document.getElementById("chipReaperTxt"), c.reaper, c.reaper === "live" ? "LIVE" : "IDLE");

  document.getElementById("rexBoundaryTag").textContent =
    "REX SESSION: " + r.session_name + (r.session_active ? " (ACTIVE)" : " (OFFLINE)") + " · OSC 7501 STATUS";

  // Claim edge state
  const claimEdge = document.getElementById("edgeWorkerRexClaim");
  const claimLbl = document.getElementById("lblWorkerRexClaim");
  if (r.claim_apps.length > 0) {
    claimEdge.setAttribute("class", "edge edge-fwd edge-live-flow");
    claimEdge.setAttribute("marker-end", "url(#arr-fwd)");
    claimLbl.setAttribute("class", "edge-label fwd");
    claimLbl.textContent = "new chats: " + r.claim_apps.join(",");
  } else {
    claimEdge.setAttribute("class", "edge edge-unbuilt");
    claimEdge.setAttribute("marker-end", "url(#arr-unbuilt)");
    claimLbl.setAttribute("class", "edge-label unbuilt");
    claimLbl.textContent = "new chats: Orca (Rex off)";
  }

  // Dynamic R4 builder slots
  const activeCount = r.runs.filter((x) => x.status === "active" || x.status === "blocked").length;
  const spawnLbl = document.getElementById("lblSpawn");
  spawnLbl.textContent = activeCount > 0 ? ("rex-runner spawn (" + activeCount + " active)") : "rex-runner spawn (0 active)";
  spawnLbl.setAttribute("class", activeCount > 0 ? "edge-label fwd" : "edge-label unbuilt");

  for (let i = 0; i < 3; i++) {
    const slot = document.getElementById("slot" + i);
    const edge = document.getElementById("edgeSpawn" + (i + 1));
    const run = r.runs[i];
    if (run) {
      const st = run.status === "active" || run.status === "blocked" ? "live" : "standby";
      setNodeState(slot, st);
      edge.setAttribute("class", st === "live" ? "edge edge-fwd edge-live-flow" : "edge edge-rec");
      edge.setAttribute("marker-end", st === "live" ? "url(#arr-fwd)" : "url(#arr-rec)");
      document.getElementById("slot" + i + "Kicker").textContent = "R4 · TAB " + (i + 2) + " (" + run.app + ")";
      document.getElementById("slot" + i + "Title").textContent = run.chat_id;
      document.getElementById("slot" + i + "Metric").textContent = run.agent + " · " + run.status;
      document.getElementById("slot" + i + "Sub1").textContent = "updated " + fmtAge(Math.max(0, Math.floor((data.now_ms - run.updated_at_ms) / 1000)));
      document.getElementById("slot" + i + "Sub2").textContent = "run.json tracked";
      setChip(document.getElementById("slot" + i + "ChipBg"), document.getElementById("slot" + i + "ChipTxt"), st, run.status.toUpperCase());
    } else {
      setNodeState(slot, "unbuilt");
      edge.setAttribute("class", "edge edge-unbuilt");
      edge.setAttribute("marker-end", "url(#arr-unbuilt)");
      setChip(document.getElementById("slot" + i + "ChipBg"), document.getElementById("slot" + i + "ChipTxt"), "unbuilt", "UNBUILT");
    }
  }

  document.getElementById("lastUpdated").textContent = "Updated " + new Date(data.now_ms).toLocaleTimeString();
  renderInspector();
}

async function pollStatus() {
  try {
    const res = await fetch("/about/status.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    applyStatus(data);
  } catch (err) {
    document.getElementById("lastUpdated").textContent = "Sync error: " + err.message;
  }
}

const inspectorPanel = document.getElementById("inspectorPanel");
const inspectorBackdrop = document.getElementById("inspectorBackdrop");
function setDrawer(open) {
  inspectorPanel.classList.toggle("drawer-open", open);
  inspectorBackdrop.classList.toggle("open", open);
}
document.getElementById("openInspectorBtn").addEventListener("click", () => setDrawer(true));
document.getElementById("inspectorDock").addEventListener("click", () => setDrawer(true));
document.getElementById("closeInspectorBtn").addEventListener("click", () => setDrawer(false));
inspectorBackdrop.addEventListener("click", () => setDrawer(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") setDrawer(false); });

const SIZE_KEY = "fk_text_size";
function applySize(size) {
  const valid = size === "large" || size === "huge" ? size : "normal";
  if (valid === "normal") document.documentElement.removeAttribute("data-size");
  else document.documentElement.setAttribute("data-size", valid);
  document.querySelectorAll(".size-btn").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.size === valid)));
  try { localStorage.setItem(SIZE_KEY, valid); } catch {}
}
document.querySelectorAll(".size-btn").forEach((btn) => {
  btn.addEventListener("click", () => applySize(btn.dataset.size));
});
try { applySize(localStorage.getItem(SIZE_KEY) || "normal"); } catch {}

document.querySelectorAll(".node").forEach((n) => {
  n.addEventListener("click", (e) => {
    if (e.target && e.target.closest && e.target.closest("a")) return;
    SELECTED = n.dataset.id;
    document.querySelectorAll(".node").forEach((x) => x.classList.toggle("is-selected", x.dataset.id === SELECTED));
    renderInspector();
    if (window.matchMedia("(max-width: 1120px)").matches) setDrawer(true);
  });
});

document.querySelectorAll(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const svg = document.getElementById("tree");
    svg.classList.remove("mode-flow", "mode-recovery", "mode-lanes");
    svg.classList.add("mode-" + btn.dataset.mode);
    document.querySelectorAll(".mode-btn").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
  });
});

document.getElementById("refreshBtn").addEventListener("click", pollStatus);
document.getElementById("themeBtn").addEventListener("click", () => {
  const root = document.documentElement;
  const current = root.getAttribute("data-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.setAttribute("data-theme", current ? (current === "dark" ? "light" : "dark") : (prefersDark ? "light" : "dark"));
});

renderInspector();
pollStatus();
pollInspect();
setInterval(() => { pollStatus(); pollInspect(); }, 10000);
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
