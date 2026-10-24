// T-04: offline infrastructure audit (FR-12, FR-13, FR-08, FR-10, NFR-01; design 5.2, 5.3, 7.7).
// The audit runs on the real template (green) and on mutated copies made in memory or in os.tmpdir()
// (each mutation must fail with a named code). Committed infra files are never modified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseTemplate } from '../../scripts/cfn-yaml.mjs';
import {
  loadContract, auditTemplate, auditTags, auditSamconfig, auditPolicyDocument, classify,
} from '../../scripts/audit-infra.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');
const contract = loadContract();
const fresh = () => parseTemplate(read('infra/template.yaml'));
const codes = (violations) => violations.map((x) => x.code);
const TAGGABLE_IDS = ['SiteBucket', 'LogBucket', 'Distribution', 'EdgeFunction', 'PublisherRole', 'Budget'];

test('real template and samconfig.toml pass the audit', () => {
  const t = fresh();
  assert.deepEqual(auditTemplate(t, contract), []);
  assert.deepEqual(auditSamconfig(read('infra/samconfig.toml'), contract), []);
  assert.deepEqual(classify(t, contract), { total: 11, taggable: 6, exception: 5 });
  assert.deepEqual(Object.keys(t.Resources).filter((id) => t.Resources[id].Type in contract.taggableTypes).sort(), [...TAGGABLE_IDS].sort());
});

test('every exception type carries a reason and a reference (FR-12 BUT)', () => {
  for (const [type, e] of Object.entries(contract.exceptionTypes)) {
    assert.ok(e.reason && e.reference, `${type} needs a reason and a reference`);
  }
});

test('CLI exits 0 on the real files', () => {
  const r = spawnSync(process.execPath, ['scripts/audit-infra.mjs'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /audit-infra: PASS/);
});

test('removing Tags from EdgeFunction fails with MISSING_TAG naming it', () => {
  const t = fresh();
  delete t.Resources.EdgeFunction.Properties.Tags;
  const found = auditTags(t, contract);
  assert.deepEqual(found.map((x) => [x.code, x.where]), [['MISSING_TAG', 'EdgeFunction']]);
});

test('removing ResourceTags from Budget fails (the Budget tag property is ResourceTags)', () => {
  const t = fresh();
  delete t.Resources.Budget.Properties.ResourceTags;
  assert.deepEqual(auditTags(t, contract).map((x) => [x.code, x.where]), [['MISSING_TAG', 'Budget']]);
});

test('a missing Environment tag, or a wrong Project value, fails', () => {
  const t = fresh();
  t.Resources.SiteBucket.Properties.Tags = t.Resources.SiteBucket.Properties.Tags.filter((x) => x.Key !== 'Environment');
  t.Resources.Distribution.Properties.Tags.find((x) => x.Key === 'Project').Value = 'other';
  t.Resources.LogBucket.Properties.Tags.find((x) => x.Key === 'Environment').Value = 'staging';
  const found = auditTags(t, contract);
  assert.deepEqual(found.map((x) => [x.code, x.where]).sort(), [['BAD_TAG_VALUE', 'Distribution'], ['BAD_TAG_VALUE', 'LogBucket'], ['MISSING_TAG', 'SiteBucket']]);
});

test('Environment accepts only a Ref to the Environment parameter; a literal test or prod fails (one template, two stacks)', () => {
  for (const literal of ['prod', 'test']) {
    const t = fresh();
    t.Resources.SiteBucket.Properties.Tags.find((x) => x.Key === 'Environment').Value = literal;
    assert.deepEqual(auditTags(t, contract).map((x) => [x.code, x.where]), [['BAD_TAG_VALUE', 'SiteBucket']], literal);
  }
  const t = fresh();
  t.Resources.SiteBucket.Properties.Tags.find((x) => x.Key === 'Environment').Value = { Ref: 'PriceClass' };
  assert.deepEqual(codes(auditTags(t, contract)), ['BAD_TAG_VALUE']);
});

test('Environment parameter AllowedValues must equal [test, prod]: adding staging, dropping prod or removing the list fails', () => {
  assert.deepEqual(fresh().Parameters.Environment.AllowedValues, ['test', 'prod']);
  for (const mutate of [(l) => [...l, 'staging'], (l) => l.filter((x) => x !== 'prod'), () => undefined]) {
    const t = fresh();
    const before = t.Parameters.Environment.AllowedValues;
    t.Parameters.Environment.AllowedValues = mutate(before);
    assert.deepEqual(codes(auditTags(t, contract)), ['ENVIRONMENT_PARAMETER']);
  }
  const t = fresh();
  delete t.Parameters.Environment;
  assert.ok(codes(auditTags(t, contract)).includes('ENVIRONMENT_PARAMETER'));
});

test('an unclassified resource type fails (unknown types never pass)', () => {
  const t = fresh();
  t.Resources.Alerts = { Type: 'AWS::SNS::Topic', Properties: {} };
  const found = auditTags(t, contract);
  assert.deepEqual(found.map((x) => [x.code, x.where]), [['UNCLASSIFIED_TYPE', 'Alerts']]);
  assert.match(found[0].message, /unclassified type AWS::SNS::Topic/);
});

test('an IAM managed policy fails as forbidden (design 5.3: no managed policy; it cannot be tagged)', () => {
  const t = fresh();
  t.Resources.Pol = { Type: 'AWS::IAM::ManagedPolicy', Properties: {} };
  assert.deepEqual(auditTags(t, contract).map((x) => [x.code, x.where]), [['FORBIDDEN_TYPE', 'Pol']]);
  assert.ok(!('AWS::IAM::ManagedPolicy' in contract.exceptionTypes));
});

test('a resource without a Type fails as unclassified', () => {
  const t = fresh();
  t.Resources.Odd = { Properties: {} };
  assert.deepEqual(codes(auditTags(t, contract)), ['UNCLASSIFIED_TYPE']);
});

test('ACM and Route 53 types fail as forbidden (FR-08)', () => {
  const t = fresh();
  t.Resources.Cert = { Type: 'AWS::CertificateManager::Certificate', Properties: {} };
  t.Resources.Zone = { Type: 'AWS::Route53::HostedZone', Properties: {} };
  t.Resources.Rec = { Type: 'AWS::Route53::RecordSet', Properties: {} };
  assert.deepEqual(auditTags(t, contract).map((x) => [x.code, x.where]).sort(), [['FORBIDDEN_TYPE', 'Cert'], ['FORBIDDEN_TYPE', 'Rec'], ['FORBIDDEN_TYPE', 'Zone']]);
});

test('red run: a template with all Tags removed lists every taggable resource', () => {
  const t = fresh();
  for (const res of Object.values(t.Resources)) {
    if (res.Properties) { delete res.Properties.Tags; delete res.Properties.ResourceTags; }
  }
  const found = auditTags(t, contract);
  assert.ok(found.every((x) => x.code === 'MISSING_TAG'));
  assert.deepEqual(found.map((x) => x.where).sort(), [...TAGGABLE_IDS].sort());
});

test('red run through the CLI: a tmp copy with every tag list removed exits 1 and names all six', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-infra-'));
  try {
    const text = read('infra/template.yaml').replace(/^( *)(Tags|ResourceTags):\r?\n(?:\1 {2}- Key: .*\r?\n\1 {4}Value: .*\r?\n)+/gm, '');
    assert.notEqual(text, read('infra/template.yaml'), 'the mutation must change the copy');
    const file = path.join(dir, 'template.yaml');
    fs.writeFileSync(file, text);
    const r = spawnSync(process.execPath, ['scripts/audit-infra.mjs', '--template', file], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout);
    for (const id of TAGGABLE_IDS) assert.match(r.stdout, new RegExp(`\\[MISSING_TAG\\] ${id}:`));
    assert.match(r.stdout, /audit-infra: FAIL \(6 violation/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- samconfig.toml ----------------------------------------------------------------------------
test('samconfig: dropping Environment from [prod] fails; so does a wrong value or a missing section', () => {
  const real = read('infra/samconfig.toml');
  const noEnv = real.replace('tags = "Project=results-dashboard Environment=prod"', 'tags = "Project=results-dashboard"');
  assert.notEqual(noEnv, real);
  const a = auditSamconfig(noEnv, contract);
  assert.deepEqual(a.map((x) => x.code), ['SAMCONFIG_TAG']);
  assert.match(a[0].where, /\[prod\.deploy\.parameters\]/);
  assert.match(a[0].message, /Environment/);
  const wrong = real.replace('Project=results-dashboard Environment=test', 'Project=results-dashboard Environment=prod');
  assert.match(auditSamconfig(wrong, contract)[0].where, /\[test\./);
  assert.match(auditSamconfig(real.replace('[prod.deploy.parameters]', '[prd.deploy.parameters]'), contract)[0].message, /section missing|no tags/);
  assert.match(auditSamconfig(real.replace('Project=results-dashboard Environment=test', 'Environment=test'), contract)[0].message, /Project/);
});

// ---- IAM wildcards ----------------------------------------------------------------------------
const policy = (...statements) => ({ Version: '2012-10-17', Statement: statements });

test('Allow wildcards fail: "*", s3:*, cloudfront:*, any service:*, NotAction', () => {
  for (const action of ['*', 's3:*', 'cloudfront:*', 'iam:*']) {
    const f = auditPolicyDocument(policy({ Effect: 'Allow', Action: action, Resource: 'arn:aws:s3:::b' }), 'p.json', contract);
    assert.deepEqual(codes(f), ['IAM_WILDCARD_ACTION'], action);
  }
  const list = auditPolicyDocument(policy({ Effect: 'Allow', Action: ['s3:GetObject', 'cloudfront:*'], Resource: 'arn:x' }), 'p.json', contract);
  assert.deepEqual(codes(list), ['IAM_WILDCARD_ACTION']);
  assert.deepEqual(codes(auditPolicyDocument(policy({ Effect: 'Allow', NotAction: 's3:DeleteBucket', Resource: 'arn:x' }), 'p.json', contract)), ['IAM_NOTACTION']);
});

test('a Deny s3:* (TLS deny, FR-04) passes; the same statement with Allow fails', () => {
  const deny = { Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: ['arn:aws:s3:::b', 'arn:aws:s3:::b/*'], Condition: { Bool: { 'aws:SecureTransport': 'false' } } };
  assert.deepEqual(auditPolicyDocument(policy(deny), 'p.json', contract), []);
  assert.deepEqual(codes(auditPolicyDocument(policy({ ...deny, Effect: 'Allow' }), 'p.json', contract)), ['IAM_WILDCARD_ACTION']);
  assert.deepEqual(codes(auditPolicyDocument(policy({ ...deny, Effect: { Ref: 'X' } }), 'p.json', contract)), ['IAM_WILDCARD_ACTION'], 'a non-literal Effect is treated as Allow');
});

test('Allow with Resource "*" fails unless allowlisted by source and Sid with a reason', () => {
  const st = { Sid: 'Wide', Effect: 'Allow', Action: 'sts:GetCallerIdentity', Resource: '*' };
  assert.deepEqual(codes(auditPolicyDocument(policy(st), 'p.json', contract)), ['IAM_WILDCARD_RESOURCE']);
  const allow = { ...contract, iamResourceWildcardAllowlist: [{ source: 'p.json', sid: 'Wide', reason: 'service needs *' }] };
  assert.deepEqual(auditPolicyDocument(policy(st), 'p.json', allow), []);
  assert.deepEqual(codes(auditPolicyDocument(policy(st), 'other.json', allow)), ['IAM_WILDCARD_RESOURCE']);
  assert.deepEqual(codes(auditPolicyDocument(policy({ ...st, Resource: { 'Fn::Sub': '*' } }), 'p.json', contract)), ['IAM_WILDCARD_RESOURCE']);
});

test('Allow of *:*, route53domains and acm-pca writes fails; their read actions pass', () => {
  const f = auditPolicyDocument(policy({ Effect: 'Allow', Action: ['*:*', 'route53domains:RegisterDomain', 'acm-pca:IssueCertificate', 'route53domains:ListDomains', 'acm-pca:DescribeCertificateAuthority'], Resource: 'arn:x' }), 'p.json', contract);
  assert.deepEqual(f.map((x) => x.code).sort(), ['IAM_FORBIDDEN_WRITE', 'IAM_FORBIDDEN_WRITE', 'IAM_WILDCARD_ACTION']);
});

test('reference URLs in tagging.json are flagged UNVERIFIED', () => {
  for (const e of [...Object.values(contract.taggableTypes), ...Object.values(contract.exceptionTypes)]) {
    assert.match(e.referenceStatus, /^UNVERIFIED — confirm at source before relying on it/);
  }
});

test('Allow of ACM or Route 53 write actions fails; read actions pass (FR-10)', () => {
  const f = auditPolicyDocument(policy({ Effect: 'Allow', Action: ['acm:RequestCertificate', 'route53:ChangeResourceRecordSets', 'acm:DescribeCertificate', 'acm:ListCertificates'], Resource: 'arn:x' }), 'p.json', contract);
  assert.deepEqual(f.map((x) => x.message.match(/Allow of ([a-z0-9:A-Z]+):/)[1]).sort(), ['acm:RequestCertificate', 'route53:ChangeResourceRecordSets']);
  assert.ok(f.every((x) => x.code === 'IAM_FORBIDDEN_WRITE'));
});

test('adding cloudfront:* to the real PublisherRole policy fails with a named code', () => {
  const t = fresh();
  t.Resources.PublisherRole.Properties.Policies[0].PolicyDocument.Statement.push({ Effect: 'Allow', Action: 'cloudfront:*', Resource: 'arn:x' });
  const found = auditTemplate(t, contract);
  assert.deepEqual(found.map((x) => [x.code, x.where]), [['IAM_WILDCARD_ACTION', 'template.yaml']]);
  assert.match(found[0].message, /cloudfront:\*/);
});

test('the real template grants no wildcard and still contains its Deny s3:* statements', () => {
  const text = read('infra/template.yaml');
  assert.ok((text.match(/Effect: Deny/g) ?? []).length >= 2 && /Action: 's3:\*'/.test(text), 'the Deny statements the audit must tolerate are present');
  assert.deepEqual(auditPolicyDocument(fresh(), 'template.yaml', contract), []);
});

test('the CLI audits an extra --policy file (the T-05 seam)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-infra-'));
  try {
    const file = path.join(dir, 'p.json');
    fs.writeFileSync(file, JSON.stringify(policy({ Effect: 'Allow', Action: 's3:*', Resource: '*' })));
    const r = spawnSync(process.execPath, ['scripts/audit-infra.mjs', '--policy', file], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /\[IAM_WILDCARD_ACTION\]/);
    assert.match(r.stdout, /\[IAM_WILDCARD_RESOURCE\]/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
