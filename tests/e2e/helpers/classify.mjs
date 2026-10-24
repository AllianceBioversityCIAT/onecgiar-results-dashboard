// Pure classifier of why a Tableau page did not render (FR-22): `login | embedding | network`, or null
// (unexplained, the caller FAILS). No Playwright import, so tests/unit can run it with fake
// `page`/`net` objects. Everything is judged from what the browser observed, as an anonymous visitor.
import { TABLEAU_HOSTS } from './site.mjs';

const isLocalHost = (host) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
// Errors that prove the host could not be reached. Anything else (ORB, cancelled, aborted, SEC_ERROR_*)
// is routine and says nothing about a non-render.
export const UNREACHABLE_ERRORS = /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_(REFUSED|RESET|CLOSED|TIMED_OUT|FAILED)|ERR_TIMED_OUT|ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE|Could not resolve hostname|Could not connect|NS_ERROR_UNKNOWN_HOST|NS_ERROR_CONNECTION_REFUSED|NS_ERROR_NET_TIMEOUT|NS_ERROR_NET_RESET/i;

const SESSION_PATH = /\/vizql\/w\/[^/]+\/v\/[^/]+\/startSession\//;
const isViewDoc = (url) => TABLEAU_HOSTS.includes(new URL(url).hostname) && /\/views\/[^/]+\/[^/?#]+/.test(new URL(url).pathname);

// True when the response forbids framing by the page's origin (X-Frame-Options, or a CSP
// frame-ancestors list that has neither `*` nor the page origin).
export function refusesEmbedding(headers, pageOrigin) {
  const xfo = (headers['x-frame-options'] || '').toLowerCase();
  if (xfo.includes('deny') || xfo.includes('sameorigin')) return true;
  const csp = headers['content-security-policy'] || '';
  const m = /frame-ancestors\s+([^;]*)/i.exec(csp);
  if (!m) return false;
  const sources = m[1].trim().split(/\s+/);
  const host = new URL(pageOrigin).hostname;
  return !sources.some((s) => s === '*' || s === pageOrigin || s === `http://${host}` || s === `http://${host}:*` || s === 'http:');
}

// Async: null while undetermined; otherwise { reason: 'login' | 'embedding' | 'network', detail }.
export async function blockReason(page, net, expectedViews, final = false) {
  const origin = new URL(page.url()).origin;
  const docs = net.responses.filter((r) => isViewDoc(r.url));
  const failedDocs = net.failed.filter((f) => isViewDoc(f.url));
  const frameUrls = page.frames().filter((f) => f.parentFrame()).map((f) => f.url());
  if (frameUrls.some((u) => /sign-?in|login|saml|auth/i.test(u) && !isLocalHost(new URL(u).hostname))
      || docs.some((r) => r.status === 401 || /sign-?in|login/i.test(r.headers.location || ''))) return { reason: 'login', detail: 'sign-in required' };
  if (docs.some((r) => refusesEmbedding(r.headers, origin))) return { reason: 'embedding', detail: 'frame-ancestors / X-Frame-Options refuse this origin' };
  const sessionStarted = net.responses.some((r) => r.status >= 200 && r.status < 300 && TABLEAU_HOSTS.includes(r.host)
    && SESSION_PATH.test(new URL(r.url).pathname));
  if (docs.some((r) => r.status >= 400)) return { reason: 'network', detail: 'view document answered with an HTTP error' };
  // Upstream viz not found. Network-level signal, probed in all three browsers (T-13 attempt 2):
  // the server answers the view document 200 but the viz session request of the embedded page,
  // POST/GET /vizql/w/<workbook>/v/<view>/startSession/viewing, answers 404 for each missing view
  // (the frame then shows "Where's the viz?"; that text is only supporting evidence, attached by
  // the callers). Early exit when every expected view got its 404; at the deadline one 404 is
  // enough, because the page cannot reach `filter-loaded` while any one of its views is missing.
  const gone = new Set(net.responses.filter((r) => r.status === 404 && TABLEAU_HOSTS.includes(r.host)
    && /\/vizql\/w\/[^/]+\/v\/[^/]+\/startSession\//.test(new URL(r.url).pathname)).map((r) => new URL(r.url).pathname));
  if ((expectedViews > 0 && gone.size >= expectedViews) || (final && gone.size > 0)) {
    return { reason: 'network', detail: 'upstream viz not found' };
  }
  // Deadline only, and only when no viz session started. A request issued from inside a Tableau frame
  // failed in a way that proves the host could not be reached (UNREACHABLE_ERRORS), for example
  // "Could not resolve hostname" for the asset host in WebKit: the frame never ran its scripts, so
  // neither a render nor the 404 above can be observed. Routine failures (ORB, cancelled, aborted,
  // certificate noise) prove nothing about a non-render and are NOT counted. A 2xx startSession
  // means Tableau answered: a missing `filter-loaded` is then a site failure (null, never BLOCKED).
  if (!final || sessionStarted) return null;
  const unreachable = (e) => UNREACHABLE_ERRORS.test(e || '');
  const frameFailures = net.failed.filter((x) => !isLocalHost(x.host) && unreachable(x.error)
    && net.requests.some((q) => q.url === x.url && !q.isMainFrame));
  if (frameFailures.length > 0) {
    return { reason: 'network', detail: `tableau frame request failed: ${frameFailures[0].host} (${frameFailures[0].error})` };
  }
  if (failedDocs.some((f) => unreachable(f.error))) return { reason: 'network', detail: 'view document request failed' };
  return null;
}

