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
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>FeedbackKit — 30-Second Mental Model</title>
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
    --idle: #9a4a00;
    --idle-soft: rgba(154, 74, 0, 0.11);
    --unbuilt: #7a7368;
    --tip-bg: #222529;
    --tip-fg: #dcdfe3;
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
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
      --idle: #f0b35a;
      --idle-soft: rgba(240, 179, 90, 0.14);
      --unbuilt: #8e96a0;
      --tip-bg: #efece5;
      --tip-fg: #1f2328;
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
    --idle: #f0b35a;
    --idle-soft: rgba(240, 179, 90, 0.14);
    --unbuilt: #8e96a0;
    --tip-bg: #efece5;
    --tip-fg: #1f2328;
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
  a:focus-visible, button:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
  .page {
    max-width: 72rem;
    margin: 0 auto;
    padding: 1.2rem max(1.1rem, env(safe-area-inset-right, 0px)) 2rem max(1.1rem, env(safe-area-inset-left, 0px));
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.85rem;
    padding-bottom: 0.85rem;
    border-bottom: 1px solid var(--border);
  }
  .title-wrap { display: flex; align-items: baseline; gap: 0.75rem; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 1.55rem; font-weight: 650; line-height: 1.25; }
  .tag {
    font-size: 0.9rem;
    font-weight: 600;
    padding: 0.2rem 0.6rem;
    border-radius: 6px;
    border: 1px solid var(--accent);
    color: var(--accent);
    background: var(--accent-soft);
  }
  .nav { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  .size-group {
    display: inline-flex;
    border: 1px solid var(--border-strong);
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
  a.btn, button.btn {
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
  }
  a.btn:hover, button.btn:hover { border-color: var(--accent); color: var(--accent); }
  button.btn.primary, button.btn[aria-expanded="true"], button.btn[aria-pressed="true"] {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 650;
  }

  /* Inline hover/tap glossary terms */
  .term {
    border-bottom: 2px dotted var(--accent);
    cursor: help;
    color: var(--text);
    position: relative;
  }
  .term:focus { outline: 3px solid var(--accent); border-radius: 3px; }
  #termTip {
    position: fixed;
    z-index: 999;
    max-width: 24rem;
    padding: 0.75rem 0.95rem;
    border-radius: 8px;
    background: var(--tip-bg);
    color: var(--tip-fg);
    font-size: 0.98rem;
    line-height: 1.5;
    box-shadow: 0 8px 24px rgba(0,0,0,0.28);
    pointer-events: none;
    display: none;
  }
  #termTip strong { display: block; font-family: var(--mono); font-size: 0.92rem; margin-bottom: 0.2rem; }

  /* Collapsible Terms drawer */
  .terms-drawer {
    display: none;
    background: var(--surface);
    border: 1px solid var(--accent);
    border-radius: 10px;
    padding: 1rem 1.15rem;
  }
  .terms-drawer.open { display: block; }
  .terms-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
    gap: 0.8rem 1.2rem;
    font-size: 0.98rem;
  }
  .terms-grid dt { font-family: var(--mono); font-size: 0.95rem; font-weight: 700; color: var(--accent); }
  .terms-grid dd { margin: 0.2rem 0 0; color: var(--text-dim); }

  .band {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1rem 1.2rem;
  }
  .band-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }
  .band-label {
    font-size: 1rem;
    font-weight: 650;
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 0.55rem;
  }
  .step-num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.6rem;
    height: 1.6rem;
    border-radius: 6px;
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 700;
    font-size: 0.95rem;
  }
  .band-note { font-size: 0.95rem; color: var(--text-dim); }

  .spine-wrap { overflow-x: auto; }
  svg.spine { display: block; width: 100%; min-width: 680px; height: auto; }
  .sp-box { fill: var(--surface-2); stroke: var(--border-strong); stroke-width: 1.8; rx: 7; }
  .sp-box.live { stroke: var(--live); fill: var(--live-soft); }
  .sp-box.idle { stroke: var(--idle); fill: var(--idle-soft); }
  .sp-box.unbuilt { stroke: var(--unbuilt); stroke-dasharray: 4 3; fill: var(--surface); }
  .sp-title { font-family: var(--sans); font-size: 13.5px; font-weight: 700; fill: var(--text); }
  .sp-sub { font-family: var(--sans); font-size: 11px; fill: var(--text-dim); }
  .sp-arrow { stroke: var(--border-strong); stroke-width: 2; fill: none; }
  .sp-arrow.hot { stroke: var(--accent); }
  .sp-arrow.dim { stroke: var(--unbuilt); stroke-dasharray: 4 3; }

  .laws { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.85rem; }
  @media (max-width: 860px) { .laws { grid-template-columns: 1fr; } }
  .law {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.95rem 1.05rem;
    background: var(--surface);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .law-top { display: flex; align-items: baseline; gap: 0.55rem; }
  .law-idx {
    font-size: 0.88rem;
    font-weight: 700;
    color: var(--accent);
    background: var(--accent-soft);
    padding: 0.12rem 0.5rem;
    border-radius: 5px;
    flex-shrink: 0;
  }
  .law h2 { margin: 0; font-size: 1.15rem; font-weight: 650; line-height: 1.3; }
  .mech {
    font-family: var(--mono);
    font-size: 0.9rem;
    background: var(--surface-2);
    border-radius: 6px;
    padding: 0.5rem 0.7rem;
    color: var(--text);
    overflow-x: auto;
    white-space: nowrap;
  }
  .mech .hi { color: var(--accent); font-weight: 650; }
  .mech .ok { color: var(--live); font-weight: 650; }
  .law p { margin: 0; font-size: 1rem; color: var(--text-dim); }
  .law code { font-family: var(--mono); font-size: 0.9em; background: var(--surface-2); padding: 0.08rem 0.35rem; border-radius: 4px; color: var(--text); }

  .stack { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.85rem; }
  @media (max-width: 920px) { .stack { grid-template-columns: 1fr; } }
  .col { border: 1px solid var(--border); border-radius: 8px; padding: 0.9rem 1rem; }
  .col.active { border-color: var(--accent); background: var(--accent-soft); }
  .col-title {
    font-size: 0.95rem;
    font-weight: 650;
    color: var(--text-dim);
    margin: 0 0 0.5rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .col.active .col-title { color: var(--accent); }
  .chips { display: flex; flex-wrap: wrap; gap: 0.45rem; }
  .chip {
    font-size: 0.92rem;
    font-weight: 600;
    padding: 0.2rem 0.6rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
  }
  .chip.done { border-color: var(--live); color: var(--live); background: var(--live-soft); }
  .col p { margin: 0; font-size: 1rem; }
  .col code { font-family: var(--mono); font-size: 0.9em; background: var(--surface); padding: 0.08rem 0.35rem; border-radius: 4px; }

  footer {
    margin-top: auto;
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0.6rem;
    font-size: 0.92rem;
    color: var(--text-dim);
    padding-top: 0.4rem;
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
      <a class="btn" href="https://systems-floorplan.pages.dev/">← Systems Home</a>
      <a class="btn" href="/about">← Live System Tree</a>
      <button class="btn" id="termsBtn" type="button" aria-expanded="false">Terms</button>
      <button class="btn primary" id="copyBtn" type="button">Copy Resume Prompt</button>
      <div class="size-group" role="group" aria-label="Text size">
        <button class="btn size-btn" data-size="normal" aria-pressed="true" type="button">A</button>
        <button class="btn size-btn" data-size="large" aria-pressed="false" type="button">A+</button>
        <button class="btn size-btn" data-size="huge" aria-pressed="false" type="button">A++</button>
      </div>
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
    <div class="spine-wrap">
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
    </div>
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
        <div class="law-top"><span class="law-idx">Law 2</span><h2>One Worker queue, two non-racing lanes</h2></div>
        <div class="mech">D1 queue → <span class="ok">Orca (skips rex-apps.json)</span> | <span class="hi">Rex Go (claim_apps)</span></div>
        <p>Orca leaves new chats for apps listed in <code>rex-apps.json</code> to <span class="term" tabindex="0" data-term="fable">Fable</span> while keeping existing Orca chats untouched. No race on <code>/runner/claim</code>.</p>
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
        <p class="col-title"><span>Live Right Now</span><span>Active</span></p>
        <p>New chats for <code>agent-pager</code>, <code>prhub</code>, <code>trips</code>, and <code>feedbackkit-demo</code> route to <span class="term" tabindex="0" data-term="fable">Fable</span> on Rex; Orca skips them via <code>rex-apps.json</code>.</p>
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
