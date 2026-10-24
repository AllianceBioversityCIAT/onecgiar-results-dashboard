// FR-06, FR-22 (design 10.1 `tableau-render`). Class: TABLEAU.
// Each Tableau page is opened as an anonymous visitor (fresh Playwright context: no cookies, no
// storage, no signed-in Tableau session, V-01). The Tableau hosts, and the requests issued by the
// viz iframe, are released by the opt-in of helpers/network.mjs; everything else stays aborted.
// Outcome per page: every view rendered (`.filter-component.filter-loaded`) -> PASSED; sign-in,
// embedding refusal or network error -> skipped with annotation `blocked` = BLOCKED (reason);
// neither -> FAILED (unexplained). A blocked view is never PASSED (FR-06 BUT, FR-22 scenario).
import { test, expect } from './helpers/network.mjs';
import { SECTIONS, SECTIONS_WITHOUT_TABLEAU, site, TABLEAU_HOSTS } from './helpers/site.mjs';
import { renderOrReason, markClass, blockTest, attachEvidence } from './helpers/tableau.mjs';

test.use({ allowHosts: TABLEAU_HOSTS, allowTableauFrames: true });

const sections = SECTIONS.filter((s) => !SECTIONS_WITHOUT_TABLEAU.includes(s));
const CASES = [
  ...sections.map((s) => ({ name: s, url: `/${s}`, def: site.tableauViews[s] })),
  { name: 'partnerships legacy (year=2017)', url: '/partnerships?year=2017', def: site.tableauViews.partnerships.legacy },
];

for (const c of CASES) {
  test(`${c.name}: the Tableau views render or the test is BLOCKED (reason)`, async ({ page, net }, testInfo) => {
    test.setTimeout(100_000); // external servers can be slow; the verdict waits up to 60 s
    markClass(testInfo, 'TABLEAU');
    expect(await page.context().cookies(), 'fresh profile (V-01)').toEqual([]);
    await page.goto(c.url);
    // Which views exist is checked by the LOCAL tableau-request spec (a wrong view name is red there);
    // this test only decides rendered vs BLOCKED (reason) from the network evidence.
    const out = await renderOrReason(page, net, c.def.views.length);
    await attachEvidence(testInfo, page, net, c.url, out);
    if (!out.rendered && out.reason) blockTest(testInfo, out.reason, out.detail);
    expect(out.rendered, 'neither rendered nor blocked for a known reason (login|embedding|network)').toBe(true);
    // Rendered: one iframe per view, each from the view's server.
    const srcs = await page.locator('iframe').evaluateAll((els) => els.map((e) => e.src));
    expect(srcs.length).toBe(c.def.views.length);
    for (const s of srcs) expect(new URL(s).hostname).toBe(c.def.server);
  });
}

// The selection tag (tableauFunctions.js `setFilterWorksheet`) needs marks from a rendered viz.
// This runs the SHIPPED function with stubbed marks and sheets (no Tableau contact), so it proves
// the tag logic, not the render; it does not replace the TABLEAU test above.
test('selection tag: setFilterWorksheet adds a tag for the selected marks and removes it when cleared (stubbed marks; LOCAL-natured)', async ({ page }, testInfo) => {
  markClass(testInfo, 'LOCAL');
  await page.goto('/innovations');
  await page.waitForLoadState('load');
  const out = await page.evaluate(() => {
    const marks = (vals) => vals.map((v) => ({ getPairs: () => [{ fieldName: 'Stage of Innovation', formattedValue: v }] }));
    const sheet = { name: 'S', cleared: 0, getName() { return 'S'; }, clearSelectedMarksAsync() { this.cleared++; } };
    const cleared = [];
    const other = { getName: () => 'other', clearFilterAsync: (f) => cleared.push(f), applyFilterAsync() {} };
    setFilterWorksheet(marks(['Stage 3', 'Stage 4']), 'Stage of Innovation', [sheet, other], sheet, 'S', 'Stage');
    const tag = document.querySelector('.alert.alert-dark.selection .filterTag');
    const first = tag ? tag.textContent : null;
    setFilterWorksheet([], 'Stage of Innovation', [sheet, other], sheet, 'S', 'Stage');
    return { first, after: document.querySelectorAll('.filterTag').length, cleared };
  });
  expect(out.first).toBe('Stage: Stage 3, Stage 4');
  expect(out.after).toBe(0);
  expect(out.cleared).toEqual(['Stage of Innovation']);
});
