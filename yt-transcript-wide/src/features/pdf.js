/*
 * Builds simple, readable PDFs (headings, paragraphs with bold speaker names, bullets, page numbers) with pdf-lib,
 * which is bundled (vendor/pdf-lib, MIT licence) and only loaded when a PDF is asked for.
 */
(function (root) {
  'use strict';

  let loading = null;
  function loadLib() {
    if (root.PDFLib) return Promise.resolve(root.PDFLib);
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = chrome.runtime.getURL('vendor/pdf-lib/pdf-lib.min.js');
        s.onload = () => (root.PDFLib ? resolve(root.PDFLib) : reject(new Error('The PDF maker didn’t load.')));
        s.onerror = () => {
          loading = null;
          reject(new Error('The PDF maker didn’t load.'));
        };
        document.head.append(s);
      });
    }
    return loading;
  }

  // The built-in PDF fonts only cover Western European text (WinAnsi): map what we can, drop the rest.
  const WIN_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
  const SWAP = {
    '→': '->',
    '←': '<-',
    '↔': '<->',
    '↗': '^',
    '↘': 'v',
    '✦': '*',
    '≈': '~',
    '≤': '<=',
    '≥': '>=',
    '−': '-',
    '‐': '-',
    '‑': '-',
    '‒': '-',
    '′': "'",
    '″': '"',
    ' ': ' ',
    ' ': ' ',
    ' ': ' ',
    ' ': ' ',
    ' ': ' ',
    '​': '',
    '­': '',
    '\t': ' ',
    '·': '·'
  };
  function winAnsi(s) {
    let out = '';
    for (const ch of String(s == null ? '' : s)) {
      const c = ch.codePointAt(0);
      if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_EXTRA.includes(ch)) {
        out += ch;
        continue;
      }
      if (ch in SWAP) {
        out += SWAP[ch];
        continue;
      }
      if (c > 0xffff) continue; // emoji and the like
      const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
      out +=
        [...base].every((b) => {
          const k = b.codePointAt(0);
          return (k >= 0x20 && k <= 0x7e) || (k >= 0xa0 && k <= 0xff);
        }) && base
          ? base
          : '?';
    }
    return out;
  }

  /**
   * blocks: [{ t: 'title' | 'meta' | 'h2' | 'h3' | 'p' | 'li' | 'note' | 'break', text?, runs?: [{ text, b?, i? }], newPage? }]
   * Returns the PDF as a Uint8Array.
   */
  async function makePdf(blocks, info) {
    const { PDFDocument, StandardFonts, rgb } = await loadLib();
    const doc = await PDFDocument.create();
    doc.setTitle(winAnsi(info.title || 'Transcripts'));
    doc.setCreator('Clean Transcript');
    doc.setProducer('Clean Transcript');
    doc.setCreationDate(new Date());
    const F = {
      r: await doc.embedFont(StandardFonts.Helvetica),
      b: await doc.embedFont(StandardFonts.HelveticaBold),
      i: await doc.embedFont(StandardFonts.HelveticaOblique),
      bi: await doc.embedFont(StandardFonts.HelveticaBoldOblique)
    };
    const region = (() => {
      try {
        return new Intl.Locale(navigator.language).maximize().region;
      } catch (e) {
        return '';
      }
    })();
    const [PW, PH] = ['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE'].includes(region) ? [612, 792] : [595.28, 841.89];
    const M = 56,
      TOP = 58,
      BOTTOM = 62,
      W = PW - 2 * M;
    const INK = rgb(0.07, 0.07, 0.07),
      MUTED = rgb(0.38, 0.38, 0.36),
      ACCENT = rgb(0.12, 0.37, 0.75),
      RULE = rgb(0.85, 0.85, 0.82);
    const STYLE = {
      title: { size: 20, lead: 25, font: 'b', color: INK, before: 0, after: 6 },
      meta: { size: 9.5, lead: 13.5, font: 'r', color: MUTED, before: 0, after: 10 },
      h2: { size: 15, lead: 20, font: 'b', color: INK, before: 6, after: 4 },
      h3: { size: 10.5, lead: 15, font: 'b', color: ACCENT, before: 10, after: 4 },
      p: { size: 10.5, lead: 15.2, font: 'r', color: INK, before: 0, after: 7 },
      li: { size: 10.5, lead: 15.2, font: 'r', color: INK, before: 0, after: 4, indent: 14 },
      note: { size: 9.5, lead: 13.5, font: 'i', color: MUTED, before: 0, after: 8 }
    };
    let page = null,
      y = 0;
    const newPage = () => {
      page = doc.addPage([PW, PH]);
      y = PH - TOP;
    };
    newPage();
    const fontOf = (run, base) => (run.b && run.i ? F.bi : run.b ? F.b : run.i ? F.i : F[base]);

    // Lay out runs into lines that fit the width; returns [[{ text, font }]]
    function lines(runs, st, width) {
      const out = [];
      let line = [],
        lineW = 0,
        pendingSpace = null;
      const push = () => {
        out.push(line);
        line = [];
        lineW = 0;
        pendingSpace = null;
      };
      for (const run of runs) {
        const font = fontOf(run, st.font);
        for (const tok of winAnsi(run.text).split(/(\s+)/)) {
          if (!tok) continue;
          if (/^\s+$/.test(tok)) {
            if (line.length) pendingSpace = { font };
            continue;
          }
          let word = tok,
            w = font.widthOfTextAtSize(word, st.size);
          const sw = pendingSpace ? pendingSpace.font.widthOfTextAtSize(' ', st.size) : 0;
          if (line.length && lineW + sw + w > width) push();
          // a single word wider than the line: break it
          while (w > width) {
            let k = word.length - 1;
            while (k > 1 && font.widthOfTextAtSize(word.slice(0, k), st.size) > width) k--;
            if (line.length) push();
            out.push([{ text: word.slice(0, k), font }]);
            word = word.slice(k);
            w = font.widthOfTextAtSize(word, st.size);
          }
          if (line.length && pendingSpace) {
            line.push({ text: ' ', font: pendingSpace.font });
            lineW += sw;
          }
          line.push({ text: word, font });
          lineW += w;
          pendingSpace = null;
        }
      }
      if (line.length) out.push(line);
      return out;
    }
    function draw(block) {
      if (block.t === 'break') {
        if (y < PH - TOP - 1) newPage();
        return;
      }
      if (block.t === 'rule') {
        if (y - 14 < BOTTOM) newPage();
        page.drawLine({ start: { x: M, y: y - 6 }, end: { x: PW - M, y: y - 6 }, thickness: 0.6, color: RULE });
        y -= 16;
        return;
      }
      const st = STYLE[block.t] || STYLE.p;
      if (block.newPage && y < PH - TOP - 1) newPage();
      const indent = st.indent || 0;
      const runs = block.runs || [{ text: block.text || '' }];
      const ls = lines(runs, st, W - indent);
      if (!ls.length) return;
      y -= st.before;
      // keep headings with what follows, and don't leave a single line of a paragraph at the bottom
      const need = /^h|title/.test(block.t) ? st.lead + 3 * STYLE.p.lead : Math.min(ls.length, 2) * st.lead;
      if (y - need < BOTTOM) newPage();
      ls.forEach((ln, i) => {
        if (y - st.lead < BOTTOM) newPage();
        let x = M + indent;
        if (block.t === 'li' && i === 0)
          page.drawText('•', { x: M + 3, y: y - st.size, size: st.size, font: F.r, color: MUTED });
        // draw consecutive pieces in the same font together
        let buf = '',
          bufFont = null,
          bufX = x;
        const flush = () => {
          if (buf) page.drawText(buf, { x: bufX, y: y - st.size, size: st.size, font: bufFont, color: st.color });
        };
        for (const piece of ln) {
          if (piece.font !== bufFont) {
            flush();
            bufFont = piece.font;
            buf = '';
            bufX = x;
          }
          buf += piece.text;
          x += piece.font.widthOfTextAtSize(piece.text, st.size);
        }
        flush();
        y -= st.lead;
      });
      y -= st.after;
    }
    for (const b of blocks) draw(b);

    // footer: title and page numbers
    const pages = doc.getPages();
    const foot = winAnsi(info.footer || info.title || '');
    pages.forEach((p, i) => {
      const num = i + 1 + ' of ' + pages.length;
      const nw = F.r.widthOfTextAtSize(num, 8);
      let t = foot;
      while (t && F.r.widthOfTextAtSize(t, 8) > W - nw - 24) t = t.slice(0, -2);
      if (t !== foot) t = t.replace(/\s*\S?$/, '') + '…';
      p.drawText(t, { x: M, y: 30, size: 8, font: F.r, color: MUTED });
      p.drawText(num, { x: PW - M - nw, y: 30, size: 8, font: F.r, color: MUTED });
    });
    return doc.save();
  }

  function downloadPdf(bytes, filename) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  root.YTCTPdf = { makePdf, downloadPdf, winAnsi };
})(typeof globalThis !== 'undefined' ? globalThis : this);
