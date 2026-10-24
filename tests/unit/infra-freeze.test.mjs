// FR-14 / NFR-03 / NFR-08, design 7.3: freeze the approved dist/ into release/<hash8>/ byte-exact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { computeManifest } from '../../scripts/manifest.mjs';
import { freezeArtifact, APPROVED_HASH } from '../../scripts/freeze-artifact.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-')); }
function makeSource() {
  const src = path.join(tmp(), 'dist');
  fs.mkdirSync(path.join(src, 'css'), { recursive: true });
  fs.writeFileSync(path.join(src, 'home.html'), '<html>\r\nhome\r\n</html>\r\n');
  fs.writeFileSync(path.join(src, 'css', 'a.css'), 'a{color:red}\n');
  fs.writeFileSync(path.join(src, 'bin.dat'), Buffer.from([0, 255, 13, 10, 7]));
  return src;
}

test('freeze from a temp copy: release hash equals the source hash and bytes are identical', () => {
  const src = makeSource();
  const hash = computeManifest(src).hash;
  const root = tmp();
  const r = freezeArtifact({ sourceDir: src, targetRoot: root, expectedHash: hash });
  const target = path.join(root, hash.slice(0, 8));
  assert.equal(r.status, 'created');
  assert.equal(r.manifest.hash, hash);
  assert.equal(computeManifest(path.join(target, 'dist')).hash, hash);
  assert.ok(fs.readFileSync(path.join(target, 'dist', 'bin.dat')).equals(Buffer.from([0, 255, 13, 10, 7])));
  const m = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'));
  assert.equal(m.hash, hash);
  assert.equal(m.fileCount, 3);
  const sums = fs.readFileSync(path.join(target, 'SHA256SUMS'), 'utf8');
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(src, 'css', 'a.css'))).digest('hex');
  assert.ok(sums.split('\n').includes(`${sha}  css/a.css`));
});

test('wrong hash refuses with a clear message and writes nothing', () => {
  const src = makeSource();
  const root = tmp();
  assert.throws(
    () => freezeArtifact({ sourceDir: src, targetRoot: root, expectedHash: APPROVED_HASH }),
    /hash mismatch/,
  );
  assert.deepEqual(fs.readdirSync(root), []);
});

test('second run on an identical release is a no-op', () => {
  const src = makeSource();
  const hash = computeManifest(src).hash;
  const root = tmp();
  freezeArtifact({ sourceDir: src, targetRoot: root, expectedHash: hash });
  const f = path.join(root, hash.slice(0, 8), 'manifest.json');
  const before = fs.statSync(f).mtimeMs;
  const r = freezeArtifact({ sourceDir: src, targetRoot: root, expectedHash: hash });
  assert.equal(r.status, 'unchanged');
  assert.equal(fs.statSync(f).mtimeMs, before);
});

test('existing release with one changed byte refuses', () => {
  const src = makeSource();
  const hash = computeManifest(src).hash;
  const root = tmp();
  freezeArtifact({ sourceDir: src, targetRoot: root, expectedHash: hash });
  const f = path.join(root, hash.slice(0, 8), 'dist', 'css', 'a.css');
  const b = fs.readFileSync(f); b[0] ^= 1; fs.writeFileSync(f, b);
  assert.throws(
    () => freezeArtifact({ sourceDir: src, targetRoot: root, expectedHash: hash }),
    /different content/,
  );
});

test('the script does not spawn any build', () => {
  const code = fs.readFileSync(path.join(ROOT, 'scripts', 'freeze-artifact.mjs'), 'utf8');
  assert.doesNotMatch(code, /child_process|spawn|exec(Sync|File)?\(|build\.mjs/);
});

test('release/** is exempt from text normalization in .gitattributes', () => {
  const ga = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8').split(/\r?\n/);
  assert.ok(ga.includes('release/** -text'));
});
