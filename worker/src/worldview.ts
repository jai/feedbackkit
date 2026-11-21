/**
 * 1-screen cognitive reorientation & mental-model snapshot (`GET /about/worldview`),
 * linked from `/about`. Implements the jstack `worldview` playbook:
 * Endsley's 3-level Situation Awareness, Altmann & Trafton Memory for Goals,
 * Parnin & Rugaber Resumption Cues, and zero-exit inline hover/tap term definitions.
 */

const WORLDVIEW_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FeedbackKit — 30-Second Mental Model</title>
<style>
  :root {
    --bg: #f7f8fb;
    --grid: rgba(15, 23, 42, 0.045);
    --surface: #ffffff;
    --surface-2: #f1f5f9;
    --border: #cbd5e1;
    --border-strong: #64748b;
    --text: #0f172a;
    --text-dim: #475569;
    --accent: #1d4ed8;
    --accent-soft: rgba(29, 78, 216, 0.10);
    --live: #059669;
    --live-soft: rgba(5, 150, 105, 0.12);
    --idle: #b45309;
    --idle-soft: rgba(180, 83, 9, 0.12);
    --unbuilt: #94a3b8;
    --tip-bg: #0f172a;
    --tip-fg: #f8fafc;
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
    --sans: "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0b1120;
      --grid: rgba(148, 163, 184, 0.07);
      --surface: #111827;
      --surface-2: #1e293b;
      --border: #334155;
      --border-strong: #94a3b8;
      --text: #f1f5f9;
      --text-dim: #94a3b8;
      --accent: #60a5fa;
      --accent-soft: rgba(96, 165, 250, 0.14);
      --live: #34d399;
      --live-soft: rgba(52, 211, 153, 0.14);
      --idle: #fbbf24;
      --idle-soft: rgba(251, 191, 36, 0.14);
      --unbuilt: #64748b;
      --tip-bg: #f8fafc;
      --tip-fg: #0f172a;
    }
  }
  :root[data-theme="dark"] {
    --bg: #0b1120;
    --grid: rgba(148, 163, 184, 0.07);
    --surface: #111827;
    --surface-2: #1e293b;
    --border: #334155;
    --border-strong: #94a3b8;
    --text: #f1f5f9;
    --text-dim: #94a3b8;
    --accent: #60a5fa;
    --accent-soft: rgba(96, 165, 250, 0.14);
    --live: #34d399;
    --live-soft: rgba(52, 211, 153, 0.14);
    --idle: #fbbf24;
    --idle-soft: rgba(251, 191, 36, 0.14);
    --unbuilt: #64748b;
    --tip-bg: #f8fafc;
    --tip-fg: #0f172a;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: var(--sans);
    color: var(--text);
    background-color: var(--bg);
    background-image:
      linear-gradient(to right, var(--grid) 1px, transparent 1px),
      linear-gradient(to bottom, var(--grid) 1px, transparent 1px);
    background-size: 24px 24px;
    line-height: 1.4;
  }
  .page {
    max-width: 1180px;
    margin: 0 auto;
    padding: 16px 22px 24px;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    gap: 13px;
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
  }
  .title-wrap { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 20px; font-weight: 650; letter-spacing: -0.02em; }
  .tag {
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    padding: 2px 7px;
    border-radius: 4px;
    border: 1px solid var(--accent);
    color: var(--accent);
    background: var(--accent-soft);
  }
  .nav { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  a.btn, button.btn {
    font-family: var(--mono);
    font-size: 11.5px;
    padding: 6px 11px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    text-decoration: none;
    cursor: pointer;
  }
  a.btn:hover, button.btn:hover { border-color: var(--accent); color: var(--accent); }
  button.btn.primary, button.btn[aria-expanded="true"] {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }

  /* Inline hover/tap glossary terms */
  .term {
    border-bottom: 1px dotted var(--accent);
    cursor: help;
    color: var(--text);
    position: relative;
  }
  .term:focus { outline: 1px solid var(--accent); border-radius: 2px; }
  #termTip {
    position: fixed;
    z-index: 999;
    max-width: 310px;
    padding: 8px 11px;
    border-radius: 6px;
    background: var(--tip-bg);
    color: var(--tip-fg);
    font-size: 12px;
    line-height: 1.4;
    box-shadow: 0 8px 24px rgba(0,0,0,0.28);
    pointer-events: none;
    display: none;
  }
  #termTip strong { display: block; font-family: var(--mono); font-size: 10.5px; margin-bottom: 2px; opacity: 0.85; }

  /* Collapsible Terms drawer */
  .terms-drawer {
    display: none;
    background: var(--surface);
    border: 1px solid var(--accent);
    border-radius: 8px;
    padding: 12px 14px;
  }
  .terms-drawer.open { display: block; }
  .terms-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 8px 14px;
    font-size: 12px;
  }
  .terms-grid dt { font-family: var(--mono); font-size: 11px; font-weight: 700; color: var(--accent); }
  .terms-grid dd { margin: 2px 0 0; color: var(--text-dim); }

  .band {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 16px;
  }
  .band-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 10px;
  }
  .band-label {
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-dim);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .step-num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 4px;
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 700;
    font-size: 10px;
  }
  .band-note { font-family: var(--mono); font-size: 10.5px; color: var(--text-dim); }

  svg.spine { display: block; width: 100%; height: auto; }
  .sp-box { fill: var(--surface-2); stroke: var(--border-strong); stroke-width: 1.4; rx: 6; }
  .sp-box.live { stroke: var(--live); fill: var(--live-soft); }
  .sp-box.idle { stroke: var(--idle); fill: var(--idle-soft); }
  .sp-box.unbuilt { stroke: var(--unbuilt); stroke-dasharray: 4 3; fill: var(--surface); }
  .sp-title { font-family: var(--sans); font-size: 12.5px; font-weight: 650; fill: var(--text); }
  .sp-sub { font-family: var(--mono); font-size: 9.5px; fill: var(--text-dim); }
  .sp-arrow { stroke: var(--border-strong); stroke-width: 1.6; fill: none; }
  .sp-arrow.hot { stroke: var(--accent); }
  .sp-arrow.dim { stroke: var(--unbuilt); stroke-dasharray: 4 3; }

  .laws { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  @media (max-width: 820px) { .laws { grid-template-columns: 1fr; } }
  .law {
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 11px 13px;
    background: var(--surface);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .law-top { display: flex; align-items: baseline; gap: 8px; }
  .law-idx {
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 700;
    color: var(--accent);
    background: var(--accent-soft);
    padding: 1px 6px;
    border-radius: 3px;
  }
  .law h2 { margin: 0; font-size: 14px; font-weight: 650; letter-spacing: -0.01em; }
  .mech {
    font-family: var(--mono);
    font-size: 11px;
    background: var(--surface-2);
    border-radius: 5px;
    padding: 6px 9px;
    color: var(--text);
    overflow-x: auto;
    white-space: nowrap;
  }
  .mech .hi { color: var(--accent); font-weight: 600; }
  .mech .ok { color: var(--live); font-weight: 600; }
  .law p { margin: 0; font-size: 12.5px; color: var(--text-dim); }
  .law code { font-family: var(--mono); font-size: 11px; background: var(--surface-2); padding: 1px 4px; border-radius: 3px; color: var(--text); }

  .stack { display: grid; grid-template-columns: 1.15fr 1.2fr 1fr; gap: 10px; }
  @media (max-width: 860px) { .stack { grid-template-columns: 1fr; } }
  .col { border: 1px solid var(--border); border-radius: 7px; padding: 10px 12px; }
  .col.active { border-color: var(--accent); background: var(--accent-soft); }
  .col-title {
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-dim);
    margin: 0 0 6px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .col.active .col-title { color: var(--accent); font-weight: 700; }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .chip {
    font-family: var(--mono);
    font-size: 10.5px;
    padding: 2px 7px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
  }
  .chip.done { border-color: var(--live); color: var(--live); background: var(--live-soft); }
  .col p { margin: 0; font-size: 13px; }
  .col code { font-family: var(--mono); font-size: 11px; background: var(--surface); padding: 1px 4px; border-radius: 3px; }

  footer {
    margin-top: auto;
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 8px;
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--text-dim);
    padding-top: 4px;
  }
</style>
</head>
<body>
<div id="termTip" role="tooltip"></div>
<main class="page">
  <header>
    <div class="title-wrap">
      <h1>Feedback Loop — 30-Second Mental Model</h1>
      <span class="tag">Reorientation Snapshot</span>
    </div>
    <nav class="nav">
      <a class="btn" href="/about">← Live System Tree</a>
      <button class="btn" id="termsBtn" type="button" aria-expanded="false">Terms</button>
      <button class="btn primary" id="copyBtn" type="button">Copy Resume Prompt</button>
      <button class="btn" id="themeBtn" type="button">Theme</button>
    </nav>
  </header>

  <section class="terms-drawer" id="termsDrawer" aria-label="Glossary of system terms">
    <dl class="terms-grid" id="termsGrid"></dl>
  </section>

  <!-- LEVEL 1: WHAT IS HERE -->
  <section class="band" aria-label="Level 1: What is here">
    <div class="band-head">
      <div class="band-label"><span class="step-num">1</span>What Is Here · Spatial Anchor</div>
      <span class="band-note" id="liveSummary">Syncing live status…</span>
    </div>
    <svg class="spine" viewBox="0 0 1120 112" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Five-node spatial spine of the Feedback Loop">
      <defs>
        <marker id="a-hot" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="var(--accent)"/>
        </marker>
        <marker id="a-dim" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="var(--unbuilt)"/>
        </marker>
      </defs>

      <rect class="sp-box live" x="6" y="24" width="176" height="62"/>
      <text class="sp-title" x="18" y="48">Apps (SDK)</text>
      <text class="sp-sub" id="spApps" x="18" y="66">Agent Pager · PR Hub · Trips</text>

      <path class="sp-arrow hot" d="M 182 55 L 222 55" marker-end="url(#a-hot)"/>

      <rect class="sp-box live" x="226" y="24" width="194" height="62"/>
      <text class="sp-title" x="238" y="48">featurekit Worker</text>
      <text class="sp-sub" id="spWorker" x="238" y="66">1 D1 queue · R2 · ACP live</text>

      <path class="sp-arrow hot" d="M 420 44 L 468 28" marker-end="url(#a-hot)"/>
      <path class="sp-arrow dim" id="spRexEdge" d="M 420 66 L 468 82" marker-end="url(#a-dim)"/>

      <rect class="sp-box live" id="spOrcaBox" x="472" y="4" width="196" height="46"/>
      <text class="sp-title" x="484" y="24">Orca (Python · Live)</text>
      <text class="sp-sub" id="spOrca" x="484" y="40">Untouched · owns new chats</text>

      <rect class="sp-box idle" id="spRexBox" x="472" y="60" width="196" height="46"/>
      <text class="sp-title" x="484" y="80">rex-runner (Go)</text>
      <text class="sp-sub" id="spRex" x="484" y="96">Daemon · live inspect</text>

      <path class="sp-arrow hot" d="M 668 83 L 708 83" marker-end="url(#a-hot)"/>

      <rect class="sp-box idle" id="spFableBox" x="712" y="54" width="184" height="54"/>
      <text class="sp-title" x="724" y="76">Fable 5.2 (Tab 1)</text>
      <text class="sp-sub" id="spFable" x="724" y="94">Coordinates &amp; validates</text>

      <path class="sp-arrow dim" id="spBuildEdge" d="M 896 81 L 932 81" marker-end="url(#a-dim)"/>

      <rect class="sp-box unbuilt" id="spBuildBox" x="936" y="54" width="178" height="54"/>
      <text class="sp-title" x="948" y="76">Builder Tabs</text>
      <text class="sp-sub" id="spBuild" x="948" y="94">Subfolder + run.json (0)</text>
    </svg>
  </section>

  <!-- LEVEL 2: HOW THIS WORLD WORKS -->
  <section class="band" aria-label="Level 2: How this world works">
    <div class="band-head">
      <div class="band-label"><span class="step-num">2</span>How This World Works · 4 Laws</div>
      <span class="band-note">Hover or tap any dotted term for its definition</span>
    </div>
    <div class="laws">
      <article class="law">
        <div class="law-top"><span class="law-idx">LAW 1</span><h2>FeedbackKit chats are not Agent Pager threads</h2></div>
        <div class="mech"><span class="term" tabindex="0" data-term="runner">Runner</span> <span class="hi"><span class="term" tabindex="0" data-term="/runner/agent">POST /runner/agent</span></span> → <span class="term" tabindex="0" data-term="worker">Worker</span> D1 → <span class="ok"><span class="term" tabindex="0" data-term="/v2/acp">AgentChatKit /v2/acp</span></span> → Phone</div>
        <p>Your phone displays whatever the <span class="term" tabindex="0" data-term="runner">runner</span> pushes for the <span class="term" tabindex="0" data-term="agent">agent</span>. One feedback chat can fan out across 4 repos or background builders with zero Agent Pager dependency.</p>
      </article>

      <article class="law">
        <div class="law-top"><span class="law-idx">LAW 2</span><h2>One Worker queue, two isolated lanes</h2></div>
        <div class="mech">D1 queue → <span class="ok">Orca Python (untouched)</span> | <span class="hi">Rex Go (config.json switch)</span></div>
        <p>Whichever <span class="term" tabindex="0" data-term="runner">runner</span> calls <code>/runner/claim</code> first owns the message. Keep <code>claim_apps</code> empty while testing; flip Orca's Menu Bar "New chats" off + opt apps in to route new chats to <span class="term" tabindex="0" data-term="fable">Fable</span>.</p>
      </article>

      <article class="law">
        <div class="law-top"><span class="law-idx">LAW 3</span><h2>Fable coordinates; isolated subfolders build</h2></div>
        <div class="mech"><span class="hi">Tab 1 <span class="term" tabindex="0" data-term="fable">Fable</span></span> (pinned UUID) ⇄ <span class="ok">fb-xxxx/<span class="term" tabindex="0" data-term="run.json">run.json</span></span> (Claude · Codex · Agy)</div>
        <p><span class="term" tabindex="0" data-term="fable">Fable</span> stays strictly coordinator/validator in its own folder (symlinked transcripts across accounts). Each builder <span class="term" tabindex="0" data-term="agent">agent</span> keeps its own folder and <span class="term" tabindex="0" data-term="run.json">run.json</span> for reboot resume.</p>
      </article>

      <article class="law">
        <div class="law-top"><span class="law-idx">LAW 4</span><h2>FIFO inbox prevents TTY collisions; reaper cleans safely</h2></div>
        <div class="mech">Builder → <span class="term" tabindex="0" data-term="inbox"><code>inbox.jsonl</code></span> → <span class="hi"><span class="term" tabindex="0" data-term="osc7501">OSC 7501</span> idle</span> → <span class="term" tabindex="0" data-term="fable">Fable</span> · <span class="ok"><span class="term" tabindex="0" data-term="reaper">reaper</span></span> checks git</div>
        <p>Builders report into <span class="term" tabindex="0" data-term="inbox"><code>inbox.jsonl</code></span> instead of typing directly into <span class="term" tabindex="0" data-term="fable">Fable</span>'s terminal. Events drain only on <span class="term" tabindex="0" data-term="osc7501">OSC 7501</span> idle/done, and the <span class="term" tabindex="0" data-term="reaper">reaper</span> protects dirty or unpushed git checkouts.</p>
      </article>
    </div>
  </section>

  <!-- LEVEL 3: GOAL STACK -->
  <section class="band" aria-label="Level 3: Where we stopped and next step">
    <div class="band-head">
      <div class="band-label"><span class="step-num">3</span>Where We Stopped · Goal Stack</div>
      <span class="band-note">Altmann &amp; Trafton resumption cue</span>
    </div>
    <div class="stack">
      <div class="col">
        <p class="col-title"><span>Already Built (Locked In)</span><span>✓</span></p>
        <div class="chips">
          <span class="chip done">Fable 5.2 Tab 1</span>
          <span class="chip done">rex-antigravity-hooks</span>
          <span class="chip done">Go rex-runner + reply</span>
          <span class="chip done">Live /about + inspect</span>
          <span class="chip done">LaunchAgent serve</span>
        </div>
      </div>

      <div class="col active">
        <p class="col-title"><span>Ready Right Now (Next 1 Step)</span><span>ACTIVE GOAL</span></p>
        <p>Flip <code>claim_apps</code> in <code>config.json</code> (e.g. <code>["agent-pager","prhub"]</code>) and toggle Orca "New chats" off in the Menu Bar, then send real feedback from your phone.</p>
      </div>

      <div class="col">
        <p class="col-title"><span>Verify Live On /about</span><span>REAL RELIABILITY</span></p>
        <p>Open <strong>Live System Tree</strong>, unlock <strong>Inspect Live Terminal</strong> with your runner token, and watch Fable + builder tabs dump live terminal output as they ship.</p>
      </div>
    </div>
  </section>

  <footer>
    <span>Grounded in Endsley (1995), Altmann &amp; Trafton (2002), Parnin &amp; Rugaber (2011), Hutchins (1995), Kirsh (2010), Nielsen &amp; Cowan (2001).</span>
    <span>Brain mirror: notes/feedback-loop-worldview</span>
  </footer>
</main>

<script>
const TERMS = {
  runner: "The local Mac daemon (Python runner/ for Orca, or Go rex-runner for Rex) bridging the Cloudflare Worker and your Mac: claims pending feedback, opens/resumes tabs, and pushes replies back up.",
  agent: "The AI model doing the thinking or coding (Fable 5.2 coordinator, Claude Opus, Codex, or Antigravity).",
  worker: "The featurekit Cloudflare Worker holding every app's chats (D1), media (R2), live chat rooms (DO), and this dashboard.",
  fable: "Claude Fable 5.2 running in Tab 1 of Rex session feedback-loop. Strictly coordinates, delegates to builders, and validates before shipping.",
  inbox: "Append-only, file-locked FIFO queue (inbox.jsonl) holding incoming chats and builder reports until Fable is idle so concurrent events never collide in Fable's terminal.",
  reaper: "Deterministic cleanup loop (rex-runner reap) that verifies clean git status, zero unpushed commits, and idle TTL before closing finished Rex tabs.",
  osc7501: "Rex's Program Status Protocol terminal escape sequence (ESC ] 7501) reporting live idle, working, blocked, done, or error states from agents.",
  "run.json": "Per-feedback manifest saved in each builder's isolated folder recording chat_id, repo, agent, session_id, and Rex window ID so reboots resume the exact conversation.",
  "/runner/agent": "Worker endpoint where the runner posts the agent's replies and working status back to D1 so your phone displays them.",
  "/v2/acp": "AgentChatKit's live streaming protocol over Durable Objects pushing new messages and working indicators straight to iOS/macOS apps."
};

const termsGrid = document.getElementById("termsGrid");
for (const [k, def] of Object.entries(TERMS)) {
  const wrap = document.createElement("div");
  wrap.innerHTML = "<dt>" + k + "</dt><dd>" + def + "</dd>";
  termsGrid.appendChild(wrap);
}

const termsBtn = document.getElementById("termsBtn");
const termsDrawer = document.getElementById("termsDrawer");
termsBtn.addEventListener("click", () => {
  const open = termsDrawer.classList.toggle("open");
  termsBtn.setAttribute("aria-expanded", String(open));
});

const tip = document.getElementById("termTip");
function showTip(el) {
  const key = el.dataset.term;
  const def = TERMS[key];
  if (!def) return;
  tip.innerHTML = "<strong>" + key + "</strong>" + def;
  tip.style.display = "block";
  const r = el.getBoundingClientRect();
  const top = r.bottom + 8 + tip.offsetHeight > window.innerHeight ? Math.max(8, r.top - tip.offsetHeight - 8) : r.bottom + 8;
  const left = Math.min(window.innerWidth - tip.offsetWidth - 10, Math.max(10, r.left));
  tip.style.top = top + "px";
  tip.style.left = left + "px";
}
function hideTip() { tip.style.display = "none"; }

document.querySelectorAll(".term").forEach((el) => {
  el.addEventListener("mouseenter", () => showTip(el));
  el.addEventListener("mouseleave", hideTip);
  el.addEventListener("focus", () => showTip(el));
  el.addEventListener("blur", hideTip);
  el.addEventListener("click", (e) => { e.stopPropagation(); showTip(el); });
});
document.addEventListener("click", hideTip);

const RESUME_PROMPT =
  "Reorient on Feedback Loop (see https://featurekit.jai-f89.workers.dev/about/worldview and brain notes/feedback-loop-worldview). " +
  "rex-runner serve is running with reply + live inspect support. Next: switch claim_apps in ~/Library/Application Support/feedbackkit-rex-runner/config.json to test real Agent Pager / PR Hub feedback through Fable 5.2.";

document.getElementById("copyBtn").addEventListener("click", async () => {
  const btn = document.getElementById("copyBtn");
  try {
    await navigator.clipboard.writeText(RESUME_PROMPT);
    btn.textContent = "Copied ✓";
    setTimeout(() => { btn.textContent = "Copy Resume Prompt"; }, 1800);
  } catch {
    window.prompt("Copy this resume prompt:", RESUME_PROMPT);
  }
});

document.getElementById("themeBtn").addEventListener("click", () => {
  const root = document.documentElement;
  const current = root.getAttribute("data-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.setAttribute("data-theme", current ? (current === "dark" ? "light" : "dark") : (prefersDark ? "light" : "dark"));
});

async function hydrate() {
  try {
    const res = await fetch("/about/status.json", { cache: "no-store" });
    if (!res.ok) return;
    const d = await res.json();
    document.getElementById("spApps").textContent = d.worker.total_chats + " chats · " + d.worker.apps.length + " apps";
    document.getElementById("spWorker").textContent = d.worker.pending_messages + " pending · " + d.worker.delivering_messages + " active";
    document.getElementById("spOrca").textContent = d.orca.online ? ("Online · " + d.orca.age_seconds + "s ago") : "Offline";
    document.getElementById("spOrcaBox").setAttribute("class", "sp-box " + (d.orca.online ? "live" : "idle"));
    document.getElementById("spRex").textContent = d.rex.connected
      ? ("Live · new chats: " + (d.rex.claim_apps.length ? d.rex.claim_apps.join(",") : "Orca"))
      : "Built · idle (not serving)";
    document.getElementById("spRexBox").setAttribute("class", "sp-box " + (d.rex.connected ? "live" : "idle"));
    document.getElementById("spFable").textContent = d.rex.coordinator_active
      ? ("Tab 1 · " + d.rex.coordinator_state + " · inbox " + d.rex.inbox_pending)
      : "Tab 1 offline";
    document.getElementById("spFableBox").setAttribute("class", "sp-box " + (d.rex.connected && d.rex.coordinator_active ? "live" : "idle"));
    const activeRuns = (d.rex.runs || []).filter((r) => r.status === "active" || r.status === "blocked").length;
    document.getElementById("spBuild").textContent = "Subfolder + run.json (" + activeRuns + " active)";
    document.getElementById("spBuildBox").setAttribute("class", "sp-box " + (activeRuns > 0 ? "live" : "unbuilt"));
    document.getElementById("liveSummary").textContent =
      "Live check: Orca " + (d.orca.online ? "online" : "offline") + " · Rex " + (d.rex.connected ? "live" : "idle") + " · " + d.worker.total_chats + " chats";
  } catch {
    document.getElementById("liveSummary").textContent = "Offline snapshot";
  }
}
hydrate();
</script>
</body>
</html>
`;

export function worldviewResponse(): Response {
  return new Response(WORLDVIEW_HTML, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=60",
    },
  });
}
