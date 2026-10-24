// FR-06 (design 10.1 `tableau-request`), FR-29, FR-28. Class: LOCAL.
// Observes the request the browser issues for every Tableau view (view path + the `Year` option,
// P-30) WITHOUT blocking it: the Tableau hosts are released by the opt-in of helpers/network.mjs,
// every other external host stays aborted. Read-only GETs a visitor's browser makes when opening
// the page. The verdict never depends on the view rendering (FR-06 AND IT MUST): the request is
// recorded when the browser issues it, whatever Tableau answers.
// Fresh browser profile: Playwright creates a new context per test (no cookies, no storage); the
// first test asserts it (Disqualifier V-01).
import { test, expect, isLocalHost } from './helpers/network.mjs';
import { markClass } from './helpers/tableau.mjs';
import { SECTIONS, SECTIONS_WITHOUT_TABLEAU, site, TABLEAU_HOSTS } from './helpers/site.mjs';

test.use({ allowHosts: TABLEAU_HOSTS });

// Class (FR-27, design 10.1): `tableau-request` is LOCAL. It asserts the request the page issues, which
// is verifiable whether or not Tableau answers, so a failure must fail the command (FR-22 BUT).
const REQUEST_CLASS = 'LOCAL';
test.beforeEach(async ({}, testInfo) => markClass(testInfo, REQUEST_CLASS));

// Expected views come from the requirement/inventory values in site.tableauViews (the unit test
// tableau-views.test.mjs ties that table to the page JS).
const sections = SECTIONS.filter((s) => !SECTIONS_WITHOUT_TABLEAU.includes(s));
const CASES = [
  ...sections.map((s) => ({ name: s, url: `/${s}`, def: site.tableauViews[s], year: '2021' })),
  { name: 'partnerships legacy (year=2017)', url: '/partnerships?year=2017', def: site.tableauViews.partnerships.legacy, year: '2017' },
];

const viewRequests = (net) => net.requests.filter((r) => !isLocalHost(r.host) && /\/views\/[^/]+\/[^/?#]+/.test(new URL(r.url).pathname));
const viewPath = (url) => new URL(url).pathname;
// `Year=` as a query (or fragment) parameter of the iframe URL, URL-decoded; null when absent.
const yearOf = (url) => {
  const m = /[?&#]Year=([^&#]*)/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
};

test('the browser context starts as a fresh profile (V-01)', async ({ context, page }) => {
  expect(await context.cookies()).toEqual([]);
  await page.goto('/home');
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

for (const c of CASES) {
  test(`${c.name}: every view is requested from ${c.def.server} with Year=${c.year}`, async ({ page, net }) => {
    await page.goto(c.url);
    const expected = c.def.views.map((v) => `/views/${c.def.workbook}/${v}`).sort();
    await expect.poll(() => [...new Set(viewRequests(net).map((r) => viewPath(r.url)))].sort(), {
      timeout: 20_000,
      message: `view requests to ${c.def.server}`,
    }).toEqual(expected);
    for (const r of viewRequests(net)) {
      expect(r.host, r.url).toBe(c.def.server);
      expect(TABLEAU_HOSTS).toContain(r.host);
      expect(yearOf(r.url), r.url).toBe(c.year);
    }
    // FR-29: Tableau is never served by the local origin.
    expect(net.requests.filter((r) => isLocalHost(r.host) && /\/views\//.test(new URL(r.url).pathname)).map((r) => r.url)).toEqual([]);
  });
}

test.describe('the Year option reaches the Tableau request (FR-06 scenario, FR-07 table)', () => {
  const YEARS = [
    { q: '?year=2019', expected: '2019' },
    { q: '', expected: '2021' },
    { q: '?year=', expected: '' },
    { q: '?year=abc', expected: 'abc' },
  ];
  for (const y of YEARS) {
    test(`/caseReports${y.q} requests https://tableau-core.cgiar.org/views/AR-OICR/OCIR-DB-Full with Year=${JSON.stringify(y.expected)}`, async ({ page, net }) => {
      await page.goto(`/caseReports${y.q}`);
      await expect.poll(() => viewRequests(net).length, { timeout: 20_000 }).toBeGreaterThan(0);
      const rs = viewRequests(net);
      expect(rs.map((r) => r.url.split(/[?#]/)[0])).toContain('https://tableau-core.cgiar.org/views/AR-OICR/OCIR-DB-Full');
      for (const r of rs) expect(yearOf(r.url), r.url).toBe(y.expected);
    });
  }
});
