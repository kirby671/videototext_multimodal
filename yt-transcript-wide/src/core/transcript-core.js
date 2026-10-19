/*
 * Transcript core: parsing, cleaning, sentence units, paragraphs, prompts, Markdown.
 * Pure functions, no browser APIs — shared by the content script and the tests.
 */
(function (root) {
  'use strict';

  const SPK = '␞'; // internal "speaker changed here" marker (from ">>" in captions)

  // ---------- time helpers ----------
  function tsToSec(ts) {
    const parts = String(ts).trim().split(':').map(Number);
    if (parts.some(isNaN)) return null;
    return parts.reduce((a, b) => a * 60 + b, 0);
  }
  function secToTs(sec) {
    if (sec == null || isNaN(sec)) return '';
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600),
      m = Math.floor((sec % 3600) / 60),
      s = sec % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  }

  // ---------- parsing text copied from YouTube's transcript panel ----------
  const TS_LINE = /^\(?\[?(?:\d{1,2}:)?\d{1,2}:\d{2}\]?\)?$/;
  const A11Y_DURATION = /^(?:\d+\s+(?:hours?|minutes?|seconds?),?\s*)+$/i;
  const INLINE_TS = /^\(?\[?((?:\d{1,2}:)?\d{1,2}:\d{2})\]?\)?\s+(.+)$/;
  const PANEL_NOISE =
    /^(?:transcript|search in video|show transcript|close transcript|chapters|key moments|in this video|english(?: \(auto-generated\))?|auto-generated)$/i;

  /** Turn pasted transcript text (timestamps on their own lines or inline) into segments. */
  function parseTranscriptText(text) {
    const str = String(text || '');
    const nonEmpty = str.split('\n').filter((l) => l.trim()).length;
    const inline = str.match(/(?:^|\s)(?:\d{1,2}:)?\d{1,2}:\d{2}(?=\s)/g) || [];
    if (nonEmpty < 5 && inline.length >= 5) {
      // one long line with timestamps inline (e.g. a selection copied without line breaks)
      const parts = str.replace(/\s+/g, ' ').split(/(?:^|\s)((?:\d{1,2}:)?\d{1,2}:\d{2})(?=\s)/);
      const out = [];
      if (parts[0] && parts[0].trim()) out.push({ type: 'seg', start: null, text: parts[0].trim() });
      for (let i = 1; i < parts.length; i += 2) {
        const t = (parts[i + 1] || '').trim();
        if (t) out.push({ type: 'seg', start: tsToSec(parts[i]), text: t });
      }
      return out;
    }
    const lines = str.replace(/\r/g, '').split('\n');
    const segs = [];
    let pendingStart = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (TS_LINE.test(line)) {
        pendingStart = tsToSec(line.replace(/[()[\]]/g, ''));
        continue;
      }
      if (A11Y_DURATION.test(line) || PANEL_NOISE.test(line)) continue;
      const m = line.match(INLINE_TS);
      if (m) {
        segs.push({ type: 'seg', start: tsToSec(m[1]), text: m[2] });
        pendingStart = null;
        continue;
      }
      segs.push({ type: 'seg', start: pendingStart, text: line });
      pendingStart = null;
    }
    return segs;
  }

  // ---------- cleaning ----------
  const NOISE_TAGS =
    /\[(?:music|applause|laughter|laughs|laughing|cheering|cheers|inaudible|silence|noise|crosstalk|sound|sounds|background noise|intro music|outro music|__)\]/gi;

  function cleanSegmentText(t, opts) {
    let s = String(t || '')
      .replace(/ /g, ' ')
      .replace(/\n/g, ' ');
    if (opts.removeTags !== false) {
      s = s
        .replace(NOISE_TAGS, ' ')
        .replace(/\[\s*_+\s*\]/g, ' ')
        .replace(/[♪♫]+/g, ' ');
    }
    return s.replace(/\s+/g, ' ').trim();
  }

  const FILLERS = /(^|[\s,;])(?:um+|uh+|uhm+|erm+|er|ah|hmm+|mhm|mm+)(?:[,.](?=\s|$))?(?=\s|$)/gi;

  function finalizeUnitText(s, opts, continuation) {
    opts = opts || {};
    s = String(s || '').replace(new RegExp(SPK, 'g'), ' ');
    if (opts.removeFillers !== false) {
      s = s.replace(FILLERS, '$1');
      s = s.replace(FILLERS, '$1'); // second pass for "uh, um,"
      // stutters: "the the", "a a a", "I I"
      s = s.replace(/\b([A-Za-z']+)(?:[\s,]+\1\b)+/gi, '$1');
      // verbal tics, only where commas make them unambiguous
      s = s
        .replace(/,\s*(?:you know|I mean|like|sort of|kind of),\s*/gi, ' ')
        .replace(/(^|[.!?]\s+)(?:you know|I mean|look|so look|yeah|okay|ok|well),\s+/gi, '$1')
        .replace(/,\s*(?:you know|I mean)(?=[.!?])/gi, '')
        .replace(/,\s*right\?/gi, '.');
    }
    s = s
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .replace(/,([.!?])/g, '$1')
      .replace(/([,;:]){2,}/g, '$1')
      .replace(/^[\s,.;:]+/, '')
      .trim();
    // standalone lowercase "i" from older auto-captions
    s = s.replace(/(^|\s)i(?=(?:'m|'ve|'ll|'d|'s)?(?:[\s,;!?]|$))/g, '$1I');
    // capitalise sentence starts that filler-removal exposed
    if (!continuation) s = s.replace(/^([a-z])/, (m) => m.toUpperCase());
    s = s.replace(/([.!?]\s+)([a-z])/g, (m, a, b) => a + b.toUpperCase());
    return s;
  }

  const ABBREV = /^(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|U\.S|U\.K|a\.m|p\.m|No|Inc|Ltd|Co|Corp|approx)\.$/i;
  const LABEL_RE = /^\s*\[?([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,2})\]?:\s+/;

  /**
   * Build sentence-sized "units" from segments. Each unit: { text, start, change, hint, chapter }
   * - start: seconds (null if unknown)
   * - change: true if captions marked a speaker change (">>") right before this unit
   * - hint: speaker label found inline ("JOHN:" / "[John]:")
   */
  function buildUnits(items, opts) {
    opts = opts || {};
    const marks = []; // { pos, start }
    const chapterAt = []; // { pos, title }
    let full = '';
    let lastStart = null;
    for (const it of items || []) {
      if (!it) continue;
      if (it.type === 'chapter') {
        if (it.text) chapterAt.push({ pos: full.length, title: String(it.text).trim() });
        continue;
      }
      let t = String(it.text || '');
      t = t.replace(/^\s*[-–]\s+(?=\S)/, SPK + ' ');
      t = t.replace(/>>+/g, ' ' + SPK + ' ');
      t = cleanSegmentText(t, opts);
      if (!t) continue;
      const start = it.start != null && !isNaN(it.start) ? Number(it.start) : lastStart;
      if (start != null) lastStart = start;
      marks.push({ pos: full.length, start });
      full += t + ' ';
    }

    const startAt = (pos) => {
      let lo = 0,
        hi = marks.length - 1,
        best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (marks[mid].pos <= pos) {
          best = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      for (let i = best; i >= 0; i--) if (marks[i].start != null) return marks[i].start;
      for (let i = Math.max(0, best); i < marks.length; i++) if (marks[i].start != null) return marks[i].start;
      return null;
    };
    let chapterIdx = 0;
    const chapterFor = (pos, endPos) => {
      let title = null;
      while (chapterIdx < chapterAt.length && chapterAt[chapterIdx].pos < endPos) {
        if (chapterAt[chapterIdx].pos >= pos || title === null) title = chapterAt[chapterIdx].title;
        chapterIdx++;
      }
      return title;
    };

    const units = [];
    let startPos = 0,
      pendingChange = false,
      pendingChapter = null;
    // Punctuated captions: keep whole sentences (split only run-ons, preferring commas).
    // Unpunctuated (older) captions: cut into ~28-word pieces.
    const enders = (full.match(/[.!?](?=\s|$)/g) || []).length;
    const totalWords = (full.match(/\S+/g) || []).length;
    const punctuated = enders >= totalWords / 60;
    const MAX_WORDS = punctuated ? 110 : 45,
      CHUNK = punctuated ? 50 : 28;

    const emit = (rawStart, rawEnd, continuation) => {
      const raw = full.slice(rawStart, rawEnd);
      const text = finalizeUnitText(raw, opts, continuation);
      const chapter = chapterFor(rawStart, rawEnd);
      if (!text) {
        if (chapter) pendingChapter = chapter;
        return;
      }
      units.push({
        text,
        start: startAt(rawStart + (raw.length - raw.trimStart().length)),
        change: continuation ? false : pendingChange,
        hint: null,
        chapter: chapter || pendingChapter || null
      });
      if (!continuation) pendingChange = false;
      pendingChapter = null;
    };

    const pushUnit = (endPos) => {
      const raw = full.slice(startPos, endPos);
      const words = raw.match(/\S+/g) || [];
      if (words.length > MAX_WORDS) {
        const re = /\S+/g;
        let m,
          n = 0,
          chunkStart = startPos,
          prev = '',
          first = true;
        while ((m = re.exec(raw))) {
          n++;
          const atComma = /,$/.test(prev);
          if (n > CHUNK && (atComma || !punctuated || n > CHUNK + 20) && words.length - (m.index ? 0 : 0)) {
            const at = startPos + m.index;
            emit(chunkStart, at, !first);
            first = false;
            chunkStart = at;
            n = 1;
          }
          prev = m[0];
        }
        emit(chunkStart, endPos, !first);
      } else {
        emit(startPos, endPos, false);
      }
      startPos = endPos;
    };

    for (let i = 0; i < full.length; i++) {
      const c = full[i];
      if (c === SPK) {
        pushUnit(i);
        startPos = i + 1;
        pendingChange = true;
        continue;
      }
      if (c === '.' || c === '!' || c === '?') {
        let j = i + 1;
        while (j < full.length && /[.!?"'”’)\]]/.test(full[j])) j++;
        if (j < full.length && !/\s/.test(full[j])) continue;
        let k = j;
        while (k < full.length && /\s/.test(full[k])) k++;
        const next = full[k];
        const prevWord = (full.slice(startPos, j).match(/(\S+)$/) || [])[1] || '';
        if ((!next || /[A-Z0-9"“'‘([␞]/.test(next)) && !ABBREV.test(prevWord)) {
          pushUnit(j);
          i = j - 1;
        }
      }
    }
    pushUnit(full.length);

    // inline speaker labels ("JOHN:", "[Jane Doe]:") — only trust labels that repeat
    const counts = {};
    units.forEach((u) => {
      const m = u.text.match(LABEL_RE);
      if (m) counts[m[1]] = (counts[m[1]] || 0) + 1;
    });
    units.forEach((u) => {
      const m = u.text.match(LABEL_RE);
      if (m && counts[m[1]] >= 2) {
        u.hint = m[1];
        u.change = true;
        u.text = finalizeUnitText(u.text.slice(m[0].length), opts);
      }
    });
    return units;
  }

  // ---------- corrections (names / terms the speaker model flags) ----------
  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  function applyCorrections(text, corrections) {
    let s = text;
    for (const c of corrections || []) {
      if (!c || !c.heard || !c.correct || c.heard === c.correct) continue;
      const re = new RegExp('(^|[^A-Za-z0-9])' + escapeRe(c.heard) + '(?![A-Za-z0-9])', 'g');
      s = s.replace(re, (m, pre) => pre + c.correct);
    }
    return s;
  }

  // ---------- speakers, turns & paragraphs ----------
  /** Map 0-based unit index -> speaker id, from model turns (1-based "start") or inline hints. */
  function speakerPerUnit(units, turns) {
    const out = new Array(units.length).fill(null);
    if (turns && turns.length) {
      const sorted = turns
        .filter((t) => t && Number.isFinite(+t.start) && t.speaker)
        .map((t) => ({ start: Math.max(1, Math.round(+t.start)), speaker: String(t.speaker) }))
        .sort((a, b) => a.start - b.start);
      let ti = -1;
      for (let i = 0; i < units.length; i++) {
        while (ti + 1 < sorted.length && sorted[ti + 1].start <= i + 1) ti++;
        out[i] = ti >= 0 ? sorted[ti].speaker : sorted[0] ? sorted[0].speaker : null;
      }
      return out;
    }
    let cur = null;
    for (let i = 0; i < units.length; i++) {
      if (units[i].hint) cur = units[i].hint;
      out[i] = cur;
    }
    return out;
  }

  /**
   * Speaker turns: consecutive sentences by the same speaker. Very long turns (or a whole
   * unlabeled transcript) are split at ~maxWords so they can be processed in pieces.
   * Returns [{ idx (1-based), speaker, start, unitFrom, unitTo, cont, text }]
   */
  function buildTurns(units, turns, corrections, maxWords) {
    maxWords = maxWords || 350;
    const spk = speakerPerUnit(units, turns);
    const hasSpeakers = spk.some((x) => x);
    const out = [];
    let cur = null;
    units.forEach((u, i) => {
      const s = spk[i];
      const words = u.text.split(/\s+/).length;
      const newTurn = !cur || s !== cur.speaker || (!hasSpeakers && u.change);
      if (newTurn || (cur.words + words > maxWords * 1.3 && cur.words >= maxWords)) {
        cur = { speaker: s, start: u.start, unitFrom: i, unitTo: i, cont: !newTurn, words: 0, parts: [] };
        out.push(cur);
      }
      cur.unitTo = i;
      cur.parts.push(u.text);
      cur.words += words;
    });
    return out.map((t, k) => ({
      idx: k + 1,
      speaker: t.speaker,
      start: t.start,
      unitFrom: t.unitFrom,
      unitTo: t.unitTo,
      cont: t.cont,
      text: applyCorrections(t.parts.join(' '), corrections)
    }));
  }

  /**
   * Readable verbatim paragraphs grouped by speaker.
   * Returns [{ speaker, start, text, cont, chapter, changeMarked, unitFrom }]
   */
  function buildParagraphs(units, turns, corrections) {
    const spk = speakerPerUnit(units, turns);
    const hasSpeakers = spk.some((x) => x);
    const paras = [];
    let cur = null;
    units.forEach((u, i) => {
      const s = spk[i];
      const words = u.text.split(/\s+/).length;
      const newTurn = !cur || s !== cur.speaker || (!hasSpeakers && u.change) || u.chapter;
      const tooLong = cur && cur.sentences >= 5 && cur.words >= 80;
      if (newTurn || tooLong) {
        cur = {
          speaker: s,
          start: u.start,
          parts: [],
          words: 0,
          sentences: 0,
          cont: !newTurn,
          chapter: u.chapter || null,
          changeMarked: !hasSpeakers && u.change,
          unitFrom: i
        };
        paras.push(cur);
      }
      cur.parts.push(u.text);
      cur.words += words;
      cur.sentences++;
    });
    return paras.map((p) => ({
      speaker: p.speaker,
      start: p.start,
      cont: p.cont,
      chapter: p.chapter,
      changeMarked: p.changeMarked,
      unitFrom: p.unitFrom,
      text: applyCorrections(p.parts.join(' '), corrections)
    }));
  }

  function speakerName(id, speakers) {
    if (!id) return null;
    const s = (speakers || []).find((x) => x.id === id);
    return s ? s.name || id : id;
  }

  /** "[T3] Farooq Malik: ..." lines — the form Claude sees for analysis and distillation. */
  function labeledTurnsText(turnsList, speakers) {
    return turnsList
      .map((t) => '[T' + t.idx + '] ' + (speakerName(t.speaker, speakers) || 'Speaker') + ': ' + t.text)
      .join('\n\n');
  }

  /** Distilled transcript groups: kept turns, consecutive same-speaker turns merged. */
  function distilledGroups(turnsList, distilled) {
    const by = (distilled && distilled.byTurn) || {};
    const covered = new Set(((distilled && distilled.covered) || []).map(Number));
    const groups = [];
    for (const t of turnsList) {
      let text,
        fallback = false;
      if (covered.has(t.idx)) {
        text = by[t.idx];
        if (!text || !String(text).trim()) continue;
      } else {
        text = t.text;
        fallback = true;
      }
      const paras = String(text)
        .split(/\n\s*\n/)
        .map((x) => x.trim())
        .filter(Boolean);
      const last = groups[groups.length - 1];
      if (last && last.speaker === t.speaker && t.speaker) {
        last.paras.push(...paras);
        last.turns.push(t.idx);
        last.fallback = last.fallback || fallback;
      } else groups.push({ speaker: t.speaker, start: t.start, paras, turns: [t.idx], fallback });
    }
    return groups;
  }

  // ---------- company highlighting ----------
  function companyMatcher(companies) {
    const names = [];
    (companies || []).forEach((c, i) => {
      [c && c.name].concat((c && c.aliases) || []).forEach((a) => {
        if (a && String(a).trim().length >= 2) names.push({ a: String(a).trim(), i });
      });
    });
    if (!names.length) return null;
    names.sort((x, y) => y.a.length - x.a.length);
    const seen = new Set(),
      uniq = [];
    for (const n of names)
      if (!seen.has(n.a)) {
        seen.add(n.a);
        uniq.push(n);
      }
    return {
      re: new RegExp('(^|[^A-Za-z0-9])(' + uniq.map((n) => escapeRe(n.a)).join('|') + ')(?![A-Za-z0-9])', 'g'),
      lookup: new Map(uniq.map((n) => [n.a, n.i]))
    };
  }
  /** Split text into [{ text, company?: index }] for safe rendering. */
  function splitHighlights(text, matcher) {
    text = String(text || '');
    if (!matcher) return [{ text }];
    const out = [];
    let last = 0,
      m;
    matcher.re.lastIndex = 0;
    while ((m = matcher.re.exec(text))) {
      const start = m.index + m[1].length;
      if (start > last) out.push({ text: text.slice(last, start) });
      out.push({ text: m[2], company: matcher.lookup.get(m[2]) });
      last = start + m[2].length;
      matcher.re.lastIndex = last;
    }
    if (last < text.length) out.push({ text: text.slice(last) });
    return out;
  }
  function boldCompanies(text, matcher) {
    return splitHighlights(text, matcher)
      .map((p) => (p.company != null ? '**' + p.text + '**' : p.text))
      .join('');
  }

  // ---------- prompts ----------
  const DEFAULT_FOCUS = [
    'How they do things — concrete methods, processes, mechanics, playbooks and decisions.',
    'How the speakers view things — beliefs, theses, mental models, predictions and framings.',
    'Strong statements — the boldest, most quotable claims, close to verbatim.',
    'Concepts a speaker explains — broken into detailed numbered points.',
    'Companies mentioned and why.'
  ].join('\n');

  function metaBlock(meta) {
    meta = meta || {};
    const lines = [];
    if (meta.title) lines.push('Title: ' + meta.title);
    if (meta.channel) lines.push('Channel: ' + meta.channel);
    if (meta.description) lines.push('Description:\n' + String(meta.description).slice(0, 2500));
    return lines.join('\n');
  }
  function rosterBlock(speakers) {
    if (!speakers || !speakers.length) return '';
    return 'Speakers:\n' + speakers.map((s) => '- ' + s.name + (s.role ? ' (' + s.role + ')' : '')).join('\n');
  }

  const SPEAKER_TOOL = {
    name: 'label_speakers',
    description: 'Record who is speaking in each part of the transcript.',
    input_schema: {
      type: 'object',
      properties: {
        speakers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Short id: S1, S2, ...' },
              name: {
                type: 'string',
                description:
                  'Best name, e.g. "Farooq Malik". If never stated use a role label such as "Host", "Guest", "Narrator", "Interviewer".'
              },
              role: {
                type: 'string',
                description:
                  'Role/affiliation if stated or in the description, e.g. "CEO & co-founder, Rain". Empty if unknown.'
              },
              confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
              evidence: { type: 'string', description: 'The cue used, e.g. "introduces himself at [41]".' }
            },
            required: ['id', 'name', 'role', 'confidence']
          }
        },
        turns: {
          type: 'array',
          description:
            'Speaker turns in order. A turn starts at a sentence number and runs until the next turn. The first turn must start at 1.',
          items: {
            type: 'object',
            properties: { start: { type: 'integer' }, speaker: { type: 'string', description: 'Speaker id' } },
            required: ['start', 'speaker']
          }
        },
        corrections: {
          type: 'array',
          description:
            'Clear mis-transcriptions of people, companies, products or technical terms, exactly as they appear in the transcript, with the correct form. Only include ones you are confident about.',
          items: {
            type: 'object',
            properties: { heard: { type: 'string' }, correct: { type: 'string' } },
            required: ['heard', 'correct']
          }
        },
        notes: { type: 'string', description: 'Optional caveats, e.g. stretches where the speaker is uncertain.' }
      },
      required: ['speakers', 'turns']
    }
  };

  const SPEAKER_SYSTEM = [
    'You label speakers in YouTube auto-caption transcripts, which have no speaker labels.',
    'The transcript is split into numbered sentences. Work out who says each one and return speaker turns.',
    'Cues to use: self-introductions ("I\'m X, CEO of Y"); being addressed by name ("Farooq, walk us through..." means Farooq answers next);',
    'hosts ask questions, introduce guests, read sponsor messages and close the show; guests answer and refer to their own company ("at Rain we...");',
    'hand-offs ("Kai, any thoughts?"), "thanks for having me", and the title/description for names, roles and correct spelling.',
    'Auto-captions often misspell names — use the spelling from the title/description and list the misspellings as corrections.',
    'Start a new turn whenever the speaker changes, including short interjections when they are their own sentence.',
    'If a video has one speaker, return one speaker. If a name is never given, use a role label (Host, Guest, Narrator).',
    'Return turns covering the whole transcript.'
  ].join(' ');

  function buildSpeakerRequest(meta, units) {
    const numbered = units.map((u, i) => '[' + (i + 1) + '] ' + (u.change ? '>> ' : '') + u.text).join('\n');
    const user =
      metaBlock(meta) +
      '\n\nTranscript (' +
      units.length +
      ' numbered sentences; ">>" marks a speaker change flagged by the captions):\n' +
      numbered;
    return { system: SPEAKER_SYSTEM, user, tool: SPEAKER_TOOL, maxTokens: 24000 };
  }

  const who = { type: 'string', description: 'Speaker name' };
  const ANALYSIS_TOOL = {
    name: 'report_analysis',
    description: 'Report the analysis of the transcript.',
    input_schema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: '3-4 sentences: who is talking, what the video covers, and its core message.'
        },
        themes: {
          type: 'array',
          description: 'Key themes running through the conversation, in order of importance.',
          items: {
            type: 'object',
            properties: {
              theme: { type: 'string', description: 'Short name for the theme' },
              context: {
                type: 'string',
                description:
                  '2-4 sentences: the context it works in — where/why it comes up, how it applies, who drives it and what they say about it.'
              },
              speakers: { type: 'array', items: { type: 'string' } }
            },
            required: ['theme', 'context']
          }
        },
        concepts: {
          type: 'array',
          description:
            'Concepts a speaker explains: a mechanism, framework, model, process or analogy they walk through. Be detailed.',
          items: {
            type: 'object',
            properties: {
              concept: { type: 'string', description: 'Name of the concept' },
              explained_by: who,
              turn: { type: 'integer', description: 'The [T#] turn number where the explanation starts' },
              points: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'The explanation as numbered points in order (typically 3-8): what it is, how it works step by step, the examples given and why it matters — as the speaker explained it, with specifics.'
              }
            },
            required: ['concept', 'explained_by', 'points']
          }
        },
        how_they_do_it: {
          type: 'array',
          description:
            'How they do things: concrete methods, processes, mechanics, playbooks, decisions, how things work in practice.',
          items: {
            type: 'object',
            properties: {
              speaker: who,
              point: { type: 'string', description: 'One-line headline' },
              detail: { type: 'string', description: '1-3 sentences of specifics' }
            },
            required: ['speaker', 'point', 'detail']
          }
        },
        how_they_see_it: {
          type: 'array',
          description: 'How the speakers view things: beliefs, theses, mental models, predictions, framings, opinions.',
          items: {
            type: 'object',
            properties: {
              speaker: who,
              view: { type: 'string', description: 'One-line headline' },
              detail: { type: 'string', description: '1-2 sentences on their reasoning' }
            },
            required: ['speaker', 'view', 'detail']
          }
        },
        strong_statements: {
          type: 'array',
          description: 'The boldest, most quotable claims, near-verbatim, lightly cleaned of filler.',
          items: {
            type: 'object',
            properties: {
              speaker: who,
              quote: { type: 'string' },
              context: { type: 'string', description: 'A few words of context' }
            },
            required: ['speaker', 'quote']
          }
        },
        facts_and_figures: {
          type: 'array',
          description: 'Specific facts stated: numbers, dates, names, metrics, firsts.',
          items: {
            type: 'object',
            properties: { speaker: who, fact: { type: 'string' } },
            required: ['speaker', 'fact']
          }
        },
        companies: {
          type: 'array',
          description:
            "Every company and organisation mentioned by name (including the speakers' own), plus named products, stablecoins/currencies, protocols and blockchains. In order of first mention.",
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Correct name' },
              type: { type: 'string', enum: ['company', 'product', 'network', 'organisation', 'other'] },
              aliases: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Every form of the name exactly as it appears in the transcript (including mis-transcriptions), so it can be highlighted.'
              },
              why: { type: 'string', description: 'One to two lines: why it is mentioned and what was said about it.' },
              mentioned_by: { type: 'array', items: { type: 'string' } }
            },
            required: ['name', 'type', 'why']
          }
        },
        concept_links: {
          type: 'array',
          description:
            'A small concept map: how the concepts above connect, as the speakers describe it (one leads to, enables, requires, is an example of, or answers another). Use the exact concept names. Usually 3-10 links; every concept should appear in at least one link if it relates to any other.',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string', description: 'Exact concept name' },
              to: { type: 'string', description: 'Exact concept name' },
              relation: {
                type: 'string',
                description:
                  '2-5 word verb phrase read as "from → relation → to", e.g. "requires", "is the first live case of"'
              }
            },
            required: ['from', 'to', 'relation']
          }
        }
      },
      required: [
        'summary',
        'themes',
        'concepts',
        'how_they_do_it',
        'how_they_see_it',
        'strong_statements',
        'facts_and_figures',
        'companies',
        'concept_links'
      ]
    }
  };

  function analysisSystem(focus) {
    return [
      'You analyse a video transcript that is split into numbered speaker turns ([T#] Name: text).',
      'Use only what is said in the transcript — no outside knowledge, no embellishment, no advice of your own.',
      'Attribute every point to the speaker who said it. Prefer specific over generic: keep numbers, names, mechanisms and examples.',
      'Ignore jokes, banter, pleasantries and sponsor reads. Fix obvious auto-caption errors in names and terms.',
      'Concepts: whenever a speaker explains how something works, capture it as a concept with detailed numbered points.',
      'Companies: list every one mentioned with a one-to-two-line reason it came up.',
      'Concept links: connect the concepts into a small map with short verb phrases.',
      'Aim for roughly 5-12 items per list for a long video and fewer for a short one; leave a list empty rather than pad it.',
      '\nThe reader cares most about:\n' + (focus && focus.trim() ? focus.trim() : DEFAULT_FOCUS)
    ].join(' ');
  }

  function buildAnalysisRequest(meta, labeledText, focus) {
    return {
      system: analysisSystem(focus),
      user: metaBlock(meta) + '\n\nTranscript:\n' + labeledText,
      tool: ANALYSIS_TOOL,
      maxTokens: 32000
    };
  }

  const DISTILL_TOOL = {
    name: 'distilled_transcript',
    description: 'Return the distilled version of each speaker turn.',
    input_schema: {
      type: 'object',
      properties: {
        turns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              turn: { type: 'integer', description: 'The [T#] number' },
              text: {
                type: 'string',
                description: "Distilled turn in the speaker's own voice. Blank lines between paragraphs in long turns."
              }
            },
            required: ['turn', 'text']
          }
        }
      },
      required: ['turns']
    }
  };

  const DISTILL_SYSTEM = [
    'You turn a raw conversation transcript into a distilled transcript.',
    "For each numbered speaker turn, rewrite it down to its core message in the speaker's own voice (first person, their wording where it carries meaning).",
    'Remove filler words and verbal tics (um, uh, you know, like, I mean, sort of, kind of, right?, so, look, basically), false starts, repetition, stutters,',
    'laughter, jokes, banter, compliments, pleasantries, thank-yous and sponsor reads.',
    'Keep every substantive point, argument, example, number, name, mechanism and caveat — nothing of substance may be lost — and keep strong claims close to verbatim.',
    'Do not add facts, interpretation or commentary. Fix obvious mis-transcriptions of names and terms.',
    'Expect roughly 40-60% of the original length. Keep host questions as crisp questions.',
    'Omit a turn entirely if it has no substance (e.g. "Yeah.", "Wow, that\'s amazing.", "Thanks for having me.") by returning an empty text for it.',
    'Turn boundaries come from automatic speaker detection and can be off by a few words: if the end of one turn clearly belongs to the next speaker, move it there.',
    'Use blank lines to split long turns into paragraphs.'
  ].join(' ');

  // ---------- one-call analysis: speakers + insights from a single read of the transcript ----------
  // Compact schema (short descriptions = fewer tokens sent on every call).
  const str = (d) => (d ? { type: 'string', description: d } : { type: 'string' });
  const arr = (items, d) => (d ? { type: 'array', description: d, items } : { type: 'array', items });
  const obj = (props, req) => ({ type: 'object', properties: props, required: req });
  const COMBINED_TOOL = {
    name: 'report_analysis',
    description: 'Speakers and analysis of the transcript.',
    input_schema: obj(
      {
        speakers: arr(
          obj(
            {
              id: str('S1, S2…'),
              name: str('Name, or a role such as Host if never stated'),
              role: str('Role/affiliation, or empty'),
              confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
            },
            ['id', 'name', 'role', 'confidence']
          )
        ),
        turns: arr(
          obj({ start: { type: 'integer' }, speaker: str('Speaker id') }, ['start', 'speaker']),
          'Sentence number where each speaker turn starts; the first is 1'
        ),
        corrections: arr(
          obj({ heard: str(), correct: str() }, ['heard', 'correct']),
          'Misheard names/terms exactly as they appear, with the correct form'
        ),
        summary: str(),
        themes: arr(
          obj({ theme: str(), context: str('Where it comes up and how it applies'), speakers: arr(str()) }, [
            'theme',
            'context'
          ])
        ),
        concepts: arr(
          obj(
            {
              concept: str(),
              explained_by: str(),
              sentence: { type: 'integer', description: 'Sentence number where the explanation starts' },
              points: arr(str(), 'The explanation as ordered points, with specifics')
            },
            ['concept', 'explained_by', 'points']
          )
        ),
        how_they_do_it: arr(obj({ speaker: str(), point: str(), detail: str() }, ['speaker', 'point', 'detail'])),
        how_they_see_it: arr(obj({ speaker: str(), view: str(), detail: str() }, ['speaker', 'view', 'detail'])),
        strong_statements: arr(
          obj({ speaker: str(), quote: str('Near-verbatim'), context: str() }, ['speaker', 'quote'])
        ),
        facts_and_figures: arr(obj({ speaker: str(), fact: str() }, ['speaker', 'fact'])),
        companies: arr(
          obj(
            {
              name: str(),
              type: { type: 'string', enum: ['company', 'product', 'network', 'organisation', 'other'] },
              aliases: arr(str(), 'Other spellings as they appear in the transcript, only if different'),
              why: str('One line: why it came up')
            },
            ['name', 'type', 'why']
          ),
          'Every company, organisation, product or network named'
        ),
        concept_links: arr(
          obj({ from: str('Concept name'), to: str('Concept name'), relation: str('2-5 word verb phrase') }, [
            'from',
            'to',
            'relation'
          ])
        )
      },
      [
        'speakers',
        'turns',
        'summary',
        'themes',
        'concepts',
        'how_they_do_it',
        'how_they_see_it',
        'strong_statements',
        'facts_and_figures',
        'companies',
        'concept_links'
      ]
    )
  };

  /** How much to write, scaled to the transcript (short videos get short answers). */
  function lengthGuidance(units) {
    const words = (units || []).reduce((a, u) => a + u.text.split(/\s+/).length, 0);
    const n = words.toLocaleString();
    if (words < 2500)
      return (
        'This is a short video (about ' +
        n +
        ' words), so keep the answer short: summary in 2 sentences; at most 3 themes; at most 3 concepts with 3-4 points each; at most 3 items in each learnings list; at most 3 strong statements; at most 4 facts; at most 4 concept links. One or two sentences per item; skip anything minor.'
      );
    if (words < 8000)
      return (
        'This is a medium-length video (about ' +
        n +
        ' words): summary in 3 sentences; at most 5 themes; at most 5 concepts with 3-6 points each; 3-6 items in each learnings list; at most 5 strong statements; at most 6 facts; at most 7 concept links. Keep every item tight.'
      );
    return (
      'This is a long video (about ' +
      n +
      ' words): summary in 3-4 sentences; 5-10 themes; up to 8 concepts with 3-8 points each; 5-10 items in each learnings list; up to 8 strong statements; up to 10 facts; up to 10 concept links. Keep every item tight.'
    );
  }

  function combinedSystem(focus, guidance) {
    return [
      'Analyse this auto-caption transcript (numbered sentences, no speaker labels) in one answer:',
      '1) Speakers: who says each sentence. Use self-introductions, people addressed by name (they answer next), hosts asking questions and reading sponsor messages, guests referring to their own company, and the title/description for names, roles and spelling. Return speakers, turns (sentence where each turn starts) and corrections for misheard names.',
      '2) Analysis: summary, themes with their context, concepts explained (sentence where the explanation starts + ordered points), how they do things, how they see things, strong statements, facts & figures, every company named and why, and links between concepts.',
      "Attribute points to speakers by name: in every speaker, explained_by and speakers field write the person's name (or role, e.g. Host), never an id like S1. Use only what is said. Ignore jokes, banter and sponsor reads. Fix misheard names and terms.",
      guidance || '',
      focus && focus.trim() ? 'The reader cares most about:\n' + focus.trim() : ''
    ]
      .filter(Boolean)
      .join('\n');
  }

  function buildCombinedRequest(meta, units, focus, lang) {
    const numbered = units.map((u, i) => '[' + (i + 1) + '] ' + (u.change ? '>> ' : '') + u.text).join('\n');
    const m = Object.assign({}, meta || {}, {
      description: meta && meta.description ? String(meta.description).slice(0, 800) : ''
    });
    const user = metaBlock(m) + '\n\nTranscript (">>" = speaker change flagged by the captions):\n' + numbered;
    const li = languageInstruction(lang, { transcript: true });
    return {
      system: combinedSystem(focus, lengthGuidance(units)) + (li ? '\n' + li : ''),
      user,
      tool: COMBINED_TOOL,
      maxTokens: 32000
    };
  }

  // ---------- languages ----------
  // The languages Chrome's built-in (free, on-device) translator supports. Claude can write all of them too.
  const LANGUAGES = [
    'ar',
    'bg',
    'bn',
    'cs',
    'da',
    'de',
    'el',
    'en',
    'es',
    'fi',
    'fr',
    'he',
    'hi',
    'hr',
    'hu',
    'id',
    'it',
    'ja',
    'kn',
    'ko',
    'lt',
    'mr',
    'nl',
    'no',
    'pl',
    'pt',
    'ro',
    'ru',
    'sk',
    'sl',
    'sv',
    'ta',
    'te',
    'th',
    'tr',
    'uk',
    'vi',
    'zh',
    'zh-Hant'
  ];
  let langNamer = null;
  function langName(code) {
    if (!code) return '';
    if (code === 'auto') return 'the video’s own language';
    try {
      langNamer = langNamer || new Intl.DisplayNames(['en'], { type: 'language' });
      return langNamer.of(code) || code;
    } catch (e) {
      return code;
    }
  }
  /** The supported language closest to a locale or detected code ("es-MX" → "es", "zh-TW" → "zh-Hant"); '' if none. */
  function pickLanguage(locale) {
    const l = String(locale || '').replace(/_/g, '-');
    if (/^zh-(TW|HK|MO|Hant)/i.test(l)) return 'zh-Hant';
    const b = l.toLowerCase().split('-')[0];
    const m = { iw: 'he', nb: 'no', nn: 'no' }[b] || b;
    return LANGUAGES.includes(m) ? m : '';
  }
  /**
   * Instant, offline guess at a transcript's language (no download, no API): the writing system first,
   * then, for Latin-alphabet languages, which language's most common short words show up most.
   * Reliable on a few hundred words; returns '' when unsure.
   */
  const STOPWORDS = {
    en: 'the and to of a that is in it you i we this for so but they what was are have not with be just like there',
    es: 'el los las y que es por pero muy yo esto eso una del como más está también porque hay cuando ellos nosotros',
    fr: "le les et est des une que pas je il vous nous ce qui dans pour sur avec mais très ça c'est on au du",
    de: 'der die und das ist nicht ich es zu den mit sie auf ein sich auch wir dass aber eine wenn noch nur',
    it: 'il di che e la non è un per sono una mi ma lo con questo anche come perché della gli più cosa molto',
    pt: 'o os não é um uma para com você isso mas eu muito também então ele ela está são das dos pra aqui',
    nl: 'de het een en van is dat niet ik je op te zijn voor met maar ook wat er we als dan nog',
    sv: 'och att det som är på för med inte jag har av till den om så kan vi men var ett också',
    da: 'og at det som er på for med ikke jeg har af til den om så kan vi men var hvad efter nogle mig også',
    no: 'og at det som er på for med ikke jeg har av til den om så kan vi men var hva etter noen meg også',
    fi: 'ja on ei se että oli kun mutta niin hän me tämä myös kuin ole sen ovat jos mitä',
    pl: 'i w nie się na że to jest z do jak ale co tak już jestem tego są czy bardzo',
    cs: 'a je se to na že v jsem není jako ale tak by pro jsou také jak co tady',
    sk: 'a je sa to na že v som nie ako ale tak by pre sú aj čo tu ktoré',
    ro: 'și în de la că nu este pe cu o un sunt mai dar foarte acest asta care pentru',
    hu: 'a az és hogy nem is egy van de meg ez csak azt már mert vagy volt',
    tr: 've bir bu da de için ile çok ne ama gibi daha var olan ben biz mi',
    id: 'dan yang di ini itu dengan untuk tidak ada dari kita saya akan juga bisa kami',
    vi: 'và của là không có những được người này cho một các trong đó với chúng tôi',
    hr: 'i je u da se na su za što ali kao nije sam to smo bi',
    sl: 'in je v da se na so za kaj ampak kot ni sem to smo bi',
    lt: 'ir yra kad tai su į bet kaip ne aš mes buvo jau tik'
  };
  let stopSets = null;
  function guessLanguage(text) {
    const s = String(text || '').slice(0, 6000);
    const count = (re) => (s.match(re) || []).length;
    const letters = count(/\p{L}/gu) || 1;
    const scripts = [
      ['ko', /[가-힯ᄀ-ᇿ]/g],
      ['ja', /[぀-ヿ]/g],
      ['th', /[฀-๿]/g],
      ['el', /[Ͱ-Ͽ]/g],
      ['he', /[֐-׿]/g],
      ['ar', /[؀-ۿ]/g],
      ['bn', /[ঀ-৿]/g],
      ['ta', /[஀-௿]/g],
      ['te', /[ఀ-౿]/g],
      ['kn', /[ಀ-೿]/g]
    ];
    for (const [code, re] of scripts) if (count(re) / letters > 0.15) return code;
    if (count(/[一-鿿]/g) / letters > 0.3) {
      const trad = count(/[們這個說會為來時對國還學過們邊麼樣經頭現發點開關]/g),
        simp = count(/[们这个说会为来时对国还学过边么样经头现发点开关]/g);
      return trad > simp ? 'zh-Hant' : 'zh';
    }
    if (count(/[ऀ-ॿ]/g) / letters > 0.15) return /आहे|आणि|ळ/.test(s) && !/ है | और /.test(s) ? 'mr' : 'hi';
    if (count(/[Ѐ-ӿ]/g) / letters > 0.3) {
      if (count(/[іїєґ]/gi) > count(/[ыэ]/gi)) return 'uk';
      if (count(/ъ/g) > 3 && !count(/[ыэ]/gi)) return 'bg';
      return 'ru';
    }
    // Latin alphabet: score each language by how many words are among its most common ones.
    if (!stopSets) {
      stopSets = {};
      for (const k of Object.keys(STOPWORDS)) stopSets[k] = new Set(STOPWORDS[k].split(' '));
    }
    const words = s.toLowerCase().match(/[\p{L}']+/gu) || [];
    if (words.length < 20) return '';
    const scores = Object.keys(stopSets)
      .map((k) => [k, words.reduce((a, w) => a + (stopSets[k].has(w) ? 1 : 0), 0) / words.length])
      .sort((a, b) => b[1] - a[1]);
    const [best, second] = scores;
    return best[1] >= 0.12 && best[1] >= second[1] * 1.15 ? best[0] : '';
  }
  const sameLanguage = (a, b) =>
    !!a && !!b && (a === b || (a.split('-')[0] === b.split('-')[0] && a !== 'zh-Hant' && b !== 'zh-Hant'));
  /** A system-prompt line asking Claude to write in the chosen language ('' for English, as before). */
  function languageInstruction(lang, opts) {
    if (!lang || lang === 'en') return '';
    const keep =
      'Keep company, product and people names exactly as they appear in the source' +
      (opts && opts.transcript
        ? ' (in name and aliases too), and keep corrections in the transcript’s own language.'
        : '.');
    if (lang === 'auto')
      return 'Write every text field of your answer in the language the speakers mainly use. ' + keep;
    const L = langName(lang);
    return (
      'Write every text field of your answer in ' +
      L +
      ', even if the source is in another language; translate quotes faithfully into ' +
      L +
      '. ' +
      keep
    );
  }

  // ---------- translating the transcript with Claude (fallback when Chrome's free translator can't) ----------
  const TRANSLATE_TOOL = {
    name: 'report_translation',
    description: 'The translated paragraphs.',
    input_schema: obj({ paragraphs: arr(obj({ n: { type: 'integer' }, text: str() }, ['n', 'text'])) }, ['paragraphs'])
  };
  function translateSystem(from, to) {
    return [
      'Translate the numbered transcript paragraphs' +
        (from ? ' from ' + langName(from) : '') +
        ' into ' +
        langName(to) +
        '.',
      'Translate each paragraph completely and faithfully: keep every point, number and nuance, and the speaker’s tone. Do not summarise, explain, add or leave anything out.',
      'Keep names of people, companies and products as they are. Return every paragraph number exactly once, in order.'
    ].join(' ');
  }
  /** Paragraphs go in chunks so long videos work and parts can run in parallel. */
  function buildTranslateRequests(texts, from, to, maxWords) {
    maxWords = maxWords || 1500;
    const wc = (s) => (String(s || '').match(/\S+/g) || []).length;
    const chunks = [];
    let cur = [],
      words = 0;
    texts.forEach((t, i) => {
      if (!String(t || '').trim()) return;
      const w = wc(t);
      if (cur.length && words + w > maxWords) {
        chunks.push(cur);
        cur = [];
        words = 0;
      }
      cur.push(i);
      words += w;
    });
    if (cur.length) chunks.push(cur);
    return chunks.map((idx) => {
      const w = idx.reduce((a, i) => a + wc(texts[i]), 0);
      return {
        idx,
        req: {
          system: translateSystem(from, to),
          user: idx.map((i) => '[' + (i + 1) + '] ' + texts[i]).join('\n\n'),
          tool: TRANSLATE_TOOL,
          maxTokens: Math.min(32000, 1500 + w * 4)
        }
      };
    });
  }

  /**
   * Claude labels voices S1, S2… and sometimes writes that label where a name belongs ("— S2").
   * Swap every such label for the speaker's name throughout an analysis (also fixes ones saved earlier).
   */
  function resolveSpeakerIds(analysis, speakers) {
    if (!analysis || !Array.isArray(speakers) || !speakers.length) return analysis;
    const byId = new Map();
    speakers.forEach((sp) => {
      if (sp && sp.id && sp.name && String(sp.name).trim() !== String(sp.id).trim())
        byId.set(String(sp.id).trim().toUpperCase(), String(sp.name).trim());
    });
    if (!byId.size) return analysis;
    const name = (id) => byId.get(id.toUpperCase());
    // In speaker fields any label is a person. In prose, only where it's used as one ("S2 explains", "S2's view",
    // "according to S2"), so things like "Form S1" or a product called S1 are left alone.
    const anyId = /(^|[^\w-])(S\d{1,2})(?![\w-])/gi;
    const VERBS =
      'says|said|explains|explained|argues|argued|notes|noted|describes|described|thinks|believes|believed|points|adds|added|mentions|mentioned|puts|put|asks|asked|agrees|agreed|disagrees|disagreed|suggests|suggested|claims|claimed|warns|warned|recalls|recalled|predicts|predicted|stresses|stressed|admits|admitted|calls|called|sees|saw|wants|wanted';
    const asPerson = new RegExp(
      "(^|[^\\w-])(S\\d{1,2})(?=['’]s\\b|\\s+(?:" +
        VERBS +
        ')\\b|\\s*[,;:]?\\s*$)|((?:according to|by|from|per)\\s+)(S\\d{1,2})(?![\\w-])',
      'gi'
    );
    const SPEAKER_KEYS = new Set(['speaker', 'speakers', 'explained_by', 'mentioned_by', 'who', 'by']);
    const fix = (v, speakerField) => {
      if (typeof v === 'string') {
        return speakerField
          ? v.replace(anyId, (m, pre, id) => (name(id) ? pre + name(id) : m))
          : v.replace(asPerson, (m, pre, id, pre2, id2) => {
              const i = id || id2,
                p = id ? pre : pre2;
              return name(i) ? p + name(i) : m;
            });
      }
      if (Array.isArray(v)) return v.map((x) => fix(x, speakerField));
      if (v && typeof v === 'object') {
        const o = {};
        for (const k of Object.keys(v)) o[k] = fix(v[k], SPEAKER_KEYS.has(k));
        return o;
      }
      return v;
    };
    return fix(analysis, false);
  }

  /** Split a combined answer into speakers and analysis; concepts are anchored to transcript turns. */
  function splitCombinedResult(out, units) {
    out = out || {};
    const speakers = (out.speakers || []).filter((s) => s && s.id && s.name);
    const turns = (out.turns || []).filter((t) => t && t.speaker);
    const ok = speakers.length && turns.length;
    const corrections = ok ? out.corrections || [] : null;
    const turnsList = buildTurns(units, ok ? turns : null, corrections);
    let analysis = Object.assign({}, out);
    delete analysis.speakers;
    delete analysis.turns;
    delete analysis.corrections;
    delete analysis.notes;
    if (ok) analysis = resolveSpeakerIds(analysis, speakers);
    (analysis.concepts || []).forEach((c) => {
      const at = Number(c.sentence) - 1;
      const t = turnsList.find((x) => at >= x.unitFrom && at <= x.unitTo);
      if (t) c.turn = t.idx;
    });
    analysis.turnCount = turnsList.length;
    return { speakers: ok ? speakers : null, turns: ok ? turns : null, corrections, notes: out.notes || '', analysis };
  }

  /** Distillation runs in chunks of turns so long videos work and parts can run in parallel. */
  function buildDistillRequests(meta, speakers, turnsList, maxWords) {
    maxWords = maxWords || 2200;
    const chunks = [];
    let cur = [],
      words = 0;
    for (const t of turnsList) {
      const w = t.text.split(/\s+/).length;
      if (cur.length && words + w > maxWords) {
        chunks.push(cur);
        cur = [];
        words = 0;
      }
      cur.push(t);
      words += w;
    }
    if (cur.length) chunks.push(cur);
    return chunks.map((ch, i) => ({
      turnIds: ch.map((t) => t.idx),
      req: {
        system: DISTILL_SYSTEM,
        user: [
          metaBlock(meta),
          rosterBlock(speakers),
          'Part ' + (i + 1) + ' of ' + chunks.length + '. Turns:',
          labeledTurnsText(ch, speakers)
        ]
          .filter(Boolean)
          .join('\n\n'),
        tool: DISTILL_TOOL,
        maxTokens: Math.min(32000, 8000 + Math.round(ch.reduce((a, t) => a + t.text.split(/\s+/).length, 0) * 2))
      }
    }));
  }

  /** One self-contained prompt for pasting into claude.ai (no API key needed). */
  function buildChatPrompt(meta, transcriptText, focus, hasSpeakers, lang) {
    return [
      'Below is the transcript of a video' +
        (hasSpeakers
          ? ' with speaker labels.'
          : '. It comes from auto-captions, so it has no speaker labels and some names may be misspelled.'),
      'Please produce, in this order:',
      '1. Summary — 3-4 sentences.',
      '2. Speakers — identify each speaker (name and role) as best you can from introductions, people being addressed by name, and the title/description.',
      '3. Key themes — each theme with the context it works in (where it comes up, how it applies, who drives it).',
      '4. Concepts explained — whenever a speaker explains a concept, name it and break the explanation into detailed numbered points (1, 2, 3...).',
      '5. Key learnings — how they do things; how they view things; strong statements (near-verbatim quotes with the speaker); facts & figures.',
      '6. Transcript — the full transcript grouped by speaker, distilled to the core message: remove filler words, false starts, laughter, jokes and banter, but keep every substantive point. Bold every company name.',
      '7. Companies mentioned — a glossary: each company with a one-to-two-line note on why it was mentioned.',
      '8. How the concepts connect — end with a small diagram (a Mermaid flowchart) linking the concepts from section 4 with short verb phrases on the arrows.',
      'Use only what is said in the transcript.',
      lang && lang !== 'en'
        ? lang === 'auto'
          ? 'Write your answer in the language the speakers mainly use.'
          : 'Write your answer in ' +
            langName(lang) +
            ', translating quotes faithfully. Keep names of people and companies as they are.'
        : '',
      focus && focus.trim() && focus.trim() !== DEFAULT_FOCUS ? '\nWhat I care most about:\n' + focus.trim() : '',
      '',
      metaBlock(meta),
      '',
      'Transcript:',
      transcriptText
    ]
      .filter((x) => x !== '')
      .join('\n');
  }

  // ---------- plain text / Markdown ----------
  function transcriptPlainText(paras, speakers) {
    const out = [];
    for (const p of paras) {
      if (p.chapter) out.push('## ' + p.chapter);
      const name = speakerName(p.speaker, speakers);
      out.push(name && !p.cont ? name + ': ' + p.text : (p.changeMarked ? '— ' : '') + p.text);
    }
    return out.join('\n\n');
  }

  function distilledPlainText(groups, speakers) {
    return groups
      .map((g) => {
        const name = speakerName(g.speaker, speakers);
        return (name ? name + ': ' : '') + g.paras.join('\n\n');
      })
      .join('\n\n');
  }

  function transcriptMarkdown(paras, speakers, matcher) {
    const out = [];
    for (const p of paras) {
      if (p.chapter) out.push('### ' + p.chapter);
      const name = speakerName(p.speaker, speakers);
      const body = boldCompanies(p.text, matcher);
      out.push(name && !p.cont ? '**' + name + ':** ' + body : (p.changeMarked ? '— ' : '') + body);
    }
    return out.join('\n\n');
  }

  function distilledMarkdown(groups, speakers, matcher) {
    return groups
      .map((g) => {
        const name = speakerName(g.speaker, speakers);
        const paras = g.paras.map((p) => boldCompanies(p, matcher));
        if (name) paras[0] = '**' + name + ':** ' + paras[0];
        return paras.join('\n\n');
      })
      .join('\n\n');
  }

  function speakersMarkdown(speakers) {
    if (!speakers || !speakers.length) return '';
    return speakers
      .map(
        (s) =>
          '- **' +
          s.name +
          '**' +
          (s.role ? ' — ' + s.role : '') +
          (s.confidence && s.confidence !== 'high' ? ' _(' + s.confidence + ' confidence)_' : '')
      )
      .join('\n');
  }

  function insightsMarkdown(A, level, opts) {
    if (!A) return '';
    const h = (n) => '#'.repeat((level || 2) + n) + ' ';
    const out = [];
    if (A.summary) out.push(h(0) + 'Summary\n\n' + A.summary);
    if (A.themes && A.themes.length) {
      out.push(
        h(0) +
          'Key themes\n\n' +
          A.themes
            .map(
              (t, i) =>
                i +
                1 +
                '. **' +
                t.theme +
                '** — ' +
                t.context +
                (t.speakers && t.speakers.length ? ' _(' + t.speakers.join(', ') + ')_' : '')
            )
            .join('\n')
      );
    }
    if (A.concepts && A.concepts.length) {
      out.push(
        h(0) +
          'Concepts explained\n\n' +
          A.concepts
            .map(
              (c) =>
                h(1) +
                c.concept +
                (c.explained_by ? ' — explained by ' + c.explained_by : '') +
                '\n\n' +
                (c.points || []).map((p, i) => i + 1 + '. ' + p).join('\n')
            )
            .join('\n\n')
      );
    }
    const kl = [];
    if (A.how_they_do_it && A.how_they_do_it.length)
      kl.push(
        h(1) +
          'How they do things\n\n' +
          A.how_they_do_it
            .map((x) => '- **' + x.point + '** — ' + (x.detail || '') + ' _(' + x.speaker + ')_')
            .join('\n')
      );
    if (A.how_they_see_it && A.how_they_see_it.length)
      kl.push(
        h(1) +
          'How they see things\n\n' +
          A.how_they_see_it
            .map((x) => '- **' + x.view + '** — ' + (x.detail || '') + ' _(' + x.speaker + ')_')
            .join('\n')
      );
    if (A.strong_statements && A.strong_statements.length)
      kl.push(
        h(1) +
          'Strong statements\n\n' +
          A.strong_statements
            .map(
              (x) =>
                '> "' +
                String(x.quote).replace(/^["“]|["”]$/g, '') +
                '"\n> — **' +
                x.speaker +
                '**' +
                (x.context ? ', ' + x.context : '')
            )
            .join('\n\n')
      );
    if (A.facts_and_figures && A.facts_and_figures.length)
      kl.push(
        h(1) +
          'Facts & figures\n\n' +
          A.facts_and_figures.map((x) => '- ' + x.fact + ' _(' + x.speaker + ')_').join('\n')
      );
    if (kl.length) out.push(h(0) + 'Key learnings\n\n' + kl.join('\n\n'));
    if (!(opts && opts.noMap)) {
      const cm = conceptMapMarkdown(A, level || 2);
      if (cm) out.push(cm);
    }
    return out.join('\n\n');
  }

  function companiesMarkdown(companies, level) {
    if (!companies || !companies.length) return '';
    const h = '#'.repeat(level || 2) + ' ';
    return (
      h +
      'Companies mentioned\n\n' +
      companies
        .map(
          (c) => '- **' + c.name + '**' + (c.type && c.type !== 'company' ? ' _(' + c.type + ')_' : '') + ' — ' + c.why
        )
        .join('\n')
    );
  }

  // ---------- concept map ----------
  /** Resolve concept_links against the concepts list. Returns { nodes: [{ i, name, by }], edges: [{ from, to, relation }] }. */
  function conceptGraph(A) {
    const concepts = (A && A.concepts) || [];
    const nodes = concepts.map((c, i) => ({
      i,
      name: String(c.concept || 'Concept ' + (i + 1)),
      by: c.explained_by || ''
    }));
    const norm = (x) =>
      String(x || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    const find = (name) => {
      const n = norm(name);
      if (!n) return -1;
      let k = nodes.findIndex((x) => norm(x.name) === n);
      if (k < 0) k = nodes.findIndex((x) => norm(x.name).includes(n) || n.includes(norm(x.name)));
      return k;
    };
    const seen = new Set(),
      edges = [];
    for (const l of (A && A.concept_links) || []) {
      const a = find(l && l.from),
        b = find(l && l.to);
      if (a < 0 || b < 0 || a === b) continue;
      const key = a + '>' + b;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: a, to: b, relation: String(l.relation || '').trim() });
    }
    return { nodes, edges };
  }

  function conceptMapMarkdown(A, level) {
    const g = conceptGraph(A);
    if (g.nodes.length < 2 || !g.edges.length) return '';
    const h = '#'.repeat(level || 2) + ' ';
    const q = (t) =>
      String(t)
        .replace(/"/g, '#quot;')
        .replace(/[[\]{}<>|]/g, ' ');
    const lab = (t) =>
      String(t)
        .replace(/["|[\]{}<>]/g, '')
        .trim();
    const used = new Set();
    g.edges.forEach((e) => {
      used.add(e.from);
      used.add(e.to);
    });
    const lines = ['flowchart TD'];
    g.nodes.forEach((n) => {
      if (used.has(n.i)) lines.push('  c' + n.i + '["' + q(n.name) + '"]');
    });
    g.edges.forEach((e) =>
      lines.push('  c' + e.from + (e.relation ? ' -->|' + lab(e.relation) + '| ' : ' --> ') + 'c' + e.to)
    );
    const list = g.edges.map(
      (e) =>
        '- **' + g.nodes[e.from].name + '** → _' + (e.relation || 'relates to') + '_ → **' + g.nodes[e.to].name + '**'
    );
    return h + 'How the concepts connect\n\n```mermaid\n' + lines.join('\n') + '\n```\n\n' + list.join('\n');
  }

  /**
   * Top-down layered layout for the concept map (pure; rendered as SVG by the UI).
   * Returns { width, height, nodes: [{ i, name, x, y, w, h, lines }], edges: [{ from, to, relation, d, lx, ly }] }.
   */
  function layoutConceptMap(graph, width) {
    width = Math.max(260, width || 360);
    const n = graph.nodes.length;
    const succ = Array.from({ length: n }, () => []),
      pred = Array.from({ length: n }, () => []);
    // drop back edges (cycles) from the layering, but still draw them
    const state = new Array(n).fill(0),
      back = new Set();
    const dfs = (u) => {
      state[u] = 1;
      graph.edges.forEach((e, k) => {
        if (e.from !== u) return;
        if (state[e.to] === 1) back.add(k);
        else if (!state[e.to]) dfs(e.to);
      });
      state[u] = 2;
    };
    for (let i = 0; i < n; i++) if (!state[i]) dfs(i);
    graph.edges.forEach((e, k) => {
      if (!back.has(k)) {
        succ[e.from].push(e.to);
        pred[e.to].push(e.from);
      }
    });
    const connected = new Set();
    graph.edges.forEach((e) => {
      connected.add(e.from);
      connected.add(e.to);
    });
    // longest-path layering
    const layer = new Array(n).fill(0),
      indeg = pred.map((p) => p.length),
      queue = [];
    for (let i = 0; i < n; i++) if (!indeg[i]) queue.push(i);
    while (queue.length) {
      const u = queue.shift();
      for (const v of succ[u]) {
        layer[v] = Math.max(layer[v], layer[u] + 1);
        if (!--indeg[v]) queue.push(v);
      }
    }
    // pull sources down next to their first child
    for (let i = 0; i < n; i++)
      if (!pred[i].length && succ[i].length)
        layer[i] = Math.max(layer[i], Math.min(...succ[i].map((v) => layer[v])) - 1);
    const maxLayer = Math.max(0, ...[...connected].map((i) => layer[i]));
    for (let i = 0; i < n; i++) if (!connected.has(i)) layer[i] = maxLayer + 1;
    // rows (a layer wider than `cols` wraps onto extra rows)
    const cols = width >= 640 ? 3 : 2,
      gap = 16,
      rowGap = 46,
      pad = 4;
    const nodeW = Math.floor((width - pad * 2 - gap * (cols - 1)) / cols);
    const byLayer = [];
    for (let i = 0; i < n; i++) (byLayer[layer[i]] = byLayer[layer[i]] || []).push(i);
    const pos = new Array(n),
      rows = [];
    for (const ids of byLayer.filter(Boolean)) {
      // order by parents' x (barycenter) to reduce crossings
      ids.sort((a, b) => {
        const bc = (v) => {
          const xs = pred[v].map((p) => pos[p] && pos[p].cx).filter((x) => x != null);
          return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : width / 2 + v;
        };
        return bc(a) - bc(b);
      });
      for (let k = 0; k < ids.length; k += cols) {
        const row = ids.slice(k, k + cols);
        rows.push(row);
        const total = row.length * nodeW + (row.length - 1) * gap;
        let x = (width - total) / 2;
        for (const id of row) {
          pos[id] = { x, cx: x + nodeW / 2 };
          x += nodeW + gap;
        }
      }
    }
    // text wrapping and row heights
    const charW = 6.3,
      lineH = 15,
      maxChars = Math.max(10, Math.floor((nodeW - 20) / charW));
    const wrap = (t) => {
      const words = String(t).split(/\s+/),
        lines = [];
      let cur = '';
      for (const w of words) {
        if ((cur + ' ' + w).trim().length > maxChars && cur) {
          lines.push(cur);
          cur = w;
        } else cur = (cur + ' ' + w).trim();
      }
      if (cur) lines.push(cur);
      return lines.slice(0, 4);
    };
    const nodes = [];
    let y = pad;
    const rowOf = new Array(n);
    rows.forEach((row, r) => {
      const hs = row.map((id) => wrap(graph.nodes[id].name).length * lineH + 16);
      const rh = Math.max(...hs);
      row.forEach((id) => {
        const lines = wrap(graph.nodes[id].name);
        nodes[id] = { i: id, name: graph.nodes[id].name, x: pos[id].x, y, w: nodeW, h: rh, lines };
        rowOf[id] = r;
      });
      y += rh + rowGap;
    });
    const height = y - rowGap + pad;
    // edges as cubic curves; labels in the gap below the source row
    const edges = graph.edges.map((e) => {
      const a = nodes[e.from],
        b = nodes[e.to];
      let p0, p1, p2, p3;
      if (rowOf[e.to] > rowOf[e.from]) {
        p0 = [a.x + a.w / 2, a.y + a.h];
        p3 = [b.x + b.w / 2, b.y];
        const dy = Math.max(24, (p3[1] - p0[1]) / 2);
        p1 = [p0[0], p0[1] + dy];
        p2 = [p3[0], p3[1] - dy];
      } else {
        // same row or pointing upward: loop around the right-hand side
        p0 = [a.x + a.w, a.y + a.h / 2];
        p3 = [b.x + b.w, b.y + b.h / 2];
        const ox = Math.min(width - 2, Math.max(p0[0], p3[0]) + 28);
        p1 = [ox, p0[1]];
        p2 = [ox, p3[1]];
      }
      const d =
        'M' + p0.map(Math.round).join(',') + ' C' + [p1, p2, p3].map((p) => p.map(Math.round).join(',')).join(' ');
      const span = rowOf[e.to] - rowOf[e.from];
      const t = span === 1 || span <= 0 ? 0.5 : Math.min(0.5, 26 / Math.max(1, p3[1] - p0[1]) + 0.08);
      const bz = (k) =>
        Math.pow(1 - t, 3) * p0[k] +
        3 * Math.pow(1 - t, 2) * t * p1[k] +
        3 * (1 - t) * t * t * p2[k] +
        Math.pow(t, 3) * p3[k];
      return { from: e.from, to: e.to, relation: e.relation, d, lx: bz(0), ly: bz(1) };
    });
    // nudge overlapping labels apart horizontally
    const lw = (s) => Math.min(width - 8, String(s || '').length * 5.7 + 12);
    edges.sort((p, q) => p.ly - q.ly || p.lx - q.lx);
    for (let i = 1; i < edges.length; i++)
      for (let j = 0; j < i; j++) {
        const p = edges[i],
          q = edges[j];
        if (Math.abs(p.ly - q.ly) < 16 && Math.abs(p.lx - q.lx) < (lw(p.relation) + lw(q.relation)) / 2 + 4) {
          const shift = (lw(p.relation) + lw(q.relation)) / 2 + 4 - Math.abs(p.lx - q.lx);
          p.lx = p.lx >= q.lx ? p.lx + shift : p.lx - shift;
        }
      }
    edges.forEach((e) => {
      const half = lw(e.relation) / 2;
      e.lx = Math.max(half + 2, Math.min(width - half - 2, e.lx));
      e.lw = lw(e.relation);
    });
    return { width, height, nodes: nodes.filter(Boolean), edges };
  }

  /**
   * Full document, in the order: summary, speakers, themes, concepts, key learnings,
   * transcript (grouped by speaker, companies in bold), company glossary, and a concept map at the end.
   */
  function fullMarkdown(meta, d) {
    meta = meta || {};
    d = d || {};
    const A = d.analysis || null;
    const matcher = A ? companyMatcher(A.companies) : null;
    const out = ['# ' + (meta.title || 'Transcript')];
    const sub = [meta.channel, meta.videoId ? 'https://www.youtube.com/watch?v=' + meta.videoId : '']
      .filter(Boolean)
      .join(' · ');
    if (sub) out.push(sub);
    if (A && A.summary) out.push('## Summary\n\n' + A.summary);
    if (d.speakers && d.speakers.length) out.push('## Speakers\n\n' + speakersMarkdown(d.speakers));
    if (A) out.push(insightsMarkdown({ ...A, summary: null }, 2, { noMap: true }));
    if (d.groups && d.groups.length && d.view !== 'verbatim')
      out.push('## Transcript (distilled, grouped by speaker)\n\n' + distilledMarkdown(d.groups, d.speakers, matcher));
    else if (d.paras && d.paras.length)
      out.push('## Transcript\n\n' + transcriptMarkdown(d.paras, d.speakers, matcher));
    if (A && A.companies && A.companies.length) out.push(companiesMarkdown(A.companies, 2));
    if (A) out.push(conceptMapMarkdown(A, 2));
    return out.filter(Boolean).join('\n\n') + '\n';
  }

  const api = {
    SPK,
    tsToSec,
    secToTs,
    parseTranscriptText,
    cleanSegmentText,
    finalizeUnitText,
    buildUnits,
    applyCorrections,
    speakerPerUnit,
    buildTurns,
    buildParagraphs,
    speakerName,
    resolveSpeakerIds,
    labeledTurnsText,
    distilledGroups,
    companyMatcher,
    splitHighlights,
    boldCompanies,
    DEFAULT_FOCUS,
    SPEAKER_TOOL,
    ANALYSIS_TOOL,
    DISTILL_TOOL,
    buildSpeakerRequest,
    buildAnalysisRequest,
    buildDistillRequests,
    buildChatPrompt,
    COMBINED_TOOL,
    buildCombinedRequest,
    splitCombinedResult,
    combinedSystem,
    lengthGuidance,
    LANGUAGES,
    langName,
    pickLanguage,
    guessLanguage,
    sameLanguage,
    languageInstruction,
    TRANSLATE_TOOL,
    buildTranslateRequests,
    transcriptPlainText,
    distilledPlainText,
    transcriptMarkdown,
    distilledMarkdown,
    speakersMarkdown,
    insightsMarkdown,
    companiesMarkdown,
    fullMarkdown,
    conceptGraph,
    conceptMapMarkdown,
    layoutConceptMap
  };
  root.YTCT = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
