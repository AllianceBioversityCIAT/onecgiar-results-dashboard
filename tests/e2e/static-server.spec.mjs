// FR-29 plain static hosting (design 10.1 `static-server`): dist/ served by
// `serve.mjs --no-rules` on 8081 (a file server with no URL logic at all). The generated documents
// are opened directly and must render, issue their Tableau request to the external server and
// load every asset: the pages are self-contained static files and the rules only map clean URLs
// to files. Class: LOCAL.
import { test, expect, settle, localErrors, hostOf } from './helpers/network.mjs';
import { nonStaticLocalRequests as nonStatic } from './helpers/network.mjs';
import { rawRequest } from '../helpers/raw-http.mjs';

const BASE = 'http://localhost:8081';

// document -> what must render (selectors are the legacy ids/classes of P-16) and, where the
// page has a Tableau view, the server it must be requested from (FR-06 / FR-29).
const DOCUMENTS = [
  { file: '/home.html', container: '.dashboard-container', tableau: 'tableau-core.cgiar.org', nav: true },
  { file: '/innovations--embed.html', container: '.dashboard-container', tableau: 'tableau-core.cgiar.org', nav: false },
  { file: '/partnerships-2017.html', container: '#total-partnerships', tableau: 'public.tableau.com', nav: true },
  { file: '/glossary.html', container: '#svg-iframe', tableau: null, nav: true },
];

test.describe('dist/ served with no URL logic', () => {
  test('the server really has no rules: clean URLs are not mapped, files are served by exact path', async () => {
    const clean = await rawRequest({ port: 8081, target: '/innovations' });
    expect(clean.status).toBe(404);
    const root = await rawRequest({ port: 8081, target: '/' });
    expect(root.status).toBe(404);
    const trailing = await rawRequest({ port: 8081, target: '/innovations.html/' });
    expect(trailing.status).toBe(404);
    const file = await rawRequest({ port: 8081, target: '/innovations.html' });
    expect(file.status).toBe(200);
    // Same bytes as the rule-driven origin serves for the clean URL (the rules only choose the file).
    const mapped = await rawRequest({ port: 8080, target: '/innovations' });
    expect(file.body.equals(mapped.body)).toBe(true);
  });

  for (const doc of DOCUMENTS) {
    test(`${doc.file} renders header, menu and container, loads every asset`, async ({ page, net }) => {
      const res = await page.goto(`${BASE}${doc.file}`);
      expect(res.status()).toBe(200);
      await settle(page);

      await expect(page).toHaveTitle(/CGIAR/);
      const header = page.locator('header').first();
      const menu = page.locator('nav.main-menu #sections > li');
      await expect(header).toBeAttached();
      await expect(menu).toHaveCount(18);
      if (doc.nav) {
        await expect(header).toBeVisible();
        await expect(page.locator('nav.main-menu')).toBeVisible();
      }
      await expect(page.locator(doc.container).first()).toBeAttached();

      // Every same-origin asset answered 2xx/3xx on a server that cannot rewrite anything.
      expect(localErrors(net), 'assets that failed or answered >= 400 without rules').toEqual([]);
      expect(nonStatic(net.requests), 'same-origin requests that are not files of dist/').toEqual([]);
      const styles = await page.evaluate(() => [...document.styleSheets].filter((s) => (s.href || '').startsWith(location.origin)).length);
      expect(styles).toBeGreaterThan(3);

      if (doc.tableau) {
        // The Tableau request is issued to the external server (aborted here), never to this origin.
        await expect
          .poll(() => net.requests.filter((r) => r.host === doc.tableau && /\/views\//.test(r.url)).length, { timeout: 15_000 })
          .toBeGreaterThan(0);
        expect(net.requests.filter((r) => /\/views\//.test(r.url) && hostOf(r.url) !== doc.tableau).map((r) => r.url)).toEqual([]);
      }
    });
  }

  test('/widget/main.js loads and runs from the plain static server', async ({ page, net }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // A host page on the same origin; the widget script is the real file served by the no-rules server.
    await page.route(`${BASE}/__host.html`, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>host</title><div id="rd-host"></div><script src="/widget/main.js"></script>' }));
    await page.goto(`${BASE}/__host.html`);
    await page.waitForLoadState('load');
    const script = net.responses.find((r) => r.url === `${BASE}/widget/main.js`);
    expect(script?.status).toBe(200);
    expect(errors).toEqual([]);
    const res = await rawRequest({ port: 8081, target: '/widget/main.js' });
    expect(res.headers['content-type']).toMatch(/^text\/javascript/);
  });

  test('a page that depends on a rewritten URL only does not load on the plain server', async ({ page, net }) => {
    // Guard for the guard: a script loaded from a clean URL (what the rules would map) must show
    // up as a local error here, otherwise the document test above could not detect it.
    await page.route(`${BASE}/__rewritten.html`, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><script src="./policies"></script>' }));
    await page.goto(`${BASE}/__rewritten.html`);
    await page.waitForLoadState('load');
    expect(localErrors(net).some((e) => e.startsWith('404') && e.endsWith('/policies'))).toBe(true);
  });
});
