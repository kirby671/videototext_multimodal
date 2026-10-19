/*
 * Shared transcript card: used on YouTube (content script) and on the standalone "Analyze a transcript" page.
 * Holds the state machine (load → clean → Claude: speakers + insights in one call; optional translation),
 * rendering, caching and exports. Environment-specific bits come in through `env`.
 */
(function (root) {
  'use strict';
  const C = root.YTCT;

  const DEFAULTS = {
    model: 'claude-opus-5-5',
    removeFillers: true,
    removeTags: true,
    autoLoad: false,
    keepYouTubePanel: false,
    focus: C.DEFAULT_FOCUS,
    analysisLang: 'en', // language Claude writes the analysis in ('auto' = the video's own language)
    translateTo: '', // last language picked in "Translate to" ('' = the browser's language)
    collapsed: false,
    layout: 'dock' // 'dock' = panel pinned to the right of the window; 'sidebar' = card above the recommendations
  };
  // Each video opens with the pinned panel as wide as YouTube's sidebar; drag its edge to widen it.
  const SIDEBAR_PX = 420;
  // Every transcript is kept (the Library): "cache:<videoId>" for YouTube videos, "cache:paste-<hash>" for pasted text.
  const CACHE_PREFIX = 'cache:';
  const hashText = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  };

  const ICON_GEAR =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Zm7.43-2.53a7.8 7.8 0 0 0 0-1.94l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.3 7.3 0 0 0-1.68-.98l-.38-2.65A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.5.42l-.38 2.65c-.6.25-1.17.58-1.68.98l-2.49-1a.5.5 0 0 0-.61.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65a7.8 7.8 0 0 0 0 1.94l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46c.13.22.39.31.61.22l2.49-1c.51.4 1.08.73 1.68.98l.38 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.38-2.65c.6-.25 1.17-.58 1.68-.98l2.49 1c.22.09.48 0 .61-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65Z"/></svg>';
  const ICON_LIB =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M4 6H2v14a2 2 0 0 0 2 2h14v-2H4V6Zm16-4H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2Zm-1 9H9V9h10v2Zm-4 4H9v-2h6v2Zm4-8H9V5h10v2Z"/></svg>';
  const ICON_EXPAND =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M21 11V3h-8l3.29 3.29-10 10L3 13v8h8l-3.29-3.29 10-10L21 11Z"/></svg>';
  const ICON_SHRINK =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M22 3.41 16.71 8.7 20 12h-8V4l3.29 3.29L20.59 2 22 3.41ZM3.41 22l5.29-5.29L12 20v-8H4l3.29 3.29L2 20.59 3.41 22Z"/></svg>';
  const ICON_CHEV =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z"/></svg>';

  const CSS = `
:host { all: initial; display: block; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.card {
  --fg: var(--yt-spec-text-primary, #0f0f0f);
  --fg2: var(--yt-spec-text-secondary, #606060);
  --bg: var(--yt-spec-base-background, #ffffff);
  --raised: var(--yt-spec-badge-chip-background, rgba(0,0,0,0.05));
  --raised-h: var(--yt-spec-button-chip-background-hover, rgba(0,0,0,0.1));
  --line: var(--yt-spec-10-percent-layer, rgba(0,0,0,0.1));
  --accent: var(--yt-spec-call-to-action, #065fd4);
  --mark: rgba(255, 196, 0, 0.28);
  --concept: rgba(6, 95, 212, 0.09);
  --err: #c5221f;
  font: 400 14px/1.55 Roboto, -apple-system, "Segoe UI", Arial, sans-serif;
  color: var(--fg); background: var(--bg);
  border: 1px solid var(--line); border-radius: 12px; overflow: hidden;
}
:host-context(html[dark]) .card { --err: #ff8a80; --mark: rgba(255, 204, 64, 0.22); --concept: rgba(138, 180, 248, 0.12); }
header { display: flex; align-items: center; gap: 8px; padding: 10px 10px 10px 14px; }
.title { all: unset; cursor: pointer; display: flex; align-items: center; gap: 6px; font-weight: 500; font-size: 16px; flex: 1; min-width: 0; }
.title .chev { display: inline-flex; transition: transform .15s ease; color: var(--fg2); }
.collapsed .title .chev { transform: rotate(-90deg); }
.collapsed .body { display: none; }
.standalone header { display: none; }
.icon { all: unset; cursor: pointer; display: inline-flex; padding: 6px; border-radius: 50%; color: var(--fg2); }
.icon:hover { background: var(--raised-h); color: var(--fg); }
.body { padding: 0 14px 12px; }
.standalone .body { padding: 16px 18px 14px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.btn { all: unset; cursor: pointer; padding: 0 14px; height: 32px; display: inline-flex; align-items: center; border-radius: 16px; background: var(--raised); color: var(--fg); font-weight: 500; font-size: 13px; white-space: nowrap; }
.btn:hover { background: var(--raised-h); }
.btn.primary { background: var(--fg); color: var(--bg); }
.btn.primary:hover { opacity: .88; }
.btn[disabled] { opacity: .4; cursor: default; pointer-events: none; }
.btn.small { height: 26px; padding: 0 11px; font-size: 12px; }
.subbar .btn.small { margin-left: auto; }
.btn:focus-visible, .link:focus-visible, .title:focus-visible, .icon:focus-visible, .tab:focus-visible, .seg button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.status { min-height: 20px; margin: 8px 0 2px; font-size: 12.5px; color: var(--fg2); }
.status:empty { display: none; }
.status[data-kind="error"], .status[data-kind="nokey"] { color: var(--err); }
.status[data-kind="work"]::before { content: ""; display: inline-block; width: 8px; height: 8px; margin-right: 7px; border-radius: 50%; background: var(--accent); animation: pulse 1s ease-in-out infinite; vertical-align: 1px; }
@keyframes pulse { 50% { opacity: .25; } }
.link { all: unset; cursor: pointer; color: var(--accent); font-size: 12.5px; font-weight: 500; }
.trgroup { display: inline-flex; align-items: stretch; }
.trgroup .btn { border-radius: 16px 0 0 16px; padding-right: 10px; }
.trgroup select { height: 32px; max-width: 132px; padding: 0 6px 0 9px; border: 0; border-left: 1px solid var(--line); border-radius: 0 16px 16px 0; background: var(--raised); color: var(--fg); font: 500 13px Roboto, -apple-system, "Segoe UI", Arial, sans-serif; cursor: pointer; }
.trgroup select:hover { background: var(--raised-h); }
.trgroup select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.trgroup select[disabled] { opacity: .4; cursor: default; }
.trinfo { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin: 8px 0 0; font-size: 12.5px; color: var(--fg2); }
.trinfo .trnote { flex: 1 1 200px; }
.keyprompt { margin: 10px 0 2px; padding: 12px 14px; border-radius: 10px; background: var(--raised); border: 1px solid var(--line); font-size: 13px; line-height: 1.5; }
.keyprompt p { margin: 0 0 10px; }
.keyprompt .fine { margin: 8px 0 0; color: var(--fg2); font-size: 12px; }
.keyprompt .row { display: flex; flex-wrap: wrap; gap: 8px; }
.link:hover { text-decoration: underline; }
.link[disabled] { opacity: .4; pointer-events: none; }
.tabs { display: flex; align-items: center; gap: 2px; margin: 10px 0 0; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.tab { all: unset; cursor: pointer; padding: 8px 10px; font-weight: 500; font-size: 13px; color: var(--fg2); border-bottom: 2px solid transparent; margin-bottom: -1px; }
.tab.on { color: var(--fg); border-bottom-color: var(--fg); }
.tabs .grow { flex: 1; }
.exp { display: inline-flex; gap: 12px; }
.tabs .exp { margin-left: 12px; }
footer .exp { display: none; }
.card { container-type: inline-size; }
@container (max-width: 560px) {
  .tabs .exp { display: none; }
  footer .exp { display: inline-flex; gap: 16px; }
  .subbar { flex-direction: column; align-items: flex-start; }
  .seg { margin-left: 0; }
}
.subbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 10px 0 0; }
.speakers { display: flex; flex-wrap: wrap; gap: 6px; flex: 1; min-width: 0; }
.chip { font-size: 12px; padding: 3px 10px; border-radius: 12px; background: var(--raised); }
.chip b { font-weight: 600; }
.chip .r { color: var(--fg2); }
.seg { display: inline-flex; background: var(--raised); border-radius: 14px; padding: 2px; margin-left: auto; }
.seg button { all: unset; cursor: pointer; font-size: 12px; font-weight: 500; padding: 3px 10px; border-radius: 12px; color: var(--fg2); }
.seg button.on { background: var(--bg); color: var(--fg); box-shadow: 0 0 0 1px var(--line); }
.pane { max-height: 62vh; overflow-y: auto; padding: 4px 4px 4px 0; margin-top: 8px; overscroll-behavior: contain; }
.standalone .pane { max-height: none; overflow: visible; }
.pane p { margin: 0 0 12px; }
.para.cont { margin-top: -4px; }
.spk { font-weight: 600; }
.dash { color: var(--fg2); }
.chapter { margin: 16px 0 8px; font-size: 13px; font-weight: 600; color: var(--fg2); text-transform: uppercase; letter-spacing: .04em; }
.empty { color: var(--fg2); font-size: 13px; }
.note { color: var(--fg2); font-size: 12px; margin: 0 0 10px; }
mark.co { background: var(--mark); color: inherit; border-radius: 3px; padding: 0 2px; cursor: pointer; }
.ctag { all: unset; cursor: pointer; display: inline-block; margin: 2px 0 6px; padding: 2px 9px; border-radius: 10px; background: var(--concept); color: var(--accent); font-size: 11.5px; font-weight: 600; }
.ctag::before { content: "Concept · "; font-weight: 500; opacity: .8; }
.s0 { color: #1a5fb4; } .s1 { color: #b5480a; } .s2 { color: #26803a; } .s3 { color: #8a3ab0; } .s4 { color: #b0204f; } .s5 { color: #0b7285; }
:host-context(html[dark]) .s0 { color: #8ab4f8; } :host-context(html[dark]) .s1 { color: #f6a96b; } :host-context(html[dark]) .s2 { color: #81c995; }
:host-context(html[dark]) .s3 { color: #d7aefb; } :host-context(html[dark]) .s4 { color: #f28bad; } :host-context(html[dark]) .s5 { color: #78d9ec; }
.L h4 { margin: 18px 0 8px; font-size: 12.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--fg2); }
.L h4:first-child { margin-top: 6px; }
.L h5 { margin: 12px 0 4px; font-size: 14px; font-weight: 600; }
.L .summary { font-size: 14.5px; }
.L ul, .L ol { margin: 0; padding-left: 20px; }
.L li { margin: 0 0 7px; }
.L li b { font-weight: 600; }
.L .who { color: var(--fg2); font-size: 12px; }
.L .theme { margin: 0 0 10px; }
.L .theme b { font-weight: 600; }
.L .concept { margin: 0 0 14px; padding: 10px 12px; border-radius: 10px; background: var(--concept); }
.L .concept h5 { margin: 0 0 2px; }
.L .concept .by { font-size: 12px; color: var(--fg2); margin: 0 0 6px; }
.L .concept ol { margin-top: 4px; }
.L blockquote { margin: 0 0 10px; padding: 2px 0 2px 12px; border-left: 3px solid var(--line); }
.L blockquote .q { font-style: italic; }
.L blockquote .by { display: block; margin-top: 2px; font-size: 12px; color: var(--fg2); }
.L .co-item { margin: 0 0 10px; }
.L .co-item .type { font-size: 11px; color: var(--fg2); border: 1px solid var(--line); border-radius: 8px; padding: 0 6px; margin-left: 6px; vertical-align: 1px; }
.L .flash { animation: flash 1.2s ease; border-radius: 6px; }
.cmap { margin: 4px 0 8px; }
.cmap svg { display: block; width: 100%; height: auto; overflow: visible; }
.cmap .edge { fill: none; stroke: var(--fg2); stroke-width: 1.4; opacity: .6; }
.cmap .arrow { fill: var(--fg2); opacity: .8; }
.cmap .node { cursor: pointer; }
.cmap .node rect { fill: var(--concept); stroke: var(--accent); stroke-opacity: .45; stroke-width: 1; }
.cmap .node:hover rect { stroke-opacity: 1; }
.cmap .node text { fill: var(--fg); font: 600 12px Roboto, -apple-system, Arial, sans-serif; }
.cmap .lab rect { fill: var(--bg); stroke: var(--line); }
.cmap .lab text { fill: var(--fg2); font: 500 10.5px Roboto, -apple-system, Arial, sans-serif; }
.cmap-note { font-size: 12px; color: var(--fg2); margin: 0 0 6px; }
@keyframes flash { 0%, 40% { background: var(--mark); } 100% { background: transparent; } }
.paste textarea { width: 100%; min-height: 150px; margin-top: 10px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); font: 13px/1.45 Roboto, -apple-system, Arial, sans-serif; resize: vertical; }
.standalone .paste textarea { min-height: 260px; margin-top: 0; }
.paste input[type=text] { width: 100%; margin-top: 8px; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); font: 13px Roboto, -apple-system, Arial, sans-serif; }
.paste .row { display: flex; gap: 8px; margin-top: 8px; }
footer { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
.spendline { margin-top: 8px; font-size: 12px; color: var(--fg2); }
.spendline:empty { display: none; }
.src { margin-left: auto; font-size: 12px; color: var(--fg2); }
.card { position: relative; }
.grip { display: none; }
.card.docked { height: 100%; display: flex; flex-direction: column; border-radius: 0; border-width: 0 0 0 1px; font-size: 15px; line-height: 1.6; box-shadow: -10px 0 24px rgba(0,0,0,.07); }
.card.docked header { padding: 10px 12px 4px 24px; }
/* Pinned panel: buttons, messages and tabs keep their natural height; only the transcript area shrinks and scrolls.
   On a very short window the whole body scrolls rather than letting anything overlap. */
.card.docked .body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; padding: 2px 24px 12px; overflow-y: auto; }
.card.docked .body > * { flex-shrink: 0; }
.card.docked .pane { max-height: none; flex: 1 1 0; min-height: 160px; padding-right: 12px; }
.card.docked .pane > * { max-width: 900px; }
.card.docked .pane p { margin-bottom: 14px; }
.card.docked .grip { display: block; position: absolute; left: 0; top: 0; bottom: 0; width: 12px; cursor: col-resize; z-index: 3; touch-action: none; outline: none; }
.card.docked .grip::after { content: ""; position: absolute; left: 4px; top: 50%; width: 4px; height: 48px; margin-top: -24px; border-radius: 2px; background: var(--line); transition: background .15s ease; }
.card.docked .grip:hover::after, .card.docked .grip:focus-visible::after, .card.dragging .grip::after { background: var(--accent); }
.card.dragging { user-select: none; }
.card.dragging .pane { pointer-events: none; }
`;

  const extAlive = () => {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  };

  // ---------- Claude calls & cost (shared with the Library's Trends view) ----------
  function callClaudeOnce(req) {
    return new Promise((resolve, reject) => {
      let done = false;
      const port = chrome.runtime.connect({ name: 'ytct-claude' });
      const ka = setInterval(() => {
        try {
          port.postMessage({ type: 'ping' });
        } catch (e) {
          /* ignore */
        }
      }, 15000);
      const finish = (fn, v) => {
        if (done) return;
        done = true;
        clearInterval(ka);
        try {
          port.disconnect();
        } catch (e) {
          /* ignore */
        }
        fn(v);
      };
      port.onMessage.addListener((msg) => {
        if (msg && msg.type === 'result')
          msg.ok ? finish(resolve, msg.data) : finish(reject, new Error(msg.error || 'Claude request failed'));
      });
      port.onDisconnect.addListener(() =>
        finish(reject, new Error('The extension restarted mid-request. Please try again.'))
      );
      port.postMessage({ type: 'call', payload: req });
    });
  }
  async function callClaude(req) {
    try {
      return await callClaudeOnce(req);
    } catch (e) {
      if (/429|529|overloaded|rate|restarted|reach/i.test(e.message)) {
        await sleep(5000);
        return callClaudeOnce(req);
      }
      throw e;
    }
  }

  // Cost: Claude reports token counts with every response; prices are Anthropic's list prices
  // in USD per million tokens (Haiku 5.5 costs more on prompts over 100k tokens).
  const PRICES = {
    'claude-opus-5-5': { in: 4, out: 20, name: 'Opus 5.5' },
    'claude-sonnet-5-5': { in: 2, out: 10, name: 'Sonnet 5.5' },
    'claude-haiku-5-5': { in: 0.1, out: 0.5, inLong: 0.5, outLong: 2.5, longOver: 100000, name: 'Haiku 5.5' },
    'claude-fable-5-1': { in: 10, out: 50, name: 'Fable 5.1' }
  };
  const newMeter = () => ({ inTok: 0, outTok: 0, thinkTok: 0, cost: 0, known: true, models: new Set() });
  function meterAdd(m, res) {
    if (!res || !res.usage) return;
    const u = res.usage;
    const inT = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    const outT = u.output_tokens || 0;
    m.inTok += inT;
    m.outTok += outT;
    m.thinkTok += (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0;
    const p = PRICES[res.model];
    if (!p) {
      m.known = false;
      if (res.model) m.models.add(res.model);
      return;
    }
    m.models.add(p.name);
    const long = p.longOver && inT > p.longOver;
    m.cost += (inT / 1e6) * (long ? p.inLong : p.in) + (outT / 1e6) * (long ? p.outLong : p.out);
  }
  const money = (c) =>
    c >= 1 ? '$' + c.toFixed(2) : c >= 0.01 ? '$' + c.toFixed(3) : c > 0 ? '$' + c.toFixed(4) : '$0';
  const meterText = (m) =>
    (m.known ? 'about ' + money(m.cost) : 'an unknown amount') +
    ' (' +
    m.inTok.toLocaleString() +
    ' tokens in, ' +
    m.outTok.toLocaleString() +
    ' out' +
    (m.thinkTok ? ' incl. ' + m.thinkTok.toLocaleString() + ' thinking' : '') +
    ' · ' +
    [...m.models].join(' + ') +
    ')';

  async function addToSpend(m) {
    if (!m.known || !m.cost || !extAlive()) return;
    try {
      const { spend } = await chrome.storage.local.get(['spend']);
      const s = spend && typeof spend.total === 'number' ? spend : { total: 0, runs: 0, since: Date.now() };
      s.total += m.cost;
      s.runs += 1;
      await chrome.storage.local.set({ spend: s });
    } catch (e) {
      /* not critical */
    }
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const slug = (s) =>
    String(s || 'transcript')
      .replace(/[\\/:*?"<>|]+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 90)
      .trim() || 'transcript';
  const wordsIn = (s) => (String(s || '').match(/\S+/g) || []).length;

  /**
   * env = {
   *   kind: 'youtube' | 'standalone',
   *   fetchTranscript?: async (videoId) => ({ items, source, meta }),  // YouTube only
   *   getMeta?: async (videoId) => meta,
   *   seek?: (seconds) => void
   * }
   */
  function createPanel(env) {
    const standalone = env.kind !== 'youtube'; // the paste page and the Library viewer
    const isLib = env.kind === 'library';
    const canDock = env.kind === 'youtube';
    let settings = { ...DEFAULTS, hasKey: false };
    const fresh = (videoId) => ({
      videoId,
      key: videoId ? CACHE_PREFIX + videoId : null,
      meta: null,
      items: null,
      source: null,
      units: null,
      unitCount: 0,
      speakers: null,
      turns: null,
      corrections: null,
      speakerNotes: '',
      analysis: null,
      distilled: null,
      busy: false,
      translations: null,
      trLang: null,
      srcLang: null,
      trOffer: null
    });
    let S = fresh(null);
    let tab = 'transcript',
      view = 'verbatim'; // older saved transcripts may also have a distilled version
    let dockPx = SIDEBAR_PX; // width of the pinned panel; back to the sidebar width on every new video

    // ---------- settings ----------
    function applySettings(all) {
      const next = { ...DEFAULTS };
      for (const k of Object.keys(DEFAULTS)) if (all[k] !== undefined) next[k] = all[k];
      next.hasKey = !!(all.apiKey && String(all.apiKey).trim());
      settings = next;
    }
    chrome.storage.local.get(null, (all) => {
      applySettings(all || {});
      if (!standalone) ui.card.classList.toggle('collapsed', !!settings.collapsed);
      applyLayout();
      render();
      const u = all && all.updateNote;
      if (!isLib && u && u.to && Date.now() - u.at < 10 * 60000 && !ui.status.textContent)
        status('Clean Transcript just updated itself to v' + u.to + '.');
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && 'spend' in changes) showSpendLine();
      if (area !== 'local' || !['apiKey', ...Object.keys(DEFAULTS)].some((k) => k in changes)) return;
      chrome.storage.local.get(null, (all) => {
        const before = { f: settings.removeFillers, t: settings.removeTags };
        applySettings(all || {});
        if (S.items && (before.f !== settings.removeFillers || before.t !== settings.removeTags)) rebuildUnits(S);
        if (settings.hasKey && !ui.keyprompt.hidden) {
          ui.keyprompt.hidden = true;
          status('API key saved. Click “Analyze with Claude” to run it.');
        }
        if (!standalone) {
          ui.card.classList.toggle('collapsed', !!settings.collapsed);
          ui.btn('collapse').setAttribute('aria-expanded', String(!settings.collapsed));
        }
        applyLayout();
        render();
      });
    });

    // ---------- derived data ----------
    function rebuildUnits(st) {
      st.units = C.buildUnits(st.items, { removeFillers: settings.removeFillers, removeTags: settings.removeTags });
      if (st.unitCount && st.unitCount !== st.units.length) {
        st.speakers = null;
        st.turns = null;
        st.corrections = null;
        st.distilled = null;
      }
      st.unitCount = st.units.length;
    }
    const turnsOf = (st) => C.buildTurns(st.units || [], st.turns, st.corrections);
    const parasOf = (st) => C.buildParagraphs(st.units || [], st.turns, st.corrections);
    const totalWords = (st) => (st.units || []).reduce((a, u) => a + wordsIn(u.text), 0);
    const hasDistilled = (st) => !!(st.distilled && st.distilled.covered && st.distilled.covered.length);
    const currentView = () => (hasDistilled(S) ? view : 'verbatim');

    // ---------- UI ----------
    const host = document.createElement('div');
    host.className = 'ytct-host';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<style>' +
      CSS +
      '</style>' +
      '<section class="card' +
      (standalone ? ' standalone' : '') +
      (isLib ? ' library' : '') +
      '" aria-label="Clean transcript">' +
      '<header><button class="title" data-act="collapse" aria-expanded="true"><span class="chev">' +
      ICON_CHEV +
      '</span><span>Clean transcript</span></button>' +
      '<button class="icon" data-act="library" title="Your Library: every transcript you’ve made" aria-label="Open your Library">' +
      ICON_LIB +
      '</button>' +
      (canDock
        ? '<button class="icon" data-act="dock" title="Open as a large panel" aria-label="Open as a large panel">' +
          ICON_EXPAND +
          '</button>'
        : '') +
      '<button class="icon" data-act="settings" title="Settings" aria-label="Settings">' +
      ICON_GEAR +
      '</button></header>' +
      (canDock
        ? '<div class="grip" role="separator" aria-orientation="vertical" aria-label="Resize the panel" tabindex="0" title="Drag to make it wider · double-click to go back to the sidebar width"></div>'
        : '') +
      '<div class="body">' +
      '<div class="paste"' +
      (env.kind === 'standalone' ? '' : ' hidden') +
      '>' +
      '<textarea placeholder="Paste a transcript — e.g. copied from YouTube’s transcript panel. Timestamps, [Music] and filler are removed automatically."></textarea>' +
      (standalone ? '<input type="text" class="ptitle" placeholder="Title (optional)">' : '') +
      '<div class="row"><button class="btn primary" data-act="paste-go">Clean transcript</button>' +
      (standalone ? '' : '<button class="btn" data-act="paste-cancel">Cancel</button>') +
      '</div></div>' +
      '<div class="actions">' +
      (standalone ? '' : '<button class="btn primary" data-act="load">Get transcript</button>') +
      '<button class="btn" data-act="analyze">Analyze with Claude</button>' +
      '<span class="trgroup"><button class="btn" data-act="translate" title="Translate the transcript (free with Chrome’s built-in translator)">Translate</button>' +
      '<select class="trlang" aria-label="Language to translate the transcript into" title="Language to translate into"></select></span>' +
      '</div>' +
      '<div class="trinfo" hidden><span class="trnote"></span><button class="btn small" data-act="translate-claude" hidden></button></div>' +
      // Shown only when someone clicks a Claude feature without a key saved. The key itself is never typed
      // on this page (YouTube's own scripts can read this panel); it goes in the extension's Settings page.
      '<div class="keyprompt" role="alert" hidden><p><b class="kp-what">To analyze with Claude, add your Anthropic API key.</b> ' +
      'You only do this once. Your key is stored locally in this browser and only sent to Anthropic when you run an analysis.</p>' +
      '<div class="row"><button class="btn small primary" data-act="addkey">Add API key</button><button class="btn small" data-act="keylater">Not now</button></div>' +
      '<p class="fine">No key? “Copy prompt for claude.ai” at the bottom works without one.</p></div>' +
      '<div class="status" role="status" aria-live="polite"></div>' +
      '<nav class="tabs" hidden><button class="tab on" data-tab="transcript">Transcript</button><button class="tab" data-tab="insights">Insights</button><button class="tab" data-tab="companies">Companies</button><span class="grow"></span>' +
      '<span class="exp"><button class="link" data-act="copy">Copy</button><button class="link" data-act="download">Download .md</button></span></nav>' +
      '<div class="subbar" hidden><div class="speakers"></div><div class="seg" hidden><button data-view="distilled">Distilled</button><button data-view="verbatim">Verbatim</button></div></div>' +
      '<div class="pane" data-pane="transcript"></div>' +
      '<div class="pane L" data-pane="insights" hidden></div>' +
      '<div class="pane L" data-pane="companies" hidden></div>' +
      '<footer><span class="exp"><button class="link" data-act="copy">Copy</button><button class="link" data-act="download">Download .md</button></span>' +
      (isLib
        ? ''
        : '<button class="link" data-act="paste">' +
          (standalone ? 'Paste a different transcript' : 'Paste a transcript') +
          '</button>') +
      '<button class="link" data-act="prompt">Copy prompt for claude.ai</button>' +
      (isLib ? '' : '<button class="link" data-act="library">Library</button>') +
      '<span class="src"></span></footer>' +
      '<div class="spendline" title="Estimated from the token counts Claude reports, at Anthropic list prices. Your exact bill is on console.anthropic.com. Reset the total in Options."></div>' +
      '</div></section>';
    const q = (s) => shadow.querySelector(s);
    const ui = {
      card: q('.card'),
      status: q('.status'),
      tabs: q('.tabs'),
      subbar: q('.subbar'),
      speakers: q('.speakers'),
      seg: q('.seg'),
      panes: {
        transcript: q('[data-pane="transcript"]'),
        insights: q('[data-pane="insights"]'),
        companies: q('[data-pane="companies"]')
      },
      keyprompt: q('.keyprompt'),
      trinfo: q('.trinfo'),
      trlang: q('.trlang'),
      trnote: q('.trnote'),
      paste: q('.paste'),
      textarea: q('textarea'),
      ptitle: q('.ptitle'),
      src: q('.src'),
      footer: q('footer'),
      spend: q('.spendline'),
      btn: (a) => q('[data-act="' + a + '"]')
    };
    C.LANGUAGES.map((c) => [c, C.langName(c)])
      .sort((a, b) => a[1].localeCompare(b[1]))
      .forEach(([c, n]) => {
        const o = el('option', null, n);
        o.value = c;
        ui.trlang.append(o);
      });
    ui.trlang.addEventListener('change', () => {
      const to = ui.trlang.value;
      S.trOffer = null;
      S.trLang = S.translations && S.translations[trKeyOf(to, viewTexts())] ? to : null; // a saved translation shows straight away
      settings.translateTo = to;
      try {
        chrome.storage.local.set({ translateTo: to });
      } catch (e) {
        /* extension reloaded */
      }
      status('');
      render();
    });

    shadow.addEventListener('click', (ev) => {
      const t = ev.target.closest('[data-act],[data-tab],[data-view],mark.co,.ctag');
      if (!t || t.disabled) return;
      if (t.matches('mark.co')) {
        goToItem('companies', 'co-' + t.dataset.co);
        return;
      }
      if (t.matches('.ctag')) {
        goToItem('insights', 'concept-' + t.dataset.concept);
        return;
      }
      if (t.dataset.tab) {
        setTab(t.dataset.tab);
        return;
      }
      if (t.dataset.view) {
        view = t.dataset.view;
        render();
        return;
      }
      const act = t.dataset.act;
      if (act === 'collapse') setCollapsed(!ui.card.classList.contains('collapsed'));
      else if (act === 'settings' || act === 'addkey') {
        if (!alive()) {
          status(STALE_MSG, 'error');
          return;
        }
        chrome.runtime.sendMessage({ type: 'openOptions' });
      } else if (act === 'keylater') ui.keyprompt.hidden = true;
      else if (act === 'translate') {
        if (activeTranslation()) {
          S.trLang = null;
          status('');
          render();
        } else translate(false);
      } else if (act === 'translate-claude') translate(true);
      else if (act === 'library') openLibrary();
      else if (act === 'dock') toggleDock();
      else if (act === 'load') load();
      else if (act === 'analyze') analyze();
      else if (act === 'copy') copyCurrent();
      else if (act === 'download') download();
      else if (act === 'prompt') copyPrompt();
      else if (act === 'paste') {
        ui.paste.hidden = false;
        ui.textarea.focus();
      } else if (act === 'paste-cancel') ui.paste.hidden = true;
      else if (act === 'paste-go') usePasted();
    });
    const grip = q('.grip');
    if (grip) {
      let dragging = false;
      grip.addEventListener('pointerdown', (ev) => {
        if (!isDocked() || ev.button !== 0) return;
        ev.preventDefault();
        dragging = true;
        grip.setPointerCapture(ev.pointerId);
        ui.card.classList.add('dragging');
      });
      grip.addEventListener('pointermove', (ev) => {
        if (dragging) setDockPx(window.innerWidth - ev.clientX, true);
      });
      const end = () => {
        if (!dragging) return;
        dragging = false;
        ui.card.classList.remove('dragging');
        setDockPx(dockPx);
      };
      grip.addEventListener('pointerup', end);
      grip.addEventListener('pointercancel', end);
      grip.addEventListener('lostpointercapture', end);
      grip.addEventListener('dblclick', () => setDockPx(SIDEBAR_PX));
      grip.addEventListener('keydown', (ev) => {
        const step = { ArrowLeft: 40, ArrowRight: -40 }[ev.key];
        if (step) {
          ev.preventDefault();
          setDockPx(clampPx(dockPx) + step);
        } else if (ev.key === 'Enter' || ev.key === 'Home') {
          ev.preventDefault();
          setDockPx(SIDEBAR_PX);
        }
      });
    }
    ui.panes.transcript.addEventListener('dblclick', (ev) => {
      const p = ev.target.closest('[data-t]');
      if (p && env.seek) {
        env.seek(Number(p.dataset.t));
        const sel = shadow.getSelection ? shadow.getSelection() : window.getSelection();
        if (sel) sel.removeAllRanges();
      }
    });

    function setCollapsed(c) {
      ui.card.classList.toggle('collapsed', c);
      ui.btn('collapse').setAttribute('aria-expanded', String(!c));
      settings.collapsed = c;
      try {
        chrome.storage.local.set({ collapsed: c });
      } catch (e) {
        /* extension reloaded */
      }
      applyLayout();
    }

    // ---------- large panel (docked to the right of the window) ----------
    const isDocked = () => canDock && settings.layout === 'dock' && !settings.collapsed;
    const clampPx = (px) => {
      const W = window.innerWidth || 1200;
      return Math.round(Math.min(Math.max(360, W - 320), Math.max(360, Number(px) || SIDEBAR_PX)));
    };
    function applyLayout(live) {
      if (!canDock) return;
      const d = isDocked();
      ui.card.classList.toggle('docked', d);
      const b = ui.btn('dock');
      if (b) {
        const label = d
          ? 'Show it as a card above the recommendations'
          : 'Pin it to the right edge (full height; drag its edge to widen)';
        b.innerHTML = d ? ICON_SHRINK : ICON_EXPAND;
        b.title = label;
        b.setAttribute('aria-label', label);
      }
      const g = q('.grip');
      const W = window.innerWidth || 1200;
      if (g) {
        g.setAttribute('aria-valuenow', String(clampPx(dockPx)));
        g.setAttribute('aria-valuemin', '360');
        g.setAttribute('aria-valuemax', String(Math.max(360, W - 320)));
      }
      if (env.onLayout) env.onLayout({ docked: d, width: clampPx(dockPx) / W, live: !!live });
    }
    function toggleDock() {
      const toDock = !isDocked();
      settings.layout = toDock ? 'dock' : 'sidebar';
      settings.collapsed = false;
      ui.card.classList.remove('collapsed');
      ui.btn('collapse').setAttribute('aria-expanded', 'true');
      try {
        chrome.storage.local.set({ layout: settings.layout, collapsed: false });
      } catch (e) {
        /* extension reloaded */
      }
      applyLayout();
      if (!toDock && env.reveal) env.reveal();
    }
    function setDockPx(px, live) {
      dockPx = clampPx(px); // not saved: the next video opens at the sidebar width again
      applyLayout(live);
    }
    function openLibrary() {
      if (!alive()) {
        status(STALE_MSG, 'error');
        return;
      }
      chrome.runtime.sendMessage({ type: 'openLibrary', key: S.items ? keyOf(S) : null });
    }

    function status(msg, kind) {
      ui.status.textContent = msg || '';
      ui.status.dataset.kind = kind || '';
    }

    function setTab(t) {
      tab = t;
      shadow.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
      for (const k of Object.keys(ui.panes)) ui.panes[k].hidden = k !== t;
      ui.subbar.hidden = t !== 'transcript' || !S.units || (!S.speakers && !S.analysis && !hasDistilled(S));
      if (t === 'insights' && ui.cmap && !ui.cmap.firstChild) drawConceptMap();
    }

    function goToItem(tabName, id) {
      setTab(tabName);
      const target = ui.panes[tabName].querySelector('[data-id="' + id + '"]');
      if (target) {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target.classList.remove('flash');
        void target.offsetWidth;
        target.classList.add('flash');
      }
    }

    function refreshButtons() {
      const has = !!S.units,
        busy = !!S.busy;
      const load = ui.btn('load');
      if (load) {
        load.disabled = busy;
        load.textContent = has ? 'Reload transcript' : 'Get transcript';
        load.classList.toggle('primary', !has);
      }
      const an = ui.btn('analyze');
      an.disabled = busy || !has;
      an.classList.toggle('primary', has && !S.analysis);
      an.textContent = S.analysis || hasDistilled(S) ? 'Re-analyze' : 'Analyze with Claude';
      for (const a of ['prompt', 'copy', 'download'])
        shadow.querySelectorAll('[data-act="' + a + '"]').forEach((b) => {
          b.disabled = !has;
        });
      ui.btn('paste-go').disabled = busy;
      renderTranslateBar();
    }

    const colorClass = (id) => {
      const i = (S.speakers || []).findIndex((s) => s.id === id);
      return 's' + ((i < 0 ? 0 : i) % 6);
    };

    function render() {
      refreshButtons();
      ui.tabs.hidden = !S.units;
      const nCo = S.analysis && S.analysis.companies ? S.analysis.companies.length : 0;
      q('[data-tab="companies"]').textContent = nCo ? 'Companies (' + nCo + ')' : 'Companies';
      ui.src.textContent = S.source ? 'Source: ' + S.source : '';
      showSpendLine();
      ui.speakers.textContent = '';
      (S.speakers || []).forEach((s) => {
        const c = el('span', 'chip');
        c.append(el('b', colorClass(s.id), s.name));
        if (s.role) c.append(el('span', 'r', ' · ' + s.role));
        c.title =
          (s.confidence && s.confidence !== 'high' ? s.confidence + ' confidence' : '') +
          (s.evidence ? (s.confidence && s.confidence !== 'high' ? ' — ' : '') + s.evidence : '');
        ui.speakers.append(c);
      });
      ui.seg.hidden = !hasDistilled(S);
      ui.seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.view === currentView()));
      renderTranscript();
      renderInsights();
      renderCompanies();
      setTab(tab);
    }

    function appendHighlighted(parent, text, matcher, companies) {
      for (const part of C.splitHighlights(text, matcher)) {
        if (part.company == null) {
          parent.append(document.createTextNode(part.text));
          continue;
        }
        const m = el('mark', 'co', part.text);
        m.dataset.co = String(part.company);
        const c = companies[part.company];
        if (c) m.title = c.name + ' — ' + c.why;
        parent.append(m);
      }
    }

    function conceptTagsByTurn(turnsList) {
      const map = new Map();
      const A = S.analysis;
      if (!A || !A.concepts || A.turnCount !== turnsList.length) return map;
      A.concepts.forEach((c, i) => {
        const t = Number(c.turn);
        if (!t) return;
        if (!map.has(t)) map.set(t, []);
        map.get(t).push({ i, name: c.concept });
      });
      return map;
    }

    function renderTranscript() {
      const pane = ui.panes.transcript;
      pane.textContent = '';
      if (!S.units) {
        pane.append(
          el(
            'p',
            'empty',
            isLib
              ? 'Pick a transcript from your Library.'
              : standalone
                ? 'Paste a transcript above and click “Clean transcript”.'
                : 'Click “Get transcript” for a clean, timestamp-free transcript of this video, or paste one. “Analyze with Claude” then labels speakers and pulls out themes, concepts and companies.'
          )
        );
        return;
      }
      if (!S.units.length) {
        pane.append(el('p', 'empty', 'The transcript came back empty.'));
        return;
      }
      const A = S.analysis;
      const companies = (A && A.companies) || [];
      const matcher = C.companyMatcher(companies);
      const turnsList = turnsOf(S);
      const tags = conceptTagsByTurn(turnsList);
      const addTags = (frag, turnIds) => {
        for (const id of turnIds)
          for (const t of tags.get(id) || []) {
            const b = el('button', 'ctag', t.name);
            b.dataset.concept = String(t.i);
            frag.append(b);
          }
      };
      const frag = document.createDocumentFragment();
      const tr = activeTranslation();
      let pi = 0;
      const shownText = (orig) => {
        const t = tr && tr.texts[pi];
        pi++;
        return t ? t : orig;
      };
      if (currentView() === 'distilled') {
        const groups = C.distilledGroups(turnsList, S.distilled);
        if (groups.some((g) => g.fallback))
          frag.append(el('p', 'note', 'Some parts couldn’t be distilled and are shown verbatim.'));
        for (const g of groups) {
          const name = C.speakerName(g.speaker, S.speakers);
          addTags(frag, g.turns);
          g.paras.forEach((ptext, i) => {
            const p = el('p', 'para' + (i ? ' cont' : ''));
            if (i === 0 && g.start != null) {
              p.dataset.t = String(g.start);
              p.title = 'Double-click to jump to ' + C.secToTs(g.start);
            }
            if (i === 0 && name)
              p.append(el('span', 'spk ' + colorClass(g.speaker), name + ':'), document.createTextNode(' '));
            appendHighlighted(p, shownText(ptext), matcher, companies);
            frag.append(p);
          });
        }
      } else {
        const unitTurn = new Array(S.units.length);
        turnsList.forEach((t) => {
          for (let i = t.unitFrom; i <= t.unitTo; i++) unitTurn[i] = t.idx;
        });
        const shown = new Set();
        for (const para of parasOf(S)) {
          if (para.chapter) frag.append(el('h4', 'chapter', para.chapter));
          const tId = unitTurn[para.unitFrom];
          if (tId && !shown.has(tId)) {
            shown.add(tId);
            addTags(frag, [tId]);
          }
          const p = el('p', 'para' + (para.cont ? ' cont' : ''));
          if (para.start != null) {
            p.dataset.t = String(para.start);
            p.title = 'Double-click to jump to ' + C.secToTs(para.start);
          }
          const name = C.speakerName(para.speaker, S.speakers);
          if (name && !para.cont)
            p.append(el('span', 'spk ' + colorClass(para.speaker), name + ':'), document.createTextNode(' '));
          else if (para.changeMarked) p.append(el('span', 'dash', '— '));
          appendHighlighted(p, shownText(para.text), matcher, companies);
          frag.append(p);
        }
      }
      pane.append(frag);
    }

    function emptyAnalysisNote(pane, what) {
      pane.append(
        el(
          'p',
          'empty',
          !S.units
            ? 'Load a transcript first.'
            : settings.hasKey
              ? 'Click “Analyze with Claude” to get ' + what + '.'
              : 'Click “Analyze with Claude” to get ' +
                what +
                ' (it uses your own Anthropic API key, stored locally). Or use “Copy prompt for claude.ai” below and paste it into a chat.'
        )
      );
    }

    function renderInsights() {
      const pane = ui.panes.insights;
      pane.textContent = '';
      const A = S.analysis;
      if (!A) {
        emptyAnalysisNote(pane, 'the summary, key themes, concepts explained and key learnings');
        return;
      }
      const whoEl = (s) => el('span', 'who', ' — ' + (s || 'Speaker'));
      const h = (t) => pane.append(el('h4', null, t));
      if (A.summary) {
        h('Summary');
        pane.append(el('p', 'summary', A.summary));
      }
      if (A.themes && A.themes.length) {
        h('Key themes');
        const ol = el('ol');
        A.themes.forEach((t) => {
          const li = el('li', 'theme');
          li.append(el('b', null, t.theme), document.createTextNode(' — ' + (t.context || '')));
          if (t.speakers && t.speakers.length) li.append(el('span', 'who', ' (' + t.speakers.join(', ') + ')'));
          ol.append(li);
        });
        pane.append(ol);
      }
      if (A.concepts && A.concepts.length) {
        h('Concepts explained');
        A.concepts.forEach((c, i) => {
          const box = el('div', 'concept');
          box.dataset.id = 'concept-' + i;
          box.append(el('h5', null, c.concept));
          if (c.explained_by) box.append(el('p', 'by', 'Explained by ' + c.explained_by));
          const ol = el('ol');
          (c.points || []).forEach((p) => ol.append(el('li', null, p)));
          box.append(ol);
          pane.append(box);
        });
      }
      const list = (title, arr, fill) => {
        if (!arr || !arr.length) return;
        h(title);
        const ul = el('ul');
        arr.forEach((x) => {
          const li = el('li');
          fill(li, x);
          ul.append(li);
        });
        pane.append(ul);
      };
      list('How they do things', A.how_they_do_it, (li, x) => {
        li.append(el('b', null, x.point || ''));
        if (x.detail) li.append(document.createTextNode(' ' + x.detail));
        li.append(whoEl(x.speaker));
      });
      list('How they see things', A.how_they_see_it, (li, x) => {
        li.append(el('b', null, x.view || ''));
        if (x.detail) li.append(document.createTextNode(' ' + x.detail));
        li.append(whoEl(x.speaker));
      });
      if (A.strong_statements && A.strong_statements.length) {
        h('Strong statements');
        A.strong_statements.forEach((x) => {
          const bq = el('blockquote');
          bq.append(el('span', 'q', '“' + String(x.quote || '').replace(/^["“]|["”]$/g, '') + '”'));
          bq.append(el('span', 'by', '— ' + (x.speaker || 'Speaker') + (x.context ? ', ' + x.context : '')));
          pane.append(bq);
        });
      }
      list('Facts & figures', A.facts_and_figures, (li, x) => {
        li.append(document.createTextNode(x.fact || ''));
        li.append(whoEl(x.speaker));
      });
      const g = C.conceptGraph(A);
      if (g.nodes.length >= 2 && g.edges.length) {
        h('How the concepts connect');
        pane.append(el('p', 'cmap-note', 'Click a concept to see its breakdown.'));
        const box = el('div', 'cmap');
        pane.append(box);
        ui.cmap = box;
        drawConceptMap();
      } else ui.cmap = null;
    }

    const SVGNS = 'http://www.w3.org/2000/svg';
    const svgEl = (tag, attrs, text) => {
      const e = document.createElementNS(SVGNS, tag);
      for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
      if (text != null) e.textContent = text;
      return e;
    };
    let lastMapWidth = 0;
    function drawConceptMap() {
      const box = ui.cmap;
      if (!box || !S.analysis) return;
      const width = Math.round(box.clientWidth || 0);
      if (!width) return; // hidden tab: drawn when the Insights tab is shown
      lastMapWidth = width;
      box.textContent = '';
      const g = C.conceptGraph(S.analysis);
      const used = new Set();
      g.edges.forEach((e) => {
        used.add(e.from);
        used.add(e.to);
      });
      const keep = g.nodes.filter((n) => used.has(n.i));
      const idx = new Map(keep.map((n, k) => [n.i, k]));
      const L = C.layoutConceptMap(
        {
          nodes: keep,
          edges: g.edges.map((e) => ({ from: idx.get(e.from), to: idx.get(e.to), relation: e.relation }))
        },
        width
      );
      const svg = svgEl('svg', {
        viewBox: '0 0 ' + L.width + ' ' + L.height,
        width: L.width,
        height: L.height,
        role: 'img',
        'aria-label':
          'Concept map: ' +
          g.edges.map((e) => g.nodes[e.from].name + ' ' + e.relation + ' ' + g.nodes[e.to].name).join('; ')
      });
      const defs = svgEl('defs');
      const marker = svgEl('marker', {
        id: 'ytct-arrow',
        viewBox: '0 0 10 10',
        refX: '9',
        refY: '5',
        markerWidth: '7',
        markerHeight: '7',
        orient: 'auto-start-reverse'
      });
      marker.append(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', class: 'arrow' }));
      defs.append(marker);
      svg.append(defs);
      for (const e of L.edges) svg.append(svgEl('path', { d: e.d, class: 'edge', 'marker-end': 'url(#ytct-arrow)' }));
      for (const nd of L.nodes) {
        const grp = svgEl('g', { class: 'node', tabindex: '0', 'data-concept': String(keep[nd.i].i) });
        grp.append(svgEl('title', {}, keep[nd.i].name + (keep[nd.i].by ? ' — explained by ' + keep[nd.i].by : '')));
        grp.append(svgEl('rect', { x: nd.x, y: nd.y, width: nd.w, height: nd.h, rx: 10 }));
        const top = nd.y + nd.h / 2 - ((nd.lines.length - 1) * 15) / 2 + 4;
        nd.lines.forEach((ln, k) =>
          grp.append(svgEl('text', { x: nd.x + nd.w / 2, y: top + k * 15, 'text-anchor': 'middle' }, ln))
        );
        grp.addEventListener('click', () => goToItem('insights', 'concept-' + keep[nd.i].i));
        grp.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            goToItem('insights', 'concept-' + keep[nd.i].i);
          }
        });
        svg.append(grp);
      }
      for (const e of L.edges) {
        if (!e.relation) continue;
        const lab = svgEl('g', { class: 'lab' });
        lab.append(svgEl('rect', { x: e.lx - e.lw / 2, y: e.ly - 9, width: e.lw, height: 18, rx: 9 }));
        lab.append(svgEl('text', { x: e.lx, y: e.ly + 3.5, 'text-anchor': 'middle' }, e.relation));
        svg.append(lab);
      }
      box.append(svg);
    }
    new ResizeObserver(() => {
      if (ui.cmap && ui.cmap.isConnected && Math.abs((ui.cmap.clientWidth || 0) - lastMapWidth) > 8) drawConceptMap();
    }).observe(ui.panes.insights);

    function renderCompanies() {
      const pane = ui.panes.companies;
      pane.textContent = '';
      const A = S.analysis;
      if (!A) {
        emptyAnalysisNote(pane, 'every company mentioned and why');
        return;
      }
      if (!A.companies || !A.companies.length) {
        pane.append(el('p', 'empty', 'No companies were mentioned.'));
        return;
      }
      pane.append(el('h4', null, 'Companies mentioned'));
      A.companies.forEach((c, i) => {
        const d = el('div', 'co-item');
        d.dataset.id = 'co-' + i;
        const b = el('b', null, c.name);
        d.append(b);
        if (c.type && c.type !== 'company') d.append(el('span', 'type', c.type));
        d.append(document.createTextNode(' — ' + (c.why || '')));
        if (c.mentioned_by && c.mentioned_by.length)
          d.append(el('span', 'who', ' (' + c.mentioned_by.join(', ') + ')'));
        pane.append(d);
      });
    }

    // ---------- Claude ----------
    const isFatal = (e) =>
      /NO_KEY|^40[13]|credit|billing|invalid x-api-key|model|context invalidated/i.test(String(e && e.message));
    const STALE_MSG =
      'This page is still running the copy of the extension from before it was reloaded. Refresh the page (⌘R / Ctrl+R) and try again.';
    const alive = () => {
      try {
        return !!(chrome.runtime && chrome.runtime.id);
      } catch (e) {
        return false;
      }
    };
    function friendly(e) {
      const m = String((e && e.message) || e);
      if (/context invalidated|Receiving end does not exist/i.test(m)) return STALE_MSG;
      if (m === 'NO_KEY') return 'Add your Anthropic API key in Settings first.';
      if (/^401|invalid x-api-key|authentication/i.test(m))
        return 'Claude rejected the API key — check it in Settings.';
      if (/^429|rate/i.test(m)) return 'Claude is rate-limiting requests — wait a minute and try again.';
      if (/^529|overloaded/i.test(m)) return 'Claude is overloaded right now — try again shortly.';
      return m;
    }
    async function pool(tasks, n) {
      let i = 0;
      const worker = async () => {
        while (i < tasks.length) {
          const t = tasks[i++];
          await t();
        }
      };
      await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
    }

    function needKey(what) {
      q('.kp-what').textContent = 'To ' + (what || 'analyze') + ' with Claude, add your Anthropic API key.';
      ui.keyprompt.hidden = false;
      status('');
      ui.btn('addkey').focus();
    }

    const CHEAP_MODEL = 'claude-haiku-5-5'; // used for translating with Claude

    // ---------- translating the transcript ----------
    // Free first: Chrome's built-in translator runs on this computer. If it can't (older Chrome, an unsupported
    // language, or it fails here), the user can choose Claude Haiku, the cheapest model, after seeing the estimate.
    // Every translation is saved with the transcript, so showing it again costs nothing.
    function withTimeout(promise, ms) {
      let t;
      return Promise.race([
        promise,
        new Promise((_, reject) => {
          t = setTimeout(() => reject(new Error('timed out')), ms);
        })
      ]).finally(() => clearTimeout(t));
    }
    function browserLang() {
      return C.pickLanguage(navigator.language) || 'en';
    }
    function viewTexts() {
      if (!S.units || !S.units.length) return [];
      if (currentView() === 'distilled') {
        const out = [];
        for (const g of C.distilledGroups(turnsOf(S), S.distilled)) out.push(...g.paras);
        return out;
      }
      return parasOf(S).map((p) => p.text);
    }
    function trKeyOf(lang, texts) {
      return lang + ':' + currentView() + ':' + hashText(texts.join('\n'));
    }
    function activeTranslation() {
      if (!S.trLang || !S.translations) return null;
      return S.translations[trKeyOf(S.trLang, viewTexts())] || null; // none for this view (e.g. after switching to Verbatim): show the original
    }
    function estimateTranslate(texts) {
      const words = texts.reduce((a, t) => a + wordsIn(t), 0);
      if (!words) return 0;
      const p = PRICES['claude-haiku-5-5'];
      return ((words * 1.4 + 300 * Math.ceil(words / 1500)) / 1e6) * p.in + ((words * 2) / 1e6) * p.out;
    }
    function centsText(c) {
      return c < 0.01 ? 'under 1¢' : c < 1 ? 'about ' + Math.round(c * 100) + '¢' : 'about $' + c.toFixed(2);
    }

    function renderTranslateBar() {
      const tr = activeTranslation();
      ui.trlang.value = S.trLang || settings.translateTo || browserLang();
      if (!ui.trlang.value) ui.trlang.value = 'en';
      const to = ui.trlang.value;
      const has = !!(S.units && S.units.length);
      const tBtn = ui.btn('translate'),
        cBtn = ui.btn('translate-claude');
      tBtn.disabled = ui.trlang.disabled = !has || !!S.busy;
      tBtn.textContent = tr ? 'Show original' : 'Translate';
      tBtn.title = tr
        ? 'Back to the original transcript'
        : 'Translate the transcript (free with Chrome’s built-in translator)';
      const offer = !tr && S.trOffer && S.trOffer.to === to ? S.trOffer : null;
      cBtn.hidden = !offer;
      cBtn.disabled = !!S.busy;
      if (offer) cBtn.textContent = 'Translate with Claude Haiku (' + centsText(estimateTranslate(viewTexts())) + ')';
      ui.trnote.textContent = tr
        ? 'Showing ' +
          C.langName(tr.lang) +
          (tr.from ? ', translated from ' + C.langName(tr.from) : '') +
          (tr.via === 'chrome'
            ? ', for free by Chrome on your computer.'
            : ', by Claude Haiku' + (tr.cost ? ' for ' + centsText(tr.cost) : '') + '.')
        : offer
          ? offer.why
          : '';
      ui.trinfo.hidden = !tr && !offer;
    }

    async function detectSource(T, texts) {
      if (T.srcLang) return T.srcLang;
      // 1) Instant offline guess from the text itself. 2) Chrome's language detector, which may need to download first.
      let code = C.guessLanguage(texts.join(' '));
      if (!code && typeof LanguageDetector !== 'undefined') {
        try {
          const d = await withTimeout(LanguageDetector.create(), 20000);
          const r = await withTimeout(d.detect(texts.join(' ').slice(0, 3000)), 20000);
          if (r && r[0] && r[0].confidence >= 0.5 && r[0].detectedLanguage !== 'und') code = r[0].detectedLanguage;
          try {
            if (d.destroy) d.destroy();
          } catch (e) {
            /* ignore */
          }
        } catch (e) {
          /* not available here: Claude can work it out */
        }
      }
      T.srcLang = C.pickLanguage(code) || code || '';
      return T.srcLang;
    }

    async function translateOnDevice(T, texts, from, to, key) {
      if (typeof Translator === 'undefined') return 'missing';
      if (!from) return 'unknown';
      if (!C.pickLanguage(from)) return 'unsupported';
      let tr = null;
      try {
        const avail = await Translator.availability({ sourceLanguage: from, targetLanguage: to });
        if (avail === 'unavailable') return 'unsupported';
        if (S === T) status('Getting Chrome’s free translator ready…', 'work');
        // Chrome may wait forever if it can't download the model (offline, blocked by policy), so give up
        // if nothing has happened for 45 seconds; a download that keeps making progress can take longer.
        let lastSign = Date.now();
        const creating = Translator.create({
          sourceLanguage: from,
          targetLanguage: to,
          monitor(m) {
            m.addEventListener('downloadprogress', (e) => {
              lastSign = Date.now();
              if (S === T)
                status(
                  'Downloading Chrome’s free ' +
                    C.langName(from) +
                    ' → ' +
                    C.langName(to) +
                    ' translator (one time only)… ' +
                    Math.round((e.loaded || 0) * 100) +
                    '%',
                  'work'
                );
            });
          }
        });
        tr = await new Promise((resolve, reject) => {
          const iv = setInterval(() => {
            if (Date.now() - lastSign > 45000) {
              clearInterval(iv);
              reject(new Error('stalled'));
            }
          }, 1000);
          creating.then(
            (t) => {
              clearInterval(iv);
              resolve(t);
            },
            (e) => {
              clearInterval(iv);
              reject(e);
            }
          );
        }).catch((e) => {
          creating.then(
            (t) => {
              try {
                t.destroy();
              } catch (x) {
                /* ignore */
              }
            },
            () => {}
          );
          throw e;
        });
        const out = new Array(texts.length).fill('');
        for (let i = 0; i < texts.length; i++) {
          if (S === T && i % 4 === 0)
            status(
              'Translating with Chrome (free, on your computer)… ' + i + ' of ' + texts.length + ' paragraphs',
              'work'
            );
          if (String(texts[i] || '').trim()) out[i] = String(await withTimeout(tr.translate(texts[i]), 60000));
        }
        T.translations[key] = { lang: to, from, via: 'chrome', at: Date.now(), texts: out };
        if (S === T) status('');
        return 'ok';
      } catch (e) {
        return 'failed';
      } finally {
        try {
          if (tr && tr.destroy) tr.destroy();
        } catch (e) {
          /* ignore */
        }
      }
    }
    function offerReason(r, from, to) {
      const why =
        r === 'missing'
          ? 'Chrome’s free translator isn’t available in this browser (it needs desktop Chrome 138 or later).'
          : r === 'unknown'
            ? 'Couldn’t tell which language the transcript is in, so Chrome’s free translator can’t run.'
            : r === 'unsupported'
              ? 'Chrome’s free translator can’t do ' +
                (C.langName(from) || 'this language') +
                ' → ' +
                C.langName(to) +
                '.'
              : 'Chrome’s free translator couldn’t run here. Click Translate to try again.';
      return why + ' Or use Claude Haiku, the cheapest Claude model (uses your API key).';
    }

    async function translateWithClaude(T, texts, from, to, key) {
      const reqs = C.buildTranslateRequests(texts, from, to);
      const out = new Array(texts.length).fill('');
      let done = 0,
        failed = 0,
        err = '';
      const meter = newMeter();
      if (S === T) status('Translating with Claude Haiku… 0/' + reqs.length, 'work');
      try {
        await pool(
          reqs.map((r) => async () => {
            try {
              const res = await callClaude(Object.assign({}, r.req, { model: CHEAP_MODEL }));
              meterAdd(meter, res);
              for (const p of (res && res.input && res.input.paragraphs) || []) {
                const i = Number(p && p.n) - 1;
                if (r.idx.includes(i)) out[i] = String(p.text || '');
              }
            } catch (e) {
              failed++;
              err = friendly(e);
              if (isFatal(e)) throw e;
            } finally {
              done++;
              if (S === T) status('Translating with Claude Haiku… ' + done + '/' + reqs.length, 'work');
            }
          }),
          3
        );
      } catch (e) {
        /* fatal error already recorded */
      }
      addToSpend(meter);
      T.costTotal = (T.costTotal || 0) + meter.cost;
      const got = out.filter(Boolean).length;
      if (got)
        T.translations[key] = {
          lang: to,
          from,
          via: 'claude',
          at: Date.now(),
          cost: meter.known ? meter.cost : null,
          texts: out
        };
      if (S === T) {
        if (!got) status('Couldn’t translate the transcript: ' + (err || 'unknown error'), 'error');
        else if (failed)
          status(
            failed +
              ' part' +
              (failed > 1 ? 's' : '') +
              ' couldn’t be translated and ' +
              (failed > 1 ? 'are' : 'is') +
              ' shown in the original language.',
            'error'
          );
        else status('');
      }
      return !!got;
    }

    async function translate(viaClaude) {
      const T = S;
      if (!T.units || !T.units.length || T.busy) return;
      if (!alive()) {
        status(STALE_MSG, 'error');
        return;
      }
      const to = ui.trlang.value;
      const texts = viewTexts();
      if (!texts.length) return;
      const key = trKeyOf(to, texts);
      T.translations = T.translations || {};
      if (T.translations[key]) {
        T.trLang = to;
        tab = 'transcript';
        status('');
        render();
        return;
      }
      if (viaClaude && !settings.hasKey) {
        needKey('translate this transcript');
        return;
      }
      T.busy = true;
      T.trOffer = null;
      ui.keyprompt.hidden = true;
      render();
      status('Checking the transcript’s language…', 'work');
      const from = await detectSource(T, texts);
      if (from && C.sameLanguage(from, to)) {
        T.busy = false;
        if (S === T) {
          status('This transcript is already in ' + C.langName(to) + '. Pick another language to translate it into.');
          render();
        }
        return;
      }
      let ok;
      if (viaClaude) ok = await translateWithClaude(T, texts, from, to, key);
      else {
        const r = await translateOnDevice(T, texts, from, to, key);
        ok = r === 'ok';
        if (!ok) {
          T.trOffer = { to, why: offerReason(r, from, to) };
          if (S === T) status('');
        }
      }
      T.busy = false;
      if (ok) {
        T.trLang = to;
        if (S === T) tab = 'transcript';
      }
      if (S === T) render();
      if (ok) saveCache(T);
    }

    // Always-visible line under the card: running total + what this video has cost.
    async function showSpendLine() {
      if (!ui.spend || !alive()) return;
      let spend = null;
      try {
        spend = (await chrome.storage.local.get(['spend'])).spend;
      } catch (e) {
        return;
      }
      const parts = [
        spend && spend.runs
          ? 'Spent so far: about ' + money(spend.total) + ' over ' + spend.runs + ' run' + (spend.runs === 1 ? '' : 's')
          : 'Spent so far: $0'
      ];
      if (S.costTotal) parts.push('this ' + (standalone ? 'transcript' : 'video') + ': about ' + money(S.costTotal));
      ui.spend.textContent = parts.join(' · ');
    }

    // One Claude call: speakers + all insights from a single read of the transcript.
    async function analyze() {
      const T = S;
      if (!T.units || T.busy) return;
      if (!alive()) {
        status(STALE_MSG, 'error');
        return;
      }
      if (!settings.hasKey) {
        needKey('analyze');
        return;
      }
      T.busy = true;
      T.speakers = null;
      T.turns = null;
      T.corrections = null;
      T.analysis = null;
      T.distilled = null;
      render();
      const t0 = Date.now();
      const tick = setInterval(() => {
        if (S === T) status('Analyzing with Claude… ' + Math.round((Date.now() - t0) / 1000) + 's', 'work');
      }, 1000);
      status('Analyzing with Claude…', 'work');
      try {
        const meter = newMeter();
        const res = await callClaude(C.buildCombinedRequest(T.meta, T.units, settings.focus, settings.analysisLang));
        meterAdd(meter, res);
        addToSpend(meter);
        T.costTotal = meter.cost;
        if (!res || !res.input) throw new Error('Claude returned nothing — please try again.');
        const r = C.splitCombinedResult(res.input, T.units);
        T.speakers = r.speakers;
        T.turns = r.turns;
        T.corrections = r.corrections;
        T.speakerNotes = r.notes;
        T.unitCount = T.units.length;
        T.analysis = r.analysis;
        if (S === T) {
          const A = T.analysis;
          const bits = [
            T.speakers
              ? T.speakers.length + ' speaker' + (T.speakers.length === 1 ? '' : 's')
              : 'speakers not identified',
            (A.themes || []).length + ' themes',
            (A.concepts || []).length + ' concepts',
            (A.companies || []).length + ' companies'
          ];
          status(bits.join(' · ') + '. This analysis cost ' + meterText(meter) + '.');
        }
      } catch (e) {
        if (S === T) status(friendly(e), 'error');
      } finally {
        clearInterval(tick);
        T.busy = false;
        if (S === T) render();
        saveCache(T);
      }
    }

    // ---------- loading ----------
    async function load() {
      if (!env.fetchTranscript) return;
      if (!alive()) {
        status(STALE_MSG, 'error');
        return;
      }
      const vid = env.videoId ? env.videoId() : null;
      if (!vid) return;
      if (S.videoId !== vid) S = fresh(vid);
      const T = S;
      if (T.busy) return;
      T.busy = true;
      refreshButtons();
      status('Getting the transcript from YouTube…', 'work');
      try {
        const r = await env.fetchTranscript(vid);
        T.meta = r.meta || T.meta;
        T.items = r.items;
        T.source = r.source;
        rebuildUnits(T);
        const restored = await restoreCache(T, true);
        const saved = await saveCache(T);
        if (S === T) {
          status(
            T.units.length +
              ' sentences · ' +
              totalWords(T).toLocaleString() +
              ' words' +
              (restored ? ' · restored your saved analysis' : '') +
              (saved ? ' · saved to your Library' : '')
          );
          render();
        }
      } catch (e) {
        if (S === T) status(e.message, 'error');
      } finally {
        T.busy = false;
        if (S === T) refreshButtons();
      }
    }

    async function usePasted() {
      const items = C.parseTranscriptText(ui.textarea.value);
      if (!items.length) {
        status('Nothing to clean — paste the transcript text first.', 'error');
        return;
      }
      const vid = env.videoId ? env.videoId() : null;
      S = fresh(vid);
      if (!vid) S.key = CACHE_PREFIX + 'paste-' + hashText(ui.textarea.value.replace(/\s+/g, ' ').trim());
      const T = S;
      T.items = items;
      T.source = 'pasted text';
      T.meta =
        vid && env.getMeta
          ? await env.getMeta(vid)
          : { title: (ui.ptitle && ui.ptitle.value.trim()) || 'Pasted transcript' };
      rebuildUnits(T);
      const restored = !vid && (await restoreCache(T, true)); // the same text pasted before: bring back its analysis
      ui.paste.hidden = true;
      tab = 'transcript';
      const saved = await saveCache(T);
      if (S !== T) return;
      status(
        T.units.length +
          ' sentences · ' +
          totalWords(T).toLocaleString() +
          ' words cleaned' +
          (restored ? ' · restored your saved analysis' : '') +
          (saved ? ' · saved to your Library' : '') +
          (!T.analysis ? ' — click “Analyze with Claude” for speakers, themes, concepts and companies.' : '')
      );
      render();
    }

    // ---------- exports ----------
    async function copyText(text, okMsg) {
      try {
        await navigator.clipboard.writeText(text);
        status(okMsg);
        return true;
      } catch (e) {
        const ta = el('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try {
          ok = document.execCommand('copy');
        } catch (e2) {
          /* ignore */
        }
        ta.remove();
        status(ok ? okMsg : 'Couldn’t copy — the browser blocked clipboard access.', ok ? '' : 'error');
        return ok;
      }
    }
    // The transcript as shown: distilled or verbatim, translated if a translation is showing.
    function shownView() {
      const tr = activeTranslation();
      const groups = hasDistilled(S) ? C.distilledGroups(turnsOf(S), S.distilled) : null;
      const paras = parasOf(S);
      if (!tr) return { groups, paras, tr: null };
      let i = 0;
      const pick = (orig) => {
        const t = tr.texts[i++];
        return t ? t : orig;
      };
      if (currentView() === 'distilled' && groups)
        return { groups: groups.map((g) => ({ ...g, paras: g.paras.map(pick) })), paras, tr };
      return { groups, paras: paras.map((p) => ({ ...p, text: pick(p.text) })), tr };
    }
    function transcriptText() {
      const v = shownView();
      if (currentView() === 'distilled') return C.distilledPlainText(v.groups, S.speakers);
      return C.transcriptPlainText(v.paras, S.speakers);
    }
    function copyCurrent() {
      if (!S.units) return;
      if (tab === 'insights' && S.analysis) copyText(C.insightsMarkdown(S.analysis, 2), 'Insights copied as Markdown.');
      else if (tab === 'companies' && S.analysis)
        copyText(C.companiesMarkdown(S.analysis.companies, 2), 'Company glossary copied.');
      else
        copyText(
          transcriptText(),
          activeTranslation()
            ? C.langName(S.trLang) + ' translation copied.'
            : (currentView() === 'distilled' ? 'Distilled' : 'Clean') + ' transcript copied.'
        );
    }
    function download() {
      if (!S.units) return;
      const v = shownView();
      const md = C.fullMarkdown(S.meta, {
        speakers: S.speakers,
        analysis: S.analysis,
        view: currentView(),
        groups: v.groups,
        paras: v.paras
      });
      const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
      const a = el('a');
      a.href = url;
      a.download = slug(S.meta && S.meta.title) + (v.tr ? ' (' + C.langName(v.tr.lang) + ')' : '') + '.md';
      shadow.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
    function copyPrompt() {
      if (!S.units) return;
      const text = C.buildChatPrompt(
        S.meta,
        C.transcriptPlainText(parasOf(S), S.speakers),
        settings.focus,
        !!S.speakers,
        settings.analysisLang
      );
      copyText(text, 'Prompt + transcript copied — paste it into a new chat.').then((ok) => {
        if (!ok) return;
        const a = el('a', 'link', 'Open claude.ai');
        a.href = 'https://claude.ai/new';
        a.target = '_blank';
        a.rel = 'noopener';
        ui.status.append(' ', a);
      });
    }

    // ---------- cache ----------
    const keyOf = (st) => st.key || (st.videoId ? CACHE_PREFIX + st.videoId : null);
    async function saveCache(st) {
      const key = keyOf(st);
      if (!key || !st.items || !alive()) return false;
      try {
        const prev = (await chrome.storage.local.get(key))[key];
        const rec = {
          savedAt: Date.now(),
          createdAt: (prev && (prev.createdAt || prev.savedAt)) || Date.now(),
          kind: key.startsWith(CACHE_PREFIX + 'paste-') ? 'paste' : 'youtube',
          videoId: (st.meta && st.meta.videoId) || st.videoId || null,
          meta: st.meta,
          items: st.items,
          source: st.source,
          unitCount: st.units ? st.units.length : 0,
          words: totalWords(st),
          speakers: st.speakers,
          turns: st.turns,
          corrections: st.corrections,
          speakerNotes: st.speakerNotes,
          analysis: st.analysis,
          distilled: st.distilled,
          translations: st.translations || null,
          costTotal: st.costTotal || 0
        };
        await chrome.storage.local.set({ [key]: rec });
        return true;
      } catch (e) {
        return false; /* results are still on screen */
      }
    }
    async function restoreCache(st, keepItems) {
      const key = keyOf(st);
      if (!key) return false;
      let rec = null;
      try {
        rec = (await chrome.storage.local.get(key))[key];
      } catch (e) {
        return false;
      }
      if (!rec) return false;
      if (!keepItems) {
        st.items = rec.items;
        st.source = rec.source;
        st.meta = st.meta || rec.meta;
        st.unitCount = 0;
        rebuildUnits(st);
      }
      if (rec.turns && rec.unitCount === (st.units || []).length) {
        st.speakers = rec.speakers;
        st.turns = rec.turns;
        st.corrections = rec.corrections;
        st.speakerNotes = rec.speakerNotes || '';
        st.distilled = rec.distilled || null;
      }
      if (rec.analysis) st.analysis = C.resolveSpeakerIds(rec.analysis, rec.speakers);
      st.costTotal = rec.costTotal || 0;
      st.translations = rec.translations || null;
      st.unitCount = (st.units || []).length;
      return !!(st.speakers || st.analysis || !keepItems);
    }

    // ---------- public ----------
    return {
      host,
      get state() {
        return S;
      },
      async setVideo(vid) {
        S = fresh(vid);
        tab = 'transcript';
        view = 'verbatim';
        if (dockPx !== SIDEBAR_PX) {
          dockPx = SIDEBAR_PX;
          applyLayout();
        } // every video opens at the sidebar width
        status('');
        ui.keyprompt.hidden = true;
        if (!standalone) ui.paste.hidden = true;
        render();
        const T = S;
        const restored = vid ? await restoreCache(T, false) : false;
        if (S !== T) return false;
        if (restored && T.units) {
          status(
            'Loaded your saved transcript' +
              (T.analysis ? ' and analysis' : '') +
              ': no credits used now' +
              (T.costTotal ? ' (it cost about ' + money(T.costTotal) + ' when it ran)' : '') +
              '.'
          );
          render();
        }
        return restored;
      },
      // Library viewer: show a saved transcript by its storage key.
      async openSaved(key) {
        S = fresh(null);
        S.key = key;
        tab = 'transcript';
        view = 'verbatim';
        status('');
        render();
        const T = S;
        const ok = await restoreCache(T, false);
        if (S !== T) return false;
        if (!ok) status('This transcript isn’t in your Library any more.', 'error');
        render();
        return ok;
      },
      load,
      analyze,
      isDocked,
      isLoaded: () => !!S.units,
      prefill(text, title) {
        ui.paste.hidden = false;
        ui.textarea.value = text || '';
        if (ui.ptitle && title) ui.ptitle.value = title;
      },
      toggle() {
        const collapsed = ui.card.classList.contains('collapsed');
        setCollapsed(!collapsed);
        return collapsed;
      },
      render
    };
  }

  root.YTCTPanel = {
    createPanel,
    DEFAULTS,
    claude: { call: callClaude, PRICES, newMeter, meterAdd, meterText, money, addToSpend }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
