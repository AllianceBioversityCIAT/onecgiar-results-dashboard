// `npm run build:infra` (design.md 4, 7.2, DD-11): generates infra/template.yaml from
// infra/template.src.yaml. Two placeholders are filled:
//   __RD_EDGE_CODE__  the CloudFront Function source, assembled in memory from the shared cores
//                     (scripts/build-edge.mjs) and inlined under Fn::Sub. It never writes dist/ or
//                     dist-edge/ and never runs the site build.
//   __RD_CSP__        the report-only CSP of scripts/serve.mjs (SECURITY_HEADERS), so AWS and the
//                     local emulation cannot drift apart (P-9).
// The output is deterministic (no timestamps, LF line ends). A test fails when the committed file
// differs from a fresh build.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';
import {
  assembleEdge, checkEdgeSource, EDGE_MAX_BYTES, CANONICAL_HOST_PLACEHOLDER,
} from './build-edge.mjs';
import { loadSite, validateSite, rdData, REPO_ROOT } from './site-data.mjs';
import { SECURITY_HEADERS } from './serve.mjs';

export const SRC_FILE = path.join('infra', 'template.src.yaml');
export const OUT_FILE = path.join('infra', 'template.yaml');
export const EDGE_PLACEHOLDER = '__RD_EDGE_CODE__';
export const CSP_PLACEHOLDER = '__RD_CSP__';
// CloudFormation: maximum template body passed in a request (P-22, cloudformation-limits).
export const TEMPLATE_MAX_BYTES = 51200;
// CanonicalHost and AlternateDomainName are limited to 253 characters by the template parameters.
export const LONGEST_HOST = 'h'.repeat(253);

export class InfraBuildError extends Error {
  constructor(details) {
    super(details[0]);
    this.name = 'InfraBuildError';
    this.details = details;
  }
}

const toLf = (s) => s.replace(/\r\n?/g, '\n');

// The edge source with the ${CanonicalHost} placeholder, from the cores on disk (in memory only).
export function edgeSource(root = REPO_ROOT) {
  const legacySource = fs.readFileSync(path.join(root, 'src', 'runtime', 'legacy-compat.core.js'), 'utf8');
  const rulesSource = fs.readFileSync(path.join(root, 'src', 'routing', 'rules.core.js'), 'utf8');
  const data = rdData(validateSite(loadSite(path.join(root, 'src', 'data', 'site.json'))));
  let text = assembleEdge({ legacySource, rulesSource, data });
  // Same size rule as build-edge.mjs: whole-line comments are stripped only when over budget.
  if (Buffer.byteLength(text, 'utf8') > EDGE_MAX_BYTES) text = assembleEdge({ legacySource, rulesSource, data, strip: true });
  const findings = checkEdgeSource(text);
  // Fn::Sub safety (design 7.2): the only dollar-brace sequence is the CanonicalHost placeholder.
  const rest = text.split(CANONICAL_HOST_PLACEHOLDER).join('');
  if (rest.includes('$' + '{')) findings.push('edge code contains a dollar-brace sequence other than ' + CANONICAL_HOST_PLACEHOLDER);
  if (text.split(CANONICAL_HOST_PLACEHOLDER).length !== 2) findings.push(CANONICAL_HOST_PLACEHOLDER + ' must appear exactly once');
  if (text.includes('__RD_')) findings.push('edge code contains a generator placeholder');
  // Size after substitution, for the longest host the template parameters allow (NFR-04).
  const substituted = Buffer.byteLength(text.split(CANONICAL_HOST_PLACEHOLDER).join(LONGEST_HOST), 'utf8');
  if (substituted > EDGE_MAX_BYTES) findings.push(`substituted edge code is ${substituted} bytes, over ${EDGE_MAX_BYTES}`);
  if (findings.length > 0) throw new InfraBuildError([`${findings.length} finding(s) in the edge source`, ...findings]);
  return text;
}

// Returns the full text of infra/template.yaml.
export function buildTemplate(root = REPO_ROOT) {
  const src = toLf(fs.readFileSync(path.join(root, SRC_FILE), 'utf8'));
  const edge = edgeSource(root);
  const csp = SECURITY_HEADERS['Content-Security-Policy-Report-Only'];
  if (typeof csp !== 'string' || csp === '') throw new InfraBuildError(['serve.mjs exposes no report-only CSP']);
  if (csp.includes('$' + '{')) throw new InfraBuildError(['the CSP contains a dollar-brace sequence']);

  const lines = src.split('\n');
  const edgeAt = lines.map((l, i) => (l.trim() === EDGE_PLACEHOLDER ? i : -1)).filter((i) => i !== -1);
  if (edgeAt.length !== 1) throw new InfraBuildError([`${SRC_FILE} must contain ${EDGE_PLACEHOLDER} on a line of its own exactly once`]);
  const indent = lines[edgeAt[0]].match(/^\s*/)[0];
  const block = edge.replace(/\n$/, '').split('\n').map((l) => (l === '' ? '' : indent + l));
  lines.splice(edgeAt[0], 1, ...block);
  let out = lines.join('\n');
  const cspCount = out.split(CSP_PLACEHOLDER).length - 1;
  if (cspCount !== 1) throw new InfraBuildError([`${SRC_FILE} must contain ${CSP_PLACEHOLDER} exactly once, found ${cspCount}`]);
  // A JSON string is a valid double-quoted YAML scalar.
  out = out.replace(CSP_PLACEHOLDER, JSON.stringify(csp));

  // Round-trip: the YAML must parse and carry back exactly the inputs.
  const doc = parseDocument(out, { uniqueKeys: true });
  const problems = doc.errors.map((e) => e.message);
  const code = doc.getIn(['Resources', 'EdgeFunction', 'Properties', 'FunctionCode', 'Fn::Sub']);
  if (code !== edge) problems.push('FunctionCode does not round-trip to the edge source');
  const cspBack = doc.getIn(['Resources', 'HeadersPolicy', 'Properties', 'ResponseHeadersPolicyConfig', 'CustomHeadersConfig', 'Items', 0, 'Value']);
  if (cspBack !== csp) problems.push('the CSP does not round-trip');
  const bytes = Buffer.byteLength(out, 'utf8');
  if (bytes >= TEMPLATE_MAX_BYTES) problems.push(`template is ${bytes} bytes, over the ${TEMPLATE_MAX_BYTES} byte direct-upload limit`);
  if (problems.length > 0) throw new InfraBuildError([`${problems.length} problem(s) in the generated template`, ...problems]);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const text = buildTemplate();
    fs.writeFileSync(path.join(REPO_ROOT, OUT_FILE), text);
    console.log(`wrote ${OUT_FILE} (${Buffer.byteLength(text, 'utf8')} bytes)`);
  } catch (e) {
    if (!(e instanceof InfraBuildError)) throw e;
    for (const d of e.details) console.error(d);
    process.exit(1);
  }
}
