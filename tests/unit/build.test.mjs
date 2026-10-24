// T-08: build pipeline (design 7.1; FR-02, FR-03, FR-04, FR-05, FR-16, FR-17, FR-19, FR-29).
// Every build runs in a child process into its own temporary folder (Y-3).
// Expected values are literals from the requirements/design, not recomputed from the code.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { runBuild, tempDir, cleanupTemp, ROOT } from '../helpers/build-run.mjs';
import { loadCore } from '../../scripts/load-core.mjs';
import { loadSite, validateSite, rdData, routableSections, SiteDataError } from '../../scripts/site-data.mjs';
import { checkRefGraph } from '../../scripts/refgraph.mjs';
import { runHygiene } from '../../scripts/hygiene.mjs';
import os from 'node:os';
import { mapCdns, assertSafeOutDir, BuildError } from '../../scripts/build.mjs';

const SECTIONS_17 = ['home', 'geographicScope', 'partners', 'SDG', 'systemLevelOutcomes', 'caseReports',
  'innovations', 'policies', 'milestones', 'partnerships', 'capDev', 'altmetric', 'publications', 'MELIA',
  'genebanks', 'glossary', 'ethiopia'];
const site = loadSite();
const rd = (outDir, rel) => fs.readFileSync(path.join(outDir, ...rel.split('/')), 'utf8');
const walk = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());

let first;
before(() => { first = runBuild(); });
after(cleanupTemp);

test('npm run build exits 0 and prints the summary (FR-02)', () => {
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Build OK/);
  assert.match(first.stdout, /html: 55/);
  assert.match(first.stdout, /manifest sha256: [0-9a-f]{64}/);
});

test('55 HTML files: 17 sections x 3 variants + partnerships-2017 x 3 + 404 (DD-01, design 4.1)', () => {
  const html = walk(first.outDir).filter((e) => e.name.endsWith('.html')).map((e) => e.name).sort();
  assert.equal(html.length, 55);
  const expected = [];
  for (const s of [...SECTIONS_17, 'partnerships-2017']) for (const v of ['', '--embed', '--embed-nonav']) expected.push(`${s}${v}.html`);
  expected.push('404.html');
  assert.deepEqual(html, expected.sort());
  assert.deepEqual(routableSections(site), SECTIONS_17);
});

test('variants differ as the design says: embed hides the page header, sentinel only in embed menu links (P-3, Y-5)', () => {
  const normal = rd(first.outDir, 'innovations.html');
  const embed = rd(first.outDir, 'innovations--embed.html');
  const nonav = rd(first.outDir, 'innovations--embed-nonav.html');
  assert.ok(!normal.includes('RDHOSTORIGINSENTINEL'));
  assert.match(embed, /href="\.\/policies\?embed=true&amp;hostOrigin=RDHOSTORIGINSENTINEL&amp;displayNav=true"/);
  assert.match(nonav, /displayNav=false/);
  assert.match(embed, /class="filters1"/); // embed printed as 1 (P-3)
  assert.ok(!/class="filters1"/.test(normal));
  assert.ok(normal.includes('id="pageheader"'));
  assert.ok(!embed.includes('id="pageheader"'));
});

test('partnerships variants use the 2018+ and the legacy template (FR-09 build side)', () => {
  const modern = rd(first.outDir, 'partnerships.html');
  const legacy = rd(first.outDir, 'partnerships-2017.html');
  assert.match(modern, /js\/partnerships-2018\.js/);
  assert.match(legacy, /js\/partnerships\.js/);
  assert.ok(!legacy.includes('partnerships-2018.js'));
});

test('widget/main.js: sectionsJson has the 19 active entries, duplicates and ethiopia included (FR-12, design 7.1 step 5)', () => {
  const js = rd(first.outDir, 'widget/main.js');
  const m = /return \("([^"]*)"\)\.replace\(\/&quot;\/g,'"'\)/.exec(js);
  assert.ok(m, 'getSections literal not found');
  const list = JSON.parse(m[1].replace(/&quot;/g, '"'));
  assert.equal(list.length, 19);
  assert.equal(list.filter((s) => s === 'geographicScope').length, 2);
  assert.equal(list.at(-1), 'ethiopia');
});

test('404.html is standalone with root-absolute URLs (DD-16)', () => {
  const html = rd(first.outDir, '404.html');
  assert.match(html, /href="\/css\/global\.css\?20200806b"/);
  assert.ok(!/(?:src|href)="\.\//.test(html));
});

test('CDN URLs are replaced by ./third-party/ paths, keeping the query suffix (FR-17, step 4)', () => {
  const home = rd(first.outDir, 'home.html');
  assert.match(home, /href="\.\/third-party\/bootstrap\/css\/bootstrap\.min\.css\?20200806b"/);
  assert.match(home, /href="\.\/third-party\/fontawesome\/css\/all\.css\?20200806b"/);
  assert.match(home, /href="\.\/third-party\/animate\/animate\.min\.css"/);
  for (const e of walk(first.outDir).filter((x) => x.name.endsWith('.html'))) {
    const text = fs.readFileSync(path.join(e.parentPath, e.name), 'utf8');
    for (const host of ['stackpath.bootstrapcdn.com', 'use.fontawesome.com', 'cdnjs.cloudflare.com']) {
      assert.ok(!text.includes(host), `${e.name} still references ${host}`);
    }
  }
  assert.match(rd(first.outDir, 'glossary.html'), /src="\.\/third-party\/jquery-csv\/jquery\.csv\.min\.js/);
});

test('self-hosted libraries are the npm files; Font Awesome css/all.css is all.min.css; 15 webfonts (FR-17, T-04)', () => {
  const same = (outRel, nmRel) => assert.ok(
    fs.readFileSync(path.join(first.outDir, ...outRel.split('/'))).equals(fs.readFileSync(path.join(ROOT, 'node_modules', ...nmRel.split('/')))), outRel);
  same('third-party/fontawesome/css/all.css', '@fortawesome/fontawesome-free/css/all.min.css');
  same('third-party/bootstrap/css/bootstrap.min.css', 'bootstrap/dist/css/bootstrap.min.css');
  same('third-party/animate/animate.min.css', 'animate.css/animate.min.css');
  same('third-party/jquery-csv/jquery.csv.min.js', 'jquery-csv/src/jquery.csv.min.js');
  same('third-party/fontawesome/webfonts/fa-solid-900.woff2', '@fortawesome/fontawesome-free/webfonts/fa-solid-900.woff2');
  assert.equal(fs.readdirSync(path.join(first.outDir, 'third-party/fontawesome/webfonts')).length, 15);
  assert.ok(!fs.existsSync(path.join(first.outDir, 'vendor')));
});

test('excludeAssets are absent, everything else in src/public is copied byte for byte (FR-03, P-25)', () => {
  for (const gone of ['js/newRelic.js', 'js/libs/jquery/jquery-3.3.1.min.js', 'js/libs/sly', 'js/oicr.js', 'json/innovations.json', 'images/svg']) {
    assert.ok(!fs.existsSync(path.join(first.outDir, gone)), `${gone} must not be published`);
  }
  for (const keep of ['js/svg-interactive.js', 'js/libs/snap/snap.svg-min.js', 'js/libs/jquery/jquery-3.4.1.min.js', 'images/svg-interactive.svg']) {
    assert.ok(fs.readFileSync(path.join(first.outDir, keep)).equals(fs.readFileSync(path.join(ROOT, 'src', 'public', keep))), keep);
  }
  // src/public already excludes the list (T-01), so every file in it is published.
  const pub = path.join(ROOT, 'src', 'public');
  const rels = walk(pub).map((e) => path.relative(pub, path.join(e.parentPath, e.name)).replace(/\\/g, '/'));
  assert.equal(rels.length, 118);
  for (const rel of rels) assert.ok(fs.existsSync(path.join(first.outDir, ...rel.split('/'))), rel);
});

test('a file listed in excludeAssets is not copied even when it is present in src/public (design 7.1 step 6)', () => {
  const src = copySrc();
  fs.writeFileSync(path.join(src, 'public', 'js', 'oicr.js'), '// excluded');
  fs.mkdirSync(path.join(src, 'public', 'images', 'svg'), { recursive: true });
  fs.writeFileSync(path.join(src, 'public', 'images', 'svg', 'x.svg'), '<svg/>');
  const r = runBuild({ srcDir: src });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(r.outDir, 'js', 'oicr.js')));
  assert.ok(!fs.existsSync(path.join(r.outDir, 'images', 'svg')));
});

test('js/legacy-compat.js is an IIFE exposing window.RDLegacyCompat and the runtime scripts run on it (design 7.7)', () => {
  const win = { URLSearchParams, location: { search: '?year=2019&entity=CCAFS' } };
  win.window = win;
  win.document = { currentScript: { dataset: { rdProduction: 'true', rdTableauView: 'https://t.test/v/', rdTableauViewNew: 'https://t.test/n/', rdForceRefresh: 'false' } } };
  const ctx = vm.createContext(win);
  vm.runInContext(rd(first.outDir, 'js/legacy-compat.js'), ctx);
  assert.deepEqual(Object.keys(win.RDLegacyCompat).sort(), ['isNumericYear', 'lastValue', 'twigEscapeHtml', 'yearAfter2017', 'yearMatches']);
  assert.equal(win.RDLegacyCompat.yearAfter2017('2019'), true);
  vm.runInContext(rd(first.outDir, 'js/rd-params.js'), ctx);
  assert.equal(win.appConfig.yearSelected, '2019');
  assert.equal(win.appConfig.entitySelected, 'CCAFS');
  assert.equal(win.appConfig.production, true);
  assert.equal(vm.runInContext('typeof isNumericYear', ctx), 'function');
});

test('the sentinel appears only in embed HTML and js/rd-apply.js; hygiene is clean on the real output (FR-03, FR-29, Y-5)', () => {
  assert.deepEqual(runHygiene({ outDir: first.outDir, sentinel: site.sentinel }), []);
  assert.ok(rd(first.outDir, 'js/rd-apply.js').includes('RDHOSTORIGINSENTINEL'));
});

test('no localhost, ports or absolute 127.0.0.1 in the output (FR-04 BUT)', () => {
  for (const e of walk(first.outDir).filter((x) => /\.(html|css|js|json|svg)$/.test(x.name))) {
    const abs = path.join(e.parentPath, e.name);
    const text = fs.readFileSync(abs, 'utf8');
    assert.ok(!/localhost|127\.0\.0\.1|https?:\/\/[\w.-]+:\d{2,5}\b/.test(text), `${e.name} mentions a local origin`);
  }
});

test('build records stats, manifest and one history line outside dist/ (step 11, Y-3)', () => {
  const manifest = first.manifest();
  assert.equal(manifest.fileCount, walk(first.outDir).length);
  assert.match(manifest.hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(manifest).includes(first.base.replace(/\\/g, '\\\\')), 'manifest holds no absolute path');
  const lines = fs.readFileSync(path.join(first.artifacts, 'build-history.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.budgetMs, 60000);
  assert.equal(rec.clean, true);
  assert.equal(rec.idle, false);
  assert.equal(typeof rec.elapsedMs, 'number');
  assert.equal(rec.manifestHash, manifest.hash);
  assert.equal(rec.node, process.version);
  assert.ok(fs.existsSync(path.join(first.artifacts, 'build-stats.json')));
  assert.ok(!fs.existsSync(path.join(first.outDir, 'artifacts')) && !fs.existsSync(path.join(first.outDir, 'build-history.jsonl')));
});

test('determinism: two builds into two separate temp folders give identical manifests (FR-02)', () => {
  const second = runBuild();
  assert.equal(second.status, 0, second.stderr);
  assert.notEqual(second.outDir, first.outDir);
  const a = first.manifest();
  const b = second.manifest();
  assert.equal(a.hash, b.hash);
  assert.deepEqual(a.files, b.files);
});

test('BUILD_OUT_DIR redirects the whole output: nothing is written under the repo dist/ by a test build', () => {
  assert.ok(first.outDir.startsWith(first.base));
  assert.ok(fs.existsSync(first.artifacts));
});

// ---- red run and failure paths -------------------------------------------------------------

function copySrc() {
  const dir = path.join(tempDir('rd-src-'), 'src');
  fs.cpSync(path.join(ROOT, 'src'), dir, { recursive: true });
  return dir;
}

test('RED RUN: a template referencing ./css/missing.css fails the build, naming template and resource (FR-19)', () => {
  const src = copySrc();
  const header = path.join(src, 'templates', 'pages', 'header.twig');
  fs.writeFileSync(header, fs.readFileSync(header, 'utf8').replace('<link href=\'./css/global.css?20200806b\'', '<link href="./css/missing.css" rel="stylesheet">\n\t\t<link href=\'./css/global.css?20200806b\''));
  const r = runBuild({ srcDir: src });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /BUILD FAILED at step 7 \(reference graph\)/);
  assert.match(r.stderr, /innovations\.html \(template innovations\.twig\): <link href> \.\/css\/missing\.css/);
  assert.match(r.stderr, /text found in template\(s\): pages\/header\.twig/);
});

test('a missing template fails the build naming it (step 3)', () => {
  const src = copySrc();
  fs.rmSync(path.join(src, 'templates', 'MELIA.twig'));
  const r = runBuild({ srcDir: src });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /step 3 \(render variants\)/);
  assert.match(r.stderr, /missing template MELIA\.twig/);
});

test('an excludeAssets entry that the SVG still loads fails on the SVG xlink:href (P-25, FR-19)', () => {
  const src = copySrc();
  const f = path.join(src, 'data', 'site.json');
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  data.excludeAssets.push('js/svg-interactive.js');
  fs.writeFileSync(f, JSON.stringify(data));
  const r = runBuild({ srcDir: src });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /images\/svg-interactive\.svg: <script xlink:href> \.\.\/js\/svg-interactive\.js/);
});

test('a null in site.json fails step 2 (T-02 knownDivergences assume no null)', () => {
  const src = copySrc();
  const f = path.join(src, 'data', 'site.json');
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  data.crps[1].acronym = null;
  fs.writeFileSync(f, JSON.stringify(data));
  const r = runBuild({ srcDir: src });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /step 2 \(load data\)/);
  assert.match(r.stderr, /site\.crps\[1\]\.acronym is null/);
});

test('assertSafeOutDir refuses roots, the repo root, ancestors, src/, .git/ and the temp dir itself; allows dist and temp subfolders', () => {
  const win = process.platform === 'win32';
  const driveRoot = path.parse(ROOT).root;
  const bad = [driveRoot, ROOT, path.dirname(ROOT), path.join(ROOT, 'src'), path.join(ROOT, 'src', 'public'), path.join(ROOT, 'reference'),
    path.join(ROOT, 'node_modules'), path.join(ROOT, '.git'), path.join(ROOT, 'scripts'), os.tmpdir(), os.tmpdir() + path.sep, path.join(ROOT, 'dist', '..', 'src')];
  if (win) bad.push('C:\\', 'D:\\', '\\\\?\\' + path.join(ROOT, 'src'), '\\\\?\\' + ROOT, ROOT.toUpperCase() + path.sep);
  else bad.push('/');
  for (const dir of bad) {
    assert.throws(() => assertSafeOutDir(dir, ROOT), (e) => e instanceof BuildError && /refusing to use .* as the output folder/.test(e.message), dir);
  }
  const good = [path.join(ROOT, 'dist'), path.join(ROOT, 'dist', 'nested'), tempDir('rd-guard-'), path.join(tempDir('rd-guard-'), 'dist')];
  for (const dir of good) assert.doesNotThrow(() => assertSafeOutDir(dir, ROOT), dir);
});

test('assertSafeOutDir protects a repository that lives inside the temp directory', () => {
  const fakeTmp = path.join(path.parse(ROOT).root, 'fake-tmp');
  const repo = path.join(fakeTmp, 'clone', 'results-dashboard-static');
  for (const dir of [repo, path.join(repo, 'src'), path.join(repo, 'src', 'public'), path.join(repo, '.git'), path.join(repo, '.git', 'objects'),
    path.join(repo, 'reference'), path.join(repo, 'node_modules'), path.join(repo, 'scripts'), path.join(repo, 'tests'),
    path.dirname(repo), fakeTmp, fakeTmp + path.sep, path.parse(repo).root]) {
    assert.throws(() => assertSafeOutDir(dir, repo, fakeTmp), (e) => e instanceof BuildError && /refusing to use/.test(e.message), dir);
  }
  for (const dir of [path.join(repo, 'dist'), path.join(repo, 'dist', 'x'), path.join(fakeTmp, 'rd-build-abc'), path.join(fakeTmp, 'rd-build-abc', 'dist')]) {
    assert.doesNotThrow(() => assertSafeOutDir(dir, repo, fakeTmp), dir);
  }
});

test('validateSite rejects a missing key and accepts the shipped data', () => {
  assert.doesNotThrow(() => validateSite(structuredClone(site)));
  const broken = structuredClone(site);
  delete broken.cdnMap;
  assert.throws(() => validateSite(broken), (e) => e instanceof SiteDataError && /missing key "cdnMap"/.test(e.message));
});

test('an unmapped URL on a self-hosted CDN domain is an error (step 4)', () => {
  const problems = [];
  const out = mapCdns('<link href="https://cdnjs.cloudflare.com/ajax/libs/other/1.0/x.css"><script src="https://example.org/a.js"></script>', site.cdnMap, 'x.html', problems);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /x\.html: URL of a self-hosted domain is not in cdnMap: https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/other\/1\.0\/x\.css/);
  assert.match(out, /https:\/\/example\.org\/a\.js/); // unrelated hosts stay
});

// ---- reference graph on synthetic outputs ---------------------------------------------------

const core = loadCore({ RD_DATA: rdData(site), URLSearchParams }, 'src/runtime/legacy-compat.core.js', 'src/routing/rules.core.js');
const resolve = (req, mode) => JSON.parse(JSON.stringify(core.resolve(req, mode)));
function graph(files, over = {}) {
  const dir = tempDir('rd-graph-');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return checkRefGraph({ outDir: dir, site: { excludeAssets: [], runtimeAssets: [], ...over }, resolve, lastValue: core.lastValue });
}
const PAGE = (body) => `<html><head></head><body>${body}</body></html>`;
const BASE = { 'innovations.html': PAGE(''), 'innovations--embed.html': PAGE(''), 'home.html': PAGE(''), 'js/a.js': '', 'css/a.css': '', 'images/a.png': 'x', 'css/b.css': 'x' };

test('refgraph: a clean page, a whitespace-padded href, absolute and fragment links pass', () => {
  const f = graph({
    ...BASE,
    'glossary.html': PAGE('<script src="./js/a.js"></script><link href="./css/a.css?v=1" rel="stylesheet"><img src="/images/a.png">'
      + '<a href=" https://doi.org/x">d</a><a href="#top">t</a><a href="mailto:a@b.c">m</a><a href="./innovations?embed=true&amp;hostOrigin=H&amp;displayNav=true">n</a>'
      + '<a href="//cdn.example/x">p</a><script>var s = \'<a href="./nope">\';</script><!-- <img src="./gone.png"> -->'),
  });
  assert.deepEqual(f, []);
});

test('refgraph: missing script, stylesheet, image and wrong case are reported with container and resource', () => {
  const f = graph({ ...BASE, 'glossary.html': PAGE('<script src="./js/missing.js"></script><link href="./css/MISSING.css"><img src="./images/A.png">') });
  assert.deepEqual(f.map((x) => `${x.file} ${x.kind} ${x.resource}`).sort(), [
    'glossary.html <img src> ./images/A.png', 'glossary.html <link href> ./css/MISSING.css', 'glossary.html <script src> ./js/missing.js']);
});

test('refgraph: CSS url() resolves against the CSS file and a missing target is reported', () => {
  const f = graph({ ...BASE, 'css/c.css': 'a{background:url("../images/a.png")} b{background:url(../images/gone.png)} c{background:url(data:image/png;base64,AA)}' });
  assert.deepEqual(f.map((x) => `${x.file} ${x.resource}`), ['css/c.css ../images/gone.png']);
});

test('refgraph: SVG script, image and use references with a path part must exist (P-25)', () => {
  const svg = '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><script xlink:href="../js/a.js"/><script xlink:href="../js/missing.js"/><use xlink:href="#id"/><image xlink:href="../images/gone.png"/></svg>';
  const f = graph({ ...BASE, 'images/s.svg': svg });
  assert.deepEqual(f.map((x) => `${x.kind} ${x.resource}`).sort(), ['<image xlink:href> ../images/gone.png', '<script xlink:href> ../js/missing.js']);
});

test('refgraph: runtimeAssets must exist', () => {
  const f = graph(BASE, { runtimeAssets: ['images/a.png', 'csv/none.csv'] });
  assert.deepEqual(f.map((x) => x.resource), ['csv/none.csv']);
});

test('refgraph: <a href> to an unknown route, to a bad route and to a missing static file fail; legacy and variants pass (Y-9)', () => {
  const links = ['./nope', './policies?x=1', './glossary', './innovationsV1', './files/x.pdf', './images/a.png', '/innovations?embed=true&displayNav=false', './a//b'];
  const f = graph({ ...BASE, 'policies.html': PAGE(''), 'glossary.html': PAGE(links.map((l) => `<a href="${l}">x</a>`).join('')), 'glossary--embed.html': PAGE('') });
  const got = Object.fromEntries(f.map((x) => [x.resource, x.reason]));
  assert.match(got['./nope'], /notFound/);
  assert.match(got['./files/x.pdf'], /static link to missing file \(files\/x\.pdf\)/);
  assert.match(got['./a//b'], /static link to missing file/); // a pass result must name an existing file
  assert.equal(got['./policies?x=1'], undefined); // policies.html exists in this fixture
  assert.equal(got['./innovationsV1'], undefined); // legacy name: redirect, allowed
  assert.equal(got['./images/a.png'], undefined);
});

test('refgraph: a route whose rewrite target is missing fails', () => {
  const f = graph({ 'home.html': PAGE('<a href="./altmetric?embed=true&displayNav=true">x</a>') });
  assert.deepEqual(f.map((x) => x.reason), ['route rewrites to missing file altmetric--embed.html']);
});

test('refgraph: any reference into excludeAssets is reported even for a prefix entry', () => {
  const f = graph({ ...BASE, 'glossary.html': PAGE('<script src="./js/libs/sly/x.js"></script>') }, { excludeAssets: ['js/libs/sly/'] });
  assert.match(f[0].reason, /points into excludeAssets \(js\/libs\/sly\/x\.js\)/);
});

// ---- hygiene on synthetic outputs ------------------------------------------------------------

function hygieneOf(files) {
  const dir = tempDir('rd-hyg-');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return runHygiene({ outDir: dir, sentinel: 'RDHOSTORIGINSENTINEL' }).map((x) => `${x.file}:${x.rule}`).sort();
}

test('hygiene flags forbidden files, folders and content (design 7.1 step 9)', () => {
  assert.deepEqual(hygieneOf({
    'a.php': 'x', 'b.twig': 'x', 'c/.htaccess': 'x', 'composer.json': '{}', 'vendor/x.js': '', 'node_modules/y.js': '',
    'js/newRelic.js': '', 'p.html': '<?php echo 1; ?>', 'q.html': '<?= 1 ?>', 'r.html': '<!--#include virtual="x" -->',
    's.js': 'var licenseKey="abc"', 't.js': '-----BEGIN RSA PRIVATE KEY-----', 'u.js': 'var password = "hunter22"',
    'third-party/lib/x.js': 'var u="http://localhost:8080/"', 'js/libs/y.js': 'fetch("http://127.0.0.1:8090")',
    'v.html': '<a href="./x.php?y=1">', 'w.html': 'http://192.0.2.50/x', 'x.html': 'http://localhost:8080/', 'y.html': 'http://example.org:9000/z',
  }), [
    'a.php:forbidden-extension', 'b.twig:forbidden-extension', 'c/.htaccess:forbidden-extension', 'c/.htaccess:forbidden-file',
    'composer.json:forbidden-file', 'js/libs/y.js:host-port', 'js/libs/y.js:loopback-ip', 'js/newRelic.js:forbidden-file', 'node_modules/y.js:forbidden-folder', 'p.html:php-open-tag',
    'q.html:php-open-tag', 'r.html:server-side-include', 's.js:licenseKey', 't.js:private-key', 'third-party/lib/x.js:host-port', 'third-party/lib/x.js:localhost', 'u.js:password-literal',
    'v.html:php-url', 'vendor/x.js:forbidden-folder', 'w.html:internal-ip', 'x.html:host-port', 'x.html:localhost', 'y.html:host-port',
  ]);
});

test('hygiene allows the sentinel only in embed HTML and js/rd-apply.js (Y-5)', () => {
  const S = 'RDHOSTORIGINSENTINEL';
  assert.deepEqual(hygieneOf({ 'a--embed.html': S, 'a--embed-nonav.html': S, 'js/rd-apply.js': S }), []);
  assert.deepEqual(hygieneOf({ 'a.html': S, 'js/other.js': S, 'x.css': S }), ['a.html:sentinel', 'js/other.js:sentinel', 'x.css:sentinel']);
});
