// T-09: the generated CloudFront Function meets the cloudfront-js-2.0 constraints (NFR-07,
// FR-14 AND IT MUST, design 7.1 step 10, 7.7). Real CloudFront acceptance is `NOT RUN — AWS`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { runBuild, cleanupTemp, tempDir, ROOT } from '../helpers/build-run.mjs';
import { checkEdgeSource, assembleEdge, extractEdgeFunctions, EDGE_MAX_BYTES } from '../../scripts/build-edge.mjs';
import { rdData } from '../../scripts/site-data.mjs';
import { HOSTS, PROD, LONGEST_HOST, PLACEHOLDER, label, defaultHost, substituteHost } from '../helpers/canonical-hosts.mjs';

const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'site.json'), 'utf8'));
const legacySource = fs.readFileSync(path.join(ROOT, 'src', 'runtime', 'legacy-compat.core.js'), 'utf8');
const rulesSource = fs.readFileSync(path.join(ROOT, 'src', 'routing', 'rules.core.js'), 'utf8');
const toLf = (s) => s.replace(/\r\n?/g, '\n');

let build;
let edgeText;
before(() => {
  build = runBuild();
  assert.equal(build.status, 0, build.stderr);
  edgeText = fs.readFileSync(path.join(build.base, 'dist-edge', 'cloudfront-function.js'), 'utf8');
});
after(() => cleanupTemp());

test('NFR-07: dist-edge/cloudfront-function.js is at most 10 000 bytes', () => {
  const bytes = Buffer.byteLength(edgeText, 'utf8');
  assert.ok(bytes <= EDGE_MAX_BYTES, `${bytes} bytes`);
  assert.ok(bytes > 1000, 'file is not a stub');
});

test('NFR-07: the generated file passes the construct check', () => {
  assert.deepEqual(checkEdgeSource(edgeText), []);
});

// ---- FR-06 / NFR-04: optional canonical host (design 7.2) ----
test('FR-06: the placeholder is kept once, as the declaration before the core, and the core never names a host', () => {
  assert.equal(edgeText.split(PLACEHOLDER).length - 1, 1);
  const decl = `var RD_CANONICAL_HOST = '${PLACEHOLDER}';`;
  assert.ok(edgeText.indexOf(decl) !== -1 && edgeText.indexOf(decl) < edgeText.indexOf('function resolve('));
  assert.ok(!/cgiar.org/.test(rulesSource), 'rules.core.js must not hard-code an institutional host');
  assert.ok(!/cgiar.org/.test(edgeText), 'the edge source must not hard-code an institutional host');
});

test('FR-06 Fn::Sub safety: the edge source has no dollar-brace sequence other than the placeholder', () => {
  assert.equal(edgeText.split(PLACEHOLDER).join('').includes('${'), false);
  const second = '$' + '{Other}';
  assert.ok(checkEdgeSource(edgeText + '\nvar x = "' + second + '";\n').some((x) => /Fn::Sub-unsafe/.test(x)), 'a second dollar-brace is a finding');
});

test('NFR-04: the substituted code for the longest host stays within 10 000 bytes and passes the construct check', () => {
  const substituted = substituteHost(edgeText, LONGEST_HOST);
  const bytes = Buffer.byteLength(substituted, 'utf8');
  console.log(`# edge size: raw (placeholder) ${Buffer.byteLength(edgeText, 'utf8')} bytes; substituted for ${LONGEST_HOST} ${bytes} bytes; limit ${EDGE_MAX_BYTES}`);
  assert.ok(bytes <= EDGE_MAX_BYTES, `${bytes} bytes`);
  assert.deepEqual(checkEdgeSource(substituted), []);
});

test('the edge file is dist-edge/ next to the output folder, not inside dist/', () => {
  assert.ok(!fs.existsSync(path.join(build.outDir, 'cloudfront-function.js')));
  assert.ok(!fs.existsSync(path.join(build.outDir, 'dist-edge')));
});

test('DD-19: file is the verbatim concatenation of the @edge functions, the rules core, the data literal and the handler', () => {
  const edgeFns = extractEdgeFunctions(legacySource);
  assert.equal(edgeFns.length, 2);
  assert.match(edgeFns[0], /^function isNumericYear\(/);
  assert.match(edgeFns[1], /^function yearAfter2017\(/);
  for (const piece of [...edgeFns, toLf(rulesSource).trimEnd()]) {
    assert.ok(edgeText.includes(piece) || edgeText.includes(piece.split('\n').filter((l) => !/^\s*\/\//.test(l) && l.trim() !== '').join('\n')), 'core text missing');
  }
  // Only the @edge functions of legacy-compat travel to the edge (design 7.1 step 10).
  for (const name of ['lastValue', 'yearMatches', 'twigEscapeHtml']) {
    assert.ok(!new RegExp(`function ${name}\\b`).test(edgeText), `${name} must not be in the edge file`);
  }
  assert.equal(edgeText.includes(`var RD_DATA = ${JSON.stringify(rdData(site))};`), true);
  assert.match(edgeText, /\nfunction handler\(event\) \{/);
});

test('DD-20: the edge file runs in an empty sandbox (no require, process, fs, URL, Buffer, timers) and declares only routing functions', () => {
  const sandbox = vm.createContext({});
  vm.runInContext(`"use strict";\n${edgeText}`, sandbox, { filename: 'cloudfront-function.js' });
  for (const g of ['require', 'process', 'fs', 'URL', 'URLSearchParams', 'Buffer', 'setTimeout', 'fetch']) {
    assert.equal(vm.runInContext(`typeof ${g}`, sandbox), 'undefined', g);
  }
  const declared = [...edgeText.matchAll(/^function\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  for (const n of declared) assert.ok(n === 'isNumericYear' || n === 'yearAfter2017' || n === 'resolve' || n === 'handler' || /^(rules|rd)[A-Z]/.test(n), n);
});

for (const H of HOSTS) {
  test(`DD-20 / FR-06: the substituted edge file runs in an empty sandbox and routes the canonical host normally {canonical host ${label(H)}}`, () => {
    const sandbox = vm.createContext({});
    vm.runInContext(`"use strict";\n${substituteHost(edgeText, H)}`, sandbox, { filename: 'cloudfront-function.js' });
    const call = (host) => JSON.parse(vm.runInContext(
      `JSON.stringify(handler({ request: { method: 'GET', uri: '/innovations', querystring: {}, headers: { host: { value: ${JSON.stringify(host)} } } } }))`,
      sandbox));
    assert.equal(call(defaultHost(H)).uri, '/innovations.html');
    const foreign = call('dxxxx.cloudfront.net');
    if (H === '') assert.equal(foreign.uri, '/innovations.html');
    else assert.equal(foreign.headers.location.value, `https://${H}/innovations`);
  });
}

test('no ES6+ syntax that the cores promise to avoid: no import/export statements and no top-level await', () => {
  assert.ok(!/^\s*(import|export)\s/m.test(edgeText));
  assert.ok(!/\bawait\b/.test(edgeText));
});

// ---- Construct check: each forbidden construct turns it red ----
const forbiddenSamples = {
  'require(fs)': "var fs = require('fs');",
  'import statement': "import fs from 'node:fs';",
  'export statement': 'export function x() {}',
  'process access': 'var e = process.env;',
  eval: "eval('1');",
  'Function constructor': "var f = new Function('return 1');",
  timers: 'setTimeout(function () {}, 1);',
  fetch: "fetch('http://x');",
  'URLSearchParams global': "var p = new URLSearchParams('a=1');",
  Buffer: "var b = Buffer.from('a');",
  Date: 'var d = Date.now();',
  'PHP marker': '// ok\nvar s = "<?php";',
  syntax: 'var = ;',
};
for (const [name, line] of Object.entries(forbiddenSamples)) {
  test(`construct check is red for: ${name}`, () => {
    const findings = checkEdgeSource(`${edgeText}\n${line}\n`);
    assert.ok(findings.length > 0, `no finding for ${name}`);
  });
}

test('construct check is red above 10 000 bytes', () => {
  const findings = checkEdgeSource(`${edgeText}\n// ${'x'.repeat(EDGE_MAX_BYTES)}\n`);
  assert.ok(findings.some((f) => f.startsWith('size ')), findings.join('; '));
});

test('construct check ignores prose in whole-line comments', () => {
  assert.deepEqual(checkEdgeSource(`${edgeText}\n// reads from require('fs') only in prose\n`), []);
});

// ---- The build gate itself (design 7.1 step 10: non-zero exit on a forbidden construct) ----
test('falsifier: a require(fs) line in the core makes the build fail at step 10 (NFR-07)', () => {
  const src = tempDir('rd-edge-src-');
  fs.cpSync(path.join(ROOT, 'src'), src, { recursive: true });
  const core = path.join(src, 'routing', 'rules.core.js');
  fs.writeFileSync(core, `${fs.readFileSync(core, 'utf8')}\nfunction rulesLeak() { return require('fs'); }\n`);
  const r = runBuild({ srcDir: src });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /BUILD FAILED at step 10 \(edge\)/);
  assert.match(r.stderr, /forbidden construct require\(\)/);
  assert.ok(!fs.existsSync(path.join(r.base, 'dist-edge', 'cloudfront-function.js')), 'no edge file is left behind');
});

test('assembleEdge strips only whole-line comments and blank lines, keeping behavior', () => {
  const data = rdData(site);
  const full = assembleEdge({ legacySource, rulesSource, data });
  const stripped = assembleEdge({ legacySource, rulesSource, data, strip: true });
  assert.ok(Buffer.byteLength(stripped) < Buffer.byteLength(full));
  assert.deepEqual(checkEdgeSource(stripped), []);
  const probe = (text) => {
    const ctx = vm.createContext({});
    vm.runInContext(substituteHost(text, PROD), ctx);
    return vm.runInContext(`JSON.stringify([resolve({method:'GET',host:'results.cgiar.org',path:'/partnerships',query:'year=2017',params:{year:'2017'}},'edge'), resolve({method:'GET',host:'x.org',path:'/homeV1/',query:'a=b c',params:{}},'edge')])`, ctx);
  };
  assert.equal(probe(stripped), probe(full));
});
