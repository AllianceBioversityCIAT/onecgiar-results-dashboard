// FR-06 / NFR-04: the routing suites run once per canonical-host value. '' is the default
// (rule 1 inactive); the other two are the institutional hosts. The helpers are pure.
export const PROD = 'results.cgiar.org';
export const HOSTS = ['', PROD, 'results-test.cgiar.org'];
export const LONGEST_HOST = HOSTS.reduce((a, b) => (b.length > a.length ? b : a));
export const PLACEHOLDER = '${CanonicalHost}';

export const label = (h) => (h === '' ? "''" : h);

// Host a request carries when a case names none: the canonical host, or PROD when rule 1 is off.
export const defaultHost = (h) => (h === '' ? PROD : h);

// What the Fn::Sub of build-infra does to the generated edge source.
export const substituteHost = (source, host) => source.split(PLACEHOLDER).join(host);

// Cases that apply under canonical host `h`. A case carrying canonicalHost runs only under it.
export const casesFor = (cases, h) => cases.filter((c) => c.canonicalHost === undefined || c.canonicalHost === h);

// Expected { expect, status } of a case under canonical host `h`. Cases without canonicalHost
// are the PROD table; modes=edge ones are rule-1 cases whose expectation moves with the host.
export function expectedFor(c, h) {
  if (c.canonicalHost !== undefined || c.modes !== 'edge' || h === PROD) {
    return { expect: c.expect, status: c.status };
  }
  if (h === '') return { expect: c.expectEmptyHost, status: c.statusEmptyHost };
  const e = c.expect;
  if (e.type === 'redirect' && e.location.startsWith(`https://${PROD}`)) {
    return { expect: { ...e, location: `https://${h}${e.location.slice(`https://${PROD}`.length)}` }, status: c.status };
  }
  return { expect: e, status: c.status };
}
