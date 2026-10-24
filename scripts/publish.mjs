// Publish the frozen release to the environment's bucket (design.md 7.4, DD-06, FR-15, FR-20, NFR-03).
//   node scripts/publish.mjs --env <test|prod> --release release/1f6d95a5 [--confirm] [--profile <p>]
// Default is a dry-run: it prints the upload plan and the deletion rule and makes NO AWS call.
// Only --confirm (which also requires an explicit --env) reaches the AWS CLI. It never builds,
// transforms or minifies; it never uses `aws s3 sync` (no MIME guessing) or `--recursive`.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { computeManifest } from './manifest.mjs';
import { APPROVED_HASH, sumsText } from './freeze-artifact.mjs';

// Fixed extension map. design.md 7.4 names the extensions; it gives explicit types only for
// .html, .svg, .csv and .woff2. The others are the standard IANA types, not specified by the design.
export const EXTENSION_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', // standard type, not specified by the design
  '.css': 'text/css; charset=utf-8', // standard type, not specified by the design
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json', // standard type, not specified by the design
  '.png': 'image/png', // standard type, not specified by the design
  '.jpg': 'image/jpeg', // standard type, not specified by the design
  '.gif': 'image/gif', // standard type, not specified by the design
  '.ico': 'image/x-icon', // standard type, not specified by the design
  '.woff2': 'font/woff2',
  '.woff': 'font/woff', // standard type, not specified by the design
  '.ttf': 'font/ttf', // standard type, not specified by the design
  '.eot': 'application/vnd.ms-fontobject', // standard type, not specified by the design
};

// [assumption] The design (7.1) fixes edge TTLs per behavior but not the object Cache-Control
// strings. HTML pages and /widget/* are the short class; every other file is the long class.
export const CACHE_SHORT = 'public, max-age=300';
export const CACHE_LONG = 'public, max-age=31536000, immutable';

const ENVS = ['test', 'prod'];

// Throws unless the release folder is internally consistent and is the approved artifact.
// Checks: folder name == hash prefix, manifest hash == approved hash, recomputed bytes == manifest
// (hash and per-file), manifest.json and SHA256SUMS text.
export function verifyRelease(releaseDir) {
  const dir = path.resolve(releaseDir);
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
  const raw = read(path.join(dir, 'manifest.json'));
  if (raw === null) throw new Error(`release verification failed: ${dir}/manifest.json not found`);
  const manifest = JSON.parse(raw);
  if (path.basename(dir) !== manifest.hash.slice(0, 8)) {
    throw new Error(`release verification failed: folder name ${path.basename(dir)} does not match hash prefix ${manifest.hash.slice(0, 8)}`);
  }
  if (manifest.hash !== APPROVED_HASH) {
    throw new Error(`release verification failed: manifest hash mismatch (expected ${APPROVED_HASH}, manifest ${manifest.hash})`);
  }
  if (!fs.existsSync(path.join(dir, 'dist'))) throw new Error(`release verification failed: ${dir}/dist not found`);
  const copy = computeManifest(path.join(dir, 'dist'));
  if (copy.hash !== manifest.hash) {
    const bad = Object.keys({ ...manifest.files, ...copy.files }).filter((k) => manifest.files[k] !== copy.files[k]);
    throw new Error(`release verification failed: hash mismatch (expected ${manifest.hash}, recomputed ${copy.hash}); differing: ${bad.slice(0, 5).join(', ')}`);
  }
  if (read(path.join(dir, 'SHA256SUMS')) !== sumsText(manifest)) {
    throw new Error('release verification failed: SHA256SUMS mismatch with manifest.json');
  }
  return { manifest, dir };
}

// [{ key, contentType, cacheControl }] for every manifest file, in manifest order.
// An unknown extension stops the plan.
export function buildPlan(manifest) {
  return Object.keys(manifest.files).map((key) => {
    const ext = path.posix.extname(key).toLowerCase();
    const contentType = EXTENSION_TYPES[ext];
    if (!contentType) throw new Error(`plan stopped: unknown extension "${ext}" for ${key}`);
    const short = ext === '.html' || key.startsWith('widget/');
    return { key, contentType, cacheControl: short ? CACHE_SHORT : CACHE_LONG };
  });
}

export function parseArgs(argv) {
  const o = { env: undefined, release: undefined, confirm: false, profile: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm') o.confirm = true;
    else if (a === '--env' || a === '--release' || a === '--profile') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      o[a.slice(2)] = v;
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (!o.release) throw new Error('--release <dir> is required');
  if (o.env !== undefined && !ENVS.includes(o.env)) throw new Error(`--env must be one of: ${ENVS.join(', ')}`);
  if (o.confirm && !o.env) throw new Error('--confirm requires an explicit --env <test|prod>');
  return o;
}

// The only place that can reach AWS. Built lazily, on the --confirm path only.
// No shell: each argv item (keys with spaces included) is passed verbatim.
export function makeAwsRunner() {
  return (args) => new Promise((resolve, reject) => {
    execFile('aws', args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`aws ${args.slice(0, 2).join(' ')} failed: ${(stderr || err.message).trim()}`));
      else resolve({ stdout });
    });
  });
}

// runner(args) -> Promise<{ stdout }>, args are the argv after `aws`. Injectable for tests.
export async function runPublish({
  env, releaseDir, confirm = false, profile, runner, makeRunner = makeAwsRunner, log = console.log,
} = {}) {
  if (env !== undefined && !ENVS.includes(env)) throw new Error(`--env must be one of: ${ENVS.join(', ')}`);
  if (confirm && !env) throw new Error('--confirm requires an explicit --env <test|prod>');
  const { manifest, dir } = verifyRelease(releaseDir);
  const plan = buildPlan(manifest);
  const dist = path.join(dir, 'dist');

  if (!confirm) {
    log(`dry-run: release ${path.basename(dir)} verified (${manifest.hash})`);
    log(`dry-run: ${plan.length} uploads planned for ${env ? `results-dashboard-${env}` : '(no --env given)'}`);
    for (const e of plan) log(`  upload ${e.key}  [${e.contentType}]  [${e.cacheControl}]`);
    log('deletion rule: every bucket key not in the manifest is deleted (the concrete list is computed only under --confirm, from a read-only bucket listing, and printed before any delete)');
    log('dry-run: no AWS call was made; add --confirm to write');
    return { dryRun: true, plan };
  }

  const run = runner || makeRunner();
  const aws = (args) => run(profile ? [...args, '--profile', profile] : args);

  const stack = `results-dashboard-${env}`;
  const out = await aws(['cloudformation', 'describe-stacks', '--stack-name', stack, '--query', 'Stacks[0].Outputs', '--output', 'json']);
  const outputs = Object.fromEntries((JSON.parse(out.stdout) || []).map((o) => [o.OutputKey, o.OutputValue]));
  const bucket = outputs.SiteBucketName;
  const distributionId = outputs.DistributionId;
  if (!bucket || !distributionId) throw new Error(`stack ${stack} outputs lack SiteBucketName or DistributionId`);
  log(`publishing ${plan.length} files to s3://${bucket} (${stack})`);

  for (const e of plan) {
    await aws(['s3', 'cp', path.join(dist, ...e.key.split('/')), `s3://${bucket}/${e.key}`,
      '--content-type', e.contentType, '--cache-control', e.cacheControl]);
  }
  log(`uploaded ${plan.length} files`);

  const listing = await aws(['s3api', 'list-objects-v2', '--bucket', bucket, '--query', 'Contents[].Key', '--output', 'json']);
  const keep = new Set(Object.keys(manifest.files));
  const deleted = (JSON.parse(listing.stdout || 'null') || []).filter((k) => !keep.has(k));
  log(`deleting ${deleted.length} keys not in the manifest`);
  for (const k of deleted) log(`  delete ${k}`);
  for (const k of deleted) await aws(['s3', 'rm', `s3://${bucket}/${k}`]);

  await aws(['cloudfront', 'create-invalidation', '--distribution-id', distributionId, '--paths', '/*']);
  log(`invalidation created for /* on ${distributionId}`);
  return { dryRun: false, plan, deleted, bucket, distributionId };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const o = parseArgs(process.argv.slice(2));
    await runPublish({ env: o.env, releaseDir: o.release, confirm: o.confirm, profile: o.profile });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
