/*
 * YouTube content script: places the shared transcript card on watch pages and provides the
 * YouTube-specific pieces — reading the transcript by letting YouTube open its own transcript panel
 * (then closing it again), video metadata, seeking, and single-page-app navigation.
 */
(() => {
  'use strict';
  if (window.__ytctContent) return;
  window.__ytctContent = true;

  const C = globalThis.YTCT;
  const PANEL_SEL = 'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]';
  const captures = new Map(); // videoId -> items captured from YouTube's own transcript response
  const domSigs = new Map(); // DOM transcript signature -> videoId it belonged to
  const metaWaiters = new Map();
  let keepYouTubePanel = false;
  let autoLoad = false;
  chrome.storage.local.get({ keepYouTubePanel: false, autoLoad: false }, (s) => {
    keepYouTubePanel = !!s.keepYouTubePanel;
    autoLoad = !!s.autoLoad;
  });
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== 'local') return;
    if ('keepYouTubePanel' in c) keepYouTubePanel = !!c.keepYouTubePanel.newValue;
    if ('autoLoad' in c) autoLoad = !!c.autoLoad.newValue;
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const currentVideoId = () => {
    try {
      return new URL(location.href).searchParams.get('v');
    } catch (e) {
      return null;
    }
  };
  const isWatch = () => location.pathname === '/watch' && !!currentVideoId();

  // ---------- messages from the page hook (MAIN world) ----------
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.source !== 'ytct-hook') return;
    if (d.type === 'transcript' && d.videoId && Array.isArray(d.items)) captures.set(d.videoId, sanitizeItems(d.items));
    if (d.type === 'meta' && metaWaiters.has(d.reqId)) {
      metaWaiters.get(d.reqId)(d.meta || null);
      metaWaiters.delete(d.reqId);
    }
  });

  function sanitizeItems(items) {
    return items
      .slice(0, 30000)
      .map((i) => ({
        type: i && i.type === 'chapter' ? 'chapter' : 'seg',
        start: i && Number.isFinite(+i.start) ? +i.start : null,
        text: String((i && i.text) || '').slice(0, 2000)
      }))
      .filter((i) => i.text);
  }

  function requestMeta() {
    return new Promise((resolve) => {
      const reqId = Math.random().toString(36).slice(2);
      metaWaiters.set(reqId, resolve);
      window.postMessage({ source: 'ytct-content', type: 'meta', reqId }, location.origin);
      setTimeout(() => {
        if (metaWaiters.has(reqId)) {
          metaWaiters.delete(reqId);
          resolve(null);
        }
      }, 1500);
    });
  }

  async function getMeta(vid) {
    for (let i = 0; i < 6; i++) {
      const m = await requestMeta();
      if (m && m.videoId === vid) return m;
      await sleep(400);
    }
    const title =
      (document.querySelector('ytd-watch-metadata h1') || {}).textContent || document.title.replace(/ - YouTube$/, '');
    const channel =
      (document.querySelector('ytd-watch-metadata ytd-channel-name a, #owner ytd-channel-name a') || {}).textContent ||
      '';
    return { videoId: vid, title: title.trim(), channel: channel.trim(), description: '' };
  }

  // ---------- reading YouTube's transcript ----------
  // YouTube has two transcript UIs in the wild: the classic one (ytd-transcript-segment-renderer)
  // and a newer one (transcript-segment-view-model, sometimes in a differently-named panel, and
  // virtualised so only visible lines exist until you scroll). Both are handled here.
  function findTranscriptPanel() {
    const seg = document.querySelector('transcript-segment-view-model, ytd-transcript-segment-renderer');
    const around = seg && seg.closest('ytd-engagement-panel-section-list-renderer');
    if (around) return around;
    const exact = document.querySelector(PANEL_SEL);
    if (exact) return exact;
    const panels = Array.from(document.querySelectorAll('ytd-engagement-panel-section-list-renderer'));
    const matches = panels.filter((p) => /transcript/i.test(p.getAttribute('target-id') || ''));
    return (
      matches.find((p) => p.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED') || matches[0] || null
    );
  }

  const SEGMENT_SELECTORS = [
    'transcript-segment-view-model',
    'ytd-transcript-segment-renderer',
    '[class*="TranscriptSegmentViewModel"]:not([class*="Timestamp"]):not([class*="A11y"])',
    '[class*="segment-renderer"]'
  ];
  function segmentNodes(root) {
    for (const sel of SEGMENT_SELECTORS) {
      const n = root.querySelectorAll(sel);
      if (n.length) return { sel, nodes: Array.from(n) };
    }
    return { sel: null, nodes: [] };
  }

  const firstMatch = (root, sels) => {
    for (const sel of sels) {
      const e = root.querySelector(sel);
      if (e) return e;
    }
    return null;
  };
  function readSegment(n) {
    const tsEl = firstMatch(n, [
      '.ytwTranscriptSegmentViewModelTimestamp',
      '.segment-timestamp',
      '[class*="Timestamp"]:not([class*="A11y"])',
      '[class*="timestamp"]:not([class*="a11y"])'
    ]);
    const tsRaw = tsEl ? tsEl.innerText || tsEl.textContent || '' : '';
    const m = tsRaw.match(/(?:\d+:)?\d{1,2}:\d{2}/);
    const txEl = firstMatch(n, [
      'span[role="text"]',
      '.ytAttributedStringHost[role="text"]',
      '.segment-text',
      'yt-formatted-string.segment-text',
      '[class*="segment-text"]',
      '[class*="SegmentText"]'
    ]);
    let tx = txEl ? txEl.innerText || txEl.textContent || '' : n.innerText || n.textContent || '';
    if (!txEl) {
      tx = tx
        .replace(/(?:\d+:)?\d{1,2}:\d{2}/, '')
        .replace(/\d+\s+(?:hours?|minutes?|seconds?)(?:,?\s*\d+\s+(?:minutes?|seconds?))*/i, '');
    }
    tx = tx.replace(/\s+/g, ' ').trim();
    return tx ? { type: 'seg', start: m ? C.tsToSec(m[0]) : null, text: tx } : null;
  }

  function readDomTranscript() {
    const panel = findTranscriptPanel();
    let found = panel ? segmentNodes(panel) : { nodes: [] };
    if (!found.nodes.length) found = segmentNodes(document);
    if (!found.nodes.length) {
      if (panel) {
        // unknown layout: fall back to the panel's visible text
        const parsed = C.parseTranscriptText((panel.querySelector('#content') || panel).innerText || '');
        if (parsed.filter((p) => p.start != null).length > 3) return parsed;
      }
      return [];
    }
    const items = [];
    if (found.sel === 'ytd-transcript-segment-renderer' && panel) {
      // classic UI: keep chapter headings in order
      panel.querySelectorAll('ytd-transcript-segment-renderer, ytd-transcript-section-header-renderer').forEach((n) => {
        if (n.tagName.toLowerCase() === 'ytd-transcript-section-header-renderer') {
          const t = n.textContent.replace(/\s+/g, ' ').trim();
          if (t) items.push({ type: 'chapter', start: null, text: t });
        } else {
          const seg = readSegment(n);
          if (seg) items.push(seg);
        }
      });
      if (items.some((i) => i.type === 'seg')) return items;
    }
    for (const n of found.nodes) {
      const seg = readSegment(n);
      if (seg) items.push(seg);
    }
    return items;
  }

  const signatureOf = (items) => {
    const segs = items.filter((i) => i.type === 'seg');
    return (
      segs.length +
      '|' +
      segs
        .slice(0, 3)
        .map((s) => s.text)
        .join('|') +
      '|' +
      (segs.length ? segs[segs.length - 1].text : '')
    );
  };

  function findTranscriptButton() {
    const sec =
      document.querySelector('ytd-watch-metadata ytd-video-description-transcript-section-renderer') ||
      document.querySelector('ytd-video-description-transcript-section-renderer');
    const b =
      (sec && sec.querySelector('button')) ||
      document.querySelector('button[aria-label="Show transcript"]') ||
      document.querySelector('button[aria-label="Transcript"]');
    if (b) return b;
    return (
      Array.from(
        document.querySelectorAll('button, yt-button-shape button, ytd-button-renderer button, tp-yt-paper-button')
      ).find((x) => {
        const label = (x.getAttribute('aria-label') || '').toLowerCase();
        const text = (x.textContent || '').trim().toLowerCase();
        return (
          label.includes('show transcript') ||
          text.includes('show transcript') ||
          label === 'transcript' ||
          text === 'transcript'
        );
      }) || null
    );
  }
  function expandDescription() {
    const exp =
      document.querySelector('ytd-watch-metadata #description-inline-expander #expand') ||
      document.querySelector('#description-inline-expander #expand') ||
      document.querySelector('ytd-text-inline-expander #expand');
    if (exp && exp.offsetParent !== null) {
      exp.click();
      return true;
    }
    return false;
  }
  function collapseDescription() {
    const col =
      document.querySelector('ytd-watch-metadata #description-inline-expander #collapse') ||
      document.querySelector('#description-inline-expander #collapse') ||
      document.querySelector('ytd-text-inline-expander #collapse');
    if (col && col.offsetParent !== null) col.click();
  }
  function showPanel() {
    const p = findTranscriptPanel();
    if (p && p.getAttribute('visibility') !== 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED')
      p.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
    return !!p;
  }
  function closeYouTubePanel() {
    const p = findTranscriptPanel();
    if (!p) return;
    const btn = firstMatch(p, [
      '#visibility-button button',
      'button[aria-label="Close transcript"]',
      'button[aria-label="Close"]'
    ]);
    if (btn) btn.click();
    setTimeout(() => {
      if (p.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED')
        p.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
    }, 400);
  }

  // The scrollable list holding the lines (nearest scrollable ancestor of a line, inside the panel).
  function findScrollBox(panel) {
    if (!panel) return null;
    const first = segmentNodes(panel).nodes[0];
    for (let el = first && first.parentElement; el && el !== panel.parentElement; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 5) {
        const oy = getComputedStyle(el).overflowY;
        if (oy === 'auto' || oy === 'scroll') return el;
      }
    }
    return (
      panel.querySelector('[class*="TranscriptBody"], [class*="TimelineItems"], #segments-container, #content') || null
    );
  }

  // One step down the list; false once at the end. A list that renders every line gets one jump to the
  // bottom (which also triggers any lazy loading); a virtualised list is walked a screen at a time.
  function scrollStep(box, nodes) {
    if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2) return false;
    let span = 0;
    if (nodes.length > 1)
      span = nodes[nodes.length - 1].getBoundingClientRect().bottom - nodes[0].getBoundingClientRect().top;
    const windowed = span < box.scrollHeight * 0.7;
    box.scrollTop = windowed
      ? Math.min(box.scrollHeight, box.scrollTop + Math.max(200, box.clientHeight * 0.9))
      : box.scrollHeight;
    return true;
  }

  // Captured transcript data is used only if it reaches (nearly) the end of the video; the newer layout's
  // response could hold just the first part, in which case the panel itself is read.
  function coversVideo(items, lengthSeconds) {
    if (!items || !items.length) return false;
    if (!lengthSeconds) return true;
    let last = -1;
    for (const i of items) if (i.type === 'seg' && i.start != null && i.start > last) last = i.start;
    return last < 0 || last >= lengthSeconds - Math.max(90, lengthSeconds * 0.1);
  }

  let lastDiag = '';
  async function openAndCapture(vid, lengthSeconds) {
    const panel0 = findTranscriptPanel();
    const wasOpen = !!panel0 && panel0.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED';
    const scrollY = window.scrollY;
    const before = signatureOf(readDomTranscript());
    let expanded = false,
      clicked = false;
    if (!wasOpen) {
      expanded = expandDescription();
      if (expanded) await sleep(500);
      const btn = findTranscriptButton();
      if (btn) {
        btn.click();
        clicked = true;
      } else if (panel0) {
        showPanel();
        clicked = true;
      }
    }
    let result = null;
    const collected = new Map(); // every line seen, in order (the newer UI may drop lines that scroll away)
    let firstSig = null,
      started = false,
      quiet = 0,
      lastSize = 0;
    if (wasOpen || clicked) {
      const t0 = Date.now();
      let lastNudge = 0,
        deadline = t0 + 45000,
        scrolling = false;
      // keep going while new lines keep appearing (long videos), up to 3 minutes
      while (Date.now() < deadline) {
        await sleep(scrolling ? 120 : 300);
        const cap = captures.get(vid);
        if (coversVideo(cap, lengthSeconds)) {
          result = { items: cap, source: 'YouTube transcript data' };
          break;
        }
        const elapsed = Date.now() - t0;
        if (!wasOpen && elapsed > 1200 && elapsed - lastNudge > 2000) {
          showPanel();
          lastNudge = elapsed;
        }

        const dom = readDomTranscript();
        if (!dom.some((i) => i.type === 'seg')) continue;
        const sig = signatureOf(dom);
        const owner = domSigs.get(sig);
        if (owner && owner !== vid) continue; // still showing a previous video's transcript
        if (!wasOpen && sig === before && elapsed < 3000) continue; // give YouTube time to swap content
        const panelNow = findTranscriptPanel();
        const box = findScrollBox(panelNow);
        if (!started) {
          started = true;
          firstSig = sig;
          if (box && box.scrollTop > 0) {
            box.scrollTop = 0;
            continue;
          } // start from the first line
        }
        for (const it of dom) {
          const key = (it.type === 'chapter' ? 'ch|' : (it.start == null ? '' : it.start) + '|') + it.text;
          if (!collected.has(key)) collected.set(key, it);
        }
        // walk down the list until the end, so every line gets rendered
        const stepped = !!box && scrollStep(box, segmentNodes(panelNow).nodes);
        scrolling = stepped;
        if (collected.size === lastSize) quiet++;
        else {
          quiet = 0;
          lastSize = collected.size;
          deadline = Math.min(t0 + 180000, Math.max(deadline, Date.now() + 15000));
        }
        if (!stepped && quiet >= 4) {
          domSigs.set(firstSig, vid);
          result = { items: Array.from(collected.values()), source: 'YouTube transcript panel' };
          break;
        }
      }
      if (!result && collected.size)
        result = { items: Array.from(collected.values()), source: 'YouTube transcript panel (may be incomplete)' };
      if (!result && captures.get(vid) && captures.get(vid).length)
        result = { items: captures.get(vid), source: 'YouTube transcript data (may be incomplete)' };
      if (result && result.items.every((i) => i.start != null)) {
        result.items = result.items
          .map((it, k) => ({ it, k }))
          .sort((a, b) => a.it.start - b.it.start || a.k - b.k)
          .map((x) => x.it);
      }
      const box = findScrollBox(findTranscriptPanel());
      if (box) box.scrollTop = 0;
    }
    const p = findTranscriptPanel();
    lastDiag =
      'panel ' +
      (p ? 'found (' + (p.getAttribute('target-id') || '?') + ')' : 'not found') +
      ', lines seen: ' +
      collected.size;
    if (!wasOpen && !keepYouTubePanel) closeYouTubePanel();
    if (expanded) collapseDescription();
    if (Math.abs(window.scrollY - scrollY) > 4) window.scrollTo({ top: scrollY });
    return result || { items: null, noButton: !clicked && !wasOpen };
  }

  async function fetchTranscript(vid) {
    const meta = await getMeta(vid);
    const len = meta && meta.lengthSeconds;
    let items = coversVideo(captures.get(vid), len) ? captures.get(vid) : null,
      source = items ? 'YouTube transcript data' : null;
    if (!items) {
      const r = await openAndCapture(vid, len);
      items = r.items;
      source = r.source;
      if (!items) {
        if (meta && meta.hasCaptions === false)
          throw new Error('This video has no captions, so YouTube has no transcript for it.');
        throw new Error(
          r.noButton
            ? 'YouTube isn’t offering a transcript for this video. If you can copy one, use “Paste a transcript” below.'
            : 'Couldn’t read YouTube’s transcript (' +
                lastDiag +
                '). Try again, or open it via “…more → Show transcript”, copy it and use “Paste a transcript”.'
        );
      }
    }
    return { items, source, meta };
  }

  // ---------- card placement ----------
  // A card left over from before the extension was reloaded can't talk to the extension any more: replace it.
  document.querySelectorAll('.ytct-host').forEach((h) => h.remove());
  const alive = () => {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  };
  const panel = YTCTPanel.createPanel({
    kind: 'youtube',
    videoId: currentVideoId,
    fetchTranscript,
    getMeta,
    seek: (t) => {
      const v = document.querySelector('video');
      if (v && Number.isFinite(t)) v.currentTime = t;
    },
    onLayout: (st) => applyDock(st),
    reveal: () => setTimeout(revealCard, 50)
  });
  panel.host.style.display = 'block';
  panel.host.style.margin = '0 0 16px 0';

  // Scroll the sidebar card into view, just below YouTube's fixed top bar.
  function revealCard() {
    const r = panel.host.getBoundingClientRect();
    window.scrollTo({ top: Math.max(0, r.top + window.scrollY - mastheadBottom() - 12), behavior: 'smooth' });
  }

  // ---------- large panel ----------
  // The card is pinned to the right of the window (as wide as YouTube's sidebar; drag its edge to widen it) and
  // YouTube's page narrows to the left so the video stays in view. YouTube's right-hand column
  // (recommendations, and its own transcript panel that we read from) sits behind the card, still laid out
  // so its transcript can be read, but out of sight.
  const DOCK_CSS = `
html.ytct-docked ytd-page-manager { margin-right: var(--ytct-dock-w) !important; }
html.ytct-docked ytd-watch-flexy #secondary {
  position: fixed !important; top: var(--ytct-dock-top, 56px) !important; right: 0 !important; left: auto !important;
  width: min(402px, var(--ytct-dock-w)) !important; min-width: 0 !important; max-width: none !important;
  height: calc(100vh - var(--ytct-dock-top, 56px)) !important; overflow: hidden !important;
  margin: 0 !important; padding: 0 !important; z-index: 0 !important; pointer-events: none !important;
}
html.ytct-docked ytd-watch-flexy #primary,
html.ytct-docked ytd-watch-flexy #player-container-outer { min-width: 0 !important; }
html.ytct-docked ytd-watch-flexy #columns { max-width: none !important; }
.ytct-host.ytct-dock-host {
  position: fixed !important; top: var(--ytct-dock-top, 56px) !important; right: 0 !important; bottom: 0 !important;
  width: var(--ytct-dock-w) !important; margin: 0 !important; z-index: 2010 !important;
}`;
  let dockWanted = { docked: false, width: 0.3 },
    dockOn = false,
    dockPx = 0,
    resizeTimer = null;
  function ensureDockStyle() {
    let st = document.getElementById('ytct-dock-style');
    if (!st) {
      st = document.createElement('style');
      st.id = 'ytct-dock-style';
      (document.head || document.documentElement).append(st);
    }
    if (st.textContent !== DOCK_CSS) st.textContent = DOCK_CSS;
  }
  function mastheadBottom() {
    const m = document.querySelector('#masthead-container') || document.querySelector('ytd-masthead');
    const r = m && m.getBoundingClientRect();
    return r && r.height ? Math.max(0, Math.round(r.bottom)) : 0;
  }
  function applyDock(st) {
    if (st) dockWanted = st;
    const on = !!dockWanted.docked && isWatch() && !document.fullscreenElement;
    const root = document.documentElement;
    let px = 0;
    if (on) {
      ensureDockStyle();
      const W = window.innerWidth;
      px = Math.round(Math.min(Math.max((dockWanted.width || 0.5) * W, 360), Math.max(360, W - 320)));
      root.style.setProperty('--ytct-dock-w', px + 'px');
      root.style.setProperty('--ytct-dock-top', mastheadBottom() + 'px');
      root.classList.add('ytct-docked');
      panel.host.classList.add('ytct-dock-host');
      if (panel.host.parentElement !== document.body) document.body.append(panel.host);
      panel.host.style.display = 'block';
    } else {
      root.classList.remove('ytct-docked');
      panel.host.classList.remove('ytct-dock-host');
    }
    const changed = on !== dockOn || px !== dockPx;
    dockOn = on;
    dockPx = px;
    if (!on && changed) ensurePlaced();
    // let YouTube re-measure its player for the new page width
    if (changed) {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => window.dispatchEvent(new Event('resize')), dockWanted.live ? 150 : 30);
    }
  }
  document.addEventListener('fullscreenchange', () => applyDock());

  function pickContainer() {
    for (const sel of ['ytd-watch-flexy #secondary-inner', 'ytd-watch-flexy #secondary']) {
      const e = document.querySelector(sel);
      if (e && e.getClientRects().length && e.offsetWidth > 200) return { el: e, mode: 'prepend' };
    }
    const meta = document.querySelector('ytd-watch-flexy #below ytd-watch-metadata');
    if (meta) return { el: meta, mode: 'after' };
    return null;
  }

  function ensurePlaced() {
    if (!isWatch()) {
      panel.host.style.display = 'none';
      if (dockOn) applyDock();
      return;
    }
    if (dockOn) {
      if (panel.host.parentElement !== document.body) document.body.append(panel.host);
      panel.host.style.display = 'block';
      return;
    }
    const c = pickContainer();
    if (!c) return;
    const placed =
      c.mode === 'after'
        ? panel.host.previousElementSibling === c.el
        : panel.host.parentElement === c.el && c.el.firstElementChild === panel.host;
    if (!placed) {
      if (c.mode === 'after') c.el.after(panel.host);
      else c.el.prepend(panel.host);
    }
    panel.host.style.display = 'block';
  }

  // ---------- navigation ----------
  let lastVid = null;
  async function onNavigate() {
    if (!isWatch()) {
      ensurePlaced();
      lastVid = null;
      return;
    }
    applyDock();
    ensurePlaced();
    const vid = currentVideoId();
    if (vid === lastVid) return;
    lastVid = vid;
    const restored = await panel.setVideo(vid);
    if (!restored && autoLoad)
      setTimeout(() => {
        if (currentVideoId() === vid && !panel.isLoaded()) panel.load();
      }, 1800);
  }
  document.addEventListener('yt-navigate-finish', () => setTimeout(onNavigate, 50));
  window.addEventListener('resize', () => {
    if (isWatch()) {
      applyDock();
      ensurePlaced();
    }
  });
  const timer = setInterval(() => {
    if (!alive()) {
      clearInterval(timer);
      panel.host.remove();
      return;
    } // extension reloaded: the new copy takes over
    if (isWatch()) {
      if (
        dockOn &&
        Math.abs(
          mastheadBottom() - (parseInt(document.documentElement.style.getPropertyValue('--ytct-dock-top'), 10) || 0)
        ) > 2
      )
        applyDock();
      if (!panel.host.isConnected || panel.host.style.display === 'none') ensurePlaced();
      if (currentVideoId() !== lastVid) onNavigate();
    } else ensurePlaced();
  }, 1500);
  onNavigate();

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'toggle') return;
    ensurePlaced();
    const opened = panel.toggle();
    if (opened && !dockOn) revealCard();
  });
})();
