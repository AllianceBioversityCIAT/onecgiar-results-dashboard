// NFR-04 build-time gate (design §10.1 `build-time.test`, §9, DD-18): one clean build in a child
// process into its own temporary BUILD_OUT_DIR; fails when elapsedMs > BUILD_TIME_BUDGET_MS.
// Runs serialized (npm test uses --test-concurrency=1) so no other test competes for the CPU.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBuild, cleanupTemp, ROOT } from '../helpers/build-run.mjs';

const DESIGN_DEFAULT_BUDGET_MS = 60000; // NFR-04 / design §9 default
const budgetMs = Number(process.env.BUILD_TIME_BUDGET_MS || DESIGN_DEFAULT_BUDGET_MS);
const idleAttested = process.env.BUILD_IDLE_ATTESTED === '1';

let build;
let record;
let persistentBefore;
let persistentAfter;
const persistentFile = join(ROOT, 'artifacts', 'build-history.jsonl');
const countLines = () => (existsSync(persistentFile) ? readFileSync(persistentFile, 'utf8').split('\n').filter(Boolean).length : 0);

before(() => {
  build = runBuild({ env: { BUILD_TIME_BUDGET_MS: String(budgetMs) } });
  const lines = readFileSync(join(build.artifacts, 'build-history.jsonl'), 'utf8').trim().split('\n');
  record = JSON.parse(lines[lines.length - 1]);
  // Z-6: the temp history is deleted by after(); persist the gate's record (append only) before any assertion,
  // so a FAILED timing is never silently discarded.
  persistentBefore = countLines();
  mkdirSync(join(ROOT, 'artifacts'), { recursive: true });
  const gate = build.status === 0 && record.elapsedMs <= budgetMs ? 'PASSED' : 'FAILED';
  appendFileSync(persistentFile, `${JSON.stringify({ ...record, source: 'build-time.test', gate })}\n`);
  persistentAfter = countLines();
});
after(() => cleanupTemp());

test('default budget comes from site.json and is 60 000 ms (NFR-04)', () => {
  const site = JSON.parse(readFileSync(join(ROOT, 'src', 'data', 'site.json'), 'utf8'));
  assert.equal(site.buildTimeBudgetMs, DESIGN_DEFAULT_BUDGET_MS);
});

test('a clean build succeeds in a child process', () => {
  assert.equal(build.status, 0, build.stderr);
});

test(`clean build elapsedMs <= BUILD_TIME_BUDGET_MS (${budgetMs})`, () => {
  assert.equal(typeof record.elapsedMs, 'number');
  assert.ok(
    record.elapsedMs <= budgetMs,
    `NFR-04 FAILED: build took ${record.elapsedMs} ms, budget ${budgetMs} ms (re-run on an idle machine with BUILD_IDLE_ATTESTED=1 to override a failed timing)`,
  );
});

test('history record keeps budget, clean flag and idle attestation (design §7.1 step 11)', () => {
  assert.equal(record.budgetMs, budgetMs);
  assert.equal(record.clean, true);
  assert.equal(record.idle, idleAttested);
});

test('the gate record is appended to the persistent artifacts/build-history.jsonl (Z-6)', () => {
  assert.equal(persistentAfter, persistentBefore + 1);
  const lines = readFileSync(persistentFile, 'utf8').trim().split('\n');
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.source, 'build-time.test');
  assert.equal(last.elapsedMs, record.elapsedMs);
  assert.equal(last.gate, record.elapsedMs <= budgetMs ? 'PASSED' : 'FAILED');
});
