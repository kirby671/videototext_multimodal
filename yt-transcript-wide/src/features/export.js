/*
 * Download transcripts from the Library as Markdown: one combined file, or a .zip with one file per video.
 * Each video gets its title, channel, date and link, then (as chosen) insights, the transcript and companies.
 */
(function (root) {
  'use strict';
  const C = root.YTCT;

  const fmtDay = (t) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const isoDay = (t) => {
    const d = new Date(t);
    return (
      d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    );
  };
  const dur = (s) => {
    s = Math.round(s || 0);
    if (!s) return '';
    const h = Math.floor(s / 3600),
      m = Math.round((s % 3600) / 60);
    return h ? h + ' h ' + String(m).padStart(2, '0') + ' min' : Math.max(1, m) + ' min';
  };

  /** One video as Markdown. `base` is the heading level of the title (1 on its own, 2 inside a combined file). */
  function videoMarkdown(e, opts, clean, base) {
    base = base || 1;
    const H = (n) => '#'.repeat(Math.min(6, base + n)) + ' ';
    const rec = e.rec || {};
    const units = C.buildUnits(rec.items || [], {
      removeFillers: clean.removeFillers !== false,
      removeTags: clean.removeTags !== false
    });
    // speaker turns only line up with the transcript they were made for
    const ok = !!(rec.turns && rec.unitCount === units.length);
    const speakers = ok ? rec.speakers : null,
      turns = ok ? rec.turns : null,
      corrections = ok ? rec.corrections : null;
    const A = rec.analysis
      ? C.resolveSpeakerIds
        ? C.resolveSpeakerIds(rec.analysis, rec.speakers)
        : rec.analysis
      : null;
    const matcher = A ? C.companyMatcher(A.companies) : null;
    const out = [H(0) + (e.title || 'Transcript')];
    const when = e.published ? 'Published ' + fmtDay(e.published) : e.created ? 'Saved ' + fmtDay(e.created) : '';
    const meta = [
      e.channel,
      when,
      dur(e.seconds),
      e.videoId ? 'https://www.youtube.com/watch?v=' + e.videoId : e.pasted ? 'Pasted transcript' : ''
    ]
      .filter(Boolean)
      .join(' · ');
    if (meta) out.push(meta);
    if (opts.insights) {
      if (A) {
        if (A.summary) out.push(H(1) + 'Summary\n\n' + A.summary);
        if (speakers && speakers.length) out.push(H(1) + 'Speakers\n\n' + C.speakersMarkdown(speakers));
        const ins = C.insightsMarkdown({ ...A, summary: null }, base + 1, { noMap: true });
        if (ins) out.push(ins);
      } else out.push('_No insights yet: this transcript hasn’t been analyzed._');
    }
    if (opts.transcript) {
      const turnsList = C.buildTurns(units, turns, corrections);
      const distilled =
        ok && rec.distilled && rec.distilled.covered && rec.distilled.covered.length ? rec.distilled : null;
      if (!opts.insights && speakers && speakers.length)
        out.push('Speakers: ' + speakers.map((s) => s.name + (s.role ? ' (' + s.role + ')' : '')).join(', '));
      if (opts.version !== 'clean' && distilled) {
        out.push(
          H(1) +
            'Transcript (distilled, grouped by speaker)\n\n' +
            C.distilledMarkdown(C.distilledGroups(turnsList, distilled), speakers, matcher)
        );
      } else {
        const paras = C.buildParagraphs(units, turns, corrections);
        out.push(
          H(1) +
            'Transcript\n\n' +
            (paras.length ? C.transcriptMarkdown(paras, speakers, matcher) : '_The transcript is empty._')
        );
      }
    }
    if (opts.companies) {
      if (A && A.companies && A.companies.length) out.push(C.companiesMarkdown(A.companies, base + 1));
      else if (!opts.insights)
        out.push(A ? '_No companies were mentioned._' : '_No companies yet: this transcript hasn’t been analyzed._');
    }
    if (opts.insights && A) {
      const cm = C.conceptMapMarkdown(A, base + 1);
      if (cm) out.push(cm);
    }
    return out.filter(Boolean).join('\n\n') + '\n';
  }

  /** The pieces of one video for other layouts (PDF): meta line, summary, speakers and transcript paragraphs. */
  function videoParts(e, version, clean) {
    const rec = e.rec || {};
    const units = C.buildUnits(rec.items || [], {
      removeFillers: clean.removeFillers !== false,
      removeTags: clean.removeTags !== false
    });
    const ok = !!(rec.turns && rec.unitCount === units.length);
    const speakers = ok ? rec.speakers : null,
      turns = ok ? rec.turns : null,
      corrections = ok ? rec.corrections : null;
    const A = rec.analysis
      ? C.resolveSpeakerIds
        ? C.resolveSpeakerIds(rec.analysis, rec.speakers)
        : rec.analysis
      : null;
    const when = e.published ? 'Published ' + fmtDay(e.published) : e.created ? 'Saved ' + fmtDay(e.created) : '';
    const meta = [
      e.channel,
      when,
      dur(e.seconds),
      e.videoId ? 'https://www.youtube.com/watch?v=' + e.videoId : e.pasted ? 'Pasted transcript' : ''
    ]
      .filter(Boolean)
      .join(' · ');
    const turnsList = C.buildTurns(units, turns, corrections);
    const distilled =
      ok && rec.distilled && rec.distilled.covered && rec.distilled.covered.length ? rec.distilled : null;
    const paras = [];
    let isDistilled = false;
    if (version !== 'clean' && distilled) {
      isDistilled = true;
      for (const g of C.distilledGroups(turnsList, distilled)) {
        const name = C.speakerName(g.speaker, speakers);
        g.paras.forEach((t, i) => paras.push({ name: i === 0 ? name : null, text: t }));
      }
    } else {
      for (const p of C.buildParagraphs(units, turns, corrections)) {
        paras.push({
          chapter: p.chapter || null,
          name: !p.cont ? C.speakerName(p.speaker, speakers) : null,
          text: (p.changeMarked && p.cont ? '— ' : '') + p.text
        });
      }
    }
    return { meta, A, speakers, paras, distilled: isDistilled };
  }

  const parts = (o) =>
    [
      o.transcript &&
        (o.version === 'clean' ? 'transcripts (word for word)' : 'transcripts (distilled where available)'),
      o.insights && 'insights',
      o.companies && 'companies'
    ].filter(Boolean);

  function combinedMarkdown(list, opts, clean) {
    const head = [
      '# Clean Transcript Library',
      '',
      '_Downloaded ' +
        fmtDay(Date.now()) +
        ' · ' +
        list.length +
        ' transcript' +
        (list.length === 1 ? '' : 's') +
        ' · ' +
        parts(opts).join(', ') +
        '_',
      '',
      '## Contents',
      ''
    ];
    list.forEach((e, i) =>
      head.push(
        i +
          1 +
          '. ' +
          e.title +
          [e.channel, e.published ? fmtDay(e.published) : '']
            .filter(Boolean)
            .map((x) => ' · ' + x)
            .join('')
      )
    );
    const body = list.map((e) => videoMarkdown(e, opts, clean, 2).trim());
    return head.join('\n') + '\n\n---\n\n' + body.join('\n\n---\n\n') + '\n';
  }

  // File names: "2026-09-12 Title.md", unique within the zip.
  function fileNames(list) {
    const used = new Set();
    return list.map((e) => {
      const base = (
        isoDay(e.published || e.created || Date.now()) +
        ' ' +
        String(e.title || 'Transcript')
          .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      )
        .slice(0, 120)
        .trim();
      let name = base + '.md',
        n = 2;
      while (used.has(name.toLowerCase())) name = base + ' (' + n++ + ').md';
      used.add(name.toLowerCase());
      return name;
    });
  }

  // ---------- a small .zip writer (files stored uncompressed: text, so still compact enough) ----------
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(b) {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function zip(files) {
    const enc = new TextEncoder();
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const chunks = [],
      central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name),
        data = enc.encode(f.text),
        crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true);
      lh.setUint16(10, time, true);
      lh.setUint16(12, date, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true);
      lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true);
      lh.setUint16(28, 0, true);
      chunks.push(lh, name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, time, true);
      ch.setUint16(14, date, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true);
      ch.setUint32(24, data.length, true);
      ch.setUint16(28, name.length, true);
      ch.setUint16(30, 0, true);
      ch.setUint16(32, 0, true);
      ch.setUint16(34, 0, true);
      ch.setUint16(36, 0, true);
      ch.setUint32(38, 0, true);
      ch.setUint32(42, offset, true);
      central.push(ch, name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((s, p) => s + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(4, 0, true);
    end.setUint16(6, 0, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    end.setUint16(20, 0, true);
    return new Blob([...chunks, ...central, end], { type: 'application/zip' });
  }

  /** Build the download for these entries. Returns { blob, filename }. */
  function build(list, opts, clean) {
    const stamp = isoDay(Date.now());
    const label =
      list.length === 1
        ? String(list[0].title || 'Transcript')
            .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 90)
            .trim()
        : 'Clean transcripts ' + stamp + ' (' + list.length + ')';
    if (opts.zip && list.length > 1) {
      const names = fileNames(list);
      const files = list.map((e, i) => ({ name: names[i], text: videoMarkdown(e, opts, clean, 1) }));
      return { blob: zip(files), filename: label + '.zip' };
    }
    const text = list.length === 1 ? videoMarkdown(list[0], opts, clean, 1) : combinedMarkdown(list, opts, clean);
    return { blob: new Blob([text], { type: 'text/markdown;charset=utf-8' }), filename: label + '.md' };
  }

  root.YTCTExport = { videoMarkdown, videoParts, combinedMarkdown, fileNames, zip, crc32, build };
})(typeof globalThis !== 'undefined' ? globalThis : this);
