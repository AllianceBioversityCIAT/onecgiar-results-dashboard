// Shared readers and validators for src/data/site.json (design.md 5, 7.1 step 2).
// Used by the build and by every consumer that derives RD_DATA for rules.core.js,
// so build, local server, edge adapter and tests all see the same section list.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SITE_PATH = path.join(REPO_ROOT, 'src', 'data', 'site.json');

export class SiteDataError extends Error {
  constructor(details) {
    super(`site.json is invalid:\n  ${details.join('\n  ')}`);
    this.name = 'SiteDataError';
    this.details = details;
  }
}

export function loadSite(file = DEFAULT_SITE_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Routable sections: the distinct actions of the non-title menu rows, in menu order
// (design 7.3 rule 5). 17 entries for the shipped data.
export function routableSections(site) {
  return [...new Set(site.sections.filter((s) => s.type !== 'title').map((s) => s.action))];
}

// The RD_DATA global that rules.core.js reads (loadCore first argument). rules.core.js also reads the
// RD_CANONICAL_HOST global (FR-06); it is not site data, so each loader defines it next to RD_DATA.
export function rdData(site) {
  return { sections: routableSections(site), legacyRedirects: site.legacyRedirects };
}

const REQUIRED_KEYS = ['sections', 'crps', 'years', 'chartsInfo', 'dataUrl', 'messages', 'appConfig',
  'defaults', 'variants', 'legacyRedirects', 'cdnMap', 'excludeAssets', 'runtimeAssets',
  'tableauViews', 'tableauHosts', 'allowedHosts', 'buildTimeBudgetMs', 'sentinel'];

function findNulls(value, where, out) {
  if (value === null) {
    out.push(`${where} is null (templates compare these values loosely; null is not allowed)`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => findNulls(v, `${where}[${i}]`, out));
  } else if (typeof value === 'object' && value !== undefined) {
    for (const k of Object.keys(value)) findNulls(value[k], `${where}.${k}`, out);
  }
}

// Step 2 of the build: shape check plus the "no null" check (T-02 known divergences
// assume no null in compared fields). Throws SiteDataError listing every problem.
export function validateSite(site) {
  const problems = [];
  if (site === null || typeof site !== 'object' || Array.isArray(site)) {
    throw new SiteDataError(['top level must be an object']);
  }
  for (const k of REQUIRED_KEYS) {
    if (!(k in site)) problems.push(`missing key "${k}"`);
  }
  if (problems.length > 0) throw new SiteDataError(problems);
  for (const k of ['sections', 'crps', 'years', 'excludeAssets', 'runtimeAssets']) {
    if (!Array.isArray(site[k]) || site[k].length === 0) problems.push(`"${k}" must be a non-empty array`);
  }
  if (Array.isArray(site.sections)) {
    site.sections.forEach((s, i) => {
      for (const f of ['name', 'action', 'type', 'active', 'show']) {
        if (!s || !(f in s)) problems.push(`sections[${i}] is missing "${f}"`);
      }
    });
  }
  for (const k of ['cdnMap', 'tableauViews', 'variants', 'defaults', 'appConfig', 'legacyRedirects']) {
    if (typeof site[k] !== 'object' || site[k] === null || Array.isArray(site[k])) problems.push(`"${k}" must be an object`);
  }
  if (!/^[A-Z]+$/.test(String(site.sentinel))) problems.push('"sentinel" must be uppercase ASCII letters only');
  if (!Number.isInteger(site.defaults && site.defaults.year)) problems.push('defaults.year must be an integer');
  const part = site.variants && site.variants.partnerships;
  if (!part || !part.template || !part.legacyTemplate) problems.push('variants.partnerships needs template and legacyTemplate');
  if (problems.length === 0) {
    const actions = new Set(site.sections.map((s) => s.action));
    for (const k of Object.keys(site.tableauViews)) {
      if (!actions.has(k)) problems.push(`tableauViews.${k} names no section`);
    }
    for (const [url, local] of Object.entries(site.cdnMap)) {
      if (!/^https:\/\/[^?#]+$/.test(url)) problems.push(`cdnMap key "${url}" must be an https URL without query`);
      if (!String(local).startsWith('./third-party/')) problems.push(`cdnMap["${url}"] must start with ./third-party/`);
    }
  }
  findNulls(site, 'site', problems);
  if (problems.length > 0) throw new SiteDataError(problems);
  return site;
}
