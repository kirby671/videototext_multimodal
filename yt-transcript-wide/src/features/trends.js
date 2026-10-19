/*
 * Trends across the Library.
 *  - Instant, free: videos over time, which companies come up when (and how they were described), people.
 *    These come straight from each video's saved analysis.
 *  - Trend report (one Claude call): reads every analysis in range together and reports recurring themes and
 *    how they evolved, what's emerging or fading, shifts in views, agreement and disagreement, company stories,
 *    numbers over time, and what to watch. Saved, so reopening it is free.
 */
(function (root) {
  'use strict';
  const AI = root.YTCTPanel.claude;
  const REPORT_KEY = 'trends:report';
  const DAY = 86400000;
  const MAX_VIDEOS = 300;

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
  const isoDay = (t) => {
    const d = new Date(t);
    return (
      d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    );
  };
  const fmtDay = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const fmtShort = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const dateOf = (e) => e.published || e.created;
  // "2026-09-12" is a calendar day: read it as local midnight, not UTC.
  const parseDay = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : Date.parse(s);
  };

  // ---------- time buckets ----------
  function bucketsFor(dates) {
    const min = Math.min(...dates),
      max = Math.max(...dates);
    const span = (max - min) / DAY;
    const unit = span <= 120 ? 'week' : span <= 730 ? 'month' : 'quarter';
    const startOf = (t) => {
      const d = new Date(t);
      d.setHours(0, 0, 0, 0);
      if (unit === 'week') {
        const wd = (d.getDay() + 6) % 7;
        d.setDate(d.getDate() - wd);
      } else if (unit === 'month') d.setDate(1);
      else {
        d.setDate(1);
        d.setMonth(d.getMonth() - (d.getMonth() % 3));
      }
      return d;
    };
    const next = (d) => {
      const n = new Date(d);
      if (unit === 'week') n.setDate(n.getDate() + 7);
      else n.setMonth(n.getMonth() + (unit === 'month' ? 1 : 3));
      return n;
    };
    const out = [];
    for (let d = startOf(min); d.getTime() <= max && out.length < 400; d = next(d)) {
      const end = next(d).getTime();
      let label, long;
      if (unit === 'week') {
        label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        long = 'Week of ' + fmtDay(d);
      } else if (unit === 'month') {
        label =
          d.toLocaleDateString(undefined, { month: 'short' }) +
          (d.getMonth() === 0 || !out.length ? ' ’' + String(d.getFullYear()).slice(2) : '');
        long = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      } else {
        label = 'Q' + (Math.floor(d.getMonth() / 3) + 1) + ' ’' + String(d.getFullYear()).slice(2);
        long = 'Q' + (Math.floor(d.getMonth() / 3) + 1) + ' ' + d.getFullYear();
      }
      out.push({ start: d.getTime(), end, label, long });
    }
    const indexOf = (t) => {
      for (let i = 0; i < out.length; i++) if (t >= out[i].start && t < out[i].end) return i;
      return out.length - 1;
    };
    return { unit, list: out, indexOf };
  }

  // ---------- local aggregates ----------
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/&/g, 'and')
      .replace(/[^a-z0-9]+/g, '');
  const GENERIC_PERSON = /^(speaker|host|guest|interviewer|narrator|unknown|moderator|audience|voice)\b|^s\d+$/i;
  function companyGroups(list) {
    const alias = new Map(),
      groups = new Map();
    for (const e of list) {
      for (const c of (e.rec.analysis && e.rec.analysis.companies) || []) {
        const k0 = norm(c.name);
        if (!k0) continue;
        const key = alias.get(k0) || k0;
        alias.set(k0, key);
        for (const a of c.aliases || []) {
          const ka = norm(a);
          if (ka.length >= 3 && !alias.has(ka)) alias.set(ka, key);
        }
        if (!groups.has(key)) groups.set(key, { key, names: new Map(), types: new Map(), mentions: [] });
        const g = groups.get(key);
        g.names.set(c.name, (g.names.get(c.name) || 0) + 1);
        if (c.type) g.types.set(c.type, (g.types.get(c.type) || 0) + 1);
        if (!g.mentions.some((m) => m.e === e)) g.mentions.push({ e, why: c.why || '' });
      }
    }
    const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    return [...groups.values()]
      .map((g) => ({
        ...g,
        name: top(g.names)[0],
        type: g.types.size ? top(g.types)[0] : '',
        mentions: g.mentions.sort((a, b) => dateOf(a.e) - dateOf(b.e))
      }))
      .sort(
        (a, b) =>
          b.mentions.length - a.mentions.length ||
          dateOf(b.mentions[b.mentions.length - 1].e) - dateOf(a.mentions[a.mentions.length - 1].e)
      );
  }
  function peopleGroups(list) {
    const groups = new Map();
    for (const e of list) {
      for (const s of e.rec.speakers || []) {
        const name = String(s.name || '').trim();
        if (!name || GENERIC_PERSON.test(name)) continue;
        const k = norm(name);
        if (!groups.has(k)) groups.set(k, { name, roles: new Map(), videos: [] });
        const g = groups.get(k);
        if (s.role) g.roles.set(s.role, (g.roles.get(s.role) || 0) + 1);
        if (!g.videos.includes(e)) g.videos.push(e);
      }
    }
    return [...groups.values()]
      .map((g) => ({
        ...g,
        role: g.roles.size ? [...g.roles.entries()].sort((a, b) => b[1] - a[1])[0][0] : '',
        videos: g.videos.sort((a, b) => dateOf(a) - dateOf(b))
      }))
      .sort((a, b) => b.videos.length - a.videos.length || a.name.localeCompare(b.name));
  }

  // ---------- the trend report request ----------
  const TREND_SYSTEM = [
    'You are analysing a personal library of video transcripts (podcasts, interviews, talks) that the reader has already summarised one by one.',
    'Find the trends ACROSS the videos over time: what keeps coming up and how the discussion of it changed, what is new, what has faded, how views have shifted, where speakers agree and disagree, how companies are being talked about, and which numbers are cited over time.',
    'The videos are given oldest first as [V1], [V2] …, each with its date. Ground every claim in them and cite videos inline as [V3] or [V3, V7]. Prefer specifics (names, numbers, short quotes) over generalities.',
    'A trend needs at least two videos. Trajectory: "rising" = more frequent or more emphasis in later videos; "steady" = throughout; "fading" = mostly in earlier videos; "new" = only in the latest part of the range.',
    'Never invent dates, numbers or quotes. If the videos are few or cover a short period, say so in the overview and keep the report proportionate.',
    'Write plainly for a busy reader. No preamble.'
  ].join(' ');
  const vids = { type: 'array', items: { type: 'integer' }, description: 'V numbers' };
  const TREND_TOOL = {
    name: 'report_trends',
    description: 'Report the trends across the videos in the library.',
    input_schema: {
      type: 'object',
      properties: {
        overview: {
          type: 'string',
          description:
            '3-6 sentences: the big picture across these videos and how it changed over the period, citing [Vn].'
        },
        themes: {
          type: 'array',
          description: 'Recurring themes, most important first.',
          items: {
            type: 'object',
            properties: {
              theme: { type: 'string', description: 'Short name, 2-6 words.' },
              videos: vids,
              trajectory: { type: 'string', enum: ['rising', 'steady', 'fading', 'new'] },
              evolution: {
                type: 'string',
                description: '1-3 sentences on how the discussion changed over time, citing [Vn].'
              },
              points: {
                type: 'array',
                items: { type: 'string' },
                description: '2-4 key points made about it across videos, each citing [Vn].'
              }
            },
            required: ['theme', 'videos', 'trajectory', 'evolution']
          }
        },
        emerging: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              topic: { type: 'string' },
              videos: vids,
              why: { type: 'string', description: 'Why it matters, citing [Vn].' }
            },
            required: ['topic', 'videos', 'why']
          }
        },
        fading: {
          type: 'array',
          items: {
            type: 'object',
            properties: { topic: { type: 'string' }, videos: vids, note: { type: 'string' } },
            required: ['topic', 'videos', 'note']
          }
        },
        shifts: {
          type: 'array',
          description: 'Views that changed over time (across speakers or within one).',
          items: {
            type: 'object',
            properties: {
              subject: { type: 'string' },
              before: { type: 'string', description: 'Earlier view, citing [Vn].' },
              after: { type: 'string', description: 'Later view, citing [Vn].' },
              who: { type: 'string' }
            },
            required: ['subject', 'before', 'after']
          }
        },
        consensus: {
          type: 'array',
          items: {
            type: 'object',
            properties: { view: { type: 'string' }, videos: vids },
            required: ['view', 'videos']
          }
        },
        disagreements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              positions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { position: { type: 'string' }, who: { type: 'string' }, videos: vids },
                  required: ['position', 'videos']
                }
              }
            },
            required: ['question', 'positions']
          }
        },
        companies: {
          type: 'array',
          description: 'Companies whose story across the videos is worth telling.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              videos: vids,
              trajectory: { type: 'string', enum: ['rising', 'steady', 'fading', 'new'] },
              story: { type: 'string', description: 'How the way it is discussed changed, citing [Vn].' }
            },
            required: ['name', 'videos', 'story']
          }
        },
        numbers: {
          type: 'array',
          description: 'Figures cited in more than one video, or that changed over time.',
          items: {
            type: 'object',
            properties: {
              metric: { type: 'string' },
              values: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { value: { type: 'string' }, video: { type: 'integer' } },
                  required: ['value', 'video']
                }
              },
              note: { type: 'string' }
            },
            required: ['metric', 'values']
          }
        },
        watch: {
          type: 'array',
          items: { type: 'string' },
          description: 'Open questions and things to watch next, citing [Vn] where relevant.'
        }
      },
      required: ['overview', 'themes']
    }
  };

  function digest(e, n, budget) {
    const A = (root.YTCT && root.YTCT.resolveSpeakerIds(e.rec.analysis, e.rec.speakers)) || e.rec.analysis || {};
    const ppl = (e.rec.speakers || []).map((s) => s.name + (s.role ? ' (' + s.role + ')' : '')).join('; ');
    const parts = [
      '[V' +
        n +
        '] ' +
        isoDay(dateOf(e)) +
        ' · "' +
        clip(e.title, 160) +
        '"' +
        (e.channel ? ' · ' + clip(e.channel, 60) : '') +
        (ppl ? '\nPeople: ' + clip(ppl, 300) : '')
    ];
    const add = (label, items) => {
      if (items.length) parts.push(label + ':\n' + items.map((x) => '- ' + x).join('\n'));
    };
    if (A.summary) parts.push('Summary: ' + clip(A.summary, 700));
    add(
      'Themes',
      (A.themes || []).slice(0, 8).map((t) => clip(t.theme + (t.context ? ' — ' + t.context : ''), 220))
    );
    add(
      'Views',
      (A.how_they_see_it || [])
        .slice(0, 6)
        .map((x) => clip(x.view + (x.detail ? ': ' + x.detail : '') + (x.speaker ? ' (' + x.speaker + ')' : ''), 240))
    );
    add(
      'Strong statements',
      (A.strong_statements || [])
        .slice(0, 5)
        .map((x) =>
          clip(
            '“' + String(x.quote || '').replace(/^["“]|["”]$/g, '') + '”' + (x.speaker ? ' — ' + x.speaker : ''),
            240
          )
        )
    );
    add(
      'Companies',
      (A.companies || []).slice(0, 20).map((c) => clip(c.name + (c.why ? ' — ' + c.why : ''), 170))
    );
    add(
      'Facts & figures',
      (A.facts_and_figures || []).slice(0, 8).map((x) => clip(x.fact + (x.speaker ? ' (' + x.speaker + ')' : ''), 200))
    );
    add(
      'How they do it',
      (A.how_they_do_it || []).slice(0, 4).map((x) => clip(x.point + (x.detail ? ': ' + x.detail : ''), 200))
    );
    if ((A.concepts || []).length)
      parts.push('Concepts explained: ' + clip(A.concepts.map((c) => c.concept).join('; '), 400));
    let out = parts.join('\n');
    while (out.length > budget && parts.length > 2) {
      parts.pop();
      out = parts.join('\n');
    }
    return out.length > budget ? out.slice(0, budget) : out;
  }

  function buildRequest(list, focus, lang) {
    const n = list.length;
    const budget = Math.max(1500, Math.min(6000, Math.floor(500000 / Math.max(1, n))));
    const digests = list.map((e, i) => digest(e, i + 1, budget));
    const guidance =
      n <= 3
        ? 'There are only ' +
          n +
          ' videos: keep the report short, and say that trends across so few videos are tentative.'
        : n <= 10
          ? 'Aim for 4-7 themes and up to 4 items in each other list; leave a list empty rather than pad it.'
          : 'Aim for 6-10 themes and up to 6 items in each other list; leave a list empty rather than pad it.';
    const li = root.YTCT && root.YTCT.languageInstruction ? root.YTCT.languageInstruction(lang) : '';
    const system =
      TREND_SYSTEM +
      '\n\n' +
      guidance +
      (focus
        ? '\n\nThe reader especially wants to track: ' +
          focus +
          '. Lead with what bears on it, but still report the other major trends.'
        : '') +
      (li ? '\n\n' + li : '');
    const user =
      'The library: ' +
      plural(n, 'video') +
      ' from ' +
      isoDay(dateOf(list[0])) +
      ' to ' +
      isoDay(dateOf(list[n - 1])) +
      ', oldest first.\n\n' +
      digests.join('\n\n');
    return { system, user, tool: TREND_TOOL, maxTokens: Math.min(32000, 6000 + 350 * n) };
  }

  // Rough cost before running (shown on the button); the real cost comes from Claude's token counts.
  function estimate(model, inTok, outTok) {
    const p = AI.PRICES[model] || AI.PRICES['claude-opus-5-5'];
    const long = p.longOver && inTok > p.longOver;
    return (inTok / 1e6) * (long ? p.inLong : p.in) + (outTok / 1e6) * (long ? p.outLong : p.out);
  }
  const estimateReport = (req, n, model) =>
    estimate(
      model,
      Math.round((req.system.length + req.user.length) / 3.6) + 900,
      Math.min(req.maxTokens, 2500 + 220 * n)
    );
  const estimateAnalyses = (list, model) =>
    list.reduce(
      (sum, e) =>
        sum + estimate(model, Math.round(e.words * 1.4) + 1500, Math.min(9000, 1500 + Math.round(e.words * 0.6))),
      0
    );

  // ---------- markdown export ----------
  function reportMarkdown(rep) {
    const R = rep.result || {};
    const V = rep.videos || [];
    const cite = (s) => String(s || '');
    const vlist = (arr) => (arr || []).map((n) => 'V' + n).join(', ');
    const L = [
      '# Trends across your Library',
      '',
      '_From ' +
        plural(V.length, 'video') +
        (V.length ? ' (' + V[0].day + ' to ' + V[V.length - 1].day + ')' : '') +
        ', written ' +
        fmtDay(rep.createdAt) +
        (rep.focus ? '. Focus: ' + rep.focus : '') +
        '._',
      ''
    ];
    if (R.overview) L.push('## Overview', '', cite(R.overview), '');
    if ((R.themes || []).length) {
      L.push('## Themes', '');
      R.themes.forEach((t) => {
        L.push(
          '### ' + t.theme + ' (' + (t.trajectory || 'steady') + ', ' + plural((t.videos || []).length, 'video') + ')',
          '',
          cite(t.evolution)
        );
        (t.points || []).forEach((p) => L.push('- ' + cite(p)));
        L.push('');
      });
    }
    const sec = (title, arr, fn) => {
      if ((arr || []).length) {
        L.push('## ' + title, '');
        arr.forEach((x) => L.push(fn(x)));
        L.push('');
      }
    };
    sec('Emerging', R.emerging, (x) => '- **' + x.topic + '** (' + vlist(x.videos) + ') — ' + cite(x.why));
    sec('Fading', R.fading, (x) => '- **' + x.topic + '** (' + vlist(x.videos) + ') — ' + cite(x.note));
    sec(
      'Shifts in views',
      R.shifts,
      (x) =>
        '- **' +
        x.subject +
        '**' +
        (x.who ? ' (' + x.who + ')' : '') +
        '\n  - Before: ' +
        cite(x.before) +
        '\n  - Now: ' +
        cite(x.after)
    );
    sec('Where they agree', R.consensus, (x) => '- ' + cite(x.view) + ' (' + vlist(x.videos) + ')');
    sec(
      'Where they disagree',
      R.disagreements,
      (x) =>
        '- **' +
        x.question +
        '**\n' +
        (x.positions || [])
          .map((p) => '  - ' + cite(p.position) + (p.who ? ' — ' + p.who : '') + ' (' + vlist(p.videos) + ')')
          .join('\n')
    );
    sec(
      'Companies',
      R.companies,
      (x) => '- **' + x.name + '**' + (x.trajectory ? ' (' + x.trajectory + ')' : '') + ' — ' + cite(x.story)
    );
    sec(
      'Numbers over time',
      R.numbers,
      (x) =>
        '- **' +
        x.metric +
        '**: ' +
        (x.values || []).map((v) => v.value + ' (V' + v.video + ')').join(' → ') +
        (x.note ? ' — ' + x.note : '')
    );
    sec('What to watch', R.watch, (x) => '- ' + cite(x));
    L.push('## Videos', '');
    V.forEach((v) =>
      L.push(
        '- V' +
          v.n +
          ' · ' +
          v.day +
          ' · ' +
          v.title +
          (v.channel ? ' (' + v.channel + ')' : '') +
          (v.videoId ? ' — https://www.youtube.com/watch?v=' + v.videoId : '')
      )
    );
    return L.join('\n') + '\n';
  }

  // ---------- the view ----------
  function mount(rootEl, deps) {
    const state = {
      range: 'all',
      channel: '',
      openCo: null,
      openTheme: null,
      report: null,
      running: false,
      batch: null,
      coShowAll: false,
      focus: ''
    };
    try {
      const s = JSON.parse(localStorage.getItem('ytct-trends') || '{}');
      if (s.range) state.range = s.range;
      if (s.channel) state.channel = s.channel;
    } catch (e) {
      /* ignore */
    }
    let settings = { model: 'claude-opus-5-5', hasKey: false };
    const loadSettings = async () => {
      const all = await chrome.storage.local.get(['apiKey', 'model', 'analysisLang', 'trendFocus', REPORT_KEY]);
      settings = {
        model: all.model || 'claude-opus-5-5',
        hasKey: !!String(all.apiKey || '').trim(),
        lang: all.analysisLang || 'en'
      };
      if (!state.focus) state.focus = all.trendFocus || '';
      state.report = all[REPORT_KEY] || null;
    };

    const tip = el('div', 'ttip');
    tip.hidden = true;
    tip.setAttribute('role', 'tooltip');
    document.body.append(tip);
    function showTip(target, value, label, lines) {
      tip.textContent = '';
      tip.append(el('b', null, value));
      if (label) tip.append(el('span', 'tl', label));
      (lines || []).slice(0, 5).forEach((l) => tip.append(el('span', 'tx', l)));
      if ((lines || []).length > 5) tip.append(el('span', 'tx', '+ ' + ((lines || []).length - 5) + ' more'));
      tip.hidden = false;
      const r = target.getBoundingClientRect(),
        t = tip.getBoundingClientRect();
      let x = r.left + r.width / 2 - t.width / 2,
        y = r.top - t.height - 8;
      if (y < 8) y = r.bottom + 8;
      x = Math.max(8, Math.min(window.innerWidth - t.width - 8, x));
      tip.style.left = Math.round(x) + 'px';
      tip.style.top = Math.round(y) + 'px';
    }
    const hideTip = () => {
      tip.hidden = true;
    };
    rootEl.addEventListener('scroll', hideTip, { passive: true });

    function scoped() {
      const now = Date.now();
      const days = { 30: 30, 90: 90, 365: 365 }[state.range];
      return deps
        .getEntries()
        .filter((e) => (!days || dateOf(e) >= now - days * DAY) && (!state.channel || e.channel === state.channel))
        .sort((a, b) => dateOf(a) - dateOf(b));
    }

    // Video chip for a V number in the current report.
    function vchip(n, rep) {
      const v = (rep.videos || [])[n - 1];
      const b = el('button', 'vref', 'V' + n);
      b.type = 'button';
      if (v) {
        b.title = v.day + ' · ' + v.title;
        b.dataset.key = v.key;
      } else b.disabled = true;
      return b;
    }
    // Text with [V3] / [V3, V7] citations turned into chips.
    function cited(text, rep) {
      const frag = document.createDocumentFragment();
      const s = String(text || '');
      const re = /\[(V\d+(?:\s*[,;&]\s*(?:V)?\d+)*)\]/g;
      let last = 0,
        m;
      while ((m = re.exec(s))) {
        frag.append(s.slice(last, m.index));
        const nums = m[1]
          .split(/[,;&]/)
          .map((x) => parseInt(x.replace(/\D/g, ''), 10))
          .filter((x) => x > 0);
        const wrap = el('span', 'vrefs');
        nums.forEach((n) => wrap.append(vchip(n, rep)));
        frag.append(wrap);
        last = m.index + m[0].length;
      }
      frag.append(s.slice(last));
      return frag;
    }
    function chips(nums, rep) {
      const w = el('span', 'vrefs');
      (nums || []).forEach((n) => w.append(vchip(n, rep)));
      return w;
    }
    const TRAJ = { rising: '↗ Rising', steady: '→ Steady', fading: '↘ Fading', new: '✦ New' };
    const trajTag = (t) => el('span', 'traj traj-' + (TRAJ[t] ? t : 'steady'), TRAJ[t] || TRAJ.steady);

    rootEl.addEventListener('click', (ev) => {
      const v = ev.target.closest('.vref');
      if (v && v.dataset.key) {
        hideTip();
        deps.openEntry(v.dataset.key);
      }
    });

    // ---------- charts ----------
    function columnChart(box, buckets, groups) {
      box.textContent = '';
      const W = Math.max(300, Math.round(box.clientWidth || 640)),
        H = 168,
        padL = 30,
        padR = 8,
        padT = 12,
        padB = 24;
      const counts = groups.map((g) => g.length);
      const max = Math.max(1, ...counts);
      const top = max <= 4 ? max : Math.ceil(max / (max <= 10 ? 2 : 5)) * (max <= 10 ? 2 : 5);
      const ticks =
        top <= 4 ? Array.from({ length: top + 1 }, (_, i) => i) : [0, top / 2, top].map((x) => Math.round(x));
      const plotH = H - padT - padB,
        band = (W - padL - padR) / Math.max(1, buckets.list.length),
        bw = Math.max(3, Math.min(24, band * 0.62));
      const svg = svgEl('svg', {
        viewBox: '0 0 ' + W + ' ' + H,
        width: W,
        height: H,
        role: 'img',
        'aria-label': 'Videos per ' + (buckets.unit || 'period')
      });
      ticks.forEach((t) => {
        const y = padT + plotH - (t / top) * plotH;
        svg.append(svgEl('line', { x1: padL, x2: W - padR, y1: y, y2: y, class: t === 0 ? 'axis' : 'grid' }));
        const tx = svgEl('text', { x: padL - 6, y: y + 3.5, 'text-anchor': 'end', class: 'tick' });
        tx.textContent = String(t);
        svg.append(tx);
      });
      const every = Math.max(1, Math.ceil(46 / band));
      buckets.list.forEach((b, i) => {
        const x = padL + i * band + (band - bw) / 2,
          c = counts[i];
        if (c) {
          const h = (c / top) * plotH,
            y = padT + plotH - h,
            r = Math.min(4, h, bw / 2);
          svg.append(
            svgEl('path', {
              class: 'bar',
              d:
                'M' +
                x +
                ',' +
                (padT + plotH) +
                'V' +
                (y + r) +
                'a' +
                r +
                ',' +
                r +
                ' 0 0 1 ' +
                r +
                ',' +
                -r +
                'H' +
                (x + bw - r) +
                'a' +
                r +
                ',' +
                r +
                ' 0 0 1 ' +
                r +
                ',' +
                r +
                'V' +
                (padT + plotH) +
                'Z'
            })
          );
        }
        if (i % every === 0) {
          const t = svgEl('text', { x: padL + i * band + band / 2, y: H - 6, 'text-anchor': 'middle', class: 'tick' });
          t.textContent = b.label;
          svg.append(t);
        }
        const hit = svgEl('rect', {
          x: padL + i * band,
          y: padT,
          width: band,
          height: plotH,
          class: 'hit',
          tabindex: c ? '0' : '-1'
        });
        const show = () =>
          showTip(
            hit,
            plural(c, 'video'),
            b.long,
            groups[i].map((e) => e.title)
          );
        hit.addEventListener('pointerenter', show);
        hit.addEventListener('focus', show);
        hit.addEventListener('pointerleave', hideTip);
        hit.addEventListener('blur', hideTip);
        svg.append(hit);
      });
      box.append(svg);
    }

    // A heatmap as a real table: one row per item, one column per period, the count in each cell.
    function heatmap(rows, buckets, opts) {
      const wrap = el('div', 'hmwrap');
      const t = el('table', 'hm');
      const thead = el('thead'),
        hr = el('tr');
      hr.append(el('th', 'rl', opts.firstCol));
      buckets.list.forEach((b) => {
        const th = el('th', 'bh', b.label);
        th.title = b.long;
        hr.append(th);
      });
      hr.append(el('th', 'tot', 'Videos'));
      thead.append(hr);
      t.append(thead);
      const tbody = el('tbody');
      const max = Math.max(1, ...rows.map((r) => Math.max(0, ...r.perBucket.map((x) => x.length))));
      rows.forEach((r) => {
        const tr = el('tr', 'row');
        tr.tabIndex = 0;
        tr.setAttribute('aria-expanded', String(!!r.open));
        const th = el('th', 'rl');
        th.scope = 'row';
        const nm = el('span', 'nm', r.label);
        nm.title = r.label;
        th.append(nm);
        if (r.tag) th.append(r.tag);
        tr.append(th);
        r.perBucket.forEach((list, i) => {
          const td = el('td', 'c');
          const n = list.length;
          if (n) {
            td.dataset.l = String(Math.max(1, Math.min(6, Math.ceil((n / max) * 6))));
            td.textContent = String(n);
            const show = () =>
              showTip(
                td,
                plural(n, 'video'),
                r.label + ' · ' + buckets.list[i].long,
                list.map((e) => e.title)
              );
            td.addEventListener('pointerenter', show);
            td.addEventListener('pointerleave', hideTip);
          }
          tr.append(td);
        });
        tr.append(el('td', 'tot', String(r.total)));
        const toggle = () => {
          opts.onToggle(r);
        };
        tr.addEventListener('click', toggle);
        tr.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            toggle();
          }
        });
        tbody.append(tr);
        if (r.open) {
          const dr = el('tr', 'detail'),
            dc = el('td');
          dc.colSpan = buckets.list.length + 2;
          dc.append(r.detail());
          dr.append(dc);
          tbody.append(dr);
        }
      });
      t.append(tbody);
      wrap.append(t);
      return wrap;
    }

    // ---------- render ----------
    function card(title, sub) {
      const c = el('section', 'tcard');
      const h = el('div', 'thead');
      h.append(el('h3', null, title));
      if (sub) h.append(el('p', 'sub', sub));
      c.append(h);
      return c;
    }

    function render() {
      hideTip();
      const act = document.activeElement;
      const typing =
        act && act.classList && act.classList.contains('rfocus')
          ? { a: act.selectionStart, b: act.selectionEnd }
          : null;
      const keepScroll = rootEl.scrollTop;
      paint();
      rootEl.scrollTop = keepScroll;
      if (typing) {
        const f = rootEl.querySelector('.rfocus');
        if (f) {
          f.focus();
          try {
            f.setSelectionRange(typing.a, typing.b);
          } catch (e) {
            /* ignore */
          }
        }
      }
    }
    function paint() {
      const all = deps.getEntries();
      const list = scoped();
      const analyzed = list.filter((e) => e.analyzed);
      rootEl.textContent = '';
      const w = el('div', 'tw');
      rootEl.append(w);

      // filters
      const f = el('div', 'filters');
      const rangeSel = el('select');
      rangeSel.setAttribute('aria-label', 'Date range');
      [
        ['all', 'All time'],
        ['30', 'Last 30 days'],
        ['90', 'Last 90 days'],
        ['365', 'Last 12 months']
      ].forEach(([v, t]) => {
        const o = el('option', null, t);
        o.value = v;
        rangeSel.append(o);
      });
      rangeSel.value = state.range;
      const chSel = el('select');
      chSel.setAttribute('aria-label', 'Channel');
      const allO = el('option', null, 'All channels');
      allO.value = '';
      chSel.append(allO);
      [...new Set(all.map((e) => e.channel).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b))
        .forEach((c) => {
          const o = el('option', null, c);
          o.value = c;
          chSel.append(o);
        });
      chSel.value = state.channel;
      const save = () => {
        try {
          localStorage.setItem('ytct-trends', JSON.stringify({ range: state.range, channel: state.channel }));
        } catch (e) {
          /* ignore */
        }
      };
      rangeSel.addEventListener('change', () => {
        state.range = rangeSel.value;
        save();
        render();
      });
      chSel.addEventListener('change', () => {
        state.channel = chSel.value;
        save();
        render();
      });
      f.append(rangeSel, chSel);
      const pub = list.filter((e) => e.published).length;
      if (list.length)
        f.append(
          el(
            'span',
            'fnote',
            pub === list.length
              ? 'Dated by when each video was published'
              : pub
                ? 'Dated by publish date (' + pub + ') or the day you saved it (' + (list.length - pub) + ')'
                : 'Dated by the day you saved each one'
          )
        );
      w.append(f);

      if (!all.length) {
        w.append(
          el(
            'p',
            'tempty',
            'Your Library is empty. Get a transcript on YouTube or paste one, and trends will appear here as your Library grows.'
          )
        );
        return;
      }
      if (!list.length) {
        w.append(el('p', 'tempty', 'Nothing in this range. Try a longer date range or all channels.'));
        return;
      }

      // KPIs
      const cos = companyGroups(analyzed),
        people = peopleGroups(analyzed);
      const hours = list.reduce((s, e) => s + (e.seconds || 0), 0) / 3600;
      const k = el('div', 'kpis');
      const tile = (label, value, note) => {
        const t = el('div', 'kpi');
        t.append(el('span', 'kl', label), el('span', 'kv', value));
        if (note) t.append(el('span', 'kn', note));
        k.append(t);
      };
      tile(
        'Transcripts',
        list.length.toLocaleString(),
        analyzed.length === list.length ? 'all analyzed' : analyzed.length + ' analyzed'
      );
      tile(
        'Hours of video',
        hours >= 10 ? Math.round(hours).toLocaleString() : hours.toFixed(1),
        fmtShort(dateOf(list[0])) + ' – ' + fmtShort(dateOf(list[list.length - 1]))
      );
      tile('Channels', String(new Set(list.map((e) => e.channel).filter(Boolean)).size || '—'));
      tile(
        'People',
        people.length ? people.length.toLocaleString() : '—',
        people.length ? 'speakers identified' : 'analyze to identify'
      );
      tile(
        'Companies',
        cos.length ? cos.length.toLocaleString() : '—',
        cos.length ? 'mentioned' : 'analyze to find them'
      );
      w.append(k);

      const buckets = bucketsFor(list.map(dateOf));
      const per = (vlist) => {
        const out = buckets.list.map(() => []);
        vlist.forEach((e) => out[buckets.indexOf(dateOf(e))].push(e));
        return out;
      };

      // trend report
      w.append(reportCard(list, analyzed));

      // companies over time
      if (cos.length) {
        const c = card(
          'Companies over time',
          'How many videos mentioned each company, per ' +
            buckets.unit +
            '. Click a row to see how it was described each time.'
        );
        const shown = state.coShowAll ? cos : cos.slice(0, 12);
        const rows = shown.map((g) => ({
          label: g.name,
          total: g.mentions.length,
          open: state.openCo === g.key,
          tag: g.type && g.type !== 'company' ? el('span', 'ctype', g.type) : null,
          perBucket: per(g.mentions.map((m) => m.e)),
          key: g.key,
          detail: () => {
            const ul = el('ul', 'mentions');
            g.mentions.forEach((m) => {
              const li = el('li');
              li.append(el('span', 'md', fmtShort(dateOf(m.e))));
              const b = el('button', 'mlink', m.e.title);
              b.type = 'button';
              b.addEventListener('click', (ev) => {
                ev.stopPropagation();
                deps.openEntry(m.e.key);
              });
              li.append(b);
              if (m.why) li.append(el('span', 'mwhy', ' — ' + m.why));
              ul.append(li);
            });
            return ul;
          }
        }));
        c.append(
          heatmap(rows, buckets, {
            firstCol: 'Company',
            onToggle: (r) => {
              state.openCo = state.openCo === r.key ? null : r.key;
              render();
            }
          })
        );
        if (cos.length > 12) {
          const more = el(
            'button',
            'tlink',
            state.coShowAll ? 'Show the top 12' : 'Show all ' + cos.length + ' companies'
          );
          more.type = 'button';
          more.addEventListener('click', () => {
            state.coShowAll = !state.coShowAll;
            render();
          });
          c.append(more);
        }
        w.append(c);
      }

      // videos over time
      const vc = card('Videos over time', 'Transcripts in your Library per ' + buckets.unit + '.');
      const chart = el('div', 'chart');
      vc.append(chart);
      w.append(vc);
      columnChart(chart, buckets, per(list));

      // people
      if (people.length) {
        const pc = card('People', 'Speakers identified across your videos, most frequent first.');
        const t = el('table', 'ppl');
        const hr = el('tr');
        ['Name', 'Role', 'Videos', 'Last seen'].forEach((h) => hr.append(el('th', null, h)));
        const th = el('thead');
        th.append(hr);
        t.append(th);
        const tb = el('tbody');
        people.slice(0, 20).forEach((p) => {
          const tr = el('tr');
          tr.append(el('td', 'pn', p.name), el('td', 'pr', p.role || ''), el('td', 'pv', String(p.videos.length)));
          const last = p.videos[p.videos.length - 1];
          const td = el('td', 'pl');
          const b = el('button', 'mlink', fmtShort(dateOf(last)));
          b.type = 'button';
          b.title = last.title;
          b.addEventListener('click', () => deps.openEntry(last.key));
          td.append(b);
          tr.append(td);
          tb.append(tr);
        });
        t.append(tb);
        pc.append(t);
        w.append(pc);
      }
    }

    function reportCard(list, analyzed) {
      const c = card('Trend report', null);
      c.classList.add('report');
      const rep = state.report;
      const missing = list.filter((e) => !e.analyzed);
      const status = el('p', 'rstatus');
      status.setAttribute('role', 'status');

      // controls: focus + run
      const ctl = el('div', 'rctl');
      const focus = el('input');
      focus.type = 'text';
      focus.className = 'rfocus';
      focus.placeholder = 'Optional: what do you want to track? e.g. “stablecoin adoption by banks”';
      focus.value = state.focus || '';
      focus.setAttribute('aria-label', 'What do you want to track (optional)');
      focus.addEventListener('input', () => {
        state.focus = focus.value;
      });
      const n = Math.min(analyzed.length, MAX_VIDEOS);
      const use = analyzed.slice(-MAX_VIDEOS);
      const req = n ? buildRequest(use, (state.focus || '').trim(), settings.lang) : null;
      const est = req ? estimateReport(req, n, settings.model) : 0;
      const run = el('button', 'tbtn primary', rep ? 'Re-run report' : 'Write the trend report');
      run.type = 'button';
      run.disabled = state.running || !!state.batch || n < 2;
      if (n >= 2) run.append(el('span', 'est', ' · about ' + AI.money(est)));
      run.title =
        n >= 2
          ? 'One Claude call that reads the analyses of ' +
            plural(n, 'video') +
            ' together. Estimated from the length; the real cost is shown when it finishes.'
          : 'Needs at least two analyzed transcripts.';
      run.addEventListener('click', () => runReport(use, (focus.value || '').trim()));
      ctl.append(focus, run);
      c.append(ctl);

      if (missing.length) {
        const mb = el('div', 'missing');
        const estA = estimateAnalyses(missing, settings.model);
        mb.append(
          el(
            'span',
            null,
            plural(missing.length, 'transcript') +
              ' in this range ' +
              (missing.length === 1 ? 'hasn’t' : 'haven’t') +
              ' been analyzed yet, so the report can’t use ' +
              (missing.length === 1 ? 'it' : 'them') +
              '. '
          )
        );
        if (state.batch) {
          mb.append(el('b', null, 'Analyzing ' + state.batch.done + ' of ' + state.batch.total + '… '));
          const stop = el('button', 'tlink', 'Stop after this one');
          stop.type = 'button';
          stop.addEventListener('click', () => {
            state.batch.stop = true;
            stop.disabled = true;
            stop.textContent = 'Stopping…';
          });
          mb.append(stop);
        } else {
          const go = el('button', 'tbtn', 'Analyze ' + (missing.length === 1 ? 'it' : 'them') + ' first');
          go.type = 'button';
          go.disabled = state.running;
          go.append(el('span', 'est', ' · about ' + AI.money(estA)));
          go.title =
            'Runs the usual analysis on each one, one after another (' +
            (AI.PRICES[settings.model] || {}).name +
            '). Estimated from their length.';
          go.addEventListener('click', () => analyzeMissing(missing));
          mb.append(go);
        }
        c.append(mb);
      }
      c.append(status);
      if (state.lastMsg) {
        status.textContent = state.lastMsg.text;
        status.dataset.kind = state.lastMsg.kind || '';
      }
      if (state.running) {
        status.textContent = 'Writing the trend report from ' + plural(n, 'video') + '… this can take a minute or two.';
        status.dataset.kind = 'work';
      }

      if (!rep || !rep.result) {
        if (!state.running)
          c.append(
            el(
              'p',
              'rhint',
              n >= 2
                ? 'Claude reads the saved analyses of the ' +
                    plural(n, 'analyzed video') +
                    ' in this range together and writes up the trends: themes and how they evolved, what’s emerging or fading, shifts in views, where speakers agree and disagree, company stories, numbers over time, and what to watch.'
                : 'The trend report needs at least two analyzed transcripts in this range.'
            )
          );
        return c;
      }
      c.append(renderReport(rep, list));
      return c;
    }

    // ---------- PDFs: a trend with the full transcripts of the videos it cites ----------
    const REF_RE = /\[(V\d+(?:\s*[,;&]\s*(?:V)?\d+)*)\]/g;
    const refsIn = (text) => {
      const out = [];
      String(text || '').replace(REF_RE, (m, g) => {
        g.split(/[,;&]/).forEach((x) => {
          const n = parseInt(x.replace(/\D/g, ''), 10);
          if (n > 0) out.push(n);
        });
        return m;
      });
      return out;
    };
    const uniq = (arr) => [...new Set(arr.filter((n) => n > 0))].sort((a, b) => a - b);
    const trajWord = (t) => ({ rising: 'Rising', steady: 'Steady', fading: 'Fading', new: 'New' })[t] || '';
    const P = (text) => ({ t: 'p', text });
    const LI = (text) => ({ t: 'li', text });

    // What each item in the report is, for its PDF: heading, the trend text, and the videos it rests on.
    function itemSpec(kind, x) {
      if (kind === 'theme')
        return {
          title: x.theme,
          kicker: ['Theme', trajWord(x.trajectory)],
          body: [
            { h: 'How it evolved', p: [x.evolution] },
            { h: 'Key points', li: x.points || [] }
          ],
          videos: uniq([...(x.videos || []), ...refsIn(x.evolution), ...(x.points || []).flatMap(refsIn)]),
          cites: [x.evolution, ...(x.points || [])]
        };
      if (kind === 'emerging')
        return {
          title: x.topic,
          kicker: ['Emerging'],
          body: [{ h: 'Why it matters', p: [x.why] }],
          videos: uniq([...(x.videos || []), ...refsIn(x.why)]),
          cites: [x.why]
        };
      if (kind === 'fading')
        return {
          title: x.topic,
          kicker: ['Fading'],
          body: [{ h: 'What changed', p: [x.note] }],
          videos: uniq([...(x.videos || []), ...refsIn(x.note)]),
          cites: [x.note]
        };
      if (kind === 'shift')
        return {
          title: x.subject,
          kicker: ['Shift in views', x.who],
          body: [
            { h: 'Before', p: [x.before] },
            { h: 'Now', p: [x.after] }
          ],
          videos: uniq([...refsIn(x.before), ...refsIn(x.after)]),
          cites: [x.before, x.after]
        };
      if (kind === 'consensus')
        return { title: x.view, kicker: ['Where they agree'], body: [], videos: uniq(x.videos || []), cites: [] };
      if (kind === 'disagreement')
        return {
          title: x.question,
          kicker: ['Where they disagree'],
          body: [
            {
              h: 'Positions',
              li: (x.positions || []).map(
                (p) =>
                  p.position +
                  (p.who ? ' — ' + p.who : '') +
                  ((p.videos || []).length ? ' [' + p.videos.map((n) => 'V' + n).join(', ') + ']' : '')
              )
            }
          ],
          videos: uniq((x.positions || []).flatMap((p) => [...(p.videos || []), ...refsIn(p.position)])),
          cites: (x.positions || []).map(
            (p) => p.position + ' [' + (p.videos || []).map((n) => 'V' + n).join(', ') + ']'
          )
        };
      if (kind === 'company')
        return {
          title: x.name,
          kicker: ['Company story', trajWord(x.trajectory)],
          body: [{ h: 'The story', p: [x.story] }],
          videos: uniq([...(x.videos || []), ...refsIn(x.story)]),
          cites: [x.story]
        };
      return null;
    }

    async function transcriptOptions() {
      let version = 'distilled';
      try {
        version = JSON.parse(localStorage.getItem('ytct-dl') || '{}').version === 'clean' ? 'clean' : 'distilled';
      } catch (e) {
        /* default */
      }
      let clean = { removeFillers: true, removeTags: true };
      try {
        clean = await chrome.storage.local.get(clean);
      } catch (e) {
        /* defaults */
      }
      return { version, clean };
    }
    // The videos' sections: each on a new page, with why it's cited, its summary and the full transcript.
    function videoBlocks(rep, nums, why, opt) {
      const V = rep.videos || [];
      const byKey = new Map(deps.getEntries().map((e) => [e.key, e]));
      const blocks = [];
      for (const n of nums) {
        const v = V[n - 1];
        if (!v) continue;
        const e = byKey.get(v.key);
        blocks.push({ t: 'h2', text: 'V' + n + ' · ' + v.title, newPage: true });
        if (!e) {
          blocks.push(
            { t: 'meta', text: [v.channel, v.day].filter(Boolean).join(' · ') },
            { t: 'note', text: 'This video is no longer in your Library, so its transcript can’t be included.' }
          );
          continue;
        }
        const X = root.YTCTExport.videoParts(e, opt.version, opt.clean);
        if (X.meta) blocks.push({ t: 'meta', text: X.meta });
        const reasons = why(n);
        if (reasons.length) {
          blocks.push({ t: 'h3', text: 'Why it’s cited' });
          reasons.forEach((r) => blocks.push(LI(r)));
        }
        if (X.A && X.A.summary) {
          blocks.push({ t: 'h3', text: 'Summary' }, P(X.A.summary));
        }
        if (X.speakers && X.speakers.length)
          blocks.push({
            t: 'note',
            text: 'Speakers: ' + X.speakers.map((sp) => sp.name + (sp.role ? ' (' + sp.role + ')' : '')).join(', ')
          });
        blocks.push({ t: 'h3', text: X.distilled ? 'Transcript (distilled, grouped by speaker)' : 'Transcript' });
        if (!X.paras.length) blocks.push({ t: 'note', text: 'The transcript is empty.' });
        X.paras.forEach((p) => {
          if (p.chapter) blocks.push({ t: 'h3', text: p.chapter });
          blocks.push({
            t: 'p',
            runs: p.name ? [{ text: p.name + ': ', b: true }, { text: p.text }] : [{ text: p.text }]
          });
        });
      }
      return blocks;
    }
    const videoList = (rep, nums) =>
      nums
        .map((n) => {
          const v = (rep.videos || [])[n - 1];
          return v ? LI('V' + n + ' · ' + v.day + ' · ' + v.title + (v.channel ? ' — ' + v.channel : '')) : null;
        })
        .filter(Boolean);
    const safeName = (s) =>
      String(s || '')
        .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80)
        .trim();

    async function itemPdf(rep, kind, x) {
      const spec = itemSpec(kind, x);
      if (!spec || !spec.videos.length) throw new Error('This item doesn’t cite any videos.');
      const opt = await transcriptOptions();
      const blocks = [{ t: 'title', text: spec.title }];
      blocks.push({
        t: 'meta',
        text: [
          ...spec.kicker.filter(Boolean),
          plural(spec.videos.length, 'video'),
          'from your trend report of ' + fmtDay(rep.createdAt)
        ].join(' · ')
      });
      if (rep.focus) blocks.push({ t: 'note', text: 'Report focus: ' + rep.focus });
      spec.body.forEach((sec) => {
        const ps = (sec.p || []).filter(Boolean),
          ls = (sec.li || []).filter(Boolean);
        if (!ps.length && !ls.length) return;
        blocks.push({ t: 'h3', text: sec.h });
        ps.forEach((t) => blocks.push(P(t)));
        ls.forEach((t) => blocks.push(LI(t)));
      });
      blocks.push({ t: 'h3', text: 'Videos (' + spec.videos.length + ')' }, ...videoList(rep, spec.videos));
      const why = (n) => spec.cites.filter((t) => refsIn(t).includes(n));
      blocks.push(...videoBlocks(rep, spec.videos, why, opt));
      const bytes = await root.YTCTPdf.makePdf(blocks, {
        title: spec.title,
        footer: spec.kicker[0] + ': ' + spec.title
      });
      root.YTCTPdf.downloadPdf(
        bytes,
        safeName(spec.kicker[0] + ' - ' + spec.title) + ' (' + plural(spec.videos.length, 'transcript') + ').pdf'
      );
      return spec.videos.length;
    }

    async function reportPdf(rep) {
      const R = rep.result || {};
      const opt = await transcriptOptions();
      const all = [];
      const blocks = [
        { t: 'title', text: 'Trends across your Library' },
        {
          t: 'meta',
          text:
            'From ' +
            plural((rep.videos || []).length, 'video') +
            ' · written ' +
            fmtDay(rep.createdAt) +
            (rep.modelName ? ' by ' + rep.modelName : '')
        }
      ];
      if (rep.focus) blocks.push({ t: 'note', text: 'Report focus: ' + rep.focus });
      const sec = (h, items) => {
        if (items.length) {
          blocks.push({ t: 'h3', text: h });
          blocks.push(...items);
        }
      };
      if (R.overview) {
        sec('Overview', [P(R.overview)]);
        all.push(...refsIn(R.overview));
      }
      (R.themes || []).forEach((t, i) => {
        if (!i) blocks.push({ t: 'h2', text: 'Themes' });
        blocks.push({
          t: 'h3',
          text:
            t.theme +
            (t.trajectory ? ' · ' + trajWord(t.trajectory) : '') +
            ' · ' +
            plural((t.videos || []).length, 'video') +
            ' [' +
            (t.videos || []).map((n) => 'V' + n).join(', ') +
            ']'
        });
        if (t.evolution) blocks.push(P(t.evolution));
        (t.points || []).forEach((p) => blocks.push(LI(p)));
        all.push(...(t.videos || []), ...refsIn(t.evolution), ...(t.points || []).flatMap(refsIn));
      });
      const listSec = (h, arr, fn, refs) => {
        if ((arr || []).length) {
          blocks.push({ t: 'h2', text: h });
          arr.forEach((x) => {
            blocks.push(LI(fn(x)));
            all.push(...refs(x));
          });
        }
      };
      const vtag = (a) => ((a || []).length ? ' [' + a.map((n) => 'V' + n).join(', ') + ']' : '');
      listSec(
        'Emerging',
        R.emerging,
        (x) => x.topic + vtag(x.videos) + ' — ' + x.why,
        (x) => [...(x.videos || []), ...refsIn(x.why)]
      );
      listSec(
        'Fading',
        R.fading,
        (x) => x.topic + vtag(x.videos) + ' — ' + x.note,
        (x) => [...(x.videos || []), ...refsIn(x.note)]
      );
      listSec(
        'Shifts in views',
        R.shifts,
        (x) => x.subject + (x.who ? ' (' + x.who + ')' : '') + '. Before: ' + x.before + ' Now: ' + x.after,
        (x) => [...refsIn(x.before), ...refsIn(x.after)]
      );
      listSec(
        'Where they agree',
        R.consensus,
        (x) => x.view + vtag(x.videos),
        (x) => x.videos || []
      );
      listSec(
        'Where they disagree',
        R.disagreements,
        (x) =>
          x.question +
          ': ' +
          (x.positions || []).map((p) => p.position + (p.who ? ' (' + p.who + ')' : '') + vtag(p.videos)).join('; '),
        (x) => (x.positions || []).flatMap((p) => p.videos || [])
      );
      listSec(
        'Company stories',
        R.companies,
        (x) => x.name + (x.trajectory ? ' (' + trajWord(x.trajectory) + ')' : '') + ' — ' + x.story,
        (x) => [...(x.videos || []), ...refsIn(x.story)]
      );
      listSec(
        'Numbers over time',
        R.numbers,
        (x) =>
          x.metric +
          ': ' +
          (x.values || []).map((v) => v.value + ' [V' + v.video + ']').join(' -> ') +
          (x.note ? ' — ' + x.note : ''),
        (x) => (x.values || []).map((v) => v.video)
      );
      listSec(
        'What to watch',
        R.watch,
        (x) => x,
        (x) => refsIn(x)
      );
      const nums = uniq(all.filter((n) => (rep.videos || [])[n - 1]));
      blocks.push({ t: 'h2', text: 'Videos cited (' + nums.length + ')' }, ...videoList(rep, nums));
      const why = (n) =>
        (R.themes || [])
          .filter((t) => (t.videos || []).includes(n) || refsIn(t.evolution).includes(n))
          .map((t) => 'Theme: ' + t.theme);
      blocks.push(...videoBlocks(rep, nums, why, opt));
      const bytes = await root.YTCTPdf.makePdf(blocks, {
        title: 'Trends across your Library',
        footer: 'Trends · ' + fmtDay(rep.createdAt)
      });
      root.YTCTPdf.downloadPdf(
        bytes,
        'Trends ' + isoDay(rep.createdAt) + ' with ' + plural(nums.length, 'transcript') + '.pdf'
      );
      return nums.length;
    }

    // A small "Transcripts (PDF)" button for an item.
    function pdfButton(rep, label, make, title) {
      const b = el('button', 'tlink pdfbtn', label);
      b.type = 'button';
      if (title) b.title = title;
      b.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (b.disabled) return;
        const was = b.textContent;
        b.disabled = true;
        b.textContent = 'Making PDF…';
        const st = rootEl.querySelector('.rstatus');
        try {
          const n = await make();
          if (st) {
            st.textContent = 'Downloaded a PDF with ' + plural(n, 'transcript') + '.';
            st.dataset.kind = '';
          }
        } catch (e) {
          if (st) {
            st.textContent = 'Couldn’t make the PDF: ' + ((e && e.message) || e);
            st.dataset.kind = 'error';
          }
        } finally {
          b.disabled = false;
          b.textContent = was;
        }
      });
      return b;
    }
    const itemPdfButton = (rep, kind, x, short) => {
      const spec = itemSpec(kind, x);
      if (!spec || !spec.videos.length) return null;
      return pdfButton(
        rep,
        short
          ? 'PDF'
          : 'Download ' +
              (spec.videos.length === 1 ? 'the transcript' : 'these ' + spec.videos.length + ' transcripts') +
              ' (PDF)',
        () => itemPdf(rep, kind, x),
        'Download this trend with the full transcript' +
          (spec.videos.length === 1 ? '' : 's') +
          ' of the ' +
          plural(spec.videos.length, 'video') +
          ' it cites, as a PDF'
      );
    };

    function renderReport(rep, list) {
      const R = rep.result;
      const box = el('div', 'rbody');
      const V = rep.videos || [];
      const inScope = new Set(list.filter((e) => e.analyzed).map((e) => e.key));
      const newer = [...inScope].filter((k) => !V.some((v) => v.key === k)).length;
      const meta = el('p', 'rmeta');
      meta.append(
        'From ' +
          plural(V.length, 'video') +
          (V.length
            ? ' (' + fmtShort(parseDay(V[0].day)) + ' – ' + fmtShort(parseDay(V[V.length - 1].day)) + ')'
            : '') +
          ' · written ' +
          fmtDay(rep.createdAt) +
          ' by ' +
          (rep.modelName || 'Claude') +
          (rep.cost ? ' · cost about ' + AI.money(rep.cost) : '') +
          (rep.focus ? ' · focus: ' + rep.focus : '')
      );
      const dl = el('button', 'tlink', 'Download .md');
      dl.type = 'button';
      dl.addEventListener('click', () => {
        const url = URL.createObjectURL(new Blob([reportMarkdown(rep)], { type: 'text/markdown;charset=utf-8' }));
        const a = el('a');
        a.href = url;
        a.download = 'Trends ' + isoDay(rep.createdAt) + '.md';
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      });
      meta.append(
        ' ',
        dl,
        ' ',
        pdfButton(
          rep,
          'Report + transcripts (PDF)',
          () => reportPdf(rep),
          'The whole report, followed by the full transcript of every video it cites, as a PDF'
        )
      );
      box.append(meta);
      if (newer)
        box.append(
          el(
            'p',
            'rnew',
            plural(newer, 'analyzed transcript') +
              ' in this range ' +
              (newer === 1 ? 'isn’t' : 'aren’t') +
              ' in this report yet. Re-run to include ' +
              (newer === 1 ? 'it' : 'them') +
              '.'
          )
        );

      if (R.overview) {
        const p = el('p', 'overview');
        p.append(cited(R.overview, rep));
        box.append(p);
      }

      // themes as a heatmap over the report's own videos
      const themes = (R.themes || []).filter((t) => t && t.theme);
      if (themes.length) {
        box.append(el('h4', null, 'Themes'));
        const dates = V.map((v) => parseDay(v.day)).filter((x) => !isNaN(x));
        const buckets = bucketsFor(dates.length ? dates : [Date.now()]);
        const rows = themes.map((t, i) => {
          const per = buckets.list.map(() => []);
          (t.videos || []).forEach((n) => {
            const v = V[n - 1];
            if (v) per[buckets.indexOf(parseDay(v.day))].push({ title: v.title });
          });
          return {
            label: t.theme,
            total: (t.videos || []).filter((n) => V[n - 1]).length,
            open: state.openTheme === i,
            key: i,
            tag: trajTag(t.trajectory),
            perBucket: per,
            detail: () => {
              const d = el('div', 'tdetail');
              const p = el('p');
              p.append(cited(t.evolution, rep));
              d.append(p);
              if ((t.points || []).length) {
                const ul = el('ul');
                t.points.forEach((x) => {
                  const li = el('li');
                  li.append(cited(x, rep));
                  ul.append(li);
                });
                d.append(ul);
              }
              const vv = el('p', 'tv');
              vv.append('Videos: ', chips(t.videos, rep));
              d.append(vv);
              const pb = itemPdfButton(rep, 'theme', t, false);
              if (pb) {
                const pr = el('p', 'tpdf');
                pr.append(pb);
                d.append(pr);
              }
              return d;
            }
          };
        });
        box.append(
          heatmap(rows, buckets, {
            firstCol: 'Theme',
            onToggle: (r) => {
              state.openTheme = state.openTheme === r.key ? null : r.key;
              render();
            }
          })
        );
        box.append(el('p', 'hmnote', 'Click a theme to see how the discussion of it changed.'));
      }

      const sect = (title, arr, fill, cls) => {
        if (!(arr || []).length) return;
        const s = el('div', 'rsec' + (cls ? ' ' + cls : ''));
        s.append(el('h4', null, title));
        const ul = el('ul');
        arr.forEach((x) => {
          const li = el('li');
          fill(li, x);
          ul.append(li);
        });
        s.append(ul);
        return s;
      };
      const two = el('div', 'rgrid');
      const withPdf = (li, kind, x) => {
        const b = itemPdfButton(rep, kind, x, true);
        if (b) li.append(' ', b);
      };
      const em = sect('Emerging', R.emerging, (li, x) => {
        li.append(el('b', null, x.topic), ' ');
        li.append(chips(x.videos, rep));
        withPdf(li, 'emerging', x);
        li.append(el('br'));
        li.append(cited(x.why, rep));
      });
      const fa = sect('Fading', R.fading, (li, x) => {
        li.append(el('b', null, x.topic), ' ');
        li.append(chips(x.videos, rep));
        withPdf(li, 'fading', x);
        li.append(el('br'));
        li.append(cited(x.note, rep));
      });
      if (em) two.append(em);
      if (fa) two.append(fa);
      if (two.childNodes.length) box.append(two);

      if ((R.shifts || []).length) {
        box.append(el('h4', null, 'Shifts in views'));
        R.shifts.forEach((x) => {
          const d = el('div', 'shift');
          const h = el('p', 'sh');
          h.append(el('b', null, x.subject));
          if (x.who) h.append(el('span', 'who', ' · ' + x.who));
          const sb = itemPdfButton(rep, 'shift', x, true);
          if (sb) h.append(' ', sb);
          d.append(h);
          const b = el('p', 'sb');
          b.append(el('span', 'lbl', 'Before'), ' ');
          b.append(cited(x.before, rep));
          d.append(b);
          const a = el('p', 'sa');
          a.append(el('span', 'lbl', 'Now'), ' ');
          a.append(cited(x.after, rep));
          d.append(a);
          box.append(d);
        });
      }

      const two2 = el('div', 'rgrid');
      const ag = sect('Where they agree', R.consensus, (li, x) => {
        li.append(cited(x.view, rep), ' ');
        li.append(chips(x.videos, rep));
        withPdf(li, 'consensus', x);
      });
      const di = sect('Where they disagree', R.disagreements, (li, x) => {
        li.append(el('b', null, x.question));
        withPdf(li, 'disagreement', x);
        const ul = el('ul', 'pos');
        (x.positions || []).forEach((p) => {
          const l2 = el('li');
          l2.append(cited(p.position, rep));
          if (p.who) l2.append(el('span', 'who', ' — ' + p.who));
          l2.append(' ');
          l2.append(chips(p.videos, rep));
          ul.append(l2);
        });
        li.append(ul);
      });
      if (ag) two2.append(ag);
      if (di) two2.append(di);
      if (two2.childNodes.length) box.append(two2);

      const co = sect('Company stories', R.companies, (li, x) => {
        li.append(el('b', null, x.name), ' ');
        if (x.trajectory) li.append(trajTag(x.trajectory), ' ');
        li.append(cited(x.story, rep));
        withPdf(li, 'company', x);
      });
      if (co) box.append(co);

      if ((R.numbers || []).length) {
        const s = el('div', 'rsec');
        s.append(el('h4', null, 'Numbers over time'));
        const t = el('table', 'nums');
        const tb = el('tbody');
        R.numbers.forEach((x) => {
          const tr = el('tr');
          tr.append(el('th', null, x.metric));
          const td = el('td');
          (x.values || [])
            .slice()
            .sort((a, b) => (a.video || 0) - (b.video || 0))
            .forEach((v, i) => {
              if (i) td.append(el('span', 'arrow', ' → '));
              const sp = el('span', 'nv');
              sp.append(el('b', null, v.value), ' ');
              sp.append(vchip(v.video, rep));
              td.append(sp);
            });
          if (x.note) td.append(el('span', 'nnote', ' ' + x.note));
          tr.append(td);
          tb.append(tr);
        });
        t.append(tb);
        s.append(t);
        box.append(s);
      }

      const wt = sect('What to watch', R.watch, (li, x) => li.append(cited(x, rep)));
      if (wt) box.append(wt);

      const det = el('details', 'vlist');
      det.append(el('summary', null, 'Videos in this report (' + V.length + ')'));
      const ol = el('ol');
      V.forEach((v) => {
        const li = el('li');
        li.append(el('span', 'vn', 'V' + v.n), ' ', el('span', 'md', v.day), ' ');
        const b = el('button', 'mlink', v.title);
        b.type = 'button';
        b.addEventListener('click', () => deps.openEntry(v.key));
        li.append(b);
        if (v.channel) li.append(el('span', 'who', ' · ' + v.channel));
        ol.append(li);
      });
      det.append(ol);
      box.append(det);
      return box;
    }

    // ---------- actions ----------
    async function runReport(use, focus) {
      if (state.running) return;
      await loadSettings();
      if (!settings.hasKey) {
        state.lastMsg = {
          text: 'To use this, add your Anthropic API key in Settings. It’s stored locally in this browser.',
          kind: 'error'
        };
        render();
        return;
      }
      state.running = true;
      state.lastMsg = null;
      state.focus = focus;
      try {
        await chrome.storage.local.set({ trendFocus: focus });
      } catch (e) {
        /* ignore */
      }
      render();
      const t0 = Date.now();
      const tick = setInterval(() => {
        const s = rootEl.querySelector('.rstatus');
        if (s && state.running)
          s.textContent =
            'Writing the trend report from ' +
            plural(use.length, 'video') +
            '… ' +
            Math.round((Date.now() - t0) / 1000) +
            's';
      }, 1000);
      try {
        const req = buildRequest(use, focus, settings.lang);
        const res = await AI.call(req);
        const meter = AI.newMeter();
        AI.meterAdd(meter, res);
        AI.addToSpend(meter);
        if (!res || !res.input) throw new Error('Claude returned nothing — please try again.');
        const rep = {
          createdAt: Date.now(),
          focus,
          model: res.model,
          modelName: (AI.PRICES[res.model] || {}).name || res.model,
          cost: meter.cost,
          scope: { range: state.range, channel: state.channel },
          videos: use.map((e, i) => ({
            n: i + 1,
            key: e.key,
            title: e.title,
            channel: e.channel,
            day: isoDay(dateOf(e)),
            videoId: e.videoId
          })),
          result: res.input
        };
        await chrome.storage.local.set({ [REPORT_KEY]: rep });
        state.report = rep;
        state.openTheme = null;
        state.lastMsg = { text: 'Trend report written. It cost ' + AI.meterText(meter) + '.' };
      } catch (e) {
        const m = String((e && e.message) || e);
        state.lastMsg = {
          text:
            m === 'NO_KEY'
              ? 'To use this, add your Anthropic API key in Settings. It’s stored locally in this browser.'
              : /context invalidated/i.test(m)
                ? 'The extension was updated while this page was open. Reload this page and try again.'
                : 'Couldn’t write the report: ' + m,
          kind: 'error'
        };
      } finally {
        clearInterval(tick);
        state.running = false;
        render();
      }
    }

    async function analyzeMissing(missing) {
      if (state.batch || state.running) return;
      await loadSettings();
      if (!settings.hasKey) {
        state.lastMsg = {
          text: 'To use this, add your Anthropic API key in Settings. It’s stored locally in this browser.',
          kind: 'error'
        };
        render();
        return;
      }
      state.batch = { total: missing.length, done: 0, ok: 0, stop: false };
      state.lastMsg = null;
      render();
      let failure = '';
      for (const e of missing) {
        if (state.batch.stop) break;
        const r = await deps.analyzeEntry(e.key);
        state.batch.done++;
        if (r.ok) state.batch.ok++;
        else {
          failure = r.message || 'unknown error';
          if (/API key|rejected|credit|billing|Settings/i.test(failure)) break;
        }
        render();
      }
      const b = state.batch;
      state.batch = null;
      state.lastMsg = {
        text:
          'Analyzed ' +
          b.ok +
          ' of ' +
          b.total +
          '.' +
          (failure ? ' Stopped on an error: ' + failure : b.stop && b.done < b.total ? ' Stopped.' : ''),
        kind: failure ? 'error' : ''
      };
      await deps.refresh();
    }

    // Older entries don't know when their video was published: look it up on YouTube (once each).
    let backfilling = false;
    async function backfillDates() {
      if (backfilling) return;
      const todo = deps
        .getEntries()
        .filter((e) => e.videoId && !e.published && !e.rec.publishTried)
        .slice(0, 60);
      if (!todo.length) return;
      backfilling = true;
      const found = {};
      let i = 0;
      const worker = async () => {
        while (i < todo.length) {
          const e = todo[i++];
          let day = '';
          try {
            const r = await fetch('https://www.youtube.com/watch?v=' + encodeURIComponent(e.videoId), {
              credentials: 'omit'
            });
            const html = r.ok ? await r.text() : '';
            const m =
              html.match(/"publishDate":\s*"([^"]+)"/) ||
              html.match(/itemprop="datePublished"\s+content="([^"]+)"/) ||
              html.match(/"uploadDate":\s*"([^"]+)"/);
            if (m && !isNaN(Date.parse(m[1]))) day = m[1];
          } catch (err) {
            /* offline or blocked: try again another day */ continue;
          }
          found[e.key] = day;
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      const keys = Object.keys(found);
      if (keys.length) {
        const cur = await chrome.storage.local.get(keys);
        const write = {};
        for (const k of keys) {
          const rec = cur[k];
          if (!rec) continue;
          write[k] = {
            ...rec,
            meta: { ...(rec.meta || {}), publishDate: (rec.meta && rec.meta.publishDate) || found[k] },
            publishTried: Date.now()
          };
        }
        try {
          await chrome.storage.local.set(write);
        } catch (e) {
          /* ignore */
        }
      }
      backfilling = false;
    }

    let shown = false;
    window.addEventListener('resize', () => {
      if (shown) {
        clearTimeout(render._t);
        render._t = setTimeout(render, 150);
      }
    });
    return {
      async show() {
        shown = true;
        await loadSettings();
        render();
        backfillDates();
      },
      hide() {
        shown = false;
        hideTip();
      },
      async update() {
        if (!shown) return;
        if (!state.running && !state.batch) await loadSettings();
        render();
      }
    };
  }

  root.YTCTTrends = { mount, buildRequest, reportMarkdown, bucketsFor, companyGroups, parseDay };
})(typeof globalThis !== 'undefined' ? globalThis : this);
