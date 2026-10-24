// T-05: template edits (FR-05, FR-12, FR-13 404 page, FR-16; design 8, DD-04/07/16).
// Behavior of the widget in a real browser is proven by T-14, not here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { listFiles } from '../../scripts/verify-original.mjs';
import { createRenderer } from '../../scripts/twig-config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'src', 'templates');
const REF = join(ROOT, 'reference', 'templates-original');
const site = JSON.parse(readFileSync(join(ROOT, 'src', 'data', 'site.json'), 'utf8'));
const read = (name) => readFileSync(join(SRC, name), 'utf8');
const renderer = createRenderer({ templatesRoot: SRC });

// Independent source of truth: design 8 table (DD-04).
const EDITED = ['pages/footer.twig', 'pages/header.twig', 'widget.twig'];
const ADDED = ['404.twig'];

function pageContext(over = {}) {
  return {
    sections: site.sections, crps: site.crps, years: site.years, chartsInfo: site.chartsInfo,
    messagesArray: site.messages, dataUrl: site.dataUrl,
    currentSection: 'innovations', entitySelected: '', yearSelected: 2021,
    forceRefresh: false, embed: false, displayNav: true, hostOrigin: '', glossarySection: false,
    appConfig: site.appConfig, queryParams: '',
    pageParams: { title: 'T', customCSS: ['./css/x.css'], customJS: ['./js/x.js'] },
    ...over,
  };
}

// ---- diff test (DD-04) ----
test('only header, footer and widget differ from the original; 404.twig is the only new file', () => {
  const ref = listFiles(REF);
  const cur = listFiles(SRC);
  const changed = ref.filter((f) => existsSync(join(SRC, f)) &&
    !readFileSync(join(REF, f)).equals(readFileSync(join(SRC, f))));
  assert.deepEqual(changed.sort(), EDITED, 'files that differ from reference/templates-original');
  assert.deepEqual(ref.filter((f) => !cur.includes(f)), [], 'no template removed');
  assert.deepEqual(cur.filter((f) => !ref.includes(f)).sort(), ADDED, 'files not in the original');
});

// ---- header (FR-05 BUT, FR-16, FR-07 contract) ----
test('header source has no inline appConfig, no Google Analytics, no UA id', () => {
  const h = read('pages/header.twig');
  assert.doesNotMatch(h, /var appConfig/);
  assert.doesNotMatch(h, /Application config parameters/);
  assert.doesNotMatch(h, /googletagmanager|gtag|dataLayer|UA-\d/);
});

test('header renders legacy-compat.js then rd-params.js with data-rd-* attributes, and no inline script', () => {
  const html = renderer.render('pages/header.twig', pageContext());
  const iCompat = html.indexOf('<script src="./js/legacy-compat.js"');
  const iParams = html.indexOf('<script src="./js/rd-params.js"');
  assert.ok(iCompat > -1, 'legacy-compat.js tag present');
  assert.ok(iParams > iCompat, 'rd-params.js after legacy-compat.js');
  assert.ok(iParams < html.indexOf('</head>'), 'both in <head>');
  const tag = html.slice(iParams, html.indexOf('>', iParams) + 1);
  assert.match(tag, /data-rd-production="true"/);
  assert.ok(tag.includes(`data-rd-tableau-view="${site.appConfig.tableauView}"`), tag);
  assert.ok(tag.includes(`data-rd-tableau-view-new="${site.appConfig.tableauViewNew}"`), tag);
  assert.match(tag, /data-rd-force-refresh="false"/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline <script> in the rendered header');
  assert.doesNotMatch(html, /googletagmanager|gtag|appConfig/);
});

test('header data attributes are HTML-escaped (no attribute breakout) and booleans follow the context', () => {
  const html = renderer.render('pages/header.twig', pageContext({
    forceRefresh: true,
    appConfig: { production: false, tableauView: 'a"><script>x</script>', tableauViewNew: "b'&c" },
  }));
  const iParams = html.indexOf('<script src="./js/rd-params.js"');
  const tag = html.slice(iParams, html.indexOf('</script>', iParams) + 9);
  assert.match(tag, /data-rd-production="false"/);
  assert.match(tag, /data-rd-force-refresh="true"/);
  assert.ok(tag.includes('data-rd-tableau-view="a&quot;&gt;&lt;script&gt;x&lt;/script&gt;"'), tag);
  assert.ok(tag.includes('data-rd-tableau-view-new="b&#039;&amp;c"'), tag);
  assert.ok(html.includes('./js/newRelic.js'), 'non-production branch of the original is untouched');
});

// ---- footer (P-28) ----
test('footer loads rd-apply.js before jQuery and keeps the original script order', () => {
  const html = renderer.render('pages/footer.twig', pageContext());
  const iApply = html.indexOf('<script src="./js/rd-apply.js"');
  const iJq = html.indexOf('./js/libs/jquery/jquery-3.4.1.min.js');
  assert.ok(iApply > -1, 'rd-apply.js tag present');
  assert.ok(iApply < iJq, 'rd-apply.js before jQuery');
  const order = ['jquery-3.4.1', 'popper.min', 'bootstrap.min', 'url.min', 'tableau-2.8.0',
    'tableauFunctions.js', 'global.js', './js/x.js'].map((s) => html.indexOf(s));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'original order kept');
  assert.ok(html.trimEnd().endsWith('</body>\n</html>'));
});

// ---- widget (DD-07, P-14, P-29) ----
const SECTIONS_JSON = '["home","a\'b"]';
const widgetSrc = () => renderer.render('widget.twig', { sectionsJson: SECTIONS_JSON });

test('widget keeps getSections/sectionsJson exactly and has no baseURL/baseOrigin template variables', () => {
  const src = widgetSrc();
  assert.ok(src.includes('("[&quot;home&quot;,&quot;a&#039;b&quot;]").replace(/&quot;/g,\'"\')'));
  assert.doesNotMatch(read('widget.twig'), /\{\{\s*base(URL|Origin)/);
});

test('widget source: outer non-strict wrapper called with .call(this), captures currentScript first', () => {
  const src = read('widget.twig');
  assert.match(src.trimEnd(), /\}\)\.call\(this\);$/);
  assert.match(src, /^\(function \(\) \{\s*\n(\s*\/\/[^\n]*\n)*\s*var \w+ = document\.currentScript;/);
  assert.ok(src.indexOf("'use strict'") > src.indexOf('currentScript'), 'strict mode only inside the factory');
  assert.match(src, /\/widget\/main\.js/);
});

// Minimal DOM double: just enough to evaluate the rendered file and construct a widget.
function load({ currentScriptSrc, scripts = [], hostOrigin = 'http://localhost:8081', amd = false }) {
  const doc = {
    currentScript: currentScriptSrc === undefined ? null : { src: currentScriptSrc },
    scripts,
    getElementsByTagName: () => scripts,
    baseURI: 'http://localhost:8081/page.html',
    location: { origin: hostOrigin },
    getElementById: () => ({ nodeName: 'DIV', appendChild() {} }),
    getElementsByClassName: () => [],
    createElement: () => ({ setAttribute() {}, style: {} }),
  };
  const win = { document: doc, URL, addEventListener() {} };
  const ctx = vm.createContext(win);
  ctx.window = win;
  if (amd) {
    ctx.define = Object.assign((f) => { ctx.__factory = f; }, { amd: true });
  }
  vm.runInContext(widgetSrc(), ctx);
  return ctx;
}

test('widget base URL and origin come from the script URL, hostOrigin from the host (FR-12 scenario)', () => {
  const ctx = load({ currentScriptSrc: 'http://localhost:8080/widget/main.js?v=3' });
  const w = new ctx.ResultsDashboardWidget('el', { currentSection: 'policies' });
  assert.equal(w.baseOrigin, 'http://localhost:8080');
  assert.equal(w.baseURL, 'http://localhost:8080');
  assert.equal(w.hostOrigin, 'http://localhost:8081');
});

test('widget keeps a non-root base path from the script URL', () => {
  const ctx = load({ currentScriptSrc: 'https://cdn.example.org/rd/widget/main.js' });
  const w = new ctx.ResultsDashboardWidget('el', {});
  assert.equal(w.baseOrigin, 'https://cdn.example.org');
  assert.equal(w.baseURL, 'https://cdn.example.org/rd');
});

test('widget falls back to the last script whose pathname ends /widget/main.js (async/defer)', () => {
  const ctx = load({
    currentScriptSrc: undefined,
    scripts: [
      { src: 'http://localhost:8081/other.js' },
      { src: 'http://localhost:8080/widget/main.js?v=1' },
      { src: 'http://localhost:9999/x/widget/main.js.map' },
      { src: '' },
    ],
  });
  const w = new ctx.ResultsDashboardWidget('el', {});
  assert.equal(w.baseURL, 'http://localhost:8080');
});

test('widget fallback is used when the loader hides currentScript (AMD defers the factory)', () => {
  const ctx = load({ currentScriptSrc: 'http://localhost:8080/widget/main.js', amd: true });
  assert.equal(typeof ctx.__factory, 'function', 'define(factory) called');
  const W = ctx.__factory();
  const w = new W('el', {});
  assert.equal(w.baseOrigin, 'http://localhost:8080');
});

test('widget raises an explicit error when the script URL cannot be resolved', () => {
  assert.throws(
    () => load({ currentScriptSrc: undefined, scripts: [{ src: 'http://localhost:8081/other.js' }] }),
    /widget\/main\.js/,
  );
});

test('widget does not take the base from the host location', () => {
  const ctx = load({ currentScriptSrc: 'http://localhost:8080/widget/main.js', hostOrigin: 'http://evil.example' });
  const w = new ctx.ResultsDashboardWidget('el', {});
  assert.notEqual(w.baseOrigin, 'http://evil.example');
});

// ---- 404 (FR-13, DD-16) ----
test('404.twig is standalone: no includes/imports, no scripts, root-absolute URLs only', () => {
  const src = read('404.twig');
  assert.doesNotMatch(src, /\{%\s*(include|import|extends|embed|from)/);
  const html = renderer.render('404.twig', {});
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /tableau|filter/i);
  assert.match(html, /Page not found/);
  assert.match(html, /<a [^>]*href="\/"/);
  assert.match(html, /<a [^>]*href="\/glossary"/);
  const urls = [...html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)].map((m) => m[1]);
  assert.ok(urls.length >= 3);
  for (const u of urls) {
    assert.ok(/^(\/(?![/\\])|https:\/\/|#)/.test(u), `not root-absolute or external: ${u}`);
  }
  assert.ok(urls.some((u) => u.startsWith('/css/')) && urls.some((u) => u.startsWith('/images/')));
  for (const u of urls.filter((u) => u.startsWith('/css/') || u.startsWith('/images/'))) {
    assert.ok(existsSync(join(ROOT, 'src', 'public', u.slice(1).split('?')[0])), `missing asset ${u}`);
  }
});
