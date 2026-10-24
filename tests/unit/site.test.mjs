// Schema and content test for src/data/site.json (design.md section 5, FR-05/06/17/28).
// Expected values are literals taken from the spec and the original ControlListService.php.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SITE_PATH = fileURLToPath(new URL('../../src/data/site.json', import.meta.url));
const site = JSON.parse(readFileSync(SITE_PATH, 'utf8'));

const KEYS = ['sections', 'crps', 'years', 'chartsInfo', 'dataUrl', 'messages', 'appConfig', 'defaults',
  'variants', 'legacyRedirects', 'cdnMap', 'excludeAssets', 'runtimeAssets', 'tableauViews',
  'tableauHosts', 'allowedHosts', 'buildTimeBudgetMs', 'sentinel'];

test('site.json has exactly the keys of design section 5', () => {
  assert.deepEqual(Object.keys(site).sort(), [...KEYS].sort());
});

test('sections: 19 entries in the original order, ethiopia hidden (FR-05)', () => {
  assert.equal(site.sections.length, 19);
  assert.deepEqual(site.sections.map((s) => s.action), [
    'home', 'geographicScope', 'geographicScope', 'partners', 'SDG', 'systemLevelOutcomes',
    'systemLevelOutcomes', 'caseReports', 'innovations', 'policies', 'milestones', 'partnerships',
    'capDev', 'altmetric', 'publications', 'MELIA', 'genebanks', 'glossary', 'ethiopia']);
  assert.deepEqual(site.sections.map((s) => s.type), [
    'section', 'title', 'subsection', 'subsection', 'subsection', 'title', 'subsection', 'subsection',
    'subsection', 'subsection', 'subsection', 'subsection', 'subsection', 'subsection', 'subsection',
    'section', 'section', 'section', 'section']);
  for (const s of site.sections) {
    assert.deepEqual(Object.keys(s), ['name', 'action', 'type', 'active', 'show']);
    assert.equal(s.active, true);
  }
  const hidden = site.sections.filter((s) => s.show === false);
  assert.deepEqual(hidden.map((s) => s.action), ['ethiopia']);
  assert.equal(site.sections.filter((s) => s.show).length, 18); // P-26: 18 menu rows
  assert.equal(site.sections[2].name, 'Location');
  assert.equal(site.sections[14].name, 'Peer Reviewed Papers');
});

test('crps: 17 entries, first is All with empty acronym', () => {
  assert.equal(site.crps.length, 17);
  assert.deepEqual(site.crps[0], { acronym: '', name: 'All' });
  assert.deepEqual(site.crps.at(-1), { acronym: 'WLE', name: 'WLE - Water, Land and Ecosystems' });
  assert.equal(site.crps[3].name, 'CCAFS - Climate Change, Agriculture and Food Security');
});

test('years: 6 entries, integers 2021..2017 and "" for All Years (P-23)', () => {
  assert.equal(site.years.length, 6);
  assert.deepEqual(site.years.map((y) => y.year), ['', 2021, 2020, 2019, 2018, 2017]);
  assert.equal(site.years[0].name, 'All Years');
  for (const y of site.years.slice(1)) {
    assert.equal(typeof y.year, 'number');
    assert.ok(Number.isInteger(y.year));
    assert.equal(y.name, String(y.year));
  }
  assert.equal(typeof site.years[0].year, 'string');
  for (const y of site.years) assert.equal(y.checked, false);
});

test('chartsInfo, dataUrl and messages carry the original values', () => {
  assert.deepEqual(site.chartsInfo.map((c) => c.title), [
    'Cross-Cutting Topics', 'Innovations by Type', 'Policies by Type', 'Training Terms', 'Number of Publications']);
  assert.deepEqual(Object.keys(site.dataUrl), ['home', 'systemLeveloutcomes', 'caseReports', 'milestones', 'innovations']);
  for (const v of Object.values(site.dataUrl)) {
    assert.equal(v, 'https://dataverse.harvard.edu/dataverse/CGIAR-Results-Dashboard/');
  }
  assert.deepEqual(site.messages, [{}]);
});

test('appConfig has only the three public keys', () => {
  assert.deepEqual(site.appConfig, {
    production: true,
    tableauView: 'https://public.tableau.com/views/',
    tableauViewNew: 'https://tableau-core.cgiar.org/views/',
  });
});

test('defaults and variants', () => {
  assert.deepEqual(site.defaults, { year: 2021, entity: '', widgetYear: 2020 });
  assert.equal(typeof site.defaults.year, 'number');
  assert.deepEqual(site.variants, {
    partnerships: { template: 'partnerships-2018.twig', legacyTemplate: 'partnerships.twig', threshold: 2017 },
  });
});

test('legacyRedirects: exactly the 20 names of design 7.3', () => {
  assert.deepEqual(site.legacyRedirects, {
    homeV1: '/', 'home-2018V1': '/', insights: '/', test: '/', widget: '/',
    innovationsV1: '/innovations', innovationsTest: '/innovations',
    policiesV1: '/policies', publicationsV1: '/publications', altmetricV1: '/altmetric',
    capDev_V1: '/capDev', caseReportsV1: '/caseReports',
    'milestones-2017': '/milestones', 'milestones-2018V1': '/milestones', milestonesTest: '/milestones',
    'partnerships-2018': '/partnerships', 'partnerships-2018V1': '/partnerships',
    partnersFilter: '/partners', partnersTest: '/partners',
    systemLevelOutcomesOld: '/systemLevelOutcomes',
  });
  assert.equal(Object.keys(site.legacyRedirects).length, 20);
  // a redirect target must be a real section path
  const actions = new Set(site.sections.map((s) => '/' + s.action));
  actions.add('/');
  for (const t of Object.values(site.legacyRedirects)) assert.ok(actions.has(t), t);
});

test('cdnMap: the four self-hosted CDN files (FR-17), keys carry no query', () => {
  assert.deepEqual(site.cdnMap, {
    'https://stackpath.bootstrapcdn.com/bootstrap/4.1.3/css/bootstrap.min.css': './third-party/bootstrap/css/bootstrap.min.css',
    'https://use.fontawesome.com/releases/v5.2.0/css/all.css': './third-party/fontawesome/css/all.css',
    'https://cdnjs.cloudflare.com/ajax/libs/animate.css/3.7.0/animate.min.css': './third-party/animate/animate.min.css',
    'https://cdnjs.cloudflare.com/ajax/libs/jquery-csv/1.0.3/jquery.csv.min.js': './third-party/jquery-csv/jquery.csv.min.js',
  });
  for (const k of Object.keys(site.cdnMap)) assert.ok(!k.includes('?'));
});

test('excludeAssets and runtimeAssets (design 4.1 / 5)', () => {
  assert.deepEqual(site.excludeAssets, [
    'js/newRelic.js', 'js/libs/jquery/jquery-3.3.1.min.js', 'js/libs/sly/', 'js/oicr.js',
    'json/innovations.json', 'images/svg/']);
  assert.equal(site.runtimeAssets.length, 2);
  assert.ok(site.runtimeAssets.includes('images/svg-interactive.svg'));
  assert.ok(site.runtimeAssets.some((p) => p.startsWith('csv/')));
});

test('tableauViews covers the 16 Tableau sections (FR-06)', () => {
  const sectionNames = site.sections.map((s) => s.action);
  const keys = Object.keys(site.tableauViews);
  assert.equal(keys.length, 16);
  assert.ok(!keys.includes('glossary'));
  for (const k of keys) assert.ok(sectionNames.includes(k), k);
  assert.deepEqual(site.tableauViews.caseReports,
    { server: 'tableau-core.cgiar.org', workbook: 'AR-OICR', views: ['OCIR-DB-Full'] });
  assert.deepEqual(site.tableauViews.home,
    { server: 'tableau-core.cgiar.org', workbook: 'AR-HOME-DB', views: ['Home-DB-Full'] });
  assert.deepEqual(site.tableauViews.ethiopia,
    { server: 'tableau-core.cgiar.org', workbook: 'AR-Ethiopia-DB_16243582481240', views: ['CountrySearch-DB-Full'] });
  for (const [k, v] of Object.entries(site.tableauViews)) {
    assert.equal(v.server, 'tableau-core.cgiar.org', k);
    assert.ok(v.workbook && v.views.length >= 1, k);
  }
  // 13 workbooks, 16 views on tableau-core (inventory section 1)
  assert.equal(new Set(Object.values(site.tableauViews).map((v) => v.workbook)).size, 13);
  assert.equal(Object.values(site.tableauViews).flatMap((v) => v.views).length, 16);
});

test('tableauViews.partnerships carries the 7 legacy public.tableau.com views', () => {
  const p = site.tableauViews.partnerships;
  assert.deepEqual(p.views, ['Partnerships-DB-Full']);
  assert.equal(p.workbook, 'AR-Partnerships');
  assert.equal(p.legacy.server, 'public.tableau.com');
  assert.equal(p.legacy.workbook, 'Results');
  assert.deepEqual(p.legacy.views, [
    '3_1DBTotalPartnerships', '3_2DBTotalPartbyStage', 'DBKeyPartnershipsMap', '3_4DBKeyPartnerships',
    '3_5DBKeyPartbyStage', '3_6DBKeyPartbyStageandProgramType2', '3_7DBKeyPartnersDetails']);
});

test('hosts, budget and sentinel (FR-28, NFR-04, X-12)', () => {
  assert.deepEqual(site.tableauHosts, []);
  assert.deepEqual(site.allowedHosts, [
    '127.0.0.1', 'localhost', '[::1]', 'tableau-core.cgiar.org', 'public.tableau.com',
    'fonts.googleapis.com', 'fonts.gstatic.com']);
  assert.equal(site.buildTimeBudgetMs, 60000);
  assert.equal(site.sentinel, 'RDHOSTORIGINSENTINEL');
  assert.match(site.sentinel, /^[A-Z]+$/);
});
