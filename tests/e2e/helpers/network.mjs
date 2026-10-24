// Network recording for the E2E suites (FR-28). Every request the browser issues is recorded;
// anything that is not on the local origins is ABORTED, so no test reaches the internet (Tableau,
// Google Fonts and any unexpected host are only observed, never contacted), EXCEPT where a spec opts in (releasePolicy below, T-13).
import { test as base, expect } from '@playwright/test';
import { site, distFileExists, FORBIDDEN_HOSTS } from './site.mjs';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
export const isLocalHost = (host) => LOOPBACK.has(host);

export function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

// Requests whose scheme is not http(s) (data:, blob:, about:) never leave the browser.
const isNetwork = (url) => /^https?:/i.test(url);

// Opt-in for the TABLEAU / request-observation specs (T-13, FR-28: "the requests a browser makes
// as a normal visitor when opening the pages (including Tableau's)"). The default is unchanged:
// every non-loopback request is aborted. A spec opts in explicitly with
//   test.use({ allowHosts: ['tableau-core.cgiar.org', 'public.tableau.com'] })
// to let exactly those hosts through, and with
//   test.use({ allowTableauFrames: true })
// to also let through the requests issued by a child frame of the page (the Tableau viz iframe
// and every host that frame loads, e.g. the Tableau asset CDN and googletagmanager.com, which the
// public.tableau.com page itself requests; FR-28 allows the requests Tableau's pages make). What the
// page's OWN (main frame) code requests is never released by allowTableauFrames: Google Fonts and
// any other main-frame host stay aborted. 192.0.2.50, results.cgiar.org and *.amazonaws.com are
// never released, even from a frame (FORBIDDEN_HOSTS). The pages of dist/ embed no iframe other
// than Tableau's.
export function releasePolicy({ allowHosts = [], allowTableauFrames = false } = {}) {
  return (req) => {
    const host = hostOf(req.url());
    if (FORBIDDEN_HOSTS.includes(host) || host.endsWith('.amazonaws.com')) return false;
    if (allowHosts.includes(host)) return true;
    if (!allowTableauFrames) return false;
    try { return req.frame().parentFrame() !== null; } catch { return false; }
  };
}

export async function attachNetwork(context, policy = {}) {
  const log = { requests: [], responses: [], failed: [] };
  const release = releasePolicy(policy);
  await context.route((url) => !isLocalHost(url.hostname), (route) => (release(route.request()) ? route.continue() : route.abort('blockedbyclient')));
  context.on('request', (req) => {
    if (!isNetwork(req.url())) return;
    let isMain = true;
    try { isMain = req.frame().parentFrame() === null; } catch { /* service worker request */ }
    log.requests.push({ url: req.url(), host: hostOf(req.url()), type: req.resourceType(), method: req.method(), isMainFrame: isMain, isNav: req.isNavigationRequest() });
  });
  context.on('response', (res) => {
    if (isNetwork(res.url())) log.responses.push({ url: res.url(), status: res.status(), host: hostOf(res.url()), headers: res.headers() });
  });
  context.on('requestfailed', (req) => {
    if (isNetwork(req.url())) log.failed.push({ url: req.url(), host: hostOf(req.url()), error: req.failure()?.errorText });
  });
  return log;
}

// auto: true, so EVERY e2e test records and aborts non-loopback requests whether or not it asks
// for `net` (the contract "no test reaches the internet" must not depend on a test opting in).
// All specs must import `test` from here, never from @playwright/test.
export const test = base.extend({
  allowHosts: [[], { option: true }],
  allowTableauFrames: [false, { option: true }],
  net: [async ({ context, allowHosts, allowTableauFrames }, use) => {
    await use(await attachNetwork(context, { allowHosts, allowTableauFrames }));
  }, { auto: true }],
});
export { expect };

export const external = (log) => log.requests.filter((r) => !isLocalHost(r.host));

// Pure checkers. Each returns the offending entries (an empty array means pass), so a test can
// assert `toEqual([])` and show them.
export function unexpectedHosts(requests, allowed = site.allowedHosts) {
  return requests.filter((r) => !allowed.includes(r.host)).map((r) => r.url);
}
export function forbiddenDestinations(requests) {
  return requests
    .filter((r) => FORBIDDEN_HOSTS.includes(r.host) || r.host.endsWith('.amazonaws.com') || /\.php$/i.test(safePath(r.url)))
    .map((r) => r.url);
}
export function nonStaticLocalRequests(requests) {
  return requests
    .filter((r) => isLocalHost(r.host) && !(r.isNav && r.isMainFrame) && !distFileExists(safePath(r.url)))
    .map((r) => r.url);
}
export function localErrors(log) {
  return [
    ...log.responses.filter((r) => isLocalHost(r.host) && r.status >= 400).map((r) => `${r.status} ${r.url}`),
    ...log.failed.filter((r) => isLocalHost(r.host)).map((r) => `FAILED ${r.url} ${r.error}`),
  ];
}
function safePath(url) {
  try { return new URL(url).pathname; } catch { return ''; }
}

// Waits until the page has gone quiet: load event plus a short settle for the scripts that run
// at document-ready (Tableau Viz construction, CSV fetch).
export async function settle(page, ms = 1500) {
  await page.waitForLoadState('load');
  await page.waitForTimeout(ms);
}
