import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadCore } from '../../scripts/load-core.mjs';

const core = loadCore('src/runtime/legacy-compat.core.js');
const golden = JSON.parse(fs.readFileSync(new URL('../golden/legacy-compare.json', import.meta.url), 'utf8'));
const tag = (r) => `[${r.kind}] `;

test('core declares exactly the five functions', () => {
  assert.deepEqual(Object.keys(core).sort(), ['isNumericYear', 'lastValue', 'twigEscapeHtml', 'yearAfter2017', 'yearMatches']);
});

for (const r of golden.numeric) {
  test(`${tag(r)}isNumericYear(${JSON.stringify(r.input)})`, () => {
    assert.equal(core.isNumericYear(r.input), r.isNumericYear);
  });
  test(`${tag(r)}yearAfter2017(${JSON.stringify(r.input)})`, () => {
    assert.equal(core.yearAfter2017(r.input), r.yearAfter2017);
  });
}

for (const r of golden.yearMatches) {
  test(`${tag(r)}yearMatches(${JSON.stringify(r.site)}, ${JSON.stringify(r.selected)})`, () => {
    assert.equal(core.yearMatches(r.site, r.selected), r.expected);
  });
}

for (const r of golden.lastValue) {
  test(`${tag(r)}lastValue(${r.query}, ${r.key})`, () => {
    assert.equal(core.lastValue(new URLSearchParams(r.query), r.key), r.expected);
  });
}

test('%202021 decodes to " 2021" through URLSearchParams and is numeric', () => {
  const v = core.lastValue(new URLSearchParams('year=%202021'), 'year');
  assert.equal(v, ' 2021');
  assert.equal(core.isNumericYear(v), true);
});

for (const r of golden.escape) {
  test(`twigEscapeHtml(${JSON.stringify(r.input)})`, () => {
    assert.equal(core.twigEscapeHtml(r.input), r.expected);
  });
}
