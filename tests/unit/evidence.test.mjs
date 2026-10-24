// Status rules of scripts/evidence.mjs (design 10.3, DD-12; FR-25, FR-27, NFR-04, NFR-10).
// Fixtures are tiny hand-built reports, never the real ones: the expected statuses come from the
// design 10.3 table and the FR-25 scenario, not from running the pipeline on real output.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseJunit, titlePatterns, flattenE2E, groupStatus, evaluate, evalBuildTime, parseHistory,
  combine, exitCode, validateTraceability, label, run, S, scanTitles, unitIndex, ranAt,
} from '../../scripts/evidence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---- fixtures

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-evidence-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const unitDir = tmp();
fs.writeFileSync(path.join(unitDir, 'a.test.mjs'), "test('alpha works (FR-X)', () => {});\ntest('beta works', () => {});\ntest(`gamma value ${n}`, () => {});\n");
fs.writeFileSync(path.join(unitDir, 'b.test.mjs'), "test('delta works', () => {});\n");

// The Playwright fixture spec file lists the tests it declares; by default those are the titles in the report.
const e2eDir = tmp();
const writeSpec = (titles) => fs.writeFileSync(path.join(e2eDir, 'f.spec.mjs'), titles.map((t) => `test(${JSON.stringify(t)}, async () => {});\n`).join(''));

const junit = (cases) => `<?xml version="1.0"?><testsuites>${cases.map(([name, kind, msg]) => (kind
  ? `<testcase name="${name}" classname="test"><${kind} message="${msg || ''}"/></testcase>`
  : `<testcase name="${name}" classname="test"/>`)).join('')}</testsuites>`;

const trace = (refs) => ({ criteria: [{ id: 'X-1', kind: 'FR', title: 't', refs }] });
const statusOf = (refs, inputs = {}) => {
  const { e2eTitles, ...rest } = inputs;
  writeSpec(e2eTitles || (rest.e2e ? [...new Set(rest.e2e.groups.map((g) => g.title))] : []));
  const { rows } = evaluate({ traceability: trace(refs), unitDir, e2eDir, ...rest });
  return rows[0];
};
const unitRef = (file, match, min = 1) => ({ type: 'unit', file, ...(match ? { match } : {}), min });
const e2eRef = (file, match) => ({ type: 'e2e', file, ...(match ? { match } : {}) });

const pwTest = (project, status, annotations = [{ type: 'class', description: 'LOCAL' }], extra = {}) => ({
  projectName: project, status: status === 'passed' ? 'expected' : status === 'skipped' ? 'skipped' : 'unexpected',
  annotations, results: [{ status, annotations }], ...extra,
});
const pwReport = (specs, projects = ['chromium', 'firefox', 'webkit']) => ({
  config: { projects: projects.map((name) => ({ name })) },
  suites: [{ title: 'f.spec.mjs', file: 'f.spec.mjs', specs: specs.map(([file, title, tests]) => ({ file, title, tests })) }],
});
const all3 = (status, ann) => ['chromium', 'firefox', 'webkit'].map((p) => pwTest(p, status, ann));
const e2e = (specs, projects) => flattenE2E(pwReport(specs, projects));

// ---- unit report

test('status: a mapped unit test that ran and passed is PASSED', () => {
  const r = statusOf([unitRef('a.test.mjs', 'alpha')], { unit: parseJunit(junit([['alpha works (FR-X)']])) });
  assert.equal(r.status, 'PASSED');
});

test('status: a failed mapped unit test makes the criterion FAILED and names the test', () => {
  const r = statusOf([unitRef('a.test.mjs')], { unit: parseJunit(junit([['alpha works (FR-X)'], ['beta works', 'failure', 'boom']])) });
  assert.equal(r.status, 'FAILED');
  assert.match(r.detail.join('\n'), /beta works/);
});

test('status: a mapped unit test with no execution record is NOT RUN, never PASSED (FR-25 BUT)', () => {
  const r = statusOf([unitRef('a.test.mjs', 'alpha'), unitRef('a.test.mjs', 'beta')], { unit: parseJunit(junit([['alpha works (FR-X)']])) });
  assert.equal(r.status, 'NOT RUN');
  assert.match(r.detail.join('\n'), /beta/);
});

test('status: with no unit report every unit-mapped criterion is NOT RUN', () => {
  assert.equal(statusOf([unitRef('a.test.mjs')], {}).status, 'NOT RUN');
});

test('status: a skipped unit test is NOT RUN (design 9: a case that needs the absent original)', () => {
  const r = statusOf([unitRef('a.test.mjs')], { unit: parseJunit(junit([['alpha works (FR-X)'], ['beta works', 'skipped', 'original absent'], ['gamma value 1']])) });
  assert.equal(r.status, 'NOT RUN');
});

test('status: a unit file scopes its tests, so another file with a passing test does not count', () => {
  const r = statusOf([unitRef('a.test.mjs', 'delta')], { unit: parseJunit(junit([['delta works']])) });
  assert.equal(r.status, 'NOT RUN');
});

test('status: dynamic titles (template literals) are attributed to their file', () => {
  const r = statusOf([unitRef('a.test.mjs', 'gamma')], { unit: parseJunit(junit([['gamma value 42']])) });
  assert.equal(r.status, 'PASSED');
  assert.ok(titlePatterns('test(`item ${a} works`, () => {})')[0].test('item 1 works'));
  assert.equal(titlePatterns('test(`${a} ${b}`, () => {})').length, 0, 'a nearly fully dynamic title is weak and never used');
});

test('status: junit entities in titles are decoded before matching', () => {
  assert.equal(parseJunit(junit([['a &lt;= b &amp; &quot;c&quot;']]))[0].name, 'a <= b & "c"');
});

test('status: a junit title holding an unescaped ">" (as node:test writes it) is still one test case', () => {
  const xml = '<testsuites><testcase name="year > 2017 -> legacy" time="0.1" classname="test"/><testcase name="next" classname="test"><failure message="x"/></testcase></testsuites>';
  const cases = parseJunit(xml);
  assert.deepEqual(cases.map((c) => [c.name, c.status]), [['year > 2017 -> legacy', 'passed'], ['next', 'failed']]);
});

test('status: FALSIFIER a whole unit test removed from the report makes a file-level ref NOT RUN, not PASSED', () => {
  const all = [['alpha works (FR-X)'], ['beta works'], ['gamma value 1']];
  assert.equal(statusOf([unitRef('a.test.mjs')], { unit: parseJunit(junit(all)) }).status, 'PASSED');
  const r = statusOf([unitRef('a.test.mjs')], { unit: parseJunit(junit(all.filter(([n]) => n !== 'beta works'))) });
  assert.equal(r.status, 'NOT RUN');
  assert.match(r.detail.join('\n'), /beta works/);
  const dyn = statusOf([unitRef('a.test.mjs')], { unit: parseJunit(junit(all.slice(0, 2))) });
  assert.equal(dyn.status, 'NOT RUN', 'a deleted dynamic-title test is detected too');
});

test('status: a failed case still outranks a gap in the same file', () => {
  const r = statusOf([unitRef('a.test.mjs')], { unit: parseJunit(junit([['alpha works (FR-X)', 'failure', 'boom']])) });
  assert.equal(r.status, 'FAILED');
});

test('status: a recorded case that matches the titles of two files is ambiguous and counts for neither', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'x.test.mjs'), "test('shared title here', () => {});\ntest('only in x file', () => {});\n");
  fs.writeFileSync(path.join(dir, 'y.test.mjs'), "test(`shared ${n} here`, () => {});\n");
  const unit = parseJunit(junit([['shared title here'], ['only in x file']]));
  const idx = unitIndex(dir, unit);
  assert.deepEqual(idx.ambiguous.map((a) => [a.name, a.files]), [['shared title here', ['x.test.mjs', 'y.test.mjs']]]);
  const { rows, attribution } = evaluate({ traceability: trace([unitRef('x.test.mjs')]), unit, unitDir: dir, e2eDir });
  assert.equal(rows[0].status, 'NOT RUN');
  assert.match(rows[0].detail.join('\n'), /shared title here/);
  assert.equal(attribution.ambiguous.length, 1);
});

test('status: a weak dynamic unit title still needs a recorded case, claimed by exactly one file', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'w.test.mjs'), 'test("solid title one", () => {});\ntest(`${c.id}: ${c.x}`, () => {});\n');
  fs.writeFileSync(path.join(dir, 'z.test.mjs'), 'test("zed title one", () => {});\n');
  const ev = (cases) => evaluate({ traceability: trace([unitRef('w.test.mjs')]), unit: parseJunit(junit(cases)), unitDir: dir, e2eDir });
  assert.equal(ev([['solid title one'], ['row1: a']]).rows[0].status, 'PASSED');
  const missing = ev([['solid title one']]);
  assert.equal(missing.rows[0].status, 'NOT RUN');
  assert.match(missing.rows[0].detail.join('\n'), /declared test\(s\) have no recorded case/);
  // a failed case claimed through the weak pattern is FAILED, not hidden
  const failed = ev([['solid title one'], ['row1: a', 'failure', 'x']]);
  assert.equal(failed.rows[0].status, 'FAILED');
});

test('status: an unowned case that two files claim through weak patterns counts for neither, so the pattern stays unmet', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'w.test.mjs'), 'test("solid title one", () => {});\ntest(`${c.id}: ${c.x}`, () => {});\n');
  fs.writeFileSync(path.join(dir, 'v.test.mjs'), 'test(`${a}: ${b}`, () => {});\n');
  const unit = parseJunit(junit([['solid title one'], ['row1: a']]));
  const idx = unitIndex(dir, unit);
  assert.equal(idx.weakOwner[1], null);
  assert.equal(idx.unowned.length, 1);
  const r = evaluate({ traceability: trace([unitRef('w.test.mjs')]), unit, unitDir: dir, e2eDir }).rows[0];
  assert.equal(r.status, 'NOT RUN');
});

// ---- disabled tests are still declared tests (FR-25 BUT)

const disabledDir = tmp();
fs.writeFileSync(path.join(disabledDir, 'd.test.mjs'), [
  'test("enabled title one", () => {});',
  'test.skip("skipped title two", () => {});',
  'test.todo("todo title three");',
  'it.skip("it skipped title four", () => {});',
  'test(`${c.id}: ${c.x}`, () => {});',
  '',
].join('\n'));
const disabled = (cases, refMatch) => evaluate({
  traceability: trace([unitRef('d.test.mjs', refMatch)]), unit: parseJunit(junit(cases)), unitDir: disabledDir, e2eDir,
}).rows[0];
const allDisabled = [['enabled title one'], ['skipped title two', 'skipped', 'skip'], ['todo title three', 'skipped', 'todo'], ['it skipped title four', 'skipped', 'skip'], ['row1: a']];

test('status: test.skip and it.skip and test.todo are declared tests, and the scan reads them', () => {
  const titles = scanTitles(fs.readFileSync(path.join(disabledDir, 'd.test.mjs'), 'utf8')).map((e) => e.title);
  assert.deepEqual(titles, ['enabled title one', 'skipped title two', 'todo title three', 'it skipped title four', ': ']);
});

test('status: a test.skip recorded as skipped makes the criterion NOT RUN, not PASSED', () => {
  const r = disabled(allDisabled);
  assert.equal(r.status, 'NOT RUN');
  assert.match(r.detail.join('\n'), /skipped skipped title two/);
});

test('status: a test.todo recorded as skipped makes the criterion NOT RUN', () => {
  const r = disabled(allDisabled, 'todo title three');
  assert.equal(r.status, 'NOT RUN');
  assert.match(r.detail.join('\n'), /todo title three/);
});

test('status: a test.skip with no record at all makes the criterion NOT RUN, not PASSED', () => {
  const r = disabled(allDisabled.filter(([n]) => n !== 'skipped title two'), 'enabled|skipped title two');
  assert.equal(r.status, 'NOT RUN');
  assert.match(r.detail.join('\n'), /skipped title two/);
  assert.equal(disabled([['enabled title one']], 'enabled title one').status, 'PASSED', 'control: the enabled test alone, inside its own match, passes');
});

test('status: a skipped unowned case cannot satisfy a weak pattern; a failed one cannot either', () => {
  const base = [['enabled title one']];
  assert.equal(disabled([...base, ['row1: a']], 'enabled title one|^: $').status, 'PASSED', 'control: a passed claimed case satisfies it');
  const skipped = disabled([...base, ['row1: a', 'skipped', 'skip']], 'enabled title one|^: $');
  assert.equal(skipped.status, 'NOT RUN');
  const failed = disabled([...base, ['row1: a', 'failure', 'x']], 'enabled title one|^: $');
  // the weak pattern is expected but its case is outside the match, so only the pattern rule can decide
  assert.equal(failed.status, 'NOT RUN', 'a failed case outside the match never satisfies the pattern (a failure inside the match is FAILED); it is reported, and is never taken as the pattern being satisfied');
});

test('status: on the REAL tests/unit no declared test title is claimed by two files (no ambiguous attribution)', () => {
  const dir = path.join(ROOT, 'tests', 'unit');
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.test.mjs'));
  const entries = new Map(files.map((f) => [f, scanTitles(fs.readFileSync(path.join(dir, f), 'utf8')).filter((e) => !e.weak)]));
  const clashes = [];
  for (const [file, list] of entries) {
    for (const e of list) {
      const owners = [...entries].filter(([, es]) => es.some((x) => x.regex.test(e.title))).map(([f]) => f);
      if (owners.length !== 1) clashes.push(`${file}: "${e.title}" matches ${owners.join(', ')}`);
    }
  }
  assert.deepEqual(clashes, []);
});

// ---- Playwright report

test('status: an e2e test passed in every browser is PASSED', () => {
  const r = statusOf([e2eRef('f.spec.mjs')], { e2e: e2e([['f.spec.mjs', 't1', all3('passed')]]) });
  assert.equal(r.status, 'PASSED');
});

test('status: FALSIFIER one deleted Playwright result makes the criterion NOT RUN, not PASSED', () => {
  const full = all3('passed');
  const missing = full.filter((t) => t.projectName !== 'firefox');
  assert.equal(statusOf([e2eRef('f.spec.mjs')], { e2e: e2e([['f.spec.mjs', 't1', full]]) }).status, 'PASSED');
  assert.equal(statusOf([e2eRef('f.spec.mjs')], { e2e: e2e([['f.spec.mjs', 't1', missing]]) }).status, 'NOT RUN');
});

test('status: a deleted whole test is NOT RUN when its criterion needs two tests', () => {
  const two = [['f.spec.mjs', 't1', all3('passed')], ['f.spec.mjs', 't2', all3('passed')]];
  assert.equal(statusOf([e2eRef('f.spec.mjs', 't1'), e2eRef('f.spec.mjs', 't2')], { e2e: e2e(two) }).status, 'PASSED');
  assert.equal(statusOf([e2eRef('f.spec.mjs', 't1'), e2eRef('f.spec.mjs', 't2')], { e2e: e2e(two.slice(0, 1)) }).status, 'NOT RUN');
});

test('status: FALSIFIER a whole Playwright test removed from every browser makes a file-level ref NOT RUN, not PASSED', () => {
  const one = [['f.spec.mjs', 't1', all3('passed')]];
  const both = [...one, ['f.spec.mjs', 't2', all3('passed')]];
  assert.equal(statusOf([e2eRef('f.spec.mjs')], { e2e: e2e(both) }).status, 'PASSED');
  const r = statusOf([e2eRef('f.spec.mjs')], { e2e: e2e(one), e2eTitles: ['t1', 't2'] });
  assert.equal(r.status, 'NOT RUN');
  assert.match(r.detail.join('\n'), /t2/);
});

test('status: a class-wide check (FR-22 LOCAL, FR-27) is NOT RUN while a declared test has no record', () => {
  const one = e2e([['f.spec.mjs', 't1', all3('passed')]]);
  const local = { type: 'e2e-class', class: 'LOCAL' };
  assert.equal(statusOf([local], { e2e: one }).status, 'PASSED');
  assert.equal(statusOf([local], { e2e: one, e2eTitles: ['t1', 't2'] }).status, 'NOT RUN');
  assert.equal(statusOf([{ type: 'rule', rule: 'fr27' }], { e2e: one, e2eTitles: ['t1', 't2'] }).status, 'NOT RUN');
});

test('status: a weak dynamic Playwright title (a routing-status table) with no record makes the file-level ref NOT RUN', () => {
  const all = [['f.spec.mjs', 'table-row-a', all3('passed')], ['f.spec.mjs', 'other test passes', all3('passed')], ['f.spec.mjs', 'another one passes', all3('passed')]];
  // The fixture spec file declares the table title as a template literal; write it by hand.
  fs.writeFileSync(path.join(e2eDir, 'f.spec.mjs'), 'test(`${c.id}: ${c.method} ${c.path} -> ${c.status}`, async () => {});\ntest("other test passes", async () => {});\ntest("another one passes", async () => {});\n');
  assert.equal(scanTitles(fs.readFileSync(path.join(e2eDir, 'f.spec.mjs'), 'utf8'))[0].weak, true);
  const withRows = [...all, ['f.spec.mjs', 'GET-1: GET "/" -> 200', all3('passed')]];
  const run1 = (specs) => evaluate({ traceability: trace([e2eRef('f.spec.mjs')]), unitDir, e2eDir, e2e: e2e(specs) }).rows[0];
  assert.equal(run1(withRows).status, 'PASSED');
  const r = run1(all.slice(1));
  assert.equal(r.status, 'NOT RUN');
  assert.match(r.detail.join('\n'), /declared test\(s\) have no record/);
});

test('status: with no Playwright report an e2e-mapped criterion is NOT RUN', () => {
  assert.equal(statusOf([e2eRef('f.spec.mjs')], {}).status, 'NOT RUN');
});

test('status: a failed e2e result in one browser is FAILED', () => {
  const tests = [pwTest('chromium', 'passed'), pwTest('firefox', 'failed'), pwTest('webkit', 'passed')];
  assert.equal(statusOf([e2eRef('f.spec.mjs')], { e2e: e2e([['f.spec.mjs', 't1', tests]]) }).status, 'FAILED');
});

test('status: a skip with annotation blocked is BLOCKED (reason), not PASSED and not FAILED', () => {
  const ann = [{ type: 'class', description: 'TABLEAU' }, { type: 'blocked', description: 'embedding' }];
  const r = statusOf([e2eRef('f.spec.mjs')], { e2e: e2e([['f.spec.mjs', 't1', all3('skipped', ann)]]) });
  assert.equal(r.status, 'BLOCKED (embedding)');
});

test('status: a test that passed but recorded a blocked annotation is BLOCKED, never PASSED', () => {
  const ann = [{ type: 'class', description: 'LOCAL' }, { type: 'blocked', description: 'tableauHosts not pinned' }];
  const r = statusOf([e2eRef('f.spec.mjs')], { e2e: e2e([['f.spec.mjs', 't1', all3('passed', ann)]]) });
  assert.equal(r.status, 'BLOCKED (tableauHosts not pinned)');
});

test('status: a skip without blocked or not-applicable annotation is NOT RUN', () => {
  const r = statusOf([e2eRef('f.spec.mjs')], { e2e: e2e([['f.spec.mjs', 't1', all3('skipped')]]) });
  assert.equal(r.status, 'NOT RUN');
});

test('status: a test of class AWS is NOT RUN — AWS', () => {
  const r = statusOf([e2eRef('f.spec.mjs')], { e2e: e2e([['f.spec.mjs', 't1', all3('skipped', [{ type: 'class', description: 'AWS' }])]]) });
  assert.equal(r.status, 'NOT RUN — AWS');
});

test('status: a test that only passed on retry (flaky) is FAILED, not PASSED', () => {
  const tests = all3('passed').map((t) => ({ ...t, status: 'flaky' }));
  assert.equal(statusOf([e2eRef('f.spec.mjs')], { e2e: e2e([['f.spec.mjs', 't1', tests]]) }).status, 'FAILED');
});

// ---- NOT APPLICABLE by specification (Leader addendum on T-15)

const na = (reason) => [{ type: 'class', description: 'LOCAL' }, { type: 'not-applicable', description: reason }];
const glossary = (webkit, chromium = pwTest('chromium', 'passed'), firefox = pwTest('firefox', 'passed')) => [chromium, firefox, webkit];

test('status: a not-applicable skip is excluded from the criterion and labeled NOT APPLICABLE (by spec), never PASSED', () => {
  const tests = glossary(pwTest('webkit', 'skipped', na('sphere click is Chromium/Firefox only')));
  const g = e2e([['f.spec.mjs', 'sphere', tests]]);
  const cell = groupStatus(g.groups[0], g.projects);
  assert.equal(cell.s, 'PASSED');
  assert.deepEqual(cell.na, ['NOT APPLICABLE (by spec: sphere click is Chromium/Firefox only)']);
  const r = statusOf([e2eRef('f.spec.mjs')], { e2e: g });
  assert.equal(r.status, 'PASSED');
  assert.deepEqual(r.na, cell.na);
});

test('status: a not-applicable skip does not fall through to NOT RUN or BLOCKED', () => {
  const tests = glossary(pwTest('webkit', 'skipped', na('by spec')));
  const g = e2e([['f.spec.mjs', 'sphere', tests]]);
  assert.notEqual(groupStatus(g.groups[0], g.projects).s, S.NOT_RUN);
  assert.notEqual(groupStatus(g.groups[0], g.projects).s, S.BLOCKED);
});

test('status: when every browser is not-applicable no browser exercised the behavior, so NOT RUN', () => {
  const tests = ['chromium', 'firefox', 'webkit'].map((p) => pwTest(p, 'skipped', na('by spec')));
  assert.equal(statusOf([e2eRef('f.spec.mjs')], { e2e: e2e([['f.spec.mjs', 'sphere', tests]]) }).status, 'NOT RUN');
});

test('status: not-applicable never hides a FAILED browser', () => {
  const tests = glossary(pwTest('webkit', 'skipped', na('by spec')), pwTest('chromium', 'failed'));
  assert.equal(statusOf([e2eRef('f.spec.mjs')], { e2e: e2e([['f.spec.mjs', 'sphere', tests]]) }).status, 'FAILED');
});

test('status: not-applicable never hides a browser that did not run', () => {
  const tests = [pwTest('chromium', 'passed'), pwTest('webkit', 'skipped', na('by spec'))]; // firefox result absent
  assert.equal(statusOf([e2eRef('f.spec.mjs')], { e2e: e2e([['f.spec.mjs', 'sphere', tests]]) }).status, 'NOT RUN');
});

test('status: a not-applicable skip in a passing test still needs one PASSED browser (blocked elsewhere stays BLOCKED)', () => {
  const ann = [{ type: 'class', description: 'LOCAL' }, { type: 'blocked', description: 'network' }];
  const tests = glossary(pwTest('webkit', 'skipped', na('by spec')), pwTest('chromium', 'skipped', ann), pwTest('firefox', 'skipped', ann));
  assert.equal(statusOf([e2eRef('f.spec.mjs')], { e2e: e2e([['f.spec.mjs', 'sphere', tests]]) }).status, 'BLOCKED (network)');
});

// ---- aggregation and exit rule

test('status: precedence is FAILED over NOT RUN over BLOCKED over PASSED', () => {
  const p = { s: S.PASSED, detail: [] };
  const b = { s: S.BLOCKED, reason: 'r', detail: [] };
  const n = { s: S.NOT_RUN, detail: [] };
  const f = { s: S.FAILED, detail: [] };
  assert.equal(combine([p, p]).s, 'PASSED');
  assert.equal(label(combine([p, b])), 'BLOCKED (r)');
  assert.equal(combine([p, b, n]).s, 'NOT RUN');
  assert.equal(combine([p, b, n, f]).s, 'FAILED');
  assert.equal(combine([]).s, 'NOT RUN');
});

test('status: exit is non-zero for FAILED or NOT RUN, zero for PASSED, BLOCKED and NOT RUN — AWS', () => {
  const row = (s) => ({ s });
  assert.equal(exitCode([row(S.PASSED), row(S.BLOCKED), row(S.AWS)]), 0);
  assert.equal(exitCode([row(S.PASSED), row(S.FAILED)]), 1);
  assert.equal(exitCode([row(S.PASSED), row(S.NOT_RUN)]), 1);
  assert.equal(exitCode([row(S.PASSED)], ['unit.xml']), 1);
});

// ---- FR-27

test('status: FR-27 is FAILED when a recorded e2e test has no class or two classes', () => {
  const rule = [{ type: 'rule', rule: 'fr27' }];
  const good = e2e([['f.spec.mjs', 't1', all3('passed')]]);
  const none = e2e([['f.spec.mjs', 't1', all3('passed', [])]]);
  const two = e2e([['f.spec.mjs', 't1', all3('passed', [{ type: 'class', description: 'LOCAL' }, { type: 'class', description: 'TABLEAU' }])]]);
  assert.equal(statusOf(rule, { e2e: good }).status, 'PASSED');
  assert.equal(statusOf(rule, { e2e: none }).status, 'FAILED');
  assert.equal(statusOf(rule, { e2e: two }).status, 'FAILED');
  assert.equal(statusOf(rule, {}).status, 'NOT RUN');
});

test('status: FR-27 and the class-wide check report a recorded FAILED even while a declared test has no record', () => {
  const classless = e2e([['f.spec.mjs', 't1', all3('passed', [])]]);
  const rule = { type: 'rule', rule: 'fr27' };
  const local = { type: 'e2e-class', class: 'LOCAL' };
  assert.equal(statusOf([rule], { e2e: classless, e2eTitles: ['t1', 't2'] }).status, 'FAILED'); // gap + class-less test
  const failing = e2e([['f.spec.mjs', 't1', [pwTest('chromium', 'failed'), pwTest('firefox', 'passed'), pwTest('webkit', 'passed')]]]);
  assert.equal(statusOf([local], { e2e: failing, e2eTitles: ['t1', 't2'] }).status, 'FAILED'); // gap + failed LOCAL test
  const good = e2e([['f.spec.mjs', 't1', all3('passed')]]);
  assert.equal(statusOf([rule], { e2e: good, e2eTitles: ['t1', 't2'] }).status, 'NOT RUN'); // gap alone stays NOT RUN
});

test('status: a class description with a suffix still counts as that single class', () => {
  const g = e2e([['f.spec.mjs', 't1', all3('passed', [{ type: 'class', description: 'LOCAL (stubbed marks)' }])]]);
  assert.equal(statusOf([{ type: 'rule', rule: 'fr27' }], { e2e: g }).status, 'PASSED');
});

// ---- NFR-04 from build-history.jsonl

const rec = (o) => JSON.stringify({ timestamp: o.t, elapsedMs: o.ms, budgetMs: o.budget ?? 60000, clean: true, idle: !!o.idle, ...(o.source ? { source: o.source, gate: o.gate } : {}) });
const hist = (...recs) => parseHistory(recs.map(rec).join('\n') + '\n');

test('status: NFR-04 is PASSED when every real clean build is within 60 000 ms', () => {
  assert.equal(evalBuildTime(hist({ t: 't1', ms: 1000 }, { t: 't2', ms: 59999 }), 60000).s, 'PASSED');
});

test('status: NFR-04 is FAILED for a real record above the budget', () => {
  const r = evalBuildTime(hist({ t: 't1', ms: 1000 }, { t: 't2', ms: 60001 }), 60000);
  assert.equal(r.s, 'FAILED');
  assert.match(r.detail.join('\n'), /60001/);
});

test('status: NFR-04 counts a budgetMs 1 falsifier record like any clean build: a real ~1 s build is harmless', () => {
  const h = hist({ t: 't1', ms: 1000 }, { t: 't2', ms: 900, budget: 1, source: 'build-time.test', gate: 'FAILED' });
  const r = evalBuildTime(h, 60000);
  assert.equal(r.s, 'PASSED');
  assert.match(r.detail[0], /2 clean record\(s\) counted/);
});

test('status: NFR-04 counts every clean record, whatever budget it was recorded under: 90 000 ms under budget 120 000 is FAILED', () => {
  const r = evalBuildTime(hist({ t: 't1', ms: 90000, budget: 120000 }), 60000);
  assert.equal(r.s, 'FAILED');
  assert.match(r.detail.join('\n'), /90000/);
});

test('status: NFR-04 has no exclusion predicate: 70 000 ms with budgetMs 30 000 is FAILED', () => {
  assert.equal(evalBuildTime(hist({ t: 't1', ms: 70000, budget: 30000 }), 60000).s, 'FAILED');
});

test('status: NFR-04 130 000 ms from build-time.test with gate FAILED and budgetMs 120 000 is FAILED', () => {
  const r = evalBuildTime(hist({ t: 't1', ms: 130000, budget: 120000, source: 'build-time.test', gate: 'FAILED' }), 60000);
  assert.equal(r.s, 'FAILED');
  assert.match(r.detail.join('\n'), /130000/);
});

test('status: NFR-04 does not count a build that is not clean, and a history of only such builds is NOT RUN', () => {
  const nonClean = parseHistory(JSON.stringify({ timestamp: 't1', elapsedMs: 99000, budgetMs: 60000, clean: false }) + '\n');
  assert.equal(evalBuildTime(nonClean, 60000).s, 'NOT RUN');
});

test('status: NFR-04 summary section counts exactly the records evalBuildTime counts', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'a'), { recursive: true });
  const lines = [rec({ t: 't1', ms: 900, budget: 1, source: 'build-time.test', gate: 'FAILED' }), JSON.stringify({ timestamp: 't2', elapsedMs: 5, budgetMs: 60000, clean: false })];
  fs.writeFileSync(path.join(dir, 'a', 'build-history.jsonl'), lines.join('\n') + '\n');
  const out = path.join(dir, 'out');
  const saved = process.env.EVIDENCE_SKIP_PROBES;
  process.env.EVIDENCE_SKIP_PROBES = '1';
  const log = console.log;
  console.log = () => {};
  try { run(['--reports', path.join(dir, 'r'), '--artifacts', path.join(dir, 'a'), '--out', out, '--date', '2000-01-01']); } finally { console.log = log; process.env.EVIDENCE_SKIP_PROBES = saved ?? ''; }
  const md = fs.readFileSync(path.join(out, 'summary.md'), 'utf8');
  assert.match(md, /2 record\(s\) in the history, 1 counted/);
  assert.match(md, /\| t1 \| 900 \| 1 \| no \| build-time\.test \| yes \|/);
  assert.match(md, /\| t2 \| 5 \| 60000 \| no \| build \| no \|/);
});

test('status: NFR-04 FAILED stands until a LATER passing record with idle: true', () => {
  const failing = { t: 't2', ms: 70000 };
  assert.equal(evalBuildTime(hist({ t: 't1', ms: 1 }, failing, { t: 't3', ms: 2000 }), 60000).s, 'FAILED'); // later but not idle
  assert.equal(evalBuildTime(hist({ t: 't0', ms: 2000, idle: true }, failing), 60000).s, 'FAILED'); // idle but earlier
  assert.equal(evalBuildTime(hist({ t: 't1', ms: 1 }, failing, { t: 't3', ms: 80000, idle: true }), 60000).s, 'FAILED'); // idle but slow
  const ok = evalBuildTime(hist({ t: 't1', ms: 1 }, failing, { t: 't3', ms: 2000, idle: true }), 60000);
  assert.equal(ok.s, 'PASSED');
  assert.match(ok.detail.join('\n'), /overridden/); // the failure stays visible
});

test('status: NFR-04 without a history is NOT RUN, and a corrupt line is skipped, not fatal', () => {
  assert.equal(evalBuildTime(null, 60000).s, 'NOT RUN');
  const h = parseHistory(`${rec({ t: 't1', ms: 5 })}\nnot json\n`);
  assert.equal(h.records.length, 1);
  assert.deepEqual(h.bad, [2]);
});

// ---- pipeline

test('status: red run with no reports present, every criterion is NOT RUN and the exit is non-zero', () => {
  const dir = tmp();
  const out = path.join(dir, 'out');
  const saved = process.env.EVIDENCE_SKIP_PROBES;
  process.env.EVIDENCE_SKIP_PROBES = '1';
  const log = console.log;
  console.log = () => {};
  let code;
  try {
    code = run(['--reports', path.join(dir, 'reports'), '--artifacts', path.join(dir, 'artifacts'), '--out', out, '--date', '2000-01-01']);
  } finally { console.log = log; process.env.EVIDENCE_SKIP_PROBES = saved ?? ''; }
  assert.equal(code, 1);
  const env = JSON.parse(fs.readFileSync(path.join(out, 'environment.json'), 'utf8'));
  const counts = env.statusCounts;
  assert.deepEqual(Object.keys(counts), ['NOT RUN']);
  assert.equal(counts['NOT RUN'], 56);
  const md = fs.readFileSync(path.join(out, 'summary.md'), 'utf8');
  assert.match(md, /56 criteria: 0 PASSED, 0 FAILED, 0 BLOCKED, 56 NOT RUN/);
  assert.match(md, /\| ID \| Criterion \| Class \| Command \| Status \| Recorded tests \|/);
  assert.match(md, /\| FR-21 \| npm test \| LOCAL \| npm test \| NOT RUN \|/);
});

// ---- traceability.json (NFR-10)

const trace2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'cases', 'traceability.json'), 'utf8'));

test('traceability.json is valid and covers every AC-L01..15, FR-01..29 and NFR-01..12', () => {
  assert.deepEqual(validateTraceability(trace2), []);
  const kinds = (k) => trace2.criteria.filter((c) => c.kind === k).length;
  assert.deepEqual([kinds('AC-L'), kinds('FR'), kinds('NFR')], [15, 29, 12]);
});

test('traceability.json: the validator rejects a missing criterion and an unknown reference', () => {
  const broken = { criteria: trace2.criteria.filter((c) => c.id !== 'FR-10').map((c) => (c.id === 'FR-02' ? { ...c, refs: [{ type: 'bogus' }] } : c)) };
  const errors = validateTraceability(broken).join('\n');
  assert.match(errors, /FR-10 is missing/);
  assert.match(errors, /FR-02: unknown ref type bogus/);
});

test('traceability.json: every unit and e2e reference points at an existing test file and a valid title pattern', () => {
  for (const c of trace2.criteria) {
    for (const r of c.refs) {
      if (r.type === 'unit') assert.ok(fs.existsSync(path.join(ROOT, 'tests', 'unit', r.file)), `${c.id}: ${r.file}`);
      if (r.type === 'e2e') assert.ok(fs.existsSync(path.join(ROOT, 'tests', 'e2e', r.file)), `${c.id}: ${r.file}`);
      if (r.match) assert.doesNotThrow(() => new RegExp(r.match), `${c.id}: ${r.match}`);
    }
  }
});

test('traceability.json: every non-aggregate criterion declares a class and a command (FR-25)', () => {
  for (const c of trace2.criteria) {
    assert.ok(c.class && c.command, c.id);
    assert.match(c.class, /^(LOCAL|PROD-RO|TABLEAU|AWS)( \/ (LOCAL|PROD-RO|TABLEAU|AWS))*$/, c.id);
  }
});

// ---- manual intake: <out>/manual/<criterion-id>.json (Leader follow-up)

const evRoot = tmp();
fs.writeFileSync(path.join(evRoot, 'log.md'), 'npm ci output\n');
fs.writeFileSync(path.join(evRoot, 'empty.md'), '');
const manualRef = { type: 'manual', note: 'T-18 shell run' };
const record = (over = {}) => ({
  id: 'X-1', status: 'PASSED', evidenceFiles: ['log.md'], recordedAt: '2000-01-01T00:00:00Z', recordedBy: 'tester', commands: ['npm ci'], ...over,
});
const withManual = (refs, rec, inputs = {}) => statusOf(refs, { evidenceRoot: evRoot, manual: rec === undefined ? {} : { 'X-1': { record: rec } }, ...inputs });

test('status: a manual record with existing, non-empty evidence files sets the status and marks the files', () => {
  const r = withManual([manualRef], record());
  assert.equal(r.status, 'PASSED');
  assert.deepEqual(r.manualFiles, ['log.md']);
  assert.equal(withManual([manualRef], record({ status: 'BLOCKED (php on PATH)' })).status, 'BLOCKED (php on PATH)');
  assert.equal(withManual([manualRef], record({ status: 'FAILED' })).status, 'FAILED');
});

test('status: without a manual record the criterion stays NOT RUN', () => {
  assert.equal(withManual([manualRef], undefined).status, 'NOT RUN');
});

test('status: a manual record whose evidence file is missing, empty or outside the evidence folder is NOT RUN (manual record without evidence file)', () => {
  for (const files of [['nope.md'], ['empty.md'], ['../outside.md'], []]) {
    const r = withManual([manualRef], record({ evidenceFiles: files }));
    assert.equal(r.status, 'NOT RUN', JSON.stringify(files));
    assert.match(r.detail.join('\n'), /manual record without evidence file/);
  }
});

test('status: a malformed manual record (wrong id, unknown status, no author, bad JSON) is NOT RUN', () => {
  for (const bad of [record({ id: 'Y-9' }), record({ status: 'DONE' }), record({ recordedBy: '' }), record({ commands: [] })]) {
    assert.equal(withManual([manualRef], bad).status, 'NOT RUN');
  }
  assert.equal(statusOf([manualRef], { evidenceRoot: evRoot, manual: { 'X-1': { error: 'not valid JSON' } } }).status, 'NOT RUN');
});

test('status: a manual PASSED can never override an automated FAILED or an automated NOT RUN', () => {
  const failedUnit = parseJunit(junit([['alpha works (FR-X)', 'failure', 'boom'], ['beta works'], ['gamma 1']]));
  const refs = [unitRef('a.test.mjs', 'alpha'), manualRef];
  assert.equal(withManual(refs, record(), { unit: failedUnit }).status, 'FAILED');
  assert.equal(withManual(refs, record(), { unit: parseJunit(junit([['beta works']])) }).status, 'NOT RUN');
  assert.equal(withManual(refs, record(), { unit: parseJunit(junit([['alpha works (FR-X)']])) }).status, 'PASSED');
});

test('status: the summary marks a manual row with its evidence files and a hand-edited summary stays non-evidence', () => {
  const dir = tmp();
  const out = path.join(dir, 'out');
  fs.mkdirSync(path.join(out, 'manual'), { recursive: true });
  fs.writeFileSync(path.join(out, 'shell.md'), 'where.exe php: not found\n');
  fs.writeFileSync(path.join(out, 'manual', 'FR-24.json'), JSON.stringify({ id: 'FR-24', status: 'PASSED', evidenceFiles: ['shell.md'], recordedAt: 't', recordedBy: 'p', command: 'README run' }));
  const saved = process.env.EVIDENCE_SKIP_PROBES;
  process.env.EVIDENCE_SKIP_PROBES = '1';
  const log = console.log;
  console.log = () => {};
  try { run(['--reports', path.join(dir, 'r'), '--artifacts', path.join(dir, 'a'), '--out', out, '--date', '2000-01-01']); } finally { console.log = log; process.env.EVIDENCE_SKIP_PROBES = saved ?? ''; }
  const md = fs.readFileSync(path.join(out, 'summary.md'), 'utf8');
  assert.match(md, /\| FR-24 \|.*\| PASSED \| 0 manual \(evidence: shell\.md\) \|/);
  assert.match(md, /Do not edit by hand: a hand-edited file is not evidence/);
  const env = JSON.parse(fs.readFileSync(path.join(out, 'environment.json'), 'utf8'));
  assert.equal(env.statusCounts.PASSED, 2); // FR-24 and AC-L14, which aggregates only FR-24
});

// ---- raw report run times and path resolution (FR-25 statement fields)

test('status: raw report run time comes from the report itself, else from the file mtime', () => {
  const stat = { mtime: new Date('2001-02-03T04:05:06.000Z') };
  assert.deepEqual(ranAt('e2e/results.json', JSON.stringify({ stats: { startTime: '2020-01-01T00:00:00.000Z' } }), stat), { at: '2020-01-01T00:00:00.000Z', source: 'Playwright stats.startTime' });
  assert.deepEqual(ranAt('compare/report.json', JSON.stringify({ generatedAt: '2021-01-01T00:00:00.000Z' }), stat), { at: '2021-01-01T00:00:00.000Z', source: 'compare generatedAt' });
  assert.equal(ranAt('build-history.jsonl', rec({ t: '2022-01-01T00:00:00.000Z', ms: 5 }) + '\n', stat).at, '2022-01-01T00:00:00.000Z');
  assert.deepEqual(ranAt('unit.xml', '<testsuites/>', stat), { at: '2001-02-03T04:05:06.000Z', source: 'file mtime' });
  assert.equal(ranAt('e2e/results.json', 'not json', stat).source, 'file mtime');
});

test('status: the pipeline writes each raw report run time to environment.json and the summary', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'reports', 'e2e'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'reports', 'e2e', 'results.json'), JSON.stringify({ stats: { startTime: '2020-01-01T00:00:00.000Z' }, config: { projects: [] }, suites: [] }));
  const out = path.join(dir, 'out');
  const saved = process.env.EVIDENCE_SKIP_PROBES;
  process.env.EVIDENCE_SKIP_PROBES = '1';
  const log = console.log;
  console.log = () => {};
  try { run(['--reports', path.join(dir, 'reports'), '--artifacts', path.join(dir, 'a'), '--out', out, '--date', '2000-01-01']); } finally { console.log = log; process.env.EVIDENCE_SKIP_PROBES = saved ?? ''; }
  const env = JSON.parse(fs.readFileSync(path.join(out, 'environment.json'), 'utf8'));
  assert.equal(env.rawReports.find((r) => r.name === 'e2e/results.json').ranAt, '2020-01-01T00:00:00.000Z');
  assert.match(fs.readFileSync(path.join(out, 'summary.md'), 'utf8'), /e2e\/results\.json` \| copied \| 2020-01-01T00:00:00\.000Z \| Playwright stats\.startTime/);
});

test('status: a relative path given by flag resolves against the current directory, like compare.mjs', () => {
  const dir = tmp();
  const before = process.cwd();
  const saved = process.env.EVIDENCE_SKIP_PROBES;
  process.env.EVIDENCE_SKIP_PROBES = '1';
  const log = console.log;
  console.log = () => {};
  try {
    process.chdir(dir);
    run(['--reports', 'r', '--artifacts', 'a', '--out', 'rel-out', '--date', '2000-01-01']);
  } finally { process.chdir(before); console.log = log; process.env.EVIDENCE_SKIP_PROBES = saved ?? ''; }
  assert.ok(fs.existsSync(path.join(dir, 'rel-out', 'summary.md')));
});
