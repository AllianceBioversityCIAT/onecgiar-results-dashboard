# Validation plan: TEST stack on the default CloudFront domain (stage S2)

This plan lists what the requester checks on the `*.cloudfront.net` address after the deploy and publish in
[RUNBOOK.md](RUNBOOK.md). Every status below is the state **before S2**: nothing has been run. Replace each status
as the check is executed and keep the output as S2 evidence.

> **Nothing here may be run now.** The checks start only after the requester signs G-DEPLOY and the runbook has
> deployed and published the release.

## Statuses

| Status | Meaning |
|---|---|
| `PASSED` | Ran, output matches the expected result. Keep the output. |
| `FAILED` | Ran, output differs. Record it; do not edit the stack or the content ad hoc. |
| `BLOCKED (reason)` | Cannot run, with the reason. |
| `NOT RUN` | Not run yet. |

## Setup

All commands are PowerShell 5.1. HTTP checks use `curl.exe` (the bare `curl` alias is `Invoke-WebRequest`).
`$Url` is the `DistributionUrl` output (runbook section 5). They call no AWS API.

```powershell
$Base = $Url.TrimEnd('/')
$Domain = ([System.Uri]$Url).Host
```

## 1. S2 checks on the default domain

### 1.1 Content and routes

| ID | Check (command) | Expected | Status |
|---|---|---|---|
| V-01 | Post-deploy content verification: `node scripts/verify-deploy.mjs --url $Url --release release/1f6d95a5` | `0 failed` and `PASS: equals approved hash 1f6d95a5...` (FR-16) | NOT RUN |
| V-02 | Home and a section: `curl.exe -s -o NUL -D - "$Base/"` and `"$Base/innovations"` | `200`, `Content-Type: text/html; charset=utf-8` | NOT RUN |
| V-03 | Trailing slash: `curl.exe -s -o NUL -D - "$Base/innovations/"` | `301`, `Location: /innovations` | NOT RUN |
| V-04 | Legacy `.html` name: `curl.exe -s -o NUL -D - "$Base/innovations.html"` | `301`, `Location: /innovations` | NOT RUN |
| V-05 | Marketing query kept and ignored by the cache key: `"$Base/innovations?utm_source=x&utm_medium=y"` | `200`; the same body as V-02 | NOT RUN |
| V-06 | Redirect keeps the query: `"$Base/innovations/?utm_source=x"` | `301`, `Location: /innovations?utm_source=x` | NOT RUN |
| V-07 | Partnerships legacy year: `"$Base/partnerships?year=2017"` | `200`, serves the 2017 page (compare with `partnerships-2017.html`; verified by V-01) | NOT RUN |
| V-08 | The parent items E-06-01 to E-06-07 in section 1.7 | See 1.7 | NOT RUN |

### 1.7 Parent E-06 items the default domain can exercise

Source: `docs/specs/changes/results-dashboard-aws-migration/evidence/validation-report.md`, section 11
"Tests pending for AWS" (seven items, each `NOT RUN — AWS` there). The IDs below are this plan's own labels for
those rows. Where an item needs the canonical host or a custom domain, that part is an S3 re-check (section 4).

| ID | Parent item and request | Expected | On the default domain | Status |
|---|---|---|---|---|
| E-06-01 | P-8 runtime: encoding of `request.uri` and query values at the edge, key order, real response behavior. Request `"$Base/innovations?utm_source=a%20b&x=%C3%A9"` and a path with encoded characters | Same result as the local emulation (`200`, or the same `301` and `Location`) | Yes (V-02 to V-06 cover the common cases) | NOT RUN |
| E-06-02 | P-31 CloudFront part: raw control or non-ASCII bytes at CloudFront. Request a path with `%00` | `400` for a bad path, `404` for traversal (rules `badRequest` and `notFound`); no `5xx` | Yes | NOT RUN |
| E-06-03 | OAC 403/404 mapping to `/404.html` | As V-22 and V-23 | Yes | NOT RUN |
| E-06-04 | Real CloudFront parity of the edge function (FR-14) and the real `cloudfront-js-2.0` runtime (NFR-07) | V-02 to V-11 behave as the local emulation; a function error or `5xx` is a failure | Yes | NOT RUN |
| E-06-05 | HTTPS, HSTS | As V-17 and V-18 | Yes | NOT RUN |
| E-06-05b | Real canonical host (FR-15): a request on a non-canonical host gets one `301` to the canonical host | Needs `CanonicalHost` set | **S3 re-check** (empty by design in S2; V-02 must show no redirect) | NOT RUN |
| E-06-06 | Widget on a real host (FR-12) | As V-16 | Partly: another origin yes, a `*.cgiar.org` host no (S3) | NOT RUN |
| E-06-07 | Publishing the exact `dist/` verified by its hash (Phase 4) | As V-01 | Yes | NOT RUN |

With the default domain no canonical redirect exists (`CanonicalHost` is empty): a request on the
`*.cloudfront.net` host must **not** be redirected anywhere. That is expected.

### 1.2 Variants, cache and premises P-16b and P-20

Embed variants must serve their own object and must not poison each other in the cache. Run each URL twice and
compare `X-Cache` and the body.

```powershell
$A = "$Base/innovations?embed=true&displayNav=true"
$B = "$Base/innovations?embed=true"
$N = "$Base/innovations"
foreach ($u in @($N, $A, $B, $N, $A, $B)) { curl.exe -s -o NUL -D - $u | Select-String -Pattern '^HTTP|^X-Cache|^Content-Length' }
```

| ID | Check | Expected | Status |
|---|---|---|---|
| V-09 | Three variants return different bodies (`Content-Length` differs, or hash the bodies) | Normal, `--embed` and `--embed-nonav` are three distinct objects | NOT RUN |
| V-10 | Second request of each variant | `X-Cache: Hit from cloudfront` per variant, never the body of another variant (P-16b, P-20) | NOT RUN |
| V-11 | Query strings are not in the cache key: V-05 after V-02 | `X-Cache: Hit from cloudfront` | NOT RUN |
| V-12 | `Cache-Control` of a page, an asset and the widget: `"$Base/css/global.css"`, `"$Base/widget/main.js"` | page and widget `public, max-age=300`; asset `public, max-age=31536000, immutable` (requester-approved at G-DEPLOY) | NOT RUN |

### 1.3 Assets, embed and widget

| ID | Check | Expected | Status |
|---|---|---|---|
| V-13 | Asset types: `/css/global.css`, `/fonts/icomoon.woff`, `/images/altmetric.svg` | `200` and the types from `scripts/publish.mjs` (`text/css; charset=utf-8`, `font/woff`, `image/svg+xml`) | NOT RUN |
| V-14 | Key with spaces: `"$Base/csv/CGIAR%20Results%20Dashboard%202020%20data%20-%20Project%20Management%20-%20Terms%20and%20Definitions%20List.csv"` | `200`, `text/csv; charset=utf-8` | NOT RUN |
| V-15 | Embed mode in a browser frame from another origin (a local test page that frames `?embed=true&displayNav=true`) | Renders; no `X-Frame-Options`; no console errors other than Tableau (see 1.6) | NOT RUN |
| V-16 | Widget loaded from another origin: a local test page with `<script src="<DistributionUrl>widget/main.js">` | Script loads and runs; no mixed-content error | NOT RUN |

### 1.4 HTTPS and headers

```powershell
curl.exe -s -o NUL -D - "$Base/"
curl.exe -s -o NUL -D - "http://$Domain/"
```

| ID | Check | Expected | Status |
|---|---|---|---|
| V-17 | HTTP to HTTPS | `http://` request gets `301` to the `https://` URL | NOT RUN |
| V-18 | Security headers on a page | `Strict-Transport-Security: max-age=31536000` (no `includeSubDomains`, no `preload`); `X-Content-Type-Options: nosniff`; `Referrer-Policy: strict-origin-when-cross-origin`; `Content-Security-Policy-Report-Only` present | NOT RUN |
| V-19 | No frame blocking | No `X-Frame-Options` header (the site and widget are embedded by design) | NOT RUN |
| V-20 | Indexing on `test` | `X-Robots-Tag: noindex, nofollow` present | NOT RUN |
| V-21 | TLS floor on `*.cloudfront.net` (P-26 outcome): `curl.exe -s -o NUL -w "%{http_code} %{ssl_version}" --tls-max 1.1 "$Base/"` | Record the outcome: a failed handshake means TLS 1.0 and 1.1 are refused; a returned code and version means they are accepted (a curl build without TLS-version options cannot run this probe: record that). Observe only. Record what is observed. The floor on the default certificate is AWS-managed and not changeable by this stack; the `TLSv1.2_2021` floor applies only after S3. | NOT RUN |

### 1.5 404 mapping and error cache

| ID | Check | Expected | Status |
|---|---|---|---|
| V-22 | Unknown path: `curl.exe -s -D - "$Base/__no-such-page__"` | Status `404` and the body of the 404 page (not an S3 XML error); the origin 403 is mapped to 404 | NOT RUN |
| V-23 | Unknown file: `"$Base/css/none.css"` | Status `404`, same page | NOT RUN |
| V-24 | Error cache | Repeat V-22 within 10 s: `X-Cache: Error from cloudfront` or a hit on the cached error; after 10 s a fresh fetch (`ErrorCachingMinTTL` 10 s) | NOT RUN |

### 1.6 Tableau

Tableau only allows framing from `*.cgiar.org`. On the default domain the frames show Tableau's embedding refusal.
That is expected, not a defect. These two checks run in S3.

| ID | Check | Status |
|---|---|---|
| V-25 | Tableau dashboards render | `BLOCKED (institutional domain not attached)` |
| V-26 | Tableau filters work | `BLOCKED (institutional domain not attached)` |

## 2. S2 premises and owners

| Premise | What S2 must establish | How | Owner |
|---|---|---|---|
| P-13b | Stack tags reach the CloudFront function and the budget | Run [TAG-CHECK.md](TAG-CHECK.md); a resource it cannot read is recorded `UNVERIFIED`, not passed | S2 validation |
| P-16b | The rewritten `uri` is the cached object; the function sees the full query even with query strings off | V-09, V-10 | S2 validation |
| P-20 | The default domain serves every route and caches each variant correctly | V-02 to V-11 | S2 validation |
| P-22 | `sam deploy` needs no artifact bucket (template under the direct-upload limit) | The size check in runbook section 3 and the deploy itself; no SAM-managed bucket appears | S2 validation |
| P-25 | Account, region and permissions exist | Written confirmation, **before G-DEPLOY** | Requester |
| P-26 outcome | The TLS floor on `*.cloudfront.net` is AWS-managed | V-21 | S2 validation |

## 3. Checks that close `UNVERIFIED` items from preparation

| Item | Check | Owner and moment |
|---|---|---|
| `sam deploy` accepts a template without `Transform` | `sam validate` and the deploy start (runbook sections 3 and 4). If rejected: stop, report, do not edit the template ad hoc. | Operator, S2 |
| `--parameter-overrides` replaces the `samconfig.toml` value | SAM prints the parameter overrides it received in the deploy header; confirm `Environment=test` and the other defaults are present there. After the deploy, `aws cloudformation describe-stacks --stack-name $Stack --query "Stacks[0].Parameters"` shows the effective values. | Operator, S2 |
| SAM accepts empty values (`Name=`) in `--parameter-overrides`, and an unnamed parameter keeps its previous value on an existing stack | The first deploy names the three domain parameters empty and must not fail. For the S3 rollback (explicit empty values) the change set must show `Modify` on `Distribution` and `EdgeFunction`; "No changes to deploy" means stop. | Operator, S2 (first deploy); Infrastructure, S3 |
| Empty-string outputs accepted on first create | Stack reaches `CREATE_COMPLETE` and the outputs list is complete. | Operator, S2 |
| Access-log delivery with the log bucket's TLS-deny policy | After V-02, objects appear under `test/` in the log bucket (allow time for delivery). | Operator, S2 |
| Deployer policy: `CloudFormationChangeSets` pattern `changeSet/samcli-deploy*/*` | The first deploy is not denied. If denied, check this statement first. | Operator with Infrastructure, S2 |
| Deployer policy: the seven wildcard or type-wide exceptions (`CloudFormationNoResourceLevel`, `CloudFrontCreateNoResourceLevel`, `TaggingRead`, `AcmListNoResourceLevel`, `CloudFrontDistributions`, `CloudFrontOacAndPolicies`, `AcmDescribeOnly`) | For each entry with `referenceStatus` `UNVERIFIED` in `infra/tagging.json`: read the cited AWS reference page, confirm the claim, set the status to verified or tighten the statement. | Leader/operator, S2 validation, **before G-DEPLOY sign-off** |
| Rollback permissions | `s3:ListBucketVersions` and `s3:DeleteObjectVersion` are not in the deployer policy; decide who holds them for content rollback. | Requester with Infrastructure, before G-DEPLOY |
| Cache-Control strings | Approve the two strings (runbook section 6). | Requester, at G-DEPLOY |

## 4. S3 re-checks

After Infrastructure attaches the institutional domain (certificate, alias, DNS, canonical host; see
[HANDOFF-INFRASTRUCTURE.md](HANDOFF-INFRASTRUCTURE.md)), repeat on the new hostname:

- [ ] V-01: `node scripts/verify-deploy.mjs --url <https-url-of-the-hostname>/ --release release/1f6d95a5`.
- [ ] Routes and redirects with the canonical host: the alternate host and any other `Host` get one `301` to the
      canonical host with the terminal path (V-02 to V-07 from the new hostname; V-05 and V-06 included).
- [ ] V-18, V-19: HSTS still without `includeSubDomains` or `preload`; still no `X-Frame-Options`.
- [ ] V-21: TLS floor is now `TLSv1.2_2021` (configured by the stack when the domain is attached).
- [ ] V-25: Tableau dashboards render (previously `BLOCKED (institutional domain not attached)`).
- [ ] V-26: Tableau filters work (previously `BLOCKED (institutional domain not attached)`).
- [ ] Pin `tableauHosts` once the real Tableau hosts are confirmed.
- [ ] Record the results as the S3 evidence; S4 needs them.
