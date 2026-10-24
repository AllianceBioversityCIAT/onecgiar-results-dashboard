// Playwright configuration (design.md 9, 10.1; T-12). Three browsers, three local servers
// (7.5 ports), html + json reporters under reports/e2e/ (FR-22).
//   8080  site with the routing rules (npm run serve)
//   8081  plain static server, no rules (widget test host, static-server.spec)
//   8090  second origin of the same dist/ (FR-04)
// E2E_DIST selects the folder to serve (default dist); the red-run procedure points it at a copy.
import { defineConfig, devices } from '@playwright/test';

const DIST = process.env.E2E_DIST || 'dist';
// `front` roots come first (first root wins): the 8081 widget host adds tests/fixtures/widget-host.
const serve = (port, extra = '', front = '') => ({
  command: `node scripts/serve.mjs${front} --root "${DIST}"${extra}`,
  env: { PORT: String(port) },
  url: `http://127.0.0.1:${port}/home${extra ? '.html' : ''}`,
  // The file index is a snapshot taken at start-up, so a stale server must never be reused.
  reuseExistingServer: false,
  timeout: 30_000,
  stdout: 'ignore',
  stderr: 'pipe',
});

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.mjs',
  outputDir: 'reports/e2e/artifacts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'reports/e2e/html', open: 'never' }],
    ['json', { outputFile: 'reports/e2e/results.json' }],
  ],
  use: {
    baseURL: 'http://localhost:8080',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: [serve(8080), serve(8081, ' --no-rules', ' --root tests/fixtures/widget-host'), serve(8090)],
});
