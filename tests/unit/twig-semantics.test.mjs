// T-02 / P-7 / P-22 / DD-05: twig.js, configured by scripts/twig-config.mjs,
// must reproduce the Twig 1.35.4 semantics pinned in tests/golden/twig.json.
// The expected values come from the cited PHP source lines, never from twig.js.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRenderer } from '../../scripts/twig-config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// T-05 edits src/templates (header/footer/widget); these goldens assert the original markup, so they run on the frozen copy.
const TEMPLATES = join(ROOT, 'reference', 'templates-original');
const golden = JSON.parse(readFileSync(join(ROOT, 'tests', 'golden', 'twig.json'), 'utf8'));
const inline = createRenderer({ templatesRoot: TEMPLATES });
const factIds = new Set(golden.facts.map((f) => f.id));
const clone = (v) => JSON.parse(JSON.stringify(v));

describe('golden table is anchored in the Twig 1.35.4 source', () => {
  test('every fact cites a pinned file, a line and the quoted text', () => {
    assert.equal(golden.meta.twigTag, 'v1.35.4');
    for (const fact of golden.facts) {
      assert.ok(fact.cites.length > 0, `${fact.id} has no citation`);
      for (const c of fact.cites) {
        assert.ok(golden.sources[c.file], `${fact.id}: ${c.file} is not in sources`);
        assert.match(golden.sources[c.file], /^[0-9a-f]{64}$/, `${c.file} sha256`);
        assert.ok(Number.isInteger(c.line) && c.line > 0, `${fact.id}: line of ${c.file}`);
        assert.ok(c.quote && c.quote.length > 3, `${fact.id}: quote of ${c.file}:${c.line}`);
      }
    }
  });

  test('every case, widget case and page expectation points at a known fact', () => {
    const refs = [
      ...golden.cases.flatMap((c) => [c.fact, ...(c.alsoFacts ?? [])]),
      golden.widgetCase.fact,
      ...golden.pageCases.scenarios.flatMap((s) => s.contains.map((x) => x.fact)),
    ];
    for (const r of refs) assert.ok(factIds.has(r), `unknown fact ${r}`);
  });
});

describe('Twig 1.35 semantics through twig-config', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'twig-semantics-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  for (const c of golden.cases) {
    test(`${c.id} (${c.fact})`, () => {
      let actual;
      if (c.files) {
        const root = join(dir, c.id);
        for (const [name, body] of Object.entries(c.files)) {
          mkdirSync(dirname(join(root, name)), { recursive: true });
          writeFileSync(join(root, name), body);
        }
        actual = createRenderer({ templatesRoot: root }).render(c.entry, clone(c.context));
      } else {
        actual = inline.renderString(c.template, clone(c.context));
      }
      assert.equal(actual, c.expected);
    });
  }
});

describe('getSections string of the widget (FR-12)', () => {
  test('sectionsJson is HTML-escaped: " -> &quot; and \' -> &#039;', () => {
    const w = golden.widgetCase;
    const html = inline.render(w.template, clone(w.context));
    assert.ok(html.includes(w.expectedContains), `missing: ${w.expectedContains}`);
  });
});

describe('real page templates render with Twig 1.35 semantics (design 7.1 step 3)', () => {
  for (const s of golden.pageCases.scenarios) {
    test(`${s.template} / ${s.id}`, () => {
      const context = { ...clone(golden.pageCases.baseContext), ...clone(s.overrides) };
      const html = inline.render(s.template, context);
      for (const x of s.contains) {
        assert.ok(html.includes(x.text), `${x.fact} (${x.why}) missing: ${JSON.stringify(x.text)}`);
      }
      for (const x of s.notContains) {
        assert.ok(!html.includes(x.text), `${x.why}: unexpected ${JSON.stringify(x.text)}`);
      }
    });
  }

  test('home.twig and innovations.twig both render the shared partials', () => {
    for (const t of ['home.twig', 'innovations.twig']) {
      const html = inline.render(t, clone(golden.pageCases.baseContext));
      for (const marker of ['var appConfig = {', '<nav class="main-menu"', 'id="filtertitley"', '<!-- Other Libraries -->']) {
        assert.ok(html.includes(marker), `${t} lacks ${marker}`);
      }
    }
  });
});

describe('known divergences are recorded, not asserted', () => {
  test('each divergence names the Twig and twig.js behavior and why it is unreachable', () => {
    const ids = golden.knownDivergences.map((d) => d.id);
    for (const id of ['D-null-eq-false', 'D-invalid-utf8', 'D-empty-hash-truthy', 'D-concat-bool', 'D-null-loose-equality']) {
      assert.ok(ids.includes(id), `missing ${id}`);
    }
    for (const d of golden.knownDivergences) {
      assert.equal(d.reachable, false, d.id);
      assert.ok(d.twig && d.twigjs && d.why, `${d.id} is incomplete`);
    }
  });
});
