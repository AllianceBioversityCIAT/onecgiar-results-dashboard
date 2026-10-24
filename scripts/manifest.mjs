// Deterministic file manifest (design.md 7.1 step 11, FR-02): sorted paths with "/" separator,
// SHA-256 per file, one global hash over the sorted "<sha256>  <path>" lines. No dates, no
// absolute paths.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Relative POSIX paths of every file under dir, sorted by code unit order.
export function listFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(abs, entry.name), childRel);
      else out.push(childRel);
    }
  };
  walk(dir, '');
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function computeManifest(dir) {
  const files = {};
  for (const rel of listFiles(dir)) files[rel] = sha256File(path.join(dir, ...rel.split('/')));
  const lines = Object.keys(files).map((p) => `${files[p]}  ${p}\n`).join('');
  const hash = crypto.createHash('sha256').update(lines).digest('hex');
  return { algorithm: 'sha256', fileCount: Object.keys(files).length, hash, files };
}

export function writeManifest(manifest, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}
