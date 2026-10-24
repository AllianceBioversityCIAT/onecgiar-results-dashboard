// FR-28, FR-29 (design 10.1 `network`): every request of every section goes to an allowed host;
// none to 192.0.2.50, *.amazonaws.com, results.cgiar.org (the old PHP site) or a `.php` path;
// the only same-origin requests are static files of dist/; Tableau views are requested from the
// external Tableau servers, never from the local origin. Hosts other than the loopback ones are
// ABORTED by the fixture (observed, never contacted). Class: LOCAL.
import { test, expect, settle, unexpectedHosts, forbiddenDestinations, nonStaticLocalRequests, isLocalHost, external } from './helpers/network.mjs';
import { SECTIONS, SECTIONS_WITHOUT_TABLEAU, site, TABLEAU_HOSTS } from './helpers/site.mjs';
import { markClass } from './helpers/tableau.mjs';

// FR-27 / design 10.1: exactly one class annotation per test.
test.beforeEach(async ({}, testInfo) => markClass(testInfo, 'LOCAL'));

// Each section, plus the variants that load different documents: legacy partnerships (public
// Tableau), an embed document and an embed-nonav document.
const PAGES = [
  ...SECTIONS.map((section) => ({ name: section, url: `/${section}`, section })),
  { name: 'partnerships legacy (year=2017)', url: '/partnerships?year=2017', section: 'partnerships', legacy: true },
  { name: 'home embed', url: '/home?embed=true&displayNav=true&hostOrigin=http%3A%2F%2Fhost.example', section: 'home' },
  { name: 'innovations embed-nonav', url: '/innovations?embed=true', section: 'innovations' },
];

for (const p of PAGES) {
  test.describe(p.name, () => {
    test('every request goes to an allowed host, none to the old PHP site, AWS or a .php path', async ({ page, net }) => {
      await page.goto(p.url);
      await settle(page);
      expect(net.requests.length).toBeGreaterThan(5);
      expect(unexpectedHosts(net.requests), 'requests to hosts outside allowedHosts').toEqual([]);
      expect(forbiddenDestinations(net.requests), '192.0.2.50, results.cgiar.org, amazonaws.com or .php').toEqual([]);
      expect(nonStaticLocalRequests(net.requests), 'same-origin requests that are not static files of dist/').toEqual([]);
    });

    if (SECTIONS_WITHOUT_TABLEAU.includes(p.section)) return;
    test('Tableau views are requested from the external server, never from the local origin', async ({ page, net }) => {
      const def = site.tableauViews[p.section];
      const spec = p.legacy ? def.legacy : def;
      await page.goto(p.url);
      await page.waitForLoadState('load');
      const viewRequests = () => net.requests.filter((r) => /\/views\/[^/]+\/[^/?]+/.test(r.url) && !isLocalHost(r.host));
      await expect.poll(() => viewRequests().length, { timeout: 15_000, message: `a /views/${spec.workbook}/ request to ${spec.server}` }).toBeGreaterThan(0);
      await page.waitForTimeout(1000);
      for (const r of viewRequests()) {
        expect(r.host, r.url).toBe(spec.server);
        expect(TABLEAU_HOSTS).toContain(r.host);
        expect(r.url).toContain(`/views/${spec.workbook}/`);
      }
      expect(viewRequests().some((r) => spec.views.some((v) => r.url.includes(`/${v}`)))).toBe(true);
      // Never local.
      expect(net.requests.filter((r) => isLocalHost(r.host) && /\/views\//.test(new URL(r.url).pathname)).map((r) => r.url)).toEqual([]);
    });
  });
}

test.describe('the checkers can fail (guards for the guards)', () => {
  test('a request to an unknown host and one to a .php path are detected', async ({ page, net }) => {
    await page.goto('/home');
    await page.waitForLoadState('load');
    await page.evaluate(() => {
      fetch('https://example.com/collect').catch(() => {});
      fetch('/api/data.php').catch(() => {});
      fetch('http://192.0.2.50/x').catch(() => {});
      fetch('https://results.cgiar.org/x').catch(() => {});
    });
    await page.waitForTimeout(500);
    expect(unexpectedHosts(net.requests)).toEqual(expect.arrayContaining(['https://example.com/collect']));
    const forbidden = forbiddenDestinations(net.requests);
    expect(forbidden).toEqual(expect.arrayContaining([
      expect.stringContaining('/api/data.php'),
      expect.stringContaining('192.0.2.50'),
      expect.stringContaining('results.cgiar.org'),
    ]));
    expect(nonStaticLocalRequests(net.requests).some((u) => u.endsWith('/api/data.php'))).toBe(true);
    // And none of them left the machine: the external ones were aborted by the fixture.
    expect(external(net).every((r) => net.failed.some((f) => f.url === r.url) || !/^(example\.com|192\.0\.2\.50|results\.cgiar\.org)$/.test(r.host))).toBe(true);
  });
});

test.describe('the abort contract', () => {
  // Deliberately does NOT use the `net` fixture: it is auto, so even a test that never asks for
  // it must have non-loopback requests aborted by the browser context, not by the network.
  test('a test that never mentions net still has external requests aborted', async ({ page }) => {
    await page.goto('/home');
    await page.waitForLoadState('load');
    const failures = [];
    page.on('requestfailed', (r) => failures.push({ url: r.url(), error: r.failure()?.errorText || '' }));
    const outcome = await page.evaluate(() => fetch('https://example.com/guard').then(() => 'reached', () => 'blocked'));
    await page.waitForTimeout(300);
    expect(outcome).toBe('blocked');
    const f = failures.find((x) => x.url === 'https://example.com/guard');
    expect(f, 'requestfailed event for the external request').toBeDefined();
    expect(f.error).toMatch(/BLOCKED_BY_CLIENT|Blocked by Web Inspector|NS_ERROR_FAILURE/); // each engine words a route abort differently (Firefox only says NS_ERROR_FAILURE)
  });
});

test.describe('Tableau frames', () => {
  test('an unknown host requested from inside a Tableau frame fails once tableauHosts is pinned', async ({ page, net }, testInfo) => {
    // Y-17: tableauHosts is pinned only from a rendered run. Until then the check cannot be made
    // honestly: it is BLOCKED, not passed. Here the Tableau frames are aborted, so no request ever
    // originates from inside one.
    // NOTE: once tableauHosts is pinned this test would pass VACUOUSLY while the frames stay
    // aborted (nothing is ever requested from inside them). T-13 owns the real check, from a
    // rendered run; do not read a green here as proof.
    if (site.tableauHosts.length === 0) {
      testInfo.annotations.push({ type: 'blocked', description: 'tableauHosts not pinned' });
      test.skip(true, 'BLOCKED (tableauHosts not pinned)');
    }
    await page.goto('/home');
    await settle(page);
    const fromFrames = net.requests.filter((r) => !r.isMainFrame && !isLocalHost(r.host));
    expect(unexpectedHosts(fromFrames, [...site.allowedHosts, ...site.tableauHosts])).toEqual([]);
  });
});
