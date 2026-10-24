// FR-08 (design 10.1 `filters`). Radios, titles and `pushState` are LOCAL (no Tableau contact:
// the default fixture aborts every non-loopback request). `applyFilterAsync` on the real sheets is
// TABLEAU: it needs the views rendered, otherwise it is BLOCKED (reason). The LOCAL test with
// stubbed sheets runs the shipped global.js/tableauFunctions.js against fake sheets; it proves the
// filter wiring, it does NOT replace the TABLEAU test.
import { test, expect } from './helpers/network.mjs';
import { site, TABLEAU_HOSTS } from './helpers/site.mjs';
import { renderOrReason, markClass, blockTest, attachEvidence } from './helpers/tableau.mjs';

const pick = (page, name, value) => page.locator(`input[name="${name}"][value="${value}"]`).evaluate((el) => el.click());
const yearParam = (page) => new URL(page.url()).searchParams.get('year');
const title = (page, id) => page.locator(id).textContent();

test.describe('year and CRP filters (LOCAL)', () => {
  test.beforeEach(async ({}, testInfo) => markClass(testInfo, 'LOCAL'));

  test('changing the year updates the URL with pushState (no reload) and the title', async ({ page }) => {
    await page.goto('/innovations');
    await page.waitForLoadState('load');
    expect(await title(page, '#filtertitley')).toBe('2021');
    await expect(page.locator('input[name="years"][value="2021"]')).toBeChecked();
    await page.evaluate(() => { window.__noReload = 'same document'; window.__len = history.length; });
    await pick(page, 'years', '2018');
    await expect.poll(() => yearParam(page)).toBe('2018');
    expect(new URL(page.url()).pathname).toBe('/innovations');
    expect(await title(page, '#filtertitley')).toBe('2018');
    await expect(page.locator('input[name="years"][value="2018"]')).toBeChecked();
    expect(await page.evaluate(() => window.__noReload)).toBe('same document'); // not reloaded
    expect(await page.evaluate(() => history.length)).toBeGreaterThan(await page.evaluate(() => window.__len)); // pushState entry
  });

  test('"All Years" removes the year from the URL and titles "All Years"', async ({ page }) => {
    await page.goto('/innovations?year=2019');
    await page.waitForLoadState('load');
    await pick(page, 'years', '');
    await expect.poll(() => yearParam(page)).toBeNull();
    expect(await title(page, '#filtertitley')).toBe('All Years');
  });

  test('changing the CRP updates the title', async ({ page }) => {
    expect(site.crps.map((c) => c.acronym)).toContain('CCAFS');
    await page.goto('/innovations');
    await page.waitForLoadState('load');
    await pick(page, 'crps', 'CCAFS');
    expect(await title(page, '#filtertitlec')).toBe('CCAFS');
    await expect(page.locator('input[name="crps"][value="CCAFS"]')).toBeChecked();
  });

  test('partnerships reloads the page on a year change (forceRefresh)', async ({ page }) => {
    await page.goto('/partnerships?year=2019');
    await page.waitForLoadState('load');
    await page.evaluate(() => { window.__noReload = 'same document'; });
    const reloaded = page.waitForEvent('load');
    await pick(page, 'years', '2018');
    await reloaded;
    expect(await page.evaluate(() => window.__noReload)).toBeUndefined(); // a new document
    expect(yearParam(page)).toBe('2018');
    await expect(page.locator('input[name="years"][value="2018"]')).toBeChecked();
    expect(await title(page, '#filtertitley')).toBe('2018');
  });

  test('the legacy partnerships variant also reloads, now onto the 2018+ variant', async ({ page }) => {
    await page.goto('/partnerships?year=2017');
    await page.waitForLoadState('load');
    await page.evaluate(() => { window.__noReload = 'same document'; });
    const reloaded = page.waitForEvent('load');
    await pick(page, 'years', '2019');
    await reloaded;
    expect(await page.evaluate(() => window.__noReload)).toBeUndefined();
    expect(yearParam(page)).toBe('2019');
    expect(await page.locator('script[src*="partnerships-2018"]').count()).toBe(1);
  });

  test('a year change calls applyFilterAsync("Year", "2018", replace) on every sheet (stubbed sheets)', async ({ page }) => {
    await page.goto('/innovations');
    await page.waitForLoadState('load');
    await page.evaluate(() => {
      window.__calls = [];
      window.sheetsArray = ['a', 'b', 'c'].map((n) => ({ getName: () => n, applyFilterAsync: (...args) => window.__calls.push([n, ...args]), clearFilterAsync() {} }));
    });
    await pick(page, 'years', '2018');
    const calls = await page.evaluate(() => window.__calls);
    expect(calls).toEqual([['a', 'Year', '2018', 'replace'], ['b', 'Year', '2018', 'replace'], ['c', 'Year', '2018', 'replace']]);
  });
});

test.describe('applyFilterAsync on the rendered sheets (TABLEAU)', () => {
  test.use({ allowHosts: TABLEAU_HOSTS, allowTableauFrames: true });

  test('/innovations: picking 2018 applies Year=2018 (replace) to every real sheet', async ({ page, net }, testInfo) => {
    test.setTimeout(100_000); // external servers can be slow; the verdict waits up to 60 s
    markClass(testInfo, 'TABLEAU');
    expect(await page.context().cookies(), 'fresh profile (V-01)').toEqual([]);
    await page.goto('/innovations');
    const out = await renderOrReason(page, net, site.tableauViews.innovations.views.length);
    await attachEvidence(testInfo, page, net, '/innovations', out);
    if (!out.rendered && out.reason) blockTest(testInfo, out.reason, out.detail);
    expect(out.rendered, 'neither rendered nor blocked for a known reason').toBe(true);
    await page.evaluate(() => {
      window.__calls = [];
      window.sheetsArray.forEach((s) => { const orig = s.applyFilterAsync.bind(s); s.applyFilterAsync = (...a) => { window.__calls.push([s.getName(), ...a]); return orig(...a); }; });
    });
    const sheets = await page.evaluate(() => window.sheetsArray.length);
    expect(sheets).toBeGreaterThan(0);
    await pick(page, 'years', '2018');
    await expect.poll(() => page.evaluate(() => window.__calls.length)).toBe(sheets);
    const calls = await page.evaluate(() => window.__calls);
    for (const c of calls) expect(c.slice(1)).toEqual(['Year', '2018', 'replace']);
  });
});
