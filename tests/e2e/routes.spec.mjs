// FR-13, FR-20, FR-04 over real HTTP (design 10.1 `routes`). Malformed and traversal targets go
// through the raw-socket client (tests/helpers/raw-http.mjs), which writes the request line byte
// for byte; fetch/Playwright would normalize `\` and `..` and never deliver them (Y-6, P-32).
// Class: LOCAL.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './helpers/network.mjs';
import { rawRequest } from '../helpers/raw-http.mjs';
import { ROOT, SECTIONS, DIST } from './helpers/site.mjs';
import { markClass } from './helpers/tableau.mjs';

// FR-27 / design 10.1: exactly one class annotation per test.
test.beforeEach(async ({}, testInfo) => markClass(testInfo, 'LOCAL'));

const { cases } = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'cases', 'routing-cases.json'), 'utf8'));
const PORTS = [8080, 8090];

// A request line cannot carry these bytes in the query without becoming a different request,
// so those cases stay in the unit suite (calling the core with the raw string).
// Node's HTTP parser also refuses DEL and bytes >= 0x80 in the target with 400 before the rules
// run, so those cases are asserted separately ("bytes the HTTP layer refuses").
const undeliverable = (c) => /[\r\n\t \u007f-￿]/.test(c.query || '');
const deliverable = cases.filter((c) => c.modes === 'both' && c.expect.type !== 'pass' && !undeliverable(c));

const targetOf = (c) => c.path + (c.query !== undefined && c.query !== '' ? `?${c.query}` : '');

for (const port of PORTS) {
  test.describe(`routing-cases.json over raw sockets on ${port}`, () => {
    for (const c of deliverable) {
      test(`${c.id}: ${c.method || 'GET'} ${JSON.stringify(c.path)} -> ${c.status}`, async () => {
        const res = await rawRequest({ port, method: c.method || 'GET', target: targetOf(c), hostHeader: `127.0.0.1:${port}` });
        expect(res.status, res.statusLine).toBe(c.status);
        if (c.expect.type === 'redirect') {
          expect(res.headers.location).toBe(c.expect.location);
          // FR-13 no-open-redirect invariant: same site, never `//` or `\` at the start.
          expect(res.headers.location).toMatch(/^\/(?![/\\])|^\/$/);
        }
        if (c.expect.type === 'notFound') {
          expect(res.body.toString('utf8')).toContain('Page not found'); // the site's own 404
          expect(res.body.toString('utf8')).not.toMatch(/Traceback|Exception|at .*\.js:\d+/);
        }
        if (c.expect.type === 'rewrite') {
          expect(res.headers['content-type']).toMatch(/^text\/html/);
        }
      });
    }
  });
}

test.describe('bytes the HTTP layer refuses', () => {
  for (const [name, target] of [['DEL', '/homeV1/?a='], ['non-ASCII byte', '/homeV1/?a=é'], ['DEL + non-ASCII', '/homeV1/?a=é']]) {
    test(`${name} in the query is answered 400 and never served or redirected`, async () => {
      const res = await rawRequest({ port: 8080, target });
      expect(res.status).toBe(400);
      expect(res.headers.location).toBeUndefined();
    });
  }
});

test.describe('redirects are terminal (FR-13 no-loop scenario)', () => {
  const redirects = deliverable.filter((c) => c.expect.type === 'redirect' && !c.method);
  for (const c of redirects) {
    test(`${c.id}: Location resolves to a non-redirect`, async () => {
      const first = await rawRequest({ port: 8080, target: targetOf(c), hostHeader: 'localhost:8080' });
      expect(first.status).toBe(301);
      const next = await rawRequest({ port: 8080, target: first.headers.location, hostHeader: 'localhost:8080' });
      expect(next.status, `${first.headers.location} -> ${next.statusLine}`).not.toBe(301);
      expect(next.headers.location).toBeUndefined();
    });
  }
});

test.describe('statuses and headers through the HTTP client', () => {
  test('/ is the home content with 200 and HTML content type', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/^text\/html/);
    expect(await res.text()).toContain('CGIAR Results Dashboard');
  });

  for (const section of SECTIONS) {
    test(`/${section} answers 200 and /${section}/ redirects to it keeping the query`, async ({ request }) => {
      expect((await request.get(`/${section}`)).status()).toBe(200);
      const res = await request.get(`/${section}/?year=2019`, { maxRedirects: 0 });
      expect(res.status()).toBe(301);
      expect(res.headers().location).toBe(`/${section}?year=2019`);
    });
  }

  test('case-sensitive: /sdg is the site 404, /SDG is 200', async ({ request }) => {
    expect((await request.get('/SDG')).status()).toBe(200);
    const res = await request.get('/sdg');
    expect(res.status()).toBe(404);
    expect(await res.text()).toContain('Page not found');
  });

  test('HEAD returns the headers of GET without a body', async ({ request }) => {
    for (const url of ['/innovations', '/js/global.js', '/zz-not-a-section']) {
      const get = await request.get(url);
      const head = await request.head(url);
      expect(head.status(), url).toBe(get.status());
      expect(head.headers()['content-type'], url).toBe(get.headers()['content-type']);
      expect(head.headers()['content-length'], url).toBe(get.headers()['content-length']);
      expect((await head.body()).length, url).toBe(0);
    }
  });

  test('static files: Content-Type values, including image/svg+xml', async ({ request }) => {
    const expectations = {
      '/js/global.js': /^text\/javascript/,
      '/css/global.css': /^text\/css/,
      '/images/svg-interactive.svg': /^image\/svg\+xml/,
      '/images/cgiar_logo.png': /^image\/png/,
      '/widget/main.js': /^text\/javascript/,
      '/third-party/fontawesome/webfonts/fa-solid-900.woff2': /^font\/woff2/,
    };
    for (const [url, type] of Object.entries(expectations)) {
      const res = await request.get(url);
      expect(res.status(), url).toBe(200);
      expect(res.headers()['content-type'], url).toMatch(type);
    }
  });

  test('POST is 405 with Allow: GET, HEAD', async ({ request }) => {
    const res = await request.post('/innovations', { data: 'x' });
    expect(res.status()).toBe(405);
    expect(res.headers().allow).toBe('GET, HEAD');
  });

  test('the canonical-host rule is disabled locally (FR-15): a foreign Host is served, not redirected', async () => {
    const res = await rawRequest({ port: 8080, target: '/innovations?year=2019', hostHeader: 'www.results.cgiar.org' });
    expect(res.status).toBe(200);
    expect(res.headers.location).toBeUndefined();
  });

  test('unknown nested path: 404 page with its styles loaded', async ({ page }) => {
    const sheets = [];
    page.on('response', (r) => { if (r.url().includes('/css/global.css')) sheets.push(r.status()); });
    const res = await page.goto('/foo/bar');
    expect(res.status()).toBe(404);
    await expect(page.locator('h1')).toHaveText('Page not found');
    await page.waitForLoadState('load');
    expect(sheets).toEqual([200]); // absolute /css/... URL works at any depth
    const rules = await page.evaluate(() => {
      const sheet = [...document.styleSheets].find((s) => (s.href || '').includes('/css/global.css'));
      return sheet ? sheet.cssRules.length : -1;
    });
    expect(rules).toBeGreaterThan(0);
  });
});

test.describe('two origins serve the same dist/ unchanged (FR-04)', () => {
  const origins = ['http://localhost:8080', 'http://127.0.0.1:8080', 'http://127.0.0.1:8090', 'http://localhost:8090'];
  for (const origin of origins) {
    test(`${origin}/innovations renders with every local resource`, async ({ page }) => {
      const bad = [];
      page.on('response', (r) => { if (r.url().startsWith(origin) && r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
      await page.route((u) => !['localhost', '127.0.0.1'].includes(u.hostname), (r) => r.abort('blockedbyclient'));
      const res = await page.goto(`${origin}/innovations`);
      expect(res.status()).toBe(200);
      await page.waitForLoadState('load');
      await expect(page.locator('nav.main-menu #sections > li')).toHaveCount(18);
      expect(await page.evaluate(() => document.styleSheets.length)).toBeGreaterThan(3);
      expect(bad).toEqual([]);
    });
  }

  test('dist/ names neither localhost, 127.0.0.1 nor a local port in any page', async () => {
    for (const file of fs.readdirSync(DIST).filter((f) => f.endsWith('.html'))) {
      const html = fs.readFileSync(path.join(DIST, file), 'utf8');
      expect(html, file).not.toMatch(/localhost|127\.0\.0\.1|:80(80|81|90)\b/);
    }
  });
});

test.describe('requests outside dist/ (FR-20)', () => {
  const targets = [
    '/../resultsDashboard-prod/resultsDashboard/app/settings.php',
    '/%2e%2e%2fresultsDashboard-prod/resultsDashboard/app/settings.php',
    '/%2e%2e/resultsDashboard-prod/resultsDashboard/app/settings.php',
    '/..%2f..%2fpackage.json',
    '/..\\..\\package.json',
    '/js/../../package.json',
    '/package.json',
    '/scripts/serve.mjs',
    '/src/data/site.json',
    '/node_modules/@playwright/test/package.json',
  ];
  for (const port of PORTS) {
    for (const target of targets) {
      test(`${port} ${target} serves nothing from outside dist/`, async () => {
        const res = await rawRequest({ port, target, hostHeader: `127.0.0.1:${port}` });
        expect([400, 404]).toContain(res.status);
        const body = res.body.toString('utf8');
        expect(body).not.toContain('<?php');
        expect(body).not.toContain('"devDependencies"');
        expect(body).not.toContain('createServer');
      });
    }
  }

  test('dist/ has no directory listing: /js and /images answer without an index', async () => {
    for (const target of ['/images', '/js', '/third-party']) {
      const res = await rawRequest({ port: 8080, target, hostHeader: 'localhost:8080' });
      expect(res.status).toBe(404);
      expect(res.body.toString('utf8')).not.toMatch(/Index of|<a href="global\.js/);
    }
  });
});
