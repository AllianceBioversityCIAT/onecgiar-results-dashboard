// Shared by the TABLEAU-class specs (tableau-render, filters): waits for a render or a block reason.
// Classification itself lives in classify.mjs (pure, unit-tested).
import { test, isLocalHost } from './network.mjs';
import { blockReason } from './classify.mjs';

export { blockReason, refusesEmbedding, UNREACHABLE_ERRORS } from './classify.mjs';
export const RENDERED = '.filter-component.filter-loaded';

// Waits until every view rendered (RENDERED) or a block reason is evident. Returns
// { rendered: true } or { rendered: false, reason, detail } ; reason is null on timeout without
// evidence (the caller FAILS: neither rendered nor explained).
export async function renderOrReason(page, net, expectedViews, timeout = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.locator(RENDERED).count() > 0 && await page.locator('.filter-component.filter-loading').count() === 0) return { rendered: true };
    const b = await blockReason(page, net, expectedViews);
    if (b) return { rendered: false, ...b };
    await page.waitForTimeout(500);
  }
  const b = await blockReason(page, net, expectedViews, true);
  return { rendered: false, reason: b ? b.reason : null, detail: b ? b.detail : null };
}

// Records class and, when blocked, the `blocked` annotation (design 9: a blocked TABLEAU test is
// skipped with annotation `blocked`) and skips the test.
export function markClass(testInfo, cls) {
  testInfo.annotations.push({ type: 'class', description: cls });
}
export function blockTest(testInfo, reason, detail = '') {
  testInfo.annotations.push({ type: 'blocked', description: reason });
  if (detail) testInfo.annotations.push({ type: 'blocked-detail', description: detail });
  test.skip(true, `BLOCKED (${reason})${detail ? `: ${detail}` : ''}`);
}

// Hosts requested from child frames (Tableau viz and its assets), for the tableauHosts pin.
export function frameHosts(net) {
  return [...new Set(net.requests.filter((r) => !r.isMainFrame && !isLocalHost(r.host)).map((r) => r.host))].sort();
}

// Attaches the observed evidence of one render attempt (hosts, responses, failures, frame text).
// Frame text is supporting evidence only; the verdict never depends on it.
export async function attachEvidence(testInfo, page, net, pageUrl, out) {
  await testInfo.attach('tableau-frame-hosts', { body: JSON.stringify({ page: pageUrl, rendered: out.rendered, reason: out.reason, detail: out.detail, hosts: frameHosts(net) }), contentType: 'application/json' });
  const frames = await Promise.all(page.frames().filter((fr) => fr.parentFrame()).map(async (fr) => ({
    url: fr.url().slice(0, 160),
    text: await fr.locator('body').innerText({ timeout: 2000 }).then((t) => t.slice(0, 200), () => null),
  })));
  const responses = net.responses.filter((r) => !isLocalHost(r.host)).map((r) => ({ url: r.url.slice(0, 160), status: r.status, xfo: r.headers['x-frame-options'], csp: r.headers['content-security-policy'] }));
  const failed = net.failed.map((x) => ({ url: x.url.slice(0, 160), error: x.error }));
  await testInfo.attach('tableau-responses', { body: JSON.stringify({ responses, failed, frames }, null, 1), contentType: 'application/json' });
}
