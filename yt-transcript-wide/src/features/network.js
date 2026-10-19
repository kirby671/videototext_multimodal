/*
 * Network: how the companies in your Library relate to each other.
 * Only changes when you press "Update network": Claude reads each new or changed video's saved analysis
 * (plus the transcript sentences that name two or more companies) and lists the ties the speakers describe.
 * Results are kept per video under "net:v:<key>", so later updates only process what's new; the picture you
 * see is a snapshot ("net:graph") built at the last update. Nothing in the Library itself is changed.
 */
(function (root) {
  'use strict';
  const C = root.YTCT;
  const AI = root.YTCTPanel.claude;
  const GRAPH_KEY = 'net:graph',
    VPREFIX = 'net:v:',
    CLS_KEY = 'net:cls';

  const SECTORS = [
    'Card network',
    'Bank',
    'Card issuer / program manager',
    'Stablecoin issuer',
    'Payments / PSP',
    'Crypto exchange / wallet',
    'Blockchain / protocol',
    'Fintech infrastructure / API',
    'Lending / credit',
    'Investor / VC',
    'Big tech',
    'Regulator / government',
    'Other'
  ];
  const TYPES = ['partner', 'provides_to', 'built_on', 'integrates', 'competes', 'invests_in', 'acquired', 'other'];
  const FAMILY_OF = {
    partner: 'works',
    provides_to: 'works',
    built_on: 'works',
    integrates: 'works',
    competes: 'competes',
    invests_in: 'owns',
    acquired: 'owns',
    other: 'other'
  };
  const FAMILY_NAME = {
    works: 'Works with',
    competes: 'Competes with',
    owns: 'Owns / invests in',
    other: 'Other tie',
    co: 'Mentioned together'
  };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const SVGNS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs) => {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
    return e;
  };
  const clip = (s, k) => {
    s = String(s == null ? '' : s)
      .replace(/\s+/g, ' ')
      .trim();
    return s.length > k ? s.slice(0, k - 1) + '…' : s;
  };
  const plural = (n, w, ws) => n.toLocaleString() + ' ' + (n === 1 ? w : ws || w + 's');
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/&/g, 'and')
      .replace(/[^a-z0-9]+/g, '');
  const dateOf = (e) => e.published || e.created;
  const isoDay = (t) => {
    const d = new Date(t);
    return (
      d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    );
  };
  const fmtShort = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const fmtDay = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const hashNum = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  };
  const analysisOf = (e) =>
    (C.resolveSpeakerIds ? C.resolveSpeakerIds(e.rec.analysis, e.rec.speakers) : e.rec.analysis) || {};
  // A video needs re-reading when its companies or summary change (not when it's merely distilled or re-saved).
  const fingerprint = (e) => {
    const A = e.rec.analysis || {};
    return (hashNum(JSON.stringify([(A.companies || []).map((c) => [c.name, c.why]), A.summary || ''])) >>> 0).toString(
      16
    );
  };

  // ---------- the Claude request ----------
  const SYSTEM = [
    'You map how companies relate to each other, from a personal library of video analyses (podcasts, interviews and talks, mostly about fintech, payments and crypto).',
    "For each video, list the ties between two named companies or organisations that the speakers state or clearly imply: partnerships, one providing a product or service to another, one building on or running through another's network or infrastructure, integrations, competition, investments and acquisitions.",
    'Use the company names exactly as listed for that video. Only include ties grounded in what was said in that video; never add ties from your own knowledge. Pay most attention to ties between fintech and financial companies.',
    'Direction: "from" provides_to / built_on / invests_in / acquired "to"; partner, integrates and competes read either way. "label" is 2-6 words that read from → to (e.g. "issues cards on", "settles USDC with", "acquired"). "context" is one specific sentence on how it came up, naming who said it where known.',
    'A video with no ties gets an empty list.',
    'Then classify every company named in these videos: its sector, whether it is a fintech or financial-services company (banks, card networks, payments, stablecoins, crypto, lending and fintech infrastructure count; general big tech, media, governments, regulators and investors do not), and one line on what it is.'
  ].join(' ');
  const TOOL = {
    name: 'map_company_ties',
    description: 'Ties between companies in each video, and what each company is.',
    input_schema: {
      type: 'object',
      properties: {
        videos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              video: { type: 'integer', description: 'The V number' },
              ties: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    from: { type: 'string' },
                    to: { type: 'string' },
                    type: { type: 'string', enum: TYPES },
                    label: { type: 'string', description: '2-6 words, reads from → to' },
                    context: { type: 'string', description: 'One sentence: how it came up' }
                  },
                  required: ['from', 'to', 'type', 'label', 'context']
                }
              }
            },
            required: ['video', 'ties']
          }
        },
        companies: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              sector: { type: 'string', enum: SECTORS },
              fintech: { type: 'boolean' },
              about: { type: 'string', description: 'One line: what it is' }
            },
            required: ['name', 'sector', 'fintech', 'about']
          }
        }
      },
      required: ['videos', 'companies']
    }
  };

  // Transcript sentences naming two or more of the video's companies: the best evidence of how they relate.
  function pairSentences(e, A, max) {
    const matcher = C.companyMatcher(A.companies || []);
    if (!matcher) return [];
    let units;
    try {
      units = C.buildUnits(e.rec.items || [], {});
    } catch (err) {
      return [];
    }
    const out = [],
      seenPairs = new Set();
    for (const u of units) {
      const ids = new Set(
        C.splitHighlights(u.text, matcher)
          .filter((p) => p.company != null)
          .map((p) => p.company)
      );
      if (ids.size < 2) continue;
      const key = [...ids].sort().join(',');
      const fresh = !seenPairs.has(key);
      if (!fresh && out.length >= max / 2) continue;
      seenPairs.add(key);
      out.push(clip(u.text, 300));
      if (out.length >= max) break;
    }
    return out;
  }
  function videoBlock(e, n) {
    const A = analysisOf(e);
    const parts = [
      '[V' +
        n +
        '] ' +
        isoDay(dateOf(e)) +
        ' · "' +
        clip(e.title, 160) +
        '"' +
        (e.channel ? ' · ' + clip(e.channel, 60) : '')
    ];
    const ppl = (e.rec.speakers || []).map((s) => s.name + (s.role ? ' (' + s.role + ')' : '')).join('; ');
    if (ppl) parts.push('People: ' + clip(ppl, 300));
    parts.push(
      'Companies named:\n' +
        (A.companies || [])
          .slice(0, 40)
          .map((c) => '- ' + c.name + (c.why ? ' — ' + clip(c.why, 200) : ''))
          .join('\n')
    );
    if (A.summary) parts.push('Summary: ' + clip(A.summary, 600));
    const facts = (A.facts_and_figures || []).slice(0, 6).map((x) => '- ' + clip(x.fact, 200));
    if (facts.length) parts.push('Facts:\n' + facts.join('\n'));
    const how = (A.how_they_do_it || [])
      .slice(0, 5)
      .map((x) => '- ' + clip(x.point + (x.detail ? ': ' + x.detail : ''), 220));
    if (how.length) parts.push('How they do it:\n' + how.join('\n'));
    const said = pairSentences(e, A, 12);
    if (said.length)
      parts.push('Sentences naming two or more of these companies:\n' + said.map((s) => '- "' + s + '"').join('\n'));
    return parts.join('\n');
  }
  function batches(list) {
    const out = [];
    let cur = [],
      size = 0;
    for (const e of list) {
      const b = videoBlock(e, cur.length + 1);
      if (cur.length && (cur.length >= 6 || size + b.length > 26000)) {
        out.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(e);
      size += b.length;
    }
    if (cur.length) out.push(cur);
    return out.map((vids) => {
      const blocks = vids.map((e, i) => videoBlock(e, i + 1));
      return {
        vids,
        req: {
          system: SYSTEM,
          user: plural(vids.length, 'video') + ':\n\n' + blocks.join('\n\n'),
          tool: TOOL,
          maxTokens: Math.min(32000, 4000 + 1800 * vids.length)
        }
      };
    });
  }
  function estimateCost(list, model) {
    const p = AI.PRICES[model] || AI.PRICES['claude-opus-5-5'];
    return batches(list).reduce((sum, b) => {
      const inTok = Math.round((b.req.system.length + b.req.user.length) / 3.6) + 700;
      const outTok = 400 + 700 * b.vids.length;
      return sum + (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
    }, 0);
  }

  // ---------- building the snapshot ----------
  function buildSnapshot(entries, perVideo, cls) {
    const vids = entries.filter((e) => perVideo[e.key]).sort((a, b) => dateOf(a) - dateOf(b));
    const videos = vids.map((e) => ({
      key: e.key,
      title: e.title,
      channel: e.channel,
      day: isoDay(dateOf(e)),
      videoId: e.videoId
    }));
    const vIndex = new Map(vids.map((e, i) => [e.key, i]));
    const alias = new Map(),
      nodes = new Map();
    const nodeFor = (name) => {
      const k0 = norm(name);
      if (!k0) return null;
      const id = alias.get(k0) || k0;
      alias.set(k0, id);
      if (!nodes.has(id)) nodes.set(id, { id, names: new Map(), videos: new Set(), why: [] });
      const n = nodes.get(id);
      n.names.set(name, (n.names.get(name) || 0) + 1);
      return n;
    };
    // nodes: every company named in an analysis (aliases merged)
    vids.forEach((e) => {
      const vi = vIndex.get(e.key);
      for (const c of analysisOf(e).companies || []) {
        const k0 = norm(c.name);
        if (!k0) continue;
        const id = alias.get(k0) || k0;
        alias.set(k0, id);
        for (const a of c.aliases || []) {
          const ka = norm(a);
          if (ka.length >= 3 && !alias.has(ka)) alias.set(ka, id);
        }
        const n = nodeFor(c.name);
        if (!n.videos.has(vi)) {
          n.videos.add(vi);
          if (c.why) n.why.push({ v: vi, text: c.why });
        }
      }
    });
    // ties
    const ties = new Map();
    vids.forEach((e) => {
      const vi = vIndex.get(e.key);
      for (const t of perVideo[e.key].ties || []) {
        const a = nodeFor(t.from),
          b = nodeFor(t.to);
        if (!a || !b || a === b) continue;
        a.videos.add(vi);
        b.videos.add(vi);
        const [x, y] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
        const k = x + '|' + y;
        if (!ties.has(k)) ties.set(k, { a: x, b: y, items: [] });
        ties.get(k).items.push({
          v: vi,
          from: a.id,
          to: b.id,
          type: TYPES.includes(t.type) ? t.type : 'other',
          label: clip(t.label, 60),
          context: clip(t.context, 400)
        });
      }
    });
    // mentioned together in the same video
    const co = new Map();
    vids.forEach((e) => {
      const vi = vIndex.get(e.key);
      const ids = [
        ...new Set((analysisOf(e).companies || []).map((c) => alias.get(norm(c.name))).filter(Boolean))
      ].sort();
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++) {
          const k = ids[i] + '|' + ids[j];
          if (!co.has(k)) co.set(k, { a: ids[i], b: ids[j], videos: [] });
          co.get(k).videos.push(vi);
        }
    });
    const top = (m) => [...m.entries()].sort((p, q) => q[1] - p[1])[0][0];
    const outNodes = [...nodes.values()].map((n) => {
      const name = top(n.names);
      const c = cls[n.id] || [...n.names.keys()].map((nm) => cls[norm(nm)]).find(Boolean) || null;
      return {
        id: n.id,
        name,
        sector: c ? c.sector : '',
        fintech: c ? !!c.fintech : null,
        about: c ? c.about : '',
        videos: [...n.videos].sort((p, q) => p - q),
        why: n.why
      };
    });
    const outTies = [...ties.values()].map((t) => {
      const fam = {};
      t.items.forEach((i) => {
        const f = FAMILY_OF[i.type];
        fam[f] = (fam[f] || 0) + 1;
      });
      return {
        ...t,
        family: Object.entries(fam).sort((p, q) => q[1] - p[1])[0][0],
        videos: [...new Set(t.items.map((i) => i.v))]
      };
    });
    return {
      builtAt: Date.now(),
      videos,
      nodes: outNodes,
      ties: outTies,
      co: [...co.values()],
      fps: Object.fromEntries(vids.map((e) => [e.key, perVideo[e.key].fp]))
    };
  }

  // ---------- layout: companies as labelled pills that never overlap, ties long enough for their labels ----------
  const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif';
  let mctx = null;
  function textWidth(text, size, weight) {
    if (!mctx) mctx = document.createElement('canvas').getContext('2d');
    mctx.font = (weight || 600) + ' ' + size + 'px ' + FONT;
    return mctx.measureText(String(text)).width;
  }
  // Positions are in "world" units; the view scales them to fit the screen.
  function layoutGraph(nodes, edges) {
    const N = nodes.length;
    if (!N) return;
    const idx = new Map(nodes.map((n, i) => [n.id, i]));
    const R0 = 110 + Math.sqrt(N) * 95;
    nodes.forEach((n) => {
      const h = hashNum(n.id),
        a = (h % 6283) / 1000,
        r = R0 * (0.25 + (h % 1000) / 1300);
      n.x = Math.cos(a) * r;
      n.y = Math.sin(a) * r;
    });
    const E = edges
      .map((e) => {
        const s = idx.get(e.a),
          t = idx.get(e.b);
        return s == null || t == null
          ? null
          : { s, t, L: (nodes[s].w + nodes[t].w) / 2 + (e.labelW || 0) + (e.family === 'co' ? 80 : 110) };
      })
      .filter(Boolean);
    const ITER = N > 120 ? 260 : 450,
      GAP = 36;
    const fx = new Float64Array(N),
      fy = new Float64Array(N);
    for (let it = 0; it < ITER; it++) {
      const temp = 70 * (1 - it / ITER) + 2;
      fx.fill(0);
      fy.fill(0);
      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
          const a = nodes[i],
            b = nodes[j];
          let dx = a.x - b.x,
            dy = a.y - b.y;
          if (!dx && !dy) {
            dx = (i - j) * 0.1 || 0.1;
            dy = 0.1;
          }
          const d2 = dx * dx + dy * dy,
            d = Math.sqrt(d2);
          let f = 46000 / d2;
          const ox = (a.w + b.w) / 2 + GAP - Math.abs(dx),
            oy = (a.h + b.h) / 2 + GAP - Math.abs(dy);
          if (ox > 0 && oy > 0) f += Math.min(ox, oy) * 0.8; // pills touching: push apart hard
          fx[i] += (dx / d) * f;
          fy[i] += (dy / d) * f;
          fx[j] -= (dx / d) * f;
          fy[j] -= (dy / d) * f;
        }
      }
      for (const e of E) {
        const a = nodes[e.s],
          b = nodes[e.t];
        const dx = b.x - a.x,
          dy = b.y - a.y,
          d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d - e.L) * 0.06;
        fx[e.s] += (dx / d) * f;
        fy[e.s] += (dy / d) * f;
        fx[e.t] -= (dx / d) * f;
        fy[e.t] -= (dy / d) * f;
      }
      for (let i = 0; i < N; i++) {
        fx[i] -= nodes[i].x * 0.009;
        fy[i] -= nodes[i].y * 0.015; // gentle pull to the middle (a little more vertically: screens are wide)
        const len = Math.sqrt(fx[i] * fx[i] + fy[i] * fy[i]) || 1,
          step = Math.min(len, temp);
        nodes[i].x += (fx[i] / len) * step;
        nodes[i].y += (fy[i] / len) * step;
      }
    }
    removeOverlaps(nodes, GAP);
  }
  function removeOverlaps(nodes, gap) {
    for (let pass = 0; pass < 200; pass++) {
      let moved = false;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i],
            b = nodes[j];
          const dx = b.x - a.x,
            dy = b.y - a.y;
          const ox = (a.w + b.w) / 2 + gap - Math.abs(dx),
            oy = (a.h + b.h) / 2 + gap * 0.7 - Math.abs(dy);
          if (ox <= 0 || oy <= 0) continue;
          moved = true;
          if (ox < oy) {
            const s = ((dx >= 0 ? 1 : -1) * ox) / 2 + 0.5;
            a.x -= s;
            b.x += s;
          } else {
            const s = ((dy >= 0 ? 1 : -1) * oy) / 2 + 0.5;
            a.y -= s;
            b.y += s;
          }
        }
      }
      if (!moved) break;
    }
  }
  // One company's ties, arranged in a ring around it (an ellipse: pills are wider than tall).
  function egoLayout(center, neighbors, base) {
    const pos = { [center.id]: { x: base.x, y: base.y } };
    const n = neighbors.length;
    if (!n) return pos;
    const circ = neighbors.reduce((s, x) => s + x.w + 56, 0);
    const R = Math.max(170, center.w / 2 + 140, circ / (2 * Math.PI));
    const tmp = neighbors.map((x, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
      return { id: x.id, w: x.w, h: x.h, x: base.x + Math.cos(a) * R * 1.3, y: base.y + Math.sin(a) * R * 0.8 };
    });
    removeOverlaps(tmp.concat([{ id: center.id, w: center.w, h: center.h, x: base.x, y: base.y, fixed: true }]), 22);
    tmp.forEach((t) => {
      pos[t.id] = { x: t.x, y: t.y };
    });
    pos[center.id] = { x: base.x, y: base.y };
    return pos;
  }
  // Where a line from a pill's centre towards (tx, ty) leaves the pill.
  function boxExit(n, tx, ty) {
    const dx = tx - n.x,
      dy = ty - n.y;
    if (!dx && !dy) return { x: n.x, y: n.y };
    const hw = n.w / 2 + 3,
      hh = n.h / 2 + 3;
    const s = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
    return { x: n.x + dx * s, y: n.y + dy * s };
  }
  // A gently curved tie from pill a to pill b, and the point for its label.
  function edgeGeom(a, b, bend) {
    const dx = b.x - a.x,
      dy = b.y - a.y,
      d = Math.sqrt(dx * dx + dy * dy) || 1;
    const off = bend * Math.min(50, d * 0.12);
    const cx = (a.x + b.x) / 2 - (dy / d) * off,
      cy = (a.y + b.y) / 2 + (dx / d) * off;
    const p0 = boxExit(a, cx, cy),
      p2 = boxExit(b, cx, cy);
    const r = (v) => Math.round(v * 10) / 10;
    return {
      d: 'M' + r(p0.x) + ',' + r(p0.y) + ' Q' + r(cx) + ',' + r(cy) + ' ' + r(p2.x) + ',' + r(p2.y),
      lx: 0.25 * p0.x + 0.5 * cx + 0.25 * p2.x,
      ly: 0.25 * p0.y + 0.5 * cy + 0.25 * p2.y
    };
  }
  const DIRECTED = new Set(['provides_to', 'built_on', 'invests_in', 'acquired']);

  // ---------- markdown ----------
  function networkMarkdown(G) {
    const name = new Map(G.nodes.map((n) => [n.id, n.name]));
    const L = [
      '# Company network',
      '',
      '_From ' + plural(G.videos.length, 'video') + ', updated ' + fmtDay(G.builtAt) + '._',
      '',
      '## Ties',
      ''
    ];
    G.ties
      .slice()
      .sort((a, b) => b.videos.length - a.videos.length)
      .forEach((t) => {
        L.push('### ' + name.get(t.a) + ' — ' + name.get(t.b) + ' (' + FAMILY_NAME[t.family].toLowerCase() + ')');
        t.items.forEach((i) => {
          const v = G.videos[i.v];
          L.push(
            '- ' +
              name.get(i.from) +
              ' ' +
              i.label +
              ' ' +
              name.get(i.to) +
              '. ' +
              i.context +
              (v ? ' _(' + v.day + ', ' + v.title + ')_' : '')
          );
        });
        L.push('');
      });
    L.push('## Companies', '');
    G.nodes
      .filter((n) => G.ties.some((t) => t.a === n.id || t.b === n.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((n) =>
        L.push('- **' + n.name + '**' + (n.sector ? ' (' + n.sector + ')' : '') + (n.about ? ' — ' + n.about : ''))
      );
    return L.join('\n') + '\n';
  }

  // ---------- the view ----------
  function mount(rootEl, deps) {
    const state = {
      show: 'fintech',
      withCo: false,
      sel: null,
      G: null,
      perVideoFps: {},
      running: false,
      progress: '',
      msg: null,
      listOpen: false,
      view: null
    };
    try {
      const s = JSON.parse(localStorage.getItem('ytct-network') || '{}');
      if (s.show) state.show = s.show;
      if (s.withCo) state.withCo = true;
    } catch (e) {
      /* ignore */
    }
    const saveUi = () => {
      try {
        localStorage.setItem('ytct-network', JSON.stringify({ show: state.show, withCo: state.withCo }));
      } catch (e) {
        /* ignore */
      }
    };
    let settings = { model: 'claude-opus-5-5', hasKey: false };

    async function load() {
      const all = await chrome.storage.local.get(null);
      settings = { model: all.model || 'claude-opus-5-5', hasKey: !!String(all.apiKey || '').trim() };
      state.G = all[GRAPH_KEY] || null;
      state.perVideoFps = {};
      for (const k of Object.keys(all))
        if (k.startsWith(VPREFIX)) state.perVideoFps[k.slice(VPREFIX.length)] = all[k].fp;
    }
    const analyzed = () => deps.getEntries().filter((e) => e.analyzed);
    const pending = () => analyzed().filter((e) => state.perVideoFps[e.key] !== fingerprint(e));
    const changedSinceSnapshot = () => {
      const G = state.G;
      if (!G) return analyzed().length;
      return analyzed().filter((e) => !G.fps || G.fps[e.key] !== fingerprint(e)).length;
    };

    const tip = el('div', 'ttip');
    tip.hidden = true;
    tip.setAttribute('role', 'tooltip');
    document.body.append(tip);
    function showTip(x, y, value, label, lines) {
      tip.textContent = '';
      tip.append(el('b', null, value));
      if (label) tip.append(el('span', 'tl', label));
      (lines || []).forEach((l) => tip.append(el('span', 'tx', l)));
      tip.hidden = false;
      const t = tip.getBoundingClientRect();
      tip.style.left = Math.round(Math.max(8, Math.min(window.innerWidth - t.width - 8, x + 14))) + 'px';
      tip.style.top = Math.round(Math.max(8, y - t.height - 12)) + 'px';
    }
    const hideTip = () => {
      tip.hidden = true;
    };

    // ---------- what's shown ----------
    function visibleGraph() {
      const G = state.G;
      const byId = new Map(G.nodes.map((n) => [n.id, n]));
      const okNode = (n) => n && (state.show === 'all' || n.fintech);
      const edges = [];
      for (const t of G.ties)
        if (okNode(byId.get(t.a)) && okNode(byId.get(t.b)))
          edges.push({ a: t.a, b: t.b, family: t.family, weight: t.videos.length, tie: t });
      if (state.withCo) {
        const tied = new Set(G.ties.map((t) => t.a + '|' + t.b));
        for (const c of G.co)
          if (!tied.has(c.a + '|' + c.b) && okNode(byId.get(c.a)) && okNode(byId.get(c.b)))
            edges.push({ a: c.a, b: c.b, family: 'co', weight: c.videos.length, co: c });
      }
      const used = new Set();
      edges.forEach((e) => {
        used.add(e.a);
        used.add(e.b);
      });
      const nodes = G.nodes.filter((n) => used.has(n.id)).map((n) => ({ ...n }));
      const hidden = G.nodes.filter((n) => okNode(n) && !used.has(n.id)).length;
      return { nodes, edges, hidden };
    }

    // ---------- render ----------
    function render() {
      hideTip();
      rootEl.textContent = '';
      const w = el('div', 'nw');
      rootEl.append(w);
      w.append(head());
      const G = state.G;
      if (!analyzed().length) {
        w.append(
          el(
            'p',
            'tempty',
            'The network is built from your analyzed transcripts. Analyze a few videos (on YouTube, or in the Library) and then press Update network.'
          )
        );
        return;
      }
      if (!G) {
        const p = el('div', 'nintro');
        p.append(
          el(
            'p',
            null,
            'Press Update network and Claude reads the saved analysis of each of your ' +
              plural(analyzed().length, 'analyzed video') +
              ', together with the sentences where two companies are named together, and maps the ties the speakers describe: partnerships, who provides what to whom, who builds on whose network, competition, investments and acquisitions.'
          )
        );
        p.append(
          el(
            'p',
            null,
            'You’ll see it as a network, with fintech companies highlighted, and can click any company or tie to see the context it came up in. It only changes when you press Update, and each video is only read once.'
          )
        );
        w.append(p);
        return;
      }
      const V = visibleGraph();
      const main = el('div', 'nmain');
      const canvas = el('div', 'ncanvas');
      const side = el('aside', 'nside');
      main.append(canvas, side);
      w.append(main);
      w.append(legend());
      w.append(listView(V));
      if (!V.nodes.length) {
        canvas.append(
          el(
            'p',
            'tempty small',
            state.show === 'fintech'
              ? 'No ties between fintech companies found yet. Try “All companies”, or include companies mentioned together.'
              : 'No ties found yet. Try including companies mentioned together.'
          )
        );
        renderSide(side, V);
        return;
      }
      drawGraph(canvas, side, V);
    }

    function head() {
      const h = el('div', 'nbar');
      const show = el('div', 'seg2');
      [
        ['fintech', 'Fintech companies'],
        ['all', 'All companies']
      ].forEach(([v, t]) => {
        const b = el('button', null, t);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(state.show === v));
        b.addEventListener('click', () => {
          state.show = v;
          state.sel = null;
          state.view = null;
          saveUi();
          render();
        });
        show.append(b);
      });
      const coL = el('label', 'nchk');
      const co = el('input');
      co.type = 'checkbox';
      co.checked = state.withCo;
      co.addEventListener('change', () => {
        state.withCo = co.checked;
        state.view = null;
        saveUi();
        render();
      });
      coL.append(co, ' Also link companies mentioned together');
      const find = el('input', 'nfind');
      find.type = 'search';
      find.placeholder = 'Find a company';
      find.setAttribute('aria-label', 'Find a company');
      find.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' || !state.G) return;
        const q = norm(find.value);
        const n = state.G.nodes.find((x) => norm(x.name) === q) || state.G.nodes.find((x) => norm(x.name).includes(q));
        if (!n) {
          state.msg = { text: 'No company called “' + find.value + '” in the network.', kind: 'error' };
          renderStatus();
          return;
        }
        if (!n.fintech && state.show === 'fintech') state.show = 'all';
        state.sel = { node: n.id };
        state.view = null;
        render();
      });
      const grow = el('span', 'grow');
      const upd = el('div', 'nupd');
      h.append(show, coL, find, grow, upd);
      updBox = upd;
      renderStatus();
      return h;
    }
    let updBox = null;
    function renderStatus() {
      if (!updBox) return;
      updBox.textContent = '';
      const todo = pending();
      const changed = changedSinceSnapshot();
      const st = el('span', 'nstat');
      if (state.running) {
        st.textContent = state.progress || 'Updating…';
        st.dataset.kind = 'work';
      } else if (state.msg) {
        st.textContent = state.msg.text;
        st.dataset.kind = state.msg.kind || '';
      } else if (state.G)
        st.textContent =
          'Updated ' +
          fmtDay(state.G.builtAt) +
          ' from ' +
          plural(state.G.videos.length, 'video') +
          (changed ? ' · ' + plural(changed, 'video') + ' new or changed since' : ' · up to date');
      updBox.append(st);
      const b = el('button', 'tbtn primary', 'Update network');
      b.type = 'button';
      b.disabled = state.running || (!todo.length && !!state.G && !changed);
      if (todo.length)
        b.append(
          el(
            'span',
            'est',
            ' · ' + plural(todo.length, 'video') + ' · about ' + AI.money(estimateCost(todo, settings.model))
          )
        );
      b.title = todo.length
        ? 'Claude reads ' + plural(todo.length, 'new or changed video') + '. Videos already read are reused at no cost.'
        : 'Rebuild the picture from what has already been read (no Claude call).';
      b.addEventListener('click', update);
      updBox.append(b);
      if (state.G) {
        const dl = el('button', 'tlink', 'Download .md');
        dl.type = 'button';
        dl.addEventListener('click', () => {
          const url = URL.createObjectURL(
            new Blob([networkMarkdown(state.G)], { type: 'text/markdown;charset=utf-8' })
          );
          const a = el('a');
          a.href = url;
          a.download = 'Company network ' + isoDay(state.G.builtAt) + '.md';
          document.body.append(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        });
        updBox.append(dl);
      }
      const notYet = deps.getEntries().filter((e) => !e.analyzed).length;
      if (notYet && !state.running) {
        const n = el(
          'span',
          'nnote',
          plural(notYet, 'transcript') +
            ' not analyzed yet ' +
            (notYet === 1 ? 'is' : 'are') +
            ' left out (the Trends tab can analyze them).'
        );
        updBox.append(n);
      }
    }

    function legend() {
      const L = el('div', 'nlegend');
      const item = (cls, text) => {
        const s = el('span', 'li');
        s.append(el('i', cls), text);
        L.append(s);
      };
      item('pl fin', 'Fintech');
      item('pl oth', 'Other company');
      item('pl hub', 'Most connected');
      L.append(el('span', 'li note', 'Bigger name = more videos'));
      item('ln works', 'Works with');
      item('ln competes', 'Competes with');
      item('ln owns', 'Owns / invests in');
      L.append(el('span', 'li note', 'Arrow = direction (provides to, builds on, invests in, acquired)'));
      if (state.withCo) item('ln co', 'Mentioned together');
      return L;
    }

    function vchip(vi) {
      const v = state.G.videos[vi];
      const b = el('button', 'vref', v ? fmtShort(Date.parse(v.day + 'T12:00:00')) : '?');
      b.type = 'button';
      if (v) {
        b.title = v.title + (v.channel ? ' · ' + v.channel : '');
        b.addEventListener('click', () => deps.openEntry(v.key));
      }
      return b;
    }
    const nameOf = (id) => {
      const n = state.G.nodes.find((x) => x.id === id);
      return n ? n.name : id;
    };

    function renderSide(side, V) {
      side.textContent = '';
      const G = state.G;
      const sel = state.sel;
      if (sel && sel.node) {
        const n = G.nodes.find((x) => x.id === sel.node);
        if (!n) {
          state.sel = null;
          return renderSide(side, V);
        }
        const close = el('button', 'tlink nclose', '← Overview');
        close.type = 'button';
        close.addEventListener('click', () => select(null));
        side.append(close);
        side.append(el('h3', null, n.name));
        side.append(
          el(
            'p',
            'nsec',
            [n.sector, n.fintech ? 'fintech' : n.fintech === false ? 'not fintech' : ''].filter(Boolean).join(' · ') +
              ' · ' +
              plural(n.videos.length, 'video')
          )
        );
        if (n.about) side.append(el('p', 'nabout', n.about));
        const mine = G.ties
          .filter((t) => t.a === n.id || t.b === n.id)
          .sort((a, b) => b.videos.length - a.videos.length);
        side.append(el('h4', null, 'Ties (' + mine.length + ')'));
        if (!mine.length) side.append(el('p', 'nmuted', 'No ties to other companies were described.'));
        mine.forEach((t) => side.append(tieBlock(t, n.id)));
        if (n.why.length) {
          side.append(el('h4', null, 'How it came up'));
          const ul = el('ul', 'nwhy');
          n.why
            .slice()
            .sort((a, b) => a.v - b.v)
            .forEach((w) => {
              const li = el('li');
              li.append(vchip(w.v), ' ', w.text);
              ul.append(li);
            });
          side.append(ul);
        }
        return;
      }
      if (sel && sel.tie) {
        const t = G.ties.find((x) => x.a + '|' + x.b === sel.tie);
        const c = !t && G.co.find((x) => x.a + '|' + x.b === sel.tie);
        const close = el('button', 'tlink nclose', '← Overview');
        close.type = 'button';
        close.addEventListener('click', () => select(null));
        side.append(close);
        if (t) {
          side.append(el('h3', null, nameOf(t.a) + ' & ' + nameOf(t.b)));
          side.append(tieBlock(t, null));
        } else if (c) {
          side.append(el('h3', null, nameOf(c.a) + ' & ' + nameOf(c.b)));
          side.append(
            el(
              'p',
              'nmuted',
              'Named in the same ' +
                (c.videos.length === 1 ? 'video' : 'videos') +
                ', with no tie between them described:'
            )
          );
          const p = el('p');
          c.videos.forEach((v) => p.append(vchip(v), ' '));
          side.append(p);
        }
        return;
      }
      // overview
      side.append(el('h3', null, 'Overview'));
      side.append(
        el(
          'p',
          'nmuted',
          V.nodes.length
            ? 'Showing ' +
                plural(V.nodes.length, 'company', 'companies') +
                ' and ' +
                plural(V.edges.filter((e) => e.tie).length, 'tie') +
                (V.hidden
                  ? '. ' +
                    plural(
                      V.hidden,
                      'other ' + (state.show === 'fintech' ? 'fintech company' : 'company'),
                      'other ' + (state.show === 'fintech' ? 'fintech companies' : 'companies')
                    ) +
                    ' came up without a tie to another.'
                  : '.') +
                ' Click a company or a line for the details.'
            : ''
        )
      );
      const deg = new Map();
      V.edges
        .filter((e) => e.tie)
        .forEach((e) => {
          deg.set(e.a, (deg.get(e.a) || 0) + 1);
          deg.set(e.b, (deg.get(e.b) || 0) + 1);
        });
      const most = [...deg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
      if (most.length) {
        side.append(el('h4', null, 'Most connected'));
        const ol = el('ol', 'nrank');
        most.forEach(([id, d]) => {
          const li = el('li');
          const b = el('button', 'mlink', nameOf(id));
          b.type = 'button';
          b.addEventListener('click', () => select({ node: id }));
          li.append(b, el('span', 'nmuted', ' · ' + plural(d, 'tie')));
          ol.append(li);
        });
        side.append(ol);
      }
      const strong = V.edges
        .filter((e) => e.tie)
        .sort((a, b) => b.weight - a.weight || b.tie.items.length - a.tie.items.length)
        .slice(0, 6);
      if (strong.length) {
        side.append(el('h4', null, 'Strongest ties'));
        const ol = el('ol', 'nrank');
        strong.forEach((e) => {
          const li = el('li');
          const b = el('button', 'mlink', nameOf(e.a) + ' & ' + nameOf(e.b));
          b.type = 'button';
          b.addEventListener('click', () => select({ tie: e.a + '|' + e.b }));
          li.append(
            b,
            el('span', 'nmuted', ' · ' + FAMILY_NAME[e.family].toLowerCase() + ' · ' + plural(e.weight, 'video'))
          );
          ol.append(li);
        });
        side.append(ol);
      }
    }
    function tieBlock(t, fromId) {
      const d = el('div', 'tie');
      const other = fromId ? (t.a === fromId ? t.b : t.a) : null;
      const h = el('p', 'th');
      if (other) {
        const b = el('button', 'mlink', nameOf(other));
        b.type = 'button';
        b.addEventListener('click', () => select({ node: other }));
        h.append(b, ' ');
      }
      h.append(el('span', 'fam fam-' + t.family, FAMILY_NAME[t.family]));
      d.append(h);
      const ul = el('ul');
      t.items
        .slice()
        .sort((a, b) => a.v - b.v)
        .forEach((i) => {
          const li = el('li');
          li.append(
            el('b', null, nameOf(i.from) + ' ' + i.label + ' ' + nameOf(i.to) + '. '),
            i.context + ' ',
            vchip(i.v)
          );
          ul.append(li);
        });
      d.append(ul);
      return d;
    }

    function listView(V) {
      const det = el('details', 'nlist');
      det.open = state.listOpen;
      det.addEventListener('toggle', () => {
        state.listOpen = det.open;
      });
      const ties = V.edges.filter((e) => e.tie).sort((a, b) => b.weight - a.weight);
      det.append(el('summary', null, 'All ties as a list (' + ties.length + ')'));
      if (!ties.length) return det;
      const t = el('table', 'ppl');
      const hr = el('tr');
      ['Company', 'Tie', 'Company', 'Videos'].forEach((x) => hr.append(el('th', null, x)));
      const th = el('thead');
      th.append(hr);
      t.append(th);
      const tb = el('tbody');
      ties.forEach((e) => {
        const tr = el('tr');
        const first = e.tie.items[0];
        const a = first ? first.from : e.a,
          b = first ? first.to : e.b;
        tr.append(el('td', null, nameOf(a)));
        const tie = el('td');
        const btn = el('button', 'mlink', first ? first.label : FAMILY_NAME[e.family]);
        btn.type = 'button';
        btn.addEventListener('click', () => {
          select({ tie: e.a + '|' + e.b });
          rootEl.scrollTo({ top: 0, behavior: 'smooth' });
        });
        tie.append(btn, el('span', 'nmuted', ' · ' + FAMILY_NAME[e.family].toLowerCase()));
        tr.append(tie, el('td', null, nameOf(b)), el('td', 'pv', String(e.weight)));
        tb.append(tr);
      });
      t.append(tb);
      det.append(t);
      return det;
    }

    // ---------- the graph ----------
    let applyHighlight = () => {};
    let select = (s) => {
      state.sel = s;
      render();
    };
    function drawGraph(canvas, side, V) {
      const W = Math.max(320, Math.round(canvas.clientWidth || 700)),
        H = Math.max(560, Math.min(900, Math.round(window.innerHeight * 0.78)));
      // sizes: pills sized to their names; the most connected companies are filled
      const deg = new Map();
      V.edges.forEach((e) => {
        if (e.family !== 'co') {
          deg.set(e.a, (deg.get(e.a) || 0) + 1);
          deg.set(e.b, (deg.get(e.b) || 0) + 1);
        }
      });
      const ranked = [...deg.values()].sort((a, b) => b - a);
      const hubMin = Math.max(
        3,
        ranked[Math.min(ranked.length - 1, Math.max(2, Math.floor(ranked.length * 0.12)))] || 3
      );
      V.nodes.forEach((n) => {
        n.deg = deg.get(n.id) || 0;
        n.hub = n.deg >= hubMin;
        n.fs = Math.round((12 + Math.min(3, Math.sqrt(n.videos.length) * 0.8)) * 10) / 10;
        n.w = Math.ceil(textWidth(n.name, n.fs, n.hub ? 700 : 600)) + 24;
        n.h = Math.round(n.fs * 2.1);
      });
      // what each tie says, and which way it points
      V.edges.forEach((e) => {
        if (!e.tie) {
          e.label = '';
          e.labelW = 0;
          return;
        }
        const items = e.tie.items;
        const labels = [...new Set(items.map((i) => i.label).filter(Boolean))];
        e.label =
          clip(labels[0] || FAMILY_NAME[e.family].toLowerCase(), 34) +
          (labels.length > 1 ? '  +' + (labels.length - 1) : '');
        e.labelW = Math.ceil(textWidth(e.label, 10.5, 500)) + 14;
        const dir = items.find((i) => DIRECTED.has(i.type));
        e.from = dir ? dir.from : null;
        e.to = dir ? dir.to : null;
      });
      const byId = new Map(V.nodes.map((n) => [n.id, n]));
      const key = state.show + '|' + state.withCo + '|' + state.G.builtAt;
      if (!state.view || state.view.key !== key) {
        layoutGraph(V.nodes, V.edges);
        state.view = {
          key,
          full: Object.fromEntries(V.nodes.map((n) => [n.id, { x: n.x, y: n.y }])),
          t: null,
          ego: null
        };
      }
      const full = state.view.full;
      const cur = state.view.ego || full;
      V.nodes.forEach((n) => {
        const p = cur[n.id] || full[n.id];
        if (p) {
          n.x = p.x;
          n.y = p.y;
        }
      });

      const svg = svgEl('svg', {
        viewBox: '0 0 ' + W + ' ' + H,
        width: W,
        height: H,
        role: 'img',
        'aria-label':
          'Network of ' +
          V.nodes.length +
          ' companies and the ties between them. The same information is in the list below.'
      });
      const defs = svgEl('defs');
      ['works', 'competes', 'owns', 'other'].forEach((f) => {
        const m = svgEl('marker', {
          id: 'nar-' + f,
          viewBox: '0 0 10 10',
          refX: '8.5',
          refY: '5',
          markerWidth: '7',
          markerHeight: '7',
          orient: 'auto-start-reverse'
        });
        m.append(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', class: 'ah ah-' + f }));
        defs.append(m);
      });
      svg.append(defs);
      const g = svgEl('g');
      svg.append(g);
      if (state.view.ego) svg.classList.add('ego');
      const eg = svgEl('g', { class: 'edges' }),
        lg = svgEl('g', { class: 'elabels' }),
        ng = svgEl('g', { class: 'nodes' });
      g.append(eg, lg, ng);

      // the view: fit what's shown, but never so small the names can't be read (you can pan)
      function fitTo(ids) {
        const list = ids ? V.nodes.filter((n) => ids.has(n.id)) : V.nodes;
        let x0 = Infinity,
          y0 = Infinity,
          x1 = -Infinity,
          y1 = -Infinity;
        list.forEach((n) => {
          x0 = Math.min(x0, n.x - n.w / 2);
          x1 = Math.max(x1, n.x + n.w / 2);
          y0 = Math.min(y0, n.y - n.h / 2);
          y1 = Math.max(y1, n.y + n.h / 2);
        });
        if (!isFinite(x0)) return { x: W / 2, y: H / 2, k: 1 };
        const pad = 40,
          k = Math.max(
            0.68,
            Math.min(1.15, (W - 2 * pad) / Math.max(1, x1 - x0), (H - 2 * pad) / Math.max(1, y1 - y0))
          );
        return { k, x: W / 2 - ((x0 + x1) / 2) * k, y: H / 2 - ((y0 + y1) / 2) * k };
      }
      if (!state.view.t) state.view.t = fitTo(null);
      const applyT = () =>
        g.setAttribute(
          'transform',
          'translate(' +
            state.view.t.x.toFixed(1) +
            ',' +
            state.view.t.y.toFixed(1) +
            ') scale(' +
            state.view.t.k.toFixed(4) +
            ')'
        );
      applyT();

      // ties
      const edgeEls = [];
      const tieCount = V.edges.filter((e) => e.tie).length;
      const strongCut =
        tieCount <= 45
          ? 0
          : Math.max(
              2,
              [...V.edges]
                .filter((e) => e.tie)
                .map((e) => e.weight)
                .sort((a, b) => b - a)[24] || 2
            );
      V.edges
        .slice()
        .sort((a, b) => (b.family === 'co') - (a.family === 'co'))
        .forEach((e) => {
          const width = e.family === 'co' ? 1 : Math.min(4, 1.6 + Math.log2(e.weight) * 1.1);
          const path = svgEl('path', { class: 'edge e-' + e.family, 'stroke-width': width, fill: 'none' });
          if (e.from) path.setAttribute('marker-end', 'url(#nar-' + e.family + ')');
          const hit = svgEl('path', { class: 'ehit', fill: 'none' });
          let lab = null;
          if (e.label) {
            lab = svgEl('g', { class: 'elab' + (e.weight >= strongCut ? ' show' : '') });
            lab.append(svgEl('rect', { x: -e.labelW / 2, y: -9, width: e.labelW, height: 18, rx: 9 }));
            const t = svgEl('text', { x: 0, y: 3.8, 'text-anchor': 'middle' });
            t.textContent = e.label;
            lab.append(t);
            lg.append(lab);
          }
          const bend = e.family === 'co' ? 0 : hashNum(e.a + e.b) % 2 ? 0.55 : -0.55;
          const rec = { e, path, hit, lab, bend };
          hit.addEventListener('pointermove', (ev) => {
            const lines = e.tie
              ? e.tie.items.slice(0, 3).map((i) => nameOf(i.from) + ' ' + i.label + ' ' + nameOf(i.to))
              : [];
            showTip(
              ev.clientX,
              ev.clientY,
              byId.get(e.a).name + ' & ' + byId.get(e.b).name,
              FAMILY_NAME[e.family] + ' · ' + plural(e.weight, 'video'),
              lines
            );
          });
          hit.addEventListener('pointerleave', hideTip);
          hit.addEventListener('click', (ev) => {
            ev.stopPropagation();
            select({ tie: e.a + '|' + e.b });
          });
          eg.append(path, hit);
          edgeEls.push(rec);
        });
      function placeEdge(r) {
        const e = r.e;
        const a = byId.get(e.from || e.a),
          b = byId.get(e.to || e.b);
        const bend = state.view.ego ? 0 : r.bend;
        const geo = edgeGeom(a, b, bend);
        r.path.setAttribute('d', geo.d);
        r.hit.setAttribute('d', geo.d);
        if (r.lab) r.lab.setAttribute('transform', 'translate(' + geo.lx.toFixed(1) + ',' + geo.ly.toFixed(1) + ')');
      }

      // companies
      const nodeEls = new Map();
      V.nodes.forEach((n) => {
        const grp = svgEl('g', {
          class: 'pill ' + (n.hub ? 'hub ' : '') + (n.fintech ? 'fin' : 'oth'),
          tabindex: '0',
          role: 'button',
          'aria-label': n.name + (n.sector ? ', ' + n.sector : '') + ', ' + plural(n.deg, 'tie')
        });
        grp.append(svgEl('rect', { x: -n.w / 2, y: -n.h / 2, width: n.w, height: n.h, rx: n.h / 2 }));
        const t = svgEl('text', { x: 0, y: n.fs * 0.36, 'text-anchor': 'middle', style: 'font-size:' + n.fs + 'px' });
        t.textContent = n.name;
        grp.append(t);
        grp.addEventListener('pointerenter', (ev) => {
          showTip(
            ev.clientX,
            ev.clientY,
            n.name,
            [n.sector, plural(n.videos.length, 'video'), plural(n.deg, 'tie')].filter(Boolean).join(' · '),
            n.about ? [clip(n.about, 90)] : []
          );
          hoverOn(n.id);
        });
        grp.addEventListener('pointerleave', () => {
          hideTip();
          hoverOn(null);
        });
        grp.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            select({ node: n.id });
          }
        });
        // drag to move a company; a click without moving opens its ties
        grp.addEventListener('pointerdown', (ev) => {
          ev.stopPropagation();
          grp.setPointerCapture(ev.pointerId);
          const start = { x: ev.clientX, y: ev.clientY, nx: n.x, ny: n.y };
          let moved = false;
          const scale = W / svg.getBoundingClientRect().width / state.view.t.k;
          const mv = (e2) => {
            const ddx = (e2.clientX - start.x) * scale,
              ddy = (e2.clientY - start.y) * scale;
            if (!moved && Math.hypot(ddx, ddy) < 3) return;
            moved = true;
            hideTip();
            n.x = start.nx + ddx;
            n.y = start.ny + ddy;
            (state.view.ego || state.view.full)[n.id] = { x: n.x, y: n.y };
            placeNode(n);
            edgeEls.forEach((r) => {
              if (r.e.a === n.id || r.e.b === n.id) placeEdge(r);
            });
          };
          const up = () => {
            grp.removeEventListener('pointermove', mv);
            grp.removeEventListener('pointerup', up);
            if (!moved) select({ node: n.id });
          };
          grp.addEventListener('pointermove', mv);
          grp.addEventListener('pointerup', up);
        });
        ng.append(grp);
        nodeEls.set(n.id, grp);
      });
      function hoverOn(id) {
        if (state.view.ego) return; // the focused view already shows everything about one company
        svg.classList.toggle('hovering', !!id);
        const near = new Set(id ? [id] : []);
        edgeEls.forEach((r) => {
          const hit = !!id && (r.e.a === id || r.e.b === id);
          if (hit) {
            near.add(r.e.a);
            near.add(r.e.b);
          }
          r.path.classList.toggle('hon', hit);
          if (r.lab) r.lab.classList.toggle('hon', hit);
        });
        nodeEls.forEach((grp, nid) => grp.classList.toggle('hon', near.has(nid)));
      }
      const placeNode = (n) =>
        nodeEls.get(n.id).setAttribute('transform', 'translate(' + n.x.toFixed(1) + ',' + n.y.toFixed(1) + ')');
      const placeAll = () => {
        V.nodes.forEach(placeNode);
        edgeEls.forEach(placeEdge);
      };
      placeAll();
      // in the whole network, only keep the always-on tie labels that don't cover a company or another label
      (function declutter() {
        const boxes = V.nodes.map((n) => ({
          x0: n.x - n.w / 2 - 4,
          x1: n.x + n.w / 2 + 4,
          y0: n.y - n.h / 2 - 3,
          y1: n.y + n.h / 2 + 3
        }));
        const hits = (b) => boxes.some((o) => b.x0 < o.x1 && o.x0 < b.x1 && b.y0 < o.y1 && o.y0 < b.y1);
        edgeEls
          .filter((r) => r.lab && r.lab.classList.contains('show'))
          .sort((a, b) => b.e.weight - a.e.weight)
          .forEach((r) => {
            const a = byId.get(r.e.from || r.e.a),
              b = byId.get(r.e.to || r.e.b);
            const geo = edgeGeom(a, b, r.bend);
            const box = { x0: geo.lx - r.e.labelW / 2, x1: geo.lx + r.e.labelW / 2, y0: geo.ly - 9, y1: geo.ly + 9 };
            if (hits(box)) r.lab.classList.remove('show');
            else boxes.push(box);
          });
      })();

      // pan by dragging the background, zoom with the wheel or the buttons
      svg.addEventListener('pointerdown', (ev) => {
        if (ev.target !== svg) return;
        svg.setPointerCapture(ev.pointerId);
        const s0 = { x: ev.clientX, y: ev.clientY, tx: state.view.t.x, ty: state.view.t.y };
        let moved = false;
        const scale = W / svg.getBoundingClientRect().width;
        const mv = (e2) => {
          const ddx = (e2.clientX - s0.x) * scale,
            ddy = (e2.clientY - s0.y) * scale;
          if (Math.hypot(ddx, ddy) > 3) moved = true;
          state.view.t.x = s0.tx + ddx;
          state.view.t.y = s0.ty + ddy;
          applyT();
        };
        const up = () => {
          svg.removeEventListener('pointermove', mv);
          svg.removeEventListener('pointerup', up);
          svg.classList.remove('panning');
          if (!moved && state.sel) select(null);
        };
        svg.classList.add('panning');
        svg.addEventListener('pointermove', mv);
        svg.addEventListener('pointerup', up);
      });
      const zoomAt = (f, cx, cy) => {
        const t = state.view.t,
          k2 = Math.min(3, Math.max(0.3, t.k * f));
        t.x = cx - (cx - t.x) * (k2 / t.k);
        t.y = cy - (cy - t.y) * (k2 / t.k);
        t.k = k2;
        applyT();
      };
      svg.addEventListener(
        'wheel',
        (ev) => {
          ev.preventDefault();
          const r = svg.getBoundingClientRect(),
            scale = W / r.width;
          zoomAt(Math.exp(-ev.deltaY * 0.0015), (ev.clientX - r.left) * scale, (ev.clientY - r.top) * scale);
        },
        { passive: false }
      );
      const zb = el('div', 'nzoom');
      [
        ['+', 'Zoom in', () => zoomAt(1.25, W / 2, H / 2)],
        ['−', 'Zoom out', () => zoomAt(0.8, W / 2, H / 2)],
        [
          'Fit',
          'Fit to the window',
          () => animateTo(null, fitTo(state.view.ego ? new Set(Object.keys(state.view.ego)) : null))
        ]
      ].forEach(([t, l, fn]) => {
        const b = el('button', null, t);
        b.type = 'button';
        b.title = l;
        b.setAttribute('aria-label', l);
        b.addEventListener('click', fn);
        zb.append(b);
      });
      const back = el('button', 'nback', '← Whole network');
      back.type = 'button';
      back.hidden = !state.view.ego;
      back.addEventListener('click', () => select(null));
      canvas.append(svg, zb, back);

      // smooth moves between the whole network and one company's ties
      let anim = 0;
      function animateTo(pos, t2, ms) {
        cancelAnimationFrame(anim);
        const from = new Map(V.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
        const t1 = { ...state.view.t };
        const t0 = performance.now(),
          dur = ms || 520;
        const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
        const step = (now) => {
          const p = ease(Math.min(1, (now - t0) / dur));
          if (pos)
            V.nodes.forEach((n) => {
              const a = from.get(n.id),
                b = pos[n.id] || a;
              n.x = a.x + (b.x - a.x) * p;
              n.y = a.y + (b.y - a.y) * p;
            });
          if (t2) {
            state.view.t = { x: t1.x + (t2.x - t1.x) * p, y: t1.y + (t2.y - t1.y) * p, k: t1.k + (t2.k - t1.k) * p };
            applyT();
          }
          placeAll();
          if (p < 1) anim = requestAnimationFrame(step);
        };
        anim = requestAnimationFrame(step);
      }

      // what's highlighted: a company's ties (arranged around it), or one tie
      applyHighlight = () => {
        const s = state.sel;
        const on = new Set(),
          onE = new Set();
        if (s && s.node) {
          on.add(s.node);
          V.edges.forEach((e) => {
            if (e.a === s.node || e.b === s.node) {
              on.add(e.a);
              on.add(e.b);
              onE.add(e);
            }
          });
        }
        if (s && s.tie)
          V.edges.forEach((e) => {
            if (e.a + '|' + e.b === s.tie) {
              on.add(e.a);
              on.add(e.b);
              onE.add(e);
            }
          });
        const active = on.size > 0;
        svg.classList.toggle('focus', active);
        nodeEls.forEach((grp, id) => {
          grp.classList.toggle('on', on.has(id));
          grp.classList.toggle('sel', !!(s && s.node === id));
        });
        edgeEls.forEach((r) => {
          const isOn = onE.has(r.e),
            ctx = !isOn && active && on.has(r.e.a) && on.has(r.e.b);
          r.path.classList.toggle('on', isOn);
          r.path.classList.toggle('ctx', ctx);
          r.hit.classList.toggle('on', isOn);
          if (r.lab) r.lab.classList.toggle('on', isOn);
        });
      };
      function focusOn(s) {
        if (s && s.node && byId.has(s.node)) {
          const c = byId.get(s.node);
          const ids = new Set([c.id]);
          V.edges.forEach((e) => {
            if (e.a === c.id) ids.add(e.b);
            if (e.b === c.id) ids.add(e.a);
          });
          const order = { works: 0, owns: 1, competes: 2, other: 3, co: 4 };
          const nb = [...ids]
            .filter((id) => id !== c.id)
            .map((id) => byId.get(id))
            .sort((a, b) => {
              const ea = V.edges.find((e) => (e.a === c.id && e.b === a.id) || (e.b === c.id && e.a === a.id));
              const eb = V.edges.find((e) => (e.a === c.id && e.b === b.id) || (e.b === c.id && e.a === b.id));
              return order[ea.family] - order[eb.family] || eb.weight - ea.weight || a.name.localeCompare(b.name);
            });
          const base = state.view.ego && state.view.ego[c.id] ? state.view.ego[c.id] : full[c.id];
          const pos = Object.assign({}, full, egoLayout(c, nb, base));
          state.view.ego = pos;
          back.hidden = false;
          svg.classList.add('ego');
          // fit the company and its ties
          const save = new Map(V.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
          V.nodes.forEach((n) => {
            n.x = pos[n.id].x;
            n.y = pos[n.id].y;
          });
          const t2 = fitTo(ids);
          V.nodes.forEach((n) => {
            const p = save.get(n.id);
            n.x = p.x;
            n.y = p.y;
          });
          animateTo(pos, t2);
        } else if (!s && state.view.ego) {
          state.view.ego = null;
          back.hidden = true;
          svg.classList.remove('ego');
          const save = new Map(V.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
          V.nodes.forEach((n) => {
            n.x = full[n.id].x;
            n.y = full[n.id].y;
          });
          const t2 = fitTo(null);
          V.nodes.forEach((n) => {
            const p = save.get(n.id);
            n.x = p.x;
            n.y = p.y;
          });
          animateTo(full, t2);
        }
      }
      select = (s) => {
        state.sel = s;
        if (s && s.node && !V.nodes.some((n) => n.id === s.node)) {
          state.view.ego = null;
          render();
          return;
        }
        if (!s || s.node) focusOn(s);
        applyHighlight();
        renderSide(side, V);
      };
      applyHighlight();
      renderSide(side, V);
      if (state.sel && state.sel.node && !state.view.ego && byId.has(state.sel.node)) focusOn(state.sel);
    }

    // ---------- update ----------
    async function update() {
      if (state.running) return;
      await load();
      const todo = pending();
      if (todo.length && !settings.hasKey) {
        state.msg = {
          text: 'To use this, add your Anthropic API key in Settings. It’s stored locally in this browser.',
          kind: 'error'
        };
        renderStatus();
        return;
      }
      state.running = true;
      state.msg = null;
      const meter = AI.newMeter();
      const jobs = batches(todo);
      let done = 0,
        failed = 0,
        err = '';
      const t0 = Date.now();
      const tick = () => {
        state.progress = todo.length
          ? 'Reading ' +
            plural(todo.length, 'video') +
            '… ' +
            done +
            '/' +
            jobs.length +
            ' batch' +
            (jobs.length === 1 ? '' : 'es') +
            ' · ' +
            Math.round((Date.now() - t0) / 1000) +
            's'
          : 'Rebuilding…';
        renderStatus();
      };
      tick();
      const timer = setInterval(tick, 1000);
      const all0 = await chrome.storage.local.get(CLS_KEY);
      const cls = all0[CLS_KEY] || {};
      let i = 0;
      const worker = async () => {
        while (i < jobs.length) {
          const job = jobs[i++];
          try {
            const res = await AI.call(job.req);
            AI.meterAdd(meter, res);
            const out = (res && res.input) || {};
            const write = {};
            job.vids.forEach((e, k) => {
              const v = (out.videos || []).find((x) => Number(x.video) === k + 1);
              write[VPREFIX + e.key] = {
                fp: fingerprint(e),
                at: Date.now(),
                model: res.model,
                ties: ((v && v.ties) || []).filter((t) => t && t.from && t.to).slice(0, 60)
              };
            });
            for (const c of out.companies || [])
              if (c && c.name)
                cls[norm(c.name)] = {
                  sector: SECTORS.includes(c.sector) ? c.sector : 'Other',
                  fintech: !!c.fintech,
                  about: clip(c.about, 200)
                };
            await chrome.storage.local.set(write);
          } catch (e) {
            failed++;
            err = String((e && e.message) || e);
            if (/NO_KEY|^40[13]|credit|billing|api key/i.test(err)) {
              i = jobs.length;
            }
          } finally {
            done++;
          }
        }
      };
      await Promise.all([worker(), worker()]);
      clearInterval(timer);
      if (meter.cost) AI.addToSpend(meter);
      try {
        await chrome.storage.local.set({ [CLS_KEY]: cls });
        const all = await chrome.storage.local.get(null);
        const perVideo = {};
        const live = new Set(deps.getEntries().map((e) => e.key));
        const stale = [];
        for (const k of Object.keys(all)) {
          if (!k.startsWith(VPREFIX)) continue;
          const key = k.slice(VPREFIX.length);
          if (live.has(key)) perVideo[key] = all[k];
          else stale.push(k);
        }
        if (stale.length) await chrome.storage.local.remove(stale); // videos you deleted from the Library
        const G = buildSnapshot(analyzed(), perVideo, cls);
        G.cost = meter.cost;
        await chrome.storage.local.set({ [GRAPH_KEY]: G });
        state.G = G;
        state.view = null;
        state.sel = null;
        state.msg = failed
          ? {
              text:
                'Updated, but ' +
                plural(failed, 'batch', 'batches') +
                ' failed (' +
                err.replace(/^NO_KEY$/, 'no API key') +
                '); press Update again to retry ' +
                (failed === 1 ? 'it' : 'them') +
                '.',
              kind: 'error'
            }
          : {
              text:
                'Updated from ' +
                plural(G.videos.length, 'video') +
                (todo.length ? '. This update cost ' + AI.meterText(meter) + '.' : ' (nothing new to read, no cost).')
            };
      } catch (e) {
        state.msg = { text: 'Couldn’t update the network: ' + ((e && e.message) || e), kind: 'error' };
      }
      state.running = false;
      await load();
      state.lastPending = pending().length;
      render();
    }

    let shown = false;
    window.addEventListener('resize', () => {
      if (shown && state.G) {
        clearTimeout(render._t);
        render._t = setTimeout(() => {
          state.view = null;
          render();
        }, 200);
      }
    });
    return {
      async show() {
        shown = true;
        await load();
        state.lastPending = pending().length;
        render();
      },
      hide() {
        shown = false;
        hideTip();
      },
      // The picture only changes when you press Update; other changes just refresh the "new since" note.
      async update() {
        if (!shown || state.running) return;
        const before = state.G && state.G.builtAt;
        await load();
        const waiting = pending().length;
        if (waiting !== state.lastPending) state.msg = null; // something new arrived: show "N new since" instead of the last run's message
        state.lastPending = waiting;
        if ((state.G && state.G.builtAt) !== before) {
          state.view = null;
          render();
        } else renderStatus();
      }
    };
  }

  root.YTCTNetwork = {
    mount,
    buildSnapshot,
    batches,
    fingerprint,
    layoutGraph,
    egoLayout,
    removeOverlaps,
    networkMarkdown,
    TOOL
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
