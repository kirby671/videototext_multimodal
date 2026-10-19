#!/usr/bin/env node
// Builds the Chrome Web Store package:
//   dist/<name>-<version>/      unpacked build (load it from chrome://extensions to test exactly what ships)
//   dist/<name>-<version>.zip   the file to upload
// Steps: copy the shipped files, strip dev-only code and permissions, check every file reference,
// refuse to build if anything looks like a credential or personal data, then zip.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SHIP,
  collectReferences,
  findSecrets,
  missingReferences,
  reservedName,
  storeManifest,
  stripDevOnly
} from './lib/build-steps.mjs';
import { createZip } from './lib/zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEXT = /\.(js|mjs|json|html|css|md|txt)$/i;

function walk(dir, base = dir) {
  return readdirSync(dir).flatMap((name) => {
    const abs = path.join(dir, name);
    if (name.startsWith('.')) return []; // .DS_Store and friends never ship
    return statSync(abs).isDirectory() ? walk(abs, base) : [path.relative(base, abs).split(path.sep).join('/')];
  });
}

function fail(title, lines) {
  console.error(`\n✖ ${title}`);
  for (const l of lines) console.error(`  ${l}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const slug = (manifest.short_name || manifest.name)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '');
const name = `${slug}-${manifest.version}`;
const outDir = path.join(ROOT, 'dist', name);

// 1. Copy what ships
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
for (const entry of SHIP) cpSync(path.join(ROOT, entry), path.join(outDir, entry), { recursive: true });
const files = walk(outDir);

// 2. Strip dev-only code, and the permissions only it needed
let stripped = 0;
for (const rel of files.filter((f) => f.endsWith('.js'))) {
  const abs = path.join(outDir, rel);
  const { code, removed } = stripDevOnly(readFileSync(abs, 'utf8'), rel);
  if (removed) writeFileSync(abs, code);
  stripped += removed;
}
const shipped = storeManifest(manifest);
writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(shipped, null, 2) + '\n');

const texts = files
  .filter((f) => TEXT.test(f))
  .map((rel) => ({ rel, text: readFileSync(path.join(outDir, rel), 'utf8') }));
const appCode = texts.filter((t) => t.rel.startsWith('src/'));
const dropped = manifest.permissions.filter((p) => !shipped.permissions.includes(p));
for (const p of dropped) {
  const users = appCode.filter((t) => t.text.includes(`chrome.${p}.`)).map((t) => t.rel);
  if (users.length) fail(`"${p}" is dev-only but still used after stripping`, users);
}

// 3. Every reference resolves, and no reserved file names
const missing = missingReferences(collectReferences(shipped, texts), outDir);
if (missing.length)
  fail(
    'Broken file references',
    missing.map((r) => `${r.from}: ${r.ref}`)
  );
const reserved = files.filter(reservedName);
if (reserved.length) fail('File names starting with "_" are reserved by Chrome', reserved);

// 4. No credentials or personal data (the bundled third-party library is minified, so it's scanned too)
const leaks = texts.flatMap(({ rel, text }) => findSecrets(text).map((h) => `${rel}:${h.line}  ${h.kind}: ${h.match}`));
if (leaks.length) fail('Possible credentials or personal data — remove them before publishing', leaks);

// 5. Zip
const zipPath = path.join(ROOT, 'dist', `${name}.zip`);
const zip = createZip(files.map((rel) => ({ name: rel, data: readFileSync(path.join(outDir, rel)) })));
writeFileSync(zipPath, zip);

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`✔ ${manifest.name} v${manifest.version}`);
console.log(`  files            ${files.length}`);
console.log(
  `  dev-only blocks  ${stripped} removed${dropped.length ? `, permissions dropped: ${dropped.join(', ')}` : ''}`
);
console.log(`  references       all resolve`);
console.log(`  secret scan      clean`);
console.log(`  package          ${path.relative(ROOT, zipPath)} (${kb(zip.length)})`);
