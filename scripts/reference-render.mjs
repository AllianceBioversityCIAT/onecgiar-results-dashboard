// R1 step 1 (design 10.2, FR-23): render reference/templates-original (byte-identical copies of the
// original templates, hash-verified) with the variables reference/routes-reference.mjs computes for
// each matrix case. Output: <outDir>/<case id>.html (cdnMap applied, an expected difference) and
// <rawDir>/<case id>.html (as the original would print it, used by R3).
//
// Independence (DD-09): imports only the engine configuration (twig-config.mjs, shared on purpose),
// the hash helpers and the data file. It never imports build.mjs, the runtime scripts or the rules.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRenderer } from './twig-config.mjs';
import { ROOT, MANIFEST_PATH, parseManifest, diffAgainstManifest } from './verify-original.mjs';
import { routeReference } from '../reference/routes-reference.mjs';

export { ROOT };
export const TEMPLATES_ROOT = path.join(ROOT, 'reference', 'templates-original');
export const MATRIX_PATH = path.join(ROOT, 'tests', 'cases', 'compare-matrix.json');
const SITE_PATH = path.join(ROOT, 'src', 'data', 'site.json');

export function loadMatrix() {
  const doc = JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8'));
  if (doc.cases.length !== 84) throw new Error(`compare-matrix.json must have exactly 84 cases, has ${doc.cases.length}`);
  return doc.cases;
}

// Byte-for-byte check of the frozen templates against the manifest of the original app.
export function verifyTemplates() {
  const prefix = 'app/templates/';
  const manifest = parseManifest(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const sub = new Map([...manifest].filter(([p]) => p.startsWith(prefix)).map(([p, h]) => [p.slice(prefix.length), h]));
  const d = diffAgainstManifest(TEMPLATES_ROOT, sub);
  return { ok: sub.size > 0 && !d.changed.length && !d.missing.length && !d.extra.length, files: sub.size, diff: d };
}

// Data that ControlListService and settings supplied to routes.php (data only, no logic).
export function loadReferenceData() {
  const site = JSON.parse(fs.readFileSync(SITE_PATH, 'utf8'));
  return {
    data: {
      sections: site.sections, crps: site.crps, years: site.years, chartsInfo: site.chartsInfo,
      messages: site.messages, dataUrl: site.dataUrl, appConfig: site.appConfig,
    },
    cdnMap: site.cdnMap,
  };
}

// Expected difference: absolute src/href whose part before the first ? or # is a cdnMap key.
export function mapCdn(html, cdnMap) {
  return html.replace(/\b(src|href)=(["'])(https?:\/\/[^"']+)\2/g, (whole, attr, q, url) => {
    const cut = url.search(/[?#]/);
    const base = cut === -1 ? url : url.slice(0, cut);
    const rest = cut === -1 ? '' : url.slice(cut);
    return Object.prototype.hasOwnProperty.call(cdnMap, base) ? `${attr}=${q}${cdnMap[base]}${rest}${q}` : whole;
  });
}

export function createReferenceRenderer() {
  const check = verifyTemplates();
  if (!check.ok) throw new Error(`reference/templates-original differs from the manifest: ${JSON.stringify(check.diff)}`);
  const { data, cdnMap } = loadReferenceData();
  const renderer = createRenderer({ templatesRoot: TEMPLATES_ROOT });
  return {
    templateFiles: check.files,
    renderCase(c) {
      const { template, context } = routeReference({ path: c.path, query: c.query, data });
      const raw = renderer.render(template, context).replace(/\r\n?/g, '\n');
      return { template, raw, mapped: mapCdn(raw, cdnMap) };
    },
  };
}

export function renderAll({ outDir, rawDir, cases = loadMatrix() }) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.rmSync(rawDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(rawDir, { recursive: true });
  const r = createReferenceRenderer();
  const templates = {};
  for (const c of cases) {
    const out = r.renderCase(c);
    fs.writeFileSync(path.join(outDir, `${c.id}.html`), out.mapped);
    fs.writeFileSync(path.join(rawDir, `${c.id}.html`), out.raw);
    templates[c.id] = out.template;
  }
  return { count: cases.length, templateFiles: r.templateFiles, templates };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = renderAll({ outDir: path.join(ROOT, '.cache', 'reference'), rawDir: path.join(ROOT, '.cache', 'reference-raw') });
  console.log(`reference-render: ${out.count} cases rendered from ${out.templateFiles} hash-verified original templates`);
}
