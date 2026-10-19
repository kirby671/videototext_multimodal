/*
 * Runs in YouTube's own page context (MAIN world) at document_start.
 * 1. Passively watches YouTube's own transcript requests (youtubei/v1/get_transcript)
 *    and forwards the segments to the content script. It never makes requests itself.
 * 2. Answers "meta" requests with the current video's title / channel / description.
 * Nothing secret ever enters this context — the API key stays in the extension.
 */
(() => {
  if (window.__ytctHook) return;
  window.__ytctHook = true;

  const isTranscriptUrl = (u) =>
    typeof u === 'string' &&
    (u.indexOf('/youtubei/v1/get_transcript') !== -1 || u.indexOf('/youtubei/v1/get_panel') !== -1);

  function textOf(x, depth) {
    depth = depth || 0;
    if (!x || depth > 6) return '';
    if (typeof x === 'string') return x;
    if (typeof x.simpleText === 'string') return x.simpleText;
    if (Array.isArray(x.runs)) return x.runs.map((r) => r.text || '').join('');
    if (typeof x.content === 'string') return x.content;
    for (const k in x) {
      if (x[k] && typeof x[k] === 'object') {
        const t = textOf(x[k], depth + 1);
        if (t) return t;
      }
    }
    return '';
  }

  function extract(json) {
    const items = [];
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) {
        for (const x of o) walk(x);
        return;
      }
      if (o.transcriptSegmentRenderer) {
        const r = o.transcriptSegmentRenderer;
        items.push({
          type: 'seg',
          start: r.startMs != null ? Number(r.startMs) / 1000 : null,
          end: r.endMs != null ? Number(r.endMs) / 1000 : null,
          text: textOf(r.snippet)
        });
        return;
      }
      // newer layout: view-model objects (field names vary, so read them defensively)
      for (const k in o) {
        if (/^transcriptSegmentViewModel$/i.test(k) && o[k] && typeof o[k] === 'object') {
          const v = o[k];
          const ms = v.startMs != null ? v.startMs : v.startTimeMs != null ? v.startTimeMs : v.startOffsetMs;
          let start = ms != null ? Number(ms) / 1000 : null;
          if (start == null) {
            const t = textOf(v.timestamp);
            const m = t && t.match(/(?:(\d+):)?(\d{1,2}):(\d{2})/);
            if (m) start = +(m[1] || 0) * 3600 + +m[2] * 60 + +m[3];
          }
          const text = textOf(v.snippet) || textOf(v.text) || textOf(v.simpleText);
          if (text) items.push({ type: 'seg', start, end: null, text });
          return;
        }
      }
      if (o.transcriptSectionHeaderRenderer) {
        const r = o.transcriptSectionHeaderRenderer;
        items.push({
          type: 'chapter',
          start: r.startMs != null ? Number(r.startMs) / 1000 : null,
          text: textOf(r.snippet) || textOf(r.sectionHeader)
        });
        return;
      }
      for (const k in o) walk(o[k]);
    })(json);
    return items;
  }

  function emit(json) {
    try {
      const items = extract(json);
      if (!items.some((i) => i.type === 'seg')) return;
      const v = new URL(location.href).searchParams.get('v');
      window.postMessage({ source: 'ytct-hook', type: 'transcript', videoId: v, items }, location.origin);
    } catch (e) {
      /* ignore */
    }
  }

  // fetch
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    const wrapped = function (input) {
      const p = origFetch.apply(this, arguments);
      try {
        const u = typeof input === 'string' ? input : (input && (input.url || input.href)) || '';
        if (isTranscriptUrl(String(u)))
          p.then((r) => r.clone().json())
            .then(emit)
            .catch(() => {});
      } catch (e) {
        /* ignore */
      }
      return p;
    };
    try {
      Object.defineProperty(wrapped, 'name', { value: 'fetch' });
    } catch (e) {
      /* ignore */
    }
    window.fetch = wrapped;
  }

  // XHR
  const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHR) {
    const oOpen = XHR.open,
      oSend = XHR.send;
    XHR.open = function (method, url) {
      try {
        this.__ytctUrl = String(url);
      } catch (e) {
        /* ignore */
      }
      return oOpen.apply(this, arguments);
    };
    XHR.send = function () {
      if (isTranscriptUrl(this.__ytctUrl)) {
        this.addEventListener('load', () => {
          try {
            emit(this.responseType === 'json' ? this.response : JSON.parse(this.responseText));
          } catch (e) {
            /* ignore */
          }
        });
      }
      return oSend.apply(this, arguments);
    };
  }

  // meta requests from the content script
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.source !== 'ytct-content' || d.type !== 'meta') return;
    let meta = null;
    try {
      const player = document.getElementById('movie_player');
      const pr = (player && player.getPlayerResponse && player.getPlayerResponse()) || window.ytInitialPlayerResponse;
      const vd = pr && pr.videoDetails;
      if (vd) {
        meta = {
          videoId: vd.videoId,
          title: vd.title || '',
          channel: vd.author || '',
          description: String(vd.shortDescription || '').slice(0, 3000),
          lengthSeconds: Number(vd.lengthSeconds) || null,
          publishDate: (() => {
            const m = pr.microformat && pr.microformat.playerMicroformatRenderer;
            return (m && (m.publishDate || m.uploadDate)) || '';
          })(),
          hasCaptions: !!(
            pr.captions &&
            pr.captions.playerCaptionsTracklistRenderer &&
            (pr.captions.playerCaptionsTracklistRenderer.captionTracks || []).length
          )
        };
      }
    } catch (e) {
      /* ignore */
    }
    window.postMessage({ source: 'ytct-hook', type: 'meta', reqId: d.reqId, meta }, location.origin);
  });
})();
