// FR-11 (design 10.1 `embed`): embed mode on the dashboard origin. The widget path (iframe from a
// host in another origin) is covered end to end by widget.spec; here the page is opened directly.
import { test, expect, settle } from './helpers/network.mjs';
import { markClass } from './helpers/tableau.mjs';

// FR-27 / design 10.1: exactly one class annotation per test.
test.beforeEach(async ({}, testInfo) => markClass(testInfo, 'LOCAL'));

const HOST = 'http://localhost:8081';
const embedUrl = (section, extra = '') => `/${section}?embed=true&hostOrigin=${HOST}${extra}`;

// Collects every message the page posts to its parent. A top-level page is its own parent, so
// `window.parent.postMessage` lands on its own window and the listener sees it.
async function recordMessages(page) {
  await page.addInitScript(() => {
    window.__messages = [];
    window.addEventListener('message', (e) => window.__messages.push({ origin: e.origin, data: e.data }));
  });
}

test.describe('embed=true&displayNav=false (FR-11 scenario)', () => {
  test.beforeEach(async ({ page }) => {
    await recordMessages(page);
    await page.goto(embedUrl('innovations', '&displayNav=false'));
    await settle(page);
  });

  test('header and side menu hidden, filters visible in the content', async ({ page }) => {
    // The header is rendered empty: no logo, no title, no text.
    await expect(page.locator('header img, header h3, header .pageheader-wrapper')).toHaveCount(0);
    expect((await page.locator('header').first().innerText()).trim()).toBe('');
    await expect(page.locator('nav.main-menu')).toBeHidden();
    await expect(page.locator('.filters1').first()).toBeVisible();
    await expect(page.locator('.filters1 input[name="years"]').first()).toBeAttached();
  });

  test('the Policies menu link carries embed, hostOrigin and displayNav', async ({ page }) => {
    const href = await page.locator('nav.main-menu a.sectionAction-policies').first().getAttribute('href');
    expect(href).toBe(`./policies?embed=true&hostOrigin=${HOST}&displayNav=false`);
  });

  test('every menu link carries the hostOrigin and no sentinel is left', async ({ page }) => {
    const hrefs = await page.locator('nav.main-menu #sections a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    expect(hrefs).toHaveLength(18);
    for (const href of hrefs) {
      expect(href).toMatch(new RegExp(`^\\./[A-Za-z]+\\?embed=true&hostOrigin=${HOST}&displayNav=false$`));
    }
  });

  test('sends updateHeight to the parent on load', async ({ page }) => {
    const messages = await page.evaluate(() => window.__messages);
    const heights = messages.filter((m) => m.data && m.data.eventName === 'updateHeight');
    expect(heights.length).toBeGreaterThanOrEqual(1);
    expect(heights[0].data.data).toBeGreaterThan(0);
  });
});

test.describe('navigation shows only when displayNav is exactly true (FR-11 BUT, routes.php:44)', () => {
  for (const [label, extra, visible] of [
    ['true', '&displayNav=true', true],
    ['absent', '', false],
    ['false', '&displayNav=false', false],
    ['1', '&displayNav=1', false],
    ['TRUE', '&displayNav=TRUE', false],
    ['empty', '&displayNav=', false],
  ]) {
    test(`displayNav ${label} -> menu ${visible ? 'visible' : 'hidden'}`, async ({ page }) => {
      await page.goto(embedUrl('innovations', extra));
      await settle(page);
      const nav = page.locator('nav.main-menu');
      if (visible) { await expect(nav).toBeVisible(); } else { await expect(nav).toBeHidden(); }
      // The header stays empty in every embed variant.
      await expect(page.locator('header img, header .pageheader-wrapper')).toHaveCount(0);
    });
  }
});

test.describe('postMessage protocol (FR-11)', () => {
  test('displayNav and changeSection are accepted only from the hostOrigin', async ({ page }) => {
    await page.goto(embedUrl('innovations', '&displayNav=true'));
    await settle(page);
    const nav = page.locator('nav.main-menu');
    await expect(nav).toBeVisible();
    // This window posts to itself, so the origin is the dashboard's (8080), not the hostOrigin (8081).
    await page.evaluate(() => window.postMessage({ eventName: 'displayNav', data: false }, '*'));
    await page.evaluate(() => window.postMessage({ eventName: 'changeSection', data: 'policies' }, '*'));
    await page.waitForTimeout(1000); // slideUp lasts 500 ms; nothing may start
    await expect(nav).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/innovations');
  });
});
