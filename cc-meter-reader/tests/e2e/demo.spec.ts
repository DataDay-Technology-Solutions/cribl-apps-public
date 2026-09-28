// tests/e2e/demo.spec.ts — the Demo Console (PRD 8.7, DESIGN_BRIEF 5.7, SPEC 11 / 13 / 17), DEMO BUILD ONLY.
//
// HOW TO RUN (the console is compiled only into the demo build):
//
//   VITE_MR_BUILD=demo npx playwright test tests/e2e/demo.spec.ts --project=chromium
//
// Playwright's webServer passes process.env through, so a FRESH server on 5174 is a demo build. If a
// release-build server is already running on 5174 it is reused, the page reports "release" in its footer,
// and every test here skips. To run beside other builders (and keep their `resetMock` off this origin's
// emulator state), start a demo server of your own and point the spec at it:
//
//   VITE_MR_MOCK=1 VITE_MR_BUILD=demo npx vite --port 5178 --strictPort &
//   MR_DEMO_BASE_URL=http://localhost:5178 npx playwright test tests/e2e/demo.spec.ts --project=chromium
//
// Time: the emulator's handlers run in the page, so `page.clock` fakes the Leader's clock and the app's
// together; the regression, its alert and the recovery are driven by fast-forwarding the clock and letting
// the UI runtime's own 30-second sweeps run. Screenshots land in tests/report/beauty/demo-<theme>-<width>.png;
// the mobile project writes only 390-wide files (never over the -1440 / -1920 ones).
//
// Every lever and scene start asks first (REVIEW-3a #7): the specs confirm through the dialog, and the key
// tests confirm with Enter (the confirm button has focus). A scene left in demo/state is never resumed on
// mount (REVIEW-3a #8).

import { expect, test, type Locator, type Page } from '@playwright/test';
import { bellMessages, gotoApp, kvGet, resetMock, setTheme, sinkDeliveries, trackConsoleErrors, type Theme } from './helpers/index.ts';
import { MOCK_USER } from '../../src/mock/types.ts';

if (process.env.MR_DEMO_BASE_URL) test.use({ baseURL: process.env.MR_DEMO_BASE_URL });

const MINUTE = 60_000;
const DAY = 86_400_000;
const BEAUTY = 'tests/report/beauty';
/** Wave-2 evidence (P2-W18 slice 2): tests/report/screens/wave2-l-<name>-<theme>-<width>.png. */
const SCREENS = 'tests/report/screens';
/**
 * Who a lever pulled from the console is recorded as: the member's "First Last" from getCriblUser()
 * (src/demo/client.ts criblUsername), exactly as the live org shows it ("Steve Koelpin", STATE.md). The
 * terminal lever (scripts/lever.ts) records MR_DEMO_AUTHOR, "s.koelpin", instead; this spec pulls levers
 * as the member only.
 */
const MEMBER_AUTHOR = `${MOCK_USER.firstName} ${MOCK_USER.lastName}`;
/** Everything below talks to one emulated org; the tests share it, so they run one after another. */
test.describe.configure({ mode: 'default' });

// ─── Seeding (full documents: KV guards reject partial settings) ─────────────
function settingsDoc(nowMs: number): Record<string, unknown> {
  return {
    schemaVersion: 1,
    updatedAt: new Date(nowMs).toISOString(),
    displayTimezone: 'America/Chicago',
    headlinePeriodDefault: 'mtd',
    presenter: {
      headlinePeriod: 'annualized',
      qrUrl: 'https://www.linkedin.com/groups/13052739', // the demo org's QR: the Cribl Innovators Network (D51)
    },
    live: { pollSeconds: 10, presenterPollSeconds: 5 },
    budgets: {},
    thresholds: {
      regressionPoints: 15,
      regressionMinutes: 3,
      regressionCommitWindowMin: 30,
      spikeSigma: 3,
      spikeMinutes: 2,
      spikeMinCentsPerHour: 500,
      budgetWarnPct: 90,
      budgetAlertPct: 100,
      goodNewsPoints: 15,
      cooldownMinutes: 60,
      ewmaAlpha: 0.0014,
      warmupSamples: 10,
      recoveryMinutes: 5,
    },
    goodNewsEnabled: false,
    excludedObjectKeys: [],
    includeInternal: false,
    // D57: no build stores a webhook URL; the stage webhook is the runner's (its .env), so the tab's endpoints are the
    // Cribl channels: here the default bell.
    notifications: [],
    humanize: {},
    demo: { enabled: true, replayMode: false, profile: true },
    runtime: 'ui',
  };
}

function pricesDoc(nowMs: number): Record<string, unknown> {
  const from = new Date(nowMs - 3 * DAY).toISOString();
  return {
    schemaVersion: 1,
    updatedAt: from,
    versions: [
      {
        effectiveFrom: from,
        byOutputId: {
          mrd_siem_prod: { milliCentsPerGb: 250_000, preset: 'splunk_cloud' },
          mrd_analytics: { milliCentsPerGb: 150_000, preset: 'datadog' },
          mrd_archive_s3: { milliCentsPerGb: 3_000, preset: 's3' },
        },
      },
    ],
  };
}

/** demo/state as the live org has it: the measured lag is 127 s (docs/LIVE_VALIDATION.md, run 1). */
function demoStateDoc(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: 1, routes: {}, measuredLagSec: 127, trim: {}, rates: {}, muted: {}, ...extra };
}

async function kvPut(page: Page, key: string, value: unknown): Promise<void> {
  const status = await page.evaluate(
    async ({ k, v }) => {
      const r = await fetch(`/mock-api/v1/kvstore/${k}`, {
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify(v),
      });
      return r.status;
    },
    { k: key, v: value },
  );
  expect(status, `PUT kvstore/${key}`).toBeLessThan(300);
}

/**
 * The shell footer's build flag ("v1.0.0 · demo build"), read by its test id and polled. A bare
 * `locator('footer')` also matched the Receipt's, the incident card's and the first-run card's <footer>
 * elements: in strict mode the read threw, the catch turned it into "", and demo-build tests were skipped as
 * "release" (1 of 30 in the baseline run, 5 of 36 once more tests shared the org).
 */
async function isDemoBuild(page: Page): Promise<boolean> {
  const build = page.getByTestId('footer-build');
  return expect
    .poll(async () => /demo build/i.test((await build.textContent({ timeout: 1_000 }).catch(() => '')) ?? ''), { timeout: 20_000 })
    .toBe(true)
    .then(() => true)
    .catch(() => false);
}

/**
 * A fresh emulated org with prices and demo mode on, the app hydrated on /demo and its first sweep done.
 * Returns the fake-clock "now" at start.
 */
async function openConsole(page: Page, opts: { clock?: boolean; demoState?: (nowMs: number) => Record<string, unknown> } = {}): Promise<number> {
  if (opts.clock !== false) await page.clock.install();
  await gotoApp(page, '/');
  test.skip(!(await isDemoBuild(page)), 'release build on this server: run with VITE_MR_BUILD=demo (see the header)');
  await resetMock(page);
  const now = await page.evaluate(() => Date.now());
  await kvPut(page, 'settings', settingsDoc(now));
  await kvPut(page, 'prices', pricesDoc(now));
  await kvPut(page, 'demo/state', opts.demoState ? opts.demoState(now) : demoStateDoc());
  // Before hydration the console shows its skeleton, never a false "Demo mode is off".
  let falseOff = false;
  const watch = page
    .waitForSelector('[data-testid="demo-off"]', { timeout: 15_000 })
    .then(async () => {
      falseOff = (await page.locator('html[data-mr-hydrated="true"]').count()) === 0;
    })
    .catch(() => undefined);
  await gotoApp(page, '/demo');
  await expect(page.getByTestId('demo-console')).toBeVisible();
  expect(falseOff).toBe(false);
  void watch;
  await waitForSweep(page);
  return now;
}

/** Lets the UI runtime sweep: fast-forwards the fake clock past its next tick, then waits for "Metering live". */
async function waitForSweep(page: Page, timeoutMs = 20_000): Promise<void> {
  const before = await sweptAt(page);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await page.clock.fastForward(5_000).catch(() => undefined);
    await page.waitForTimeout(250);
    const after = await sweptAt(page);
    if (after && after !== before) break;
    if (Date.now() > deadline) throw new Error('no sweep landed');
  }
  await expect(page.getByTestId('demo-status')).toContainText(/Metering live/);
}

async function sweptAt(page: Page): Promise<string | null> {
  const meta = await kvGet(page, 'meta');
  if (!meta) return null;
  try {
    return (JSON.parse(meta) as { lastSweepAt?: string }).lastSweepAt ?? null;
  } catch {
    return null;
  }
}

/**
 * Console errors, minus the emulator's missing bell endpoint: the sweep's Cribl-bell delivery (core/delivery.ts,
 * D23) posts to /system/messages, which src/mock does not emulate yet, so the browser logs a 404 resource
 * error. That gap belongs to the mock/delivery owners; everything else still fails the test.
 */
function consoleErrors(page: Page): () => string[] {
  const all = trackConsoleErrors(page);
  return () => all().filter((e) => !/404 \(Not Found\) \(http:\/\/[^)]*\/mock-api\/v1\/system\/messages\)/.test(e));
}

/** Advances fake time in sweep-sized steps until `until()` holds (each step lets a real sweep finish). */
async function advanceUntil(page: Page, until: () => Promise<boolean>, maxFakeMs: number, label: string): Promise<void> {
  let elapsed = 0;
  while (!(await until())) {
    if (elapsed >= maxFakeMs) throw new Error(`${label}: not within ${maxFakeMs / 1000} s of fake time`);
    await page.clock.fastForward(15_000);
    elapsed += 15_000;
    // Real time for the sweep's KV and metrics round-trips and the next poll.
    await page.waitForTimeout(700);
  }
}

/**
 * Waits for the lever in flight to finish. A lever pulled right after a sweep may be refused for the
 * minute's Leader budget (the first sweep backfills an hour) and retried after a countdown; the fake clock
 * is moved through that countdown.
 */
async function settleLever(page: Page, timeoutMs = 60_000): Promise<void> {
  const activity = page.getByTestId('demo-activity');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await activity.getAttribute('data-state');
    if (state === 'idle') {
      const last = await activity.getAttribute('data-last');
      expect(last === null || last === 'ok' || last === 'cancelled' || last === 'busy', `last lever outcome: ${last}`).toBe(true);
      return;
    }
    if (Date.now() > deadline) throw new Error(`lever still ${state}`);
    if (state === 'retry') await page.clock.fastForward(10_000);
    await page.waitForTimeout(300);
  }
}

async function timelineCommits(page: Page): Promise<{ hash: string; message: string; author: string; source?: string }[]> {
  const raw = await kvGet(page, 'timeline');
  if (!raw) return [];
  const doc = JSON.parse(raw) as {
    byGroup: Record<string, { hash: string; message: string; author: string; source?: string }[]>;
  };
  return Object.values(doc.byGroup).flat();
}

/**
 * Full-page shots un-stick the pinned bars (a full-page capture would paint them mid-page); viewport shots
 * show the phone exactly as held.
 */
async function shoot(page: Page, theme: Theme, name = 'demo', fullPage = true, dir = BEAUTY): Promise<void> {
  const width = page.viewportSize()?.width ?? 0;
  // The mobile project (DPR 3) writes phone frames only; desktop-width files belong to the desktop projects.
  if (test.info().project.name === 'mobile' && width !== 390) return;
  await setTheme(page, theme);
  await page.waitForTimeout(150);
  await page.screenshot({
    path: `${dir}/${name}-${theme}-${width}.png`,
    fullPage,
    animations: 'disabled',
    // `.mr-topnav` relative: the shell's visually-hidden status label escapes its scrolling tab row at 390 px
    // in the demo build (five tabs) and widens the document — reported to the shell owner.
    ...(fullPage
      ? {
          style:
            '.mr-demo-status, .mr-demo-bottombar, .mr-shell-header { position: static !important; } .mr-topnav { position: relative !important; }',
        }
      : {}),
  });
}

/** Nothing in the console reaches past the viewport, and no heading or paragraph overflows its own box. */
async function expectNoOverflow(page: Page): Promise<void> {
  const width = page.viewportSize()?.width ?? 0;
  const bad = await page.evaluate((w) => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-testid="demo-console"] *'))) {
      if (el.closest('.mr-visually-hidden') || el.offsetParent === null) continue;
      const box = el.getBoundingClientRect();
      if (box.right > w + 0.5) out.push(`past the edge: ${el.tagName}.${String(el.className).slice(0, 50)}`);
      if (/^(P|H1|H2|H3)$/.test(el.tagName) && el.scrollWidth > el.clientWidth + 1)
        out.push(`text overflow: ${el.tagName}.${String(el.className).slice(0, 50)}`);
    }
    return out;
  }, width);
  expect(bad).toEqual([]);
}

/**
 * The confirmation for a lever or scene: checks it names `ids` and (for Cribl changes) the worker group,
 * then presses `button` (or Enter / Cancel). Returns the dialog.
 */
async function confirmLever(
  page: Page,
  opts: { title: string | RegExp; ids?: string[]; deploys?: boolean; press: string | 'Enter' | 'Cancel' },
): Promise<Locator> {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading')).toHaveText(opts.title);
  for (const id of opts.ids ?? []) await expect(dialog.locator('code', { hasText: id }).first()).toBeVisible();
  const deploy = dialog.getByTestId('demo-confirm-deploy');
  if (opts.deploys === false) await expect(deploy).toHaveText('Nothing in Cribl changes.');
  else await expect(deploy).toHaveText('Commits and deploys to worker group default.');
  if (opts.press === 'Enter') await page.keyboard.press('Enter');
  else await dialog.getByRole('button', { name: opts.press, exact: true }).click();
  await expect(dialog).toBeHidden();
  return dialog;
}

/**
 * WCAG contrast of an element's text (or, with `edge`, its top border) against the first opaque background
 * behind it — the element's own, else the nearest ancestor's. Colours are read from getComputedStyle, so the
 * measurement follows the layout and both themes (the audit's contrast.py cropped fixed pixel boxes).
 */
async function contrastOf(loc: Locator, edge = false): Promise<number> {
  return loc.evaluate((el, useEdge) => {
    const parse = (c: string): [number, number, number, number] => {
      const n = (c.match(/[\d.]+/g) ?? []).map(Number);
      if (c.startsWith('color(')) return [n[0]! * 255, n[1]! * 255, n[2]! * 255, n[3] ?? 1];
      return [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 1];
    };
    const lum = ([r, g, b]: number[]) => {
      const ch = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(r!) + 0.7152 * ch(g!) + 0.0722 * ch(b!);
    };
    const start = useEdge ? el.parentElement : el;
    let bg: number[] | null = null;
    for (let node: Element | null = start; node && !bg; node = node.parentElement) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c[3] > 0.99) bg = c;
    }
    const cs = getComputedStyle(el);
    const fg = parse(useEdge ? cs.borderTopColor : cs.color);
    const [hi, lo] = [lum(fg), lum(bg ?? [255, 255, 255])].sort((a, b) => b - a);
    return (hi! + 0.05) / (lo! + 0.05);
  }, edge);
}

async function boxHeight(page: Page, selector: string): Promise<number[]> {
  return page
    .locator(selector)
    .evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => e.getBoundingClientRect().height));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('phone layout: status pinned, 48 px buttons, one column, no horizontal scroll, both themes', async ({ page }) => {
  const errors = consoleErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openConsole(page);

  // Every visible lever button is at least 48 px tall (PRD 8.8 item 9).
  const heights = await boxHeight(page, '[data-testid="demo-console"] button');
  expect(heights.length).toBeGreaterThan(8);
  for (const h of heights.filter((x) => x > 30)) expect(h).toBeGreaterThanOrEqual(47.5);
  // Nothing in the console reaches past 390 px. (The shell's tab row is measured separately: with the
  // Demo tab its visually-hidden status label escapes the scrolling tab row — reported to the shell owner.)
  await expectNoOverflow(page);
  test.info().annotations.push({
    type: 'document scrollWidth at 390',
    description: String(await page.evaluate(() => document.documentElement.scrollWidth)),
  });
  // The payoff levers are in the bottom bar under the thumb.
  const bar = page.getByTestId('demo-bottombar');
  await expect(bar).toBeVisible();
  const barBox = await bar.boundingBox();
  expect(barBox!.y + barBox!.height).toBeGreaterThan(844 - 100);
  // The status line leads on the phone and stays pinned while scrolling.
  const title = await page.getByRole('heading', { name: 'Demo Console', level: 1 }).boundingBox();
  expect((await page.getByTestId('demo-status').boundingBox())!.y).toBeLessThan(title!.y);
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(200);
  const status = await page.getByTestId('demo-status').boundingBox();
  expect(status!.y).toBeLessThan(120);
  await page.mouse.wheel(0, -2000);

  // One status line at idle on the phone (P1-L03): the idle "Ready" row is visually hidden, still a live region.
  // (Back at the top first: Firefox finishes the wheel scroll above smoothly, after the call returns.)
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  const statusBox = (await page.getByTestId('demo-status').boundingBox())!;
  expect(statusBox.height).toBeLessThan(48);
  await expect(page.getByTestId('demo-activity')).toHaveAttribute('role', 'status');
  // 'Payments API' once in the trim group, not again as the rate's title and state (P1-L03).
  await expect(page.getByTestId('demo-rate').getByRole('heading')).toHaveText('Datagen rate');
  await expect(page.getByTestId('demo-rate-state')).toHaveText('1× · normal');
  await expect(page.getByTestId('demo-rate')).not.toContainText('Payments API');
  // What the room sees, one line under the pinned status (P2-W18): the presenter hero's figure and the alert.
  const projector = page.getByTestId('demo-projector');
  await expect(projector).toHaveText(/^Projector: \$[\d,]+ · no alert$/);
  const projectorBox = (await projector.boundingBox())!;
  expect(projectorBox.height).toBeLessThan(24);
  expect(projectorBox.y).toBeGreaterThanOrEqual(statusBox.y + statusBox.height);

  // The alert is expected ~2:07 after a break: demo/state's measured lag (127 s), not the 4-minute default.
  await expect(page.getByTestId('demo-alert-eta')).toHaveText('Alert expected in ~2:07 after a break · measured lag');
  await expect(page.getByTestId('demo-trim-eta')).toHaveText('Alert expected in ~2:07 after a break · measured lag');
  // No lever pulled yet: the ledger says what will land there (P2-W18 slice 2).
  await expect(page.getByTestId('demo-ledger-empty')).toHaveText('No levers pulled yet. Each one lands here with its commit id and who pulled it.');

  // No scaffolding (BEAUTY F15): no tier chips, no "not in this build" rows, unsupported scenes hidden.
  const consoleText = (await page.getByTestId('demo-console').textContent()) ?? '';
  expect(consoleText).not.toMatch(/Tier 2|not in this build|Budget pace/);
  await expect(page.locator('[data-testid="demo-scenes"] [data-scene]')).toHaveCount(5);
  // Disabled buttons are quieter than enabled ones: no fill, no shadow. Enabled Break the trim keeps its danger fill.
  const style = (loc: Locator) =>
    loc.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, shadow: cs.boxShadow, color: cs.color };
    });
  const restore = await style(page.getByTestId('demo-bottombar').getByRole('button', { name: 'Restore' }));
  expect(restore.bg).toBe('rgba(0, 0, 0, 0)');
  expect(restore.shadow).toBe('none');
  const breakBtn = await style(page.getByTestId('demo-bottombar').getByRole('button', { name: 'Break the trim' }));
  expect(breakBtn.bg).not.toBe('rgba(0, 0, 0, 0)');

  for (const theme of ['light', 'dark'] as const) {
    await shoot(page, theme, 'demo-idle');
    await shoot(page, theme, 'demo-idle-phone', false);
  }
  expect(errors()).toEqual([]);
});

test('break → the regression names the trim commit, not the pack commit 40 s earlier → restore → recovery', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = consoleErrors(page);
  // Record the remote's cues (P2-W18): every navigator.vibrate pattern, and every status-line flash.
  await page.addInitScript(() => {
    const w = window as unknown as { __vibrations: number[][]; __flashes: number };
    w.__vibrations = [];
    w.__flashes = 0;
    Object.defineProperty(Navigator.prototype, 'vibrate', {
      configurable: true,
      value: (pattern: number[]) => {
        w.__vibrations.push([...pattern]);
        return true;
      },
    });
    new MutationObserver((records) => {
      for (const r of records) if ((r.target as Element).getAttribute?.('data-flash') === 'true') w.__flashes += 1;
    }).observe(document, { attributes: true, attributeFilter: ['data-flash'], subtree: true });
  });
  const cues = () => page.evaluate(() => (window as unknown as { __vibrations: number[][]; __flashes: number }).__vibrations);
  const flashes = () => page.evaluate(() => (window as unknown as { __flashes: number }).__flashes);
  await page.setViewportSize({ width: 390, height: 844 });
  await openConsole(page);

  // Apply the pack on Windows workstations: one lever in flight, every other lever disabled, then applied.
  const windows = page.locator('[data-stream="windows_workstations"]');
  await windows.getByRole('button', { name: /Apply the pack to Windows workstations/ }).click();
  // Nothing runs until the confirmation, which names the route, the pipelines and the worker group.
  await expect(page.getByTestId('demo-activity')).toHaveAttribute('data-state', 'idle');
  await confirmLever(page, {
    title: 'Apply the Windows XML pack to Windows workstations?',
    ids: ['mrd_windows_workstations', 'default'],
    press: 'Apply the pack',
  });
  await expect(page.getByTestId('demo-activity')).toHaveAttribute('data-state', /running|retry/);
  await expect(page.getByRole('button', { name: /Apply the pack to Palo Alto/ })).toBeDisabled();
  await settleLever(page);
  await expect(page.getByTestId('demo-level-windows_workstations')).toHaveText(/Pack applied/, { timeout: 20_000 });

  // 40 s later, break the trim — behind a confirmation that names the pipeline (SPEC 17).
  await page.clock.fastForward(40_000);
  // The console's fill at rest (read before the click: WebKit keeps the clicked button :hover, and the hover
  // step is darker).
  const consoleBg = await page
    .getByTestId('demo-bottombar')
    .getByRole('button', { name: 'Break the trim' })
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.getByTestId('demo-bottombar').getByRole('button', { name: 'Break the trim' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Break the trim on Payments API sampling?');
  await expect(dialog).toContainText('mrd_pay_sample');
  await expect(dialog).toContainText('Alert expected in ~2:07 (measured lag).');
  // Break the trim keeps its danger variant: the confirm button is filled like the console's danger button.
  const confirmBg = await dialog.getByRole('button', { name: 'Break the trim' }).evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(confirmBg).toBe(consoleBg);
  // …and a danger glyph, not Modal.confirm's amber info icon (P1-L03): the icon slot is repainted in the
  // danger foreground through Capra's AttentionSolid path.
  const glyph = await dialog.locator('[data-appearance="default"][aria-hidden="true"]').evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, mask: cs.maskImage || cs.webkitMaskImage, svg: getComputedStyle(el.querySelector('svg')!).visibility };
  });
  expect(glyph.mask).toContain('svg');
  expect(glyph.svg).toBe('hidden');
  expect(glyph.bg).toBe('rgb(206, 44, 49)'); // color.foreground.danger.default (light)
  // Enter confirms: the confirm button has focus.
  await expect(dialog.getByRole('button', { name: 'Break the trim' })).toBeFocused();
  await shoot(page, 'light', 'demo-confirm', false);
  await shoot(page, 'dark', 'demo-confirm', false);
  await setTheme(page, 'light');
  await confirmLever(page, { title: 'Break the trim on Payments API sampling?', ids: ['mrd_pay_sample'], press: 'Break the trim' });
  await settleLever(page);
  await expect(page.getByTestId('demo-trim-state')).toHaveText(/Trim broken/, {
    timeout: 20_000,
  });

  // The lever becomes the countdown (P2-W18): the bottom bar's Break slot reads "Alert in ~m:ss", disabled,
  // with a red edge, beside Restore.
  const bar = page.getByTestId('demo-bottombar');
  const countdown = bar.getByTestId('demo-lever-countdown').getByRole('button');
  await expect(countdown).toHaveText(/^Alert in ~?\d:\d\d$/);
  await expect(countdown).toBeDisabled();
  expect(await countdown.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe('rgb(229, 72, 77)'); // the incident red (--mr-fill-incident-high)
  await expect(bar.getByRole('button', { name: 'Restore' })).toBeEnabled();
  expect(await cues()).toEqual([]);

  // The console counts down to the expected alert from the measured lag.
  await expect(
    page.getByRole('heading', {
      name: /Next alert expected in ~\d:\d\d|Alert due any moment/,
    }),
  ).toBeAttached();
  await expect(page.getByTestId('demo-next-alert')).toHaveText(/^(~\d:\d\d|0:00)$/);
  // "Trim broken just now" / "12 s ago" — never "0:00 ago" (P1-L03).
  const waitingText = (await page.getByTestId('demo-console').textContent()) ?? '';
  expect(waitingText).toMatch(/Trim broken (just now|\d+ s ago|\d+ min ago)/);
  expect(waitingText).not.toMatch(/\d:\d\d ago|ago ago/);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expectNoOverflow(page);
  await shoot(page, 'light', 'demo-waiting', false);
  await shoot(page, 'dark', 'demo-waiting', false);
  // The laptop's page lever counts down the same way (its Break slot, keyed B / R).
  if (test.info().project.name !== 'mobile') {
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId('demo-trim').getByTestId('demo-lever-countdown').getByRole('button')).toHaveText(/^Alert in ~?\d:\d\d$|^Alert due any moment$/);
    for (const theme of ['light', 'dark'] as const) await shoot(page, theme, 'demo-waiting', false);
    await page.setViewportSize({ width: 390, height: 844 });
  }
  await setTheme(page, 'light');

  const commits = await timelineCommits(page);
  const trim = commits.find((c) => c.message === 'demo: break the trim on mrd_pay_sample');
  const pack = commits.find((c) => /demo: apply the pack on mrd_(rt_)?windows_workstations/.test(c.message));
  expect(trim, 'trim commit in the timeline').toBeTruthy();
  expect(pack, 'pack commit in the timeline').toBeTruthy();
  expect(trim!.author).toBe(MEMBER_AUTHOR);

  // The UI runtime's sweeps catch the regression (demo profile: 1-minute confirmation).
  const card = page.locator('[data-testid="demo-alert"] article');
  await advanceUntil(
    page,
    async () => (await card.count()) > 0 && /Savings dropped/.test((await card.first().textContent()) ?? ''),
    6 * MINUTE,
    'regression alert',
  );
  // On the projector (P2-W18 slice 2): the laptop console's miniature stage shows the takeover the room sees —
  // the same title, the drop and the money — and says how long it stays up.
  if (test.info().project.name !== 'mobile') {
    await page.setViewportSize({ width: 1440, height: 900 });
    const onStage = page.getByTestId('demo-projector-panel');
    await expect(onStage).toHaveAttribute('data-takeover', 'alert');
    const mini = onStage.getByTestId('demo-stage-takeover');
    await expect(mini).toContainText('Savings dropped: Payments API sampling');
    await expect(mini).toContainText(/\d+% → \d+%/);
    await expect(mini).toContainText(/\$[\d,]+ a day · \$[\d,]+ a year if left/);
    await expect(onStage.getByTestId('demo-stage-state')).toHaveText(/^Takeover on screen · clears in 0:\d\d, or on any key$/);
    for (const [width, height] of [
      [1440, 900],
      [1920, 1080],
      [1280, 720],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => window.scrollTo(0, 0));
      for (const theme of ['light', 'dark'] as const) await shoot(page, theme, 'wave2-l-takeover', false, SCREENS);
    }
    await setTheme(page, 'light');
    await page.setViewportSize({ width: 390, height: 844 });
  }
  const commitLine = card.locator('[data-callout="commit"]');
  await expect(commitLine).toContainText(trim!.hash.slice(0, 7));
  await expect(commitLine).not.toContainText(pack!.hash.slice(0, 7));
  await expect(card.locator('[data-callout="author"]')).toHaveText(MEMBER_AUTHOR);
  await expect(card.locator('[data-callout="per-day"]')).toContainText(/a day/);
  // The remote felt it (P2-W18): one [40, 60, 40] buzz and one status flash for the one new alert; the bar is
  // now a single Restore, and the projector strip says an alert is open.
  expect(await cues()).toEqual([[40, 60, 40]]);
  expect(await flashes()).toBe(1);
  await expect(bar.getByRole('button')).toHaveCount(1);
  await expect(bar.getByRole('button')).toHaveText('Restore');
  await expect(page.getByTestId('demo-projector')).toHaveText(/ · alert open$/);
  // The lever ledger (P2-W18 slice 2): both levers as real commits with their ids and the member's name, newest
  // first; the break carries the "caught in" the incident card prints, the pack apply 40 s earlier does not.
  const ledgerItems = page.getByTestId('demo-ledger').getByTestId('demo-ledger-item');
  await expect(ledgerItems).toHaveCount(2);
  await expect(ledgerItems.nth(0)).toHaveAttribute('data-lever', 'breakTrim');
  await expect(ledgerItems.nth(0)).toHaveAttribute('data-hash', trim!.hash.slice(0, 7));
  await expect(ledgerItems.nth(0)).toContainText('Break the trim · Payments API sampling');
  await expect(ledgerItems.nth(0)).toContainText(new RegExp(`${MEMBER_AUTHOR} · deployed · caught in \\d+:\\d\\d`));
  // Once the card's clock stops (the delivery landed) it prints the same measured figure.
  const cardCaught = card.first().locator('.mr-inc-caught');
  await expect(cardCaught).not.toHaveAttribute('data-live', 'true', { timeout: 20_000 });
  const measured = ((await cardCaught.textContent()) ?? '').match(/\d+:\d\d/)?.[0];
  await expect(ledgerItems.nth(0)).toContainText(`caught in ${measured}`);
  await expect(ledgerItems.nth(1)).toHaveAttribute('data-lever', 'applyPack');
  await expect(ledgerItems.nth(1)).toHaveAttribute('data-hash', pack!.hash.slice(0, 7));
  await expect(ledgerItems.nth(1)).toContainText('Apply the pack · Windows workstations');
  await expect(ledgerItems.nth(1)).not.toContainText('caught in');

  // The incident card fits a 390 × 844 phone without scrolling.
  await page.evaluate(() => window.scrollTo(0, 0));
  const cardBox = await card.first().boundingBox();
  expect(cardBox!.y).toBeGreaterThanOrEqual(0);
  expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(844 - 72);
  await expectNoOverflow(page);

  for (const theme of ['light', 'dark'] as const) {
    await shoot(page, theme, 'demo-incident', false);
    await shoot(page, theme);
    await shoot(page, theme, 'wave2-l-incident', true, SCREENS);
  }
  await ledgerItems.nth(0).scrollIntoViewIfNeeded();
  for (const theme of ['light', 'dark'] as const) await shoot(page, theme, 'wave2-l-ledger', false, SCREENS);
  for (const width of [1440, 1920]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 1080 });
    await page.evaluate(() => window.scrollTo(0, 0));
    for (const theme of ['light', 'dark'] as const) {
      await shoot(page, theme);
      await shoot(page, theme, 'wave2-l-incident', true, SCREENS);
    }
    await ledgerItems.nth(0).scrollIntoViewIfNeeded();
    for (const theme of ['light', 'dark'] as const) await shoot(page, theme, 'wave2-l-ledger', false, SCREENS);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await setTheme(page, 'light');

  // Restore: same path back (asked first); the incident closes itself.
  await page.getByTestId('demo-bottombar').getByRole('button', { name: 'Restore' }).click();
  await confirmLever(page, { title: 'Restore the trim on Payments API sampling?', ids: ['mrd_pay_sample'], press: 'Restore' });
  await settleLever(page);
  await expect(page.getByTestId('demo-trim-state')).toHaveText(/Trim intact/, {
    timeout: 20_000,
  });
  expect((await timelineCommits(page)).some((c) => c.message === 'demo: restore the trim on mrd_pay_sample')).toBe(true);
  await advanceUntil(
    page,
    async () => /Recovered/.test((await page.getByTestId('demo-alert').textContent()) ?? ''),
    8 * MINUTE,
    'recovery',
  );
  await expect(page.getByTestId('demo-open-alerts')).toHaveText(/0 open alerts/);
  await page.evaluate(() => window.scrollTo(0, 0));
  for (const theme of ['light', 'dark'] as const) await shoot(page, theme, 'demo-recovered', false);
  expect(errors()).toEqual([]);
});

test('lever keys: every key asks first and Enter confirms; keys wait while a question or a lever is up', async ({ page }) => {
  test.setTimeout(120_000);
  await openConsole(page);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('2');
  await expect(page.locator('.mr-chip')).toHaveText('Apply the pack: Palo Alto');
  // The key opened the same question the button opens; nothing ran yet, and other keys do nothing meanwhile.
  await expect(page.getByRole('dialog')).toContainText('Apply the Palo Alto pack to Palo Alto firewalls?');
  await expect(page.getByTestId('demo-activity')).toHaveAttribute('data-state', 'idle');
  await page.keyboard.press('0');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.getByRole('dialog').getByRole('heading')).toHaveText('Apply the Palo Alto pack to Palo Alto firewalls?');
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Apply the pack' })).toBeFocused();
  await shoot(page, 'light', 'demo-confirm-key', false);
  await shoot(page, 'dark', 'demo-confirm-key', false);
  await setTheme(page, 'light');
  await expect(page.getByRole('dialog')).toContainText('pipeline mrd_passthrough → mrd_pan_pack');
  await confirmLever(page, { title: 'Apply the Palo Alto pack to Palo Alto firewalls?', ids: ['mrd_pan_firewall'], press: 'Enter' });
  await expect(page.getByTestId('demo-activity')).toHaveAttribute('data-state', /running|retry/);
  // A second key while the lever runs only shows the busy chip.
  await page.keyboard.press('3');
  await expect(page.locator('.mr-chip')).toHaveText(/A lever is running/);
  await settleLever(page);
  await expect(page.getByTestId('demo-level-pan_firewall')).toHaveText(/Pack applied/, { timeout: 20_000 });
  await expect(page.getByTestId('demo-level-vpc_flow')).toHaveText(/Raw/);

  await page.keyboard.press('b');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Break the trim on Payments API sampling?');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('demo-trim-state')).toHaveText(/Trim intact/);

  // Esc cancels too: nothing changes.
  await page.keyboard.press('0');
  await expect(page.getByRole('dialog').getByRole('heading')).toHaveText('Reset everything to baseline?');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByTestId('demo-activity')).toHaveAttribute('data-state', 'idle');

  // V reverts every applied pack, after its question.
  await page.keyboard.press('v');
  await expect(page.locator('.mr-chip')).toHaveText('Revert all');
  await confirmLever(page, { title: 'Revert every applied pack?', ids: ['mrd_pan_firewall'], press: 'Enter' });
  await settleLever(page);
  await expect(page.getByTestId('demo-level-pan_firewall')).toHaveText(/Raw/, {
    timeout: 20_000,
  });
});

test('lever keys work on the presenter stage with the console never mounted; the console adopts that lever', async ({ page }) => {
  test.setTimeout(120_000);
  await openConsole(page);
  // A fresh page load straight into presenter mode: only the boot-time install in src/main.tsx can have
  // registered the lever keys, because the Demo Console is not on this page.
  await gotoApp(page, '/?present=1');
  await expect(page.getByTestId('demo-console')).toHaveCount(0);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('2');
  await expect(page.locator('.mr-chip')).toHaveText('Apply the pack: Palo Alto');
  // The same confirmation opens on the stage; Enter pulls the lever.
  await confirmLever(page, { title: 'Apply the Palo Alto pack to Palo Alto firewalls?', ids: ['mrd_pan_firewall'], press: 'Enter' });
  // Leave the stage and open the console in-app: one runtime per page, so it shows the lever already running.
  await page.keyboard.press('p');
  await page.getByRole('navigation').first().locator('a[href*="/demo"]').first().click();
  await expect(page.getByTestId('demo-console')).toBeVisible();
  await settleLever(page);
  await expect(page.getByTestId('demo-level-pan_firewall')).toHaveText(/Pack applied/, { timeout: 20_000 });
});

test('a budget refusal retries with a visible countdown the member can cancel', async ({ page }) => {
  test.setTimeout(120_000);
  await openConsole(page);
  // Spend this minute's Leader budget on "levers" (SPEC 7: sweeps + levers share 45 of the 50).
  const minute = await page.evaluate(() => new Date().toISOString().slice(0, 16));
  const demo = await kvGet(page, 'demo/state');
  const state = demo
    ? (JSON.parse(demo) as Record<string, unknown>)
    : demoStateDoc();
  await kvPut(page, 'demo/state', {
    ...state,
    leverCalls: { minute, calls: 45 },
  });

  const h1 = page.getByRole('heading', { name: 'Demo Console', level: 1 });
  const idleTop = (await h1.boundingBox())!.y;
  await page.getByRole('button', { name: /Apply the pack to AWS VPC Flow Logs/ }).click();
  await confirmLever(page, { title: 'Apply the VPC Flow aggregation to AWS VPC Flow Logs?', ids: ['mrd_vpc_flow'], press: 'Apply the pack' });
  const activity = page.getByTestId('demo-activity');
  await expect(activity).toHaveAttribute('data-state', 'retry', {
    timeout: 15_000,
  });
  // On the laptop the status card sits beside the title and grows here; the title stays put (P1-L03). (On the
  // phone the pinned card leads the page, so it moves the title by design.)
  if ((page.viewportSize()?.width ?? 0) >= 1024) expect(Math.abs((await h1.boundingBox())!.y - idleTop)).toBeLessThan(0.5);
  // The status line's icon sits on its first line, whatever the text wraps to.
  const iconBox = (await activity.locator('.mr-demo-activity-icon').boundingBox())!;
  const leverBox = (await activity.locator('.mr-demo-activity-lever').boundingBox())!;
  expect(Math.abs(iconBox.y + iconBox.height / 2 - (leverBox.y + leverBox.height / 2))).toBeLessThan(3);
  await expect(activity).toContainText(/The Leader budget is spent for this minute\. Retrying in \d:\d\d/);
  await shoot(page, 'light', 'demo-retry', false);
  await activity.getByRole('button', { name: 'Cancel retry' }).click();
  await expect(page.getByText('Retry cancelled. Nothing changed.')).toBeVisible();
  await expect(activity).toHaveAttribute('data-state', 'idle');
  await expect(page.getByTestId('demo-level-vpc_flow')).toHaveText(/Raw/);
});

test('Savings scene: progress line, then one-tap abort restores the pack', async ({ page }) => {
  test.setTimeout(180_000);
  await openConsole(page);
  await page.getByRole('button', { name: 'Start the Savings scene' }).click();
  await confirmLever(page, { title: 'Start the Savings scene?', ids: ['mrd_windows_workstations'], press: 'Start the scene' });
  const running = page.getByTestId('demo-scene-running');
  await expect(running).toBeVisible();
  await settleLever(page);
  await expect(page.getByTestId('demo-level-windows_workstations')).toHaveText(/Pack applied/, { timeout: 20_000 });
  await expect(running).toHaveAttribute('data-step', /narrowing|holding/);
  // The run of show (P2-W18 slice 2): the scene as timed beats — the apply done at 0:00 as recorded, what is
  // still to come planned with "~" — and one caret, on the beat that happens next.
  const beats = running.getByTestId('demo-run-of-show').getByTestId('demo-show-beat');
  await expect(beats).toHaveCount(3);
  await expect(beats.nth(0)).toHaveAttribute('data-state', 'done');
  await expect(beats.nth(0)).toHaveText(/^Apply the pack · Windows workstations · done0:00$/);
  await expect(beats.nth(1)).toHaveAttribute('data-label', 'narrowed');
  await expect(beats.nth(1)).toHaveText(/^The ribbon narrows( · done)?~?\d:\d\d$/);
  await expect(beats.nth(2)).toHaveText(/^Revert · Windows workstations~\d:\d\d$/);
  await expect(running.locator('[aria-current="step"]')).toHaveCount(1);
  await expect(running).toContainText('Times from the start of the scene; ~ marks an estimate.');
  // The stage's scene indicator (mirrored in the laptop's miniature) names the step in words, never "1:wait".
  if (test.info().project.name !== 'mobile') {
    await expect(page.getByTestId('demo-stage')).toContainText(/Savings scene · (Waiting for the ribbon to narrow|Holding)/);
    await expect(page.getByTestId('demo-stage')).not.toContainText(/\d:(wait|hold|lever)/);
  }
  // Other scenes can't start while one runs.
  await expect(page.getByRole('button', { name: 'Start the Regression scene' })).toBeDisabled();
  expect((await kvGet(page, 'demo/state')) ?? '').toContain('"scene"');
  await shoot(page, 'light', 'demo-scene', false);
  await running.scrollIntoViewIfNeeded();
  for (const theme of ['light', 'dark'] as const) await shoot(page, theme, 'wave2-l-scene', false, SCREENS);
  await setTheme(page, 'light');
  // Abort and restore is a button, not a 700 px bar, on the laptop (P1-L03).
  if ((page.viewportSize()?.width ?? 0) >= 1024)
    expect((await running.getByRole('button', { name: 'Abort and restore' }).boundingBox())!.width).toBeLessThanOrEqual(480);

  await running.getByRole('button', { name: 'Abort and restore' }).click();
  await settleLever(page);
  await expect(running).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId('demo-level-windows_workstations')).toHaveText(/Raw/);
  expect((await kvGet(page, 'demo/state')) ?? '').not.toContain('"scene"');
  expect((await timelineCommits(page)).some((c) => /demo: revert the pack on mrd_(rt_)?windows_workstations/.test(c.message))).toBe(true);
});

test('Weekly receipt now posts the receipt to the Cribl bell (D57: the stage webhook is the runner\'s, never the tab\'s)', async ({ page }) => {
  test.setTimeout(90_000);
  await openConsole(page);
  await page.getByRole('button', { name: 'Weekly receipt now' }).click();
  const weekly = page.getByRole('dialog');
  // The confirmation names every place the receipt goes from this tab: the Cribl bell the delivery router always
  // adds (D27), exactly what core/weekly.ts sends to. Direct webhooks are sent only by the runner, from its .env.
  await expect(weekly).toContainText('Endpoint Cribl notifications');
  await expect(weekly).not.toContainText('webhook.site');
  await confirmLever(page, { title: 'Send the weekly receipt now?', deploys: false, press: 'Send now' });
  await settleLever(page);
  await expect(page.getByText('Weekly receipt sent to 1 endpoint.')).toBeVisible({ timeout: 20_000 });
  expect((await bellMessages(page)).some((m) => /receipt/i.test(JSON.stringify(m)))).toBe(true);
  expect((await sinkDeliveries(page)).some((d) => d.host === 'webhook.site')).toBe(false);
});

test('desktop: the status line sits in the header row, right of the title, over the levers column', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openConsole(page);
  const title = (await page.getByRole('heading', { name: 'Demo Console', level: 1 }).boundingBox())!;
  const status = (await page.getByTestId('demo-status').boundingBox())!;
  const levers = (await page.getByRole('heading', { name: 'Levers', level: 2 }).boundingBox())!;
  expect(status.x).toBeGreaterThan(title.x + title.width);
  expect(Math.abs(status.x - levers.x)).toBeLessThan(2);
  expect(status.y).toBeLessThan(title.y + title.height);
  expect(status.y + status.height).toBeGreaterThan(title.y);
  // Number keys sit inside the Apply buttons, like the letter keys inside every other lever (P1-L03). Touch
  // screens (the mobile project, even at 1440) show no key hints at all.
  const touch = test.info().project.name === 'mobile';
  for (const [stream, key] of touch ? [] : ([['windows_workstations', '1'], ['pan_firewall', '2'], ['vpc_flow', '3']] as const)) {
    const row = page.locator(`[data-stream="${stream}"]`);
    const kbd = (await row.locator('kbd').boundingBox())!;
    const button = (await row.getByRole('button').boundingBox())!;
    await expect(row.locator('kbd')).toHaveText(key);
    expect(kbd.x).toBeGreaterThan(button.x);
    expect(kbd.x + kbd.width).toBeLessThanOrEqual(button.x + button.width);
    expect(kbd.y).toBeGreaterThan(button.y);
  }
  for (const width of [1440, 1920]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 1080 });
    for (const theme of ['light', 'dark'] as const) await shoot(page, theme, 'demo-idle');
  }
});

test('On the projector (P2-W18): the laptop console shows the stage in miniature — the presenter’s own figure, basis and savers', async ({ page }) => {
  const phone = test.info().project.name === 'mobile';
  test.skip(phone, 'the phone shows the one-line projector strip instead (phone layout test)');
  const errors = consoleErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openConsole(page);
  const panel = page.getByTestId('demo-projector-panel');
  // In the main column, at its head, above the scenes.
  await expect(page.locator('.mr-demo-col--main').getByTestId('demo-projector-panel')).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'On the projector' })).toBeVisible();
  const panelBox = (await panel.boundingBox())!;
  const scenesBox = (await page.getByTestId('demo-scenes').boundingBox())!;
  expect(panelBox.y + panelBox.height).toBeLessThan(scenesBox.y);
  // The frame is the stage's 16:9.
  const stage = panel.getByTestId('demo-stage');
  const stageBox = (await stage.boundingBox())!;
  expect(Math.abs(stageBox.width / stageBox.height - 16 / 9)).toBeLessThan(0.02);
  // The hero figure is the stage's own Meter (odometer wheels, not a stack of digits) on the stage's basis.
  const figure = stage.locator('[data-callout="projector"][data-value-m]');
  await expect(figure).toBeVisible();
  const value = Math.floor(Number(await figure.getAttribute('data-value-m')) / 100_000);
  expect(value).toBeGreaterThan(0);
  const wheel = (await figure.locator('.mr-meter-wheel').first().boundingBox())!;
  const size = await figure.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(wheel.height).toBeLessThan(size * 1.3);
  expect(size).toBeGreaterThanOrEqual(28);
  await expect(stage).toContainText('Saved by Cribl');
  await expect(stage).toContainText(/annualized run rate, from the last/);
  await expect(stage).toContainText("What's saving the most");
  await expect(stage.locator('.mr-demo-stage-item').first()).toHaveText(/\$[\d,]+$/);
  // Dark like the stage (P1-A07), with the rest band the stage draws when no card is up (review W2).
  await expect(stage).toHaveClass(/\bdark\b/);
  await expect(stage.getByTestId('demo-stage-rest')).toBeVisible();
  // One sentence for assistive tech, the same figure in it.
  await expect(stage).toHaveAttribute('role', 'img');
  await expect(stage).toHaveAttribute('aria-label', /^The presenter view shows \$[\d,]+ saved, annualized run rate/);
  // Quiet stage: the caption says so, with the alert the next break would bring.
  await expect(panel.getByTestId('demo-stage-state')).toHaveText('No alert on screen · Alert expected in ~2:07 after a break · measured lag');
  await expect(panel.getByTestId('demo-stage-takeover')).toHaveCount(0);
  for (const [width, height] of [
    [1440, 900],
    [1920, 1080],
    [1280, 720],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => window.scrollTo(0, 0));
    for (const theme of ['light', 'dark'] as const) await shoot(page, theme, 'wave2-l-projector', false, SCREENS);
  }
  await setTheme(page, 'light');

  // The same figure the stage shows: the annualized run rate does not accrue, so the numbers match exactly.
  await gotoApp(page, '/?present=1');
  const stageFigure = page.locator('.mr-pv-figure [data-callout="saved"][data-value-m]');
  await expect
    .poll(async () => Math.floor(Number(await stageFigure.getAttribute('data-value-m', { timeout: 2_000 }).catch(() => 'NaN')) / 100_000))
    .toBe(value);
  expect(errors()).toEqual([]);
});

test('layout (P1-L02): every lever and tool above the fold at 1440 × 900; Open presenter and Story (live run) on every width', async ({ page }) => {
  const phone = test.info().project.name === 'mobile';
  if (!phone) await page.setViewportSize({ width: 1440, height: 900 });
  await openConsole(page);
  const controls = '[aria-labelledby="mr-demo-levers"] button, [data-testid="demo-tools"] button, [data-testid="demo-tools"] input';
  const bottoms = () =>
    page.locator(controls).evaluateAll((els) =>
      els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => Math.round(e.getBoundingClientRect().bottom)),
    );
  if (!phone) {
    for (const [width, height] of [
      [1440, 900],
      [1920, 1080],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => window.scrollTo(0, 0));
      const all = await bottoms();
      expect(all.length).toBeGreaterThanOrEqual(16);
      expect(Math.max(...all), `lowest lever or tool at ${width} × ${height}`).toBeLessThanOrEqual(height);
      // Three columns: Tools right of Levers, level with them.
      const levers = (await page.getByRole('heading', { name: 'Levers', level: 2 }).boundingBox())!;
      const tools = (await page.getByRole('heading', { name: 'Reset and tools', level: 2 }).boundingBox())!;
      expect(tools.x).toBeGreaterThan(levers.x + levers.width);
      expect(Math.abs(tools.y - levers.y)).toBeLessThan(2);
    }
    // Two columns below 1440: Tools under Scenes in the main column, left of the Levers.
    await page.setViewportSize({ width: 1280, height: 800 });
    const scenes = (await page.getByTestId('demo-scenes').boundingBox())!;
    const tools = (await page.getByRole('heading', { name: 'Reset and tools', level: 2 }).boundingBox())!;
    const levers = (await page.getByRole('heading', { name: 'Levers', level: 2 }).boundingBox())!;
    expect(tools.y).toBeGreaterThan(scenes.y + scenes.height);
    expect(Math.abs(tools.x - scenes.x)).toBeLessThan(2);
    expect(levers.x).toBeGreaterThan(tools.x + tools.width);
    for (const theme of ['light', 'dark'] as const) await shoot(page, theme, 'demo-idle');
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  // The stage is a button away on every width, the phone included (P1-L02).
  const tools = page.getByTestId('demo-tools');
  for (const name of ['Open presenter', 'Start the tour', 'Play the story', 'Story (live run)']) {
    const b = tools.getByRole('button', { name });
    await expect(b).toBeVisible();
    expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(47.5);
  }
  if (!phone) await expect(tools.getByRole('button', { name: 'Open presenter' }).locator('..').locator('kbd')).toHaveText('P');
  await tools.getByRole('button', { name: 'Story (live run)' }).click();
  await expect(page).toHaveURL(/[?&]story=live(&|$)/);
  await gotoApp(page, '/demo');
  await expect(page.getByTestId('demo-console')).toBeVisible();
  await page.getByTestId('demo-tools').getByRole('button', { name: 'Open presenter' }).click();
  await expect(page).toHaveURL(/[?&]present=1(&|$)/);
  await expect(page.locator('.mr-pv')).toBeVisible();
});

test('contrast (P1-L01): Break the trim ≥ 4.5:1, disabled labels ≥ 3:1, the confirmation item card has an edge, both themes', async ({ page }) => {
  const phone = test.info().project.name === 'mobile';
  if (!phone) await page.setViewportSize({ width: 1440, height: 900 });
  await openConsole(page);
  // On the phone the page lever is in the bottom bar; on the laptop in the Break the trim group.
  const scope = page.getByTestId(phone ? 'demo-bottombar' : 'demo-trim');
  const breakBtn = scope.getByRole('button', { name: 'Break the trim' });
  const restore = scope.getByRole('button', { name: 'Restore' });
  await expect(restore).toBeDisabled();
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await page.waitForTimeout(100);
    expect(await contrastOf(breakBtn), `${theme}: Break the trim label on its fill`).toBeGreaterThanOrEqual(4.5);
    expect(await contrastOf(restore), `${theme}: disabled Restore label`).toBeGreaterThanOrEqual(3);
    expect(await contrastOf(page.getByRole('button', { name: 'Calm' })), `${theme}: disabled Calm label`).toBeGreaterThanOrEqual(3);
    expect(await contrastOf(page.getByRole('button', { name: 'Revert all' })), `${theme}: disabled Revert all label`).toBeGreaterThanOrEqual(3);

    await breakBtn.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    expect(await contrastOf(dialog.getByRole('button', { name: 'Break the trim' })), `${theme}: confirm button`).toBeGreaterThanOrEqual(4.5);
    // The "This affects" card: in dark its fill IS the modal surface, so its border is what makes it a card.
    const item = dialog.locator('.mr-demo-confirm-item').first();
    expect(await item.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('1px');
    expect(await contrastOf(item, true), `${theme}: confirm item edge against the modal`).toBeGreaterThan(1.3);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  }
  await setTheme(page, 'light');
});

test('a scene left in demo/state is never resumed on mount: the console asks, and Resume drives it', async ({ page }) => {
  test.setTimeout(150_000);
  const errors = consoleErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openConsole(page, {
    demoState: (now) =>
      demoStateDoc({
        scene: {
          name: 'regression',
          step: '0:lever',
          startedAt: new Date(now - 12 * MINUTE).toISOString(),
          stepAt: new Date(now - 30_000).toISOString(),
          changed: { trims: [], rates: [], budgets: [], routes: [] },
        },
      }),
  });
  const prompt = page.getByTestId('demo-left-scene');
  await expect(prompt).toBeVisible();
  await expect(prompt).toHaveAttribute('data-abandoned', 'false');
  await expect(prompt.getByRole('heading')).toHaveText('A scene was left running');
  await expect(prompt).toContainText(/Regression · step 1 of 5 · started 12 min ago · last step \d+ s ago/);
  await expect(prompt).toContainText('Resume runs next: Breaking the trim');
  await expect(prompt).toContainText('It has not changed anything in Cribl yet.');
  // Sweeps land and time passes: still nothing pulled (no lever commit, trim intact), scenes blocked until answered.
  await page.clock.fastForward(40_000);
  await waitForSweep(page);
  await expect(page.getByTestId('demo-trim-state')).toHaveText(/Trim intact/);
  expect((await timelineCommits(page)).filter((c) => c.source === 'demo')).toEqual([]);
  expect((await kvGet(page, 'demo/state')) ?? '').toContain('"scene"');
  await expect(page.getByRole('button', { name: 'Start the Savings scene' })).toBeDisabled();
  for (const theme of ['light', 'dark'] as const) await shoot(page, theme, 'demo-left', false);
  await setTheme(page, 'light');

  // Resume: this console now drives it — the next step breaks the trim.
  await prompt.getByRole('button', { name: 'Resume' }).click();
  await expect(prompt).toBeHidden();
  const running = page.getByTestId('demo-scene-running');
  await expect(running).toBeVisible();
  await settleLever(page);
  await expect(page.getByTestId('demo-trim-state')).toHaveText(/Trim broken/, { timeout: 20_000 });
  // Abort (one tap, SPEC 11) restores it.
  await running.getByRole('button', { name: 'Abort and restore' }).click();
  await settleLever(page);
  await expect(running).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId('demo-trim-state')).toHaveText(/Trim intact/, { timeout: 20_000 });
  expect(errors()).toEqual([]);
});

test('a scene that has not moved for 30 minutes is abandoned: restore or dismiss, never resume, nothing restored by itself', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await openConsole(page, {
    demoState: (now) =>
      demoStateDoc({
        routes: { mrd_vpc_flow: { previousPipelineId: 'mrd_passthrough', appliedAt: new Date(now - 44 * MINUTE).toISOString(), level: 'pack' } },
        scene: {
          name: 'savings:vpc_flow',
          step: '2:hold',
          startedAt: new Date(now - 45 * MINUTE).toISOString(),
          stepAt: new Date(now - 43 * MINUTE).toISOString(),
          changed: { trims: [], rates: [], budgets: [], routes: ['vpc_flow'] },
        },
      }),
  });
  const prompt = page.getByTestId('demo-left-scene');
  await expect(prompt).toHaveAttribute('data-abandoned', 'true');
  await expect(prompt.getByRole('heading')).toHaveText('A scene was abandoned');
  await expect(prompt).toContainText('Savings · step 3 of 4 · started 45 min ago');
  await expect(prompt).toContainText('Nothing moved for 30 minutes, so nothing was restored automatically.');
  await expect(prompt.locator('code', { hasText: 'mrd_vpc_flow' })).toBeVisible();
  await expect(prompt.getByRole('button', { name: 'Resume' })).toHaveCount(0);
  await expect(prompt.getByRole('button', { name: 'Restore what it changed' })).toBeEnabled();
  for (const theme of ['light', 'dark'] as const) await shoot(page, theme, 'demo-abandoned', false);
  await setTheme(page, 'light');

  await prompt.getByRole('button', { name: 'Dismiss' }).click();
  await expect(prompt).toBeHidden();
  await expect(page.getByText('Savings scene dismissed. Nothing was restored.')).toBeVisible();
  const state = JSON.parse((await kvGet(page, 'demo/state')) ?? '{}') as { scene?: unknown; routes?: Record<string, unknown> };
  expect(state.scene).toBeUndefined();
  expect(Object.keys(state.routes ?? {})).toEqual(['mrd_vpc_flow']); // left as it was
  expect((await timelineCommits(page)).filter((c) => c.source === 'demo')).toEqual([]);
  await expect(page.getByRole('button', { name: 'Start the Savings scene' })).toBeEnabled();
});
