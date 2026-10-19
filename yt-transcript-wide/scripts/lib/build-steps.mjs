// Pure build steps, kept separate from scripts/build.mjs so they can be unit-tested.
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Files and folders that make up the extension. Everything else in the repo is tooling or docs. */
export const SHIP = ['manifest.json', 'icons', 'src', 'vendor'];

/** Permissions only the dev-only code needs; dropped from store builds. */
export const DEV_ONLY_PERMISSIONS = ['alarms'];

const DEV_START = /^[ \t]*\/\/ #region dev-only\b.*$/gm;
const DEV_END = /^[ \t]*\/\/ #endregion dev-only\b.*$/gm;
const DEV_BLOCK = /^[ \t]*\/\/ #region dev-only\b[^\n]*\n[\s\S]*?^[ \t]*\/\/ #endregion dev-only\b[^\n]*(?:\n|$)/gm;

/**
 * Remove `// #region dev-only` … `// #endregion dev-only` blocks (code that only makes sense for an
 * unpacked development install, such as reloading itself when files change on disk).
 * @returns {{ code: string, removed: number }}
 */
export function stripDevOnly(code, file = 'file') {
  const starts = (code.match(DEV_START) || []).length;
  const ends = (code.match(DEV_END) || []).length;
  if (starts !== ends) throw new Error(`${file}: unbalanced dev-only regions (${starts} start, ${ends} end)`);
  const out = code.replace(DEV_BLOCK, '');
  return { code: out, removed: starts };
}

/** The manifest for the Web Store: same as the dev one, minus dev-only permissions. */
export function storeManifest(manifest) {
  const m = structuredClone(manifest);
  m.permissions = (m.permissions || []).filter((p) => !DEV_ONLY_PERMISSIONS.includes(p));
  return m;
}

const SECRET_PATTERNS = [
  ['Anthropic API key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI API key', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Email address', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/],
  ['Local file path', /\/Users\/[A-Za-z0-9._-]+\/|\/home\/[A-Za-z0-9._-]+\/|[A-Z]:\\Users\\/]
];

/**
 * Look for credentials and personal data that must never ship.
 * @returns {{ kind: string, line: number, match: string }[]}
 */
export function findSecrets(text) {
  const hits = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const [kind, re] of SECRET_PATTERNS) {
      const m = line.match(re);
      if (m) hits.push({ kind, line: i + 1, match: m[0].length > 24 ? m[0].slice(0, 12) + '…' : m[0] });
    }
  });
  return hits;
}

/** Chrome refuses to load an extension containing a file or folder whose name starts with "_". */
export function reservedName(relPath) {
  return relPath.split('/').some((part) => part.startsWith('_') && part !== '_locales');
}

const LOCAL_REF = /^(?![a-z]+:|\/\/|#|data:)[^?#]+/i;
const REPO_PATH_LITERAL = /['"`]((?:src|vendor|icons)\/[A-Za-z0-9_./-]+\.(?:html|js|css|png|json))['"`]/g;

/**
 * Every file the extension refers to: manifest entries, <script src>/<link href>/<a href> in pages,
 * and extension paths written as string literals in scripts (chrome.runtime.getURL, executeScript …).
 * @param {object} manifest
 * @param {{ rel: string, text: string }[]} files  text files, paths relative to the extension root
 * @returns {{ from: string, ref: string, resolved: string }[]}
 */
export function collectReferences(manifest, files) {
  const refs = [];
  const add = (from, ref, resolved) => refs.push({ from, ref, resolved: path.posix.normalize(resolved) });

  if (manifest.background?.service_worker)
    add('manifest.json', manifest.background.service_worker, manifest.background.service_worker);
  for (const cs of manifest.content_scripts || [])
    for (const f of [...(cs.js || []), ...(cs.css || [])]) add('manifest.json', f, f);
  if (manifest.options_page) add('manifest.json', manifest.options_page, manifest.options_page);
  if (manifest.options_ui?.page) add('manifest.json', manifest.options_ui.page, manifest.options_ui.page);
  for (const icons of [manifest.icons, manifest.action?.default_icon]) {
    for (const f of Object.values(icons || {})) add('manifest.json', f, f);
  }

  for (const { rel, text } of files) {
    if (rel.endsWith('.html')) {
      for (const m of text.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
        const local = m[1].match(LOCAL_REF);
        if (local) add(rel, m[1], path.posix.join(path.posix.dirname(rel), local[0]));
      }
    }
    if (rel.endsWith('.js')) {
      for (const m of text.matchAll(REPO_PATH_LITERAL)) add(rel, m[1], m[1]);
    }
  }
  return refs;
}

/** References that don't resolve to a file under `root`. */
export function missingReferences(refs, root) {
  return refs.filter((r) => !existsSync(path.join(root, r.resolved)));
}
