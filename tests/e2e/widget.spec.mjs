// FR-12 / FR-04 / DD-07 (design 10.1 `widget`): the public widget, driven from a host page on
// ANOTHER origin. The host is tests/fixtures/widget-host/host.html on http://localhost:8081; the
// widget script and the iframe come from the dashboard on http://localhost:8080 (P-14). A
// same-origin host would not be evidence for FR-12, so every test uses the 8081 host.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './helpers/network.mjs';
import { DIST } from './helpers/site.mjs';
import { markClass } from './helpers/tableau.mjs';

// FR-27 / design 10.1: exactly one class annotation per test.
test.beforeEach(async ({}, testInfo) => markClass(testInfo, 'LOCAL'));

const HOST = 'http://localhost:8081';
const DASH = 'http://localhost:8080';
const IFRAME = '#iframe-dashboardEmbed';
// Literal expected value (FR-12, P-29): the actions of the 19 active sections, with the duplicates
// of the original control list and `ethiopia`, as the string `getSections()` has always returned.
const SECTIONS_STRING = '["home","geographicScope","geographicScope","partners","SDG","systemLevelOutcomes","systemLevelOutcomes","caseReports","innovations","policies","milestones","partnerships","capDev","altmetric","publications","MELIA","genebanks","glossary","ethiopia"]';

// Opens the host with the given knobs and returns once the widget constructor is available.
async function openHost(page, knobs = {}, origin = HOST) {
  const q = new URLSearchParams(knobs).toString();
  await page.goto(`${origin}/host.html${q ? `?${q}` : ''}`);
  await page.waitForFunction(() => window.ResultsDashboardWidget || window.AmdWidget);
}
const create = (page, options) => page.evaluate((o) => {
  const Ctor = window.ResultsDashboardWidget || window.AmdWidget;
  window.w = new Ctor('el', o);
  return { baseURL: window.w.baseURL, baseOrigin: window.w.baseOrigin, hostOrigin: window.w.hostOrigin };
}, options);
const iframeSrc = (page) => page.locator(IFRAME).getAttribute('src');
async function dashboardFrame(page) {
  const handle = await page.locator(IFRAME).elementHandle();
  const frame = await handle.contentFrame();
  await frame.waitForLoadState('load');
  return frame;
}
const heightOf = (page) => page.locator(IFRAME).evaluate((el) => el.style.height);

test.describe('widget on a host in another origin', () => {
  test('the host really is another origin than the dashboard', async ({ page }) => {
    await openHost(page);
    expect(await page.evaluate(() => location.origin)).toBe(HOST);
    expect(new URL(DASH).origin).not.toBe(HOST);
    const script = await page.evaluate(() => document.getElementById('widget-script').src);
    expect(script).toBe(`${DASH}/widget/main.js`);
  });

  test('creates the iframe to the dashboard origin with hostOrigin from the host (FR-12 scenario)', async ({ page }) => {
    await openHost(page);
    const w = await create(page, { currentSection: 'policies' });
    expect(await iframeSrc(page)).toBe(`${DASH}/policies?year=2020&embed=true&hostOrigin=${HOST}&displayNav=true`);
    // Only hostOrigin comes from the host's location; base URL and origin come from the script URL.
    expect(w).toEqual({ baseURL: DASH, baseOrigin: DASH, hostOrigin: HOST });
    const frame = await dashboardFrame(page);
    expect(new URL(frame.url()).origin).toBe(DASH);
  });

  test('hostOrigin is the host origin whatever its spelling; the base stays the script origin', async ({ page }) => {
    await openHost(page, {}, 'http://127.0.0.1:8081');
    const w = await create(page, { currentSection: 'policies', yearSelected: 2019, displayNav: false });
    expect(w).toEqual({ baseURL: DASH, baseOrigin: DASH, hostOrigin: 'http://127.0.0.1:8081' });
    expect(await iframeSrc(page)).toBe(`${DASH}/policies?year=2019&embed=true&hostOrigin=http://127.0.0.1:8081&displayNav=false`);
  });

  test('the same dist/ works from its second origin (DD-07, FR-04)', async ({ page }) => {
    const second = 'http://127.0.0.1:8090';
    await openHost(page, { base: second });
    const w = await create(page, { currentSection: 'innovations' });
    expect(w.baseURL).toBe(second);
    expect(await iframeSrc(page)).toBe(`${second}/innovations?year=2020&embed=true&hostOrigin=${HOST}&displayNav=true`);
    const frame = await dashboardFrame(page);
    await expect(frame.locator('.filters1').first()).toBeVisible();
    // updateHeight from that origin is the one the widget trusts.
    await frame.evaluate(() => parent.postMessage({ eventName: 'updateHeight', data: 1234 }, '*'));
    await expect.poll(() => heightOf(page)).toBe('1227px');
  });

  test('the iframe height follows updateHeight from the dashboard origin (value minus 7)', async ({ page }) => {
    await openHost(page);
    await create(page, { currentSection: 'policies' });
    // The embedded page sends its own updateHeight on load.
    await expect.poll(() => heightOf(page)).toMatch(/^\d+px$/);
    const frame = await dashboardFrame(page);
    await frame.evaluate(() => parent.postMessage({ eventName: 'updateHeight', data: 1234 }, '*'));
    await expect.poll(() => heightOf(page)).toBe('1227px');
  });

  test('updateHeight from any other origin is ignored', async ({ page }) => {
    await openHost(page);
    await create(page, { currentSection: 'policies' });
    const frame = await dashboardFrame(page);
    await expect.poll(() => heightOf(page)).toMatch(/^\d+px$/);

    // Foreign senders: another port of the same machine (a real cross-origin frame), the same
    // port under another host name, and the host page itself.
    await page.evaluate(() => {
      for (const url of ['http://localhost:8090/home.html', 'http://127.0.0.1:8080/home.html']) {
        const f = document.createElement('iframe');
        f.src = url;
        document.body.appendChild(f);
      }
    });
    for (const origin of ['http://localhost:8090', 'http://127.0.0.1:8080']) {
      await expect.poll(() => page.frames().some((f) => f.url().startsWith(`${origin}/`)), { message: `frame from ${origin}` }).toBe(true);
      const foreign = page.frames().find((f) => f.url().startsWith(`${origin}/`));
      await foreign.waitForLoadState('load');
      await foreign.evaluate(() => parent.postMessage({ eventName: 'updateHeight', data: 4321 }, '*'));
    }
    await page.evaluate(() => window.postMessage({ eventName: 'updateHeight', data: 5555 }, '*'));
    // Messages are delivered in order: once the trusted control below is applied, the three
    // foreign ones before it have already been handled (and must have left the height alone).
    await frame.evaluate(() => parent.postMessage({ eventName: 'updateHeight', data: 2000 }, '*'));
    await expect.poll(() => heightOf(page)).toBe('1993px');
  });

  test('changeSection navigates the iframe to that section', async ({ page }) => {
    await openHost(page);
    await create(page, { currentSection: 'policies' });
    const frame = await dashboardFrame(page);
    await expect(frame.locator('nav.main-menu')).toBeVisible();
    await page.evaluate(() => window.w.changeSection('innovations'));
    await expect.poll(() => frame.url()).toBe(`${DASH}/innovations?embed=true&hostOrigin=${HOST}&displayNav=true`);
    expect(await page.evaluate(() => window.w.userOptions.currentSection)).toBe('innovations');
  });

  test('displayNav(false) hides the iframe menu and displayNav(true) shows it again', async ({ page }) => {
    await openHost(page);
    await create(page, { currentSection: 'policies' });
    const frame = await dashboardFrame(page);
    const nav = frame.locator('nav.main-menu');
    await expect(nav).toBeVisible();
    await page.evaluate(() => window.w.displayNav(false));
    await expect(nav).toBeHidden();
    await page.evaluate(() => window.w.displayNav(true));
    await expect(nav).toBeVisible();
  });

  test('the displayNav option false creates the iframe without a menu', async ({ page }) => {
    await openHost(page);
    await create(page, { currentSection: 'policies', displayNav: false });
    expect(await iframeSrc(page)).toBe(`${DASH}/policies?year=2020&embed=true&hostOrigin=${HOST}&displayNav=false`);
    const frame = await dashboardFrame(page);
    await expect(frame.locator('nav.main-menu')).toBeHidden();
  });

  test('getSections() returns the original 19-action string, not an array (P-29)', async ({ page }) => {
    await openHost(page);
    await create(page, { currentSection: 'policies' });
    const sections = await page.evaluate(() => window.w.getSections());
    expect(typeof sections).toBe('string');
    expect(sections).toBe(SECTIONS_STRING);
    expect(JSON.parse(sections)).toHaveLength(19);
  });
});

test.describe('loading variants of the widget script (DD-07)', () => {
  const EXPECTED = `${DASH}/policies?year=2020&embed=true&hostOrigin=${HOST}&displayNav=true`;

  test('?v=1 cache-buster: the base is still the script origin', async ({ page }) => {
    await openHost(page, { v: '1' });
    expect(await page.evaluate(() => document.getElementById('widget-script').src)).toBe(`${DASH}/widget/main.js?v=1`);
    const w = await create(page, { currentSection: 'policies' });
    expect(w.baseURL).toBe(DASH);
    expect(await iframeSrc(page)).toBe(EXPECTED);
  });

  test('async script', async ({ page }) => {
    await openHost(page, { load: 'async' });
    expect(await page.evaluate(() => document.getElementById('widget-script').async)).toBe(true);
    await create(page, { currentSection: 'policies' });
    expect(await iframeSrc(page)).toBe(EXPECTED);
  });

  test('deferred script: it really ran after parsing, and still resolves its base', async ({ page }) => {
    await openHost(page, { load: 'defer' });
    expect(await page.evaluate(() => document.getElementById('widget-script').defer)).toBe(true);
    // Proof the attribute took effect: an inline script right after the tag saw no widget yet.
    expect(await page.evaluate(() => window.rdSeenAtParse)).toBe('undefined');
    await create(page, { currentSection: 'policies' });
    expect(await iframeSrc(page)).toBe(EXPECTED);
  });

  test('synchronous script is available at parse time (control for the defer proof)', async ({ page }) => {
    await openHost(page);
    expect(await page.evaluate(() => window.rdSeenAtParse)).toBe('function');
  });

  for (const load of ['sync', 'async', 'defer']) {
    test(`host with a fake define.amd (${load}): the factory runs after evaluation and the base still resolves`, async ({ page }) => {
      await openHost(page, { amd: '1', load });
      // The UMD took the AMD branch: no global, the loader got the factory (P-14).
      expect(await page.evaluate(() => typeof window.ResultsDashboardWidget)).toBe('undefined');
      expect(await page.evaluate(() => typeof window.AmdWidget)).toBe('function');
      const w = await create(page, { currentSection: 'policies' });
      expect(w.baseURL).toBe(DASH);
      expect(await iframeSrc(page)).toBe(EXPECTED);
    });
  }

  // Forward pointer 1 (DD-07, recorded as CURRENT behavior, not as a requirement): when the script
  // URL does not end in /widget/main.js (renamed or bundled by the host), the whole file URL
  // becomes the base path, so the iframe URL is built under that file. Hosts must keep the name.
  test('a script served under another path uses the whole file URL as its base (documents current behavior)', async ({ page }) => {
    const body = fs.readFileSync(path.join(DIST, 'widget', 'main.js'));
    await page.route(`${DASH}/vendor/bundle.js`, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body }));
    await openHost(page, { src: `${DASH}/vendor/bundle.js` });
    const w = await create(page, { currentSection: 'policies' });
    expect(w.baseOrigin).toBe(DASH);
    expect(w.baseURL).toBe(`${DASH}/vendor/bundle.js`);
    expect(await iframeSrc(page)).toBe(`${DASH}/vendor/bundle.js/policies?year=2020&embed=true&hostOrigin=${HOST}&displayNav=true`);
  });
});
