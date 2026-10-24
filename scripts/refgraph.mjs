// Reference-graph validator (design.md 7.1 step 7, X-3, Y-9, FR-19).
// Checks every local reference in the built output: HTML asset tags, CSS url(), SVG
// script/image/use references, runtimeAssets, and navigation links (through rules.core in
// local mode). Absolute URLs with a scheme, protocol-relative URLs and fragment-only values are
// not files and are skipped. Matching is case-sensitive (an in-memory set of exact paths, never
// the file system, whose case rules differ per OS).
import fs from 'node:fs';
import path from 'node:path';
import { listFiles } from './manifest.mjs';

const ORIGIN = 'http://rd.invalid';

// Attributes that load a resource, per tag.
const ASSET_ATTRS = {
  script: ['src', 'href', 'xlink:href'], link: ['href'], img: ['src'], iframe: ['src'],
  source: ['src'], use: ['href', 'xlink:href'], image: ['href', 'xlink:href'], video: ['src', 'poster'],
  audio: ['src'], embed: ['src'], track: ['src'], object: ['data'],
};
const NAV_ATTRS = { a: ['href'], area: ['href'] };

const TAG_RE = /<([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>=`]+))?)*)\s*\/?>/g;
const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+)))?/g;

export function parseAttrs(source) {
  const attrs = {};
  for (const m of source.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

const decodeEntities = (v) => v.replace(/&amp;/g, '&');

// CSS text -> list of url()/@import targets.
export function extractCssRefs(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const refs = [];
  for (const m of text.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)) refs.push(m[2]);
  for (const m of text.matchAll(/@import\s+(['"])(.*?)\1/g)) refs.push(m[2]);
  return refs;
}

// Markup (HTML or SVG) -> { assets, links, css } with the raw attribute values.
export function extractMarkupRefs(markup) {
  const assets = [];
  const links = [];
  const css = [];
  let text = markup.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, (all, body) => { css.push(body); return '<style></style>'; });
  text = text.replace(/<script\b([^>]*)>[\s\S]*?<\/script\s*>/gi, '<script$1></script>');
  for (const m of text.matchAll(TAG_RE)) {
    const tag = m[1].toLowerCase();
    const attrs = parseAttrs(m[2]);
    for (const a of ASSET_ATTRS[tag] || []) {
      if (a in attrs) assets.push({ tag, attr: a, value: decodeEntities(attrs[a]) });
    }
    for (const a of NAV_ATTRS[tag] || []) {
      if (a in attrs) links.push({ tag, attr: a, value: decodeEntities(attrs[a]) });
    }
    if (attrs.style) css.push(attrs.style);
  }
  return { assets, links, css };
}

// "Is this a file or route reference?" Browsers trim ASCII whitespace from URL attributes.
function localRef(value) {
  const v = value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
  if (v === '' || v.startsWith('#') || v.startsWith('//')) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)) return null;
  return v;
}

// Resolve a reference against the URL path of its container; returns { pathname, search } of the
// resulting URL (pathname percent-encoded as a browser would send it).
function resolveUrl(ref, containerUrlPath) {
  const u = new URL(ref, ORIGIN + containerUrlPath);
  return { pathname: u.pathname, search: u.search.startsWith('?') ? u.search.slice(1) : '' };
}

function safeDecode(p) {
  try { return decodeURIComponent(p); } catch { return p; }
}

function isExcluded(rel, excludeAssets) {
  return excludeAssets.some((e) => (e.endsWith('/') ? rel.startsWith(e) : rel === e));
}

// URL of an output HTML page: its clean route. Every page sits at the root of dist/, so the
// resolution directory is always "/" (design 7.1, "Resolution").
function pageUrlPath(file) {
  return `/${file.replace(/\.html$/, '').replace(/--embed(-nonav)?$/, '').replace(/-2017$/, '')}`;
}

/**
 * @param {object} o
 * @param {string} o.outDir        built output folder
 * @param {object} o.site          parsed site.json
 * @param {Function} o.resolve     rules.core resolve(request, mode)
 * @param {Function} o.lastValue   legacy-compat lastValue (same parser semantics as the adapters)
 * @returns {Array<{file:string, kind:string, resource:string, reason:string}>}
 */
export function checkRefGraph({ outDir, site, resolve, lastValue }) {
  const files = new Set(listFiles(outDir));
  const findings = [];
  const excluded = site.excludeAssets || [];
  const read = (rel) => fs.readFileSync(path.join(outDir, ...rel.split('/')), 'utf8');

  const checkFile = (container, kind, raw, containerUrlPath) => {
    const ref = localRef(raw);
    if (ref === null) return;
    const rel = safeDecode(resolveUrl(ref, containerUrlPath).pathname).replace(/^\//, '');
    if (isExcluded(rel, excluded)) {
      findings.push({ file: container, kind, resource: raw.trim(), reason: `points into excludeAssets (${rel})` });
    } else if (!files.has(rel)) {
      findings.push({ file: container, kind, resource: raw.trim(), reason: `file not found in output (${rel})` });
    }
  };

  const checkLink = (container, raw, containerUrlPath) => {
    const ref = localRef(raw);
    if (ref === null) return;
    const { pathname, search } = resolveUrl(ref, containerUrlPath);
    const params = {};
    const sp = new URLSearchParams(search);
    for (const k of new Set(sp.keys())) params[k] = lastValue(sp, k);
    // 'local' mode: rule 1 is off, the host is irrelevant. The caller's core defines RD_CANONICAL_HOST ('').
    const result = resolve({ method: 'GET', host: 'results.cgiar.org', path: pathname, query: search, params }, 'local');
    const kind = '<a href>';
    if (result.type === 'notFound' || result.type === 'badRequest' || result.type === 'methodNotAllowed') {
      findings.push({ file: container, kind, resource: raw.trim(), reason: `route resolves to ${result.type}` });
    } else if (result.type === 'rewrite' && !files.has(result.file)) {
      findings.push({ file: container, kind, resource: raw.trim(), reason: `route rewrites to missing file ${result.file}` });
    } else if (result.type === 'pass') {
      const rel = safeDecode(pathname).replace(/^\//, '');
      if (isExcluded(rel, excluded)) {
        findings.push({ file: container, kind, resource: raw.trim(), reason: `points into excludeAssets (${rel})` });
      } else if (!files.has(rel)) {
        findings.push({ file: container, kind, resource: raw.trim(), reason: `static link to missing file (${rel})` });
      }
    }
  };

  for (const rel of [...files]) {
    const ext = path.posix.extname(rel).toLowerCase();
    if (ext === '.html') {
      const urlPath = pageUrlPath(rel);
      const refs = extractMarkupRefs(read(rel));
      const seen = new Set();
      for (const r of refs.assets) {
        const key = `${r.tag}|${r.value}`;
        if (!seen.has(key)) { seen.add(key); checkFile(rel, `<${r.tag} ${r.attr}>`, r.value, urlPath); }
      }
      for (const r of refs.links) {
        const key = `a|${r.value}`;
        if (!seen.has(key)) { seen.add(key); checkLink(rel, r.value, urlPath); }
      }
      for (const css of refs.css) for (const u of extractCssRefs(css)) checkFile(rel, 'CSS url()', u, urlPath);
    } else if (ext === '.css') {
      for (const u of extractCssRefs(read(rel))) checkFile(rel, 'CSS url()', u, `/${rel}`);
    } else if (ext === '.svg') {
      const refs = extractMarkupRefs(read(rel));
      for (const r of refs.assets) checkFile(rel, `<${r.tag} ${r.attr}>`, r.value, `/${rel}`);
      for (const css of refs.css) for (const u of extractCssRefs(css)) checkFile(rel, 'CSS url()', u, `/${rel}`);
    }
  }
  for (const asset of site.runtimeAssets || []) {
    if (!files.has(asset)) findings.push({ file: 'site.json runtimeAssets', kind: 'runtimeAssets', resource: asset, reason: 'file not found in output' });
  }
  return findings;
}
