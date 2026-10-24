// Verifies byte identity of the frozen original (FR-01, DD-11).
// Library use: import { ... } from './verify-original.mjs'
// CLI: node scripts/verify-original.mjs [--write]   (ORIGINAL_DIR overrides the default path)
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_ORIGINAL_DIR = join(ROOT, '..', 'resultsDashboard-prod', 'resultsDashboard');
export const MANIFEST_PATH = join(ROOT, 'reference', 'original-manifest.sha256');

export function originalDir() {
  return process.env.ORIGINAL_DIR || DEFAULT_ORIGINAL_DIR;
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Sorted (code-unit order), POSIX-style relative paths of every file under dir. */
export function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function buildManifest(dir) {
  return listFiles(dir).map((p) => `${sha256(readFileSync(join(dir, p)))}  ${p}\n`).join('');
}

/** Parses "<sha256>  <path>" lines into a Map(path -> hash). */
export function parseManifest(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!m) throw new Error(`Malformed manifest line: ${line}`);
    map.set(m[2], m[1]);
  }
  return map;
}

/** Compares the files under dir with a manifest; returns the differences. */
export function diffAgainstManifest(dir, manifest) {
  const actual = new Map(listFiles(dir).map((p) => [p, sha256(readFileSync(join(dir, p)))]));
  const changed = [];
  const missing = [];
  const extra = [];
  for (const [p, h] of manifest) {
    if (!actual.has(p)) missing.push(p);
    else if (actual.get(p) !== h) changed.push(p);
  }
  for (const p of actual.keys()) if (!manifest.has(p)) extra.push(p);
  return { changed, missing, extra };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = originalDir();
  if (!existsSync(dir)) {
    console.error(`NOT RUN: original folder not found: ${dir}`);
    process.exit(2);
  }
  if (process.argv.includes('--write')) {
    writeFileSync(MANIFEST_PATH, buildManifest(dir), { encoding: 'utf8' });
    console.log(`Wrote ${MANIFEST_PATH}`);
  } else {
    const d = diffAgainstManifest(dir, parseManifest(readFileSync(MANIFEST_PATH, 'utf8')));
    const bad = d.changed.length + d.missing.length + d.extra.length;
    console.log(bad ? JSON.stringify(d, null, 2) : 'Original matches the manifest.');
    process.exit(bad ? 1 : 0);
  }
}
