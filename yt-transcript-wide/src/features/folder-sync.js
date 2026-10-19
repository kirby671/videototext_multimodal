/*
 * Sync the Library to a folder you choose, as plain Markdown files Claude can read:
 *   README.md             what's here and how to ask Claude about it
 *   Library index.md      every video: date, title, channel, analyzed or not, file name
 *   Transcripts/*.md      one file per video: title, link, insights, companies and the full transcript
 *   Trend report.md       the latest trend report (if you've written one)
 *   Company network.md    the company network (if you've built one)
 * Only files this sync created are ever changed or removed. The folder handle lives in IndexedDB;
 * what was written (names + fingerprints) lives in chrome.storage under "sync:state".
 * `store` is { get(keys|null), set(obj) }: chrome.storage.local in pages, a message relay in the background.
 */
(function (root) {
  'use strict';
  const DB = 'ytct-sync',
    KV = 'kv',
    STATE_KEY = 'sync:state',
    SUB = 'Transcripts',
    PREFIX = 'cache:';

  // ---------- the folder handle (IndexedDB: handles can't go in chrome.storage) ----------
  function db() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(KV);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function kv(op, key, val) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(KV, op === 'get' ? 'readonly' : 'readwrite');
      const s = tx.objectStore(KV);
      const q = op === 'get' ? s.get(key) : op === 'del' ? s.delete(key) : s.put(val, key);
      q.onsuccess = () => resolve(op === 'get' ? q.result : true);
      q.onerror = () => reject(q.error);
    });
  }
  const getFolder = () => kv('get', 'dir').catch(() => null);
  const setFolder = (h) => (h ? kv('put', 'dir', h) : kv('del', 'dir'));
  async function permission(h, ask) {
    if (!h || !h.queryPermission) return 'denied';
    const o = { mode: 'readwrite' };
    let p = await h.queryPermission(o);
    if (p !== 'granted' && ask && h.requestPermission) p = await h.requestPermission(o);
    return p;
  }

  // ---------- what goes in the files ----------
  const hash = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16) + ':' + s.length;
  };
  const isoDay = (t) => {
    const d = new Date(t);
    return (
      d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    );
  };
  const parseDay = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : Date.parse(s) || 0;
  };
  const wordsIn = (s) => (String(s || '').match(/\S+/g) || []).length;
  function entryOf(key, rec) {
    const meta = rec.meta || {};
    const kind = rec.kind || (key.startsWith(PREFIX + 'paste-') ? 'paste' : 'youtube');
    const vid = rec.videoId || meta.videoId || (kind === 'youtube' ? key.slice(PREFIX.length) : null);
    const segs = (rec.items || []).filter((i) => i && i.type !== 'chapter');
    return {
      key,
      rec,
      kind,
      videoId: /^[\w-]{11}$/.test(String(vid || '')) ? vid : null,
      title: String(meta.title || (kind === 'paste' ? 'Pasted transcript' : 'Untitled video')).trim(),
      channel: String(meta.channel || '').trim(),
      created: rec.createdAt || rec.savedAt || 0,
      published: parseDay(meta.publishDate),
      seconds: Number(meta.lengthSeconds) || (segs.length && segs[segs.length - 1].start) || 0,
      words: rec.words || segs.reduce((n, s) => n + wordsIn(s.text), 0),
      analyzed: !!rec.analysis,
      pasted: kind === 'paste' || rec.source === 'pasted text'
    };
  }
  const dateOf = (e) => e.published || e.created || Date.now();
  const baseName = (e) =>
    (
      isoDay(dateOf(e)) +
      ' ' +
      e.title
        .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    )
      .slice(0, 110)
      .trim();
  const q = (s) => JSON.stringify(String(s == null ? '' : s));
  function frontMatter(e) {
    return [
      '---',
      'title: ' + q(e.title),
      'channel: ' + q(e.channel),
      'date: ' + isoDay(dateOf(e)) + (e.published ? '  # published' : '  # saved to the Library'),
      e.videoId ? 'youtube: https://www.youtube.com/watch?v=' + e.videoId : 'source: pasted transcript',
      'analyzed: ' + (e.analyzed ? 'yes' : 'no'),
      'library_id: ' + q(e.key),
      '---',
      ''
    ].join('\n');
  }
  function indexMarkdown(entries, files) {
    const L = [
      '# Library index',
      '',
      entries.length +
        ' transcript' +
        (entries.length === 1 ? '' : 's') +
        ', newest first. Each one is a file in the Transcripts folder.',
      '',
      '| Date | Title | Channel | Analyzed | File |',
      '| --- | --- | --- | --- | --- |'
    ];
    const cell = (s) =>
      String(s || '')
        .replace(/\|/g, '\\|')
        .replace(/\s+/g, ' ');
    entries.forEach((e) =>
      L.push(
        '| ' +
          isoDay(dateOf(e)) +
          ' | ' +
          cell(e.title) +
          ' | ' +
          cell(e.channel) +
          ' | ' +
          (e.analyzed ? 'yes' : 'no') +
          ' | ' +
          SUB +
          '/' +
          cell(files[e.key].name) +
          ' |'
      )
    );
    return L.join('\n') + '\n';
  }
  function readme(n, hasTrends, hasNet) {
    return [
      '# Clean Transcript Library',
      '',
      'This folder is kept up to date automatically by the Clean Transcript extension (' +
        n +
        ' transcript' +
        (n === 1 ? '' : 's') +
        ' at the last sync). Files here are overwritten when the Library changes, so don’t edit them; anything else you put in the folder is left alone.',
      '',
      '## What’s here',
      '',
      '- **Transcripts/**: one Markdown file per video. Each starts with its title, channel, date and YouTube link, then the analysis (summary, speakers, key themes, concepts explained, how they do things, how they see things, strong statements, facts & figures), the full transcript word for word with speakers named where they were identified, and the companies mentioned with why each came up.',
      '- **Library index.md**: every video with its date, channel, whether it has been analyzed, and its file name.',
      hasTrends
        ? '- **Trend report.md**: the latest trend report across the Library; [V1], [V2]… refer to the numbered video list at its end.'
        : null,
      hasNet
        ? '- **Company network.md**: how the companies in these videos relate to each other, with the context each tie came up in.'
        : null,
      '',
      '## Asking Claude',
      '',
      'Add this folder to a chat in the Claude desktop app, then ask things like:',
      '',
      '- “Using my transcript library, what has been said about stablecoin settlement, and by whom?”',
      '- “Which videos mention Circle, and how does the way they talk about it change over time?”',
      '- “Find quotes where a guest disagrees with the host about regulation.”',
      '',
      'Library index.md is the quickest way to find the right files; the transcripts have the detail and exact wording.',
      ''
    ]
      .filter((x) => x !== null)
      .join('\n');
  }

  async function writeText(dir, name, text) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
  }
  async function removeFile(dir, name) {
    try {
      await dir.removeEntry(name);
    } catch (e) {
      /* already gone */
    }
  }

  /**
   * Bring the folder up to date. opts: { ask: may prompt for permission (needs a click), force: rewrite everything }.
   * Returns { ok, reason?, written, removed, total, folder }.
   */
  async function syncNow(store, opts) {
    opts = opts || {};
    const dir = await getFolder();
    if (!dir) return { ok: false, reason: 'nofolder' };
    let perm = 'denied';
    try {
      perm = await permission(dir, !!opts.ask);
    } catch (e) {
      perm = 'denied';
    }
    if (perm !== 'granted') {
      const cur = (await store.get([STATE_KEY]))[STATE_KEY] || {};
      await store.set({ [STATE_KEY]: { ...cur, folderName: dir.name, needsPermission: true } });
      return { ok: false, reason: 'permission', folder: dir.name };
    }
    const run = async () => {
      const all = await store.get(null);
      const prev = all[STATE_KEY] || {};
      const files = { ...(prev.files || {}) };
      const extrasPrev = { ...(prev.extras || {}) };
      const clean = { removeFillers: all.removeFillers !== false, removeTags: all.removeTags !== false };
      const entries = Object.keys(all)
        .filter((k) => k.startsWith(PREFIX) && all[k] && Array.isArray(all[k].items))
        .map((k) => entryOf(k, all[k]))
        .sort((a, b) => dateOf(b) - dateOf(a) || a.title.localeCompare(b.title));
      const sub = await dir.getDirectoryHandle(SUB, { create: true });
      const live = new Set(entries.map((e) => e.key));
      let written = 0,
        removed = 0;
      // gone from the Library: remove its file
      for (const k of Object.keys(files))
        if (!live.has(k)) {
          await removeFile(sub, files[k].name);
          delete files[k];
          removed++;
        }
      const taken = new Set(Object.values(files).map((f) => f.name.toLowerCase()));
      for (const e of entries) {
        const base = baseName(e);
        const f = files[e.key];
        let name = f && f.base === base ? f.name : null;
        if (!name) {
          if (f) taken.delete(f.name.toLowerCase());
          name = base + '.md';
          for (let n = 2; taken.has(name.toLowerCase()); n++) name = base + ' (' + n + ').md';
          taken.add(name.toLowerCase());
        }
        const text =
          frontMatter(e) +
          root.YTCTExport.videoMarkdown(
            e,
            { transcript: true, insights: true, companies: true, version: 'clean' },
            clean,
            1
          );
        const h = hash(text);
        if (f && f.name !== name) {
          await removeFile(sub, f.name);
          removed++;
        }
        if (!f || f.h !== h || f.name !== name || opts.force) {
          await writeText(sub, name, text);
          written++;
        }
        files[e.key] = { name, base, h };
      }
      const report = all['trends:report'],
        net = all['net:graph'];
      const extras = {
        'README.md': readme(entries.length, !!(report && report.result), !!net),
        'Library index.md': indexMarkdown(entries, files)
      };
      if (report && report.result && root.YTCTTrends)
        extras['Trend report.md'] = root.YTCTTrends.reportMarkdown(report);
      if (net && root.YTCTNetwork) extras['Company network.md'] = root.YTCTNetwork.networkMarkdown(net);
      const extrasNow = {};
      for (const [n, t] of Object.entries(extras)) {
        const h = hash(t);
        if (extrasPrev[n] !== h || opts.force) {
          await writeText(dir, n, t);
          written++;
        }
        extrasNow[n] = h;
      }
      for (const n of Object.keys(extrasPrev))
        if (!(n in extras)) {
          await removeFile(dir, n);
          removed++;
        }
      const state = {
        folderName: dir.name,
        files,
        extras: extrasNow,
        lastSync: Date.now(),
        count: entries.length,
        needsPermission: false,
        error: null
      };
      await store.set({ [STATE_KEY]: state });
      return { ok: true, written, removed, total: entries.length, folder: dir.name };
    };
    try {
      return await (navigator.locks ? navigator.locks.request('ytct-sync', run) : run());
    } catch (e) {
      const cur = (await store.get([STATE_KEY]))[STATE_KEY] || {};
      await store.set({ [STATE_KEY]: { ...cur, folderName: dir.name, error: String((e && e.message) || e) } });
      return { ok: false, reason: 'error', error: String((e && e.message) || e), folder: dir.name };
    }
  }

  root.YTCTSync = { getFolder, setFolder, permission, syncNow, STATE_KEY, entryOf, baseName };
})(typeof globalThis !== 'undefined' ? globalThis : this);
