// FR-07 (hostile scenario in a browser, `$&` in hostOrigin), FR-16, NFR-06 emulated headers
// (design 10.1 `security`). Parameters must never be interpolated as HTML or JavaScript: they
// reach the DOM as text and data only. Class: LOCAL.
import { test, expect, settle } from './helpers/network.mjs';
import { rawRequest } from '../helpers/raw-http.mjs';
import { SECTIONS } from './helpers/site.mjs';
import { markClass } from './helpers/tableau.mjs';

// FR-27 / design 10.1: exactly one class annotation per test.
test.beforeEach(async ({}, testInfo) => markClass(testInfo, 'LOCAL'));

const enc = encodeURIComponent;

async function watch(page) {
  const seen = { dialogs: [], errors: [] };
  page.on('dialog', (d) => { seen.dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  page.on('pageerror', (e) => seen.errors.push(e.message));
  return seen;
}
const pwned = (page) => page.evaluate(() => window.__pwned);
const scriptCount = (page) => page.locator('script').count();

test.describe('hostile year (FR-07 hostile scenario)', () => {
  const payloads = [
    '</script><script>alert(1)</script>',
    '</script><script>window.__pwned=1</script>',
    '"><img src=x onerror=window.__pwned=1>',
    "';window.__pwned=1;//",
  ];
  for (const payload of payloads) {
    test(`year=${payload}: no script runs, the value appears as text`, async ({ page }) => {
      const seen = await watch(page);
      await page.goto('/innovations?year=2019');
      await settle(page, 500);
      const baseline = await scriptCount(page);

      await page.goto(`/innovations?year=${enc(payload)}`);
      await settle(page, 500);

      expect(seen.dialogs).toEqual([]);
      expect(await pwned(page)).toBeUndefined();
      expect(await scriptCount(page), 'script elements injected').toBe(baseline);
      expect(await page.locator('img[onerror]').count()).toBe(0);
      const title = page.locator('#filtertitley');
      await expect(title).toHaveText(payload);                       // literal text
      expect(await title.evaluate((e) => e.children.length)).toBe(0);  // no markup under it
      // appConfig carries the HTML-escaped value (Twig autoescape parity), as data.
      const escaped = payload.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
      expect(await page.evaluate(() => window.appConfig.yearSelected)).toBe(escaped);
    });
  }
});

test.describe('hostile hostOrigin', () => {
  test("hostOrigin=x'%3Balert(1)%2F%2F is data: no dialog, escaped in appConfig, literal in embed links", async ({ page }) => {
    const seen = await watch(page);
    await page.goto("/innovations?embed=true&displayNav=true&hostOrigin=x'%3Balert(1)%2F%2F");
    await settle(page, 500);
    expect(seen.dialogs).toEqual([]);
    expect(await pwned(page)).toBeUndefined();
    expect(await page.evaluate(() => window.appConfig.hostOrigin)).toBe("x&#039;;alert(1)//");
    const hrefs = await page.locator('nav.main-menu a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    expect(hrefs.length).toBeGreaterThan(10);
    for (const href of hrefs) {
      expect(href).not.toContain('RDHOSTORIGINSENTINEL');
      expect(href).toContain("hostOrigin=x';alert(1)//");
    }
  });

  test('`$&`, `$\'` and a backtick pattern in hostOrigin stay literal (no replacement-pattern expansion)', async ({ page }) => {
    const value = "x$&y$'z$`w$$";
    await page.goto(`/innovations?embed=true&displayNav=true&hostOrigin=${enc(value)}`);
    await settle(page, 500);
    const hrefs = await page.locator('nav.main-menu a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    expect(hrefs.length).toBeGreaterThan(10);
    for (const href of hrefs) {
      expect(href).not.toContain('RDHOSTORIGINSENTINEL');
      expect(href).toContain(`hostOrigin=${value}&displayNav=true`);
    }
  });

  test('a hostile hostOrigin cannot turn a menu link into a script URL', async ({ page }) => {
    await page.goto(`/innovations?embed=true&displayNav=true&hostOrigin=${enc('javascript:alert(1)//')}`);
    await settle(page, 500);
    const hrefs = await page.locator('a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    expect(hrefs.filter((h) => /^\s*javascript:/i.test(h))).toEqual([]);
  });
});

test.describe('hostile entity', () => {
  test('entity=<img onerror> is text in the title, no element is created', async ({ page }) => {
    const seen = await watch(page);
    const payload = '<img src=x onerror=window.__pwned=1>';
    await page.goto('/innovations?year=2019');
    await settle(page, 500);
    const images = await page.locator('img').count();
    await page.goto(`/innovations?entity=${enc(payload)}`);
    await settle(page, 500);
    expect(seen.dialogs).toEqual([]);
    expect(await pwned(page)).toBeUndefined();
    expect(await page.locator('img').count()).toBe(images);
    await expect(page.locator('#filtertitlec')).toHaveText(payload);
    expect(await page.locator('#filtertitlec').evaluate((e) => e.children.length)).toBe(0);
    expect(await page.evaluate(() => window.appConfig.entitySelected)).toBe('&lt;img src=x onerror=window.__pwned=1&gt;');
  });
});

test.describe('every section with all hostile values at once', () => {
  const hostile = `year=${enc('</script><script>window.__pwned=1</script>')}&entity=${enc('<svg onload=window.__pwned=1>')}&hostOrigin=${enc("x';window.__pwned=1;//")}&embed=true&displayNav=true`;
  const benign = 'year=2019&entity=CCAFS&hostOrigin=https%3A%2F%2Fhost.example&embed=true&displayNav=true';
  for (const section of SECTIONS) {
    test(`${section}: nothing executes and no element is injected`, async ({ page }) => {
      const seen = await watch(page);
      await page.goto(`/${section}?${benign}`);
      await settle(page, 500);
      const baseline = { scripts: await scriptCount(page), svg: await page.locator('svg[onload]').count() };
      await page.goto(`/${section}?${hostile}`);
      await settle(page, 500);
      expect(seen.dialogs).toEqual([]);
      expect(await pwned(page)).toBeUndefined();
      expect(await scriptCount(page)).toBe(baseline.scripts);
      expect(await page.locator('svg[onload]').count()).toBe(baseline.svg);
    });
  }
});

test.describe('emulated security headers (NFR-06)', () => {
  const expectHeaders = (headers, label) => {
    expect(headers['x-content-type-options'], label).toBe('nosniff');
    expect(headers['referrer-policy'], label).toBe('strict-origin-when-cross-origin');
    const csp = headers['content-security-policy-report-only'];
    expect(csp, label).toBeDefined();
    expect(csp, label).toContain("default-src 'self'");
    expect(csp, label).toMatch(/frame-src [^;]*'self'[^;]*https:\/\/tableau-core\.cgiar\.org[^;]*https:\/\/public\.tableau\.com/);
    expect(csp, label).toMatch(/script-src [^;]*'unsafe-inline'/);
    expect(csp, label).toMatch(/style-src [^;]*'unsafe-inline'[^;]*fonts\.googleapis\.com/);
    expect(csp, label).toMatch(/font-src [^;]*fonts\.gstatic\.com/);
    // Report-Only: nothing is enforced, and the widget must stay embeddable (no X-Frame-Options).
    expect(headers['content-security-policy'], label).toBeUndefined();
    expect(headers['x-frame-options'], label).toBeUndefined();
    expect(headers['cache-control'], label).toBe('no-store');
    expect(headers['set-cookie'], label).toBeUndefined();
    expect(headers['server'] ?? '', label).not.toMatch(/php|apache|express/i);
    expect(headers['x-powered-by'], label).toBeUndefined();
  };

  for (const port of [8080, 8090, 8081]) {
    test(`${port}: headers on a page, a static file, a redirect, a 404 and a HEAD`, async () => {
      const targets = port === 8081
        ? [['/home.html', 200], ['/js/global.js', 200], ['/nope', 404]]
        : [['/innovations', 200], ['/js/global.js', 200], ['/innovations/', 301], ['/zz-not-a-section', 404], ['/a#b', 400], ['/a%zz', 400]];
      for (const [target, status] of targets) {
        const res = await rawRequest({ port, target, hostHeader: `localhost:${port}` });
        expect(res.status, `${port} ${target}`).toBe(status);
        expectHeaders(res.headers, `${port} ${target}`);
      }
      const head = await rawRequest({ port, method: 'HEAD', target: port === 8081 ? '/home.html' : '/innovations', hostHeader: `localhost:${port}` });
      expect(head.status).toBe(200);
      expectHeaders(head.headers, `${port} HEAD`);
      const post = await rawRequest({ port, method: 'POST', target: '/innovations', hostHeader: `localhost:${port}` });
      expect(post.status).toBe(405); // the no-rules server also refuses non-GET/HEAD
      expectHeaders(post.headers, `${port} POST`);
    });
  }

  test('response splitting: a CR LF in the query never reaches a header, and no cookie is set', async () => {
    const res = await rawRequest({ port: 8080, target: '/homeV1/?a=%0D%0ASet-Cookie:%20x=1' });
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('/?a=%0D%0ASet-Cookie:%20x=1');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.raw.toString('latin1').split('\r\n\r\n')[0]).not.toMatch(/\r\nSet-Cookie:/i);
  });

  test('the Report-Only policy does not block anything: the page works under it', async ({ page, net }) => {
    const violations = [];
    await page.addInitScript(() => {
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
    });
    await page.goto('/home');
    await settle(page);
    await expect(page.locator('nav.main-menu #sections > li')).toHaveCount(18);
    violations.push(...(await page.evaluate(() => window.__csp)));
    // Informational: violations are reported, never enforced (the document and its scripts ran).
    test.info().annotations.push({ type: 'csp-report-only', description: `${violations.length} reported` });
    expect(net.responses.filter((r) => r.status >= 400)).toEqual([]);
  });
});
