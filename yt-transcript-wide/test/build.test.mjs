import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectReferences,
  findSecrets,
  missingReferences,
  reservedName,
  storeManifest,
  stripDevOnly
} from '../scripts/lib/build-steps.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

function sourceFiles(dir) {
  return readdirSync(path.join(ROOT, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    return statSync(path.join(ROOT, rel)).isDirectory() ? sourceFiles(rel) : [rel];
  });
}

test('stripDevOnly removes marked regions and nothing else', () => {
  const code = ['a();', '// #region dev-only: reload on change', 'devThing();', '// #endregion dev-only', 'b();'].join(
    '\n'
  );
  const { code: out, removed } = stripDevOnly(code);
  assert.equal(removed, 1);
  assert.equal(out, 'a();\nb();');
});

test('stripDevOnly refuses unbalanced regions', () => {
  assert.throws(() => stripDevOnly('// #region dev-only\nx();'), /unbalanced/);
});

test('store manifest drops dev-only permissions', () => {
  assert.ok(manifest.permissions.includes('alarms'));
  assert.ok(!storeManifest(manifest).permissions.includes('alarms'));
  assert.deepEqual(storeManifest(manifest).host_permissions, manifest.host_permissions);
});

test('secret scan catches keys and personal data, but not the placeholder in Settings', () => {
  const fakeKey = ['sk', 'ant', 'api03', 'x'.repeat(40)].join('-');
  assert.equal(findSecrets(`const key = "${fakeKey}";`)[0].kind, 'Anthropic API key');
  assert.equal(findSecrets('contact: someone@example.com')[0].kind, 'Email address');
  assert.equal(findSecrets('/Users/someone/Documents/x')[0].kind, 'Local file path');
  assert.deepEqual(findSecrets('<input placeholder="sk-ant-…">'), []);
});

test('reserved file names are detected', () => {
  assert.equal(reservedName('node_modules/_baseGet.js'), true);
  assert.equal(reservedName('_locales/en/messages.json'), false);
  assert.equal(reservedName('src/ui/panel.js'), false);
});

test('every file the extension refers to exists in the source tree', () => {
  const texts = sourceFiles('src')
    .filter((f) => /\.(js|html)$/.test(f))
    .map((rel) => ({ rel, text: readFileSync(path.join(ROOT, rel), 'utf8') }));
  const refs = collectReferences(manifest, texts);
  assert.ok(refs.length > 30, 'found the references');
  assert.deepEqual(missingReferences(refs, ROOT), []);
});

test('the source contains no credentials or personal data', () => {
  const leaks = sourceFiles('src').flatMap((rel) =>
    findSecrets(readFileSync(path.join(ROOT, rel), 'utf8')).map((h) => `${rel}:${h.line} ${h.kind}`)
  );
  assert.deepEqual(leaks, []);
});
