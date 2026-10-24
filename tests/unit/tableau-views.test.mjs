// T-08: Tableau view coverage (FR-06; design 7.1 step 8). The views the page JavaScript asks for
// must equal site.json tableauViews, for every section and every variant of the built output.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runBuild, tempDir, cleanupTemp } from '../helpers/build-run.mjs';
import { loadSite } from '../../scripts/site-data.mjs';
import { checkTableauViews, requestsOf } from '../../scripts/tableau-check.mjs';

const site = loadSite();
// Literal expectations from the original page scripts (public/js/*.js, `var SECTION` and `view:`).
const EXPECTED_WORKBOOKS = {
  home: 'AR-HOME-DB', geographicScope: 'AR-HOME-DB', partners: 'AR-HOME-DB', SDG: 'AR-HOME-DB',
  systemLevelOutcomes: 'AR-SLO', caseReports: 'AR-OICR', innovations: 'AR-Innovations', policies: 'AR-Policies',
  milestones: 'AR-Milestones', partnerships: 'AR-Partnerships', capDev: 'AR-CAPDEV', altmetric: 'AR-Altmetric',
  publications: 'AR-Publications', MELIA: 'AR-MELIA', genebanks: 'AR-Genebank', ethiopia: 'AR-Ethiopia-DB_16243582481240',
};
const LEGACY_VIEWS = ['3_1DBTotalPartnerships', '3_2DBTotalPartbyStage', 'DBKeyPartnershipsMap', '3_4DBKeyPartnerships',
  '3_5DBKeyPartbyStage', '3_6DBKeyPartbyStageandProgramType2', '3_7DBKeyPartnersDetails'];

let built;
before(() => { built = runBuild(); });
after(cleanupTemp);

const read = (rel) => fs.readFileSync(path.join(built.outDir, ...rel.split('/')), 'utf8');

// Independent reading of a page: the scripts it loads, then SECTION and view: literals.
function viewsOfPage(file) {
  const html = read(file);
  const scripts = [...html.matchAll(/<script[^>]*\ssrc="\.\/js\/([A-Za-z0-9_.-]+\.js)/g)].map((m) => m[1]);
  const out = [];
  for (const s of scripts) {
    const js = read(`js/${s}`);
    if (!/vizDataArray\s*=/.test(js)) continue;
    out.push({
      script: s,
      workbook: /var SECTION = "([^"]+)"/.exec(js)[1],
      views: [...js.matchAll(/view:\s*'([^']+)'/g)].map((m) => m[1]),
      factory: /createTableauVizNew\(/.test(js) ? 'new' : 'old',
    });
  }
  return out;
}

test('build for the Tableau checks succeeds', () => {
  assert.equal(built.status, 0, built.stderr);
});

test('tableauViews covers the 16 sections that show a dashboard (glossary has none) and the legacy partnerships views (FR-06)', () => {
  assert.deepEqual(Object.keys(site.tableauViews).sort(), Object.keys(EXPECTED_WORKBOOKS).sort());
  assert.equal(Object.keys(site.tableauViews).length, 16);
  for (const [section, wb] of Object.entries(EXPECTED_WORKBOOKS)) {
    assert.equal(site.tableauViews[section].workbook, wb, section);
    assert.equal(site.tableauViews[section].server, 'tableau-core.cgiar.org', section);
    assert.equal(site.tableauViews[section].views.length, 1, section);
  }
  assert.deepEqual(site.tableauViews.partnerships.legacy, { server: 'public.tableau.com', workbook: 'Results', views: LEGACY_VIEWS });
});

test('every section page and its embed variants request exactly the views of tableauViews (FR-06)', () => {
  for (const [section, expected] of Object.entries(site.tableauViews)) {
    for (const suffix of ['', '--embed', '--embed-nonav']) {
      const req = viewsOfPage(`${section}${suffix}.html`);
      assert.equal(req.length, 1, `${section}${suffix}: one page script creates the views`);
      assert.equal(req[0].workbook, expected.workbook, `${section}${suffix} workbook`);
      assert.deepEqual(req[0].views, expected.views, `${section}${suffix} views`);
      assert.equal(req[0].factory, 'new', `${section}${suffix} uses tableauViewNew (tableau-core)`);
    }
  }
});

test('legacy partnerships variants request the public.tableau.com views (FR-06, FR-09)', () => {
  for (const suffix of ['', '--embed', '--embed-nonav']) {
    const req = viewsOfPage(`partnerships-2017${suffix}.html`);
    assert.equal(req.length, 1);
    assert.equal(req[0].workbook, 'Results');
    assert.deepEqual(req[0].views, LEGACY_VIEWS);
    assert.equal(req[0].factory, 'old'); // createTableauViz -> appConfig.tableauView (public.tableau.com)
  }
  assert.equal(new URL(site.appConfig.tableauView).hostname, 'public.tableau.com');
  assert.equal(new URL(site.appConfig.tableauViewNew).hostname, 'tableau-core.cgiar.org');
});

test('glossary requests no Tableau view', () => {
  assert.deepEqual(viewsOfPage('glossary.html'), []);
});

test('the build-time check agrees on the real output', () => {
  assert.deepEqual(checkTableauViews({ outDir: built.outDir, site }), []);
});

test('the check reports a view that differs from tableauViews, and a workbook or server that differs', () => {
  const wrongView = structuredClone(site);
  wrongView.tableauViews.policies.views = ['Other-DB-Full'];
  assert.deepEqual(checkTableauViews({ outDir: built.outDir, site: wrongView }).slice(0, 1),
    ['policies.html: views [Policies-DB-Full] != expected [Other-DB-Full]']);
  const wrongBook = structuredClone(site);
  wrongBook.tableauViews.capDev.workbook = 'AR-Nope';
  assert.match(checkTableauViews({ outDir: built.outDir, site: wrongBook })[0], /capDev\.html: workbook \["AR-CAPDEV"\] != expected AR-Nope/);
  const wrongServer = structuredClone(site);
  wrongServer.tableauViews.partnerships.legacy.server = 'tableau-core.cgiar.org';
  assert.match(checkTableauViews({ outDir: built.outDir, site: wrongServer })[0], /partnerships-2017\.html: server \["public\.tableau\.com"\] != expected tableau-core\.cgiar\.org/);
});

test('the check reports a section that has an entry but no page script, and a page with a view but no entry', () => {
  const dir = tempDir('rd-tab-');
  fs.cpSync(built.outDir, dir, { recursive: true });
  for (const suffix of ['', '--embed', '--embed-nonav']) {
    const f = path.join(dir, `altmetric${suffix}.html`);
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/<script[^>]*altmetrics\.js[^>]*><\/script>/, ''));
  }
  assert.match(checkTableauViews({ outDir: dir, site })[0], /altmetric\.html: requests no Tableau view, tableauViews expects Altmetrics-DB-Full/);
  const noEntry = structuredClone(site);
  delete noEntry.tableauViews.MELIA;
  assert.match(checkTableauViews({ outDir: built.outDir, site: noEntry })[0], /MELIA\.html: requests views but tableauViews has no entry for MELIA/);
});

test('requestsOf ignores the shared helper (defines the creators) and comments', () => {
  assert.equal(requestsOf('function createTableauViz(a){}\nfunction createTableauVizNew(a){}', site), null);
  const js = 'var SECTION = "W";\n// { elementID: "x", view: "Old" }\nvizDataArray = [\n { elementID: "a", view: \'V1\' }\n];\ncreateTableauVizNew(1,2,3);';
  assert.deepEqual(requestsOf(js, site), { workbook: 'W', server: 'tableau-core.cgiar.org', views: ['V1'] });
});
