// T-10: local server (design.md 7.4, FR-20, NFR-05, NFR-06, NFR-09). Traversal cases use the
// raw-socket helper only: fetch would normalize the target and prove nothing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { buildIndex, startServer, contentTypeOf } from '../../scripts/serve.mjs';
import { rawRequest } from '../helpers/raw-http.mjs';
import { runBuild, tempDir, cleanupTemp, ROOT } from '../helpers/build-run.mjs';

const write = (file, content = file) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const BS = String.fromCharCode(92); // backslash, spelled out so no layer can mangle it

let fx; // fixture: <base>/secret.txt (outside the roots), roots a and b
let plain; // --no-rules server over a, b
let site; // rules server over a temp build
let siteOut;

before(async () => {
  const base = tempDir('rd-serve-');
  fx = { base, a: path.join(base, 'a'), b: path.join(base, 'b') };
  write(path.join(base, 'secret.txt'), 'TOP-SECRET-OUTSIDE-ROOT');
  write(path.join(fx.a, 'Case.html'), '<p>case</p>');
  write(path.join(fx.a, 'dup.css'), 'from-a');
  write(path.join(fx.a, 'index.html'), '<p>index</p>');
  write(path.join(fx.a, 'sub', 'index.html'), '<p>sub</p>');
  write(path.join(fx.a, 'nolist', 'file.txt'), 'x');
  write(path.join(fx.a, '404.html'), '<p>custom 404</p>');
  write(path.join(fx.b, 'dup.css'), 'from-b');
  write(path.join(fx.b, 'only-b.js'), 'only-b');
  plain = await startServer({ roots: [fx.a, fx.b], rules: false, port: 0 });

  const built = runBuild();
  assert.equal(built.status, 0, built.stderr);
  siteOut = built.outDir;
  site = await startServer({ roots: [siteOut], rules: true, port: 0 });
});

after(async () => {
  await plain.close();
  await site.close();
  cleanupTemp();
});

const get = (srv, target, extra = {}) => rawRequest({ port: srv.port, target, ...extra });

test('index: exact case-sensitive paths, first root wins, no directories', () => {
  const idx = buildIndex([fx.a, fx.b]);
  assert.ok(idx.has('/Case.html'));
  assert.ok(!idx.has('/case.html'));
  assert.ok(!idx.has('/CASE.HTML'));
  assert.equal(fs.readFileSync(idx.get('/dup.css'), 'utf8'), 'from-a');
  assert.ok(idx.has('/only-b.js'));
  assert.ok(!idx.has('/sub') && !idx.has('/sub/') && !idx.has('/nolist'));
  const swapped = buildIndex([fx.b, fx.a]);
  assert.equal(fs.readFileSync(swapped.get('/dup.css'), 'utf8'), 'from-b');
});

test('case sensitivity over HTTP (NFR-05), independent of the Windows file system', async () => {
  assert.equal((await get(plain, '/Case.html')).status, 200);
  for (const t of ['/case.html', '/CASE.HTML', '/cASE.html']) assert.equal((await get(plain, t)).status, 404, t);
});

test('roots: first match wins, later root still reachable', async () => {
  assert.equal((await get(plain, '/dup.css')).body.toString(), 'from-a');
  assert.equal((await get(plain, '/only-b.js')).body.toString(), 'only-b');
});

test('Content-Type map, including image/svg+xml', () => {
  const expected = {
    'a.html': 'text/html; charset=utf-8', 'a.js': 'text/javascript; charset=utf-8', 'a.css': 'text/css; charset=utf-8',
    'a.svg': 'image/svg+xml', 'a.png': 'image/png', 'a.jpg': 'image/jpeg', 'a.gif': 'image/gif', 'a.ico': 'image/x-icon',
    'a.woff': 'font/woff', 'a.woff2': 'font/woff2', 'a.ttf': 'font/ttf', 'a.eot': 'application/vnd.ms-fontobject',
    'a.csv': 'text/csv; charset=utf-8', 'a.json': 'application/json; charset=utf-8', 'a.bin': 'application/octet-stream',
  };
  for (const [f, t] of Object.entries(expected)) assert.equal(contentTypeOf(f), t, f);
});

test('served files carry the right Content-Type and the emulated headers (NFR-06)', async () => {
  const r = await get(plain, '/Case.html');
  assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.ok(!('x-frame-options' in r.headers));
  const csp = r.headers['content-security-policy-report-only'];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-src 'self' https:\/\/tableau-core\.cgiar\.org https:\/\/public\.tableau\.com/);
  assert.match(csp, /script-src[^;]*'unsafe-inline'/);
  assert.match(csp, /style-src[^;]*'unsafe-inline'[^;]*fonts\.googleapis\.com/);
  assert.ok(!Object.keys(r.headers).includes('content-security-policy'));
  const missing = await get(plain, '/nope.txt');
  assert.equal(missing.headers['x-content-type-options'], 'nosniff');
});

test('HEAD: same status and headers as GET, no body', async () => {
  const g = await get(plain, '/Case.html');
  const h = await get(plain, '/Case.html', { method: 'HEAD' });
  assert.equal(h.status, 200);
  assert.equal(h.body.length, 0);
  assert.equal(h.headers['content-length'], g.headers['content-length']);
  assert.equal(h.headers['content-type'], g.headers['content-type']);
  const h404 = await get(plain, '/nope.txt', { method: 'HEAD' });
  assert.equal(h404.status, 404);
  assert.equal(h404.body.length, 0);
});

test('methods other than GET/HEAD get 405 with Allow (NFR-09)', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    for (const srv of [plain, site]) {
      const r = await get(srv, '/Case.html', { method, body: method === 'POST' || method === 'PUT' ? 'x=1' : undefined });
      assert.equal(r.status, 405, method);
      assert.equal(r.headers.allow, 'GET, HEAD');
    }
  }
});

test('no directory listing: a directory is never listed (plain server)', async () => {
  assert.equal((await get(plain, '/nolist/')).status, 404);
  assert.equal((await get(plain, '/nolist')).status, 404);
  assert.match((await get(plain, '/nolist/')).body.toString(), /custom 404/);
  assert.equal((await get(plain, '/sub/')).body.toString(), '<p>sub</p>');
  assert.equal((await get(plain, '/sub')).status, 404);
});

// Raw traversal inputs. FR-20: the response is 404 or 400 and no file outside the root is served.
const TRAVERSAL = [
  '/../secret.txt',
  '/a/../../secret.txt',
  '/%2e%2e/secret.txt',
  '/%2E%2E/secret.txt',
  '/%2e%2e%2fsecret.txt',
  '/..%2fsecret.txt',
  '/..%5csecret.txt',
  `/..${BS}secret.txt`,
  `/${BS}..${BS}secret.txt`,
  '/..%c0%afsecret.txt',
  '/%252e%252e/secret.txt',
  '/sub/..%2f..%2fsecret.txt',
  '//secret.txt',
  '/%00',
  '/Case.html%00.txt',
  '/%zz',
  'http://localhost/../secret.txt',
  '../secret.txt',
  '*',
];

for (const [name, getSrv] of [['plain', () => plain], ['rules', () => site]]) {
  test(`raw-socket traversal is 404/400 and serves nothing outside the root (${name})`, async () => {
    for (const t of TRAVERSAL) {
      const r = await get(getSrv(), t);
      assert.ok(r.status === 404 || r.status === 400, `${JSON.stringify(t)} -> ${r.statusLine}`);
      assert.ok(!r.body.toString('latin1').includes('TOP-SECRET'), t);
    }
  });
}

test('FR-20 scenario: the prod settings path and its encoded variants (rules server)', async () => {
  for (const t of [
    '/../resultsDashboard-prod/resultsDashboard/app/settings.php',
    '/%2e%2e/resultsDashboard-prod/resultsDashboard/app/settings.php',
    '/%2e%2e%2fresultsDashboard-prod%2fresultsDashboard%2fapp%2fsettings.php',
  ]) {
    const r = await get(site, t);
    assert.ok(r.status === 404 || r.status === 400, `${t} -> ${r.statusLine}`);
    assert.ok(!r.body.toString('latin1').includes('<?php'));
  }
});

test('control and non-ASCII bytes in the target never reach the files (Node parser, P-31)', async () => {
  for (const bytes of [[0x2f, 0x61, 0x09, 0x62], [0x2f, 0x61, 0x00, 0x62], [0x2f, 0xc3, 0xa9], [0x2f, 0x61, 0x7f], [0x2f, 0x61, 0x20, 0x62]]) {
    for (const srv of [plain, site]) {
      const r = await get(srv, Buffer.from(bytes));
      assert.equal(r.status, 400, Buffer.from(bytes).toString('hex'));
    }
  }
});

test('rules server: sections, redirects, 404 body, static assets', async () => {
  const sdg = fs.readFileSync(path.join(siteOut, 'SDG.html'));
  const home = await get(site, '/');
  assert.equal(home.status, 200);
  assert.equal(home.headers['content-type'], 'text/html; charset=utf-8');
  const s = await get(site, '/SDG');
  assert.equal(s.status, 200);
  assert.ok(s.body.equals(sdg));
  const embed = await get(site, '/SDG?embed=true&displayNav=true');
  assert.ok(embed.body.equals(fs.readFileSync(path.join(siteOut, 'SDG--embed.html'))));
  const r = await get(site, '/homeV1/');
  assert.equal(r.status, 301);
  assert.equal(r.headers.location, '/');
  assert.equal((await get(site, '/SDG.html')).headers.location, '/SDG');
  const notFoundBody = fs.readFileSync(path.join(siteOut, '404.html'));
  const nf = await get(site, '/no-such-thing');
  assert.equal(nf.status, 404);
  assert.ok(nf.body.equals(notFoundBody));
  const deep = await get(site, '/css/does/not/exist.css');
  assert.equal(deep.status, 404);
  assert.ok(deep.body.equals(notFoundBody));
  const cssName = fs.readdirSync(path.join(siteOut, 'css'))[0];
  const css = await get(site, `/css/${cssName}`);
  assert.equal(css.status, 200);
  assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
  assert.equal((await get(site, '/CSS/' + cssName)).status, 404, 'static path casing is exact');
  assert.equal((await get(site, '/sdg')).status, 404);
  assert.equal((await get(site, '/SDG.html', { method: 'HEAD' })).body.length, 0);
});

test('rules server: bad raw paths and open-redirect shapes (rules 0a/0b through the adapter)', async () => {
  assert.equal((await get(site, '/a#b')).status, 400);
  assert.equal((await get(site, '/a^b')).status, 400);
  assert.equal((await get(site, '//evil.com/')).status, 404);
  assert.equal((await get(site, `/${BS}evil.com/`)).status, 404);
  assert.equal((await get(site, 'http://evil.com/x')).status, 400);
});

test('binds loopback only (IPv4, and IPv6 when available)', async () => {
  for (const s of site.servers) assert.ok(['127.0.0.1', '::1'].includes(s.address().address), s.address().address);
  assert.equal(site.servers[0].address().address, '127.0.0.1');
  if (site.servers.length === 2) {
    const r = await rawRequest({ port: site.port, host: '::1', target: '/no-such-thing' });
    assert.equal(r.status, 404);
  } else {
    assert.ok(site.warnings.length > 0);
  }
});

test('port in use: startServer rejects with EADDRINUSE', async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const port = blocker.address().port;
  try {
    await assert.rejects(startServer({ roots: [fx.a], rules: false, port }), { code: 'EADDRINUSE' });
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});

test('port in use: npm run serve exits non-zero with a message naming PORT', async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const port = blocker.address().port;
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'serve.mjs'), '--root', fx.a, '--no-rules'], {
      encoding: 'utf8', env: { ...process.env, PORT: String(port) }, timeout: 20000,
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, new RegExp(`port ${port} is already in use`));
    assert.match(r.stderr, /PORT=/);
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});

test('invalid PORT is rejected with a message naming PORT', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'serve.mjs'), '--root', fx.a], {
    encoding: 'utf8', env: { ...process.env, PORT: 'abc' }, timeout: 20000,
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /invalid PORT "abc"/);
});

// Wildcard holders: on Windows a listener on 0.0.0.0 or :: does not make bind(127.0.0.1) fail, so
// startServer probes loopback with a TCP connect before listening.
const holdOn = (host) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(null));
  s.listen({ port: 0, host }, () => resolve(s));
});
const closeHolder = (s) => new Promise((r) => s.close(r));

for (const host of ['0.0.0.0', '::']) {
  test(`port in use by a wildcard listener (${host}): startServer rejects with EADDRINUSE`, async (t) => {
    const blocker = await holdOn(host);
    if (!blocker) return t.skip(`${host} unavailable on this machine`);
    const port = blocker.address().port;
    try {
      let started;
      try {
        await assert.rejects((started = startServer({ roots: [fx.a], rules: false, port })), { code: 'EADDRINUSE' });
      } finally {
        if (started) await started.then((x) => x.close(), () => {});
      }
    } finally {
      await closeHolder(blocker);
    }
  });

  test(`port in use by a wildcard listener (${host}): npm run serve names PORT and exits 1`, async (t) => {
    const blocker = await holdOn(host);
    if (!blocker) return t.skip(`${host} unavailable on this machine`);
    const port = blocker.address().port;
    try {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'serve.mjs'), '--root', fx.a, '--no-rules'], {
        encoding: 'utf8', env: { ...process.env, PORT: String(port) }, timeout: 20000,
      });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, new RegExp(`port ${port} is already in use`));
      assert.match(r.stderr, /PORT=\d+ npm run serve/);
      assert.match(r.stderr, /\$env:PORT=\d+; npm run serve/);
    } finally {
      await closeHolder(blocker);
    }
  });
}

test('startup log says the index is a snapshot and to restart after a rebuild', async () => {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'serve.mjs'), '--root', fx.a, '--no-rules'], {
    env: { ...process.env, PORT: '0' },
  });
  let out = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no listening line: ' + out)), 15000);
      child.stdout.on('data', (d) => {
        out += d;
        if (out.includes('listening on')) { clearTimeout(timer); resolve(); }
      });
      child.on('exit', () => { clearTimeout(timer); reject(new Error('exited early: ' + out)); });
    });
    assert.match(out, /snapshot.*restart/i);
  } finally {
    child.kill();
  }
});
