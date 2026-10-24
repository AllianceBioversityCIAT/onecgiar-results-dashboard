// FR-01 / DD-11: the frozen copies are byte-identical to the original.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, MANIFEST_PATH, originalDir, listFiles, parseManifest, diffAgainstManifest,
} from '../../scripts/verify-original.mjs';

const ORIG = originalDir();
const present = existsSync(ORIG);
const skip = present ? false : `NOT RUN: original folder absent (${ORIG})`;
const manifest = () => parseManifest(readFileSync(MANIFEST_PATH, 'utf8'));

test('manifest of the original matches every file under the original folder', { skip }, () => {
  const d = diffAgainstManifest(ORIG, manifest());
  assert.deepEqual(d, { changed: [], missing: [], extra: [] });
});

test('reference/templates-original is byte-identical to the original app/templates', { skip }, () => {
  const refDir = join(ROOT, 'reference', 'templates-original');
  const origDir = join(ORIG, 'app', 'templates');
  const refFiles = listFiles(refDir);
  assert.deepEqual(refFiles, listFiles(origDir), 'same file set');
  for (const f of refFiles) {
    assert.ok(readFileSync(join(refDir, f)).equals(readFileSync(join(origDir, f))), `differs: ${f}`);
  }
});

test('every kept JS file under src/public/js is byte-equal to the original', { skip }, () => {
  const keptDir = join(ROOT, 'src', 'public', 'js');
  const origDir = join(ORIG, 'public', 'js');
  const kept = listFiles(keptDir).filter((f) => f.endsWith('.js'));
  assert.ok(kept.length > 0, 'at least one kept JS file');
  for (const f of kept) {
    assert.ok(existsSync(join(origDir, f)), `no original for ${f}`);
    assert.ok(readFileSync(join(keptDir, f)).equals(readFileSync(join(origDir, f))), `differs: ${f}`);
  }
});

// Runs even when the original folder is absent: the frozen copy is checked against the manifest.
test('reference/templates-original matches the manifest hashes (no original needed)', () => {
  const m = manifest();
  const prefix = 'app/templates/';
  const expected = [...m].filter(([p]) => p.startsWith(prefix));
  assert.ok(expected.length > 0, 'manifest lists app/templates files');
  const sub = new Map(expected.map(([p, h]) => [p.slice(prefix.length), h]));
  const d = diffAgainstManifest(join(ROOT, 'reference', 'templates-original'), sub);
  assert.deepEqual(d, { changed: [], missing: [], extra: [] });
});
