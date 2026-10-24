// T-08: documentation check for the S2 runbook, validation plan and handoff (FR-17, FR-18, FR-19, FR-22, NFR-05).
// Static read of the real files in infra/. Mutated copies are made in memory (and, for the CLI-less
// env override, in os.tmpdir()); committed docs are never modified.
// Marker contract:
//   - a fenced block that holds an AWS-mutating command is directly preceded (previous non-blank line)
//     by the exact line MUTATING_MARKER;
//   - a fenced block that holds only read-only AWS commands is directly preceded by a line that starts
//     with READONLY_PREFIX (or by the mutating marker);
//   - every fenced block that holds commands is tagged `powershell` (NFR-05).
// AWS command lines are classified by explicit lists; an AWS/SAM line in neither list is a violation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC_NAMES = ['RUNBOOK.md', 'VALIDATION.md', 'HANDOFF-INFRASTRUCTURE.md', 'TAG-CHECK.md'];
const DOCS_DIR = process.env.INFRA_DOCS_DIR || path.join(ROOT, 'infra');
export const MUTATING_MARKER = '> **Requires G-DEPLOY.** AWS-mutating command.';
export const READONLY_PREFIX = '> Read-only.';

const MUTATING = [
  /\bsam\s+(deploy|delete)\b/,
  /\baws\s+cloudformation\s+(deploy|create-stack|update-stack|delete-stack|execute-change-set|create-change-set|delete-change-set)\b/,
  /\baws\s+s3\s+(cp|sync|rm|mv|mb|rb)\b/,
  /\baws\s+s3api\s+(put|delete|create|copy|restore)-/,
  /\baws\s+cloudfront\s+(create|update|delete|tag|untag|publish)-/,
  /\baws\s+iam\s+(create|delete|put|attach|detach|update|tag|untag)-/,
  /\b(npm\s+run\s+publish|node\s+scripts\/publish\.mjs)\b.*--confirm\b/,
];
const READONLY = [
  /\baws\s+cloudformation\s+(describe|list|get|validate)-/,
  /\baws\s+s3\s+ls\b/,
  /\baws\s+s3api\s+(get|list|head)-/,
  /\baws\s+cloudfront\s+(get|list)-/,
  /\baws\s+iam\s+(get|list)-/,
  /\baws\s+budgets\s+(describe|view|list)-/,
  /\baws\s+acm\s+(describe|list)-/,
  /\baws\s+sts\s+get-caller-identity\b/,
  /\baws\s+resourcegroupstaggingapi\s+get-resources\b/,
  /\baws\s+configure\s+(list|get)\b/,
  /\baws\s+sso\s+login\b/,
  /\baws\s+--version\b/,
  /\bsam\s+(--version|validate)\b/,
];
// Offline commands: no AWS call (the publish dry-run is the default and has no --confirm).
const COMMAND_LINE = /^\s*(?:\$\w+\s*=\s*)?(aws|sam|npm|node|cfn-lint)\b|\b(aws|sam)\s+[a-z-]/;

export function parseBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^```(\S*)\s*$/.exec(lines[i]);
    if (!open) continue;
    let j = i + 1;
    while (j < lines.length && !/^```\s*$/.test(lines[j])) j++;
    let p = i - 1;
    while (p >= 0 && lines[p].trim() === '') p--;
    blocks.push({ lang: open[1], line: i + 1, body: lines.slice(i + 1, j), marker: p >= 0 ? lines[p] : '' });
    i = j;
  }
  return blocks;
}

const classify = (l) => (MUTATING.some((r) => r.test(l)) ? 'mutating' : READONLY.some((r) => r.test(l)) ? 'readonly' : null);

// Returns [{ code, where, detail }] for one document text.
export function checkMarkers(name, text) {
  const out = [];
  for (const b of parseBlocks(text)) {
    const where = `${name}:${b.line}`;
    const cmds = b.body.filter((l) => !/^\s*#/.test(l) && COMMAND_LINE.test(l));
    if (cmds.length === 0) continue;
    if (b.lang !== 'powershell') out.push({ code: 'NOT_POWERSHELL', where, detail: `block tagged "${b.lang}" holds commands` });
    let mutating = false;
    let aws = false;
    for (const l of cmds) {
      const c = classify(l);
      if (c === 'mutating') { mutating = true; aws = true; } else if (c === 'readonly') aws = true;
      else if (/\b(aws|sam)\s+[a-z-]/.test(l)) out.push({ code: 'UNCLASSIFIED_AWS_COMMAND', where, detail: l.trim() });
    }
    if (mutating && b.marker !== MUTATING_MARKER) out.push({ code: 'MISSING_GDEPLOY_MARKER', where, detail: cmds.find((l) => classify(l) === 'mutating').trim() });
    if (!mutating && aws && !(b.marker.startsWith(READONLY_PREFIX) || b.marker === MUTATING_MARKER)) {
      out.push({ code: 'MISSING_READONLY_MARKER', where, detail: cmds[0].trim() });
    }
  }
  return out;
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const ROOT_PATH = /\b((?:scripts|infra|release|tests|src)\/[A-Za-z0-9_./*-]+\.(?:mjs|js|json|toml|yaml|md|twig))\b/g;

// Every `npm run <script>` is a package.json script; every repo path mentioned (outside <placeholders>) exists;
// every relative markdown link resolves.
export function checkReferences(name, text, root = ROOT, scripts = pkg.scripts) {
  const out = [];
  for (const m of text.matchAll(/\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g)) {
    if (!(m[1] in scripts)) out.push({ code: 'UNKNOWN_NPM_SCRIPT', where: name, detail: m[1] });
  }
  for (const m of text.matchAll(ROOT_PATH)) {
    if (m[1].includes('*')) continue;
    if (!fs.existsSync(path.join(root, ...m[1].split('/')))) out.push({ code: 'MISSING_FILE', where: name, detail: m[1] });
  }
  for (const m of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
    if (/^[a-z]+:/.test(m[1])) continue;
    if (!fs.existsSync(path.resolve(DOCS_DIR, m[1])) && !fs.existsSync(path.resolve(root, m[1]))) out.push({ code: 'BROKEN_LINK', where: name, detail: m[1] });
  }
  return out;
}

// FR-08 / FR-22 BUT: no account id, no email, no concrete institutional hostname in the docs.
export function checkNoAssumptions(name, text) {
  const out = [];
  if (/\b\d{12}\b/.test(text)) out.push({ code: 'ACCOUNT_ID', where: name, detail: 'twelve-digit number' });
  if (/[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(text)) out.push({ code: 'EMAIL', where: name, detail: 'email address' });
  for (const m of text.matchAll(/(?<![*<\w-])([a-z0-9-]+(?:\.[a-z0-9-]+)*\.cgiar\.org)\b/g)) out.push({ code: 'CONCRETE_HOSTNAME', where: name, detail: m[1] });
  return out;
}

const read = (n) => fs.readFileSync(path.join(DOCS_DIR, n), 'utf8');
const real = () => Object.fromEntries(DOC_NAMES.map((n) => [n, read(n)]));
const codes = (v) => v.map((x) => x.code);

test('the four documents exist', () => {
  for (const n of DOC_NAMES) assert.ok(fs.existsSync(path.join(DOCS_DIR, n)), `${n} missing`);
});

test('every AWS command line is marked, and every command block is PowerShell', () => {
  for (const [n, t] of Object.entries(real())) assert.deepEqual(checkMarkers(n, t), [], n);
});

test('every npm script, repo path and link referenced by the docs exists', () => {
  for (const [n, t] of Object.entries(real())) assert.deepEqual(checkReferences(n, t), [], n);
});

test('no account id, email or concrete institutional hostname is assumed (FR-22 BUT)', () => {
  for (const [n, t] of Object.entries(real())) assert.deepEqual(checkNoAssumptions(n, t), [], n);
});

test('RUNBOOK covers the S2 commands in order and the marked mutating commands', () => {
  const t = read('RUNBOOK.md');
  const order = [
    'sam deploy --config-file infra/samconfig.toml --config-env test',
    'describe-stacks',
    'node scripts/publish.mjs --env test --release release/1f6d95a5',
    'node scripts/publish.mjs --env test --release release/1f6d95a5 --confirm',
    'node scripts/verify-deploy.mjs --url',
    'TAG-CHECK.md',
    'VALIDATION.md',
  ];
  let at = -1;
  for (const s of order) {
    const i = t.indexOf(s, at + 1);
    assert.ok(i > at, `"${s}" missing or out of order`);
    at = i;
  }
  assert.ok(t.split(MUTATING_MARKER).length - 1 >= 3, 'deploy, publish --confirm and rollback each carry the marker');
});

test('VALIDATION records Tableau as BLOCKED with the reason, and lists the S3 re-checks', () => {
  const t = read('VALIDATION.md');
  assert.match(t, /BLOCKED \(institutional domain not attached\)/);
  assert.match(t, /\*\.cgiar\.org/);
  assert.match(t, /S3 re-checks/);
});

test('HANDOFF is a fill-in template with a read command per value and the order of attachment', () => {
  const t = read('HANDOFF-INFRASTRUCTURE.md');
  for (const v of ['DistributionId', 'DistributionArn', 'DistributionDomainName', 'DistributionUrl', 'SiteBucketName']) assert.ok(t.includes(`<${v}>`), `${v} placeholder`);
  assert.match(t, /certificate[\s\S]*stack update[\s\S]*DNS[\s\S]*canonical host/i);
});

// Falsifiers: each mutation must turn a check red with a named code.
test('falsifier: removing the G-DEPLOY marker before sam deploy is caught', () => {
  const t = real()['RUNBOOK.md'];
  const lines = t.split(/\r?\n/);
  const block = parseBlocks(t).find((b) => b.body.some((l) => /^sam deploy /.test(l)));
  assert.ok(block, 'fixture: a block with sam deploy');
  let p = block.line - 2;
  while (lines[p].trim() === '') p--;
  assert.equal(lines[p], MUTATING_MARKER, 'fixture: marker directly before the sam deploy block');
  lines.splice(p, 1);
  const v = checkMarkers('RUNBOOK.md', lines.join('\n'));
  assert.ok(codes(v).includes('MISSING_GDEPLOY_MARKER'), JSON.stringify(v));
  assert.ok(v.some((x) => /sam deploy/.test(x.detail)));
});

test('falsifier: a mutating command with only the read-only marker is caught', () => {
  const v = checkMarkers('x', `${READONLY_PREFIX} nothing\n\n\`\`\`powershell\naws s3 rm s3://b/k\n\`\`\`\n`);
  assert.deepEqual(codes(v), ['MISSING_GDEPLOY_MARKER']);
});

test('falsifier: publish --confirm without the marker is caught, the dry-run needs none', () => {
  const dry = '```powershell\nnode scripts/publish.mjs --env test --release release/1f6d95a5\n```\n';
  assert.deepEqual(checkMarkers('x', dry), []);
  const bad = '```powershell\nnode scripts/publish.mjs --env test --release release/1f6d95a5 --confirm\n```\n';
  assert.deepEqual(codes(checkMarkers('x', bad)), ['MISSING_GDEPLOY_MARKER']);
});

test('falsifier: an unknown AWS verb and a non-PowerShell block are caught', () => {
  assert.deepEqual(codes(checkMarkers('x', `${READONLY_PREFIX}\n\n\`\`\`powershell\naws ec2 run-instances\n\`\`\`\n`)), ['UNCLASSIFIED_AWS_COMMAND']);
  assert.ok(codes(checkMarkers('x', `${READONLY_PREFIX}\n\n\`\`\`bash\naws sts get-caller-identity\n\`\`\`\n`)).includes('NOT_POWERSHELL'));
});

test('falsifier: a non-existent script, npm script, file or link is caught', () => {
  const bad = real()['RUNBOOK.md'] + '\n`npm run does-not-exist` and `scripts/nope.mjs` and [x](./missing.md)\n';
  assert.deepEqual(new Set(codes(checkReferences('RUNBOOK.md', bad))), new Set(['UNKNOWN_NPM_SCRIPT', 'MISSING_FILE', 'BROKEN_LINK']));
});

test('falsifier: an account id, an email or a concrete hostname is caught', () => {
  assert.deepEqual(codes(checkNoAssumptions('x', 'arn:aws:iam::123456789012:user/a, a@b.org, results.cgiar.org')).sort(), ['ACCOUNT_ID', 'CONCRETE_HOSTNAME', 'EMAIL']);
  assert.deepEqual(checkNoAssumptions('x', 'only *.cgiar.org and <hostname>.cgiar.org'), []);
});

test('INFRA_DOCS_DIR makes the document checks run on a copy (temp-copy falsifier path)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-docs-'));
  try {
    for (const n of DOC_NAMES) fs.copyFileSync(path.join(DOCS_DIR, n), path.join(tmp, n));
    const t = fs.readFileSync(path.join(tmp, 'RUNBOOK.md'), 'utf8');
    assert.deepEqual(checkMarkers('RUNBOOK.md', t), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Domain parameters are never cleared by omission: on an existing stack `sam deploy` keeps the previous
// value of an unnamed parameter, so every override string names all eleven parameters (empty = `Name=`).
const ALL_PARAMS = ['Environment', 'PriceClass', 'EnableAccessLogs', 'LogRetentionDays', 'Indexing', 'PublisherPrincipalArn', 'BudgetLimitUsd', 'BudgetEmail', 'AlternateDomainName', 'CertificateArn', 'CanonicalHost'];
export function checkOverrides(name, text) {
  const out = [];
  const lines = text.split(/\r?\n/).filter((l) => /^\$Overrides\s*=/.test(l));
  if (lines.length === 0) out.push({ code: 'NO_OVERRIDES', where: name, detail: 'no $Overrides line' });
  for (const l of lines) {
    for (const p of ALL_PARAMS) if (!new RegExp(`(^|[\\s"])${p}=`).test(l)) out.push({ code: 'PARAM_NOT_NAMED', where: name, detail: p });
  }
  return out;
}

test('every override string names all parameters; the domain rollback passes the three explicitly empty', () => {
  const d = real();
  assert.deepEqual(checkOverrides('RUNBOOK.md', d['RUNBOOK.md']), []);
  assert.deepEqual(checkOverrides('HANDOFF-INFRASTRUCTURE.md', d['HANDOFF-INFRASTRUCTURE.md']), []);
  assert.match(d['RUNBOOK.md'], /\$Overrides = ".* AlternateDomainName= CertificateArn= CanonicalHost="/);
  const overrides = d['HANDOFF-INFRASTRUCTURE.md'].split(/\r?\n/).filter((l) => /^\$Overrides\s*=/.test(l));
  assert.equal(overrides.length, 2, 'attachment block and rollback block');
  assert.match(overrides[1], / AlternateDomainName= CertificateArn= CanonicalHost="$/);
});

test('falsifier: leaving a domain parameter out of an override string is caught', () => {
  const bad = real()['HANDOFF-INFRASTRUCTURE.md'].replace(' AlternateDomainName= CertificateArn= CanonicalHost="', '"');
  assert.deepEqual(codes(checkOverrides('x', bad)).includes('PARAM_NOT_NAMED'), true);
});

test('VALIDATION lists the parent E-06 section 11 items with a status each', () => {
  const t = read('VALIDATION.md');
  for (const id of ['E-06-01', 'E-06-02', 'E-06-03', 'E-06-04', 'E-06-05', 'E-06-05b', 'E-06-06', 'E-06-07']) {
    assert.ok(new RegExp(`\\| ${id} \\|.*NOT RUN`).test(t), `${id} row with a status`);
  }
  assert.match(t, /results-dashboard-aws-migration\/evidence\/validation-report\.md/);
  assert.ok(fs.existsSync(path.join(ROOT, '..', 'docs', 'specs', 'changes', 'results-dashboard-aws-migration', 'evidence', 'validation-report.md')), 'parent path cited exists');
});
