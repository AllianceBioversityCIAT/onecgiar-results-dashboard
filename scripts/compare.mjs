// `npm run compare` (design 10.2, FR-23, FR-28, NFR-08, DD-09).
//   R1  reference render of the original templates vs the local build, DOM after JS + window.appConfig
//       + Tableau requests (LOCAL class). Independent logic: reference/routes-reference.mjs.
//   R2  requester screenshot vs a local screenshot, side by side in reports/compare/r2-home.html.
//   R3  live PROD, read-only: one HEAD probe, courtesy-limited GET only if it answers.
// Exit code: non-zero if R1 has an unclassified difference or R2 could not be generated.
// R3 BLOCKED (PROD unreachable) is neither a failure nor a pass.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { startServer } from './serve.mjs';
import { renderAll, loadMatrix, ROOT } from './reference-render.mjs';

const REF_PORT = Number(process.env.COMPARE_REF_PORT || 8095);
const LOCAL_PORT = Number(process.env.COMPARE_LOCAL_PORT || 8096);
const PROD = 'https://results.cgiar.org';
const OUT = path.join(ROOT, 'reports', 'compare');
const CACHE_REF = path.join(ROOT, '.cache', 'reference');
const CACHE_RAW = path.join(ROOT, '.cache', 'reference-raw');
const DIST = process.env.COMPARE_DIST ? path.resolve(process.env.COMPARE_DIST) : path.join(ROOT, 'dist');
const SCREENSHOT = path.resolve(ROOT, '..', 'docs', 'specs', 'changes', 'results-dashboard-aws-migration', 'evidence', 'reference', 'Screenshot 2026-10-23 160828.png');
const TABLEAU_HOST = /(^|\.)tableau\.com$|^tableau-core\.cgiar\.org$/;
const MAX_DIFFS_PER_CASE = 8;
// Per-case removals that R1 declares as expected (FR-16 on the reference; runtime scripts locally).
const EXPECTED_REF_STATS = { 'analytics-UA': 2, 'inline-appConfig': 1 };
const EXPECTED_LOC_STATS = { 'runtime-scripts': 3 };

// ---------- normalization (design 10.2 R1 (a)) ----------
const collapse = (s) => s.replace(/\s+/g, ' ').trim();

// Runs in the page: serializes the live DOM. The radio/checkbox `checked` PROPERTY is recorded
// (rd-apply.js sets the property, not the attribute).
function extractTree() {
  const walk = (n) => {
    if (n.nodeType === 3) return n.nodeValue;
    if (n.nodeType !== 1) return null;
    const a = {};
    for (const at of Array.from(n.attributes)) a[at.name] = at.value;
    const node = { t: n.tagName.toLowerCase(), a, c: [] };
    if (n.tagName === 'INPUT') node.checked = n.checked;
    for (const ch of Array.from(n.childNodes)) {
      const r = walk(ch);
      if (r !== null) node.c.push(r);
    }
    return node;
  };
  return walk(document.documentElement);
}

// Declared removals are side-specific (design 10.2 R1 step 4(a)): the FR-16 items (inline appConfig,
// analytics/UA) exist only in the reference and are removed there only; the runtime scripts exist
// only in the migrated page and are removed there only. A FR-16 pattern on the local side is NOT
// removed: it shows up as a DOM difference (see fr16Findings).
const FR16 = [
  ['inline-appConfig', (src, text) => /var\s+appConfig\s*=/.test(text)],
  ['analytics-UA', (src, text) => /googletagmanager\.com\/gtag/.test(src) || /gtag\(|dataLayer/.test(text)],
];
const RUNTIME_SRC = /(^|\/)(legacy-compat|rd-params|rd-apply)\.js$/;
const scriptParts = (n) => ({
  src: n.a.src ? n.a.src.trim().split(/[?#]/)[0] : '',
  text: n.c.filter((x) => typeof x === 'string').join(''),
});

// FR-05 BUT / FR-16: names every script of the tree that matches a FR-16 pattern.
export function fr16Findings(tree) {
  const out = [];
  const walk = (n) => {
    if (typeof n === 'string') return;
    if (n.t === 'script') {
      const { src, text } = scriptParts(n);
      for (const [name, test] of FR16) if (test(src, text)) out.push(name);
    }
    n.c.forEach(walk);
  };
  walk(tree);
  return out;
}

export function normalizeTree(root, stats, side) {
  if (side !== 'reference' && side !== 'local') throw new Error('normalizeTree needs side reference|local');
  const bump = (k) => { stats[k] = (stats[k] || 0) + 1; };
  const scriptRemoved = (n) => {
    if (n.t !== 'script') return null;
    const { src, text } = scriptParts(n);
    if (side === 'local') return RUNTIME_SRC.test(src) ? 'runtime-scripts' : null;
    for (const [name, test] of FR16) if (test(src, text)) return name;
    return null;
  };
  const walk = (n) => {
    if (typeof n === 'string') return collapse(n);
    const why = scriptRemoved(n);
    if (why) { bump(why); return null; }
    const a = {};
    for (const k of Object.keys(n.a).sort()) {
      if (k.startsWith('data-rd-')) { bump('data-rd-attributes'); continue; }
      if (n.t === 'input' && k === 'checked') continue; // state is compared through the property
      a[k] = k === 'class' ? collapse(n.a[k]) : n.a[k];
    }
    const out = { t: n.t, a };
    if (n.checked !== undefined) out.checked = n.checked;
    const kids = [];
    for (const ch of n.c) {
      const r = walk(ch);
      if (r === null || r === '') continue;
      if (typeof r === 'string' && typeof kids[kids.length - 1] === 'string') kids[kids.length - 1] = collapse(kids[kids.length - 1] + ' ' + r);
      else kids.push(r);
    }
    out.c = kids;
    return out;
  };
  return walk(root);
}

const describe = (n) => (typeof n === 'string' ? JSON.stringify(n.slice(0, 80)) : `<${n.t}${n.a.id ? '#' + n.a.id : ''}${n.a.class ? '.' + n.a.class.split(' ')[0] : ''}>`);

export function diffTrees(ref, loc, pathStr = 'html', out = []) {
  if (out.length >= MAX_DIFFS_PER_CASE) return out;
  if (typeof ref === 'string' || typeof loc === 'string') {
    if (ref !== loc) out.push(`${pathStr}: text ${describe(ref)} (reference) vs ${describe(loc)} (local)`);
    return out;
  }
  if (ref.t !== loc.t) { out.push(`${pathStr}: element ${describe(ref)} vs ${describe(loc)}`); return out; }
  const here = `${pathStr}>${ref.t}${ref.a.id ? '#' + ref.a.id : ''}`;
  for (const k of new Set([...Object.keys(ref.a), ...Object.keys(loc.a)])) {
    if (ref.a[k] !== loc.a[k]) out.push(`${here}: attribute ${k}=${JSON.stringify(ref.a[k])} (reference) vs ${JSON.stringify(loc.a[k])} (local)`);
  }
  if (ref.checked !== loc.checked) out.push(`${here}: checked ${ref.checked} (reference) vs ${loc.checked} (local)`);
  const n = Math.max(ref.c.length, loc.c.length);
  for (let i = 0; i < n && out.length < MAX_DIFFS_PER_CASE; i++) {
    if (ref.c[i] === undefined) out.push(`${here}[${i}]: extra ${describe(loc.c[i])} in local`);
    else if (loc.c[i] === undefined) out.push(`${here}[${i}]: missing ${describe(ref.c[i])} in local`);
    else diffTrees(ref.c[i], loc.c[i], `${here}[${i}]`, out);
  }
  return out;
}

// ---------- page capture ----------
async function capture(context, url, origin) {
  const page = await context.newPage();
  const tableau = [];
  const errors = [];
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.origin === origin) return route.continue();
    if (TABLEAU_HOST.test(u.hostname)) tableau.push(route.request().url());
    return route.abort();
  });
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));
  const response = await page.goto(url, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  const appConfig = await page.evaluate(() => (typeof window.appConfig === 'undefined' ? null : JSON.parse(JSON.stringify(window.appConfig))));
  const tree = await page.evaluate(extractTree);
  const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map((a) => a.getAttribute('href')));
  await page.close();
  return { status: response.status(), appConfig, tree, tableau: tableau.sort(), errors, hrefs };
}

const sortKeys = (o) => (o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])) : o);
// JSON text of sorted keys: values AND types are compared (2021 vs "2021", true vs "true").
const same = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));

// ---------- R1 ----------
async function runR1(browser, cases) {
  const refStats = {};
  const locStats = {};
  const results = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  for (const c of cases) {
    const q = c.query ? `?${c.query}` : '';
    const ref = await capture(context, `http://127.0.0.1:${REF_PORT}/${c.id}.html${q}`, `http://127.0.0.1:${REF_PORT}`);
    const loc = await capture(context, `http://127.0.0.1:${LOCAL_PORT}${c.path}${q}`, `http://127.0.0.1:${LOCAL_PORT}`);
    const diffs = [];
    if (ref.status !== 200) diffs.push({ cat: 'oracle', msg: `reference page HTTP ${ref.status}` });
    if (loc.status !== 200) diffs.push({ cat: 'http', msg: `local page HTTP ${loc.status}` });
    // (a) normalized DOM after JS
    const caseRef = {};
    const caseLoc = {};
    const nr = normalizeTree(ref.tree, caseRef, 'reference');
    const nl = normalizeTree(loc.tree, caseLoc, 'local');
    for (const m of diffTrees(nr, nl)) diffs.push({ cat: 'dom', msg: m });
    for (const f of fr16Findings(loc.tree)) diffs.push({ cat: 'dom', msg: `fr16: the migrated page contains a FR-16 ${f} script (FR-05 BUT)` });
    // The declared removals must be exactly the expected ones, per case.
    if (JSON.stringify(sortKeys(caseRef)) !== JSON.stringify(EXPECTED_REF_STATS)) {
      diffs.push({ cat: 'normalization', msg: `reference removals ${JSON.stringify(caseRef)} deviate from expected ${JSON.stringify(EXPECTED_REF_STATS)}` });
    }
    if (JSON.stringify(sortKeys(caseLoc)) !== JSON.stringify(EXPECTED_LOC_STATS)) {
      diffs.push({ cat: 'normalization', msg: `local removals ${JSON.stringify(caseLoc)} deviate from expected ${JSON.stringify(EXPECTED_LOC_STATS)}` });
    }
    for (const [k, v] of Object.entries(caseRef)) refStats[k] = (refStats[k] || 0) + v;
    for (const [k, v] of Object.entries(caseLoc)) locStats[k] = (locStats[k] || 0) + v;
    // (b) window.appConfig, values and types
    if (!ref.appConfig) diffs.push({ cat: 'oracle', msg: 'reference page defines no window.appConfig' });
    if (!loc.appConfig) diffs.push({ cat: 'appConfig', msg: 'local page defines no window.appConfig' });
    if (ref.appConfig && loc.appConfig && !same(ref.appConfig, loc.appConfig)) {
      diffs.push({ cat: 'appConfig', msg: `reference ${JSON.stringify(sortKeys(ref.appConfig))} vs local ${JSON.stringify(sortKeys(loc.appConfig))}` });
    }
    // oracle self-check: the reference against the literal expectation written in the matrix
    if (ref.appConfig && !same(ref.appConfig, c.expect.appConfig)) {
      diffs.push({ cat: 'oracle', msg: `reference appConfig ${JSON.stringify(sortKeys(ref.appConfig))} differs from the matrix literal ${JSON.stringify(sortKeys(c.expect.appConfig))}` });
    }
    if (loc.appConfig && !same(loc.appConfig, c.expect.appConfig)) {
      diffs.push({ cat: 'appConfig', msg: `local appConfig ${JSON.stringify(sortKeys(loc.appConfig))} differs from the matrix literal ${JSON.stringify(sortKeys(c.expect.appConfig))}` });
    }
    // (c) Tableau view and Year each page asked for
    if (JSON.stringify(ref.tableau) !== JSON.stringify(loc.tableau)) {
      diffs.push({ cat: 'tableau', msg: `reference ${JSON.stringify(ref.tableau)} vs local ${JSON.stringify(loc.tableau)}` });
    }
    // E cases with a menu: links carry the decoded literal hostOrigin (split/join, not a pattern replacement)
    const ho = new URLSearchParams(c.query).get('hostOrigin');
    if (ho !== null && /displayNav=true/.test(c.query) && !loc.hrefs.some((h) => h.includes(`hostOrigin=${ho}`))) {
      diffs.push({ cat: 'menu-literal', msg: `no local link contains hostOrigin=${ho}` });
    }
    if (JSON.stringify(ref.errors) !== JSON.stringify(loc.errors)) {
      diffs.push({ cat: 'pageerror', msg: `reference ${JSON.stringify(ref.errors)} vs local ${JSON.stringify(loc.errors)}` });
    }
    results.push({ id: c.id, group: c.group, tableauRequests: loc.tableau.length, tableauHasYear: loc.tableau.some((u) => /[?&]Year=/.test(u)), diffs });
  }
  await context.close();
  return { results, normalized: { reference: refStats, local: locStats } };
}

// ---------- R2 ----------
function pngSize(file) {
  const b = fs.readFileSync(file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

async function runR2(browser) {
  if (!fs.existsSync(SCREENSHOT)) return { status: 'FAILED', detail: `requester screenshot not found: ${SCREENSHOT}` };
  fs.mkdirSync(OUT, { recursive: true });
  const prodPng = path.join(OUT, 'r2-prod-home.png');
  const localPng = path.join(OUT, 'r2-local-home.png');
  fs.copyFileSync(SCREENSHOT, prodPng);
  const ctx = await browser.newContext({ viewport: { width: 2534, height: 1253 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const failed = [];
  page.on('requestfailed', (r) => { if (TABLEAU_HOST.test(new URL(r.url()).hostname)) failed.push(r.url()); });
  await page.goto(`http://127.0.0.1:${LOCAL_PORT}/?year=2021`, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.screenshot({ path: localPng });
  await ctx.close();
  const ps = pngSize(prodPng);
  const ls = pngSize(localPng);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>R2 - Home, year 2021</title>
<style>body{font:14px/1.4 system-ui,sans-serif;margin:16px}.row{display:flex;gap:16px;align-items:flex-start}figure{margin:0;flex:1;min-width:0}img{width:100%;border:1px solid #888}figcaption{font-weight:600;margin-bottom:6px}</style></head>
<body><h1>R2 - Home, <code>?year=2021</code>, normal mode</h1>
<p>Human review at G2 (NFR-08). Left: the requester's screenshot (${ps.width}x${ps.height}). Right: the local page at ${ls.width}x${ls.height}, Tableau allowed. Tableau iframe content is excluded from the comparison; the pixel metric does not apply (display scale and Tableau region unknown).</p>
<p>Tableau requests that failed in the local capture: ${failed.length}${failed.length ? ' (offline or blocked, so the viz area may be empty)' : ''}.</p>
<div class="row"><figure><figcaption>Reference (requester screenshot)</figcaption><img src="r2-prod-home.png" alt="Requester screenshot"></figure>
<figure><figcaption>Local</figcaption><img src="r2-local-home.png" alt="Local screenshot"></figure></div></body></html>
`;
  fs.writeFileSync(path.join(OUT, 'r2-home.html'), html);
  return { status: 'GENERATED', page: 'reports/compare/r2-home.html', reference: ps, local: ls, tableauFailed: failed.length };
}

// ---------- R3 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'results-dashboard-static compare (read-only parity check; CGIAR migration)';

async function runR3(browser, cases) {
  let probe;
  try {
    const res = await fetch(`${PROD}/`, { method: 'HEAD', signal: AbortSignal.timeout(10000), headers: { 'User-Agent': UA }, redirect: 'manual' });
    probe = { answered: true, status: res.status };
  } catch (e) {
    const cause = e && e.cause && (e.cause.code || e.cause.message);
    probe = { answered: false, error: `${e.name}: ${cause || e.message}` };
  }
  if (!probe.answered) {
    return { status: 'BLOCKED (PROD unreachable)', probe, attempts: 1, cases: cases.length, detail: 'one HEAD probe; no further request made' };
  }
  // PROD answered: courtesy-limited GET of the matrix (1 concurrent, >= 1 s apart, <= 200 requests),
  // compared with the reference render as the original templates print it (no cdnMap, no JS).
  // NOTE: this branch has not been exercised (PROD was unreachable when it was written).
  const CAP = Number(process.env.COMPARE_R3_CAP || 200);
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const diffs = [];
  let requests = 1;
  const staticTree = async (html) => {
    const p = await ctx.newPage();
    await p.setContent(html, { waitUntil: 'domcontentloaded' });
    const t = await p.evaluate(extractTree);
    await p.close();
    return normalizeTree(t, {}, 'reference'); // PROD and the raw reference both carry the FR-16 items
  };
  for (const c of cases) {
    if (requests >= CAP) { diffs.push({ id: c.id, msg: 'cap reached, case not compared' }); continue; }
    await sleep(1000);
    requests += 1;
    let body;
    try {
      const res = await fetch(`${PROD}${c.path}${c.query ? '?' + c.query : ''}`, { method: 'GET', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000), redirect: 'manual' });
      body = await res.text();
      if (res.status !== 200) {
        const loc = res.headers.get('location');
        diffs.push({ id: c.id, msg: `PROD HTTP ${res.status}${loc ? ' -> ' + loc : ''} (redirects are recorded, not followed)` });
        continue;
      }
    } catch (e) { diffs.push({ id: c.id, msg: `GET failed: ${e.message}` }); continue; }
    const d = diffTrees(await staticTree(fs.readFileSync(path.join(CACHE_RAW, `${c.id}.html`), 'utf8')), await staticTree(body));
    if (d.length) diffs.push({ id: c.id, msg: d.join(' | ') });
  }
  await ctx.close();
  return { status: diffs.length ? 'COMPARED (differences)' : 'COMPARED (equal)', probe, requests, diffs };
}

// ---------- main ----------
function printAndWrite(report) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const L = [];
  L.push('compare: R1 checks equivalence with the REFERENCE RENDER of the original templates (twig.js on both sides),');
  L.push('         not with the real PHP server (template-engine fidelity risk, requirements.md section 8).');
  const r1 = report.r1;
  L.push(`R1: ${r1.matched}/${r1.total} cases matched, ${r1.differing} differing; hash-verified original templates: ${r1.templateFiles}`);
  for (const [k, v] of Object.entries(r1.byCategory)) L.push(`    ${k}: ${v}`);
  L.push(`    expected normalizations (FR-16 removals) reference side: ${JSON.stringify(r1.normalized.reference)}; local side: ${JSON.stringify(r1.normalized.local)}`);
  L.push(`    cases whose Tableau request carries Year: ${r1.withYear} of ${r1.withTableau} that requested Tableau`);
  for (const c of r1.results.filter((x) => x.diffs.length).slice(0, 12)) {
    L.push(`  DIFF ${c.id}`);
    for (const d of c.diffs.slice(0, 3)) L.push(`      [${d.cat}] ${d.msg.slice(0, 300)}`);
  }
  L.push(`R2: ${report.r2.status}${report.r2.page ? ' -> ' + report.r2.page : ' ' + (report.r2.detail || '')}`);
  L.push(`R3: ${report.r3.status}${report.r3.probe && report.r3.probe.error ? ' (' + report.r3.probe.error + ')' : ''}`);
  console.log(L.join('\n'));
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'home.html'))) {
    console.error('compare: dist/ is missing or incomplete; run `npm run build` first');
    return 2;
  }
  const cases = loadMatrix();
  const rendered = renderAll({ outDir: CACHE_REF, rawDir: CACHE_RAW, cases });
  const refServer = await startServer({ roots: [CACHE_REF, DIST], rules: false, port: REF_PORT });
  const locServer = await startServer({ roots: [DIST], rules: true, port: LOCAL_PORT });
  const browser = await chromium.launch();
  let exit = 0;
  try {
    const r1 = await runR1(browser, cases);
    const byCategory = {};
    for (const c of r1.results) for (const d of c.diffs) byCategory[d.cat] = (byCategory[d.cat] || 0) + 1;
    const differing = r1.results.filter((c) => c.diffs.length).length;
    const r1Summary = {
      total: cases.length, matched: cases.length - differing, differing, byCategory,
      templateFiles: rendered.templateFiles, normalized: r1.normalized,
      withTableau: r1.results.filter((c) => c.tableauRequests > 0).length,
      withYear: r1.results.filter((c) => c.tableauHasYear).length,
      results: r1.results,
    };
    const r2 = await runR2(browser).catch((e) => ({ status: 'FAILED', detail: e.message }));
    const r3 = await runR3(browser, cases);
    printAndWrite({
      generatedAt: new Date().toISOString(),
      statements: {
        'FR-23 (AND IT MUST)': 'R1 checks equivalence with the reference render of the original templates (twig.js on both sides), not with the real PHP server (template-engine fidelity risk, requirements.md section 8).',
      },
      declaredLimits: [
        'R1 shares scripts/twig-config.mjs (engine configuration) with the build, on purpose (DD-05, DD-09).',
        'R1 shares src/data/site.json with the build: sections, crps, years, chartsInfo, messages, dataUrl and appConfig are data supplied to the reference route, so a wrong data row would not be detected by R1.',
        'twig.js on both sides does not detect differences from PHP Twig; non-canonical years (JS == vs PHP ==) are outside the matrix (design 10.2).',
        'reference/routes-reference.mjs follows PHP 7 for year > 2017 with non-numeric strings (equals D19 on the matrix values).',
      ],
      deviations: [
        'Design 10.2 R1 step 2 uses one server on 8082 with --no-rules --root .cache/reference --root dist. This run uses two servers instead: 8095 (reference, --no-rules, roots .cache/reference then dist) and 8096 (local, rules on, root dist), so the local side goes through the real rules and the reference side does not.',
      ],
      r1: r1Summary, r2, r3,
    });
    if (differing > 0 || r2.status !== 'GENERATED') exit = 1;
  } finally {
    await browser.close();
    await refServer.close();
    await locServer.close();
  }
  return exit;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
}
