// Offline infrastructure audit (T-04; FR-12, FR-13, FR-08, FR-10, NFR-01, NFR-06; design 5.2, 5.3, 7.7).
// Reads infra/tagging.json, the stack template, samconfig.toml and IAM policy documents. No AWS access.
//   node scripts/audit-infra.mjs [--template <file>] [--samconfig <file>] [--policy <file.json>]...
// Policy files default to infra/iam/*.json (T-05: infra/iam/deployer-policy.json); "*" resources need a documented exception.
// Fail-closed: a resource type that is neither taggable nor a documented exception is a violation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTemplate } from './cfn-yaml.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (...p) => path.join(ROOT, ...p);

export const loadContract = () => JSON.parse(fs.readFileSync(rel('infra', 'tagging.json'), 'utf8'));

const v = (code, where, message) => ({ code, where, message });
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// ---- tags (FR-12) -----------------------------------------------------------------------------
// One template serves both stacks, so a literal Environment would be wrong for one of them:
// only a Ref to the Environment parameter is accepted (checked against AllowedValues in auditTags).
function tagValueOk(contract, template, name, value) {
  const spec = contract.requiredTags[name];
  if (spec.value !== undefined) return value === spec.value;
  return isObj(value) && Object.keys(value).length === 1 && value.Ref === spec.parameterRef
    && isObj(template.Parameters) && spec.parameterRef in template.Parameters;
}

function auditEnvironmentParameter(template, contract) {
  const spec = contract.requiredTags.Environment;
  if (!spec) return [];
  const allowed = template?.Parameters?.[spec.parameterRef]?.AllowedValues;
  const same = Array.isArray(allowed) && allowed.length === spec.values.length && spec.values.every((x) => allowed.includes(x));
  return same ? [] : [v('ENVIRONMENT_PARAMETER', `Parameters.${spec.parameterRef}`, `AllowedValues must equal ${JSON.stringify(spec.values)}, found ${JSON.stringify(allowed)}`)];
}

export function auditTags(template, contract) {
  const out = [...auditEnvironmentParameter(template, contract)];
  const resources = isObj(template?.Resources) ? template.Resources : {};
  for (const [id, res] of Object.entries(resources)) {
    const type = isObj(res) ? res.Type : undefined;
    if (typeof type !== 'string') { out.push(v('UNCLASSIFIED_TYPE', id, 'unclassified type: resource has no string Type')); continue; }
    const forbidden = contract.forbiddenTypePrefixes.find((f) => type.startsWith(f.prefix));
    if (forbidden) { out.push(v('FORBIDDEN_TYPE', id, `forbidden type ${type}: ${forbidden.reason}`)); continue; }
    if (type in contract.exceptionTypes) continue;
    const taggable = contract.taggableTypes[type];
    if (!taggable) { out.push(v('UNCLASSIFIED_TYPE', id, `unclassified type ${type}: add it to taggableTypes or exceptionTypes (with a reason) in infra/tagging.json`)); continue; }
    const tags = res.Properties?.[taggable.property];
    if (!Array.isArray(tags)) { out.push(v('MISSING_TAG', id, `${type} has no ${taggable.property} list (Project and Environment required)`)); continue; }
    for (const name of Object.keys(contract.requiredTags)) {
      const entry = tags.find((t) => isObj(t) && t.Key === name);
      if (!entry) out.push(v('MISSING_TAG', id, `${type} ${taggable.property} lacks required tag ${name}`));
      else if (!tagValueOk(contract, template, name, entry.Value)) out.push(v('BAD_TAG_VALUE', id, `${type} tag ${name} has an unaccepted value ${JSON.stringify(entry.Value)}`));
    }
  }
  return out;
}

export function classify(template, contract) {
  const counts = { total: 0, taggable: 0, exception: 0 };
  for (const res of Object.values(template?.Resources ?? {})) {
    counts.total++;
    if (res?.Type in contract.taggableTypes) counts.taggable++;
    else if (res?.Type in contract.exceptionTypes) counts.exception++;
  }
  return counts;
}

// ---- samconfig.toml stack tags (FR-12) ------------------------------------------------------------
export function auditSamconfig(text, contract, envs = ['test', 'prod']) {
  const out = [];
  const sections = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (h) { current = h[1].trim(); sections.set(current, {}); continue; }
    const kv = line.match(/^\s*([A-Za-z_]+)\s*=\s*"([^"]*)"\s*(#.*)?$/);
    if (kv && current) sections.get(current)[kv[1]] = kv[2];
  }
  for (const env of envs) {
    const where = `samconfig.toml [${env}.deploy.parameters]`;
    const sec = sections.get(`${env}.deploy.parameters`);
    if (!sec) { out.push(v('SAMCONFIG_TAG', where, 'section missing')); continue; }
    if (sec.tags === undefined) { out.push(v('SAMCONFIG_TAG', where, 'no tags entry')); continue; }
    const pairs = Object.fromEntries(sec.tags.split(/\s+/).filter(Boolean).map((p) => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; }));
    if (pairs.Project !== contract.requiredTags.Project.value) out.push(v('SAMCONFIG_TAG', where, `stack tag Project must be ${contract.requiredTags.Project.value}, found ${JSON.stringify(pairs.Project)}`));
    if (pairs.Environment !== env) out.push(v('SAMCONFIG_TAG', where, `stack tag Environment must be ${env}, found ${JSON.stringify(pairs.Environment)}`));
  }
  return out;
}

// ---- IAM statements (FR-10, NFR-01) ---------------------------------------------------------------
const leaves = (x, acc = []) => {
  if (typeof x === 'string') acc.push(x);
  else if (Array.isArray(x)) x.forEach((i) => leaves(i, acc));
  else if (isObj(x)) Object.values(x).forEach((i) => leaves(i, acc));
  return acc;
};
const statementsIn = (node, acc = []) => {
  if (Array.isArray(node)) node.forEach((n) => statementsIn(n, acc));
  else if (isObj(node)) {
    if ('Effect' in node && ('Action' in node || 'NotAction' in node)) acc.push(node);
    Object.values(node).forEach((n) => statementsIn(n, acc));
  }
  return acc;
};
// A resource is a wildcard when it is "*" or an ARN whose resource part is only a type token plus "*"
// segments (distribution/*, changeSet/*/*, or a bare "*"): it matches every resource of that type in the
// account, so it needs the same documented exception as Resource "*". Name-prefixed patterns such as
// results-dashboard-* or an S3 <bucket>/* are scoped.
export const isWideResource = (r) => {
  if (r === '*') return true;
  if (typeof r !== 'string' || !r.startsWith('arn:')) return false;
  const part = r.split(':').slice(5).join(':');
  if (/^\*(\/\*)*$/.test(part)) return true;
  // S3 ARNs are bucket[/key]: "<bucket>/*" is scoped to that bucket, not a resource type.
  return r.split(':')[2] !== 's3' && /^[A-Za-z][A-Za-z0-9-]*(\/\*)+$/.test(part);
};
const wideResources = (st) => leaves(st.Resource).filter(isWideResource);
const READ_ONLY = /^(acm|acm-pca|route53|route53domains):(describe|list|get|check|view)/i;
const DNS_CERT_SERVICE = /^(acm|acm-pca|route53|route53domains):/i;

// Only Effect: Allow is audited for wildcards: a Deny with s3:* only removes access (FR-04 TLS deny).
// An Effect that is not the literal "Deny" is treated as Allow (fail closed).
export function auditPolicyDocument(doc, source, contract) {
  const out = [];
  for (const st of statementsIn(doc)) {
    if (st.Effect === 'Deny') continue;
    const where = `${source}${st.Sid ? ` (Sid ${st.Sid})` : ''}`;
    if ('NotAction' in st) out.push(v('IAM_NOTACTION', where, 'Allow with NotAction grants everything except the listed actions'));
    for (const a of leaves(st.Action)) {
      if (a === '*' || a === '*:*') out.push(v('IAM_WILDCARD_ACTION', where, `Allow with Action "${a}"`));
      else if (/^[A-Za-z0-9-]+:\*$/.test(a)) out.push(v('IAM_WILDCARD_ACTION', where, `Allow with service wildcard action ${a}`));
      if (DNS_CERT_SERVICE.test(a) && !READ_ONLY.test(a)) out.push(v('IAM_FORBIDDEN_WRITE', where, `Allow of ${a}: no ACM, ACM PCA, Route 53 or Route 53 Domains write actions (FR-10)`));
    }
    const resources = [...leaves(st.Resource), ...leaves(st.NotResource)];
    if ('NotResource' in st || resources.some(isWideResource)) {
      const entry = (contract.iamResourceWildcardAllowlist ?? []).find((e) => e.source === source && e.sid && e.sid === st.Sid);
      if (!entry) out.push(v('IAM_WILDCARD_RESOURCE', where, 'Allow with Resource "*" (or NotResource) outside the documented allowlist in infra/tagging.json'));
      else {
        const problem = exceptionProblem(entry, st);
        if (problem) out.push(v('IAM_EXCEPTION_UNDOCUMENTED', where, problem));
      }
    }
  }
  // An allowlist entry for this source whose statement is gone (or no longer uses "*") is stale.
  for (const e of contract.iamResourceWildcardAllowlist ?? []) {
    if (e.source !== source) continue;
    const st = statementsIn(doc).find((x) => x.Sid === e.sid && x.Effect !== 'Deny');
    if (!st || wideResources(st).length === 0) out.push(v('IAM_EXCEPTION_STALE', `${source} (Sid ${e.sid})`, 'allowlist entry has no matching Allow statement with a wildcard or type-wide resource'));
  }
  return out;
}

// A "*"-resource exception is evidence only when it names its actions, gives a reason and cites the
// AWS Service Authorization Reference page of the service with a verification status (and a closure point if UNVERIFIED) (T-05 Disqualifier).
const SERVICE_REF_URL = /^https:\/\/docs\.aws\.amazon\.com\/service-authorization\/latest\/reference\/list_[a-z0-9_]+\.html$/;
function exceptionProblem(e, st) {
  if (typeof e.reason !== 'string' || !e.reason.trim()) return 'exception has no reason';
  if (typeof e.reference !== 'string' || !SERVICE_REF_URL.test(e.reference)) return 'exception reference must be a Service Authorization Reference URL (list_<service>.html)';
  if (typeof e.referenceStatus !== 'string' || !e.referenceStatus.trim()) return 'exception has no referenceStatus (verified at source, or UNVERIFIED)';
  if (/^UNVERIFIED/.test(e.referenceStatus) && (typeof e.closure !== 'string' || !e.closure.trim())) return 'UNVERIFIED exception has no closure point (who closes it, and when)';
  const wide = wideResources(st).sort();
  const declaredRes = Array.isArray(e.resources) ? [...e.resources].sort() : null;
  if (!declaredRes || JSON.stringify(wide) !== JSON.stringify(declaredRes)) return `exception resources ${JSON.stringify(declaredRes)} must equal the statement's wildcard resources ${JSON.stringify(wide)}`;
  const granted = [...leaves(st.Action)].sort();
  const declared = Array.isArray(e.actions) ? [...e.actions].sort() : null;
  if (!declared || JSON.stringify(granted) !== JSON.stringify(declared)) return `exception actions ${JSON.stringify(declared)} must equal the statement actions ${JSON.stringify(granted)}`;
  return null;
}

export function auditTemplate(template, contract) {
  return [...auditTags(template, contract), ...auditPolicyDocument(template, 'template.yaml', contract)];
}

// ---- CLI ----------------------------------------------------------------------------------------
function main(argv) {
  const opts = { template: rel('infra', 'template.yaml'), samconfig: rel('infra', 'samconfig.toml'), policies: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--template') opts.template = path.resolve(argv[++i]);
    else if (argv[i] === '--samconfig') opts.samconfig = path.resolve(argv[++i]);
    else if (argv[i] === '--policy') opts.policies.push(path.resolve(argv[++i]));
    else { console.error(`unknown argument ${argv[i]}`); return 2; }
  }
  let discovered = false;
  if (opts.policies.length === 0) {
    discovered = true;
    const dir = rel('infra', 'iam');
    if (fs.existsSync(dir)) opts.policies = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(dir, f));
  }
  const contract = loadContract();
  const template = parseTemplate(fs.readFileSync(opts.template, 'utf8'));
  const violations = [
    ...auditTemplate(template, contract),
    ...auditSamconfig(fs.readFileSync(opts.samconfig, 'utf8'), contract),
  ];
  for (const p of opts.policies) violations.push(...auditPolicyDocument(JSON.parse(fs.readFileSync(p, 'utf8')), path.relative(ROOT, p).split(path.sep).join('/'), contract));
  const audited = new Set(opts.policies.map((p) => path.relative(ROOT, p).split(path.sep).join('/')));
  for (const e of contract.iamResourceWildcardAllowlist ?? []) {
    if (discovered && !audited.has(e.source)) violations.push(v('IAM_EXCEPTION_STALE', `${e.source} (Sid ${e.sid})`, 'allowlist entry names a policy file that was not audited'));
  }
  const c = classify(template, contract);
  console.log(`audit-infra: ${c.total} resources (${c.taggable} taggable, ${c.exception} documented exceptions), ${opts.policies.length} policy file(s)`);
  if (violations.length === 0) { console.log('audit-infra: PASS'); return 0; }
  for (const x of violations) console.log(`  [${x.code}] ${x.where}: ${x.message}`);
  console.log(`audit-infra: FAIL (${violations.length} violation(s))`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
