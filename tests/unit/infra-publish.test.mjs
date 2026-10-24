// T-06: publish script (FR-15, FR-20, NFR-03; design.md 7.4, DD-06). No test runs the real AWS CLI:
// every case injects a recorder runner, and the CLI cases put a marker "aws" shim first on PATH.
// Mutated release copies live in the temp dir.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runPublish, buildPlan, verifyRelease, parseArgs } from '../../scripts/publish.mjs';
import { tempDir, cleanupTemp, ROOT } from '../helpers/build-run.mjs';

const RELEASE = path.join(ROOT, 'release', '1f6d95a5');
const manifest = JSON.parse(fs.readFileSync(path.join(RELEASE, 'manifest.json'), 'utf8'));
const GLOSSARY = 'csv/CGIAR Results Dashboard 2020 data - Project Management - Terms and Definitions List.csv';

after(() => cleanupTemp());

const noop = () => {};
const forbiddenRunner = () => { throw new Error('the AWS runner must not be reached'); };

// Recorder runner: records every argv and answers the three read calls the script makes.
function recorder({ stale = [] } = {}) {
  const calls = [];
  const runner = async (args) => {
    calls.push(args);
    const sub = args.slice(0, 2).join(' ');
    if (sub === 'cloudformation describe-stacks') {
      return { stdout: JSON.stringify([
        { OutputKey: 'DistributionId', OutputValue: 'EDIST123' },
        { OutputKey: 'SiteBucketName', OutputValue: 'rd-test-bucket' },
        { OutputKey: 'DistributionUrl', OutputValue: 'https://x.cloudfront.net/' },
      ]) };
    }
    if (sub === 's3api list-objects-v2') {
      return { stdout: JSON.stringify([...Object.keys(manifest.files).slice(0, 3), ...stale]) };
    }
    return { stdout: '' };
  };
  return { calls, runner };
}

function copyRelease() {
  const dir = path.join(tempDir('rd-publish-'), '1f6d95a5');
  fs.cpSync(RELEASE, dir, { recursive: true });
  return dir;
}

test('plan for the real release: 196 entries, Content-Type per extension, cache classes', () => {
  const plan = buildPlan(manifest);
  assert.equal(plan.length, 196);
  const byExt = {};
  for (const e of plan) byExt[path.extname(e.key)] = byExt[path.extname(e.key)] || e.contentType;
  assert.deepEqual(byExt, {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.eot': 'application/vnd.ms-fontobject',
    '.svg': 'image/svg+xml',
    '.ttf': 'font/ttf',
    '.woff': 'font/woff',
    '.png': 'image/png',
    '.js': 'text/javascript; charset=utf-8',
    '.woff2': 'font/woff2',
  });
  for (const e of plan) assert.equal(e.contentType, byExt[path.extname(e.key)], e.key);
  const short = plan.filter((e) => e.cacheControl === 'public, max-age=300').map((e) => e.key);
  assert.ok(short.includes('home.html') && short.includes('404.html') && short.includes('widget/main.js'));
  assert.equal(short.length, 55 + 1);
  const long = plan.find((e) => e.key === 'css/global.css');
  assert.equal(long.cacheControl, 'public, max-age=31536000, immutable');
  assert.deepEqual(plan.map((e) => e.key).sort(), Object.keys(manifest.files).sort());
});

test('unknown extension stops the plan, naming the file', () => {
  assert.throws(() => buildPlan({ files: { 'a.html': 'x', 'b.xyz': 'y' } }), /unknown extension.*b\.xyz/);
  assert.throws(() => buildPlan({ files: { LICENSE: 'x' } }), /unknown extension.*LICENSE/);
});

test('tampered release (one byte) stops before planning and before any runner call', async () => {
  const dir = copyRelease();
  const file = path.join(dir, 'dist', 'css', 'global.css');
  const bytes = fs.readFileSync(file);
  bytes[0] ^= 0x01;
  fs.writeFileSync(file, bytes);
  assert.throws(() => verifyRelease(dir), /mismatch/);
  const logs = [];
  await assert.rejects(
    runPublish({ env: 'test', releaseDir: dir, confirm: true, runner: forbiddenRunner, log: (l) => logs.push(l) }),
    /mismatch/,
  );
  assert.equal(logs.join('\n').includes('uploads'), false, 'no plan printed for a tampered release');
});

test('release folder name must match the hash prefix', () => {
  const dir = path.join(tempDir('rd-publish-'), 'deadbeef');
  fs.cpSync(RELEASE, dir, { recursive: true });
  assert.throws(() => verifyRelease(dir), /folder name/);
});

test('dry-run (default) prints the plan and the deletion rule and never reaches the runner', async () => {
  const logs = [];
  const r = await runPublish({
    env: 'test', releaseDir: RELEASE, runner: forbiddenRunner, makeRunner: forbiddenRunner, log: (l) => logs.push(l),
  });
  const out = logs.join('\n');
  assert.equal(r.dryRun, true);
  assert.equal(r.plan.length, 196);
  assert.match(out, /dry-run/i);
  assert.match(out, /196 uploads/);
  assert.match(out, /every bucket key not in the manifest is deleted/);
  assert.match(out, /no AWS call/i);
});

test('dry-run with an injected recorder issues zero runner calls', async () => {
  const { calls, runner } = recorder();
  await runPublish({ env: 'test', releaseDir: RELEASE, runner, log: noop });
  assert.equal(calls.length, 0);
});

test('--confirm without --env refuses; invalid env refuses; no runner call', async () => {
  const { calls, runner } = recorder();
  await assert.rejects(runPublish({ releaseDir: RELEASE, confirm: true, runner, log: noop }), /--env/);
  await assert.rejects(runPublish({ env: 'staging', releaseDir: RELEASE, confirm: true, runner, log: noop }), /--env/);
  assert.equal(calls.length, 0);
  assert.throws(() => parseArgs(['--confirm', '--release', RELEASE]), /--env/);
  assert.deepEqual(parseArgs(['--env', 'test', '--release', 'r', '--profile', 'p']),
    { env: 'test', release: 'r', confirm: false, profile: 'p' });
});

test('--confirm issues exactly the expected command sequence (no sync, headers on every cp)', async () => {
  const stale = ['old/leftover.js', 'index.old.html'];
  const { calls, runner } = recorder({ stale });
  const logs = [];
  const r = await runPublish({ env: 'test', releaseDir: RELEASE, confirm: true, profile: 'cgiar', runner, log: (l) => logs.push(l) });
  const plan = buildPlan(manifest);
  assert.equal(calls.length, 1 + 196 + 1 + stale.length + 1);
  const P = ['--profile', 'cgiar'];
  assert.deepEqual(calls[0], ['cloudformation', 'describe-stacks', '--stack-name', 'results-dashboard-test',
    '--query', 'Stacks[0].Outputs', '--output', 'json', ...P]);
  for (let i = 0; i < 196; i++) {
    const e = plan[i];
    assert.deepEqual(calls[1 + i], ['s3', 'cp', path.join(RELEASE, 'dist', ...e.key.split('/')),
      `s3://rd-test-bucket/${e.key}`, '--content-type', e.contentType, '--cache-control', e.cacheControl, ...P]);
  }
  assert.deepEqual(calls[197], ['s3api', 'list-objects-v2', '--bucket', 'rd-test-bucket',
    '--query', 'Contents[].Key', '--output', 'json', ...P]);
  assert.deepEqual(calls.slice(198, 200), stale.map((k) => ['s3', 'rm', `s3://rd-test-bucket/${k}`, ...P]));
  assert.deepEqual(calls[200], ['cloudfront', 'create-invalidation', '--distribution-id', 'EDIST123', '--paths', '/*', ...P]);
  const g = calls.find((c) => c[0] === 's3' && c[1] === 'cp' && c[2].endsWith('.csv'));
  assert.equal(g[3], `s3://rd-test-bucket/${GLOSSARY}`);
  for (const c of calls) {
    assert.notEqual(c[1], 'sync');
    assert.equal(c.includes('--recursive'), false);
    assert.equal(c.includes('build'), false);
  }
  assert.deepEqual(r.deleted, stale);
  assert.match(logs.join('\n'), /old\/leftover\.js/);
});

test('the deletion list is printed before the first delete is issued', async () => {
  const events = [];
  const { runner } = recorder({ stale: ['old/x.js'] });
  const wrapped = async (args) => { events.push(args[1] === 'rm' ? 'rm' : 'call'); return runner(args); };
  await runPublish({ env: 'test', releaseDir: RELEASE, confirm: true, runner: wrapped, log: (l) => { if (/old\/x\.js/.test(l)) events.push('printed'); } });
  assert.ok(events.indexOf('printed') > -1 && events.indexOf('printed') < events.indexOf('rm'));
});

test('a failing upload stops the run: no listing, no deletion, no invalidation', async () => {
  const { calls, runner } = recorder();
  let n = 0;
  const failing = async (args) => {
    if (args[0] === 's3' && args[1] === 'cp' && ++n === 5) throw new Error('boom');
    return runner(args);
  };
  await assert.rejects(runPublish({ env: 'test', releaseDir: RELEASE, confirm: true, runner: failing, log: noop }), /boom/);
  assert.equal(calls.some((c) => c[1] === 'rm' || c[0] === 'cloudfront' || c[0] === 's3api'), false);
});

function shimDir() {
  const dir = tempDir('rd-shim-');
  const marker = path.join(dir, 'aws-was-called');
  fs.writeFileSync(path.join(dir, 'aws.cmd'), `@echo off\r\necho x> "${marker}"\r\n`);
  fs.writeFileSync(path.join(dir, 'aws'), `#!/bin/sh\necho x > "${marker}"\n`, { mode: 0o755 });
  return { dir, marker };
}

test('CLI dry-run prints the plan, exits 0 and never starts an aws process', () => {
  const { dir, marker } = shimDir();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'publish.mjs'), '--env', 'test', '--release', RELEASE],
    { encoding: 'utf8', env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /196 uploads/);
  assert.equal(fs.existsSync(marker), false);
});

test('CLI --confirm without --env exits 1 and never starts an aws process', () => {
  const { dir, marker } = shimDir();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'publish.mjs'), '--confirm', '--release', RELEASE],
    { encoding: 'utf8', env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--env/);
  assert.equal(fs.existsSync(marker), false);
});
