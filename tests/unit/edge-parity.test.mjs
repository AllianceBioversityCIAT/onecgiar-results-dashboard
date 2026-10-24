// T-09: local/edge adapter parity over routing-cases.json (FR-14 scenario, design 7.3 Adapters,
// 7.6, Z-5). Both adapters call the same core, so the falsifiable assertions are about the
// adapters: (1) input construction (raw path and raw query byte-identical, query round-trip with
// keys in order and multiValue expanded), (2) materialization (status, Location, rewritten uri).
// The local adapter's input is modelled exactly as design 7.3 defines it (raw target split, parsed
// map from URLSearchParams, last value wins); the real server is tested by serve.test (T-10).
// Real CloudFront behavior (decoded vs raw query values, 404 body via the custom error response,
// key order of request.querystring) is `NOT RUN — AWS` (P-8).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { runBuild, cleanupTemp, ROOT } from '../helpers/build-run.mjs';
import { HOSTS, label, defaultHost, casesFor, expectedFor, substituteHost } from '../helpers/canonical-hosts.mjs';

const { cases } = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'cases', 'routing-cases.json'), 'utf8'));
const STATUS = { rewrite: 200, redirect: 301, badRequest: 400, methodNotAllowed: 405, notFound: 404, pass: 200 };

let rawEdge; // the generated file, with the ${CanonicalHost} placeholder still in it
before(() => {
  const r = runBuild();
  assert.equal(r.status, 0, r.stderr);
  rawEdge = fs.readFileSync(path.join(r.base, 'dist-edge', 'cloudfront-function.js'), 'utf8');
});
after(() => cleanupTemp());

for (const H of HOSTS) {
  const CANON_HOST = defaultHost(H);
  const edgeText = () => substituteHost(rawEdge, H);
  const t = (name, fn) => test(`${name} {canonical host ${label(H)}}`, fn);

  // ---- Simulated CloudFront event (P-8 shape): one field per key, multiValue when repeated ----
  function simulateQuerystring(rawQuery) {
    const qs = {};
    if (rawQuery === '') return qs;
    for (const part of rawQuery.split('&')) {
      const i = part.indexOf('=');
      const key = i === -1 ? part : part.slice(0, i);
      const value = i === -1 ? '' : part.slice(i + 1);
      if (Object.prototype.hasOwnProperty.call(qs, key)) {
        qs[key].multiValue.push({ value });
      } else {
        qs[key] = { value, multiValue: undefined, first: value };
        qs[key].multiValue = [{ value }];
      }
    }
    // Single occurrences carry no multiValue (docs: multiValue only for duplicates).
    for (const k of Object.keys(qs)) {
      if (qs[k].multiValue.length === 1) delete qs[k].multiValue;
      delete qs[k].first;
    }
    return qs;
  }

  function eventOf(c) {
    return {
      version: '1.0',
      context: { eventType: 'viewer-request' },
      viewer: { ip: '198.51.100.11' },
      request: {
        method: c.method ?? 'GET',
        uri: c.path,
        querystring: simulateQuerystring(c.query ?? ''),
        headers: { host: { value: c.host ?? CANON_HOST } },
        cookies: {},
      },
    };
  }

  // Local adapter input per design 7.3: raw path/query as received, parsed map = last value.
  function localInput(c) {
    const query = c.query ?? '';
    const sp = new URLSearchParams(query);
    const params = {};
    for (const k of new Set(sp.keys())) { const all = sp.getAll(k); params[k] = all[all.length - 1]; }
    return { method: c.method ?? 'GET', host: c.host ?? CANON_HOST, path: c.path, query, params };
  }

  // True when some key or value of the query has an escape decodeURIComponent rejects.
  function malformedEscape(query) {
    return query.split('&').some((p) => p.split('=').some((x) => {
      try { decodeURIComponent(x.replace(/\+/g, ' ')); return false; } catch (e) { return true; }
    }));
  }

  // Fresh vm context per run with a spy on the core's resolve; handlerOf is the unit under test.
  function runEdge(event, handlerOf = (ctx) => ctx.handler) {
    const ctx = vm.createContext({});
    vm.runInContext(edgeText(), ctx, { filename: 'cloudfront-function.js' });
    const captured = [];
    const original = ctx.resolve;
    ctx.resolve = (req, mode) => { captured.push({ req: JSON.parse(JSON.stringify(req)), mode }); return original(req, mode); };
    const out = handlerOf(ctx)(JSON.parse(JSON.stringify(event)));
    return { out: JSON.parse(JSON.stringify(out)), captured };
  }

  const expectedMaterialization = (c) => expectedFor(c, H).expect;

  for (const c of casesFor(cases, H)) {
    const bothOrEdge = c.modes === 'both' ? 'both' : 'edge';

    t(`input construction [${bothOrEdge}] ${c.id}: raw path and raw query are byte-identical to the local adapter's, query round-trips`, () => {
      const { captured } = runEdge(eventOf(c));
      assert.equal(captured.length, 1, 'handler calls the core exactly once');
      assert.equal(captured[0].mode, 'edge');
      const local = localInput(c);
      const got = captured[0].req;
      assert.equal(got.path, local.path);
      assert.equal(got.query, local.query);
      assert.equal(got.method, local.method);
      assert.equal(got.host, local.host);
      // FR-14: the parsed map is the same too. Documented normalization: a malformed escape makes
      // the handler keep the raw text (decodeURIComponent throws) where URLSearchParams yields
      // U+FFFD; the rule result must then be identical (checked below).
      if (malformedEscape(c.query ?? '')) {
        assert.equal(JSON.stringify(got.params).includes('\ufffd'), false);
      } else {
        assert.deepEqual(got.params, local.params);
      }  });

    t(`materialization [edge] ${c.id}: ${c.expect.type} -> ${c.status}`, () => {
      const { out } = runEdge(eventOf(c));
      const want = expectedMaterialization(c);
      switch (want.type) {
        case 'rewrite':
          assert.equal(out.statusCode, undefined);
          assert.equal(out.uri, `/${want.file}`);
          break;
        case 'redirect':
          assert.equal(out.statusCode, 301);
          assert.equal(out.headers.location.value, want.location);
          break;
        case 'badRequest':
        case 'methodNotAllowed':
          assert.equal(out.statusCode, STATUS[want.type]);
          break;
        case 'notFound':
          // The final 404 is served by CloudFront's custom error response: NOT RUN — AWS (W-2).
          assert.equal(out.statusCode, undefined);
          assert.equal(out.uri, '/__rd_not_found__');
          break;
        case 'pass':
          assert.equal(out.statusCode, undefined);
          assert.equal(out.uri, c.path);
          break;
        default:
          assert.fail(`unexpected type ${want.type}`);
      }
    });
  }

  t('rule result is identical for edge and local inputs, also where the maps are normalized (malformed escapes)', () => {
    const ctx = vm.createContext({});
    vm.runInContext(edgeText(), ctx);
    const run = (r) => JSON.stringify(ctx.resolve(r, 'edge'));
    const probes = ['year=%E0%A4%A', 'year=%', 'year=2019&embed=%zz', 'a=%FF&year=%202019', 'embed=tru%65&displayNav=%74rue'];
    for (const query of probes) {
      const c = { path: '/partnerships', query };
      const { captured } = runEdge(eventOf(c));
      assert.equal(run(captured[0].req), run(localInput(c)), query);
    }
  });

  t('form semantics: + is a space and decoded keys are matched', () => {
    const { captured } = runEdge(eventOf({ path: '/innovations', query: 'a+b=c+d&%65mbed=true' }));
    assert.deepEqual(captured[0].req.params, { 'a b': 'c d', embed: 'true' });
  });

  t('every case query is representable as a CloudFront querystring object (the round trip is not vacuous)', () => {
    const withQuery = casesFor(cases, H).filter((c) => (c.query ?? '') !== '');
    assert.ok(withQuery.length >= 40);
    for (const c of withQuery) {
      const { captured } = runEdge(eventOf(c));
      assert.equal(captured[0].req.query, c.query, c.id);
    }
  });

  t('multiValue is expanded in order and params take the LAST value (P-24)', () => {
    const event = eventOf({ path: '/partnerships' });
    event.request.querystring = {
      year: { value: '2019', multiValue: [{ value: '2019' }, { value: '2017' }] },
      embed: { value: 'true' },
    };
    const { captured, out } = runEdge(event);
    assert.equal(captured[0].req.query, 'year=2019&year=2017&embed=true');
    assert.deepEqual(captured[0].req.params, { year: '2017', embed: 'true' });
    assert.equal(out.uri, '/partnerships-2017--embed-nonav.html');
  });

  t('an empty querystring object gives an empty raw query and an empty map', () => {
    const { captured } = runEdge(eventOf({ path: '/innovations' }));
    assert.equal(captured[0].req.query, '');
    assert.deepEqual(captured[0].req.params, {});
  });

  t('generated responses carry the status the core result states (FR-14: same HTTP status)', () => {
    for (const c of casesFor(cases, H)) {
      const want = expectedMaterialization(c);
      if (want.type === 'rewrite' || want.type === 'pass' || want.type === 'notFound') continue;
      const { out } = runEdge(eventOf(c));
      assert.equal(out.statusCode, STATUS[want.type], c.id);
      assert.equal(typeof out.statusCode, 'number', 'statusCode is an integer (P-8 docs)');
    }
  });
}
