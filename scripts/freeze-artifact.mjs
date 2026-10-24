// Freeze the approved dist/ into release/<hash8>/ (design.md 7.3, FR-14, NFR-03, NFR-08, DD-05).
// Refuses unless the recomputed manifest hash is the approved one. Never builds, never writes dist/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeManifest, writeManifest } from './manifest.mjs';

export const APPROVED_HASH = '1f6d95a5efc5ea0f943b0475fe896da2472f8d67a701f4e9d173377fe9d8d075';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const sumsText = (manifest) =>
  Object.keys(manifest.files).map((p) => `${manifest.files[p]}  ${p}\n`).join('');

// Returns { status: 'created' | 'unchanged', dir, manifest }; throws on any refusal.
export function freezeArtifact({
  sourceDir = path.join(ROOT, 'dist'),
  targetRoot = path.join(ROOT, 'release'),
  expectedHash = APPROVED_HASH,
} = {}) {
  const manifest = computeManifest(sourceDir);
  if (manifest.hash !== expectedHash) {
    throw new Error(`freeze refused: hash mismatch (expected ${expectedHash}, recomputed ${manifest.hash})`);
  }
  const dir = path.join(targetRoot, expectedHash.slice(0, 8));
  const dist = path.join(dir, 'dist');
  if (fs.existsSync(dir)) {
    if (releaseMatches(dir, manifest)) return { status: 'unchanged', dir, manifest };
    throw new Error(`freeze refused: ${dir} already exists with different content`);
  }
  fs.mkdirSync(dist, { recursive: true });
  for (const rel of Object.keys(manifest.files)) {
    const to = path.join(dist, ...rel.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(sourceDir, ...rel.split('/')), to);
  }
  writeManifest(manifest, path.join(dir, 'manifest.json'));
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), sumsText(manifest));
  if (!releaseMatches(dir, manifest)) throw new Error(`freeze failed: copy at ${dir} does not verify`);
  return { status: 'created', dir, manifest };
}

// Recomputes the copied bytes (not just the stored manifest) and checks all three artifacts.
export function releaseMatches(dir, manifest) {
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
  if (!fs.existsSync(path.join(dir, 'dist'))) return false;
  const copy = computeManifest(path.join(dir, 'dist'));
  return copy.hash === manifest.hash
    && read(path.join(dir, 'manifest.json')) === `${JSON.stringify(manifest, null, 2)}\n`
    && read(path.join(dir, 'SHA256SUMS')) === sumsText(manifest);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const r = freezeArtifact();
    console.log(`${r.status}: ${r.dir} (${r.manifest.fileCount} files, ${r.manifest.hash})`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
