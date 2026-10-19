/*
 * Background service worker: the only place the Anthropic API key is used.
 * Content scripts send { system, user, tool, maxTokens } over a port; we call the Messages API
 * offering one tool (tool_choice "auto") so the answer comes back as structured JSON.
 */
const DEFAULT_MODEL = 'claude-opus-5-5';
const API_URL = 'https://api.anthropic.com/v1/messages';

// Extension pages, relative to the extension root.
const PAGES = {
  analyze: 'src/pages/analyze/analyze.html',
  library: 'src/pages/library/library.html',
  options: 'src/pages/options/options.html',
  offscreenSync: 'src/pages/offscreen/sync.html'
};

async function callAnthropic(payload) {
  const { apiKey, model } = await chrome.storage.local.get({ apiKey: '', model: DEFAULT_MODEL });
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('NO_KEY');
  const body = {
    model: payload.model || model || DEFAULT_MODEL,
    max_tokens: payload.maxTokens || 8000,
    system: payload.tool ? (payload.system || '') + toolInstruction(payload.tool) : payload.system,
    messages: [{ role: 'user', content: payload.user }]
  };
  if (payload.tool) {
    body.tools = [payload.tool];
    body.tool_choice = { type: 'auto' };
    // Keep thinking (billed as output) to a minimum; dropped automatically if a model rejects it.
    body.output_config = { effort: 'low' };
  }
  const post = async () => {
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify(body)
      });
    } catch (e) {
      throw new Error('Couldn’t reach the Claude API (' + e.message + ').');
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = json && json.error && json.error.message ? json.error.message : res.statusText;
      if (res.status === 400 && body.output_config && /output_config|effort/i.test(msg)) {
        delete body.output_config;
        return post();
      }
      throw new Error(res.status + ': ' + msg);
    }
    if (json.stop_reason === 'max_tokens')
      throw new Error('Claude’s answer hit the length limit — try again, or pick a different model in Settings.');
    return json;
  };
  let json = await post();
  if (!payload.tool) {
    return {
      text: (json.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(''),
      usage: json.usage,
      model: json.model
    };
  }
  let input = pickToolInput(json, payload.tool);
  let usage = json.usage || {};
  if (!input) {
    const said = (json.content || []).filter((b) => b.type === 'text' && b.text.trim());
    if (said.length)
      body.messages = [
        { role: 'user', content: payload.user },
        { role: 'assistant', content: said },
        { role: 'user', content: 'Please call the `' + payload.tool.name + '` tool now with your complete answer.' }
      ];
    json = await post();
    input = pickToolInput(json, payload.tool);
    const u2 = json.usage || {};
    const th = (u) => (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0;
    usage = {
      input_tokens: (usage.input_tokens || 0) + (u2.input_tokens || 0),
      output_tokens: (usage.output_tokens || 0) + (u2.output_tokens || 0),
      output_tokens_details: { thinking_tokens: th(usage) + th(u2) }
    };
  }
  if (!input) throw new Error('Claude didn’t return structured output — please try again.');
  return { input, usage, model: body.model };
}

// Opus 5.5 / Sonnet 5.5 / Fable 5.1 reject forced tool use (tool_choice "tool"/"any" → 400),
// so the tool is offered with tool_choice "auto" plus an explicit instruction to use it.
// If Claude answers in text anyway, we parse JSON from the text or ask once more.
function toolInstruction(tool) {
  return (
    '\n\nAnswer only by calling the `' + tool.name + '` tool with your complete result. Do not reply in plain text.'
  );
}
function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fenced ? fenced[1] : text;
  const a = src.indexOf('{'),
    b = src.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const v = JSON.parse(src.slice(a, b + 1));
    return v && typeof v === 'object' ? v : null;
  } catch (e) {
    return null;
  }
}
function pickToolInput(data, tool) {
  const block = (data.content || []).find((b) => b.type === 'tool_use' && b.name === tool.name);
  if (block) return block.input;
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return extractJson(text);
}

// Claude requests in flight (a self-update waits until none are running).
let openPorts = 0,
  lastPortUse = 0;
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ytct-claude') return;
  openPorts++;
  lastPortUse = Date.now();
  port.onDisconnect.addListener(() => {
    openPorts = Math.max(0, openPorts - 1);
    lastPortUse = Date.now();
  });
  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.type !== 'call') return; // 'ping' messages just keep this worker awake
    try {
      const data = await callAnthropic(msg.payload || {});
      port.postMessage({ type: 'result', ok: true, data });
    } catch (e) {
      try {
        port.postMessage({ type: 'result', ok: false, error: e.message });
      } catch (_) {
        /* port closed */
      }
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
    return;
  }
  if (msg.type === 'openAnalyzer') {
    openAnalyzer();
    return;
  }
  if (msg.type === 'openLibrary') {
    openLibrary(msg.key);
    return;
  }
  // the background folder sync reads and saves the Library through here
  if (msg.type === 'syncStore') {
    (msg.op === 'get'
      ? chrome.storage.local.get(msg.keys == null ? null : msg.keys)
      : chrome.storage.local.set(msg.obj || {}).then(() => true)
    ).then(sendResponse, () => sendResponse(null));
    return true;
  }
  if (msg.type === 'syncDone') {
    syncRunning = false;
    if (chrome.offscreen) chrome.offscreen.closeDocument().catch(() => {});
    return;
  }
  if (msg.type === 'testKey') {
    callAnthropic({ system: 'Reply with the single word OK.', user: 'Ping', maxTokens: 5 })
      .then((r) => sendResponse({ ok: true, model: r.model }))
      .catch((e) => sendResponse({ ok: false, error: e.message === 'NO_KEY' ? 'No API key saved yet.' : e.message }));
    return true;
  }
});

const openAnalyzer = () => chrome.tabs.create({ url: chrome.runtime.getURL(PAGES.analyze) });

// The Library: reuse an open Library tab if there is one, and select the given transcript.
async function openLibrary(key) {
  const base = chrome.runtime.getURL(PAGES.library);
  const url = base + (key ? '#' + encodeURIComponent(key) : '');
  try {
    const ctx = chrome.runtime.getContexts ? await chrome.runtime.getContexts({ contextTypes: ['TAB'] }) : [];
    const open = (ctx || []).find((c) => c.tabId >= 0 && String(c.documentUrl || '').startsWith(base));
    if (open) {
      await chrome.tabs.update(open.tabId, { active: true, url });
      if (open.windowId >= 0) await chrome.windows.update(open.windowId, { focused: true });
      return;
    }
  } catch (e) {
    /* fall through to a new tab */
  }
  chrome.tabs.create({ url });
}

// Toolbar button: on a YouTube video it shows/hides the card; anywhere else it opens the paste-a-transcript page.
chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id && /^https:\/\/www\.youtube\.com\/watch/.test(tab.url || '')) {
    chrome.tabs.sendMessage(tab.id, { type: 'toggle' }).catch(openAnalyzer);
  } else {
    openAnalyzer();
  }
});

// Right-click on selected text anywhere: "Clean & analyze this transcript"
chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'ytct-analyze',
      title: 'Clean & analyze this transcript',
      contexts: ['selection']
    });
    chrome.contextMenus.create({ id: 'ytct-library', title: 'Open your transcript Library', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'ytct-paste', title: 'Paste a transcript', contexts: ['action'] });
  });
  // After an install, update or reload, put a fresh card on YouTube tabs that are already open,
  // so you don't have to refresh them.
  if (details.reason === 'install' || details.reason === 'update') refreshOpenYouTubeTabs();
  if (details.reason === 'update') reopenPagesAfterUpdate();
});

// #region dev-only: removed from Web Store builds by scripts/build.mjs
// ---------- self-update (unpacked installs) ----------
// Updates are written straight into this extension's folder. Once a minute we compare the version in
// manifest.json on disk with the one running; when it has changed (and no Claude request is running)
// we reload, so Chrome picks up the new files without a trip to chrome://extensions. Extension pages that
// were open (Library, paste page, settings) close on reload, so they're reopened afterwards.
const UPDATE_ALARM = 'ytct-update-check';
chrome.alarms.get(UPDATE_ALARM, (a) => {
  if (!a) chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 1 });
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === UPDATE_ALARM) checkForUpdate();
});
async function checkForUpdate() {
  try {
    const me = await chrome.management.getSelf();
    if (me.installType !== 'development') return; // Web Store installs update themselves
    const res = await fetch(chrome.runtime.getURL('manifest.json') + '?t=' + Date.now(), { cache: 'no-store' });
    const disk = await res.json();
    const running = chrome.runtime.getManifest().version;
    if (!disk || !disk.version || disk.version === running) return;
    if (openPorts > 0 || Date.now() - lastPortUse < 120000) return; // something is running: try again next minute
    const ctx = chrome.runtime.getContexts ? await chrome.runtime.getContexts({ contextTypes: ['TAB'] }) : [];
    const reopen = [...new Set((ctx || []).map((c) => c.documentUrl).filter(Boolean))].slice(0, 6);
    await chrome.storage.local.set({ updateNote: { from: running, to: disk.version, at: Date.now(), reopen } });
    chrome.runtime.reload();
  } catch (e) {
    /* manifest mid-write or unreadable: try again next minute */
  }
}
// #endregion dev-only

// Pages that were open before an update are reopened afterwards (pages from before v1.16 lived at the root).
const LEGACY_PAGES = { 'analyze.html': PAGES.analyze, 'library.html': PAGES.library, 'options.html': PAGES.options };
async function reopenPagesAfterUpdate() {
  try {
    const { updateNote } = await chrome.storage.local.get('updateNote');
    if (
      !updateNote ||
      !Array.isArray(updateNote.reopen) ||
      !updateNote.reopen.length ||
      Date.now() - updateNote.at > 5 * 60000
    )
      return;
    const base = chrome.runtime.getURL('');
    for (const old of updateNote.reopen) {
      if (!String(old).startsWith(base)) continue;
      const path = String(old)
        .slice(base.length)
        .replace(/^[^#?]+/, (p) => LEGACY_PAGES[p] || p);
      await chrome.tabs.create({ url: base + path, active: false });
    }
    await chrome.storage.local.set({ updateNote: { ...updateNote, reopen: [] } });
  } catch (e) {
    /* not critical */
  }
}

// Inject the content scripts declared in manifest.json into YouTube tabs that were already open.
async function refreshOpenYouTubeTabs() {
  const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' }).catch(() => []);
  const scripts = chrome.runtime.getManifest().content_scripts || [];
  let n = 0;
  for (const t of tabs) {
    try {
      for (const cs of scripts) {
        await chrome.scripting.executeScript({
          target: { tabId: t.id },
          files: cs.js,
          world: cs.world === 'MAIN' ? 'MAIN' : 'ISOLATED'
        });
      }
      n++;
    } catch (e) {
      /* tab closed, discarded or not a page we can script */
    }
  }
  return n;
}
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'ytct-library') {
    openLibrary();
    return;
  }
  if (info.menuItemId === 'ytct-paste') {
    openAnalyzer();
    return;
  }
  if (info.menuItemId !== 'ytct-analyze' || !info.selectionText) return;
  await chrome.storage.session.set({ pendingText: { text: info.selectionText, title: (tab && tab.title) || '' } });
  openAnalyzer();
});

// ---------- keep the synced folder current (for Claude) ----------
// When the Library changes and you've chosen a folder, write the changes there, even if the Library page
// isn't open (an open Library page syncs itself). Uses a short-lived offscreen page, which can write files.
let syncTimer = null,
  syncRunning = false;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!Object.keys(changes).some((k) => k.startsWith('cache:') || k === 'trends:report' || k === 'net:graph')) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(backgroundSync, 4000);
});
async function backgroundSync() {
  try {
    const { syncEnabled } = await chrome.storage.local.get('syncEnabled');
    if (!syncEnabled || !chrome.offscreen || syncRunning) return;
    const base = chrome.runtime.getURL(PAGES.library);
    const ctx = chrome.runtime.getContexts ? await chrome.runtime.getContexts({ contextTypes: ['TAB'] }) : [];
    if ((ctx || []).some((c) => String(c.documentUrl || '').startsWith(base))) return; // the open Library does it
    syncRunning = true;
    setTimeout(() => {
      if (syncRunning) {
        syncRunning = false;
        chrome.offscreen.closeDocument().catch(() => {});
      }
    }, 120000);
    await chrome.offscreen.createDocument({
      url: PAGES.offscreenSync,
      reasons: ['BLOBS'],
      justification: 'Write your transcript Library to the folder you chose, so Claude can read it.'
    });
  } catch (e) {
    syncRunning = false; /* a sync page is already open, or offscreen isn't available */
  }
}
