/*
 * Library: every transcript you've fetched on YouTube or pasted, with its analysis.
 * Records live in chrome.storage.local under "cache:<videoId>" or "cache:paste-<hash>" (see src/ui/panel.js).
 */
(() => {
  'use strict';
  const PREFIX = 'cache:';
  const $ = (id) => document.getElementById(id);
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const theme = () => document.documentElement.toggleAttribute('dark', mq.matches);
  theme();
  mq.addEventListener('change', theme);

  let entries = [];
  let selected = null;
  let query = '';
  let deletedKey = null;
  let picking = false; // "Choose…" mode: clicking a transcript ticks it
  const picked = new Set();

  const viewer = YTCTPanel.createPanel({
    kind: 'library',
    seek: (t) => {
      const e = entries.find((x) => x.key === selected);
      if (e && e.videoId && Number.isFinite(t))
        window.open(
          'https://www.youtube.com/watch?v=' + encodeURIComponent(e.videoId) + '&t=' + Math.max(0, Math.floor(t)) + 's',
          '_blank',
          'noopener'
        );
    }
  });
  $('mount').append(viewer.host);

  // ---------- data ----------
  const wordsIn = (s) => (String(s || '').match(/\S+/g) || []).length;
  const isVideoId = (v) => /^[\w-]{11}$/.test(String(v || ''));
  function toEntry(key, rec) {
    const meta = rec.meta || {};
    const kind = rec.kind || (key.startsWith(PREFIX + 'paste-') ? 'paste' : 'youtube');
    const videoId = rec.videoId || meta.videoId || (kind === 'youtube' ? key.slice(PREFIX.length) : null);
    const segs = (rec.items || []).filter((i) => i && i.type !== 'chapter');
    const A = rec.analysis || null;
    return {
      key,
      rec,
      kind,
      videoId: isVideoId(videoId) ? videoId : null,
      title: String(meta.title || (kind === 'paste' ? 'Pasted transcript' : 'Untitled video')).trim(),
      channel: String(meta.channel || '').trim(),
      created: rec.createdAt || rec.savedAt || 0,
      published: (() => {
        const p = YTCTTrends.parseDay(meta.publishDate);
        return Number.isFinite(p) ? p : 0;
      })(),
      updated: rec.savedAt || rec.createdAt || 0,
      seconds: Number(meta.lengthSeconds) || (segs.length && segs[segs.length - 1].start) || 0,
      words: rec.words || segs.reduce((n, s) => n + wordsIn(s.text), 0),
      analyzed: !!A,
      distilled: !!(rec.distilled && rec.distilled.covered && rec.distilled.covered.length),
      pasted: kind === 'paste' || rec.source === 'pasted text',
      cost: rec.costTotal || 0,
      _hay: null,
      _text: null
    };
  }
  // Searchable text, built the first time a search needs it.
  function hay(e) {
    if (e._hay == null) {
      const A = e.rec.analysis || {};
      e._text = (e.rec.items || [])
        .filter((i) => i && i.text)
        .map((i) => i.text)
        .join(' ')
        .replace(/\s+/g, ' ');
      const extra = [
        A.summary,
        ...(A.themes || []).map((t) => t.theme + ' ' + (t.context || '')),
        ...(A.concepts || []).map((c) => c.concept),
        ...(A.companies || []).map((c) => c.name),
        ...(e.rec.speakers || []).map((s) => s.name)
      ]
        .filter(Boolean)
        .join(' ');
      e._hay = (e.title + ' \n ' + e.channel + ' \n ' + extra + ' \n ' + e._text).toLowerCase();
    }
    return e._hay;
  }

  async function loadAll() {
    let all = {};
    try {
      all = await chrome.storage.local.get(null);
    } catch (e) {
      all = {};
    }
    entries = Object.keys(all)
      .filter((k) => k.startsWith(PREFIX) && all[k] && Array.isArray(all[k].items))
      .map((k) => toEntry(k, all[k]));
  }

  // ---------- formatting ----------
  const money = (c) =>
    c >= 1 ? '$' + c.toFixed(2) : c >= 0.01 ? '$' + c.toFixed(3) : c > 0 ? '$' + c.toFixed(4) : '$0';
  const dur = (s) => {
    s = Math.round(s || 0);
    if (!s) return '';
    const h = Math.floor(s / 3600),
      m = Math.round((s % 3600) / 60);
    return h ? h + ' h ' + String(m).padStart(2, '0') + ' min' : Math.max(1, m) + ' min';
  };
  function shortDate(t) {
    if (!t) return '';
    const d = new Date(t),
      now = new Date();
    return d.toLocaleDateString(
      undefined,
      d.getFullYear() === now.getFullYear()
        ? { month: 'short', day: 'numeric' }
        : { month: 'short', day: 'numeric', year: 'numeric' }
    );
  }
  const longDate = (t) =>
    t ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  // Text with the search words highlighted.
  function marked(text, words) {
    const frag = document.createDocumentFragment();
    if (!words.length) {
      frag.append(text);
      return frag;
    }
    const re = new RegExp('(' + words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
    let last = 0;
    String(text).replace(re, (m, _g, i) => {
      frag.append(text.slice(last, i), el('mark', null, m));
      last = i + m.length;
      return m;
    });
    frag.append(text.slice(last));
    return frag;
  }

  // ---------- list ----------
  const words = () => query.toLowerCase().split(/\s+/).filter(Boolean);
  function visible() {
    const w = words();
    const list = w.length
      ? entries.filter((e) => {
          const h = hay(e);
          return w.every((x) => h.includes(x));
        })
      : entries.slice();
    const by = $('sort').value;
    const cmp =
      {
        new: (a, b) => b.created - a.created,
        old: (a, b) => a.created - b.created,
        updated: (a, b) => b.updated - a.updated,
        title: (a, b) => a.title.localeCompare(b.title),
        long: (a, b) => b.words - a.words
      }[by] || ((a, b) => b.created - a.created);
    return list.sort(cmp);
  }
  function snippetFor(e, w) {
    if (!w.length) return null;
    const head = (e.title + ' ' + e.channel).toLowerCase();
    if (w.every((x) => head.includes(x))) return null;
    hay(e);
    const text = e._text || '';
    const low = text.toLowerCase();
    const hit = w
      .map((x) => low.indexOf(x))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)[0];
    if (hit == null) return null;
    let a = Math.max(0, hit - 60),
      b = Math.min(text.length, hit + 110);
    if (a > 0) a = text.indexOf(' ', a) + 1 || a;
    if (b < text.length) b = text.lastIndexOf(' ', b) > hit ? text.lastIndexOf(' ', b) : b;
    return (a > 0 ? '…' : '') + text.slice(a, b).trim() + (b < text.length ? '…' : '');
  }

  function renderList() {
    const list = $('list');
    const shown = visible();
    const w = words();
    list.textContent = '';
    const analyzed = entries.filter((e) => e.analyzed).length;
    $('count').textContent = entries.length
      ? entries.length +
        ' transcript' +
        (entries.length === 1 ? '' : 's') +
        (analyzed ? ' · ' + analyzed + ' analyzed' : '') +
        (w.length ? ' · ' + shown.length + ' match' + (shown.length === 1 ? '' : 'es') : '')
      : '';
    list.classList.toggle('picking', picking);
    list.setAttribute('role', picking ? 'group' : 'listbox');
    updateDownloadButtons(shown);
    if (!entries.length) {
      list.append(el('li', 'listnote', 'Nothing saved yet.'));
      return;
    }
    if (!shown.length) {
      list.append(el('li', 'listnote', 'No transcripts match “' + query.trim() + '”.'));
      return;
    }
    for (const e of shown) {
      const li = el('li');
      li.setAttribute('role', 'presentation');
      const b = el('button', 'item');
      b.type = 'button';
      b.dataset.key = e.key;
      if (picking) {
        b.setAttribute('role', 'checkbox');
        b.setAttribute('aria-checked', String(picked.has(e.key)));
        b.tabIndex = 0;
      } else {
        b.setAttribute('role', 'option');
        b.setAttribute('aria-selected', String(e.key === selected));
        b.tabIndex = e.key === selected || (!selected && e === shown[0]) ? 0 : -1;
      }
      const ck = el('span', 'ck', '✓');
      ck.setAttribute('aria-hidden', 'true');
      b.append(ck);
      const th = el('div', 'thumb');
      if (e.videoId) {
        const img = el('img');
        img.loading = 'lazy';
        img.alt = '';
        img.src = 'https://i.ytimg.com/vi/' + e.videoId + '/mqdefault.jpg';
        img.onerror = () => {
          img.remove();
          th.textContent = '▶';
        };
        th.append(img);
      } else th.textContent = '¶';
      const tx = el('div', 'txt');
      const t = el('div', 't');
      t.append(marked(e.title, w));
      tx.append(t);
      tx.append(el('div', 'm', [e.channel, shortDate(e.created), dur(e.seconds)].filter(Boolean).join(' · ')));
      const tags = el('div', 'tags');
      if (e.analyzed) tags.append(el('span', 'tag on', 'Analyzed'));
      if (e.distilled) tags.append(el('span', 'tag on', 'Distilled'));
      if (e.pasted) tags.append(el('span', 'tag', 'Pasted'));
      tags.append(el('span', 'tag', e.words.toLocaleString() + ' words'));
      tx.append(tags);
      b.append(th, tx);
      const sn = snippetFor(e, w);
      if (sn) {
        const s = el('div', 'snip');
        s.append(marked(sn, w));
        b.append(s);
      }
      li.append(b);
      list.append(li);
    }
  }

  function markSelected() {
    if (picking) return;
    $('list')
      .querySelectorAll('.item')
      .forEach((b) => {
        const on = b.dataset.key === selected;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
      });
  }

  // ---------- download as Markdown ----------
  const DL_DEFAULTS = { transcript: true, insights: true, companies: true, version: 'distilled', fmt: 'one' };
  function dlOptions() {
    let o = { ...DL_DEFAULTS };
    try {
      o = { ...o, ...JSON.parse(localStorage.getItem('ytct-dl') || '{}') };
    } catch (e) {
      /* ignore */
    }
    return o;
  }
  function showDlOptions() {
    const o = dlOptions();
    $('oTranscript').checked = !!o.transcript;
    $('oInsights').checked = !!o.insights;
    $('oCompanies').checked = !!o.companies;
    document.querySelector(
      'input[name="oVer"][value="' + (o.version === 'clean' ? 'clean' : 'distilled') + '"]'
    ).checked = true;
    document.querySelector('input[name="oFmt"][value="' + (o.fmt === 'zip' ? 'zip' : 'one') + '"]').checked = true;
  }
  function saveDlOptions() {
    const o = {
      transcript: $('oTranscript').checked,
      insights: $('oInsights').checked,
      companies: $('oCompanies').checked,
      version: document.querySelector('input[name="oVer"]:checked').value,
      fmt: document.querySelector('input[name="oFmt"]:checked').value
    };
    try {
      localStorage.setItem('ytct-dl', JSON.stringify(o));
    } catch (e) {
      /* ignore */
    }
    renderList();
  }
  showDlOptions();
  $('dlOpts').addEventListener('change', saveDlOptions);
  $('dlOptsBtn').addEventListener('click', () => {
    const open = $('dlOpts').hidden;
    $('dlOpts').hidden = !open;
    $('dlOptsBtn').setAttribute('aria-expanded', String(open));
  });

  function updateDownloadButtons(shown) {
    const n = shown.length,
      filtered = !!words().length;
    $('dlAll').textContent = n ? (filtered ? 'Download these ' + n : 'Download all ' + n) : 'Download all';
    $('dlAll').disabled = !n || picking;
    $('dlPick').disabled = !n || picking;
    $('selbar').hidden = !picking;
    $('selCount').textContent = picked.size + ' selected';
    $('selGo').textContent = picked.size ? 'Download ' + picked.size : 'Download';
    $('selGo').disabled = !picked.size;
  }
  function setPicking(on) {
    picking = on;
    if (!on) picked.clear();
    renderList();
    if (on) {
      const first = $('list').querySelector('.item');
      if (first) first.focus();
    }
  }
  async function download(list) {
    const o = dlOptions();
    if (!list.length) {
      say('Nothing to download.');
      return false;
    }
    if (!o.transcript && !o.insights && !o.companies) {
      say('Pick at least one of transcripts, insights or companies in Options.');
      $('dlOpts').hidden = false;
      $('dlOptsBtn').setAttribute('aria-expanded', 'true');
      return false;
    }
    let clean = { removeFillers: true, removeTags: true };
    try {
      clean = await chrome.storage.local.get(clean);
    } catch (e) {
      /* defaults */
    }
    let out;
    try {
      out = YTCTExport.build(list, { ...o, zip: o.fmt === 'zip' }, clean);
    } catch (e) {
      say('Couldn’t build the download: ' + e.message);
      return false;
    }
    const url = URL.createObjectURL(out.blob);
    const a = el('a');
    a.href = url;
    a.download = out.filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    say('Downloaded ' + list.length + ' transcript' + (list.length === 1 ? '' : 's') + ' as “' + out.filename + '”.');
    return true;
  }
  $('dlAll').addEventListener('click', () => download(visible()));
  $('dlPick').addEventListener('click', () => setPicking(true));
  $('selCancel').addEventListener('click', () => setPicking(false));
  $('selAll').addEventListener('click', () => {
    visible().forEach((e) => picked.add(e.key));
    renderList();
  });
  $('selNone').addEventListener('click', () => {
    picked.clear();
    renderList();
  });
  $('selGo').addEventListener('click', async () => {
    const list = visible().filter((e) => picked.has(e.key));
    // anything ticked but hidden by the current search still counts
    entries.filter((e) => picked.has(e.key) && !list.includes(e)).forEach((e) => list.push(e));
    if (await download(list)) setPicking(false);
  });

  // ---------- viewer ----------
  function emptyViewer() {
    $('vbody').hidden = true;
    const box = $('vempty');
    box.hidden = false;
    box.textContent = '';
    if (entries.length) {
      box.append(el('b', null, 'Pick a transcript'));
      box.append(
        'Everything you’ve fetched on YouTube or pasted is kept here, with its analysis. Search finds words anywhere in a transcript.'
      );
    } else {
      box.append(el('b', null, 'Nothing here yet'));
      box.append(
        'Transcripts you get on YouTube (“Get transcript”) or paste in are saved here automatically, with any analysis you run on them.'
      );
    }
  }
  function headFor(e) {
    $('vtitle').textContent = e.title;
    const bits = [e.channel, 'Added ' + longDate(e.created), dur(e.seconds), e.words.toLocaleString() + ' words'];
    if (e.cost) bits.push('Claude cost about ' + money(e.cost));
    $('vmeta').textContent = bits.filter(Boolean).join(' · ');
    const open = $('vopen');
    open.hidden = !e.videoId;
    if (e.videoId) open.href = 'https://www.youtube.com/watch?v=' + encodeURIComponent(e.videoId);
  }
  async function select(key, opts) {
    opts = opts || {};
    const e = entries.find((x) => x.key === key);
    if (!e) {
      selected = null;
      renderList();
      emptyViewer();
      return;
    }
    selected = key;
    try {
      history.replaceState(null, '', '#' + encodeURIComponent(key));
    } catch (err) {
      /* ignore */
    }
    $('vconfirm').hidden = true;
    $('vdel').hidden = false;
    $('vempty').hidden = true;
    $('vbody').hidden = false;
    headFor(e);
    document.body.classList.add('detail');
    markSelected();
    const b = $('list').querySelector('[data-key="' + CSS.escape(key) + '"]');
    if (b) {
      b.scrollIntoView({ block: 'nearest' });
      if (opts.focus !== false) b.focus({ preventScroll: true });
    }
    $('vbody').closest('main').scrollTop = 0;
    await viewer.openSaved(key);
  }

  // ---------- events ----------
  let qTimer = null;
  $('q').addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      query = $('q').value;
      renderList();
    }, 120);
  });
  $('sort').addEventListener('change', () => {
    try {
      localStorage.setItem('ytct-lib-sort', $('sort').value);
    } catch (e) {
      /* ignore */
    }
    renderList();
  });
  try {
    const s = localStorage.getItem('ytct-lib-sort');
    if (s && $('sort').querySelector('option[value="' + s + '"]')) $('sort').value = s;
  } catch (e) {
    /* ignore */
  }

  $('list').addEventListener('click', (ev) => {
    const b = ev.target.closest('.item');
    if (!b) return;
    if (picking) {
      const k = b.dataset.key;
      if (picked.has(k)) picked.delete(k);
      else picked.add(k);
      b.setAttribute('aria-checked', String(picked.has(k)));
      updateDownloadButtons(visible());
      return;
    }
    select(b.dataset.key);
  });
  $('list').addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && picking) {
      setPicking(false);
      return;
    }
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    const items = Array.from($('list').querySelectorAll('.item'));
    const i = items.indexOf(document.activeElement);
    const next = items[Math.min(items.length - 1, Math.max(0, i + (ev.key === 'ArrowDown' ? 1 : -1)))];
    if (next) {
      ev.preventDefault();
      if (picking) next.focus();
      else select(next.dataset.key);
    }
  });
  $('back').addEventListener('click', () => {
    document.body.classList.remove('detail');
  });

  $('vdel').addEventListener('click', () => {
    $('vdel').hidden = true;
    $('vconfirm').hidden = false;
    $('vdelno').focus();
  });
  $('vdelno').addEventListener('click', () => {
    $('vconfirm').hidden = true;
    $('vdel').hidden = false;
  });
  $('vdelyes').addEventListener('click', async () => {
    const key = selected;
    if (!key) return;
    const order = visible().map((e) => e.key);
    const next = order[order.indexOf(key) + 1] || order[order.indexOf(key) - 1] || null;
    deletedKey = key;
    await chrome.storage.local.remove(key);
    entries = entries.filter((e) => e.key !== key);
    say('Deleted “' + ($('vtitle').textContent || 'transcript') + '”.');
    if (next) select(next);
    else {
      selected = null;
      history.replaceState(null, '', location.pathname);
      renderList();
      emptyViewer();
      document.body.classList.remove('detail');
    }
  });

  function say(t) {
    $('msg').textContent = t || '';
  }

  // Backup: one JSON file with every record, which "Import backup" reads back.
  $('export').addEventListener('click', async () => {
    const all = await chrome.storage.local.get(null);
    const recs = {};
    for (const k of Object.keys(all))
      if (k.startsWith(PREFIX) && all[k] && Array.isArray(all[k].items)) recs[k] = all[k];
    const n = Object.keys(recs).length;
    if (!n) {
      say('Nothing to export yet.');
      return;
    }
    const net = {};
    for (const k of Object.keys(all)) if (k.startsWith('net:')) net[k] = all[k];
    const blob = new Blob(
      [
        JSON.stringify({
          app: 'clean-transcript-library',
          version: 1,
          exportedAt: new Date().toISOString(),
          entries: recs,
          trendReport: all['trends:report'] || null,
          network: net
        })
      ],
      { type: 'application/json' }
    );
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    const d = new Date();
    a.download =
      'clean-transcript-library-' +
      d.getFullYear() +
      '-' +
      String(d.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(d.getDate()).padStart(2, '0') +
      '.json';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    say('Exported ' + n + ' transcript' + (n === 1 ? '' : 's') + '.');
  });
  $('import').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', async () => {
    const f = $('file').files && $('file').files[0];
    $('file').value = '';
    if (!f) return;
    let data;
    try {
      data = JSON.parse(await f.text());
    } catch (e) {
      say('That file isn’t a Library backup (it couldn’t be read as JSON).');
      return;
    }
    const src =
      data && typeof data === 'object' ? (data.entries && typeof data.entries === 'object' ? data.entries : data) : {};
    const keys = Object.keys(src).filter((k) => k.startsWith(PREFIX) && src[k] && Array.isArray(src[k].items));
    if (!keys.length) {
      say('No transcripts found in that file.');
      return;
    }
    const have = await chrome.storage.local.get(keys);
    const write = {};
    let same = 0;
    for (const k of keys) {
      if (have[k] && (have[k].savedAt || 0) >= (src[k].savedAt || 0)) {
        same++;
        continue;
      }
      write[k] = src[k];
    }
    if (data && data.network && typeof data.network === 'object') {
      const keys2 = Object.keys(data.network).filter((k) => k.startsWith('net:'));
      const cur = await chrome.storage.local.get(keys2);
      for (const k of keys2) {
        const a = cur[k],
          b = data.network[k];
        if (!a || (b && (b.builtAt || b.at || 0) > (a.builtAt || a.at || 0))) write[k] = b;
      }
    }
    if (data && data.trendReport && data.trendReport.result) {
      const cur = (await chrome.storage.local.get('trends:report'))['trends:report'];
      if (!cur || (cur.createdAt || 0) < (data.trendReport.createdAt || 0)) write['trends:report'] = data.trendReport;
    }
    try {
      if (Object.keys(write).length) await chrome.storage.local.set(write);
    } catch (e) {
      say('Couldn’t import: ' + e.message);
      return;
    }
    const n = Object.keys(write).filter((k) => k.startsWith(PREFIX)).length;
    say(
      'Imported ' + n + ' transcript' + (n === 1 ? '' : 's') + (same ? '; ' + same + ' already up to date' : '') + '.'
    );
    await refresh();
  });

  // ---------- views: Transcripts | Trends ----------
  let view = 'list';
  const trends = YTCTTrends.mount($('trends'), {
    getEntries: () => entries,
    openEntry: (key) => {
      setView('list');
      select(key);
    },
    refresh: () => refresh(),
    // Analyze one saved transcript with the usual single Claude call (via the viewer), and report how it went.
    analyzeEntry: async (key) => {
      if (!(await viewer.openSaved(key))) return { ok: false, message: 'It isn’t in your Library any more.' };
      selected = key;
      const e = entries.find((x) => x.key === key);
      if (e) headFor(e);
      await viewer.analyze();
      for (let i = 0; i < 20; i++) {
        const rec = (await chrome.storage.local.get(key))[key];
        if (rec && rec.analysis) return { ok: true };
        await new Promise((r) => setTimeout(r, 150));
      }
      const st = viewer.host.shadowRoot && viewer.host.shadowRoot.querySelector('.status');
      return { ok: false, message: (st && st.textContent) || 'Claude didn’t return an analysis.' };
    }
  });
  const network = YTCTNetwork.mount($('network'), {
    getEntries: () => entries,
    openEntry: (key) => {
      setView('list');
      select(key);
    }
  });
  const VIEWS = ['list', 'trends', 'network'];
  function setView(v) {
    view = VIEWS.includes(v) ? v : 'list';
    $('trends').hidden = view !== 'trends';
    $('network').hidden = view !== 'network';
    $('listView').hidden = view !== 'list';
    $('tabList').setAttribute('aria-selected', String(view === 'list'));
    $('tabTrends').setAttribute('aria-selected', String(view === 'trends'));
    $('tabNetwork').setAttribute('aria-selected', String(view === 'network'));
    if (view === 'trends') trends.show();
    else trends.hide();
    if (view === 'network') network.show();
    else network.hide();
    try {
      history.replaceState(
        null,
        '',
        view !== 'list' ? '#' + view : selected ? '#' + encodeURIComponent(selected) : location.pathname
      );
    } catch (e) {
      /* ignore */
    }
  }
  document.querySelector('.views').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-view]');
    if (b) setView(b.dataset.view);
  });
  document.querySelector('.views').addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    ev.preventDefault();
    const i = (VIEWS.indexOf(view) + (ev.key === 'ArrowRight' ? 1 : VIEWS.length - 1)) % VIEWS.length;
    setView(VIEWS[i]);
    $({ list: 'tabList', trends: 'tabTrends', network: 'tabNetwork' }[view]).focus();
  });

  // Just updated itself? Say so for a few minutes.
  chrome.storage.local.get('updateNote', ({ updateNote }) => {
    if (updateNote && updateNote.to && Date.now() - updateNote.at < 10 * 60000) {
      $('upd').textContent = 'Updated to v' + updateNote.to;
      $('upd').hidden = false;
    }
  });

  // ---------- sync to a folder, for Claude ----------
  const syncStore = { get: (k) => chrome.storage.local.get(k), set: (o) => chrome.storage.local.set(o) };
  let syncBusy = false;
  const timeOf = (t) =>
    new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) +
    (new Date(t).toDateString() === new Date().toDateString()
      ? ''
      : ', ' + new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
  async function renderSync(msg, kind) {
    const folder = await YTCTSync.getFolder();
    const st = (await chrome.storage.local.get(YTCTSync.STATE_KEY))[YTCTSync.STATE_KEY] || {};
    let perm = 'denied';
    if (folder) {
      try {
        perm = await YTCTSync.permission(folder, false);
      } catch (e) {
        perm = 'denied';
      }
    }
    const on = !!folder,
      needs = on && perm !== 'granted';
    $('syncChoose').hidden = on;
    $('syncResume').hidden = !needs;
    $('syncNow').hidden = !on || needs;
    $('syncChange').hidden = !on;
    $('syncStop').hidden = !on;
    const stat = $('syncStat');
    stat.dataset.kind = kind || (needs || st.error ? 'error' : '');
    stat.textContent =
      msg ||
      (!on
        ? 'Keep your Library as files Claude can read.'
        : needs
          ? 'Paused: Chrome needs your OK to keep writing to “' + folder.name + '”.'
          : st.error
            ? 'Couldn’t write to “' + folder.name + '”: ' + st.error
            : st.lastSync
              ? 'Synced to “' +
                folder.name +
                '” · ' +
                st.count +
                ' transcript' +
                (st.count === 1 ? '' : 's') +
                ' · ' +
                timeOf(st.lastSync)
              : 'Folder: “' + folder.name + '”');
  }
  async function runSync(opts) {
    if (syncBusy) return;
    syncBusy = true;
    renderSync('Syncing…', 'work');
    let r;
    try {
      r = await YTCTSync.syncNow(syncStore, opts || {});
    } catch (e) {
      r = { ok: false, reason: 'error', error: e.message };
    }
    syncBusy = false;
    if (r.ok) renderSync();
    else if (r.reason === 'permission') renderSync();
    else if (r.reason === 'nofolder') renderSync();
    else renderSync('Couldn’t sync: ' + (r.error || 'unknown error'), 'error');
    return r;
  }
  $('syncChoose').addEventListener('click', chooseFolder);
  $('syncChange').addEventListener('click', chooseFolder);
  async function chooseFolder() {
    if (!window.showDirectoryPicker) {
      renderSync('This version of Chrome can’t write to a folder.', 'error');
      return;
    }
    let h;
    try {
      h = await window.showDirectoryPicker({ id: 'ytct-library', mode: 'readwrite', startIn: 'documents' });
    } catch (e) {
      return;
    } // cancelled
    await YTCTSync.setFolder(h);
    // a new folder starts fresh (the old one is left as it is)
    await chrome.storage.local.set({
      syncEnabled: true,
      [YTCTSync.STATE_KEY]: { folderName: h.name, files: {}, extras: {} }
    });
    const r = await runSync({ ask: true });
    if (r && r.ok)
      say(
        'Your Library is now in “' +
          r.folder +
          '”. Add that folder to a chat in the Claude desktop app to ask Claude about it.'
      );
  }
  $('syncResume').addEventListener('click', () => runSync({ ask: true }));
  $('syncNow').addEventListener('click', () => runSync({ ask: true, force: true }));
  $('syncStop').addEventListener('click', async () => {
    await YTCTSync.setFolder(null);
    await chrome.storage.local.set({ syncEnabled: false });
    await chrome.storage.local.remove(YTCTSync.STATE_KEY);
    renderSync();
    say('Stopped syncing. The files already in the folder are left there.');
  });
  let syncTimer = null;
  const syncSoon = () => {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(async () => {
      const f = await YTCTSync.getFolder();
      if (f) runSync({ ask: false });
    }, 2500);
  };
  (async () => {
    const f = await YTCTSync.getFolder();
    if (f) runSync({ ask: false });
    else renderSync();
  })();

  // Another tab (YouTube, the paste page) saved or removed something: refresh the list.
  let rTimer = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (YTCTSync.STATE_KEY in changes && !syncBusy) renderSync(); // the background sync finished
    if (!Object.keys(changes).some((k) => k.startsWith(PREFIX) || k === 'trends:report' || k === 'net:graph')) return;
    syncSoon();
    clearTimeout(rTimer);
    rTimer = setTimeout(refresh, 250);
  });
  async function refresh() {
    await loadAll();
    const cur = selected && entries.find((e) => e.key === selected);
    if (selected && !cur && selected !== deletedKey) {
      selected = null;
      emptyViewer();
    } else if (cur) headFor(cur);
    renderList();
    if (!selected) emptyViewer();
    trends.update();
    network.update();
  }

  window.addEventListener('hashchange', () => {
    const k = decodeURIComponent(location.hash.slice(1));
    if (k === 'trends' || k === 'network') {
      if (view !== k) setView(k);
      return;
    }
    if (k && view !== 'list') setView('list');
    if (k && k !== selected) {
      if (entries.some((e) => e.key === k)) select(k);
      else refresh().then(() => select(k));
    }
  });

  (async () => {
    await loadAll();
    renderList();
    const k = decodeURIComponent(location.hash.slice(1));
    if (k === 'trends' || k === 'network') {
      emptyViewer();
      setView(k);
      return;
    }
    if (k && entries.some((e) => e.key === k)) select(k, { focus: false });
    else emptyViewer();
    if (!k) $('q').focus();
  })();
})();
