// Shared constants for the E2E suites. Expected values that the design states literally (the 17
// section names, the 18 menu rows) are written here as literals, independent of site.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const DIST = path.resolve(ROOT, process.env.E2E_DIST || 'dist');
export const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'site.json'), 'utf8'));

// FR-05
export const SECTIONS = [
  'home', 'geographicScope', 'partners', 'SDG', 'systemLevelOutcomes', 'caseReports', 'innovations',
  'policies', 'milestones', 'partnerships', 'capDev', 'altmetric', 'publications', 'MELIA', 'genebanks',
  'glossary', 'ethiopia',
];
export const MENU_ROWS = 18; // P-26
export const SECTIONS_WITHOUT_TABLEAU = ['glossary'];
export const FORBIDDEN_HOSTS = ['192.0.2.50', 'results.cgiar.org', 'www.results.cgiar.org'];
export const CDN_HOSTS = ['stackpath.bootstrapcdn.com', 'use.fontawesome.com', 'cdnjs.cloudflare.com'];
export const TABLEAU_HOSTS = ['tableau-core.cgiar.org', 'public.tableau.com'];

export function distFileExists(pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return false; }
  const file = path.join(DIST, ...rel.split('/').filter(Boolean));
  if (!file.startsWith(DIST)) return false;
  try { return fs.statSync(file).isFile(); } catch { return false; }
}
