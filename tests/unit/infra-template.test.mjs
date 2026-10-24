// T-03: the generated stack template (infra/template.yaml), its parameter files and samconfig.toml
// (FR-01..FR-05, FR-07..FR-09, FR-11, NFR-02, NFR-09; design 5.1, 5.3, 6, 7.1, 7.6).
// The template is parsed with the `yaml` package (CloudFormation short-form tags become plain
// objects) and evaluated offline: conditions, Fn::If and the DD-09 rule are resolved against the
// real parameter files, so the assertions are about the rendered stack, not about type names.
// Real CloudFormation acceptance is `NOT RUN - AWS`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { SECURITY_HEADERS } from '../../scripts/serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');

// ---- CloudFormation short-form tags -> long form -------------------------------------------
const tagPair = (name, key) => [
  { tag: '!' + name, resolve: (s) => ({ [key]: s }) },
  { tag: '!' + name, collection: 'seq', resolve: (seq) => ({ [key]: seq.toJSON() }) },
];
const CFN_TAGS = [
  ['Ref', 'Ref'], ['Sub', 'Fn::Sub'], ['GetAtt', 'Fn::GetAtt'], ['If', 'Fn::If'], ['Equals', 'Fn::Equals'],
  ['Not', 'Fn::Not'], ['And', 'Fn::And'], ['Or', 'Fn::Or'], ['Join', 'Fn::Join'], ['Select', 'Fn::Select'],
  ['FindInMap', 'Fn::FindInMap'], ['Condition', 'Condition'],
].flatMap(([n, k]) => tagPair(n, k));

const parseTemplate = (text) => parse(text, { customTags: CFN_TAGS });
const templateText = () => read('infra/template.yaml');
const T = () => {
  const t = parseTemplate(templateText());
  assert.ok(t && typeof t === 'object' && t.Resources && t.Parameters, 'infra/template.yaml defines Parameters and Resources');
  return t;
};

// ---- offline evaluator (conditions, Fn::If, rules) -------------------------------------------
const NOVALUE = Symbol('NoValue');

function paramsFor(t, overrides = {}) {
  const out = {};
  for (const [name, def] of Object.entries(t.Parameters ?? {})) {
    out[name] = String(name in overrides ? overrides[name] : def.Default ?? '');
  }
  return out;
}

function makeEval(t, params) {
  const value = (v) => {
    if (v && typeof v === 'object' && 'Ref' in v) {
      if (!(v.Ref in params)) throw new Error(`unsupported Ref ${v.Ref} in a condition`);
      return params[v.Ref];
    }
    return String(v);
  };
  const cond = (c) => {
    if ('Condition' in c) return cond(t.Conditions[c.Condition]);
    if ('Fn::Equals' in c) return value(c['Fn::Equals'][0]) === value(c['Fn::Equals'][1]);
    if ('Fn::And' in c) return c['Fn::And'].every(cond);
    if ('Fn::Or' in c) return c['Fn::Or'].some(cond);
    if ('Fn::Not' in c) return !cond(c['Fn::Not'][0]);
    throw new Error('unsupported condition ' + JSON.stringify(c));
  };
  const render = (node) => {
    if (Array.isArray(node)) return node.map(render).filter((x) => x !== NOVALUE);
    if (node && typeof node === 'object') {
      const keys = Object.keys(node);
      if (keys.length === 1 && keys[0] === 'Fn::If') {
        const [name, a, b] = node['Fn::If'];
        return render(cond({ Condition: name }) ? a : b);
      }
      if (keys.length === 1 && keys[0] === 'Ref') {
        if (node.Ref === 'AWS::NoValue') return NOVALUE;
        if (node.Ref in params) return params[node.Ref];
        return node;
      }
      if (keys.length === 1 && keys[0] === 'Fn::Sub' && typeof node['Fn::Sub'] === 'string') {
        // Only parameter variables are resolved; resource variables keep the Fn::Sub form.
        const s = node['Fn::Sub'].replace(/\$\{([A-Za-z0-9]+)\}/g, (m, n) => (n in params ? params[n] : m));
        return s.includes('${') ? { 'Fn::Sub': s } : s;
      }
      const out = {};
      for (const k of keys) {
        const v = render(node[k]);
        if (v !== NOVALUE) out[k] = v;
      }
      return out;
    }
    return node;
  };
  return { cond, render };
}

// The stack as CloudFormation would see it for these parameter values (inactive resources and
// outputs removed). Throws when a rule assertion fails, like stack validation would.
function renderStack(t, overrides = {}) {
  const params = paramsFor(t, overrides);
  const ev = makeEval(t, params);
  for (const [name, rule] of Object.entries(t.Rules ?? {})) {
    for (const a of rule.Assertions) {
      if (!ev.cond(a.Assert)) throw new Error(`rule ${name}: ${a.AssertDescription}`);
    }
  }
  const pick = (section) => {
    const out = {};
    for (const [id, def] of Object.entries(t[section] ?? {})) {
      if (def.Condition !== undefined && !ev.cond({ Condition: def.Condition })) continue;
      const { Condition, ...rest } = def;
      out[id] = ev.render(rest);
    }
    return out;
  };
  return { params, Resources: pick('Resources'), Outputs: pick('Outputs') };
}

const paramFile = (env) => Object.fromEntries(JSON.parse(read(`infra/params/${env}.json`)).map((p) => [p.ParameterKey, p.ParameterValue]));
const resourcesOfType = (res, type) => Object.entries(res).filter(([, r]) => r.Type === type);
const only = (res, type) => {
  const found = resourcesOfType(res, type);
  assert.equal(found.length, 1, `expected exactly one ${type}, found ${found.length}`);
  return found[0][1];
};
const statements = (doc) => (Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement]);
const asList = (v) => (Array.isArray(v) ? v : [v]);

// ---- samconfig.toml: the subset used here ([env.deploy.parameters] tables of string/bool keys) --
function parseSamconfig(text) {
  const cfg = {};
  let table = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const head = /^\[([^\]]+)\]$/.exec(line);
    if (head) { table = cfg[head[1]] = {}; continue; }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    assert.ok(kv, `unparseable samconfig line: ${line}`);
    const v = kv[2].trim();
    const value = v === 'true' ? true : v === 'false' ? false : /^".*"$/.test(v) ? v.slice(1, -1) : Number(v);
    (table ?? cfg)[kv[1]] = value;
  }
  return cfg;
}
const pairs = (s) => Object.fromEntries(s.split(' ').filter(Boolean).map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));

// ======================================================================================
// FR-01 one template, two environments
// ======================================================================================
test('FR-01: one template defines the whole stack; resources are not duplicated per environment', () => {
  const t = T();
  const ids = Object.keys(t.Resources);
  assert.ok(ids.includes('SiteBucket'), 'SiteBucket is defined');
  assert.ok(!ids.some((id) => /test|prod/i.test(id)), `no per-environment logical IDs: ${ids.join(', ')}`);
  assert.deepEqual(t.Parameters.Environment.AllowedValues, ['test', 'prod']);
});

test('FR-01: both parameter files and samconfig use the same template and differ only in values', () => {
  const t = T();
  const names = Object.keys(t.Parameters);
  const sam = parseSamconfig(read('infra/samconfig.toml'));
  for (const env of ['test', 'prod']) {
    const file = paramFile(env);
    for (const k of Object.keys(file)) assert.ok(names.includes(k), `${env}.json has unknown parameter ${k}`);
    assert.equal(file.Environment, env);
    const table = sam[`${env}.deploy.parameters`];
    assert.ok(table, `[${env}.deploy.parameters] exists`);
    // Empty values are left to the template defaults (also empty), so overrides carry the rest.
    const expected = Object.fromEntries(Object.entries(file).filter(([, v]) => v !== ''));
    assert.deepEqual(pairs(table.parameter_overrides), expected, `${env}: samconfig overrides equal the parameter file`);
    // Rendering must succeed (rules pass) and use the same resource set shape.
    renderStack(t, file);
  }
  // Same switches (budget on) -> same resource set: environments differ only in parameter values.
  const on = { BudgetLimitUsd: '10' };
  const a = Object.keys(renderStack(t, { ...paramFile('test'), ...on }).Resources).sort();
  const b = Object.keys(renderStack(t, { ...paramFile('prod'), ...on }).Resources).sort();
  assert.deepEqual(a, b, 'same resources for test and prod parameter files');
});

test('FR-01: offline validation, every Ref, GetAtt, Sub variable, condition and DependsOn resolves', () => {
  const t = T();
  const params = new Set(Object.keys(t.Parameters));
  const resources = new Set(Object.keys(t.Resources));
  const conditions = new Set(Object.keys(t.Conditions ?? {}));
  const problems = [];
  const known = (n) => params.has(n) || resources.has(n) || n.startsWith('AWS::');
  const walk = (node, where) => {
    if (Array.isArray(node)) return node.forEach((x, i) => walk(x, `${where}[${i}]`));
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'Ref' && typeof v === 'string' && !known(v)) problems.push(`${where}: Ref ${v}`);
      if (k === 'Fn::GetAtt') {
        const id = (Array.isArray(v) ? v[0] : String(v).split('.')[0]);
        if (!resources.has(id)) problems.push(`${where}: GetAtt ${id}`);
      }
      if (k === 'Fn::If' && !conditions.has(v[0])) problems.push(`${where}: Fn::If condition ${v[0]}`);
      if (k === 'Condition' && typeof v === 'string' && !conditions.has(v)) problems.push(`${where}: Condition ${v}`);
      if (k === 'DependsOn') for (const d of asList(v)) if (!resources.has(d)) problems.push(`${where}: DependsOn ${d}`);
      if (k === 'Fn::Sub') {
        const s = typeof v === 'string' ? v : v[0];
        for (const m of s.matchAll(/\$\{([^}!]+)\}/g)) if (!known(m[1].split('.')[0])) problems.push(`${where}: Sub variable ${m[1]}`);
      }
      walk(v, `${where}.${k}`);
    }
  };
  walk({ Resources: t.Resources, Outputs: t.Outputs, Conditions: t.Conditions }, '$');
  assert.deepEqual(problems, []);
});

// ======================================================================================
// FR-02 / FR-08 / NFR-09: default certificate unless HasCustomDomain
// ======================================================================================
test('FR-02: HasCustomDomain is true only when both the alternate domain and the certificate are set', () => {
  const t = T();
  const flag = (o) => makeEval(t, paramsFor(t, o)).cond({ Condition: 'HasCustomDomain' });
  assert.equal(flag({}), false);
  assert.equal(flag({ AlternateDomainName: 'a.example.org' }), false);
  assert.equal(flag({ CertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/abc' }), false);
  assert.equal(flag({ AlternateDomainName: 'a.example.org', CertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/abc' }), true);
});

test('FR-02 / NFR-09: with empty domain parameters the distribution uses the default certificate and no aliases', () => {
  const t = T();
  for (const env of ['test', 'prod']) {
    const { Resources } = renderStack(t, paramFile(env));
    const cfg = only(Resources, 'AWS::CloudFront::Distribution').Properties.DistributionConfig;
    // P-26: only CloudFrontDefaultCertificate is set; the doc says to leave all other fields empty.
    assert.deepEqual(cfg.ViewerCertificate, { CloudFrontDefaultCertificate: true }, env);
    assert.equal('Aliases' in cfg, false, `${env}: no Aliases`);
    assert.deepEqual(resourcesOfType(Resources, 'AWS::CertificateManager::Certificate'), []);
  }
});

test('FR-08: with domain parameters set the distribution serves the alias with the ACM certificate and TLSv1.2_2021', () => {
  const t = T();
  const arn = 'arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555';
  const { Resources } = renderStack(t, { AlternateDomainName: 'results-test.example.org', CertificateArn: arn, CanonicalHost: 'results-test.example.org' });
  const cfg = only(Resources, 'AWS::CloudFront::Distribution').Properties.DistributionConfig;
  assert.deepEqual(cfg.Aliases, ['results-test.example.org']);
  assert.deepEqual(cfg.ViewerCertificate, { AcmCertificateArn: arn, SslSupportMethod: 'sni-only', MinimumProtocolVersion: 'TLSv1.2_2021' });
  assert.equal('CloudFrontDefaultCertificate' in cfg.ViewerCertificate, false, 'default certificate and aliases are never combined');
});

test('FR-08: the stack never creates certificates, DNS records or zones', () => {
  const t = T();
  const types = Object.values(t.Resources).map((r) => r.Type);
  assert.deepEqual(types.filter((x) => /^AWS::(CertificateManager|Route53|Route53Resolver|Route53Domains)::/.test(x)), []);
  assert.ok(!/AWS::(CertificateManager|Route53)::/.test(templateText().replace(/^\s*#.*$/gm, '')), 'not even outside Resources');
});

test('DD-09: the template rules reject a half-configured domain and a canonical host that is not the alias', () => {
  const t = T();
  assert.ok(Object.keys(t.Rules ?? {}).length >= 1, 'Rules section exists');
  const arn = 'arn:aws:acm:us-east-1:123456789012:certificate/abc-123';
  const ok = (o) => { renderStack(t, o); };
  const bad = (o, what) => assert.throws(() => renderStack(t, o), /rule/, what);
  ok({});
  ok({ AlternateDomainName: 'a.example.org', CertificateArn: arn });
  ok({ AlternateDomainName: 'a.example.org', CertificateArn: arn, CanonicalHost: 'a.example.org' });
  bad({ AlternateDomainName: 'a.example.org' }, 'domain without certificate');
  bad({ CertificateArn: arn }, 'certificate without domain');
  bad({ CanonicalHost: 'a.example.org' }, 'canonical host without a custom domain');
  bad({ AlternateDomainName: 'a.example.org', CertificateArn: arn, CanonicalHost: 'b.example.org' }, 'canonical host differs from the alias');
});

// ---- parameter types (injection-safe hostnames, P-forward-pointer from T-02) ----
const patternOf = (t, name) => new RegExp(`^(?:${t.Parameters[name].AllowedPattern})$`);
test('FR-06: CanonicalHost and AlternateDomainName accept only empty or a hostname of at most 253 characters', () => {
  const t = T();
  for (const name of ['CanonicalHost', 'AlternateDomainName']) {
    const p = t.Parameters[name];
    assert.equal(p.Default, '', `${name} defaults to empty`);
    assert.ok(p.AllowedPattern, `${name} has an AllowedPattern`);
    assert.equal(p.MaxLength, 253);
    const re = patternOf(t, name);
    const accepted = ['', 'results.cgiar.org', 'results-test.cgiar.org', 'a', 'x'.repeat(63) + '.' + 'y'.repeat(63)];
    for (const v of accepted) assert.ok(re.test(v), `${name} accepts ${JSON.stringify(v)}`);
    const rejected = ["a';alert(1);//", 'a\\b', 'a\nb', '${Other}', 'a b', 'a"b', 'a$b', 'a/b', 'a:443', "'", '‮.com'];
    for (const v of rejected) assert.ok(!re.test(v), `${name} rejects ${JSON.stringify(v)}`);
  }
});

test('FR-02: parameter definitions follow design 5.1', () => {
  const t = T();
  const P = t.Parameters;
  assert.deepEqual(P.PriceClass.AllowedValues, ['PriceClass_100', 'PriceClass_200', 'PriceClass_All']);
  assert.deepEqual(P.EnableAccessLogs.AllowedValues, ['true', 'false']);
  assert.deepEqual(P.Indexing.AllowedValues, ['allow', 'deny']);
  assert.equal(P.Indexing.Default, 'deny', 'safe default: do not index');
  assert.equal(P.LogRetentionDays.Type, 'Number');
  assert.equal(P.BudgetLimitUsd.Type, 'Number');
  assert.equal(P.BudgetEmail.Default, '');
  assert.equal(P.PublisherPrincipalArn.Default, '');
  assert.equal(P.CertificateArn.Default, '');
  assert.ok(patternOf(t, 'CertificateArn').test('arn:aws:acm:us-east-1:123456789012:certificate/abc-1'));
  assert.ok(!patternOf(t, 'CertificateArn').test('arn:aws:acm:eu-west-1:123456789012:certificate/abc-1'), 'ACM certificate must be in us-east-1 (P-10)');
  assert.ok(patternOf(t, 'CertificateArn').test(''));
  assert.ok(patternOf(t, 'BudgetEmail').test('') && patternOf(t, 'BudgetEmail').test('someone@example.org') && !patternOf(t, 'BudgetEmail').test('not an email'));
  assert.ok(patternOf(t, 'PublisherPrincipalArn').test('arn:aws:iam::123456789012:role/x') && !patternOf(t, 'PublisherPrincipalArn').test('arn:aws:iam::123456789012:root') && patternOf(t, 'PublisherPrincipalArn').test(''));
});

test('FR-02: parameter files hold no secrets, credentials, e-mail addresses, account IDs or domains', () => {
  for (const env of ['test', 'prod']) {
    const raw = read(`infra/params/${env}.json`);
    const file = paramFile(env);
    assert.equal('BudgetEmail' in file, false, 'BudgetEmail is given at deploy time, never committed');
    for (const k of ['AlternateDomainName', 'CertificateArn', 'CanonicalHost']) assert.ok(!(k in file) || file[k] === '', `${env}: ${k} is empty`);
    assert.ok(!/@/.test(raw), 'no e-mail address');
    assert.ok(!/\b\d{12}\b/.test(raw), 'no account ID');
    assert.ok(!/arn:/.test(raw), 'no ARN');
    assert.ok(!/AKIA|secret|password|token/i.test(raw), 'no credential words');
  }
  assert.equal(paramFile('test').Indexing, 'deny');
  assert.equal(paramFile('prod').Indexing, 'allow');
  assert.equal(paramFile('test').LogRetentionDays, '30');
  assert.equal(paramFile('prod').LogRetentionDays, '90');
});

// ======================================================================================
// FR-04 private origin bucket
// ======================================================================================
test('FR-04: the site bucket is private, encrypted, versioned, owner-enforced and retained', () => {
  const t = T();
  const raw = t.Resources.SiteBucket;
  assert.equal(raw.Type, 'AWS::S3::Bucket');
  assert.equal(raw.DeletionPolicy, 'Retain');
  assert.equal(raw.UpdateReplacePolicy, 'Retain');
  const p = raw.Properties;
  assert.deepEqual(p.PublicAccessBlockConfiguration, { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
  assert.deepEqual(p.OwnershipControls.Rules, [{ ObjectOwnership: 'BucketOwnerEnforced' }]);
  assert.equal(p.VersioningConfiguration.Status, 'Enabled');
  const enc = p.BucketEncryption.ServerSideEncryptionConfiguration;
  assert.equal(enc.length, 1);
  assert.equal(enc[0].ServerSideEncryptionByDefault.SSEAlgorithm, 'AES256');
  const lc = p.LifecycleConfiguration.Rules.find((r) => r.NoncurrentVersionExpiration);
  assert.equal(lc.Status, 'Enabled');
  assert.equal(lc.NoncurrentVersionExpiration.NoncurrentDays, 90);
  assert.ok(!('AccessControl' in p) && !('WebsiteConfiguration' in p), 'no ACL, no website endpoint');
});

test('FR-04: the bucket policy grants only s3:GetObject to this distribution and denies non-TLS requests', () => {
  const t = T();
  const doc = t.Resources.SiteBucketPolicy.Properties.PolicyDocument;
  assert.equal(t.Resources.SiteBucketPolicy.Properties.Bucket.Ref, 'SiteBucket');
  const st = statements(doc);
  const allows = st.filter((s) => s.Effect === 'Allow');
  assert.equal(allows.length, 1, 'exactly one Allow statement');
  assert.deepEqual(asList(allows[0].Action), ['s3:GetObject']);
  assert.deepEqual(allows[0].Principal, { Service: 'cloudfront.amazonaws.com' });
  assert.deepEqual(allows[0].Resource, { 'Fn::Sub': '${SiteBucket.Arn}/*' });
  assert.deepEqual(allows[0].Condition, { StringEquals: { 'AWS:SourceArn': { 'Fn::Sub': 'arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/${Distribution}' } } });
  const denies = st.filter((s) => s.Effect === 'Deny');
  assert.equal(denies.length, 1);
  assert.deepEqual(denies[0].Condition, { Bool: { 'aws:SecureTransport': 'false' } });
  assert.ok(['*', { AWS: '*' }].some((x) => JSON.stringify(x) === JSON.stringify(denies[0].Principal)));
  assert.equal(st.length, 2);
  assert.ok(!/ListBucket/i.test(JSON.stringify(doc)), 'no s3:ListBucket (DD-08): missing keys give 403');
});

// ======================================================================================
// FR-05 distribution
// ======================================================================================
const distCfg = (env = 'test') => only(renderStack(T(), paramFile(env)).Resources, 'AWS::CloudFront::Distribution').Properties.DistributionConfig;
const CACHING_OPTIMIZED = '658327ea-f89d-4fab-a63d-7e88639e58f6';

test('FR-05: origin is the S3 REST endpoint behind OAC, never the website endpoint', () => {
  const t = T();
  const cfg = distCfg();
  assert.equal(cfg.Origins.length, 1);
  const o = cfg.Origins[0];
  assert.deepEqual(o.DomainName, { 'Fn::GetAtt': 'SiteBucket.RegionalDomainName' });
  assert.deepEqual(o.OriginAccessControlId, { 'Fn::GetAtt': 'OriginAccessControl.Id' });
  assert.deepEqual(o.S3OriginConfig, { OriginAccessIdentity: '' });
  assert.equal('CustomOriginConfig' in o, false);
  assert.deepEqual(t.Resources.OriginAccessControl.Properties.OriginAccessControlConfig.SigningBehavior, 'always');
  const oac = t.Resources.OriginAccessControl.Properties.OriginAccessControlConfig;
  assert.equal(oac.SigningProtocol, 'sigv4');
  assert.equal(oac.OriginAccessControlOriginType, 's3');
});

test('FR-05: protocols, edge function, caching and query strings of the default behavior', () => {
  const t = T();
  const cfg = distCfg();
  assert.equal(cfg.Enabled, true);
  assert.equal(cfg.HttpVersion, 'http2and3');
  assert.equal(cfg.IPV6Enabled, true);
  assert.deepEqual(cfg.PriceClass, 'PriceClass_100');
  const d = cfg.DefaultCacheBehavior;
  assert.equal(d.ViewerProtocolPolicy, 'redirect-to-https');
  assert.deepEqual(d.AllowedMethods, ['GET', 'HEAD']);
  assert.equal(d.Compress, true);
  assert.deepEqual(d.CachePolicyId, { Ref: 'HtmlCachePolicy' });
  assert.deepEqual(d.FunctionAssociations, [{ EventType: 'viewer-request', FunctionARN: { 'Fn::GetAtt': 'EdgeFunction.FunctionARN' } }]);
  assert.ok(d.ResponseHeadersPolicyId, 'headers policy attached');
  const c = t.Resources.HtmlCachePolicy.Properties.CachePolicyConfig;
  assert.equal(c.MinTTL, 0);
  assert.equal(c.DefaultTTL, 300);
  assert.equal(c.MaxTTL, 3600);
  const k = c.ParametersInCacheKeyAndForwardedToOrigin;
  assert.deepEqual(k.QueryStringsConfig, { QueryStringBehavior: 'none' });
  assert.deepEqual(k.CookiesConfig, { CookieBehavior: 'none' });
  assert.deepEqual(k.HeadersConfig, { HeaderBehavior: 'none' });
  assert.equal(k.EnableAcceptEncodingGzip, true);
  assert.equal(k.EnableAcceptEncodingBrotli, true);
});

test('FR-05: asset behaviors use CachingOptimized, /widget/* uses the short-TTL policy, all with the edge function', () => {
  const cfg = distCfg();
  const byPath = Object.fromEntries(cfg.CacheBehaviors.map((b) => [b.PathPattern, b]));
  assert.deepEqual(Object.keys(byPath).sort(), ['/css/*', '/csv/*', '/fonts/*', '/images/*', '/js/*', '/third-party/*', '/widget/*']);
  for (const [p, b] of Object.entries(byPath)) {
    assert.equal(b.ViewerProtocolPolicy, 'redirect-to-https', p);
    assert.deepEqual(b.AllowedMethods, ['GET', 'HEAD'], p);
    assert.equal(b.Compress, true, p);
    assert.equal(b.TargetOriginId, cfg.DefaultCacheBehavior.TargetOriginId, p);
    assert.deepEqual(b.FunctionAssociations, cfg.DefaultCacheBehavior.FunctionAssociations, p);
    assert.deepEqual(b.ResponseHeadersPolicyId, cfg.DefaultCacheBehavior.ResponseHeadersPolicyId, p);
    if (p === '/widget/*') assert.deepEqual(b.CachePolicyId, { Ref: 'HtmlCachePolicy' });
    else assert.equal(b.CachePolicyId, CACHING_OPTIMIZED, p);
  }
});

test('FR-05: 403 and 404 from the origin serve /404.html with status 404', () => {
  const cfg = distCfg();
  const errs = Object.fromEntries(cfg.CustomErrorResponses.map((e) => [e.ErrorCode, e]));
  assert.deepEqual(Object.keys(errs).sort(), ['403', '404']);
  for (const e of Object.values(errs)) {
    assert.equal(e.ResponsePagePath, '/404.html');
    assert.equal(e.ResponseCode, 404);
    assert.equal(e.ErrorCachingMinTTL, 10);
  }
});

// ======================================================================================
// FR-07 response headers
// ======================================================================================
const headersPolicy = (overrides = {}) => only(renderStack(T(), { ...paramFile('test'), ...overrides }).Resources, 'AWS::CloudFront::ResponseHeadersPolicy').Properties.ResponseHeadersPolicyConfig;

test('FR-07: HSTS without subdomains or preload, nosniff, referrer policy, report-only CSP equal to the local emulation', () => {
  const c = headersPolicy();
  assert.deepEqual(c.SecurityHeadersConfig.StrictTransportSecurity, { AccessControlMaxAgeSec: 31536000, IncludeSubdomains: false, Preload: false, Override: true });
  assert.deepEqual(c.SecurityHeadersConfig.ContentTypeOptions, { Override: true });
  assert.deepEqual(c.SecurityHeadersConfig.ReferrerPolicy, { ReferrerPolicy: 'strict-origin-when-cross-origin', Override: true });
  const items = Object.fromEntries(c.CustomHeadersConfig.Items.map((i) => [i.Header, i]));
  assert.equal(items['Content-Security-Policy-Report-Only'].Value, SECURITY_HEADERS['Content-Security-Policy-Report-Only']);
  assert.ok(!('Content-Security-Policy' in items), 'report-only, never enforcing');
});

test('FR-07: no X-Frame-Options anywhere; X-Robots-Tag only when Indexing is deny', () => {
  const text = templateText().replace(/^\s*#.*$/gm, '');
  assert.ok(!/x-frame-options|FrameOptions/i.test(text));
  const names = (o) => (headersPolicy(o).CustomHeadersConfig.Items.map((i) => i.Header));
  assert.ok(names({ Indexing: 'deny' }).includes('X-Robots-Tag'));
  assert.ok(!names({ Indexing: 'allow' }).includes('X-Robots-Tag'));
  const robots = headersPolicy({ Indexing: 'deny' }).CustomHeadersConfig.Items.find((i) => i.Header === 'X-Robots-Tag');
  assert.equal(robots.Value, 'noindex, nofollow');
  assert.equal(robots.Override, true);
  assert.ok(!('FrameOptions' in headersPolicy().SecurityHeadersConfig));
  // test deploys deny indexing, prod allows it (design 5.1)
  assert.ok(headersPolicy(paramFile('test')).CustomHeadersConfig.Items.some((i) => i.Header === 'X-Robots-Tag'));
  assert.ok(!headersPolicy(paramFile('prod')).CustomHeadersConfig.Items.some((i) => i.Header === 'X-Robots-Tag'));
});

// ======================================================================================
// FR-06 / design 7.2 edge function
// ======================================================================================
test('FR-06: the edge function is cloudfront-js-2.0, auto-published, and substitutes only CanonicalHost', () => {
  const t = T();
  const f = t.Resources.EdgeFunction.Properties;
  assert.equal(f.AutoPublish, true);
  assert.equal(f.FunctionConfig.Runtime, 'cloudfront-js-2.0');
  assert.ok(typeof f.FunctionConfig.Comment === 'string' && f.FunctionConfig.Comment.length > 0 && f.FunctionConfig.Comment.length <= 128);
  const code = f.FunctionCode['Fn::Sub'];
  assert.equal(typeof code, 'string', 'FunctionCode is a plain Fn::Sub string');
  const vars = [...code.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
  assert.deepEqual(vars, ['CanonicalHost']);
  assert.ok(code.includes("var RD_CANONICAL_HOST = '${CanonicalHost}';"));
  assert.ok(!code.includes('__RD_'), 'no placeholder left');
});

test('NFR-04: the substituted edge code stays within 10 000 bytes for the longest allowed host', () => {
  const code = T().Resources.EdgeFunction.Properties.FunctionCode['Fn::Sub'];
  const bytes = Buffer.byteLength(code.split('${CanonicalHost}').join('h'.repeat(253)), 'utf8');
  assert.ok(bytes <= 10000, `${bytes} bytes`);
});

test('FR-01 (DD-11): regenerating the template gives identical bytes (not stale), within the direct-upload limit', async () => {
  const { buildTemplate } = await import('../../scripts/build-infra.mjs');
  const fresh = buildTemplate();
  assert.equal(fresh, templateText(), 'infra/template.yaml is stale or was edited by hand: run npm run build:infra');
  assert.equal(buildTemplate(), fresh, 'two builds give the same bytes (NFR-02)');
  // P-22: the CloudFormation direct template-body limit is 51,200 bytes.
  assert.ok(Buffer.byteLength(fresh, 'utf8') < 51200, `${Buffer.byteLength(fresh, 'utf8')} bytes`);
});

// ======================================================================================
// FR-09 outputs
// ======================================================================================
test('FR-09: all design 6 outputs exist and resolve to the right values', () => {
  const t = T();
  assert.deepEqual(Object.keys(t.Outputs).sort(), ['AlternateDomainName', 'CanonicalHost', 'DistributionArn', 'DistributionDomainName', 'DistributionId', 'DistributionUrl', 'PublisherRoleArn', 'SiteBucketName']);
  const o = (n) => t.Outputs[n].Value;
  assert.deepEqual(o('DistributionId'), { Ref: 'Distribution' });
  assert.deepEqual(o('DistributionArn'), { 'Fn::Sub': 'arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/${Distribution}' });
  assert.deepEqual(o('DistributionDomainName'), { 'Fn::GetAtt': 'Distribution.DomainName' });
  assert.deepEqual(o('DistributionUrl'), { 'Fn::Sub': 'https://${Distribution.DomainName}/' });
  assert.deepEqual(o('SiteBucketName'), { Ref: 'SiteBucket' });
  assert.deepEqual(o('AlternateDomainName'), { Ref: 'AlternateDomainName' });
  assert.deepEqual(o('CanonicalHost'), { Ref: 'CanonicalHost' });
  assert.deepEqual(o('PublisherRoleArn'), { 'Fn::If': ['HasPublisher', { 'Fn::GetAtt': 'PublisherRole.Arn' }, ''] });
  // Rendered: publisher output is empty when no principal is configured, domain outputs empty by default.
  const { Outputs } = renderStack(t, paramFile('test'));
  assert.equal(Outputs.PublisherRoleArn.Value, '');
  assert.equal(Outputs.AlternateDomainName.Value, '');
  assert.equal(Outputs.CanonicalHost.Value, '');
});

// ======================================================================================
// FR-10 (publisher role) / FR-11 (logging, budget) / FR-12 (tags)
// ======================================================================================
test('FR-10: the publisher role exists only with a principal and has the exact inline permissions', () => {
  const t = T();
  assert.deepEqual(resourcesOfType(renderStack(t, paramFile('test')).Resources, 'AWS::IAM::Role'), [], 'skipped when empty');
  const principal = 'arn:aws:iam::123456789012:role/operator';
  const { Resources } = renderStack(t, { ...paramFile('test'), PublisherPrincipalArn: principal });
  const role = only(Resources, 'AWS::IAM::Role').Properties;
  assert.deepEqual(role.AssumeRolePolicyDocument.Statement.map((s) => [s.Effect, s.Principal.AWS, s.Action]), [['Allow', principal, 'sts:AssumeRole']]);
  assert.equal(role.Policies.length, 1, 'one inline policy, no managed policies');
  assert.ok(!('ManagedPolicyArns' in role));
  const actions = statements(role.Policies[0].PolicyDocument).flatMap((s) => asList(s.Action)).sort();
  assert.deepEqual(actions, ['cloudformation:DescribeStacks', 'cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation', 's3:DeleteObject', 's3:ListBucket', 's3:PutObject']);
  for (const s of statements(role.Policies[0].PolicyDocument)) {
    assert.equal(s.Effect, 'Allow');
    for (const r of asList(s.Resource)) assert.ok(r !== '*', 'no wildcard resource');
    for (const a of asList(s.Action)) assert.ok(!/\*/.test(a), 'no wildcard action');
  }
  const forAction = (a) => statements(role.Policies[0].PolicyDocument).find((s) => asList(s.Action).includes(a)).Resource;
  assert.deepEqual(forAction('s3:ListBucket'), { 'Fn::GetAtt': 'SiteBucket.Arn' });
  assert.deepEqual(forAction('s3:PutObject'), { 'Fn::Sub': '${SiteBucket.Arn}/*' });
  assert.deepEqual(forAction('cloudfront:CreateInvalidation'), { 'Fn::Sub': 'arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/${Distribution}' });
  assert.deepEqual(forAction('cloudformation:DescribeStacks'), { 'Fn::Sub': 'arn:${AWS::Partition}:cloudformation:${AWS::Region}:${AWS::AccountId}:stack/${AWS::StackName}/*' });
});

test('FR-11: access logs go to a private ACL-enabled log bucket with expiry, and only when enabled', () => {
  const t = T();
  const on = renderStack(t, { ...paramFile('test'), EnableAccessLogs: 'true', LogRetentionDays: '45' }).Resources;
  const buckets = resourcesOfType(on, 'AWS::S3::Bucket');
  assert.equal(buckets.length, 2);
  const log = on.LogBucket.Properties;
  assert.deepEqual(log.OwnershipControls.Rules, [{ ObjectOwnership: 'BucketOwnerPreferred' }]);
  assert.deepEqual(log.PublicAccessBlockConfiguration, { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
  assert.ok(log.BucketEncryption, 'encrypted');
  const rule = log.LifecycleConfiguration.Rules[0];
  assert.equal(rule.ExpirationInDays, '45');
  assert.equal(rule.Status, 'Enabled');
  assert.deepEqual(on.Distribution.Properties.DistributionConfig.Logging, { Bucket: { 'Fn::GetAtt': 'LogBucket.DomainName' }, Prefix: 'test/', IncludeCookies: false });
  assert.ok(on.LogBucketPolicy, 'log bucket policy present');
  const off = renderStack(t, { ...paramFile('test'), EnableAccessLogs: 'false' }).Resources;
  assert.equal(resourcesOfType(off, 'AWS::S3::Bucket').length, 1);
  assert.equal('Logging' in off.Distribution.Properties.DistributionConfig, false);
  assert.equal('LogBucketPolicy' in off, false);
});

test('FR-11: the budget is skipped at limit 0 and alerts at 80 % and 100 % only when an e-mail is given', () => {
  const t = T();
  assert.deepEqual(resourcesOfType(renderStack(t, { ...paramFile('test'), BudgetLimitUsd: '0' }).Resources, 'AWS::Budgets::Budget'), []);
  const noEmail = only(renderStack(t, { ...paramFile('test'), BudgetLimitUsd: '10' }).Resources, 'AWS::Budgets::Budget').Properties;
  assert.equal('NotificationsWithSubscribers' in noEmail, false);
  const b = only(renderStack(t, { ...paramFile('test'), BudgetLimitUsd: '10', BudgetEmail: 'someone@example.org' }).Resources, 'AWS::Budgets::Budget').Properties;
  assert.equal(b.Budget.BudgetType, 'COST');
  assert.equal(b.Budget.TimeUnit, 'MONTHLY');
  assert.deepEqual(b.Budget.BudgetLimit, { Amount: '10', Unit: 'USD' });
  assert.deepEqual(b.NotificationsWithSubscribers.map((n) => n.Notification.Threshold).sort((a, b) => a - b), [80, 100]);
  for (const n of b.NotificationsWithSubscribers) {
    assert.equal(n.Notification.ThresholdType, 'PERCENTAGE');
    assert.deepEqual(n.Subscribers, [{ SubscriptionType: 'EMAIL', Address: 'someone@example.org' }]);
  }
  assert.deepEqual(b.ResourceTags, [{ Key: 'Project', Value: 'results-dashboard' }, { Key: 'Environment', Value: 'test' }]);
});

test('FR-12: every taggable resource carries explicit Project and Environment tags', () => {
  const t = T();
  const principal = 'arn:aws:iam::123456789012:role/operator';
  const { Resources } = renderStack(t, { ...paramFile('prod'), PublisherPrincipalArn: principal, BudgetLimitUsd: '10', BudgetEmail: 'someone@example.org' });
  const taggable = { 'AWS::S3::Bucket': 'Tags', 'AWS::CloudFront::Distribution': 'Tags', 'AWS::CloudFront::Function': 'Tags', 'AWS::IAM::Role': 'Tags', 'AWS::Budgets::Budget': 'ResourceTags' };
  const exempt = new Set(['AWS::S3::BucketPolicy', 'AWS::CloudFront::OriginAccessControl', 'AWS::CloudFront::CachePolicy', 'AWS::CloudFront::ResponseHeadersPolicy']);
  const seen = new Set();
  for (const [id, r] of Object.entries(Resources)) {
    seen.add(r.Type);
    if (exempt.has(r.Type)) continue;
    const prop = taggable[r.Type];
    assert.ok(prop, `${id} (${r.Type}) is neither taggable-listed nor exempt`);
    assert.deepEqual(r.Properties[prop], [{ Key: 'Project', Value: 'results-dashboard' }, { Key: 'Environment', Value: 'prod' }], id);
  }
  for (const type of Object.keys(taggable)) assert.ok(seen.has(type), `${type} was exercised`);
});

// ======================================================================================
// samconfig.toml (FR-01, FR-03, FR-12, design 7.6)
// ======================================================================================
test('FR-03 / FR-12: samconfig has test and prod with distinct stacks, region, both tags and confirm_changeset', () => {
  const text = read('infra/samconfig.toml');
  const sam = parseSamconfig(text);
  assert.equal(sam.version, 0.1);
  const stacks = new Set();
  for (const env of ['test', 'prod']) {
    const d = sam[`${env}.deploy.parameters`];
    assert.equal(d.stack_name, `results-dashboard-${env}`);
    stacks.add(d.stack_name);
    assert.equal(d.region, 'us-east-1');
    assert.equal(d.confirm_changeset, true);
    assert.deepEqual(pairs(d.tags), { Project: 'results-dashboard', Environment: env });
    assert.equal(d.capabilities, 'CAPABILITY_IAM');
    assert.ok(!('resolve_s3' in d) || d.resolve_s3 === false, 'no SAM-managed untagged artifact bucket (design 7.6)');
    assert.ok(!('s3_bucket' in d));
    assert.ok(!/BudgetEmail/.test(d.parameter_overrides), 'BudgetEmail is never committed');
  }
  assert.equal(stacks.size, 2);
  assert.ok(!/@/.test(text) && !/\b\d{12}\b/.test(text), 'no e-mail address or account ID');
});

test('NFR-01: committed infra files contain no e-mail address, account ID or credential', () => {
  for (const f of ['infra/template.yaml', 'infra/samconfig.toml', 'infra/template.src.yaml']) {
    const text = read(f);
    assert.ok(!/[\w.+-]+@[\w-]+\.[\w.]+/.test(text), `${f}: no e-mail address`);
    assert.ok(!/(?<![\d])\d{12}(?![\d])/.test(text.replace(/123456789012/g, '')), `${f}: no account ID`);
    assert.ok(!/AKIA[0-9A-Z]{16}/.test(text), `${f}: no access key`);
  }
});

test('FR-01: package.json has build:infra and the exact yaml devDependency', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['build:infra'], 'node scripts/build-infra.mjs');
  assert.equal(pkg.devDependencies.yaml, '2.9.1');
  assert.ok(!('yaml' in (pkg.dependencies ?? {})));
});
