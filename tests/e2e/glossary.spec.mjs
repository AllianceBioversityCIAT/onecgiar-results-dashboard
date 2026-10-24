// FR-10 (design 10.1 `glossary`, P-25). Class: LOCAL.
//  - the SVG in the same-origin iframe loads its 3 scripts (P-25)
//  - the CSV whose file name contains spaces loads without a 404
//  - header filters are hidden on /glossary
//  - Chromium/Firefox: a click on "Sphere of influence" filters the table
//  - WebKit: the static fallback image is shown (glossary.js treats Safari by user agent)
// A browser where a behaviour does not apply by design is annotated `not-applicable` and skipped,
// never silently passed. jQuery loads twice on this page, for parity (S-8): not a failure.
import { test, expect, settle, localErrors } from './helpers/network.mjs';
import { markClass } from './helpers/tableau.mjs';

// FR-27 / design 10.1: exactly one class annotation per test.
test.beforeEach(async ({}, testInfo) => markClass(testInfo, 'LOCAL'));

// Literal expectations, from the shipped CSV (columns "1".."3" and "Term"), not recomputed by the
// page's own logic.
const CSV_FILE = 'CGIAR Results Dashboard 2020 data - Project Management - Terms and Definitions List.csv';
const SVG_SCRIPTS = [
  '/js/libs/snap/snap.svg-min.js',
  '/js/svg-interactive.js',
  '/js/libs/jquery/jquery-3.4.1.min.js',
];
const SPHERE_OF_INFLUENCE_TERMS = ['Outcomes', 'Sphere of influence']; // marked "x" in column 2
const SPHERE_OF_CONTROL_TERMS = ['Outputs', 'Peer-reviewed papers', 'Sphere of control']; // column 1

const isWebkit = (browserName) => browserName === 'webkit';

function notApplicable(testInfo, reason) {
  testInfo.annotations.push({ type: 'not-applicable', description: reason });
  test.skip(true, reason);
}

const pathOf = (url) => new URL(url).pathname;

test.describe('glossary', () => {
  test.beforeEach(async ({ page }) => {
    const response = await page.goto('/glossary');
    expect(response.status()).toBe(200);
    await settle(page);
  });

  test('the SVG iframe loads its 3 scripts (P-25), each answered 200', async ({ net }) => {
    for (const script of SVG_SCRIPTS) {
      const hits = net.responses.filter((r) => pathOf(r.url) === script);
      expect(hits.length, `no response for ${script}`).toBeGreaterThan(0);
      expect(hits.map((r) => r.status), `status of ${script}`).not.toContain(404);
      expect(hits.every((r) => r.status === 200), `all responses of ${script} are 200`).toBe(true);
    }
    // The SVG document itself is requested from inside the iframe.
    expect(net.responses.some((r) => pathOf(r.url) === '/images/svg-interactive.svg' && r.status === 200)).toBe(true);
  });

  test('the CSV whose name contains spaces loads without 404', async ({ net }) => {
    const csv = net.responses.filter((r) => decodeURIComponent(pathOf(r.url)) === `/csv/${CSV_FILE}`);
    expect(csv.length, `no response for /csv/${CSV_FILE}`).toBeGreaterThan(0);
    expect(csv.map((r) => r.status), 'status of the CSV').toEqual(csv.map(() => 200));
    expect(localErrors(net), 'local resources that failed or answered >= 400').toEqual([]);
  });

  test('the header filters are hidden', async ({ page }) => {
    await expect(page.locator('#pageheader')).toBeVisible();
    await expect(page.locator('#pageheader .filters')).toHaveCount(0);
    await expect(page.locator('.filter-component:visible')).toHaveCount(0);
  });

  test('all terms are listed on load', async ({ page }) => {
    await expect(page.locator('table caption.tableCaption')).toHaveText('All terms');
    // 15 data rows in the CSV (the header row is a separate tr.headTitles).
    await expect(page.locator('#termsDefinitionsTable tr:not(.headTitles)')).toHaveCount(15);
  });

  test('click on "Sphere of influence" filters the table (Chromium/Firefox)', async ({ page, browserName }, testInfo) => {
    if (isWebkit(browserName)) notApplicable(testInfo, 'WebKit shows the static fallback image; the SVG click handlers are not attached (glossary.js, Safari branch)');
    const svg = page.frameLocator('#svg-iframe');
    await svg.locator('#tl_2').click();

    await expect(page.locator('table caption.tableCaption')).toHaveText('Sphere of influence');
    const terms = page.locator('#termsDefinitionsTable tr:not(.headTitles) td.cellTerm');
    await expect(terms).toHaveText(SPHERE_OF_INFLUENCE_TERMS);
    await expect(page.locator('.clearFilterBtn')).toBeVisible();

    // A second sphere replaces the filter (discriminates "filter" from "append").
    await svg.locator('#tl_1').click();
    await expect(page.locator('table caption.tableCaption')).toHaveText('Sphere of control');
    await expect(terms).toHaveText(SPHERE_OF_CONTROL_TERMS);

    // SHOW ALL TERMS restores the full list.
    await page.locator('.clearFilterBtn').click();
    await expect(page.locator('table caption.tableCaption')).toHaveText('All terms');
    await expect(page.locator('#termsDefinitionsTable tr:not(.headTitles)')).toHaveCount(15);
  });

  test('WebKit shows the static fallback image instead of the interactive SVG', async ({ page, browserName }, testInfo) => {
    if (!isWebkit(browserName)) notApplicable(testInfo, `${browserName} gets the interactive SVG; the fallback image is Safari/WebKit only`);
    await expect(page.locator('.browser-message')).toBeVisible();
    await expect(page.locator('#svg-iframe')).toBeHidden();
    const fallback = page.locator('img[src^="images/svg-interactive.svg"]');
    await expect(fallback).toHaveCount(1);
    await expect(fallback).toBeVisible();
    await expect.poll(() => fallback.evaluate((img) => img.complete && img.naturalWidth > 0), 'fallback image decoded').toBe(true);
    await expect(page.locator('.clearFilterBtn')).toBeHidden();
    // The table still shows every term.
    await expect(page.locator('#termsDefinitionsTable tr:not(.headTitles)')).toHaveCount(15);
  });
});
