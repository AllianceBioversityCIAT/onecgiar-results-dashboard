// FR-05, FR-16, FR-17 (design 10.1 `sections`): 17 sections, 18 menu rows, active section, no
// resource 404s, no self-hosted CDN requests, no own cookies, no UA analytics, rd-apply creates
// no elements, Font Awesome webfonts load. Class: LOCAL.
import { test, expect, settle, localErrors, external } from './helpers/network.mjs';
import { SECTIONS, MENU_ROWS, CDN_HOSTS, DIST } from './helpers/site.mjs';
import fs from 'node:fs';
import path from 'node:path';

for (const section of SECTIONS) {
  test.describe(section, () => {
    test('renders header, menu, no resource 404, no CDN, no cookies, no UA', async ({ page, context, net }) => {
      const response = await page.goto(`/${section}`);
      expect(response.status()).toBe(200);
      expect(new URL(page.url()).pathname).toBe(`/${section}`); // rewritten, no .html in the URL (the legacy scripts may add ?year)
      await settle(page);

      await expect(page).toHaveTitle(/CGIAR Program Results Dashboard|CGIAR Results Dashboard/);
      await expect(page.locator('#pageheader')).toBeVisible();
      await expect(page.locator('footer, .data-info').first()).toBeAttached();

      // FR-05 / P-26: 18 rows (16 links + 2 titles); ethiopia is reachable but never in the menu.
      await expect(page.locator('nav.main-menu #sections > li')).toHaveCount(MENU_ROWS);
      await expect(page.locator('nav.main-menu #sections a.sectionAction-ethiopia')).toHaveCount(0);
      const active = page.locator('nav.main-menu #sections > li.active');
      if (section === 'ethiopia') {
        await expect(active).toHaveCount(0);
      } else {
        await expect(active).toHaveCount(1);
        await expect(active.locator(`a.sectionAction-${section}`)).toHaveCount(1);
      }

      // FR-16 / FR-17 / FR-28
      expect(localErrors(net), 'local resources that failed or answered >= 400').toEqual([]);
      expect(
        net.requests.filter((r) => CDN_HOSTS.includes(r.host)).map((r) => r.url),
        'requests to a CDN that dist/ self-hosts',
      ).toEqual([]);
      expect(
        net.requests.filter((r) => /googletagmanager\.com|google-analytics\.com|newrelic|nr-data\.net|js-agent/i.test(r.url)).map((r) => r.url),
        'UA / analytics / New Relic requests',
      ).toEqual([]);
      expect(await context.cookies(), 'cookies set by the site').toEqual([]);
      expect(await page.evaluate(() => document.cookie)).toBe('');
      // Third parties still allowed to be observed: only fonts and Tableau.
      for (const r of external(net)) expect(r.host).toMatch(/^(fonts\.googleapis\.com|fonts\.gstatic\.com|tableau-core\.cgiar\.org|public\.tableau\.com)$/);
    });

    test('markup has no server-interpolated appConfig block, UA tag or New Relic', async ({ request }) => {
      const body = await (await request.get(`/${section}`)).text();
      expect(body).not.toMatch(/UA-\d+/);
      expect(body).not.toMatch(/googletagmanager|gtag\(|newrelic|NREUM/i);
      const inline = [...body.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
      for (const code of inline) expect(code).not.toMatch(/appConfig/);
    });

    test('rd-apply creates and removes no element', async ({ page }) => {
      // Scripts other than the three that resolve parameters are replaced by an empty body so
      // that only rd-apply can change the DOM between the two loads.
      const keep = /\/js\/(legacy-compat|rd-params|rd-apply)\.js/;
      const load = async (withApply) => {
        await page.route('**/*.js*', (route) => {
          const url = route.request().url();
          if (!/\.js(\?|$)/.test(new URL(url).pathname + new URL(url).search)) return route.fallback();
          if (keep.test(url) && !(url.includes('rd-apply') && !withApply)) return route.fallback();
          return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
        });
        await page.goto(`/${section}?year=2019&entity=CCAFS&embed=true&displayNav=true&hostOrigin=https%3A%2F%2Fhost.example`);
        await page.waitForLoadState('load');
        const snapshot = await page.evaluate(() => ({
          count: document.getElementsByTagName('*').length,
          ids: [...document.querySelectorAll('[id]')].map((e) => e.id).sort(),
          classes: [...new Set([...document.querySelectorAll('[class]')].flatMap((e) => [...e.classList]))].sort(),
          checkedYear: (document.querySelector('input[name="years"]:checked') || {}).value ?? null,
        }));
        await page.unrouteAll({ behavior: 'wait' });
        return snapshot;
      };
      const without = await load(false);
      const withApply = await load(true);
      expect(withApply.count).toBe(without.count);
      expect(withApply.ids).toEqual(without.ids);
      expect(withApply.classes).toEqual(without.classes);
      // The control really differs where rd-apply acts (filter pages only), so the equality above is not vacuous.
      if (without.checkedYear !== null || withApply.checkedYear !== null) {
        expect(withApply.checkedYear).toBe('2019');
      }
    });
  });
}

test.describe('Font Awesome webfonts (FR-17)', () => {
  test('self-hosted webfonts load without 404', async ({ page, net }) => {
    await page.goto('/home');
    await page.waitForLoadState('load');
    // Use the glyph the way a page does, so the browser has to fetch the font file.
    await page.evaluate(() => {
      const probe = document.createElement('i');
      probe.className = 'fas fa-home';
      probe.id = 'rd-test-probe';
      document.body.appendChild(probe);
    });
    const faces = await page.evaluate(() => document.fonts.load('900 16px "Font Awesome 5 Free"'));
    expect(faces.length, 'Font Awesome 5 Free (solid) faces loaded').toBeGreaterThan(0);
    const fontResponses = net.responses.filter((r) => /\/third-party\/fontawesome\/webfonts\//.test(r.url));
    expect(fontResponses.length).toBeGreaterThan(0);
    expect(fontResponses.filter((r) => r.status >= 400).map((r) => `${r.status} ${r.url}`)).toEqual([]);
    expect(localErrors(net)).toEqual([]);
  });

  test('every webfont referenced by the self-hosted CSS exists in dist/', async () => {
    const css = fs.readFileSync(path.join(DIST, 'third-party', 'fontawesome', 'css', 'all.css'), 'utf8');
    const refs = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1].replace(/['"]/g, '').split(/[?#]/)[0]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(fs.existsSync(path.resolve(DIST, 'third-party', 'fontawesome', 'css', ref)), ref).toBe(true);
    }
  });
});
