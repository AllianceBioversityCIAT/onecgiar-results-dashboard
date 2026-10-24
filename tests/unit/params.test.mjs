// T-06: rd-params.js (window.appConfig computation) and rd-apply.js (DOM effects).
// Pure parts run in Node through node:vm without a DOM; the DOM part uses a minimal fake
// document and only checks wiring (real DOM effects are E2E: T-12/T-14, R1: T-16).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadCore } from '../../scripts/load-core.mjs';

const core = loadCore({ URLSearchParams }, 'src/runtime/legacy-compat.core.js', 'src/runtime/rd-params.js', 'src/runtime/rd-apply.js');
const golden = JSON.parse(fs.readFileSync(new URL('../golden/legacy-compare.json', import.meta.url), 'utf8'));
// Objects built inside the vm context have another realm's prototypes: compare through JSON.
const json = (x) => JSON.parse(JSON.stringify(x));

const DATA = { rdProduction: 'true', rdTableauView: 'https://t.test/views/', rdTableauViewNew: 'https://t.test/new/', rdForceRefresh: 'false' };
const compute = (search, data = DATA) => json(core.rdComputeParams(search, data));
const cfg = (search, data) => compute(search, data).appConfig;

// FR-07 table
test('FR-07 no year: 2021 selected, string "2021" to Tableau', () => {
  assert.equal(cfg('').yearSelected, '2021');
  assert.equal(compute('').year, '2021');
});
test('FR-07 year=2019', () => { assert.equal(cfg('?year=2019').yearSelected, '2019'); });
test('FR-07 year= (empty): All Years, Year="" to Tableau', () => {
  assert.equal(cfg('?year=').yearSelected, '');
  assert.equal(compute('?year=').year, '');
});
test('FR-07 year=abc kept literally (parity, not validated)', () => { assert.equal(cfg('?year=abc').yearSelected, 'abc'); });
test('FR-07 numeric non-canonical %202021 and 2021.0 keep the literal value', () => {
  assert.equal(compute('?year=%202021').year, ' 2021');
  assert.equal(cfg('?year=2021.0').yearSelected, '2021.0');
});
test('FR-07 D19 crafted: year=2021abc literal, year[]=2021 is another key (default 2021)', () => {
  assert.equal(cfg('?year=2021abc').yearSelected, '2021abc');
  assert.equal(cfg('?year[]=2021').yearSelected, '2021');
  assert.equal(compute('?year%5B%5D=2021').year, '2021');
});
test('FR-07 repeated key: last value wins (P-24)', () => { assert.equal(cfg('?year=2019&year=2020').yearSelected, '2020'); });
test('FR-07 no entity: empty string; entity=CCAFS', () => {
  assert.equal(cfg('').entitySelected, '');
  assert.equal(cfg('?entity=CCAFS').entitySelected, 'CCAFS');
});
test('FR-07 absent hostOrigin is the empty string (PHP null rendered by Twig)', () => {
  assert.equal(cfg('').hostOrigin, '');
});
test('FR-07 embed and displayNav (parity routes.php:44)', () => {
  const t = (q) => { const r = compute(q); return [r.embed, r.displayNav]; };
  assert.deepEqual(t(''), [false, true]);
  assert.deepEqual(t('?embed=true'), [true, false]);
  assert.deepEqual(t('?embed=true&displayNav=true'), [true, true]);
  assert.deepEqual(t('?embed=true&displayNav=1'), [true, false]);
  assert.deepEqual(t('?embed=yes&displayNav=true'), [false, true]);
});

// golden rows: lastValue semantics through the real query parser
for (const r of golden.lastValue.filter((x) => x.key === 'year')) {
  test(`golden [${r.kind}] year resolution for ${r.query}`, () => {
    const out = compute('?' + r.query);
    assert.equal(out.year, r.expected === null ? '2021' : r.expected);
  });
}

// appConfig keys/types
test('appConfig has exactly the original keys with the original types', () => {
  const c = cfg('?year=2019&entity=X&hostOrigin=http://h.test');
  assert.deepEqual(Object.keys(c).sort(),
    ['entitySelected', 'forceRefresh', 'hostOrigin', 'production', 'tableauView', 'tableauViewNew', 'yearSelected']);
  assert.deepEqual(['production', 'forceRefresh'].map((k) => typeof c[k]), ['boolean', 'boolean']);
  for (const k of ['tableauView', 'tableauViewNew', 'hostOrigin', 'entitySelected', 'yearSelected']) assert.equal(typeof c[k], 'string', k);
  assert.equal(c.production, true);
  assert.equal(c.forceRefresh, false);
  assert.equal(c.tableauView, 'https://t.test/views/');
  assert.equal(c.tableauViewNew, 'https://t.test/new/');
});
test('appConfig booleans come from data-rd-* as json_encode text', () => {
  const c = cfg('', { ...DATA, rdProduction: 'false', rdForceRefresh: 'true' });
  assert.equal(c.production, false);
  assert.equal(c.forceRefresh, true);
});

// escaped values (Twig 1.35 html strategy)
test('appConfig strings are HTML-escaped like Twig (a&b -> a&amp;b)', () => {
  assert.equal(cfg('?year=a%26b').yearSelected, 'a&amp;b');
});
test('appConfig escapes all five characters in year, entity and hostOrigin', () => {
  const c = cfg('?year=a%26b%27%22%3Cx%3E&entity=%3C%22&hostOrigin=http://h.test/?x=1%26y=%272%27');
  assert.equal(c.yearSelected, 'a&amp;b&#039;&quot;&lt;x&gt;');
  assert.equal(c.entitySelected, '&lt;&quot;');
  assert.equal(c.hostOrigin, 'http://h.test/?x=1&amp;y=&#039;2&#039;');
});
test('appConfig escapes data-rd strings too (Twig autoescape parity)', () => {
  assert.equal(cfg('', { ...DATA, rdTableauView: 'a&b' }).tableauView, 'a&amp;b');
});
test('hostile year: no raw markup characters reach appConfig', () => {
  const c = cfg('?year=' + encodeURIComponent('</script><script>alert(1)</script>'));
  assert.equal(c.yearSelected, '&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.ok(!/[<>"']/.test(c.yearSelected));
});
test('hostile hostOrigin: quote is escaped, value stays data', () => {
  assert.equal(cfg('?hostOrigin=x%27%3Balert(1)%2F%2F').hostOrigin, 'x&#039;;alert(1)//');
});
test('golden escape rows via appConfig.yearSelected', () => {
  for (const r of golden.escape) assert.equal(cfg('?year=' + encodeURIComponent(r.input)).yearSelected, r.expected, r.input);
});
test('the literal (unescaped) values are kept for titles and links', () => {
  const o = compute('?year=a%26b&entity=%3Cb%3E&hostOrigin=h%27x');
  assert.deepEqual([o.year, o.entity, o.hostOrigin], ['a&b', '<b>', "h'x"]);
});

// rd-apply: sentinel replacement
const S = 'RDHOSTORIGINSENTINEL';
test('sentinel replaced by the literal hostOrigin', () => {
  assert.equal(core.rdReplaceSentinel(`./policies?embed=true&hostOrigin=${S}&displayNav=false`, 'http://localhost:8081'),
    './policies?embed=true&hostOrigin=http://localhost:8081&displayNav=false');
});
test('$& and $\' patterns in hostOrigin stay literal', () => {
  const origin = "http://h.test/$&$'$`$$";
  assert.equal(core.rdReplaceSentinel(`a=${S}&b`, origin), `a=${origin}&b`);
});
test('every sentinel occurrence is replaced; no sentinel leaves href unchanged', () => {
  assert.equal(core.rdReplaceSentinel(`${S}-${S}`, 'o'), 'o-o');
  assert.equal(core.rdReplaceSentinel('./x', 'o'), './x');
});
test('empty hostOrigin removes the sentinel', () => {
  assert.equal(core.rdReplaceSentinel(`a=${S}&b`, ''), 'a=&b');
});

// rd-apply wiring against a minimal fake document
function el(props) { return { attrs: {}, ...props, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; } }; }
function fakeDoc() {
  const years = ['2021', '2020', '2019', '2018', '2017', ''].map((v) => el({ value: v, checked: false }));
  const crps = ['', 'A4NH', 'CCAFS'].map((v) => el({ value: v, checked: false }));
  const ty = el({ textContent: 'x' });
  const tc = el({ textContent: 'x' });
  const links = [el({ attrs: { href: `./a?hostOrigin=${S}` } }), el({ attrs: { href: `./b?hostOrigin=${S}&c=${S}` } })];
  const map = {
    'input[name="years"]': years, 'input[name="crps"]': crps,
    '#filtertitley': [ty], '#filtertitlec': [tc], 'a[href*="RDHOSTORIGINSENTINEL"]': links,
  };
  return {
    years, crps, ty, tc, links,
    querySelectorAll: (s) => map[s] || [],
    querySelector: (s) => (map[s] || [])[0] || null,
  };
}
const apply = (search) => { const d = fakeDoc(); core.rdApply(d, core.rdComputeParams(search, DATA)); return d; };
const checked = (list) => list.filter((e) => e.checked).map((e) => e.value);

test('apply: default year 2021 checked, title "2021", entity All and "Research Programs"', () => {
  const d = apply('');
  assert.deepEqual(checked(d.years), ['2021']);
  assert.equal(d.ty.textContent, '2021');
  assert.deepEqual(checked(d.crps), ['']);
  assert.equal(d.tc.textContent, 'Research Programs');
});
test('apply: year= checks "All Years" and titles it so', () => {
  const d = apply('?year=');
  assert.deepEqual(checked(d.years), ['']);
  assert.equal(d.ty.textContent, 'All Years');
});
test('apply: year=abc and 2021abc check no radio, title is the literal value (D19)', () => {
  for (const v of ['abc', '2021abc']) {
    const d = apply('?year=' + v);
    assert.deepEqual(checked(d.years), [], v);
    assert.equal(d.ty.textContent, v);
  }
});
test('apply: %202021 and 2021.0 check 2021 and keep the literal title', () => {
  let d = apply('?year=%202021');
  assert.deepEqual(checked(d.years), ['2021']);
  assert.equal(d.ty.textContent, ' 2021');
  d = apply('?year=2021.0');
  assert.deepEqual(checked(d.years), ['2021']);
  assert.equal(d.ty.textContent, '2021.0');
});
test('apply: entity=CCAFS checks CCAFS and titles it', () => {
  const d = apply('?entity=CCAFS');
  assert.deepEqual(checked(d.crps), ['CCAFS']);
  assert.equal(d.tc.textContent, 'CCAFS');
});
test('apply: hostile year is the literal text, never an escaped or markup form', () => {
  const v = '</script><script>alert(1)</script>';
  const d = apply('?year=' + encodeURIComponent(v));
  assert.equal(d.ty.textContent, v);
  assert.equal(d.ty.innerHTML, undefined);
});
test('apply: embed rewrites sentinel hrefs with the literal hostOrigin; non-embed leaves them', () => {
  let d = apply('?embed=true&hostOrigin=' + encodeURIComponent("http://h.test/$&$'"));
  assert.deepEqual(d.links.map((l) => l.attrs.href),
    ["./a?hostOrigin=http://h.test/$&$'", "./b?hostOrigin=http://h.test/$&$'&c=http://h.test/$&$'"]);
  d = apply('?hostOrigin=x');
  assert.equal(d.links[0].attrs.href, `./a?hostOrigin=${S}`);
});
test('apply: tolerates pages without filters', () => {
  core.rdApply({ querySelectorAll: () => [], querySelector: () => null }, core.rdComputeParams('', DATA));
});
