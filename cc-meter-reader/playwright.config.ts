// playwright.config.ts — end-to-end runs against the app with the in-browser Cribl emulator (MSW).
//
// The web server is Vite on 5174 (5173 is the author's live dev server) with VITE_MR_MOCK=1, so the app
// starts src/mock/browser.ts and talks to '/mock-api/v1' instead of a Leader.
//
// Projects: `chromium` (1440×900), `chromium-1920` (1920×1080) and `mobile` (390×844, touch) run by
// default. `firefox` and `webkit` run only when asked for — `--project=firefox`, `--project=webkit`
// (also `--project firefox webkit`, repeated flags and `*` wildcards), or MR_CROSS_BROWSER=1 — because only
// Chromium is installed on the build machine (`npx playwright install firefox webkit` adds the others).
// `--project=chromium` is the quick run.
//
// Why every project is always DEFINED: Playwright loads this file again in each worker process, and a
// worker's argv carries none of the runner's flags. A project defined only when argv asks for it would be
// missing in the worker ("Project … not found in the worker process"). So all five are always defined, and
// the two opt-in ones get a never-matching `grep` unless the runner's command line (or MR_CROSS_BROWSER=1)
// asks for them. Test selection happens in the runner; workers run the test ids they are handed and never
// read `grep`, so the worker's copy (where argv never asks) is harmless. Where there is no command line to
// read (UI mode, an editor extension), MR_CROSS_BROWSER=1 opts in.
//
// Artifacts: screenshots always, traces kept on failure, everything under tests/report/playwright.

import { defineConfig, devices, type Project } from '@playwright/test';

// MR_E2E_PORT lets parallel checkouts (git worktrees) run their own mock server side by side.
const PORT = Number(process.env.MR_E2E_PORT) || 5174;
const BASE_URL = `http://localhost:${PORT}`;

/** The `--project` values on the runner's command line (`--project=a`, `--project a b`, repeated flags). */
function projectArgs(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--project=')) out.push(arg.slice('--project='.length));
    else if (arg === '--project') for (; i + 1 < argv.length && !argv[i + 1].startsWith('-'); i++) out.push(argv[i + 1]);
  }
  return out.flatMap((value) => value.split(',')).filter(Boolean);
}

/** Playwright's own project matching: case-insensitive, `*` is a wildcard. */
const matchesProject = (pattern: string, name: string): boolean =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i').test(name);

const requested = projectArgs(process.argv.slice(2));
const wants = (name: string): boolean => process.env.MR_CROSS_BROWSER === '1' || requested.some((pattern) => matchesProject(pattern, name));
/** Matches no test title: keeps an opt-in project out of a run that did not ask for it. */
const NOT_REQUESTED = /(?!)/;

const desktop = { viewport: { width: 1440, height: 900 } };

const projects: Project[] = [
  { name: 'chromium', use: { ...devices['Desktop Chrome'], ...desktop } },
  { name: 'chromium-1920', use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } } },
  {
    name: 'mobile',
    use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  },
  { name: 'firefox', use: { ...devices['Desktop Firefox'], ...desktop }, ...(wants('firefox') ? {} : { grep: NOT_REQUESTED }) },
  { name: 'webkit', use: { ...devices['Desktop Safari'], ...desktop }, ...(wants('webkit') ? {} : { grep: NOT_REQUESTED }) },
];

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'tests/report/playwright',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list'], ['html', { outputFolder: 'tests/report/playwright-html', open: 'never' }], ['json', { outputFile: 'tests/report/playwright-results.json' }]],
  use: {
    baseURL: BASE_URL,
    screenshot: 'on',
    trace: 'retain-on-failure',
    video: 'off',
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'America/Chicago',
    serviceWorkers: 'allow', // MSW lives in a service worker
  },
  projects,
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: BASE_URL,
    env: { VITE_MR_MOCK: '1' },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
