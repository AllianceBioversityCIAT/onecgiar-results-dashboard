import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadCore } from '../../scripts/load-core.mjs';

const readJson = (rel) => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
const site = readJson('../../src/data/site.json');
const golden = readJson('../golden/legacy-compare.json');
const { cases } = readJson('../cases/routing-cases.json');

// Sections are the distinct actions of non-title menu rows (17 of them, design 7.3 rule 5).
const sections = [...new Set(site.sections.filter((s) => s.type !== 'title').map((s) => s.action))];
const core = loadCore(
  { RD_DATA: { sections, legacyRedirects: site.legacyRedirects } },
  'src/runtime/legacy-compat.core.js',
  'src/routing/rules.core.js'
);

const CANON_HOST = 'results.cgiar.org';
const CANON = `https://${CANON_HOST}`;
const STATUS = { rewrite: 200, redirect: 301, badRequest: 400, methodNotAllowed: 405, notFound: 404, pass: 200 };

// Parsed query map as the adapters build it: last value of a repeated key (P-24).
function paramsOf(query) {
  const sp = new URLSearchParams(query);
  const params = {};
  for (const k of new Set(sp.keys())) params[k] = core.lastValue(sp, k);
  return params;
}

function request(c, host = CANON_HOST) {
  const query = c.query ?? '';
  return { method: c.method ?? 'GET', host: c.host ?? host, path: c.path, query, params: paramsOf(query) };
}

// Results are created in the vm realm; normalise to plain objects of this realm.
const run = (req, mode) => JSON.parse(JSON.stringify(core.resolve(req, mode)));

// Redirect invariant (design 7.3, X-5/Y-1/Z-1): resolve Location the way a client does.
function locationShape(loc) {
  if (/[\u0000- \u007f-￿]/.test(loc)) return 'Location holds a control, space or non-ASCII character';
  const rest = loc.startsWith(`${CANON}/`) ? loc.slice(CANON.length) : loc;
  const p = rest.split('?')[0];
  if (!(p === '/' || (p.startsWith('/') && p[1] !== '/' && p[1] !== '\\'))) return `path part ${JSON.stringify(p)} is not same-site`;
  return null;
}

function invariantA(loc) {
  const shapeError = locationShape(loc);
  if (shapeError) return shapeError;
  const u = new URL(loc, `${CANON}/`);
  const rest = loc.startsWith(`${CANON}/`) ? loc.slice(CANON.length) : loc;
  const emitted = rest.split('?')[0];
  if (u.origin !== CANON) return `origin ${u.origin}`;
  if (u.hash !== '') return `fragment ${u.hash}`;
  if (u.pathname !== emitted) return `normalized path ${JSON.stringify(u.pathname)} != emitted ${JSON.stringify(emitted)}`;
  return null;
}

function invariantB(loc, mode) {
  const u = new URL(loc, `${CANON}/`);
  const query = u.search.slice(1);
  const r = run({ method: 'GET', host: CANON_HOST, path: u.pathname, query, params: paramsOf(query) }, mode);
  return r.type === 'redirect' ? `normalized ${u.pathname + u.search} redirects again to ${r.location}` : null;
}

test('site data: 17 sections and 20 legacy names', () => {
  assert.equal(sections.length, 17);
  assert.equal(Object.keys(site.legacyRedirects).length, 20);
});

test('core exposes resolve and reuses the legacy-compat year logic', () => {
  assert.equal(typeof core.resolve, 'function');
  assert.equal(typeof core.yearAfter2017, 'function');
});

// ---- Table cases, in every mode they apply to (FR-13, FR-15, FR-09, DD-02) ----
const ids = new Set();
for (const c of cases) {
  assert.ok(!ids.has(c.id), `duplicate case id ${c.id}`);
  ids.add(c.id);
  const modes = c.modes === 'both' ? ['local', 'edge'] : ['edge'];
  for (const mode of modes) {
    test(`case ${c.id} [${mode}]`, () => {
      const r = run(request(c), mode);
      const got = { type: r.type };
      if ('file' in r) got.file = r.file;
      if ('location' in r) got.location = r.location;
      assert.deepEqual(got, c.expect);
      assert.equal(STATUS[r.type], c.status);
      if (r.type !== 'pass') assert.equal(r.status, c.status);
    });
    if (c.expect.type === 'redirect') {
      test(`invariant (a) normalized path equals emitted path: ${c.id} [${mode}]`, () => {
        assert.equal(invariantA(run(request(c), mode).location), null);
      });
      test(`invariant (b) normalized URL does not redirect: ${c.id} [${mode}]`, () => {
        assert.equal(invariantB(run(request(c), mode).location, mode), null);
      });
    }
  }
}

// V-1 regression: a literal '#', '^' or '|' in the path must never reach a Location.
for (const path of ['/homeV1#/', '/a#b', '/x^y/', '/x|y/']) {
  for (const mode of ['local', 'edge']) {
    test(`V-1 ${JSON.stringify(path)} [${mode}]: invariants hold if redirected, and it is a 400`, () => {
      const r = run({ method: 'GET', host: CANON_HOST, path, query: '', params: {} }, mode);
      if (r.type === 'redirect') {
        assert.deepEqual({ a: invariantA(r.location), b: invariantB(r.location, mode) }, { a: null, b: null });
      }
      assert.equal(r.type, 'badRequest');
    });
  }
}

test('edge-only cases: rule 1 is disabled in local mode (FR-15)', () => {
  const edgeOnly = cases.filter((c) => c.modes === 'edge');
  assert.ok(edgeOnly.length >= 10);
  for (const c of edgeOnly) {
    const local = run(request(c), 'local');
    assert.deepEqual(local, run({ ...request(c), host: CANON_HOST }, 'local'), c.id);
    assert.ok(!(local.type === 'redirect' && local.location.startsWith('https://')), c.id);
  }
  const r = run({ method: 'GET', host: 'www.results.cgiar.org', path: '/innovations', query: 'year=2019', params: { year: '2019' } }, 'local');
  assert.deepEqual({ type: r.type, file: r.file }, { type: 'rewrite', file: 'innovations.html' });
});

test('FR-15 literal: www + /innovations?year=2019 in edge mode is https, never http', () => {
  const r = run({ method: 'GET', host: 'www.results.cgiar.org', path: '/innovations', query: 'year=2019', params: { year: '2019' } }, 'edge');
  assert.equal(r.location, 'https://results.cgiar.org/innovations?year=2019');
  assert.ok(!r.location.startsWith('http://'));
});

// ---- Generated coverage from the site data ----
for (const name of sections) {
  test(`section /${name}: three variants, trailing slash and .html redirects`, () => {
    const g = (path, query) => run({ method: 'GET', host: CANON_HOST, path, query, params: paramsOf(query) }, 'local');
    if (name === 'home') {
      assert.equal(g('/', '').file, 'home.html');
    }
    assert.equal(g(`/${name}`, '').file, `${name}.html`);
    assert.equal(g(`/${name}`, 'embed=true&displayNav=true').file, `${name}--embed.html`);
    assert.equal(g(`/${name}`, 'embed=true').file, `${name}--embed-nonav.html`);
    assert.equal(g(`/${name}/`, '').location, `/${name}`);
    for (const f of [`${name}.html`, `${name}--embed.html`, `${name}--embed-nonav.html`]) {
      assert.equal(g(`/${f}`, '').location, `/${name}`, f);
    }
    assert.equal(g(`/${name.toUpperCase() === name ? name.toLowerCase() : name.toUpperCase()}`, '').type, 'notFound');
  });
}

for (const [name, target] of Object.entries(site.legacyRedirects)) {
  test(`legacy /${name} -> ${target} (one hop, also with a trailing slash and on www)`, () => {
    const g = (host, path, mode) => run({ method: 'GET', host, path, query: 'a=1', params: { a: '1' } }, mode);
    assert.equal(g(CANON_HOST, `/${name}`, 'local').location, `${target}?a=1`);
    assert.equal(g(CANON_HOST, `/${name}//`, 'local').location, `${target}?a=1`);
    assert.equal(g('www.results.cgiar.org', `/${name}/`, 'edge').location, `${CANON}${target}?a=1`);
    assert.ok(target === '/' || sections.includes(target.slice(1)), `target ${target} is a section`);
  });
}

// ---- Partnerships golden table (FR-09, DD-03, D19) ----
for (const r of golden.numeric) {
  test(`[${r.kind}] partnerships year=${JSON.stringify(r.input)} -> ${r.yearAfter2017 ? '2018+' : 'legacy'}`, () => {
    const query = `year=${encodeURIComponent(r.input)}`;
    const out = run({ method: 'GET', host: CANON_HOST, path: '/partnerships', query, params: paramsOf(query) }, 'local');
    assert.equal(out.file, r.yearAfter2017 ? 'partnerships.html' : 'partnerships-2017.html');
  });
}

// ---- Fuzz with a recorded fixed seed (Y-1, Y-12) ----
const FUZZ_SEED = 20261023;
const FUZZ_N = 4000;
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEGMENTS = ['', 'a', 'x', 'innovations', 'homeV1', 'home%56%31', 'widget', 'action', 'Action', 'partnerships', 'partnerships-2017', '.', '..', '%2e', '%2E', '.%2e', '%2e%2E',
  '%2F', '%5C', '%5c', 'innovations.html', 'innovations--embed.html', 'home--embed-nonav.html', 'a"b', 'a<b>', 'a`b', '{x}', 'a#b', 'a^b', 'a|b', '%', '%zz', '%00', '%FF',
  'é', '\t', ' ', 'js', 'global.js', '\\', '404.html', 'constructor', '%69nnovations', '...', '%252e'];
const SEPARATORS = ['/', '/', '/', '//', '\\', '/'];
const QUERIES = ['', '', 'year=2019', 'year=2017', 'embed=true', 'embed=true&displayNav=true', 'a=b#c', 'x=%2F', 'q="<>`{}', 'a=b c', 'a=\r\nb', 'a=é', 'a=%0D%0A',
  'year[]=1', 'hostOrigin=http%3A%2F%2Fa', 'year=', '#', '\t', 'a=\u007f', 'a=^|b', '^|', 'q=x^y|z#^'];
const HOSTS = [CANON_HOST, CANON_HOST, 'www.results.cgiar.org', 'evil.example'];
const METHODS = ['GET', 'GET', 'GET', 'HEAD', 'POST'];

function fuzzCases() {
  const rnd = mulberry32(FUZZ_SEED);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const out = [];
  for (let i = 0; i < FUZZ_N; i++) {
    let path = rnd() < 0.95 ? '/' : '';
    const n = Math.floor(rnd() * 4);
    for (let s = 0; s < n; s++) path += (s > 0 ? pick(SEPARATORS) : '') + pick(SEGMENTS);
    const trailing = Math.floor(rnd() * 4);
    if (rnd() < 0.6) path += '/'.repeat(trailing);
    out.push({ method: pick(METHODS), host: pick(HOSTS), path, query: pick(QUERIES) });
  }
  return out;
}

const fuzz = fuzzCases();
console.log(`# routing fuzz: seed=${FUZZ_SEED} cases=${FUZZ_N}`);

function fuzzRun(mode) {
  const stats = { redirect: 0, badRequest: 0, notFound: 0, rewrite: 0, pass: 0, methodNotAllowed: 0 };
  const failA = [];
  const failB = [];
  const failResult = [];
  for (const f of fuzz) {
    const req = { ...f, params: paramsOf(f.query) };
    const r = run(req, mode);
    if (!(r.type in stats)) { failResult.push(`${JSON.stringify(f)} -> ${JSON.stringify(r)}`); continue; }
    stats[r.type]++;
    if (r.type === 'redirect') {
      const a = invariantA(r.location);
      if (a) failA.push(`${JSON.stringify(f)} -> ${r.location}: ${a}`);
      else {
        const b = invariantB(r.location, mode);
        if (b) failB.push(`${JSON.stringify(f)} -> ${r.location}: ${b}`);
      }
    }
  }
  return { stats, failA, failB, failResult };
}

for (const mode of ['local', 'edge']) {
  const res = fuzzRun(mode);
  test(`fuzz seed ${FUZZ_SEED} [${mode}]: every result is one of the six types and the run is not inert`, () => {
    assert.deepEqual(res.failResult, []);
    assert.ok(res.stats.redirect > 100, JSON.stringify(res.stats));
    assert.ok(res.stats.badRequest > 100, JSON.stringify(res.stats));
    assert.ok(res.stats.notFound > 100, JSON.stringify(res.stats));
    assert.ok(res.stats.rewrite > 50, JSON.stringify(res.stats));
  });
  test(`fuzz seed ${FUZZ_SEED} [${mode}]: invariant (a) normalized path equals emitted path`, () => {
    assert.deepEqual(res.failA.slice(0, 5), []);
  });
  test(`fuzz seed ${FUZZ_SEED} [${mode}]: invariant (b) normalized URL does not redirect`, () => {
    assert.deepEqual(res.failB.slice(0, 5), []);
  });
}
