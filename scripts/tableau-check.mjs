// Step 8 of the build (design.md 7.1, FR-06): the Tableau views requested by the page JavaScript
// must equal site.json tableauViews. The page JS is found through the built HTML: every
// <script src> that exists in the output and calls createTableauViz / createTableauVizNew.
import fs from 'node:fs';
import path from 'node:path';
import { listFiles } from './manifest.mjs';
import { extractMarkupRefs } from './refgraph.mjs';

function stripComments(js) {
  return js.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
}

// { workbook, server, views[] } requested by one page script, or null when it creates no viz.
export function requestsOf(js, site) {
  const text = stripComments(js);
  const isNew = /createTableauVizNew\s*\(/.test(text);
  const isOld = /createTableauViz\s*\(/.test(text);
  if (!isNew && !isOld) return null;
  // Only page scripts count; tableauFunctions.js defines the creators and requests nothing.
  if (!/vizDataArray\s*=/.test(text)) return null;
  const section = /var\s+SECTION\s*=\s*(['"])([^'"]+)\1/.exec(text);
  const region = /vizDataArray\s*=\s*\[([\s\S]*?)\]\s*;/.exec(text);
  const views = region ? [...region[1].matchAll(/view\s*:\s*(['"])([^'"]+)\1/g)].map((m) => m[2]) : [];
  const base = isNew ? site.appConfig.tableauViewNew : site.appConfig.tableauView;
  return { workbook: section ? section[2] : null, server: new URL(base).hostname, views };
}

const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// Returns a list of difference strings (empty = equal).
export function checkTableauViews({ outDir, site }) {
  const diffs = [];
  const files = new Set(listFiles(outDir));
  const sections = [...new Set(site.sections.filter((s) => s.type !== 'title').map((s) => s.action))];
  const seenSections = new Set();
  for (const section of sections) {
    const variants = [section];
    if (section === 'partnerships') variants.push('partnerships-2017');
    for (const base of variants) {
      const expected = base === 'partnerships-2017' ? (site.tableauViews[section] || {}).legacy : site.tableauViews[section];
      for (const suffix of ['', '--embed', '--embed-nonav']) {
        const page = `${base}${suffix}.html`;
        if (!files.has(page)) { diffs.push(`${page}: page missing from output`); continue; }
        const scripts = extractMarkupRefs(fs.readFileSync(path.join(outDir, page), 'utf8')).assets
          .filter((a) => a.tag === 'script' && a.attr === 'src')
          .map((a) => a.value.trim().split(/[?#]/)[0].replace(/^\.\//, ''));
        const requested = [];
        for (const s of scripts) {
          if (s.startsWith('js/libs/') || !files.has(s) || !s.endsWith('.js')) continue;
          const r = requestsOf(fs.readFileSync(path.join(outDir, ...s.split('/')), 'utf8'), site);
          if (r) requested.push({ ...r, script: s });
        }
        if (!expected) {
          if (requested.length > 0) diffs.push(`${page}: requests views but tableauViews has no entry for ${base} (${requested.map((r) => r.script).join(', ')})`);
          continue;
        }
        seenSections.add(base);
        if (requested.length === 0) { diffs.push(`${page}: requests no Tableau view, tableauViews expects ${expected.views.join(', ')}`); continue; }
        const got = {
          workbooks: [...new Set(requested.map((r) => r.workbook))],
          servers: [...new Set(requested.map((r) => r.server))],
          views: requested.flatMap((r) => r.views),
        };
        if (got.workbooks.length !== 1 || got.workbooks[0] !== expected.workbook) diffs.push(`${page}: workbook ${JSON.stringify(got.workbooks)} != expected ${expected.workbook}`);
        if (got.servers.length !== 1 || got.servers[0] !== expected.server) diffs.push(`${page}: server ${JSON.stringify(got.servers)} != expected ${expected.server}`);
        if (!same(got.views, expected.views)) diffs.push(`${page}: views [${got.views.join(', ')}] != expected [${expected.views.join(', ')}]`);
      }
    }
  }
  for (const key of Object.keys(site.tableauViews)) {
    if (!seenSections.has(key)) diffs.push(`tableauViews.${key} was not matched by any page`);
  }
  return diffs;
}
