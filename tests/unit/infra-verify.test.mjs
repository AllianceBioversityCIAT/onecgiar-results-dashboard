// T-07: post-deploy verification (FR-16, NFR-03; design.md 7.5). Every case runs the verifier
// against a localhost server only. Mutated release copies live in the temp dir.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { startServer } from '../../scripts/serve.mjs';
import { verifyDeploy, buildUrlMap, ACCEPT_ENCODING } from '../../scripts/verify-deploy.mjs';
import { tempDir, cleanupTemp, ROOT } from '../helpers/build-run.mjs';

const APPROVED = '1f6d95a5efc5ea0f943b0475fe896da2472f8d67a701f4e9d173377fe9d8d075';
const RELEASE = path.join(ROOT, 'release', '1f6d95a5');
const manifest = JSON.parse(fs.readFileSync(path.join(RELEASE, 'manifest.json'), 'utf8'));

const servers = [];
async function serve(root) {
  const s = await startServer({ roots: [root], rules: true, port: 0 });
  servers.push(s);
  return `http://127.0.0.1:${s.port}`;
}

// A copy of the frozen dist with an optional mutation; returns the copy's dist dir.
function mutatedCopy(mutate) {
  const dir = path.join(tempDir('rd-verify-'), 'dist');
  fs.cpSync(path.join(RELEASE, 'dist'), dir, { recursive: true });
  mutate(dir);
  return dir;
}

after(async () => {
  await Promise.all(servers.map((s) => s.close()));
  cleanupTemp();
});

test('URL map covers every one of the 196 manifest files', () => {
  const map = buildUrlMap(manifest);
  assert.equal(Object.keys(manifest.files).length, 196);
  assert.equal(map.length, 196);
  assert.deepEqual(map.map((e) => e.file).sort(), Object.keys(manifest.files).sort());
  assert.equal(map.find((e) => e.file === 'home.html').url, '/');
  assert.equal(map.find((e) => e.file === 'partners--embed.html').url, '/partners?embed=true&displayNav=true');
  assert.equal(map.find((e) => e.file === 'partners--embed-nonav.html').url, '/partners?embed=true');
  assert.equal(map.find((e) => e.file === 'partnerships-2017.html').url, '/partnerships?year=2017');
  assert.equal(map.filter((e) => e.expectStatus === 404).length, 1);
  assert.equal(map.find((e) => e.file === '404.html').expectStatus, 404);
});

test('PASS with the approved hash on the frozen release served by serve.mjs', async () => {
  const base = await serve(path.join(RELEASE, 'dist'));
  const r = await verifyDeploy({ url: base, releaseDir: RELEASE });
  assert.deepEqual(r.failures, []);
  assert.equal(r.checked, 196);
  assert.equal(r.hash, APPROVED);
  assert.equal(r.ok, true);
});

test('FAIL naming the file when one byte of one asset differs', async () => {
  const target = Object.keys(manifest.files).find((f) => f.endsWith('.css'));
  const root = mutatedCopy((dir) => {
    const file = path.join(dir, ...target.split('/'));
    const buf = fs.readFileSync(file);
    buf[0] = buf[0] ^ 1;
    fs.writeFileSync(file, buf);
  });
  const r = await verifyDeploy({ url: await serve(root), releaseDir: RELEASE });
  assert.equal(r.ok, false);
  assert.notEqual(r.hash, APPROVED);
  assert.deepEqual(r.failures.map((f) => f.file), [target]);
});

test('FAIL naming the file when one HTML section differs by one byte', async () => {
  const root = mutatedCopy((dir) => {
    const file = path.join(dir, 'glossary--embed.html');
    fs.appendFileSync(file, ' ');
  });
  const r = await verifyDeploy({ url: await serve(root), releaseDir: RELEASE });
  assert.equal(r.ok, false);
  assert.deepEqual(r.failures.map((f) => f.file), ['glossary--embed.html']);
});

test('FAIL when one file is missing from the served site', async () => {
  const target = Object.keys(manifest.files).find((f) => f.startsWith('images/'));
  const root = mutatedCopy((dir) => fs.rmSync(path.join(dir, ...target.split('/'))));
  const r = await verifyDeploy({ url: await serve(root), releaseDir: RELEASE });
  assert.equal(r.ok, false);
  assert.deepEqual(r.failures.map((f) => f.file), [target]);
});

test('FAIL when the 404 page is missing: a 404 is accepted only for the 404 page, by bytes', async () => {
  const root = mutatedCopy((dir) => fs.rmSync(path.join(dir, '404.html')));
  const r = await verifyDeploy({ url: await serve(root), releaseDir: RELEASE });
  assert.equal(r.ok, false);
  assert.deepEqual(r.failures.map((f) => f.file), ['404.html']);
});

test('FAIL when nothing is reachable', async () => {
  const s = await startServer({ roots: [path.join(RELEASE, 'dist')], rules: true, port: 0 });
  const base = `http://127.0.0.1:${s.port}`;
  await s.close();
  const r = await verifyDeploy({ url: base, releaseDir: RELEASE });
  assert.equal(r.ok, false);
  assert.equal(r.failures.length, 196);
});

// A gzip-compressing front, like a CDN that compresses when the client accepts it.
async function compressingFront(upstream) {
  const srv = http.createServer((req, res) => {
    const up = http.request(upstream + req.url, { headers: req.headers }, (ures) => {
      const chunks = [];
      ures.on('data', (c) => chunks.push(c));
      ures.on('end', () => {
        let body = Buffer.concat(chunks);
        const headers = { ...ures.headers };
        if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
          body = zlib.gzipSync(body);
          headers['content-encoding'] = 'gzip';
        }
        headers['content-length'] = body.length;
        res.writeHead(ures.statusCode, headers);
        res.end(body);
      });
    });
    up.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  servers.push({ close: () => new Promise((r) => { srv.close(r); srv.closeAllConnections(); }) });
  return `http://127.0.0.1:${srv.address().port}`;
}

test('PASS through a compressing front because the verifier asks for identity', async () => {
  const base = await compressingFront(await serve(path.join(RELEASE, 'dist')));
  const r = await verifyDeploy({ url: base, releaseDir: RELEASE });
  assert.deepEqual(r.failures, []);
  assert.equal(r.ok, true);
  assert.equal(r.hash, APPROVED);
  assert.equal(ACCEPT_ENCODING, 'identity');
});

test('CLI exits 0 on the frozen release and 1 on a mutated copy', async () => {
  const good = await serve(path.join(RELEASE, 'dist'));
  const bad = await serve(mutatedCopy((dir) => fs.appendFileSync(path.join(dir, 'home.html'), 'x')));
  // Async spawn: the servers live in this process, so the event loop must stay free.
  const run = (url) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'verify-deploy.mjs'), '--url', url, '--release', RELEASE]);
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', (status) => resolve({ status, out }));
  });
  const ok = await run(good);
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.out, new RegExp(APPROVED));
  const ko = await run(bad);
  assert.equal(ko.status, 1, ko.out);
  assert.match(ko.out, /home\.html/);
});
