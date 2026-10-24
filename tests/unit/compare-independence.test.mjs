// T-16 / FR-23 "R1 source independent of the migration" + DD-09.
// Expected values come from requirements.md FR-23 and from routes.php semantics (the original
// route), written as literals here; nothing is computed with the code under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REF = join(ROOT, 'reference', 'routes-reference.mjs');

// Every module specifier a source file can pull in: static import/export-from, dynamic import(),
// require(). Comments are stripped first so a mention in prose does not count.
export function importSpecifiers(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const out = [];
  const patterns = [
    /\bimport\s+(?:[\w*{}\s,$]+?\s+from\s+)?(['"])([^'"]+)\1/g,
    /\bexport\s+(?:[\w*{}\s,$]+?\s+)from\s+(['"])([^'"]+)\1/g,
    /\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g,
    /\brequire\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g,
  ];
  for (const re of patterns) for (const m of code.matchAll(re)) out.push(m[2]);
  return out;
}

const allowed = (spec) => /(^|\/)twig-config\.mjs$/.test(spec) || spec.startsWith('node:');

test('scanner finds static, dynamic, re-export and require specifiers (and ignores comments)', () => {
  const src = [
    "import a from '../src/runtime/rd-params.js';",
    "import { b } from \"../scripts/build.mjs\";",
    "import '../src/x.js';",
    "export * from '../src/y.js';",
    "const c = await import('../scripts/serve.mjs');",
    "const d = require('../src/z.js');",
    "// import e from '../src/commented.js';",
    "/* import f from '../src/blocked.js'; */",
  ].join('\n');
  assert.deepEqual(importSpecifiers(src).sort(), [
    '../scripts/build.mjs', '../scripts/serve.mjs', '../src/runtime/rd-params.js',
    '../src/x.js', '../src/y.js', '../src/z.js',
  ]);
});

test('routes-reference.mjs imports nothing from src/ or scripts/ except twig-config.mjs', () => {
  const specs = importSpecifiers(readFileSync(REF, 'utf8'));
  const bad = specs.filter((s) => !allowed(s));
  assert.deepEqual(bad, []);
});

test('routes-reference.mjs does not name the migrated modules whose equivalence it measures', () => {
  const text = readFileSync(REF, 'utf8');
  for (const name of ['rd-params', 'rd-apply', 'legacy-compat', 'rules.core', 'src/runtime', 'src/routing', 'site-data']) {
    assert.ok(!text.includes(name), `routes-reference.mjs mentions ${name}`);
  }
});

// ---- behavior of the reference route (literals from routes.php:6-45) ----
const { routeReference, parseQuery } = await import('../../reference/routes-reference.mjs');
const data = {
  sections: [{ name: 'Home', action: 'home' }, { name: 'X', action: 'innovations' }],
  crps: [], years: [], chartsInfo: [], messages: [], dataUrl: {},
  appConfig: { production: true, tableauView: 'v', tableauViewNew: 'n' },
};
const route = (path, query) => routeReference({ path, query, data });

test('absent year defaults to the integer 2021; absent entity to ""; root serves the first section', () => {
  const r = route('/', '');
  assert.equal(r.template, 'home.twig');
  assert.strictEqual(r.context.yearSelected, 2021);
  assert.strictEqual(r.context.entitySelected, '');
  assert.strictEqual(r.context.currentSection, 'home');
  assert.strictEqual(r.context.embed, false);
  assert.strictEqual(r.context.displayNav, true);
  assert.strictEqual(r.context.queryParams, '');
});

test('partnerships picks the 2018 template for year > 2017 or absent, the legacy one otherwise; forceRefresh always', () => {
  assert.equal(route('/partnerships', '').template, 'partnerships-2018.twig');
  assert.equal(route('/partnerships', 'year=2019').template, 'partnerships-2018.twig');
  assert.equal(route('/partnerships', 'year=2017').template, 'partnerships.twig');
  assert.equal(route('/partnerships', 'year=').template, 'partnerships.twig');
  assert.equal(route('/partnerships', 'year=abc').template, 'partnerships.twig');
  assert.strictEqual(route('/partnerships', 'year=2017').context.forceRefresh, true);
  assert.strictEqual(route('/innovations', '').context.forceRefresh, false);
});

test('embed builds queryParams from the raw hostOrigin; displayNav needs the literal "true"', () => {
  const r = route('/innovations', 'embed=true&hostOrigin=http%3A%2F%2Fa.test%2F%3Fx%3D1%26y%3D%272%27');
  assert.equal(r.context.queryParams, "embed=true&hostOrigin=http://a.test/?x=1&y='2'&displayNav=false");
  assert.strictEqual(r.context.displayNav, false);
  assert.equal(route('/innovations', 'embed=true&displayNav=true').context.queryParams, 'embed=true&hostOrigin=&displayNav=true');
  assert.strictEqual(route('/innovations', 'embed=1').context.embed, false);
});

test('last duplicate wins; keys are case-sensitive; empty value is kept (isset)', () => {
  assert.strictEqual(route('/home', 'year=2019&year=2018').context.yearSelected, '2018');
  assert.strictEqual(route('/home', 'Year=2019').context.yearSelected, 2021);
  assert.strictEqual(route('/home', 'year=').context.yearSelected, '');
  assert.deepEqual(parseQuery('a=%41+b&c'), { a: 'A b', c: '' });
});
