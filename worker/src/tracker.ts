/**
 * Live Feedback Tracker (`GET /about/threads` and authenticated `GET /about/threads.json`).
 * Shows every app's feedback threads live as they come and go, with state, lane, shipped links,
 * expandable message history, and live Rex terminal captures.
 */

import type { StoredRexStatus } from "./about.ts";
import type { AppConfig, FeatureKitEnv } from "./featurekit.ts";
import { threadAgentState, type AgentSide } from "./feedback.ts";
import { parseShipped, type Shipped } from "./shipped.ts";

const REX_STATUS_KEY = "rex/status.json";
const ORCA_FRESH_MS = 90_000;
const REX_FRESH_MS = 120_000;
const MAX_THREADS = 150;
const MAX_MESSAGES_PER_THREAD = 14;
const MAX_MSG_TEXT = 1200;

export type TrackerThreadState = "needs_you" | "working" | "queued" | "failed" | "idle" | "ended";

export interface TrackerMessage {
  role: "user" | "agent";
  text: string;
  at: number | null;
  status?: string | null;
  images?: number;
}

export interface TrackerThread {
  id: string;
  app: string;
  title: string;
  sender: string;
  created_at: number;
  updated_at: number;
  state: TrackerThreadState;
  asks: boolean;
  activity: string | null;
  lane: "rex" | "orca" | "unclaimed";
  builder: {
    agent: string;
    status: string;
    updated_at_ms: number;
  } | null;
  shipped: Shipped | null;
  counts: {
    user: number;
    agent: number;
    pending: number;
    delivering: number;
    failed: number;
  };
  latest_preview: string;
  messages: TrackerMessage[];
}

export interface TrackerAppGroup {
  app: string;
  repo: string | null;
  lane_default: "rex" | "orca";
  total: number;
  needs_you: number;
  working: number;
  queued: number;
  failed: number;
  shipped: number;
  idle: number;
  threads: TrackerThread[];
}

interface ChatRow {
  id: string;
  app: string;
  login: string;
  title: string;
  created_at: number;
  sender_name: string | null;
  agent: string | null;
  thread_host: string | null;
  thread_id: string | null;
}

interface MsgRow {
  chat: string;
  id: string;
  at: number;
  text: string;
  images: number;
  status: string | null;
  detail: string | null;
}

interface BeatRow {
  at: number;
  orca: number;
}

function clipText(raw: string, max: number): string {
  const s = raw.trim();
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

const STATE_PRIORITY: Record<TrackerThreadState, number> = {
  needs_you: 0,
  working: 1,
  queued: 2,
  failed: 3,
  idle: 4,
  ended: 5,
};

/** Returns live per-app feedback threads merged with Orca + Rex runner telemetry. */
export async function aboutThreadsJsonResponse(
  env: FeatureKitEnv,
  apps: Record<string, AppConfig>,
  now: number,
): Promise<Response> {
  const [chatRows, msgRows, beatRow, rexObj] = await Promise.all([
    env.DB.prepare(
      "SELECT id, app, login, title, created_at, sender_name, agent, thread_host, thread_id " +
        "FROM chats WHERE kind = 'agent' ORDER BY created_at DESC LIMIT ?",
    )
      .bind(MAX_THREADS)
      .all<ChatRow>(),
    env.DB.prepare(
      "SELECT chat, id, at, text, images, status, detail FROM messages " +
        "WHERE status IS NULL OR status != 'removed' ORDER BY at ASC",
    ).all<MsgRow>(),
    env.DB.prepare("SELECT at, orca FROM runner_beat WHERE id = 1").first<BeatRow>(),
    env.FEEDBACK.get(REX_STATUS_KEY),
  ]);

  let rex: StoredRexStatus | null = null;
  if (rexObj) {
    try {
      rex = (await rexObj.json()) as StoredRexStatus;
    } catch {
      rex = null;
    }
  }
  const rexFresh = rex !== null && now - rex.reported_at_ms <= REX_FRESH_MS;
  const rexAgeSec = rex ? Math.max(0, Math.floor((now - rex.reported_at_ms) / 1000)) : null;
  const rexClaimSet = new Set(rex?.claim_apps ?? []);
  const rexRunByChat = new Map((rex?.runs ?? []).map((r) => [r.chat_id, r]));

  const orcaBeatMs = beatRow?.at ? Number(beatRow.at) : null;
  const orcaAgeSec = orcaBeatMs !== null ? Math.max(0, Math.floor((now - orcaBeatMs) / 1000)) : null;
  const orcaOnline = orcaBeatMs !== null && now - orcaBeatMs <= ORCA_FRESH_MS && beatRow?.orca === 1;

  const msgsByChat = new Map<string, MsgRow[]>();
  for (const m of msgRows.results ?? []) {
    const arr = msgsByChat.get(m.chat);
    if (arr) {
      arr.push(m);
    } else {
      msgsByChat.set(m.chat, [m]);
    }
  }

  const threadsByApp = new Map<string, TrackerThread[]>();
  for (const [slug, cfg] of Object.entries(apps)) {
    if (!cfg.echo) {
      threadsByApp.set(slug, []);
    }
  }

  for (const row of chatRows.results ?? []) {
    const appCfg = apps[row.app];
    if (appCfg?.echo) {
      continue;
    }
    let agent: AgentSide | null = null;
    if (row.agent) {
      try {
        agent = JSON.parse(row.agent) as AgentSide;
      } catch {
        agent = null;
      }
    }
    const userMsgs = msgsByChat.get(row.id) ?? [];
    let pending = 0;
    let delivering = 0;
    let failed = 0;
    let lastSentAt: number | null = null;
    let latestUserFailed = false;
    for (const m of userMsgs) {
      if (m.status === "pending") {
        pending++;
      } else if (m.status === "delivering") {
        delivering++;
      } else if (m.status === "failed") {
        failed++;
      }
      if (lastSentAt === null || m.at >= lastSentAt) {
        lastSentAt = m.at;
        latestUserFailed = m.status === "failed";
      }
    }

    const agentMsgs = Array.isArray(agent?.messages) ? agent.messages : [];
    let lastAgentAt: number | null = null;
    for (const am of agentMsgs) {
      const t = parseIsoMs(am.at);
      if (t !== null && (lastAgentAt === null || t > lastAgentAt)) {
        lastAgentAt = t;
      }
    }
    if (lastAgentAt === null && agentMsgs.length > 0 && typeof agent?.updatedAt === "number") {
      lastAgentAt = agent.updatedAt;
    }

    const waiting = pending > 0 || delivering > 0;
    const computed = threadAgentState(agent, lastSentAt, lastAgentAt, waiting);
    const rexRun = rexRunByChat.get(row.id) ?? null;

    let state: TrackerThreadState;
    if (agent?.ended) {
      state = "ended";
    } else if (computed.state === "needs_you") {
      state = "needs_you";
    } else if (computed.queued) {
      state = "queued";
    } else if (computed.state === "working" || rexRun?.status === "active") {
      state = "working";
    } else if (latestUserFailed && (lastAgentAt === null || (lastSentAt ?? 0) > lastAgentAt)) {
      state = "failed";
    } else {
      state = "idle";
    }

    let lane: "rex" | "orca" | "unclaimed";
    if (rexRun) {
      lane = "rex";
    } else if (row.thread_host || row.thread_id) {
      lane = "orca";
    } else if (rexClaimSet.has(row.app) && (agentMsgs.length > 0 || agent?.isWorking || !waiting)) {
      lane = "rex";
    } else if (!waiting && agentMsgs.length > 0) {
      lane = "orca";
    } else {
      lane = rexClaimSet.has(row.app) ? "rex" : "unclaimed";
    }

    const merged: TrackerMessage[] = [];
    for (const m of userMsgs) {
      merged.push({
        role: "user",
        text: clipText(m.text, MAX_MSG_TEXT),
        at: m.at,
        status: m.status,
        images: m.images || 0,
      });
    }
    for (const am of agentMsgs) {
      merged.push({
        role: "agent",
        text: clipText(am.text, MAX_MSG_TEXT),
        at: parseIsoMs(am.at) ?? (typeof agent?.updatedAt === "number" ? agent.updatedAt : null),
      });
    }
    merged.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    const recentMsgs = merged.slice(-MAX_MESSAGES_PER_THREAD);
    const lastMsg = recentMsgs.length > 0 ? recentMsgs[recentMsgs.length - 1] : null;

    const updatedAt = Math.max(
      Number(row.created_at) || 0,
      lastSentAt ?? 0,
      lastAgentAt ?? 0,
      typeof agent?.updatedAt === "number" ? agent.updatedAt : 0,
      rexRun?.updated_at_ms ?? 0,
    );

    const shipped = agent?.shipped ? (parseShipped(agent.shipped) ?? null) : null;
    const activity =
      computed.activity ??
      (rexRun?.status === "active"
        ? `Builder running (${rexRun.agent})`
        : rexRun?.status === "blocked"
          ? `Builder waiting (${rexRun.agent})`
          : state === "queued"
            ? "Queued for runner"
            : null);

    const thread: TrackerThread = {
      id: row.id,
      app: row.app,
      title: clipText(row.title || (userMsgs[0]?.text ?? row.id), 140),
      sender: row.sender_name || row.login,
      created_at: Number(row.created_at) || 0,
      updated_at: updatedAt,
      state,
      asks: computed.asks === true,
      activity,
      lane,
      builder: rexRun
        ? {
            agent: rexRun.agent,
            status: rexRun.status,
            updated_at_ms: rexRun.updated_at_ms,
          }
        : null,
      shipped,
      counts: {
        user: userMsgs.length,
        agent: agentMsgs.length,
        pending,
        delivering,
        failed,
      },
      latest_preview: lastMsg ? clipText(lastMsg.text.replace(/\s+/g, " "), 180) : "",
      messages: recentMsgs,
    };

    const list = threadsByApp.get(row.app);
    if (list) {
      list.push(thread);
    } else {
      threadsByApp.set(row.app, [thread]);
    }
  }

  const appGroups: TrackerAppGroup[] = [];
  for (const [slug, list] of threadsByApp.entries()) {
    list.sort((a, b) => {
      const p = STATE_PRIORITY[a.state] - STATE_PRIORITY[b.state];
      if (p !== 0) {
        return p;
      }
      return b.updated_at - a.updated_at;
    });
    let needsYou = 0;
    let working = 0;
    let queued = 0;
    let failed = 0;
    let shipped = 0;
    let idle = 0;
    for (const t of list) {
      if (t.state === "needs_you") needsYou++;
      else if (t.state === "working") working++;
      else if (t.state === "queued") queued++;
      else if (t.state === "failed") failed++;
      else idle++;
      if (t.shipped) shipped++;
    }
    appGroups.push({
      app: slug,
      repo: apps[slug]?.repo ?? null,
      lane_default: rexClaimSet.has(slug) ? "rex" : "orca",
      total: list.length,
      needs_you: needsYou,
      working,
      queued,
      failed,
      shipped,
      idle,
      threads: list,
    });
  }

  return Response.json(
    {
      now_ms: now,
      runners: {
        orca_online: orcaOnline,
        orca_age_seconds: orcaAgeSec,
        rex_connected: rexFresh,
        rex_age_seconds: rexAgeSec,
        coordinator_active: rex?.coordinator_active ?? false,
        coordinator_state: rex?.coordinator_state ?? "unknown",
        inbox_pending: rex?.inbox_pending ?? 0,
        claim_apps: rex?.claim_apps ?? [],
      },
      apps: appGroups,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

const TRACKER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>FeedbackKit — Live Feedback Tracker</title>
<style>
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
    --warn: #9a4a00;
    --warn-soft: rgba(154, 74, 0, 0.12);
    --err: #a8261c;
    --err-soft: rgba(168, 38, 28, 0.11);
    --muted: #7a7368;
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
      --warn: #f0b35a;
      --warn-soft: rgba(240, 179, 90, 0.15);
      --err: #ff9b8f;
      --err-soft: rgba(255, 155, 143, 0.15);
      --muted: #8e96a0;
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
    --warn: #f0b35a;
    --warn-soft: rgba(240, 179, 90, 0.15);
    --err: #ff9b8f;
    --err-soft: rgba(255, 155, 143, 0.15);
    --muted: #8e96a0;
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
    line-height: 1.6;
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
  .page {
    max-width: 62rem;
    margin: 0 auto;
    padding: 1.25rem max(1.1rem, env(safe-area-inset-right, 0px)) 4rem max(1.1rem, env(safe-area-inset-left, 0px));
    display: flex;
    flex-direction: column;
    gap: 1.1rem;
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 0.9rem;
    padding-bottom: 0.95rem;
    border-bottom: 1px solid var(--border);
  }
  .eyebrow {
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--text-dim);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.55rem;
  }
  h1 { margin: 0.3rem 0 0.2rem; font-size: 1.7rem; font-weight: 650; line-height: 1.25; }
  .subtitle { margin: 0; font-size: 1rem; color: var(--text-dim); }
  .nav { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .size-group {
    display: inline-flex;
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    overflow: hidden;
    background: var(--surface);
  }
  .size-group button.btn { border: none; border-right: 1px solid var(--border); border-radius: 0; padding: 0.45rem 0.7rem; }
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
    gap: 0.4rem;
  }
  button.btn:hover, a.btn:hover { border-color: var(--accent); color: var(--accent); }
  button.btn[aria-pressed="true"] {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 650;
  }

  .pill {
    font-size: 0.88rem;
    font-weight: 650;
    padding: 0.18rem 0.6rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    display: inline-flex;
    align-items: center;
    gap: 0.38rem;
    white-space: nowrap;
  }
  .pill.live { border-color: var(--live); color: var(--live); background: var(--live-soft); }
  .pill.warn { border-color: var(--warn); color: var(--warn); background: var(--warn-soft); }
  .pill.accent { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
  .pill.err { border-color: var(--err); color: var(--err); background: var(--err-soft); }
  .pill.muted { border-color: var(--border); color: var(--text-dim); background: var(--surface-2); }
  .dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; display: inline-block; background: currentColor; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  @media (prefers-reduced-motion: no-preference) { .dot.pulsing { animation: pulse 2.2s ease-in-out infinite; } }

  .health-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem 1.1rem;
    align-items: center;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0.75rem 1rem;
    font-size: 0.95rem;
    color: var(--text-dim);
  }
  .health-item { display: inline-flex; align-items: center; gap: 0.45rem; }
  .health-item strong { color: var(--text); font-weight: 650; }

  .filter-bar { display: flex; flex-direction: column; gap: 0.7rem; }
  .filter-group {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem 0.55rem;
    align-items: center;
  }
  .filter-label {
    font-size: 0.85rem;
    font-weight: 700;
    color: var(--text-dim);
    min-width: 3.4rem;
  }
  .filter-row { display: flex; flex-wrap: wrap; gap: 0.45rem; align-items: center; flex: 1; }
  button.app-btn {
    border-radius: 10px;
    font-weight: 600;
  }
  button.state-btn {
    border-radius: 999px;
    padding: 0.38rem 0.85rem;
    min-height: 2.5rem;
    background: var(--surface-2);
    border-color: var(--border);
  }
  button.state-btn[data-filter="needs_you"][aria-pressed="true"] {
    border-color: var(--warn);
    background: var(--warn-soft);
    color: var(--warn);
  }
  button.state-btn[data-filter="working"][aria-pressed="true"] {
    border-color: var(--live);
    background: var(--live-soft);
    color: var(--live);
  }
  button.state-btn[data-filter="shipped"][aria-pressed="true"] {
    border-color: var(--live);
    background: var(--live-soft);
    color: var(--live);
  }
  .search-input {
    flex: 1 1 14rem;
    min-height: 2.75rem;
    padding: 0.45rem 0.85rem;
    border-radius: 8px;
    border: 1px solid var(--border-strong);
    background: var(--surface);
    color: var(--text);
    font-family: var(--sans);
    font-size: 1rem;
  }

  .auth-box {
    display: none;
    background: var(--surface);
    border: 1px solid var(--warn);
    border-radius: 10px;
    padding: 1rem 1.15rem;
  }
  .auth-box.open { display: block; }
  .auth-row { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.6rem; }
  .auth-row input {
    flex: 1 1 14rem;
    min-height: 2.75rem;
    font-family: var(--mono);
    font-size: 0.95rem;
    padding: 0.45rem 0.75rem;
    border-radius: 8px;
    border: 1px solid var(--border-strong);
    background: var(--surface-2);
    color: var(--text);
  }

  .app-section { display: flex; flex-direction: column; gap: 0.75rem; }
  .app-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem 1rem;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid var(--border);
  }
  .app-title { margin: 0; font-size: 1.35rem; font-weight: 650; display: inline-flex; align-items: center; gap: 0.6rem; }
  .app-counts { display: flex; flex-wrap: wrap; gap: 0.45rem; font-size: 0.92rem; color: var(--text-dim); }

  .thread-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-left: 5px solid var(--border-strong);
    border-radius: 10px;
    box-shadow: var(--shadow);
    overflow: hidden;
    transition: border-color 180ms ease;
  }
  .thread-card.state-needs_you { border-left-color: var(--warn); }
  .thread-card.state-working { border-left-color: var(--live); }
  .thread-card.state-queued { border-left-color: var(--accent); }
  .thread-card.state-failed { border-left-color: var(--err); }
  .thread-card.changed-flash { border-color: var(--accent); }

  .thread-summary {
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    color: inherit;
    font: inherit;
    padding: 0.95rem 1.1rem;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }
  .thread-summary:hover { background: var(--surface-2); }
  .thread-top { display: flex; flex-wrap: wrap; align-items: center; gap: 0.45rem 0.6rem; }
  .thread-age { margin-left: auto; font-size: 0.92rem; color: var(--text-dim); font-variant-numeric: tabular-nums; }
  .thread-title { margin: 0; font-size: 1.15rem; font-weight: 650; line-height: 1.35; }
  .thread-activity { margin: 0; font-size: 0.98rem; color: var(--accent); font-weight: 600; }
  .thread-preview { margin: 0; font-size: 0.98rem; color: var(--text-dim); }
  .shipped-bar { display: flex; flex-wrap: wrap; gap: 0.45rem; margin-top: 0.2rem; }
  .shipped-chip {
    font-family: var(--mono);
    font-size: 0.88rem;
    padding: 0.18rem 0.55rem;
    border-radius: 6px;
    border: 1px solid var(--live);
    background: var(--live-soft);
    color: var(--live);
    text-decoration: none;
    font-weight: 600;
  }
  .shipped-chip:hover { background: var(--live); color: var(--surface); }

  .thread-detail {
    display: none;
    border-top: 1px solid var(--border);
    padding: 0.95rem 1.1rem 1.1rem;
    background: var(--surface-2);
    flex-direction: column;
    gap: 0.85rem;
  }
  .thread-card.is-open .thread-detail { display: flex; }
  .msg-list { display: flex; flex-direction: column; gap: 0.6rem; }
  .msg-bubble {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.65rem 0.85rem;
  }
  .msg-bubble.user { border-left: 4px solid var(--accent); }
  .msg-bubble.agent { border-left: 4px solid var(--live); }
  .msg-meta { display: flex; justify-content: space-between; gap: 0.6rem; font-size: 0.88rem; color: var(--text-dim); margin-bottom: 0.25rem; }
  .msg-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.98rem; }
  .term-head { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; font-size: 0.92rem; font-weight: 650; color: var(--text-dim); }
  pre.term-dump {
    margin: 0.4rem 0 0;
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
  .empty-state {
    background: var(--surface);
    border: 1px dashed var(--border-strong);
    border-radius: 10px;
    padding: 1.25rem;
    color: var(--text-dim);
  }
</style>
</head>
<body>
<main class="page">
  <header>
    <div>
      <div class="eyebrow">
        <span>FeedbackKit · Live Feedback Tracker</span>
        <span class="pill live" id="liveBadge"><span class="dot pulsing"></span>Live · 10s poll</span>
      </div>
      <h1>Live Feedback Threads by App</h1>
      <p class="subtitle">Every app's feedback threads live as they arrive, run, ask questions, and ship. Click any thread to read messages and its live Rex terminal.</p>
    </div>
    <nav class="nav">
      <a class="btn" href="https://systems-floorplan.pages.dev/">← Systems Home</a>
      <a class="btn" href="/about">← System Tree</a>
      <a class="btn" href="/about/worldview">Mental Model (30s)</a>
      <div class="size-group" role="group" aria-label="Text size">
        <button class="btn size-btn" data-size="normal" aria-pressed="true" type="button">A</button>
        <button class="btn size-btn" data-size="large" aria-pressed="false" type="button">A+</button>
        <button class="btn size-btn" data-size="huge" aria-pressed="false" type="button">A++</button>
      </div>
      <button class="btn" id="refreshBtn" type="button">Refresh</button>
      <button class="btn" id="themeBtn" type="button">Theme</button>
    </nav>
  </header>

  <section class="health-strip" id="healthStrip" aria-label="Runner health">
    <span class="health-item">Syncing live threads…</span>
  </section>

  <section class="auth-box" id="authBox" aria-label="Unlock live tracker">
    <strong>Sign in required for thread details</strong>
    <p class="subtitle">Behind Cloudflare Access this unlocks automatically. If opened outside Access, enter your runner token once (stored only in this browser).</p>
    <div class="auth-row">
      <input type="password" id="tokenInput" placeholder="Runner or Admin token…"/>
      <button class="btn" id="unlockBtn" type="button">Unlock</button>
    </div>
  </section>

  <section class="filter-bar" aria-label="Filters">
    <div class="filter-group">
      <span class="filter-label">Apps</span>
      <div class="filter-row" id="appTabs"></div>
    </div>
    <div class="filter-group">
      <span class="filter-label">Status</span>
      <div class="filter-row">
        <button class="btn state-btn" data-filter="live" aria-pressed="true" type="button">⚡ Live</button>
        <button class="btn state-btn" data-filter="needs_you" aria-pressed="false" type="button">🙋 Needs you</button>
        <button class="btn state-btn" data-filter="working" aria-pressed="false" type="button">⚙️ Working</button>
        <button class="btn state-btn" data-filter="shipped" aria-pressed="false" type="button">🚀 Shipped</button>
        <button class="btn state-btn" data-filter="all" aria-pressed="false" type="button">📋 All recent</button>
        <input class="search-input" id="searchInput" type="search" placeholder="🔍 Filter by title, chat ID, or text…"/>
      </div>
    </div>
  </section>

  <div id="trackerRoot"></div>
</main>

<script>
const TOKEN_KEY = "fk_about_inspect_token";
const SIZE_KEY = "fk_text_size";
let DATA = null;
let INSPECT = null;
let SELECTED_APP = "all";
let STATE_FILTER = "live";
let SEARCH_TEXT = "";
const OPEN_CHATS = new Set();
const PREV_SIGS = new Map();
const CHANGED_AT = new Map();

const hashMatch = /chat=(fb_[0-9a-f]+)/.exec(window.location.hash || "");
if (hashMatch) {
  OPEN_CHATS.add(hashMatch[1]);
  STATE_FILTER = "all";
}

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}

function authHeaders() {
  const t = getToken();
  return t ? { Authorization: "Bearer " + t } : {};
}

function fmtAge(ms) {
  if (!ms) return "—";
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return sec + "s ago";
  if (sec < 3600) return Math.floor(sec / 60) + "m ago";
  if (sec < 86400) return Math.floor(sec / 3600) + "h ago";
  return Math.floor(sec / 86400) + "d ago";
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const APP_META = {
  "agent-pager": { icon: "📟", name: "Agent Pager" },
  "prhub": { icon: "🔀", name: "PR Hub" },
  "trips": { icon: "✈️", name: "Trips" },
  "feedbackkit-demo": { icon: "🧪", name: "FeedbackKit Demo" }
};
function appLabel(slug) {
  const m = APP_META[slug];
  return m ? (m.icon + " " + m.name) : ("📦 " + slug);
}

function stateBadge(t) {
  if (t.state === "needs_you") return ['warn', t.asks ? '❓ Needs your answer' : '🙋 Needs you'];
  if (t.state === "working") return ['live', '⚙️ Working'];
  if (t.state === "queued") return ['accent', '⏳ Queued'];
  if (t.state === "failed") return ['err', '❌ Failed'];
  if (t.state === "ended") return ['muted', '🔒 Ended'];
  if (t.shipped && t.shipped.released) return ['live', '🚀 Released'];
  if (t.shipped) return ['accent', '✅ On main'];
  return ['muted', '💤 Idle'];
}

function matchesFilter(t) {
  if (STATE_FILTER === "live") {
    if (!(t.state === "working" || t.state === "queued" || t.state === "needs_you" || t.state === "failed")) return false;
  } else if (STATE_FILTER === "needs_you") {
    if (t.state !== "needs_you") return false;
  } else if (STATE_FILTER === "working") {
    if (!(t.state === "working" || t.state === "queued")) return false;
  } else if (STATE_FILTER === "shipped") {
    if (!t.shipped) return false;
  }
  if (SEARCH_TEXT) {
    const q = SEARCH_TEXT.toLowerCase();
    const hay = (t.id + " " + t.app + " " + t.title + " " + (t.activity || "") + " " + t.latest_preview).toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function findPaneForThread(t) {
  if (!INSPECT || !Array.isArray(INSPECT.panes)) return null;
  const exact = INSPECT.panes.find((p) => p.id === t.id);
  if (exact) return exact;
  if (t.lane === "rex") {
    return INSPECT.panes.find((p) => p.kind === "coordinator") || null;
  }
  return null;
}

function renderShipped(shipped) {
  if (!shipped) return "";
  const chips = [];
  for (const r of shipped.releases || []) {
    chips.push('<a class="shipped-chip" href="' + esc(r.url) + '" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">Release ' + esc(r.tag) + ' ↗</a>');
  }
  for (const p of shipped.prs || []) {
    chips.push('<a class="shipped-chip" href="' + esc(p.url) + '" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">PR #' + esc(p.number) + ' ↗</a>');
  }
  for (const c of shipped.commits || []) {
    chips.push('<a class="shipped-chip" href="' + esc(c.url) + '" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">' + esc(c.sha) + ' ↗</a>');
  }
  return chips.length ? '<div class="shipped-bar">' + chips.join("") + '</div>' : "";
}

function render() {
  if (!DATA) return;
  const r = DATA.runners;
  document.getElementById("healthStrip").innerHTML =
    '<span class="health-item"><span class="pill ' + (r.rex_connected ? 'live' : 'warn') + '">🦖 Rex ' + (r.rex_connected ? 'Live' : 'Idle') + '</span></span>' +
    '<span class="health-item">🧭 Fable: <strong>' + esc(r.coordinator_active ? r.coordinator_state : 'offline') + '</strong> (inbox ' + esc(r.inbox_pending) + ')</span>' +
    '<span class="health-item"><span class="pill ' + (r.orca_online ? 'live' : 'muted') + '">🐋 Orca ' + (r.orca_online ? 'Online' : 'Offline') + '</span></span>' +
    '<span class="health-item" style="margin-left:auto">Updated ' + new Date(DATA.now_ms).toLocaleTimeString() + '</span>';

  document.querySelectorAll(".state-btn").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.filter === STATE_FILTER)));

  // App tabs
  const tabsEl = document.getElementById("appTabs");
  const allLive = DATA.apps.reduce((n, a) => n + a.working + a.queued + a.needs_you + a.failed, 0);
  const allTotal = DATA.apps.reduce((n, a) => n + a.total, 0);
  let tabsHtml = '<button class="btn app-btn" data-app="all" aria-pressed="' + (SELECTED_APP === "all") + '" type="button">🌐 All Apps (' + allLive + ' live / ' + allTotal + ')</button>';
  for (const g of DATA.apps) {
    const active = g.working + g.queued + g.needs_you + g.failed;
    const badge = active > 0 ? (active + ' live') : (g.total + ' total');
    tabsHtml += '<button class="btn app-btn" data-app="' + esc(g.app) + '" aria-pressed="' + (SELECTED_APP === g.app) + '" type="button">' + esc(appLabel(g.app)) + ' (' + badge + ')</button>';
  }
  tabsEl.innerHTML = tabsHtml;
  tabsEl.querySelectorAll(".app-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      SELECTED_APP = btn.dataset.app;
      render();
    });
  });

  // Thread groups
  const root = document.getElementById("trackerRoot");
  const groups = SELECTED_APP === "all" ? DATA.apps : DATA.apps.filter((g) => g.app === SELECTED_APP);
  const now = Date.now();
  let html = "";
  let shownCount = 0;

  for (const g of groups) {
    const visible = g.threads.filter(matchesFilter).sort((a, b) => {
      if (a.asks !== b.asks) return a.asks ? -1 : 1;
      return 0;
    });
    if (visible.length === 0 && SELECTED_APP === "all") continue;
    shownCount += visible.length;
    html += '<section class="app-section">';
    html += '<div class="app-head">';
    html += '<h2 class="app-title">' + esc(appLabel(g.app)) + ' <span class="pill ' + (g.lane_default === 'rex' ? 'accent' : 'muted') + '">' + (g.lane_default === 'rex' ? '🦖 Rex / Fable' : '🐋 Orca') + '</span></h2>';
    html += '<div class="app-counts">' +
      (g.needs_you ? '<span class="pill warn">🙋 ' + g.needs_you + ' needs you</span>' : '') +
      (g.working ? '<span class="pill live">⚙️ ' + g.working + ' working</span>' : '') +
      (g.queued ? '<span class="pill accent">⏳ ' + g.queued + ' queued</span>' : '') +
      (g.failed ? '<span class="pill err">❌ ' + g.failed + ' failed</span>' : '') +
      '<span class="pill muted">' + g.total + ' total</span>' +
      '</div></div>';

    if (visible.length === 0) {
      html += '<div class="empty-state">No threads match the current filter for ' + esc(appLabel(g.app)) + '. Try switching to "📋 All recent".</div>';
    } else {
      for (const t of visible) {
        const [pillCls, pillTxt] = stateBadge(t);
        const isOpen = OPEN_CHATS.has(t.id);
        const recentlyChanged = CHANGED_AT.has(t.id) && (now - CHANGED_AT.get(t.id) < 25000);
        const laneLabel = t.builder ? ('🦖 Rex · ' + t.builder.agent + ' (' + t.builder.status + ')') : (t.lane === 'rex' ? '🧭 Rex · Fable' : t.lane === 'orca' ? '🐋 Orca' : '⏳ Queued');

        html += '<article class="thread-card state-' + esc(t.state) + (isOpen ? ' is-open' : '') + (recentlyChanged ? ' changed-flash' : '') + '" id="card-' + esc(t.id) + '">';
        html += '<button class="thread-summary" type="button" data-chat="' + esc(t.id) + '" aria-expanded="' + isOpen + '">';
        html += '<div class="thread-top">' +
          '<span class="pill ' + pillCls + '">' + (t.state === 'working' ? '<span class="dot pulsing"></span>' : '') + esc(pillTxt) + '</span>' +
          '<span class="pill muted">' + esc(laneLabel) + '</span>' +
          '<span class="pill muted">' + esc(t.id) + '</span>' +
          (recentlyChanged ? '<span class="pill accent">Updated just now</span>' : '') +
          '<span class="thread-age">' + esc(fmtAge(t.updated_at)) + '</span>' +
          '</div>';
        html += '<p class="thread-title">' + esc(t.title) + '</p>';
        if (t.activity) {
          html += '<p class="thread-activity">' + esc(t.activity) + '</p>';
        }
        if (t.latest_preview && t.latest_preview !== t.title) {
          html += '<p class="thread-preview">' + esc(t.latest_preview) + '</p>';
        }
        html += renderShipped(t.shipped);
        html += '</button>';

        if (isOpen) {
          html += '<div class="thread-detail">';
          html += '<div class="msg-list">';
          for (const m of t.messages) {
            const who = m.role === 'user' ? (t.sender || 'Jai') : 'Agent';
            const extra = m.status && m.status !== 'delivered' ? (' · ' + m.status) : '';
            html += '<div class="msg-bubble ' + m.role + '">' +
              '<div class="msg-meta"><strong>' + esc(who) + esc(extra) + '</strong><span>' + esc(fmtAge(m.at)) + '</span></div>' +
              '<p class="msg-text">' + esc(m.text) + '</p>' +
              '</div>';
          }
          html += '</div>';
          const pane = findPaneForThread(t);
          if (pane) {
            html += '<div><div class="term-head"><span>Live Rex Terminal: ' + esc(pane.label) + ' [' + esc(pane.status) + ']</span><span>Captured ' + esc(fmtAge(INSPECT.reported_at_ms)) + '</span></div>' +
              '<pre class="term-dump">' + esc(pane.capture || '(empty pane)') + '</pre></div>';
          }
          html += '</div>';
        }
        html += '</article>';
      }
    }
    html += '</section>';
  }

  if (shownCount === 0 && SELECTED_APP === "all") {
    html = '<div class="empty-state">No active or waiting threads right now. Switch to <strong>All recent</strong> to browse finished and shipped feedback across all apps.</div>';
  }
  root.innerHTML = html;
  root.querySelectorAll(".thread-summary").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.chat;
      if (OPEN_CHATS.has(id)) OPEN_CHATS.delete(id);
      else OPEN_CHATS.add(id);
      render();
    });
  });
}

async function poll() {
  if (document.hidden && DATA) return;
  try {
    const [res, insRes] = await Promise.all([
      fetch("/about/threads.json", { headers: authHeaders(), cache: "no-store" }),
      fetch("/about/inspect", { headers: authHeaders(), cache: "no-store" }).catch(() => null),
    ]);
    if (res.status === 401) {
      document.getElementById("authBox").classList.add("open");
      document.getElementById("healthStrip").innerHTML = '<span class="health-item">Sign in or enter token to load live threads.</span>';
      return;
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    document.getElementById("authBox").classList.remove("open");
    const next = await res.json();
    const now = Date.now();
    for (const g of next.apps || []) {
      for (const t of g.threads || []) {
        const sig = t.state + "|" + t.updated_at + "|" + (t.activity || "") + "|" + t.counts.agent + "|" + t.counts.user;
        if (PREV_SIGS.size > 0 && PREV_SIGS.get(t.id) !== sig) {
          CHANGED_AT.set(t.id, now);
        }
        PREV_SIGS.set(t.id, sig);
      }
    }
    DATA = next;
    if (insRes && insRes.ok) {
      INSPECT = await insRes.json();
    }
    render();
  } catch (err) {
    document.getElementById("healthStrip").innerHTML = '<span class="health-item">Sync error: ' + esc(err.message) + '</span>';
  }
}

document.querySelectorAll(".state-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    STATE_FILTER = btn.dataset.filter;
    render();
  });
});
document.getElementById("searchInput").addEventListener("input", (e) => {
  SEARCH_TEXT = e.target.value.trim();
  render();
});
document.getElementById("unlockBtn").addEventListener("click", () => {
  const val = document.getElementById("tokenInput").value.trim();
  if (!val) return;
  try { localStorage.setItem(TOKEN_KEY, val); } catch {}
  document.getElementById("tokenInput").value = "";
  poll();
});
document.getElementById("refreshBtn").addEventListener("click", poll);
document.getElementById("themeBtn").addEventListener("click", () => {
  const root = document.documentElement;
  const current = root.getAttribute("data-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.setAttribute("data-theme", current ? (current === "dark" ? "light" : "dark") : (prefersDark ? "light" : "dark"));
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

document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
poll();
setInterval(poll, 10000);
</script>
</body>
</html>
`;

export function aboutThreadsHtmlResponse(): Response {
  return new Response(TRACKER_HTML, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=60",
    },
  });
}
