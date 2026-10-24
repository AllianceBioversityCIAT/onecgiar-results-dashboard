// Post-deploy verification (design.md 7.5, FR-16, NFR-03).
//   node scripts/verify-deploy.mjs --url <base> --release <dir containing manifest.json>
// Maps every release file to a URL that serves it unmodified (the routing core used in reverse),
// fetches each with "Accept-Encoding: identity", compares the sha256 of the body with the manifest,
// recomputes the global hash and exits 0 only when it equals the approved hash.
// It works against any base URL (CloudFront default domain, institutional domain, local server).
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadCore } from './load-core.mjs';
import { loadSite, rdData } from './site-data.mjs';
import { APPROVED_HASH } from './freeze-artifact.mjs';

export const ACCEPT_ENCODING = 'identity';
// An unknown path: the only URL where a 404 status is accepted (it serves 404.html).
export const NOT_FOUND_PATH = '/__rd-verify-unknown__';

const VARIANTS = [
  { suffix: '', query: '' },
  { suffix: '--embed', query: 'embed=true&displayNav=true' },
  { suffix: '--embed-nonav', query: 'embed=true' },
];

function loadRules() {
  return loadCore({ RD_DATA: rdData(loadSite()), RD_CANONICAL_HOST: '' }, 'src/runtime/legacy-compat.core.js', 'src/routing/rules.core.js');
}

function resolveWith(core, pathname, query) {
  const sp = new URLSearchParams(query);
  const params = {};
  for (const k of new Set(sp.keys())) params[k] = core.lastValue(sp, k);
  return core.resolve({ method: 'GET', host: '', path: pathname, query, params }, 'local');
}

// Returns [{ file, url, expectStatus }] covering every manifest file, or throws naming the files
// that have no URL. Each candidate HTML URL is confirmed through core.resolve to rewrite to the file.
export function buildUrlMap(manifest) {
  const core = loadRules();
  const files = Object.keys(manifest.files);
  const byFile = new Map();
  const sections = rdData(loadSite()).sections;
  for (const section of sections) {
    const pathname = section === 'home' ? '/' : '/' + section;
    const queries = section === 'partnerships'
      ? VARIANTS.flatMap((v) => [v, { suffix: v.suffix, query: v.query ? v.query + '&year=2017' : 'year=2017' }])
      : VARIANTS;
    for (const v of queries) {
      const r = resolveWith(core, pathname, v.query);
      if (r.type !== 'rewrite') continue;
      const url = pathname + (v.query ? '?' + v.query : '');
      if (!byFile.has(r.file)) byFile.set(r.file, { url, expectStatus: 200 });
    }
  }
  const map = [];
  const missing = [];
  for (const file of files) {
    if (file === '404.html') {
      const r = resolveWith(core, NOT_FOUND_PATH, '');
      if (r.type !== 'notFound') throw new Error(`routing core does not return notFound for ${NOT_FOUND_PATH}`);
      map.push({ file, url: NOT_FOUND_PATH, expectStatus: 404 });
    } else if (byFile.has(file)) {
      map.push({ file, ...byFile.get(file) });
    } else if (file.endsWith('.html') && /--embed|^[^/]+\.html$/.test(file)) {
      missing.push(file); // an HTML page no route can reach
    } else {
      const url = '/' + file.split('/').map(encodeURIComponent).join('/');
      const r = resolveWith(core, url, '');
      if (r.type === 'pass') map.push({ file, url, expectStatus: 200 });
      else missing.push(file);
    }
  }
  if (missing.length > 0) throw new Error(`no URL serves these manifest files: ${missing.join(', ')}`);
  return map;
}

function fetchBytes(base, target) {
  return new Promise((resolve, reject) => {
    const url = new URL(target, base);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, { method: 'GET', headers: { 'Accept-Encoding': ACCEPT_ENCODING }, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Resolves { ok, hash, checked, failures: [{ file, url, reason }] }; never throws for HTTP problems.
export async function verifyDeploy({ url, releaseDir, expectedHash = APPROVED_HASH, concurrency = 8 }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(releaseDir, 'manifest.json'), 'utf8'));
  const map = buildUrlMap(manifest);
  const failures = [];
  const actual = {};
  let next = 0;
  async function worker() {
    while (next < map.length) {
      const e = map[next++];
      try {
        const { status, body } = await fetchBytes(url, e.url);
        if (status !== e.expectStatus) {
          failures.push({ file: e.file, url: e.url, reason: `status ${status}, expected ${e.expectStatus}` });
          continue;
        }
        const digest = sha256(body);
        actual[e.file] = digest;
        if (digest !== manifest.files[e.file]) {
          failures.push({ file: e.file, url: e.url, reason: `sha256 ${digest} != manifest ${manifest.files[e.file]}` });
        }
      } catch (err) {
        failures.push({ file: e.file, url: e.url, reason: `unreachable: ${err.message || err.code}` });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, map.length) }, worker));
  failures.sort((a, b) => (a.file < b.file ? -1 : 1));
  // Global hash over the digests actually received (same line format as scripts/manifest.mjs).
  const lines = Object.keys(manifest.files).sort().map((f) => `${actual[f] ?? 'MISSING'}  ${f}\n`).join('');
  const hash = crypto.createHash('sha256').update(lines).digest('hex');
  return { ok: failures.length === 0 && hash === expectedHash, hash, checked: map.length, failures };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
  const url = opt('--url');
  const release = opt('--release');
  if (!url || !release) {
    console.error('usage: node scripts/verify-deploy.mjs --url <base-url> --release <release-dir>');
    process.exit(2);
  }
  let r;
  try { r = await verifyDeploy({ url, releaseDir: path.resolve(release) }); } catch (e) {
    console.error(`verify-deploy: ${e.message}`);
    process.exit(2);
  }
  for (const f of r.failures) console.error(`FAIL ${f.file} (${f.url}): ${f.reason}`);
  console.log(`checked ${r.checked} files, ${r.failures.length} failed`);
  console.log(`recomputed hash ${r.hash}`);
  console.log(r.ok ? `PASS: equals approved hash ${APPROVED_HASH}` : `FAIL: expected ${APPROVED_HASH}`);
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
