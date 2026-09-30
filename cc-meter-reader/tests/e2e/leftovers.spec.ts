// tests/e2e/leftovers.spec.ts — the known leftovers after wave 3 (STATE 0o/0p, run sheet "Known leftovers"), each
// encoded as its acceptance. Runs on every project; the evidence screenshots (tests/report/screens/leftovers-*.png)
// come from `chromium` (1440) and `mobile` (390) only, so the other browsers never overwrite them.
//
//   1. Safari: the FIRST click on "Send a test alert", straight after typing the URL, did nothing. A field's first
//      blur re-renders the endpoint list; the Slack preview above keyed its nodes from a counter shared across
//      renders, so it remounted, and WebKit moved a page scrolled to its end by 72 px mid-click: the press that
//      began on the button ended off it (src/components/SlackPreview/mrkdwn.tsx).
//   2. The presenter at 390 px scrolled the hero's label and the top of its figure off the screen when an alert
//      card landed: the in-page card was brought on screen with scrollIntoView('nearest'). Now the hero's top never
//      leaves the frame (src/components/IncidentTakeover/reveal.ts).
//   4. The phone tab row was 14 px too wide at 390 (326 px of release tabs in a 312 px scroller), more with the
//      Ledger's alert count: the status is now its dot on a 24 px target without the chevron (the chevron's button
//      stays for the keyboard), and on phones the count and the Settings dot sit on the label's corner
//      (src/components/Shell/Shell.css).
//   3. The Ledger printed a route named like its pipeline twice (the tour's "DNS to Cribl Lake" under Route and
//      under Pipeline): the name now reads once, under Pipeline, and the Route cell is blank on screen, as it is
//      where a route is named like its source (LedgerTable routeFold).

import { expect, test, type Page } from '@playwright/test';
import type { Incident, Settings, Snapshot } from '../../core/types.ts';
import { gotoApp, resetMock, setTheme, trackConsoleErrors } from './helpers/index.ts';

const SCREENS = 'tests/report/screens';
/** A Cribl notification target the emulator lists (src/mock/fixtures.ts). */
const TARGET = 'mrd_webhook_site';
/** The dev server re-optimizing a dependency mid-run is an environment artifact, not an app error. */
const ALLOW = [/Outdated Optimize Dep/];

/** Evidence at 1440 (chromium) and 390 (mobile): `leftovers-<name>-<width>.png`. */
async function evidence(page: Page, name: string, opts: { fullPage?: boolean } = {}): Promise<void> {
  const project = test.info().project.name;
  if (project !== 'chromium' && project !== 'mobile') return;
  await page.evaluate(() => document.fonts.ready);
  const width = page.viewportSize()?.width ?? 0;
  await page.screenshot({ path: `${SCREENS}/leftovers-${name}-${width}.png`, fullPage: opts.fullPage ?? false });
}

/** The window's scroll after two frames (a layout the last change forced has landed). */
async function settledScrollY(page: Page): Promise<number> {
  return page.evaluate(async () => {
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    return window.scrollY;
  });
}

/** Scrolls the page to its end (where the second endpoint's test button sits) without touching focus. */
async function scrollToEnd(page: Page): Promise<number> {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight - window.innerHeight));
  return settledScrollY(page);
}

/**
 * A saved Cribl target whose test alert has run (its "What the target receives" preview on screen), then a second
 * target endpoint with its id just typed: the field still has focus and has never been left. (D57: every list
 * endpoint is a Cribl notification target; the direct-webhook editor this once exercised is gone.)
 */
async function secondEndpointJustTyped(page: Page): Promise<void> {
  await gotoApp(page, '/settings/notifications');
  await page.getByRole('button', { name: 'Add endpoint' }).first().click();
  await page.getByTestId('endpoint-0').getByLabel('Name').fill('Ops Slack');
  await page.getByTestId('endpoint-0-target').getByRole('textbox').fill(TARGET);
  await page.getByTestId('endpoint-0-relay').getByRole('button', { name: 'Connect' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByTestId('endpoint-0-relay')).toHaveAttribute('data-relay', 'ready');
  // M1 (founder-build r1 ui-5): a Connect that succeeded stores the endpoint at once; nothing is left to save.
  await expect(page.locator('section[data-section="notifications"] .mr-set-savebar')).toContainText('No unsaved changes');
  await page.getByTestId('endpoint-0-test').getByRole('button').click();
  await expect(page.getByTestId('endpoint-0-result')).toContainText(`Handed to Cribl for ${TARGET} (200)`);
  await expect(page.getByTestId('endpoint-0').locator('.mr-ep-preview')).toBeVisible();

  await page.getByRole('button', { name: 'Add endpoint' }).first().click();
  await page.getByTestId('endpoint-1').getByLabel('Name').fill('Relay');
  const field = page.getByTestId('endpoint-1-target').getByRole('textbox');
  await field.fill(TARGET);
  // The relay is the one endpoint 0 connected: the test button is ready once the typed id is checked.
  await expect(page.getByTestId('endpoint-1-relay')).toHaveAttribute('data-relay', 'ready', { timeout: 10_000 });
  await expect(field).toBeFocused();
}

test.describe('leftover 1: "Send a test alert" takes the first click (Safari)', () => {
  test('a URL field left for the first time keeps a page scrolled to its end where it is', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await secondEndpointJustTyped(page);
    const atEnd = await scrollToEnd(page);
    expect(atEnd, 'the page is long enough to scroll').toBeGreaterThan(0);
    // The first blur marks the field touched and re-renders the list (the first endpoint's preview included).
    await page.getByTestId('endpoint-1-target').getByRole('textbox').blur();
    expect(await settledScrollY(page), 'scroll after the first blur').toBe(atEnd);
    // The relay check before Connect answers 404 ("not connected yet"): the browser logs it, the App reads it as missing.
    expect(errors().filter((e) => !/Failed to load resource: the server responded with a status of 40[34]/.test(e))).toEqual([]);
  });

  test('the first press, straight from the URL field, sends the test alert', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await secondEndpointJustTyped(page);
    await scrollToEnd(page);
    // No blur first: the press itself takes focus from the field, as a member's click does.
    const button = page.getByTestId('endpoint-1-test').getByRole('button');
    const box = await button.boundingBox();
    await button.click();
    await expect(page.getByTestId('endpoint-1-result')).toHaveText(`Handed to Cribl for ${TARGET} (200). Cribl delivers it from its notification service.`);
    // The button never moved under the pointer.
    expect((await button.boundingBox())?.y).toBeCloseTo(box?.y ?? Number.NaN, 0);
    await evidence(page, '1-test-alert');
    expect(errors().filter((e) => !/Failed to load resource: the server responded with a status of 40[34]/.test(e))).toEqual([]);
  });
});

test.describe('leftover 3: the Ledger prints a route named like its pipeline once', () => {
  const ROWS = '[data-testid="ledger-scroll"] [role="row"][data-row-id]';
  const NAME = 'DNS to Cribl Lake';

  test('the tour\'s "DNS to Cribl Lake" reads once, under Pipeline; other routes keep their cells', async ({ page, isMobile }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await gotoApp(page, '/');
    await resetMock(page);
    // The deep link scrolls the Ledger to the DNS flow (its pipeline) and marks it.
    await gotoApp(page, '/ledger?tour=1&object=pipe:datacenter:dns_to_lake');
    await page.locator('[data-callout="sample-band"]').waitFor({ timeout: 30_000 });
    const row = page.locator(ROWS).filter({ hasText: NAME }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    const names = await row.evaluate((el) => [...el.querySelectorAll('.mr-lt-name, .mr-truncate')].map((n) => n.textContent ?? ''));
    expect(names.filter((n) => n === NAME), `names in the row: ${names.join(' | ')}`).toHaveLength(1);
    if (!isMobile) {
      const table = page.locator('.mr-lt');
      // The tour's other routes say something of their own, so the Route column stays.
      await expect(table).toHaveAttribute('data-columns', /^source,route,pipeline,destination,/);
      // The name reads under Pipeline (the cell with the link); the Route cell beside it is blank on screen and
      // names the route only to a screen reader.
      const routeCell = row.locator('[data-folds="pipeline"]');
      await expect(routeCell).toHaveCount(1);
      await expect(routeCell).toHaveText(NAME);
      await expect(routeCell.locator('.mr-visually-hidden')).toHaveText(NAME);
      const pipelineCell = row.locator('.mr-lt-td--pipeline');
      await expect(pipelineCell.locator('.mr-lt-name')).toHaveText(NAME);
      const header = await page.locator('[role="columnheader"]').filter({ hasText: /^Pipeline/ }).first().boundingBox();
      const cell = await pipelineCell.boundingBox();
      expect(Math.abs((cell?.x ?? 0) - (header?.x ?? Number.NaN)), 'the name starts under the Pipeline header').toBeLessThanOrEqual(2);
      // No row prints the same name in two neighbouring name cells.
      const repeats = await page.locator(ROWS).evaluateAll((rows) =>
        rows.flatMap((r) => {
          const cells = [...r.querySelectorAll(':scope > [role="cell"]')].slice(0, 3).map((c) => c.querySelector('.mr-lt-name')?.textContent ?? '');
          return cells.some((c, i) => c !== '' && c === cells[i + 1]) ? [cells.join(' | ')] : [];
        }),
      );
      expect(repeats).toEqual([]);
    }
    await row.scrollIntoViewIfNeeded();
    await evidence(page, '3-ledger-route');
    expect(errors()).toEqual([]);
  });
});

test.describe('leftover 2: the presenter keeps its hero whole while an alert card is up', () => {
  const MC = 100_000;
  const SAVERS = [
    { id: 'mrd_win_xml_pack', label: 'Windows event trimming', perDay: 1_340 },
    { id: 'mrd_pan_pack', label: 'Firewall duplicate suppression', perDay: 912 },
    { id: 'mrd_k8s_noise', label: 'Kubernetes noise filter', perDay: 640 },
    { id: 'mrd_pay_sample', label: 'Payments API sampling', perDay: 388 },
    { id: 'mrd_cdn_agg', label: 'CDN log aggregation', perDay: 121 },
  ];
  const iso = (ms: number) => new Date(ms).toISOString();

  /** The presenter spec's stage: $1,284,435 a year from five savers (tests/e2e/presenter.spec.ts snapshotAt). */
  function snapshotAt(now: number): Snapshot {
    const perDayM = SAVERS.reduce((sum, x) => sum + x.perDay, 0) * MC + 118 * MC;
    return {
      schemaVersion: 1,
      sweepAt: iso(now - 4_000),
      windowStart: iso(now - 64_000),
      windowEnd: iso(now - 4_000),
      mode: 'ui',
      headline: {
        todayM: 1_602 * MC,
        mtdM: 91_420 * MC,
        d30M: 104_380 * MC,
        annualizedM: perDayM * 365,
        annualizedFromDays: 5,
        whpMtdM: 152_400 * MC,
        paidMtdM: 60_980 * MC,
        ratioMtd: 0.6,
        whpTodayM: 2_670 * MC,
        paidTodayM: 1_068 * MC,
        whp30dM: 174_000 * MC,
        paid30dM: 69_620 * MC,
      },
      ratePerSecM: perDayM / 86_400,
      flows: [],
      destinations: [],
      topSavers: SAVERS.map((x) => ({ objectKey: `pipe:default:${x.id}`, label: x.label, savedPerDayM: x.perDay * MC, ratio: 0.6, groupId: 'default', pipelineId: x.id })),
      unpricedOutputIds: [],
      openIncidents: 0,
      incidents: [],
      trend: [],
      ratioSeries: [],
      timeline: [],
      deliveries: [],
      calls: 22,
      collectingSince: iso(now - 5 * 86_400_000),
      metricsSource: 'metrics-query',
      attributionSummary: 'route',
    };
  }

  function regression(now: number): Incident {
    return {
      id: 'inc_7f3a01',
      type: 'regression',
      severity: 'high',
      objectKey: 'pipe:default:mrd_pay_sample',
      label: 'Payments API sampling',
      outputId: 'mrd_siem_prod',
      openedAt: iso(now - 1_000),
      cause: 'commit',
      commit: {
        hash: 'a1f3c9e5b2',
        message: 'demo: break the trim on mrd_pay_sample',
        author: 'meter-reader',
        committedAt: iso(now - 180_000),
        deployedAt: iso(now - 171_000),
        groupId: 'default',
        match: 'message',
      },
      before: 0.75,
      after: 0.5,
      impactPerDayM: 25 * MC,
      caughtInSec: 170,
      notes: ['demo-profile'],
      deliveries: [{ endpointId: 'ep_slack', status: 200, at: iso(now) }],
      lastNotifiedAt: iso(now),
    };
  }

  interface Hook {
    store: { getState(): { settings: Settings; snapshot: Snapshot | null }; setState(p: Record<string, unknown>): void };
    stop(): void;
  }

  const SLACK = { id: 'ep_slack', name: 'Slack', url: 'https://hooks.slack.com/services/T000/B000/abcd', host: 'hooks.slack.com', format: 'slack' as const, minSeverity: 'medium' as const, weeklyReceipt: true, enabled: true };

  for (const [width, height] of [
    [390, 844],
    [390, 664],
    [1440, 900],
  ] as const) {
    test(`${width}x${height}: the card lands on screen and the hero's label, figure and caption stay whole`, async ({ page }) => {
      const errors = trackConsoleErrors(page, ALLOW);
      await page.setViewportSize({ width, height });
      await gotoApp(page, '/?present=1');
      await page.waitForFunction(() => '__MR_PRESENTER__' in window);
      await setTheme(page, 'dark');
      const now = await page.evaluate(() => Date.now());
      await page.evaluate(
        ({ snap, endpoint }) => {
          const hook = (window as unknown as { __MR_PRESENTER__: Hook }).__MR_PRESENTER__;
          hook.stop();
          const { settings } = hook.store.getState();
          hook.store.setState({
            snapshot: snap,
            source: 'live',
            errors: {},
            prices: { schemaVersion: 1, updatedAt: new Date(0).toISOString(), versions: [] },
            settings: { ...settings, notifications: [endpoint], presenter: { ...settings.presenter, headlinePeriod: 'annualized' } },
          });
        },
        { snap: snapshotAt(now), endpoint: SLACK },
      );
      await expect(page.locator('.mr-pv-figure')).toContainText('1,284,435');
      // The hero's first-paint roll-up from $0 (P2-W19, 1.2 s) finishes before the card lands.
      await page.waitForTimeout(2_000);
      // At rest nothing has scrolled.
      expect(await page.evaluate(() => window.scrollY)).toBe(0);

      await page.evaluate((incident) => {
        const hook = (window as unknown as { __MR_PRESENTER__: Hook }).__MR_PRESENTER__;
        const snap = hook.store.getState().snapshot;
        if (!snap) throw new Error('no snapshot on stage');
        hook.store.setState({ snapshot: { ...snap, incidents: [incident], openIncidents: 1 } });
      }, regression(now));
      const card = page.locator('.mr-takeover');
      await expect(card).toHaveAttribute('data-delivered', 'true');
      // The slide-up has finished, so every box is final.
      await page.waitForFunction(() => {
        const el = document.querySelector('.mr-takeover');
        return !!el && el.getAnimations().every((a) => a.playState !== 'running' && !a.pending);
      });
      const boxes = await page.evaluate(() => {
        const box = (sel: string) => {
          const r = document.querySelector(sel)?.getBoundingClientRect();
          return r ? { top: r.top, bottom: r.bottom } : null;
        };
        return {
          inner: window.innerHeight,
          scrollWidth: document.documentElement.scrollWidth,
          label: box('.mr-pv-label'),
          figure: box('.mr-pv-figure'),
          caption: box('.mr-pv-caption'),
          head: box('.mr-tk-head'),
          ratio: box('.mr-tk-ratio'),
          card: box('.mr-takeover'),
        };
      });
      for (const key of ['label', 'figure', 'caption'] as const) {
        const b = boxes[key];
        expect(b, `${key} is on the stage`).not.toBeNull();
        expect(b?.top ?? -1, `${key} top is on screen`).toBeGreaterThanOrEqual(0);
        expect(b?.bottom ?? Infinity, `${key} bottom is on screen`).toBeLessThanOrEqual(boxes.inner);
      }
      // The card's headline and its drop (75% → 50%) are on screen with the hero.
      for (const key of ['head', 'ratio'] as const) {
        expect(boxes[key]?.top ?? -1, `card ${key} top`).toBeGreaterThanOrEqual(0);
        expect(boxes[key]?.bottom ?? Infinity, `card ${key} bottom`).toBeLessThanOrEqual(boxes.inner);
      }
      // Where hero and card fit together (a 390 × 844 phone, and the projector), the whole card is on screen too
      // (P1-B02, presenter.spec "fits a phone at 390").
      if (height >= 844) expect(boxes.card?.bottom ?? Infinity, 'the whole card is on screen').toBeLessThanOrEqual(boxes.inner);
      expect(boxes.scrollWidth).toBeLessThanOrEqual(width);
      if (test.info().project.name === 'chromium') {
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: `${SCREENS}/leftovers-2-presenter-alert-${width}x${height}.png` });
      }
      expect(errors()).toEqual([]);
    });
  }
});

test.describe('leftover 4: the five tabs fit a 390 px phone', () => {
  interface ShellHook {
    store: { getState(): { snapshot: Record<string, unknown> | null }; setState(p: Record<string, unknown>): void };
    stop(): void;
  }

  /** The tab row as laid out: whether it scrolls, every tab's box, the status dot and target. */
  async function tabRow(page: Page) {
    return page.evaluate(() => {
      const row = document.querySelector<HTMLElement>('.mr-topnav-tabs')!;
      const box = row.getBoundingClientRect();
      const tabs = [...row.querySelectorAll<HTMLElement>('a')].map((a) => {
        const r = a.getBoundingClientRect();
        return { name: a.textContent ?? '', left: r.left, right: r.right };
      });
      const badge = row.querySelector<HTMLElement>('[data-testid="tab-badge"]')?.getBoundingClientRect();
      const settings = row.querySelector<HTMLElement>('a[href*="/settings"]')?.getBoundingClientRect();
      const dot = document.querySelector<HTMLElement>('.mr-topnav-status .mr-status-dot')!.getBoundingClientRect();
      const target = document.querySelector<HTMLElement>('.mr-status-pulse')!.getBoundingClientRect();
      return {
        overflow: row.scrollWidth - row.clientWidth,
        fadeEnd: row.dataset.fadeEnd,
        fadeStart: row.dataset.fadeStart,
        row: { left: box.left, right: box.right, top: box.top },
        tabs,
        badge: badge ? { left: badge.left, right: badge.right, top: badge.top } : null,
        settingsLeft: settings?.left ?? Number.NaN,
        dotRight: dot.right,
        target: { width: target.width, height: target.height },
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        vw: window.innerWidth,
      };
    });
  }

  for (const path of ['/?tour=1', '/ledger?tour=1']) {
    test(`${path}: every tab whole with no scrolling, the dot on the gutter, the pulse still opens by tap and by keyboard`, async ({ page, isMobile }) => {
      const errors = trackConsoleErrors(page, ALLOW);
      if (!isMobile) await page.setViewportSize({ width: 390, height: 844 });
      await gotoApp(page, '/');
      await resetMock(page);
      await gotoApp(page, path);
      await page.locator('[data-callout="sample-band"]').waitFor({ timeout: 30_000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);

      const m = await tabRow(page);
      expect(m.tabs.map((t) => t.name)).toEqual(['Receipt', 'Flow', 'What if', 'Ledger', 'Settings']);
      expect(m.overflow, 'the tab row scrolls').toBeLessThanOrEqual(0);
      for (const t of m.tabs) {
        expect(t.left, `${t.name} left`).toBeGreaterThanOrEqual(m.row.left - 0.5);
        expect(t.right, `${t.name} right`).toBeLessThanOrEqual(m.row.right + 0.5);
      }
      expect([m.fadeStart, m.fadeEnd]).toEqual(['false', 'false']);
      // The dot ends on the page's 16 px gutter, like the cards under it.
      expect(Math.abs(m.vw - 16 - m.dotRight), 'dot right edge on the gutter').toBeLessThanOrEqual(1.5);
      // A 24 px target at least (WCAG 2.5.8).
      expect(m.target.width).toBeGreaterThanOrEqual(24);
      expect(m.target.height).toBeGreaterThanOrEqual(24);
      expect(m.pageOverflow).toBeLessThanOrEqual(0);
      await evidence(page, `4-tab-row${path.startsWith('/ledger') ? '-ledger' : ''}`);

      // A tap on the status opens the pulse; the chevron's button is still the keyboard's way in.
      await page.locator('.mr-status').click();
      await expect(page.getByTestId('status-pulse')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('status-pulse')).toHaveCount(0);
      const chevron = page.getByRole('button', { name: 'Sweep details' });
      await chevron.focus();
      await expect(chevron).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('status-pulse')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('status-pulse')).toHaveCount(0);
      await chevron.blur();

      // An open alert and an unpriced destination: the Ledger's count and the Settings dot cost no width.
      await page.waitForFunction(() => '__MR_SHELL__' in window);
      await page.evaluate(() => {
        const hook = (window as unknown as { __MR_SHELL__: ShellHook }).__MR_SHELL__;
        hook.stop();
        const snap = hook.store.getState().snapshot;
        if (!snap) throw new Error('no snapshot');
        hook.store.setState({ snapshot: { ...snap, openIncidents: 2, unpricedOutputIds: ['mrd_lake'] } });
      });
      const nav = page.getByRole('navigation').first();
      await expect(nav.getByRole('link', { name: 'Ledger, 2 open alerts' }).getByTestId('tab-badge')).toHaveText('2');
      await expect(nav.getByTestId('tab-dot')).toBeVisible();
      const b = await tabRow(page);
      expect(b.overflow, 'the tab row scrolls with the count').toBeLessThanOrEqual(0);
      expect(b.badge, 'the count is drawn').not.toBeNull();
      expect(b.badge!.right, 'the count clears the Settings tab').toBeLessThanOrEqual(b.settingsLeft - 2);
      expect(b.badge!.top, 'the count is not cut by the tab row').toBeGreaterThanOrEqual(b.row.top);
      await evidence(page, `4-tab-row-badges${path.startsWith('/ledger') ? '-ledger' : ''}`);
      expect(errors()).toEqual([]);
    });
  }

  test('1440: the desktop row keeps its chevron and word', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the phone layout is the test above');
    await gotoApp(page, '/?tour=1');
    await page.locator('[data-callout="sample-band"]').waitFor({ timeout: 30_000 });
    const chevron = page.getByRole('button', { name: 'Sweep details' });
    await expect(chevron).toBeVisible();
    expect(await chevron.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await expect(page.locator('.mr-topnav-status .mr-status-label--full')).toBeVisible();
    await evidence(page, '4-tab-row');
  });
});
