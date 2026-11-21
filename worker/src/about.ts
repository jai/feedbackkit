/**
 * Static interactive architecture & flow preview (`GET /about`) for FeedbackKit's
 * Menu Bar About link. Renders a mathematical-tree view of the dual-lane setup
 * (existing Python/Orca runner untouched + parallel Go/Rex coordinator loop).
 */

const ABOUT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FeedbackKit — Architecture &amp; Request Flow</title>
<style>
  :root {
    --bg: #f6f8fb;
    --bg-grid: rgba(15, 23, 42, 0.055);
    --surface: #ffffff;
    --surface-2: #f1f5f9;
    --border: #cbd5e1;
    --border-strong: #64748b;
    --text: #0f172a;
    --text-dim: #475569;
    --accent: #1d4ed8;
    --accent-soft: rgba(29, 78, 216, 0.10);
    --ret: #047857;
    --ret-soft: rgba(4, 120, 87, 0.10);
    --warn: #b45309;
    --warn-soft: rgba(180, 83, 9, 0.12);
    --muted: #64748b;
    --muted-soft: rgba(100, 116, 139, 0.10);
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
    --sans: "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0b1120;
      --bg-grid: rgba(148, 163, 184, 0.08);
      --surface: #111827;
      --surface-2: #1e293b;
      --border: #334155;
      --border-strong: #94a3b8;
      --text: #f1f5f9;
      --text-dim: #94a3b8;
      --accent: #60a5fa;
      --accent-soft: rgba(96, 165, 250, 0.14);
      --ret: #34d399;
      --ret-soft: rgba(52, 211, 153, 0.14);
      --warn: #fbbf24;
      --warn-soft: rgba(251, 191, 36, 0.14);
      --muted: #94a3b8;
      --muted-soft: rgba(148, 163, 184, 0.12);
      --shadow: 0 10px 28px rgba(0, 0, 0, 0.40);
    }
  }
  :root[data-theme="dark"] {
    --bg: #0b1120;
    --bg-grid: rgba(148, 163, 184, 0.08);
    --surface: #111827;
    --surface-2: #1e293b;
    --border: #334155;
    --border-strong: #94a3b8;
    --text: #f1f5f9;
    --text-dim: #94a3b8;
    --accent: #60a5fa;
    --accent-soft: rgba(96, 165, 250, 0.14);
    --ret: #34d399;
    --ret-soft: rgba(52, 211, 153, 0.14);
    --warn: #fbbf24;
    --warn-soft: rgba(251, 191, 36, 0.14);
    --muted: #94a3b8;
    --muted-soft: rgba(148, 163, 184, 0.12);
    --shadow: 0 10px 28px rgba(0, 0, 0, 0.40);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: var(--sans);
    color: var(--text);
    background-color: var(--bg);
    background-image:
      linear-gradient(to right, var(--bg-grid) 1px, transparent 1px),
      linear-gradient(to bottom, var(--bg-grid) 1px, transparent 1px);
    background-size: 24px 24px;
    line-height: 1.45;
  }
  .shell {
    max-width: 1280px;
    margin: 0 auto;
    padding: 20px 24px 48px;
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }
  .eyebrow {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-dim);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .badge {
    font-family: var(--mono);
    font-size: 10px;
    padding: 2px 7px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-dim);
  }
  .badge.live-next { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
  h1 {
    margin: 6px 0 4px;
    font-size: 24px;
    font-weight: 650;
    letter-spacing: -0.02em;
  }
  .subtitle {
    margin: 0;
    font-size: 14px;
    color: var(--text-dim);
    max-width: 68ch;
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  button.mode-btn, button.theme-btn {
    font-family: var(--mono);
    font-size: 12px;
    padding: 7px 12px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    transition: border-color 140ms ease, background 140ms ease, color 140ms ease;
  }
  button.mode-btn:hover, button.theme-btn:hover { border-color: var(--border-strong); }
  button.mode-btn[aria-pressed="true"] {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    margin: 14px 0 12px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-dim);
  }
  .legend-item { display: inline-flex; align-items: center; gap: 6px; }
  .swatch { width: 18px; height: 2px; display: inline-block; }
  .swatch.fwd { background: var(--accent); }
  .swatch.ret { background: repeating-linear-gradient(90deg, var(--ret) 0 5px, transparent 5px 8px); }
  .swatch.rec { background: repeating-linear-gradient(90deg, var(--warn) 0 3px, transparent 3px 6px); }
  .swatch.orca { background: var(--muted); opacity: 0.65; }

  .workspace {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 330px;
    gap: 18px;
    align-items: start;
  }
  @media (max-width: 980px) {
    .workspace { grid-template-columns: 1fr; }
  }
  .canvas-frame {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow);
    overflow-x: auto;
    padding: 12px;
  }
  svg#tree {
    display: block;
    width: 100%;
    min-width: 780px;
    height: auto;
    user-select: none;
  }

  /* SVG blueprint styling */
  .rank-label {
    font-family: var(--mono);
    font-size: 10px;
    fill: var(--text-dim);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .rank-rule { stroke: var(--border); stroke-width: 1; stroke-dasharray: 2 4; opacity: 0.55; }
  .boundary {
    fill: none;
    stroke: var(--border-strong);
    stroke-width: 1.25;
    stroke-dasharray: 6 4;
    rx: 8;
  }
  .boundary-tag {
    font-family: var(--mono);
    font-size: 10px;
    fill: var(--text-dim);
  }
  .edge {
    fill: none;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: opacity 180ms ease, stroke-width 180ms ease;
  }
  .edge-fwd { stroke: var(--accent); }
  .edge-ret { stroke: var(--ret); stroke-dasharray: 6 4; }
  .edge-rec { stroke: var(--warn); stroke-dasharray: 3 4; }
  .edge-orca { stroke: var(--muted); opacity: 0.55; }
  .edge-label {
    font-family: var(--mono);
    font-size: 10px;
    fill: var(--text-dim);
    paint-order: stroke;
    stroke: var(--surface);
    stroke-width: 4px;
    stroke-linejoin: round;
  }
  .edge-label.fwd { fill: var(--accent); }
  .edge-label.ret { fill: var(--ret); }
  .edge-label.rec { fill: var(--warn); }

  @keyframes flowDash {
    from { stroke-dashoffset: 24; }
    to { stroke-dashoffset: 0; }
  }
  @media (prefers-reduced-motion: no-preference) {
    .mode-flow .edge-fwd.anim { stroke-dasharray: 8 4; animation: flowDash 1.4s linear infinite; }
    .mode-flow .edge-ret.anim { animation: flowDash 1.8s linear infinite; }
    .mode-recovery .edge-rec.anim { animation: flowDash 1.2s linear infinite; }
  }

  .node { cursor: pointer; transition: opacity 180ms ease; }
  .node rect.box {
    fill: var(--surface);
    stroke: var(--border-strong);
    stroke-width: 1.5;
    rx: 6;
    transition: stroke 140ms ease, fill 140ms ease, stroke-width 140ms ease;
  }
  .node:hover rect.box { stroke: var(--accent); stroke-width: 2; }
  .node.is-selected rect.box { stroke: var(--accent); stroke-width: 2.5; fill: var(--accent-soft); }
  .node.kind-root rect.box { stroke: var(--accent); stroke-width: 2; }
  .node.kind-coord rect.box { stroke: var(--accent); stroke-width: 2.2; }
  .node.kind-orca rect.box { stroke: var(--muted); stroke-dasharray: 4 3; }
  .node.kind-reaper rect.box { stroke: var(--warn); }
  .node .n-kicker {
    font-family: var(--mono);
    font-size: 9.5px;
    fill: var(--text-dim);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .node .n-title {
    font-family: var(--sans);
    font-size: 13px;
    font-weight: 650;
    fill: var(--text);
  }
  .node .n-sub {
    font-family: var(--mono);
    font-size: 10.5px;
    fill: var(--text-dim);
  }
  .node .chip-bg { rx: 3; }
  .node .chip-txt { font-family: var(--mono); font-size: 9px; font-weight: 600; }

  /* Mode dimming */
  .mode-flow .only-recovery { opacity: 0.15; }
  .mode-flow .lane-orca { opacity: 0.45; }
  .mode-recovery .only-flow { opacity: 0.22; }
  .mode-recovery .lane-orca { opacity: 0.28; }
  .mode-lanes .only-recovery { opacity: 0.18; }
  .mode-lanes .lane-orca { opacity: 1; }

  /* Inspector panel */
  aside.inspector {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    box-shadow: var(--shadow);
  }
  .ins-kicker {
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--accent);
    margin: 0 0 4px;
  }
  .ins-title {
    margin: 0 0 8px;
    font-size: 17px;
    font-weight: 650;
  }
  .ins-summary {
    margin: 0 0 14px;
    font-size: 13px;
    color: var(--text-dim);
  }
  .kv {
    border-top: 1px solid var(--border);
    padding: 10px 0;
  }
  .kv-label {
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim);
    margin-bottom: 3px;
  }
  .kv-val {
    font-size: 12.5px;
    color: var(--text);
    overflow-wrap: anywhere;
  }
  .kv-val code {
    font-family: var(--mono);
    font-size: 11.5px;
    background: var(--surface-2);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .live-preview-box {
    margin-top: 10px;
    padding: 10px 12px;
    border: 1px dashed var(--accent);
    border-radius: 6px;
    background: var(--accent-soft);
    font-size: 12px;
  }
  .live-preview-box strong {
    display: block;
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--accent);
    margin-bottom: 3px;
  }

  .strip {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    margin-top: 18px;
  }
  @media (max-width: 820px) {
    .strip { grid-template-columns: 1fr; }
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 16px;
  }
  .card h2 {
    margin: 0 0 6px;
    font-family: var(--mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim);
  }
  .card p { margin: 0; font-size: 13px; color: var(--text); }
  .card code { font-family: var(--mono); font-size: 11.5px; background: var(--surface-2); padding: 1px 4px; border-radius: 3px; }
</style>
</head>
<body>
<div class="shell">
  <header>
    <div>
      <div class="eyebrow">
        <span>FeedbackKit · System Blueprint</span>
        <span class="badge live-next">STATIC PREVIEW</span>
        <span class="badge">LIVE TELEMETRY NEXT</span>
      </div>
      <h1>Feedback Loop — Mathematical Tree</h1>
      <p class="subtitle">Rooted request hierarchy across apps, Cloudflare Worker, untouched Orca runner, and the new Go Rex runner coordinating Fable 5.2 and ephemeral builder tabs. Click any node to inspect state and recovery.</p>
    </div>
    <div class="controls" role="group" aria-label="Diagram view modes">
      <button class="mode-btn" data-mode="flow" aria-pressed="true">1 · Request Flow</button>
      <button class="mode-btn" data-mode="recovery" aria-pressed="false">2 · Failure &amp; Reboot</button>
      <button class="mode-btn" data-mode="lanes" aria-pressed="false">3 · Orca vs Rex</button>
      <button class="theme-btn" id="themeBtn" type="button" title="Toggle light/dark">Theme</button>
    </div>
  </header>

  <div class="legend">
    <span class="legend-item"><span class="swatch fwd"></span>Forward dispatch (request down tree)</span>
    <span class="legend-item"><span class="swatch ret"></span>Return feedback &amp; status (up tree)</span>
    <span class="legend-item"><span class="swatch rec"></span>Reboot / crash recovery &amp; reaper</span>
    <span class="legend-item"><span class="swatch orca"></span>Existing Orca lane (untouched)</span>
  </div>

  <div class="workspace">
    <div class="canvas-frame">
      <svg id="tree" class="mode-flow" viewBox="0 0 920 710" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Mathematical tree of FeedbackKit request flow">
        <defs>
          <marker id="arr-fwd" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="var(--accent)"/>
          </marker>
          <marker id="arr-ret" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="var(--ret)"/>
          </marker>
          <marker id="arr-rec" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="var(--warn)"/>
          </marker>
          <marker id="arr-orca" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="var(--muted)"/>
          </marker>
        </defs>

        <!-- Rank guide lines -->
        <text class="rank-label" x="14" y="34">R0 · APPS</text>
        <line class="rank-rule" x1="14" y1="84" x2="906" y2="84"/>
        <text class="rank-label" x="14" y="106">R1 · WORKER</text>
        <line class="rank-rule" x1="14" y1="184" x2="906" y2="184"/>
        <text class="rank-label" x="14" y="206">R2 · RUNNERS</text>
        <line class="rank-rule" x1="14" y1="304" x2="906" y2="304"/>
        <text class="rank-label" x="14" y="326">R3 · COORDINATOR</text>
        <line class="rank-rule" x1="14" y1="490" x2="906" y2="490"/>
        <text class="rank-label" x="14" y="512">R4 · BUILDERS</text>

        <!-- Rex session dashed boundary -->
        <rect class="boundary" x="278" y="316" width="626" height="378"/>
        <text class="boundary-tag" x="292" y="334">REX SESSION: feedback-loop (DEDICATED AUTOMATION BOUNDARY · OSC 7501 STATUS)</text>

        <!-- EDGES: R0 Apps <-> R1 Worker -->
        <path class="edge edge-fwd anim only-flow" d="M 445 72 L 445 104" marker-end="url(#arr-fwd)"/>
        <path class="edge edge-ret anim only-flow" d="M 475 104 L 475 72" marker-end="url(#arr-ret)"/>
        <text class="edge-label fwd" x="342" y="92">POST /v2/feedback</text>
        <text class="edge-label ret" x="486" y="92">ACP live + APNs</text>

        <!-- EDGES: R1 Worker -> R2 Runners (Orthogonal mathematical tree split) -->
        <!-- Left branch: Orca (untouched) -->
        <path class="edge edge-orca lane-orca" d="M 405 170 L 405 194 L 146 194 L 146 218" marker-end="url(#arr-orca)"/>
        <text class="edge-label lane-orca" x="160" y="190">existing /runner/poll (untouched)</text>

        <!-- Right branch: Go Rex Runner -->
        <path class="edge edge-fwd anim" d="M 515 170 L 515 194 L 580 194 L 580 218" marker-end="url(#arr-fwd)"/>
        <path class="edge edge-ret anim only-flow" d="M 610 218 L 610 188 L 535 188 L 535 170" marker-end="url(#arr-ret)"/>
        <text class="edge-label fwd" x="592" y="210">wait + claim</text>
        <text class="edge-label ret" x="620" y="191">POST /runner/agent</text>

        <!-- Orca lane continuation R2 -> R3/R4 -->
        <path class="edge edge-orca lane-orca" d="M 146 290 L 146 356" marker-end="url(#arr-orca)"/>
        <text class="edge-label lane-orca" x="52" y="330">orca worktree create</text>

        <!-- EDGES: R2 Go Runner -> R3 Inbox, Coordinator, Reaper -->
        <!-- Go Runner -> Serialized Inbox -> Fable -->
        <path class="edge edge-fwd anim" d="M 530 290 L 530 348 L 418 348 L 418 366" marker-end="url(#arr-fwd)"/>
        <text class="edge-label fwd" x="378" y="344">enqueue chat event</text>

        <path class="edge edge-fwd anim" d="M 500 412 L 542 412" marker-end="url(#arr-fwd)"/>
        <text class="edge-label fwd" x="503" y="404">drain</text>

        <!-- Go Runner -> Reaper -->
        <path class="edge edge-rec anim" d="M 650 290 L 650 348 L 818 348 L 818 366" marker-end="url(#arr-rec)"/>
        <text class="edge-label rec" x="688" y="344">reap timer / kill</text>

        <!-- Reboot recovery edge: Go Runner wake-up -> Fable & Builders -->
        <path class="edge edge-rec anim only-recovery" d="M 595 290 L 595 366" marker-end="url(#arr-rec)"/>
        <text class="edge-label rec only-recovery" x="602" y="342">boot: start.sh --resume</text>

        <!-- EDGES: R3 Fable <-> R4 Ephemeral Builder Tabs (Tree fan-out) -->
        <!-- Forward fan-out -->
        <path class="edge edge-fwd anim" d="M 615 456 L 615 510 L 385 510 L 385 538" marker-end="url(#arr-fwd)"/>
        <path class="edge edge-fwd anim" d="M 615 456 L 615 538" marker-end="url(#arr-fwd)"/>
        <path class="edge edge-fwd anim" d="M 615 456 L 615 510 L 800 510 L 800 538" marker-end="url(#arr-fwd)"/>
        <text class="edge-label fwd" x="468" y="505">spawn tab + brief (fb-xxxx)</text>

        <!-- Return feedback bus: Builders -> Serialized Inbox -> Fable -->
        <path class="edge edge-ret anim only-flow" d="M 385 636 L 385 668 L 800 668 L 800 636"/>
        <path class="edge edge-ret anim only-flow" d="M 595 636 L 595 668"/>
        <path class="edge edge-ret anim only-flow" d="M 385 668 L 306 668 L 306 412 L 336 412" marker-end="url(#arr-ret)"/>
        <text class="edge-label ret" x="452" y="683">rex-runner report &lt;chat&gt; (status / diff / PR / checks) → inbox → Fable validates</text>

        <!-- Recovery edges: Reaper -> Builders & run.json resume -->
        <path class="edge edge-rec anim only-recovery" d="M 852 456 L 852 538" marker-end="url(#arr-rec)"/>
        <text class="edge-label rec only-recovery" x="772" y="486">prune clean worktrees</text>

        <!-- NODES -->
        <!-- R0: Apps -->
        <g class="node" data-id="apps" transform="translate(310, 14)">
          <rect class="box" width="300" height="58"/>
          <text class="n-kicker" x="12" y="18">R0 · CLIENT APPS (FEEDBACKKIT SDK)</text>
          <text class="n-title" x="12" y="36">Agent Pager · PR Hub · Trips</text>
          <text class="n-sub" x="12" y="50">In-app chat · screenshots · videos · menu bar</text>
        </g>

        <!-- R1: Worker -->
        <g class="node kind-root is-selected" data-id="worker" transform="translate(290, 104)">
          <rect class="box" width="340" height="66"/>
          <text class="n-kicker" x="12" y="18">R1 · CLOUDFLARE WORKER (SOURCE OF TRUTH)</text>
          <text class="n-title" x="12" y="37">featurekit Worker + D1 + R2 + Live DO</text>
          <text class="n-sub" x="12" y="54">/v2/feedback · /runner/* · /about (this page)</text>
        </g>

        <!-- R2 Left: Orca Runner (Untouched) -->
        <g class="node kind-orca lane-orca" data-id="orca-runner" transform="translate(32, 218)">
          <rect class="box" width="228" height="72"/>
          <text class="n-kicker" x="12" y="18">R2 · LEGACY LANE (UNTOUCHED)</text>
          <text class="n-title" x="12" y="37">Orca Runner (Python)</text>
          <text class="n-sub" x="12" y="53">runner.py · launchd · live today</text>
          <rect class="chip-bg" x="148" y="6" width="70" height="16" fill="var(--muted-soft)"/>
          <text class="chip-txt" x="155" y="17" fill="var(--muted)">UNTOUCHED</text>
        </g>

        <!-- R3/R4 Left: Orca Worktrees -->
        <g class="node kind-orca lane-orca" data-id="orca-worktrees" transform="translate(32, 356)">
          <rect class="box" width="228" height="96"/>
          <text class="n-kicker" x="12" y="18">ORCA WORKSTREAM</text>
          <text class="n-title" x="12" y="38">Per-chat Orca Worktrees</text>
          <text class="n-sub" x="12" y="56">fb-&lt;8hex&gt; · Claude Opus 5.5</text>
          <text class="n-sub" x="12" y="72">Orca agentSession.send queue</text>
          <text class="n-sub" x="12" y="87">Keeps shipping while Rex iterates</text>
        </g>

        <!-- R2 Right: Go Rex Runner -->
        <g class="node kind-coord" data-id="go-runner" transform="translate(432, 218)">
          <rect class="box" width="316" height="72"/>
          <text class="n-kicker" x="12" y="18">R2 · NEW REX LANE (SINGLE GO BINARY)</text>
          <text class="n-title" x="12" y="37">rex-runner (Wake-up Loop &amp; Bridge)</text>
          <text class="n-sub" x="12" y="54">launchd · long-poll /runner/wait · run.json</text>
          <rect class="chip-bg" x="242" y="6" width="64" height="16" fill="var(--accent-soft)"/>
          <text class="chip-txt" x="250" y="17" fill="var(--accent)">GO BINARY</text>
        </g>

        <!-- R3 Inside Rex: Serialized Inbox -->
        <g class="node" data-id="inbox" transform="translate(336, 366)">
          <rect class="box" width="164" height="90"/>
          <text class="n-kicker" x="10" y="18">R3 · SERIALIZED QUEUE</text>
          <text class="n-title" x="10" y="38">Coordinator Inbox</text>
          <text class="n-sub" x="10" y="55">inbox.jsonl (FIFO)</text>
          <text class="n-sub" x="10" y="70">Waits for OSC 7501</text>
          <text class="n-sub" x="10" y="83">idle/done before send</text>
        </g>

        <!-- R3 Inside Rex: Fable 5.2 Coordinator -->
        <g class="node kind-coord" data-id="fable" transform="translate(542, 366)">
          <rect class="box" width="194" height="90"/>
          <text class="n-kicker" x="10" y="18">R3 · TAB 1 (PINNED)</text>
          <text class="n-title" x="10" y="38">Fable 5.2 Coordinator</text>
          <text class="n-sub" x="10" y="55">feedback-coordinator/</text>
          <text class="n-sub" x="10" y="70">Strict coord &amp; validator</text>
          <text class="n-sub" x="10" y="83">Pinned UUID · rotatable</text>
        </g>

        <!-- R3 Inside Rex: Deterministic Reaper -->
        <g class="node kind-reaper" data-id="reaper" transform="translate(754, 366)">
          <rect class="box" width="136" height="90"/>
          <text class="n-kicker" x="10" y="18">R3 · CLEANUP</text>
          <text class="n-title" x="10" y="38">Reaper / Kill</text>
          <text class="n-sub" x="10" y="55">rex-runner reap</text>
          <text class="n-sub" x="10" y="70">Clean git check</text>
          <text class="n-sub" x="10" y="83">Close tab + prune</text>
        </g>

        <!-- R4 Inside Rex: Ephemeral Builder Leaves -->
        <g class="node" data-id="builder-app" transform="translate(296, 538)">
          <rect class="box" width="184" height="98"/>
          <text class="n-kicker" x="10" y="18">R4 · TAB 2 (EPHEMERAL)</text>
          <text class="n-title" x="10" y="37">fb-1a2b · App Fix</text>
          <text class="n-sub" x="10" y="54">Claude Opus / Codex</text>
          <text class="n-sub" x="10" y="69">Repo: agent-pager / prhub</text>
          <text class="n-sub" x="10" y="85">Subfolder + run.json</text>
        </g>

        <g class="node" data-id="builder-kits" transform="translate(502, 538)">
          <rect class="box" width="190" height="98"/>
          <text class="n-kicker" x="10" y="18">R4 · TAB 3 (EPHEMERAL)</text>
          <text class="n-title" x="10" y="37">fb-9e8d · Shared Kit</text>
          <text class="n-sub" x="10" y="54">Claude / Codex</text>
          <text class="n-sub" x="10" y="69">FeedbackKit · DurableNet</text>
          <text class="n-sub" x="10" y="85">AgentChatKit · PRKit</text>
        </g>

        <g class="node" data-id="builder-agy" transform="translate(712, 538)">
          <rect class="box" width="178" height="98"/>
          <text class="n-kicker" x="10" y="18">R4 · TAB 4 (EPHEMERAL)</text>
          <text class="n-title" x="10" y="37">fb-4f5a · Antigravity</text>
          <text class="n-sub" x="10" y="54">agy + rex-antigravity-hooks</text>
          <text class="n-sub" x="10" y="69">OSC 7501 status native</text>
          <text class="n-sub" x="10" y="85">Own transcript + run.json</text>
        </g>
      </svg>
    </div>

    <aside class="inspector" aria-live="polite">
      <p class="ins-kicker" id="insKicker">R1 · CLOUDFLARE WORKER</p>
      <h2 class="ins-title" id="insTitle">featurekit Worker</h2>
      <p class="ins-summary" id="insSummary"></p>
      <div class="kv">
        <div class="kv-label">Runtime &amp; Location</div>
        <div class="kv-val" id="insRuntime"></div>
      </div>
      <div class="kv">
        <div class="kv-label">State &amp; Interfaces</div>
        <div class="kv-val" id="insState"></div>
      </div>
      <div class="kv">
        <div class="kv-label">Failure &amp; Reboot Recovery</div>
        <div class="kv-val" id="insRecovery"></div>
      </div>
      <div class="live-preview-box">
        <strong>Planned Live Telemetry</strong>
        <span id="insLive"></span>
      </div>
    </aside>
  </div>

  <section class="strip">
    <div class="card">
      <h2>Nondestructive Split</h2>
      <p>The existing Python Orca runner (<code>runner/</code>) stays untouched and keeps handling live feedback while the new Go binary (<code>rex-runner</code>) iterates in parallel.</p>
    </div>
    <div class="card">
      <h2>Per-Run Isolation &amp; Resume</h2>
      <p>Every builder runs in its own folder with <code>run.json</code> recording <code>{chat_id, repo, agent, session_id, rex_tab}</code> so a reboot resumes Claude, Codex, or Antigravity cleanly.</p>
    </div>
    <div class="card">
      <h2>Zero TTY Collisions</h2>
      <p>Builders never raw-type into Fable. Events append to <code>inbox.jsonl</code> and drain into Fable only when Rex OSC 7501 reports <code>idle</code> or <code>done</code>.</p>
    </div>
  </section>
</div>

<script>
const NODES = {
  apps: {
    kicker: "R0 · CLIENT APPS",
    title: "Agent Pager · PR Hub · Trips",
    summary: "iOS and macOS apps embedding FeedbackKit. Owners trigger coding agents that land changes; builders open PRs; everyone else opens a GitHub issue.",
    runtime: "SwiftUI apps + macOS Menu Bar app (which will link here via About).",
    state: "<code>POST /v2/feedback</code>, screenshot/video uploads to R2, live updates over <code>/v2/acp</code> and APNs.",
    recovery: "DurableNetworking queues unsent messages offline and retries idempotently via <code>client_ref</code>.",
    live: "Connected apps, unread feedback chats, and Menu Bar builder toggle status."
  },
  worker: {
    kicker: "R1 · CLOUDFLARE WORKER",
    title: "featurekit Worker",
    summary: "Single source of truth for all feedback chats, media attachments, delivery journals, and wake-up signals across every app.",
    runtime: "Cloudflare Worker + D1 (SQLite) + R2 (media) + Durable Objects (<code>RunnerWake</code>, <code>FeedbackLiveRoom</code>).",
    state: "<code>/v2/feedback</code>, <code>/runner/wait</code>, <code>/runner/poll</code>, <code>/runner/claim</code>, <code>/runner/agent</code>, and <code>GET /about</code>.",
    recovery: "Stateless edge compute backed by D1. Unclaimed messages remain pending until a runner claims and reports terminal outcome.",
    live: "Pending work queue depth, active long-poll waiters, and live node status payload feeding this page."
  },
  "orca-runner": {
    kicker: "R2 · LEGACY LANE (UNTOUCHED)",
    title: "Orca Runner (Python)",
    summary: "Existing production runner kept completely untouched while the new Go Rex runner is built and validated.",
    runtime: "Python LaunchAgent (<code>feedbackkit_runner.service</code>) driving paired Orca runtimes.",
    state: "<code>state.json</code>, <code>builders.json</code>, <code>status.json</code>.",
    recovery: "launchd restarts automatically; claimed messages are journaled before delivery.",
    live: "Live health dot, last tick timestamp, and active Orca chat count."
  },
  "orca-worktrees": {
    kicker: "ORCA WORKSTREAM",
    title: "Per-Chat Orca Worktrees",
    summary: "Existing per-chat worktrees (<code>fb-&lt;8hex&gt;</code>) running Claude Opus inside Orca. Continues serving live app feedback with zero disruption.",
    runtime: "Orca-managed git worktrees + Orca <code>agentSession.send</code> queue.",
    state: "Each chat pinned to its initial builder host; 24h idle tidy via <code>orca worktree rm</code>.",
    recovery: "Messages wait while a builder is offline and replay once Orca answers.",
    live: "Count of active Orca chats and last shipped commit status."
  },
  "go-runner": {
    kicker: "R2 · NEW REX LANE",
    title: "rex-runner (Go Binary)",
    summary: "New nondestructive Go binary implementing the wake-up loop, Worker polling, Rex session/tab orchestration, serialized inbox drain, and deterministic reaper.",
    runtime: "Compiled Go binary managed by launchd (separate from Python <code>runner/</code>).",
    state: "Holds <code>/runner/wait</code> long-poll, manages <code>run.json</code> manifests per feedback folder, calls <code>rex</code> CLI.",
    recovery: "On machine boot: ensures Rex session <code>feedback-loop</code> exists, resumes Tab 1 Fable via <code>start.sh</code>, and resumes any unfinished <code>fb-xxxx</code> tabs from their <code>run.json</code>.",
    live: "Binary version, uptime, wake-up loop latency, and active tab map."
  },
  inbox: {
    kicker: "R3 · SERIALIZED QUEUE",
    title: "Coordinator Inbox (FIFO)",
    summary: "Prevents concurrent builders or incoming chats from colliding inside Fable's terminal.",
    runtime: "Append-only local queue (<code>inbox.jsonl</code>) drained by <code>rex-runner</code>.",
    state: "Stores typed events: <code>new_chat</code>, <code>user_reply</code>, <code>builder_update</code>, <code>builder_blocked</code>, <code>reap_notice</code>.",
    recovery: "Persisted on disk with ack offsets; unacknowledged events survive crashes and drain once Fable returns to OSC 7501 <code>idle</code>/<code>done</code>.",
    live: "Queued event count, oldest waiting message age, and Fable's current OSC 7501 state."
  },
  fable: {
    kicker: "R3 · TAB 1 (PINNED)",
    title: "Fable 5.2 Coordinator",
    summary: "Strictly coordinates and validates across all apps and shared kit repos. Never edits app code directly; delegates fixes to ephemeral builder tabs and checks CI/tests before shipping.",
    runtime: "Claude Code (<code>claude-fable-5-2</code>) in dedicated <code>~/Developer/feedback-coordinator/</code>, Tab 1 of Rex session <code>feedback-loop</code>.",
    state: "Pinned UUID in <code>.session-id</code>; transcript directory symlinked across account profiles for clean rotation without losing context.",
    recovery: "<code>start.sh</code> detects existing transcript and runs <code>--resume &lt;uuid&gt;</code> automatically after any reboot or account switch.",
    live: "OSC 7501 status (<code>idle</code>/<code>working</code>/<code>blocked</code>), active account profile, and linked Rex block ID."
  },
  reaper: {
    kicker: "R3 · CLEANUP",
    title: "Deterministic Reaper / Kill",
    summary: "Closes finished Rex tabs and removes idle worktrees without relying on Fable's context window.",
    runtime: "Go subcommand (<code>rex-runner reap</code>) on a periodic ticker or triggered on demand by Fable.",
    state: "Reads each run's <code>run.json</code>, verifies clean <code>git status</code>, verifies zero unpushed commits, and checks idle TTL.",
    recovery: "Dirty or unpushed worktrees are never deleted — marked <code>kept</code> and surfaced back to Fable.",
    live: "Last sweep time, tabs reaped today, and worktrees held for uncommitted work."
  },
  "builder-app": {
    kicker: "R4 · EPHEMERAL BUILDER TAB",
    title: "fb-1a2b · App Fix",
    summary: "Isolated builder thread fixing app-level feedback (Agent Pager, PR Hub, or Trips) in its own worktree.",
    runtime: "Claude Opus or Codex in a dedicated Rex tab inside <code>feedback-loop</code>.",
    state: "Own subfolder + <code>run.json</code> (<code>{chat_id, repo, branch, agent, session_id, rex_block}</code>).",
    recovery: "If the machine restarts mid-build, <code>rex-runner</code> respawns the tab in the same folder with <code>--resume &lt;session_id&gt;</code>.",
    live: "Live branch name, OSC 7501 activity, and link to jump straight to the Rex tab."
  },
  "builder-kits": {
    kicker: "R4 · EPHEMERAL BUILDER TAB",
    title: "fb-9e8d · Shared Kit Fix",
    summary: "Builder thread routed by Fable when app feedback actually belongs in a shared Swift package (FeedbackKit, DurableNetworking, AgentChatKit, or PRKit).",
    runtime: "Claude Opus or Codex in a dedicated Rex tab; Fable sequences kit release → downstream app adoption.",
    state: "Own kit worktree + <code>run.json</code> linked back to parent <code>chat_id</code>.",
    recovery: "Resumes from kit worktree + pinned agent session ID; Fable tracks downstream adoption state.",
    live: "Target kit repo, CI status, and downstream adoption link."
  },
  "builder-agy": {
    kicker: "R4 · EPHEMERAL BUILDER TAB",
    title: "fb-4f5a · Antigravity Builder",
    summary: "Builder thread running Google Antigravity with <code>rex-antigravity-hooks</code> installed for Rex session awareness and native OSC 7501 status.",
    runtime: "<code>agy</code> CLI in a dedicated Rex tab with <code>rex-antigravity-hooks</code> plugin active.",
    state: "Own subfolder + Antigravity conversation ID saved in <code>run.json</code>.",
    recovery: "Resumes conversation in its subfolder on reboot; OSC 7501 reports <code>blocked</code> whenever user input is needed.",
    live: "Antigravity conversation ID, OSC 7501 state, and active tool summary."
  }
};

const svg = document.getElementById("tree");
const nodes = document.querySelectorAll(".node");
const modeBtns = document.querySelectorAll(".mode-btn");

function selectNode(id) {
  const info = NODES[id];
  if (!info) return;
  nodes.forEach((n) => n.classList.toggle("is-selected", n.dataset.id === id));
  document.getElementById("insKicker").textContent = info.kicker;
  document.getElementById("insTitle").textContent = info.title;
  document.getElementById("insSummary").textContent = info.summary;
  document.getElementById("insRuntime").innerHTML = info.runtime;
  document.getElementById("insState").innerHTML = info.state;
  document.getElementById("insRecovery").innerHTML = info.recovery;
  document.getElementById("insLive").innerHTML = info.live;
}

nodes.forEach((n) => n.addEventListener("click", () => selectNode(n.dataset.id)));

modeBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.mode;
    svg.classList.remove("mode-flow", "mode-recovery", "mode-lanes");
    svg.classList.add("mode-" + mode);
    modeBtns.forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
  });
});

document.getElementById("themeBtn").addEventListener("click", () => {
  const root = document.documentElement;
  const current = root.getAttribute("data-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const next = current ? (current === "dark" ? "light" : "dark") : (prefersDark ? "light" : "dark");
  root.setAttribute("data-theme", next);
});

selectNode("worker");
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
