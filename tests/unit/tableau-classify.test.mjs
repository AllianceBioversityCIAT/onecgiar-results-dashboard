// T-13 (FR-22): the pure classifier of why a Tableau page did not render. Fake `page`/`net`
// objects; no browser, no network. A routine failure must never turn a site FAILED into BLOCKED.
import test from 'node:test';
import assert from 'node:assert/strict';
import { blockReason, UNREACHABLE_ERRORS } from '../e2e/helpers/classify.mjs';

const HOST = 'tableau-core.cgiar.org';
const viewUrl = (v) => `https://${HOST}/views/AR-OICR/${v}?:embed=y&Year=2021`;
const session = (v, status) => ({ url: `https://${HOST}/vizql/w/AR-OICR/v/${v}/startSession/viewing?x=1`, status, host: HOST, headers: {} });
const doc = (v, headers = {}) => ({ url: viewUrl(v), status: 200, host: HOST, headers });
const page = { url: () => 'http://localhost:8080/caseReports', frames: () => [{ parentFrame: () => ({}), url: () => viewUrl('V1') }] };
const net = (over = {}) => ({ requests: [], responses: [], failed: [], ...over });
const failedFrame = (url, error) => ({ failed: { url, host: new URL(url).hostname, error }, request: { url, host: new URL(url).hostname, isMainFrame: false } });

test('routine failures (ORB, cancelled, aborted) plus a started session and no render are NOT a block', async () => {
  const orb = failedFrame('https://cdn.example.net/a.js', 'net::ERR_BLOCKED_BY_ORB');
  const cancelled = failedFrame('https://cdn.example.net/b.js', 'Load request cancelled');
  const aborted = failedFrame('https://cdn.example.net/c.js', 'NS_BINDING_ABORTED');
  const cert = failedFrame('https://cdn.example.net/d.js', 'SEC_ERROR_UNKNOWN');
  const n = net({
    responses: [doc('V1'), session('V1', 200)],
    failed: [orb, cancelled, aborted, cert].map((x) => x.failed),
    requests: [orb, cancelled, aborted, cert].map((x) => x.request),
  });
  assert.equal(await blockReason(page, n, 1, true), null);
});

test('routine failures alone at the deadline (no session either way) are not a block', async () => {
  const orb = failedFrame('https://cdn.example.net/a.js', 'net::ERR_BLOCKED_BY_ORB');
  assert.equal(await blockReason(page, net({ responses: [doc('V1')], failed: [orb.failed], requests: [orb.request] }), 1, true), null);
});

test('an unresolvable frame host at the deadline is network', async () => {
  const dns = failedFrame('https://public.tableau.com/views/Results/V1?:embed=y', 'net::ERR_NAME_NOT_RESOLVED');
  const r = await blockReason(page, net({ failed: [dns.failed], requests: [dns.request] }), 1, true);
  assert.equal(r.reason, 'network');
  assert.match(r.detail, /ERR_NAME_NOT_RESOLVED/);
});

test('an unresolvable host is NOT a block when a viz session started (site failure)', async () => {
  const dns = failedFrame('https://cdn.example.net/a.js', 'Could not resolve hostname');
  const n = net({ responses: [doc('V1'), session('V1', 200)], failed: [dns.failed], requests: [dns.request] });
  assert.equal(await blockReason(page, n, 1, true), null);
});

test('the frame-failure rule only applies at the deadline', async () => {
  const dns = failedFrame('https://cdn.example.net/a.js', 'Could not resolve hostname');
  assert.equal(await blockReason(page, net({ failed: [dns.failed], requests: [dns.request] }), 1, false), null);
});

test('a frame-ancestors header that excludes the page origin is embedding', async () => {
  const h = { 'content-security-policy': "frame-ancestors 'self' https://cgiar.org https://*.cgiar.org" };
  const r = await blockReason(page, net({ responses: [doc('V1', h)] }), 1);
  assert.equal(r.reason, 'embedding');
});

test('a frame-ancestors header that allows the page origin is not embedding', async () => {
  const h = { 'content-security-policy': 'frame-ancestors http://localhost:*' };
  assert.equal(await blockReason(page, net({ responses: [doc('V1', h)] }), 1), null);
});

test('a 404 startSession for every view is network, upstream viz not found', async () => {
  const n = net({ responses: [doc('V1'), doc('V2'), session('V1', 404), session('V2', 404)] });
  assert.deepEqual(await blockReason(page, n, 2), { reason: 'network', detail: 'upstream viz not found' });
});

test('a 404 for only some views waits (null) until the deadline, then is network', async () => {
  const n = net({ responses: [doc('V1'), doc('V2'), session('V1', 404)] });
  assert.equal(await blockReason(page, n, 2, false), null);
  assert.deepEqual(await blockReason(page, n, 2, true), { reason: 'network', detail: 'upstream viz not found' });
});

test('the unreachable allowlist names the host-unreachable errors and not the routine ones', () => {
  for (const e of ['net::ERR_NAME_NOT_RESOLVED', 'net::ERR_CONNECTION_REFUSED', 'net::ERR_CONNECTION_RESET', 'net::ERR_CONNECTION_CLOSED', 'net::ERR_CONNECTION_TIMED_OUT', 'net::ERR_TIMED_OUT', 'net::ERR_INTERNET_DISCONNECTED', 'net::ERR_ADDRESS_UNREACHABLE', 'Could not resolve hostname', 'Could not connect to the server', 'NS_ERROR_UNKNOWN_HOST', 'NS_ERROR_CONNECTION_REFUSED', 'NS_ERROR_NET_TIMEOUT', 'NS_ERROR_NET_RESET']) {
    assert.ok(UNREACHABLE_ERRORS.test(e), e);
  }
  for (const e of ['net::ERR_BLOCKED_BY_ORB', 'net::ERR_ABORTED', 'NS_BINDING_ABORTED', 'SEC_ERROR_UNKNOWN', 'Load request cancelled', 'net::ERR_BLOCKED_BY_CLIENT.Inspector']) {
    assert.ok(!UNREACHABLE_ERRORS.test(e), e);
  }
});
