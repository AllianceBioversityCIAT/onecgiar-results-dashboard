# CGIAR Results Dashboard - static site

A 100 % static build of the Results Dashboard: 17 pages, a widget script and local tooling to build, serve and test them on Windows. Node.js is the only thing you need to install. **PHP is not needed and must not be installed.**

## Quick path

Run these in Windows PowerShell (5.1 or 7) from this folder:

```powershell
npm ci                    # install the pinned dependencies
npm run build             # generate dist/
npm run serve             # serve dist/ at http://localhost:8080 (Ctrl+C to stop)
```

Open <http://localhost:8080/>. The home page should load. In a second window, run `npm test` to check the build.

If a command fails, see [Known issues](#known-issues).

## Prerequisites

| Need | Detail |
|---|---|
| Windows | Windows PowerShell 5.1 or PowerShell 7. No WSL, no Git Bash, no administrator rights |
| Node.js | 22 LTS (22.12 or later, below 23); `.nvmrc` says `22`. Includes `npm` |
| Git | Only to clone the repository |
| Network | `registry.npmjs.org` for `npm ci`; nothing else for build, serve and unit tests |
| PHP, Composer, Slim, Apache, PHP-FPM | **Not needed. Do not install them.** No script here uses them |

Check your tools:

```powershell
node -v
npm -v
Get-Command php -ErrorAction SilentlyContinue   # expected: prints nothing
```

## Commands

All commands run from the repository root.

| Task | Command | What you get |
|---|---|---|
| Install | `npm ci` | Exactly the versions in `package-lock.json`. No binaries are downloaded |
| Build | `npm run build` | `dist/` (static files only) and `artifacts/` (manifest, build history) |
| Serve | `npm run serve` | `dist/` at `http://localhost:8080`, loopback only. Stop with Ctrl+C |
| Unit tests | `npm test` | No network, no browser. Writes `reports/unit.xml` |
| E2E, one-time | `npx playwright install` | Downloads Chromium, Firefox and WebKit |
| E2E tests | `npm run test:e2e` | Starts its own servers (ports 8080, 8081, 8090). Writes `reports/e2e/` |
| Compare | `npm run compare` | Local build against the reference render (R1) and the requester screenshot (R2); PROD (R3) only if reachable. Writes `reports/compare/` |
| Evidence | `npm run evidence` | Consolidates reports into `summary.md` plus a copy of the raw reports. The default folder `docs/specs/changes/results-dashboard-aws-migration/evidence/<date>` is resolved against the **parent** of this repository, so it only works inside the full project layout. In a standalone clone use `npm run evidence -- --out .\evidence-out` (or `$env:EVIDENCE_OUT_DIR = ".\evidence-out"`) |

Notes:

- Run `npm run build` before `npm run serve`, `npm run test:e2e` and `npm run compare`; they use `dist/`.
- `npm run test:e2e` and `npm run serve` both use port 8080. Stop the server before running the E2E tests.
- `npm run compare` reads the requester screenshot (R2) from `..\docs\specs\changes\results-dashboard-aws-migration\evidence\reference\Screenshot 2026-10-23 160828.png`, relative to the **parent** of this repository. In a standalone clone R2 reports `FAILED requester screenshot not found` and the command exits 1; put that file at that relative path to avoid it.
- `npm run compare` contacts `https://results.cgiar.org` only with a single read-only probe. Run it only when you are authorized to.
- `npm run evidence` needs the reports of `npm test`, `npm run test:e2e` and `npm run compare`; run them first. It exits 1 while any criterion is `BLOCKED` or `NOT RUN` (expected on localhost); read `summary.md` for the counts.

### Optional environment variables

Set them for one command in PowerShell, then clear them:

```powershell
$env:PORT = 8081; npm run serve
Remove-Item Env:PORT
```

| Variable | Default | Effect |
|---|---|---|
| `PORT` | `8080` | Port of `npm run serve` |
| `BUILD_OUT_DIR` | `dist` | Output folder of the build |
| `BUILD_SRC_DIR` | `src` | Source folder of the build |
| `E2E_DIST` | `dist` | Folder the E2E servers serve |
| `COMPARE_DIST` | `dist` | Local build used by `npm run compare` |
| `EVIDENCE_*` | see `scripts/evidence.mjs` | Inputs and outputs of `npm run evidence` |

The other optional variables (build time budget, test seams) are listed in the design, section 9 (`docs/specs/changes/results-dashboard-aws-migration/design.md`).

## Known issues

| Symptom | Cause | Fix |
|---|---|---|
| `npm : File ...npm.ps1 cannot be loaded because running scripts is disabled on this system` | PowerShell execution policy blocks `npm.ps1` | Use `npm.cmd` and `npx.cmd` (for example `npm.cmd ci`, `npx.cmd playwright install`), or relax the policy for this window only: `Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned` |
| `serve: port 8080 is already in use ...` | Another program (or a previous `npm run serve`) holds the port | Stop it, or pick another port: `$env:PORT=8081; npm run serve` |
| Every E2E test fails with `browserType.launch: Executable doesn't exist at ...` followed by `Looks like Playwright was just installed or updated.` and `Please run the following command to download new browsers:` `npx playwright install` | Playwright browsers are not installed | Run `npx playwright install` once, then repeat `npm run test:e2e` |
| `npm run compare` reports R3 `BLOCKED (PROD unreachable)` | `https://results.cgiar.org` does not answer from this network (unreachable since 2026-10-23) | Expected. R1 and R2 still run. R3 is neither passed nor failed |
| Tableau tests report `BLOCKED (embedding)` | `tableau-core.cgiar.org` only allows being framed from `*.cgiar.org`, so views do not render from `localhost` | Expected. The test that checks the requested Tableau URL still passes; rendering can only be checked on a `*.cgiar.org` host |

## Folder structure

```text
results-dashboard-static/
├─ package.json, package-lock.json   scripts and pinned dev dependencies
├─ src/
│  ├─ templates/                     Twig page templates (copies of the originals)
│  ├─ data/site.json                 site settings and control lists
│  ├─ public/                        CSS, JS, images, fonts, CSV, JSON copied to dist/
│  ├─ runtime/                       browser scripts (URL parameters, filters, legacy shims)
│  └─ routing/rules.core.js          the single set of URL rules
├─ scripts/                          build, serve, compare and evidence tools (.mjs)
├─ tests/
│  ├─ unit/                          node:test suites (npm test)
│  ├─ e2e/                           Playwright specs (npm run test:e2e)
│  └─ cases/, golden/, helpers/, fixtures/
├─ reference/                        original templates and hashes, used only as the comparison oracle
└─ dist/, artifacts/, reports/, .cache/   generated, ignored by git
```

## Architecture

The site is built once and served as plain files.

- `npm run build` renders the Twig templates with twig.js into static `.html` files and copies the assets to `dist/`. There is no template engine, application server or database at run time.
- `dist/` contains only static files. It can be copied to any static file host unchanged; the local server only maps clean URLs (for example `/home`) to those files.
- Page behavior (year and CRP filters, partnerships variants, glossary) runs in the browser. Charts are Tableau views loaded from the external Tableau Server.
- Node.js is used to build, test and serve locally. It is not part of the deployed site.
