// tests/e2e/ledger.spec.ts — the Ledger (PRD 8.3, DESIGN_BRIEF 5.4, SPEC 13 persistence + deep links, SPEC 17
// columns) against the in-browser Cribl emulator, with the real demo-rig data a week of sweeps produces
// (tests/e2e/ledger-fixture.ts). Behaviour first, then the beauty grid: both themes × 390 / 1440 / 1920 into
// tests/report/beauty/ledger-<theme>-<width>.png (PRD 8.8 item 12).

import { expect, test, type Page } from '@playwright/test';
import { gotoApp, mockControl, setTheme, trackConsoleErrors, waitForHydration, waitForMock, type Theme } from './helpers/index.ts';
import { loadDemoFixture, injectLedgerDocs, type LedgerDocs } from './ledger-fixture.ts';

let fixture: LedgerDocs;

test.beforeAll(async () => {
  fixture = loadDemoFixture();
});

const ROWS = '[data-testid="ledger-scroll"] [role="row"][data-row-id]';

/** Boots the emulator, stores the fixture in its KV, reloads at `path` and waits for the table. */
async function openLedger(page: Page, path = '/ledger', docs: LedgerDocs = fixture): Promise<void> {
  await gotoApp(page, '/ledger');
  await injectLedgerDocs(page, docs);
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await waitForMock(page);
  await waitForHydration(page);
  await expect(page.locator(ROWS).first()).toBeVisible();
}

/** Flows the table lists by default: the rest (no traffic in the last hour) fold into one summary row (BEAUTY F11). */
function activeCount(): number {
  return fixture.snapshot.flows.filter((f) => f.inBPerDay > 0 || f.outBPerDay > 0 || f.whpPerDayM > 0 || f.paidPerDayM > 0).length;
}
function quietCount(): number {
  return fixture.snapshot.flows.length - activeCount();
}

function row(page: Page, inputId: string) {
  return page.locator(`${ROWS}[data-row-id*="|${inputId}|"]`);
}

/**
 * Texts the ellipsis cuts short: the text's own laid-out width (a Range; the ellipsis is only painted) against its
 * box. scrollWidth rounds to whole pixels and misses a label that overflows by a fraction, which still shows "…".
 */
function clippedNames(page: Page, selector: string): Promise<string[]> {
  return page.locator(selector).evaluateAll((els) =>
    els
      .filter((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return range.getBoundingClientRect().width > el.getBoundingClientRect().width + 0.01;
      })
      .map((el) => el.textContent ?? ''),
  );
}

function search(page: Page): URLSearchParams {
  return new URL(page.url()).searchParams;
}

test.describe('Ledger', () => {
  test('lists every flow with humanized names, right-aligned figures and status chips', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the wide column layout; phones get cards (next test)');
    const errors = trackConsoleErrors(page);
    await openLedger(page);
    const flows = activeCount();
    await expect(page.locator(ROWS)).toHaveCount(flows);
    await expect(page.getByRole('heading', { level: 1, name: 'Ledger' })).toBeVisible();
    await expect(page.locator('.mr-ledger-count')).toHaveText(`${flows} flows`);

    // SPEC 17 columns in the wide layout (1440). Every demo route is named like its source, so Route folds into
    // Source (P1-K01; it comes back where a route says something new — next test).
    const headers = page.locator('[role="columnheader"]');
    await expect(headers).toHaveText([
      'Source',
      'Pipeline',
      'Destination',
      /In\s*\/ day/,
      /Out\s*\/ day/,
      'Volume reduced',
      /Would have paid\s*\/ day/,
      /Paid\s*\/ day/,
      /Saved\s*\/ day/,
      'Trend',
      'Status',
    ]);
    // Default sort: saved / day, biggest first.
    await expect(page.locator('[role="columnheader"][aria-sort="descending"]')).toContainText('Saved');

    const pay = row(page, 'mrd_payments_api');
    await expect(pay).toContainText('Payments API sampling');
    await expect(pay.locator('[data-status="regression"]')).toHaveText('Savings dropped');
    await expect(pay.locator('.mr-sparkline--incident-high')).toBeVisible();

    // Numbers are right-aligned and tabular.
    const savedCell = pay.locator('.mr-lt-td--saved');
    expect(await savedCell.evaluate((el) => getComputedStyle(el).justifyContent)).toBe('flex-end');
    expect(await savedCell.locator('.mr-num').evaluate((el) => getComputedStyle(el).fontVariantNumeric)).toContain('tabular-nums');

    // The pipeline opens in Cribl, in the top window.
    const link = pay.locator('a[data-pipeline-link="mrd_pay_sample"]');
    await expect(link).toHaveAttribute('href', '/stream/m/default/pipelines/mrd_pay_sample');
    await expect(link).toHaveAttribute('target', '_top');

    // Sticky totals row sums the visible flows.
    await expect(page.locator('.mr-lt-totals')).toContainText(`Total · ${flows} flows`);
    expect(errors()).toEqual([]);
  });

  test('names read whole at 1440 and 1920: Route folds into Source where it repeats it, and 1920 widens the page for the table (P1-K01)', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, 'phones get cards');
    const width = page.viewportSize()?.width ?? 0;
    await openLedger(page);
    const table = page.locator('.mr-lt');
    await expect(table).toHaveAttribute('data-layout', 'wide');
    // On the demo rows every route is named like its source, so the column says nothing and folds away.
    await expect(table).toHaveAttribute('data-columns', /^source,pipeline,destination,/);
    const headers = page.locator('[role="columnheader"]');
    await expect(headers.first()).toHaveText('Source');
    await expect(headers.filter({ hasText: /^Route$/ })).toHaveCount(0);
    // No name cell is cut short: source, pipeline and destination read whole (the span, not the cell: the
    // pipeline cell also holds the link icon).
    expect(await clippedNames(page, `${ROWS} .mr-lt-td :is(.mr-lt-name, .mr-truncate)`)).toEqual([]);
    // At 1920 the Ledger's page widens to 1440 px, so the table uses the canvas instead of truncating beside it;
    // below 1600 it keeps every tab's 1280 px frame.
    const flowsCard = await page.locator('.mr-ledger-flows').boundingBox();
    if (!flowsCard) throw new Error('no flows card');
    if (width >= 1600) expect(flowsCard.width).toBeGreaterThanOrEqual(1400);
    else expect(flowsCard.width).toBeLessThanOrEqual(1280);
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await page.locator('.mr-ledger-flows').screenshot({ path: `tests/report/screens/wave1-k-k01-table-${width}-${theme}.png` });
    }
    await setTheme(page, 'light');
    // Where a route says something its source does not (the built-in flows, "Default route"), the column is back.
    await page.getByTestId('ledger-quiet').getByRole('button', { name: 'Show' }).click();
    await expect(table).toHaveAttribute('data-columns', /^source,route,pipeline,destination,/);
    await expect(headers.nth(1)).toHaveText('Route');

    // Flows across two worker groups: the 1440 px Ledger names the group beside the flow, and the names still read
    // whole; the 1280 px page keeps the room for the names.
    const edge = { ...fixture, snapshot: { ...fixture.snapshot, flows: fixture.snapshot.flows.map((f, i) => (i % 2 ? { ...f, groupId: 'edge-west' } : f)) } };
    await openLedger(page, '/ledger', edge);
    if (width >= 1600) {
      await expect(table).toHaveAttribute('data-columns', /^source,pipeline,destination,group,/);
      await expect(headers.nth(3)).toHaveText('Worker group');
      expect(await clippedNames(page, `${ROWS} .mr-lt-td :is(.mr-lt-name, .mr-truncate)`)).toEqual([]);
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await page.locator('.mr-ledger-flows').screenshot({ path: `tests/report/screens/wave1-k-k01-groups-${width}-${theme}.png` });
      }
    } else {
      await expect(table).toHaveAttribute('data-columns', /^source,pipeline,destination,in,/);
    }
  });

  test('the medium table keeps its width busy: Status is capped, and Would have paid is back from 960 px (P1-K01)', async ({ page, isMobile }) => {
    test.skip(isMobile, 'phones get cards');
    test.skip(test.info().project.name !== 'chromium', 'one desktop project is enough for a set viewport');
    for (const [viewport, whp] of [
      [1024, true],
      [900, false],
    ] as const) {
      await page.setViewportSize({ width: viewport, height: 900 });
      await openLedger(page);
      const table = page.locator('.mr-lt');
      await expect(table).toHaveAttribute('data-layout', 'medium');
      await expect(page.locator('[role="columnheader"]').filter({ hasText: 'Would have paid' })).toHaveCount(whp ? 1 : 0);
      // No dead band: the status column stops at 160 px and the flow column takes the rest.
      const status = await page.locator('[role="columnheader"]').last().boundingBox();
      if (!status) throw new Error('no status header');
      expect(status.width).toBeLessThanOrEqual(160 + 0.5);
      expect(await clippedNames(page, `${ROWS} .mr-lt-td--flow .mr-truncate`)).toEqual([]);
      if (whp)
        for (const theme of ['light', 'dark'] as const) {
          await setTheme(page, theme);
          await page.locator('.mr-ledger-flows').screenshot({ path: `tests/report/screens/wave1-k-k01-table-${viewport}-${theme}.png` });
        }
    }
  });

  test('at phone width every flow is a card: pipeline, status, path, saved / day, trend', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = trackConsoleErrors(page);
    await openLedger(page);
    await expect(page.locator('.mr-lt')).toHaveAttribute('data-layout', 'narrow');
    await expect(page.locator('[role="columnheader"]')).toHaveCount(0);
    const pay = row(page, 'mrd_payments_api');
    await expect(pay.locator('.mr-lt-link')).toContainText('Payments API sampling');
    await expect(pay.locator('[data-status="regression"]')).toHaveText('Savings dropped');
    await expect(pay.locator('.mr-lt-card-path')).toHaveText('Payments API → SIEM (prod)');
    await expect(pay.locator('.mr-lt-card-saved')).toContainText('/ day');
    // The money strip replaced the "6 flows · saving $279 / day" line (P2-W17): the count and the day's figures.
    await expect(page.locator('.mr-ledger-strip-count')).toContainText(`${activeCount()} flows`);
    await expect(page.getByTestId('ledger-strip').locator('[data-tile="saved"]')).toContainText('/ day');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(errors()).toEqual([]);
  });

  test("'/' focuses search; typing filters and lands in the URL; Escape clears", async ({ page }) => {
    await openLedger(page);
    // Take focus off any control so '/' reaches the shortcut. Click the static page title, not a corner of
    // <main>: that corner sits flush under the sticky header, and once a retry scrolls the page the header
    // covers it and every later attempt hits the header (seen under a loaded 6-worker run).
    await page.getByRole('main').getByRole('heading', { level: 1 }).click();
    await page.keyboard.press('/');
    const input = page.locator('[data-mr-search] input');
    await expect(input).toBeFocused();
    await page.keyboard.type('payments');
    await expect(page.locator(ROWS)).toHaveCount(1);
    await expect(page.locator('.mr-ledger-count')).toHaveText(`1 of ${fixture.snapshot.flows.length} flows`);
    await expect.poll(() => search(page).get('q')).toBe('payments');
    await page.keyboard.press('Escape');
    await expect(page.locator('.mr-ledger-count')).toHaveText(`${activeCount()} flows`);
    await expect.poll(() => search(page).get('q')).toBeNull();
  });

  test('filters persist in the URL; filtered-to-zero is a designed state with one-click recovery', async ({ page, isMobile }, info) => {
    await openLedger(page, '/ledger?state=regression');
    await expect(page.locator(ROWS)).toHaveCount(1);
    await expect(row(page, 'mrd_payments_api')).toBeVisible();

    await page.goto('/ledger?dest=mrd_archive_s3', {
      waitUntil: 'domcontentloaded',
    });
    await waitForHydration(page);
    await expect(page.locator(ROWS)).toHaveCount(1);
    await expect(row(page, 'mrd_vpc_flow')).toBeVisible();

    await page.goto('/ledger?q=no-such-flow', {
      waitUntil: 'domcontentloaded',
    });
    await waitForHydration(page);
    const empty = page.locator('[data-state="filtered-empty"]');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('No flows match these filters');
    if (!isMobile) await expect(page.locator('[role="columnheader"]').first()).toBeVisible(); // the header stays
    if (info.project.name === 'chromium') {
      await page.screenshot({ path: 'tests/report/beauty/ledger-filtered-empty-light-1440.png', fullPage: true });
    }
    await empty.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.locator('.mr-ledger-count')).toHaveText(`${activeCount()} flows`);
    await expect.poll(() => search(page).get('q')).toBeNull();
  });

  test('flows with no traffic fold into one summary row; Show lists them under Cribl\'s own names', async ({ page }, info) => {
    expect(quietCount()).toBeGreaterThan(0); // the demo rig's default Sources carry no traffic
    await openLedger(page);
    const quiet = page.getByTestId('ledger-quiet');
    await expect(quiet).toContainText(`${quietCount()} flows with no traffic in the last hour`);
    await expect(page.locator(`${ROWS}[data-status="idle"]`)).toHaveCount(0);
    await quiet.getByRole('button', { name: 'Show' }).click();
    await expect.poll(() => search(page).get('quiet')).toBe('show');
    // Every flow is now in the table (counted from the table's own row count: phones virtualize the cards).
    await expect(page.locator('.mr-ledger-count')).toHaveText(`${fixture.snapshot.flows.length} flows`);
    await expect(quiet).toContainText('are listed');
    // Cribl's built-in objects read like the product's names, not raw ids ("In splunk hec", "Devnull", "Main").
    const hec = row(page, 'in_splunk_hec');
    await hec.scrollIntoViewIfNeeded();
    if (!info.project.name.startsWith('mobile')) {
      await expect(hec).toContainText('Splunk HEC');
      await expect(hec).toContainText('Default route');
      await expect(hec).toContainText('DevNull');
    }
    await expect(hec).toContainText('Main (default)');
    if (info.project.name === 'chromium') {
      await page.screenshot({ path: 'tests/report/beauty/ledger-quiet-shown-light-1440.png', fullPage: true });
    }
    await quiet.getByRole('button', { name: 'Hide' }).click();
    await expect.poll(() => search(page).get('quiet')).toBeNull();
    await expect(page.locator(ROWS)).toHaveCount(activeCount());
    // The "No traffic" status filter lists exactly those flows, with no summary row.
    await page.goto('/ledger?state=idle', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await expect(page.locator(ROWS)).toHaveCount(quietCount());
    await expect(page.getByTestId('ledger-quiet')).toHaveCount(0);
  });

  test('column headers sort, and the sort is in the URL', async ({ page, isMobile }) => {
    test.skip(isMobile, 'phones have no column headers');
    await openLedger(page);
    await page.locator('[role="columnheader"] button[data-sort-key="paid"]').click();
    await expect.poll(() => search(page).get('sort')).toBe('-paid');
    await expect(page.locator('[role="columnheader"][aria-sort="descending"]')).toContainText('Paid');
    const paidAt = ((await page.locator('.mr-lt').getAttribute('data-columns')) ?? '').split(',').indexOf('paid') + 1;
    expect(paidAt).toBeGreaterThan(0);
    const paid = await page.locator(`${ROWS} .mr-lt-td:nth-child(${paidAt})`).allInnerTexts();
    const values = paid.map((s) => (s.includes('$') ? Number(s.replace(/[^0-9]/g, '')) : -1));
    expect(values).toEqual([...values].sort((a, b) => b - a));
    await page.locator('[role="columnheader"] button[data-sort-key="source"]').click();
    await expect.poll(() => search(page).get('sort')).toBe('source');
    await expect(page.locator('[role="columnheader"][aria-sort="ascending"]')).toContainText('Source');
    // A link sorted by route while Route folds into Source (P1-K01): the Source header shows that order.
    await openLedger(page, '/ledger?sort=-route');
    await expect(page.locator('[role="columnheader"][aria-sort="descending"]')).toHaveText('Source');
  });

  test('?object= deep link scrolls to and highlights the row', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await openLedger(page, '/ledger?object=route:default:mrd_payments_api');
    const pay = row(page, 'mrd_payments_api');
    await expect(pay).toHaveClass(/is-highlighted/);
    await expect(pay).toHaveAttribute('aria-current', 'true');
    await expect(pay).toBeInViewport();
    // Only that flow is highlighted.
    await expect(page.locator(`${ROWS}.is-highlighted`)).toHaveCount(1);
  });

  test('a deep link hidden by filters says so and clears them on request', async ({ page }) => {
    await openLedger(page, '/ledger?object=route:default:mrd_payments_api&dest=mrd_archive_s3');
    const notice = page.locator('[data-state="object-hidden"]');
    await expect(notice).toBeVisible();
    await notice.getByRole('button', { name: 'Clear filters' }).click();
    await expect(row(page, 'mrd_payments_api')).toHaveClass(/is-highlighted/);
  });

  test('rows are keyboard reachable: arrows move, Enter selects', async ({ page }) => {
    await openLedger(page);
    const first = page.locator(ROWS).first();
    await first.focus();
    await expect(first).toBeFocused();
    await page.keyboard.press('ArrowDown');
    const second = page.locator(`${ROWS}[data-index="1"]`);
    await expect(second).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => search(page).get('object')).toMatch(/^route:default:/);
    await expect(second).toHaveClass(/is-highlighted/);
    await page.keyboard.press('End');
    await expect(page.locator(`${ROWS}[data-index="${activeCount() - 1}"]`)).toBeFocused();
    // Tab from a focused row reaches its "open in Cribl" link.
    await page.keyboard.press('Home');
    await page.keyboard.press('Tab');
    await expect(page.locator(`${ROWS}[data-index="0"] a[data-pipeline-link]`)).toBeFocused();
  });

  test('change timeline: commit diamonds, the newest is the story callout, click → who and what moved', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openLedger(page);
    const timeline = page.locator('[data-testid="change-timeline"]');
    await timeline.scrollIntoViewIfNeeded();
    const newest = timeline.locator('[data-callout="change-marker"]');
    await expect(newest).toHaveCount(1);
    await expect(newest).toHaveAttribute('data-commit', fixture.snapshot.timeline[0].hash.slice(0, 7));
    await expect(newest).toHaveClass(/is-cause/); // the open alert names this commit
    await expect(timeline.locator('.mr-ct-line').first()).toBeVisible();

    await newest.click();
    const card = page.locator('[data-testid="commit-card"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText('demo: break the trim on mrd_pay_sample');
    await expect(card).toContainText('by s.koelpin');
    await expect(card).toContainText('pipelines/mrd_pay_sample/conf.yml');
    await expect(card.locator('.mr-ct-card-moved')).toContainText('Payments API sampling');
    await expect(card.locator('.mr-ct-moved-figs.is-down')).toHaveCount(1);
    await card.scrollIntoViewIfNeeded();
    if (test.info().project.name === 'chromium') await card.screenshot({ path: 'tests/report/beauty/ledger-commit-card-light-1440.png' });

    // "What moved" selects the flow in the table.
    await card.locator('button.mr-ct-moved-row').first().click();
    await expect.poll(() => search(page).get('object')).toBe('route:default:mrd_payments_api');
    // The card closed with that selection; the diamond says so once the timeline has re-rendered (on a phone the
    // table's scroll to the row lands first), so the Enter below opens it rather than toggling a stale selection.
    await expect(newest).toHaveAttribute('aria-expanded', 'false');

    // Keyboard: Enter opens with focus on Close (not the card, which would wear a ring around its whole box —
    // P1-K03); Escape closes and returns focus to the diamond.
    await newest.focus();
    await page.keyboard.press('Enter');
    await expect(card).toBeVisible();
    await expect(card.getByRole('button', { name: 'Close' })).toBeFocused();
    await expect(card).not.toBeFocused();
    await page.keyboard.press('Escape');
    await expect(card).toBeHidden();
    await expect(newest).toBeFocused();
    expect(errors()).toEqual([]);
  });

  test('change timeline opens zoomed to the changes, with its diamonds apart; 24 h shows the whole day', async ({ page }) => {
    await openLedger(page);
    const timeline = page.locator('[data-testid="change-timeline"]');
    await timeline.scrollIntoViewIfNeeded();
    const radio = (name: string) => timeline.getByRole('radio', { name }).or(timeline.getByRole('button', { name })).first();
    await expect(radio('Changes')).toHaveAttribute('aria-checked', 'true');
    await expect(timeline.locator('.mr-ct-caption')).toContainText('around the latest changes');
    // The commits in range spread across the plot instead of stacking in its last pixels.
    const xs = await timeline.locator('.mr-ct-marker-diamond').evaluateAll((els) =>
      els.map((el) => {
        const b = el.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      }),
    );
    expect(xs.length).toBeGreaterThanOrEqual(2);
    const plot = await timeline.locator('.mr-ct-svg').boundingBox();
    if (!plot) throw new Error('no plot');
    const spread = Math.max(...xs.map((p) => p.x)) - Math.min(...xs.map((p) => p.x));
    expect(spread).toBeGreaterThan(plot.width * 0.2);
    // No two diamonds overlap: coincident ones stagger into rows.
    for (let i = 0; i < xs.length; i++)
      for (let j = i + 1; j < xs.length; j++) expect(Math.hypot(xs[i].x - xs[j].x, xs[i].y - xs[j].y)).toBeGreaterThanOrEqual(10);
    if (test.info().project.name === 'chromium') await timeline.screenshot({ path: 'tests/report/beauty/ledger-timeline-changes-light-1440.png' });
    await radio('24 h').click();
    await expect(timeline.locator('.mr-ct-caption')).toContainText('last 24 hours');
    expect(search(page).get('timeline')).toBeNull(); // view state; the URL keeps ?timeline= for 24 h / 7 d only
    if (test.info().project.name === 'chromium') await timeline.screenshot({ path: 'tests/report/beauty/ledger-timeline-24h-light-1440.png' });
    await radio('Changes').click();
    await expect(timeline.locator('.mr-ct-caption')).toContainText('around the latest changes');
  });

  test('change timeline: 7 d uses the daily trend and persists in the URL', async ({ page }) => {
    await openLedger(page);
    const timeline = page.locator('[data-testid="change-timeline"]');
    await timeline
      .getByRole('radio', { name: '7 d' })
      .or(timeline.getByRole('button', { name: '7 d' }))
      .first()
      .click();
    await expect.poll(() => search(page).get('timeline')).toBe('7d');
    await expect(timeline.locator('.mr-ct-caption')).toContainText('last 7 days');
    await expect(timeline.locator('.mr-ct-axis-label')).toContainText([/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d+$/]);
    // Every commit of the last hour is still marked on the 7-day view, and the newest carries the callout.
    expect(await timeline.locator('.mr-ct-marker').count()).toBeGreaterThanOrEqual(4);
    await expect(timeline.locator('[data-callout="change-marker"]')).toHaveCount(1);
    await expect(timeline.locator('.mr-ct-line').first()).toBeVisible();
    if (test.info().project.name === 'chromium')
      await timeline.screenshot({ path: 'tests/report/beauty/ledger-timeline-7d-light-1440.png' });
  });

  test('change timeline: the chart is a named group, so its commit buttons reach assistive tech (P1-K04)', async ({ page }) => {
    await openLedger(page);
    const timeline = page.getByTestId('change-timeline');
    await timeline.scrollIntoViewIfNeeded();
    const markers = await timeline.locator('.mr-ct-marker').count();
    expect(markers).toBeGreaterThanOrEqual(4);
    await expect(timeline.locator('svg.mr-ct-svg')).toHaveAttribute('role', 'group');
    // axe's nested-interactive, checked by hand (no axe dependency): no element whose children are presentational
    // (img, button, tab, …) holds a focusable descendant, on the page or with a commit card open.
    const nestedInteractive = () =>
      page.evaluate(() => {
        const presentational = ['img', 'image', 'button', 'checkbox', 'radio', 'tab', 'switch', 'slider', 'progressbar', 'meter', 'separator', 'option', 'math'];
        const focusable = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
        const out: string[] = [];
        for (const el of document.querySelectorAll('main [role]')) {
          if (!presentational.includes(el.getAttribute('role') ?? '')) continue;
          const inner = el.querySelector(focusable);
          if (inner) out.push(`${el.tagName.toLowerCase()}[role=${el.getAttribute('role')}] > ${inner.tagName.toLowerCase()}`);
        }
        return out;
      });
    expect(await nestedInteractive()).toEqual([]);
    // The accessibility tree names every commit button inside the chart's group.
    const commitButtons = (snapshot: string) => snapshot.split('\n').filter((l) => /- button "Commit [0-9a-f]{7} by /.test(l)).length;
    const tree = await timeline.ariaSnapshot();
    expect(tree).toMatch(/- group "Savings ratio, (last 24 hours|from .*, around the latest changes), \d+ commits? marked"/);
    expect(commitButtons(tree)).toBe(markers);
    await timeline.locator('[data-callout="change-marker"]').click();
    await expect(page.getByTestId('commit-card')).toBeVisible();
    expect(await nestedInteractive()).toEqual([]);
    expect(commitButtons(await timeline.ariaSnapshot())).toBe(markers);
  });

  test('change timeline on a phone: 7 d day labels never collide, commits sit in a strip under the axis, the line runs to now, the card docks inside the timeline (P1-K03)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openLedger(page, '/ledger?timeline=7d');
    const timeline = page.getByTestId('change-timeline');
    await timeline.scrollIntoViewIfNeeded();
    // Day labels: thinned to fit (every 2nd day at 390), counted back from today's, never touching.
    const labels = await timeline.locator('text.mr-ct-axis-label[text-anchor="middle"]').evaluateAll((els) =>
      els.map((el) => {
        const b = el.getBoundingClientRect();
        return { text: el.textContent ?? '', left: b.left, right: b.right };
      }),
    );
    expect(labels.length).toBeGreaterThanOrEqual(3);
    expect(labels.length).toBeLessThan(7);
    for (let i = 1; i < labels.length; i++) expect(labels[i].left, `${labels[i - 1].text} | ${labels[i].text}`).toBeGreaterThan(labels[i - 1].right + 4);
    // A day's label sits at its local noon (dayTicks), so before noon the newest label is yesterday's.
    const tz = fixture.settings.displayTimezone || 'UTC';
    const endMs = Date.parse(fixture.snapshot.windowEnd);
    const endHour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).format(endMs));
    const parts = new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', timeZone: tz }).formatToParts(endHour < 12 ? endMs - 86_400_000 : endMs);
    const part = (type: string) => parts.find((p) => p.type === type)?.value;
    expect(labels.at(-1)?.text).toBe(`${part('weekday')} ${part('day')}`);
    // Commits: in the strip under the axis (never stacked up into the plot, where they read as values), apart.
    const axis = await timeline.locator('.mr-ct-axis').boundingBox();
    if (!axis) throw new Error('no axis');
    const diamonds = await timeline.locator('.mr-ct-marker-diamond').evaluateAll((els) =>
      els.map((el) => {
        const b = el.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2, top: b.top };
      }),
    );
    expect(diamonds.length).toBeGreaterThanOrEqual(4);
    for (const d of diamonds) expect(d.top).toBeGreaterThan(axis.y);
    expect(new Set(diamonds.map((d) => Math.round(d.y))).size).toBe(1);
    const xs = diamonds.map((d) => d.x).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(11);
    // The line runs to now: it ends at the plot's right edge, where today's commits are.
    const line = await timeline.locator('.mr-ct-line').last().boundingBox();
    if (!line) throw new Error('no line');
    expect(line.x + line.width).toBeGreaterThanOrEqual(axis.x + axis.width - 4);
    // The commit card docks under the chart: inside the timeline card, clear of its title.
    const title = await timeline.getByRole('heading', { name: 'Change timeline' }).boundingBox();
    await timeline.locator('[data-callout="change-marker"]').click();
    const card = page.getByTestId('commit-card');
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-placement', 'docked');
    const box = await card.boundingBox();
    const outer = await timeline.boundingBox();
    if (!box || !outer || !title) throw new Error('no card');
    expect(box.x).toBeGreaterThanOrEqual(outer.x);
    expect(box.x + box.width).toBeLessThanOrEqual(outer.x + outer.width);
    expect(box.y).toBeGreaterThanOrEqual(outer.y);
    expect(box.y + box.height).toBeLessThanOrEqual(outer.y + outer.height);
    expect(box.y).toBeGreaterThan(axis.y + axis.height); // under the chart, so it covers neither the title nor the plot
    expect(box.y).toBeGreaterThan(title.y + title.height);
    await expect(card.getByRole('button', { name: 'Close' })).toBeFocused();
  });

  test('change timeline on desktop: the commit card floats beside its diamond, below the legend, even beside a short rail (P1-K03)', async ({ page, isMobile }) => {
    test.skip(isMobile, 'phones dock the card (previous test)');
    const quiet: LedgerDocs = { ...fixture, snapshot: { ...fixture.snapshot, incidents: [] } };
    const intersects = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    for (const [docs, path] of [
      [fixture, '/ledger'],
      [fixture, '/ledger?timeline=7d'],
      [quiet, '/ledger'], // no alerts: the rail is short, so the chart keeps its own height (no stretch)
    ] as const) {
      await openLedger(page, path, docs);
      const timeline = page.getByTestId('change-timeline');
      await timeline.scrollIntoViewIfNeeded();
      const marker = timeline.locator('[data-callout="change-marker"]');
      await marker.click();
      const card = page.getByTestId('commit-card');
      await expect(card).toBeVisible();
      await expect(card).toHaveAttribute('data-placement', 'float');
      const box = await card.boundingBox();
      const readout = await timeline.locator('.mr-ct-readout').boundingBox();
      const legend = await timeline.locator('.mr-ct-legend').boundingBox();
      const diamond = await marker.locator('.mr-ct-marker-diamond').boundingBox();
      if (!box || !readout || !legend || !diamond) throw new Error(`no card for ${path}`);
      expect(intersects(box, readout), `${path}: the card covers the legend readout`).toBe(false);
      expect(box.y).toBeGreaterThanOrEqual(legend.y + legend.height);
      expect(intersects(box, diamond), `${path}: the card covers its own diamond`).toBe(false);
      if (test.info().project.name === 'chromium' && docs === fixture)
        await timeline.screenshot({ path: `tests/report/beauty/ledger-commit-card${path.includes('7d') ? '-7d' : ''}-light-1440.png` });
    }
  });

  test('alerts rail: open and recent alerts with delivery status; "Show in table" selects the flow', async ({ page }) => {
    await openLedger(page);
    const rail = page.locator('[data-testid="incidents-rail"]');
    await rail.scrollIntoViewIfNeeded();
    await expect(rail.getByRole('heading', { name: /Alerts/ })).toBeVisible();
    await expect(rail).toContainText('Savings dropped: Payments API sampling');
    await expect(rail).toContainText('Sent to Slack · #finops-alerts');
    await expect(rail.locator('.mr-rail-group-title')).toHaveText(['Open', 'Recent · last 24 hours']);
    const recent = rail.locator('.mr-rail-group').nth(1);
    await expect(recent).toContainText('Kubernetes noise filter');
    // The recent group also lists the Windows pack's good news (P2-W06), so the click names its card.
    await recent.locator('article', { hasText: 'Kubernetes noise filter' }).getByRole('button', { name: 'Show in table' }).click();
    await expect.poll(() => search(page).get('object')).toBe('route:default:mrd_k8s_prod');
    await expect(row(page, 'mrd_k8s_prod')).toHaveClass(/is-highlighted/);
  });

  test('lower row: the timeline and the alerts rail end on one line; "Show in table" lives in its card; the demo note is said once (P1-K02)', async ({ page, isMobile }) => {
    await openLedger(page);
    const timeline = page.getByTestId('change-timeline');
    const rail = page.getByTestId('incidents-rail');
    await rail.scrollIntoViewIfNeeded();
    if (!isMobile) {
      const tb = await timeline.boundingBox();
      const rb = await rail.boundingBox();
      if (!tb || !rb) throw new Error('no lower row');
      expect(Math.abs(tb.height - rb.height)).toBeLessThanOrEqual(8);
      expect(Math.abs(tb.y + tb.height - (rb.y + rb.height))).toBeLessThanOrEqual(8);
    }
    // Every "Show in table" is inside the card it acts on, never a link floating under it.
    const actions = rail.getByRole('button', { name: 'Show in table' });
    await expect(actions).toHaveCount(fixture.snapshot.incidents.length);
    for (const action of await actions.all()) expect(await action.evaluate((el) => el.closest('.mr-inc') !== null)).toBe(true);
    // The demo-profile note: once, under the rail's caption, and in no card.
    expect(fixture.snapshot.incidents.some((i) => i.notes?.includes('demo-profile'))).toBe(true);
    await expect(rail.getByTestId('rail-demo-note')).toHaveText('1-minute confirmation (demo profile). Default is 3.');
    await expect(rail.getByText('1-minute confirmation (demo profile)')).toHaveCount(1);
    // No line of a card starts or ends on a visible "·" joiner: it wraps with the part after it, and one that would
    // start a line hangs outside the line's box, clipped (IncidentCard.css .mr-inc-tail).
    const strandedJoiners = await rail.locator('.mr-inc-line .mr-inc-sep').evaluateAll((seps) =>
      seps.filter((sep) => {
        const line = sep.closest('.mr-inc-line');
        if (!line) return false;
        const s = sep.getBoundingClientRect();
        const box = line.getBoundingClientRect();
        const center = (s.left + s.right) / 2;
        const visible = center > box.left && center < box.right;
        return visible && (center - box.left < 4 || box.right - center < 4);
      }).length,
    );
    expect(strandedJoiners).toBe(0);
    const project = test.info().project.name;
    if (project === 'chromium' || project === 'mobile')
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        const width = page.viewportSize()?.width ?? 0;
        await page.locator(isMobile ? '[data-testid="incidents-rail"]' : '.mr-ledger-lower').screenshot({
          path: `tests/report/screens/wave1-k-k02-lower-row-${width}-${theme}.png`,
        });
      }
  });

  test('lower row: a long list of alerts scrolls inside the rail, and the two cards still end on one line (P1-K02)', async ({ page, isMobile }) => {
    test.skip(isMobile, 'one column on phones: the rail is as long as its alerts');
    const open = fixture.snapshot.incidents.find((i) => !i.closedAt);
    if (!open) throw new Error('the fixture has an open alert');
    const many = Array.from({ length: 6 }, (_, k) => ({ ...open, id: `${open.id}_${k}`, objectKey: `route:default:extra_${k}`, label: `Extra flow ${k + 1}` }));
    await openLedger(page, '/ledger', { ...fixture, snapshot: { ...fixture.snapshot, incidents: [...fixture.snapshot.incidents, ...many] } });
    const timeline = page.getByTestId('change-timeline');
    const rail = page.getByTestId('incidents-rail');
    await rail.scrollIntoViewIfNeeded();
    const tb = await timeline.boundingBox();
    const rb = await rail.boundingBox();
    if (!tb || !rb) throw new Error('no lower row');
    expect(rb.height).toBeLessThanOrEqual(640 + 1);
    expect(Math.abs(tb.height - rb.height)).toBeLessThanOrEqual(8);
    const body = rail.locator('.mr-rail-body');
    expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true);
    // The header stays put while the alerts scroll.
    await body.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(rail.getByRole('heading', { name: /Alerts/ })).toBeInViewport();
    if (test.info().project.name === 'chromium')
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await page.locator('.mr-ledger-lower').screenshot({ path: `tests/report/screens/wave1-k-k02-many-alerts-1440-${theme}.png` });
      }
  });

  test('no data yet is a designed empty state', async ({ page }) => {
    const empty: LedgerDocs = {
      ...fixture,
      snapshot: {
        ...fixture.snapshot,
        flows: [],
        incidents: [],
        timeline: [],
        ratioSeries: [],
        trend: [],
      },
    };
    await gotoApp(page, '/ledger');
    await injectLedgerDocs(page, empty);
    await page.goto('/ledger', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await expect(page.locator('[data-state="no-flows"]')).toContainText('No flows yet');
    await expect(page.locator('[data-testid="incidents-rail"]')).toContainText('No open alerts');
    await expect(page.locator('[data-testid="change-timeline"]')).toContainText('No history yet');
    if (test.info().project.name === 'chromium') {
      await page.screenshot({ path: 'tests/report/beauty/ledger-empty-light-1440.png', fullPage: true });
    }
  });
});

// ─── Wave 2: the table nits (P1-K05) and the loading / error states (P1-K06) ─────────────────────────────

/** A copy of the fixture with its flows edited (a muted flow, an unpriced one …). */
function withFlows(edit: (flows: LedgerDocs['snapshot']['flows'], sweepAtMs: number) => void): LedgerDocs {
  const docs = structuredClone(fixture);
  edit(docs.snapshot.flows, Date.parse(docs.snapshot.sweepAt));
  return docs;
}

/** The first active (priced, trafficked) flow that no alert colours: the one the nits tests edit. */
function calmFlowIndex(flows: LedgerDocs['snapshot']['flows']): number {
  return flows.findIndex((f) => f.inBPerDay > 0 && f.state === 'ok' && !f.inputId.includes('payments'));
}

/** WCAG 1.4.12 text spacing, exactly as the accessibility probe applied it (tests/report/audit/accessibility/probe2.ts). */
const TEXT_SPACING_CSS = `* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }`;

function shotName(page: Page, id: string, theme: Theme): string {
  return `tests/report/screens/wave2-k-${id}-${page.viewportSize()?.width ?? 0}-${theme}.png`;
}

test.describe('Ledger table nits (P1-K05)', () => {
  test('the muted chip reads whole in sentence case, the sentence in its title', async ({ page }) => {
    const docs = withFlows((flows, at) => {
      const i = calmFlowIndex(flows);
      flows[i] = { ...flows[i], muted: true, mutedUntil: new Date(at + 5.5 * 60_000).toISOString() };
    });
    await openLedger(page, '/ledger', docs);
    const chip = page.locator(`${ROWS} .mr-lt-chip[data-status="muted"]`);
    await expect(chip).toHaveText('Muted · 6 min');
    await expect(chip).toHaveAttribute('title', 'Muted after a demo change · 6 min left');
    expect(await clippedNames(page, `${ROWS} .mr-lt-chip-text`)).toEqual([]);
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await page.locator('.mr-ledger-flows').screenshot({ path: shotName(page, 'k05-muted', theme) });
    }
  });

  test('the sort caret sits on its label line, and headers share one bottom line', async ({ page, isMobile }) => {
    test.skip(isMobile, 'phones have no column headers');
    await openLedger(page);
    const saved = page.locator('[role="columnheader"].is-sorted');
    const caret = await saved.locator('.mr-lt-sort-icon').boundingBox();
    const label = await saved.locator('.mr-lt-th-label').boundingBox();
    const unit = await saved.locator('.mr-lt-th-unit').boundingBox();
    if (!caret || !label || !unit) throw new Error('no sorted header');
    // The caret is centred on the label's line, not between the label and its unit.
    expect(Math.abs(caret.y + caret.height / 2 - (label.y + label.height / 2))).toBeLessThanOrEqual(2);
    expect(caret.y + caret.height).toBeLessThan(unit.y + 1);
    // A one-line head ("Source") ends on the same line as a two-line head's unit ("/ day").
    const source = await page.locator('[role="columnheader"]').first().locator('.mr-lt-th-label').boundingBox();
    if (!source) throw new Error('no Source header');
    expect(Math.abs(source.y + source.height - (unit.y + unit.height))).toBeLessThanOrEqual(2);
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await page.locator('.mr-lt-head').screenshot({ path: shotName(page, 'k05-head', theme) });
    }
  });

  test('one "Clear filters" per state: filtered to zero, a hidden deep link, and a filtered list', async ({ page }) => {
    const clears = page.locator('.mr-ledger').getByRole('button', { name: 'Clear filters' });
    await openLedger(page);
    await page.goto('/ledger?q=no-such-flow', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await expect(page.locator('[data-state="filtered-empty"]')).toBeVisible();
    await expect(clears).toHaveCount(1);
    await page.goto('/ledger?object=route:default:mrd_payments_api&dest=mrd_archive_s3', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await expect(page.locator('[data-state="object-hidden"]')).toBeVisible();
    await expect(clears).toHaveCount(1);
    await page.goto('/ledger?state=regression', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await expect(page.locator(ROWS)).toHaveCount(1);
    await expect(clears).toHaveCount(1);
  });

  test('?dest= and ?group= the sweep does not know: a notice, every flow listed, never an option', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openLedger(page, '/ledger?dest=nope&group=nowhere');
    const notice = page.locator('[data-state="filter-missing"]');
    await expect(notice).toContainText("Destination nope isn't in the latest sweep");
    await expect(notice).toContainText("Worker group nowhere isn't in the latest sweep");
    await expect(page.locator(ROWS)).toHaveCount(activeCount());
    // The destination menu offers only what the sweep knows.
    await page.locator('[data-filter="dest"] button').first().click();
    const options = page.getByRole('option');
    await expect(options.first()).toBeVisible();
    await expect(options.filter({ hasText: /nope/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await page.locator('.mr-ledger-flows').screenshot({ path: shotName(page, 'k05-unknown-filter', theme) });
    }
    await setTheme(page, 'light');
    await notice.getByRole('button', { name: 'Close' }).click();
    await expect.poll(() => search(page).get('dest')).toBeNull();
    await expect.poll(() => search(page).get('group')).toBeNull();
    await expect(notice).toHaveCount(0);
    expect(errors()).toEqual([]);
  });

  test('a deep link to a flow key reads as its pipeline, never the raw pipe-separated key', async ({ page }) => {
    const pay = fixture.snapshot.flows.find((f) => f.inputId === 'mrd_payments_api');
    if (!pay) throw new Error('no payments flow');
    await openLedger(page, `/ledger?object=${encodeURIComponent(pay.key)}&dest=mrd_archive_s3`);
    const notice = page.locator('[data-state="object-hidden"]');
    await expect(notice).toContainText('Payments API sampling · The linked flow is hidden');
    await expect(notice).not.toContainText('|');
  });

  test('an unpriced flow on a phone card reads "—", with no "/ day" after it', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'the card layout');
    const docs = withFlows((flows) => {
      const i = calmFlowIndex(flows);
      flows[i] = { ...flows[i], state: 'unpriced' };
    });
    await openLedger(page, '/ledger', docs);
    const card = page.locator(`${ROWS}[data-status="unpriced"]`);
    await expect(card.locator('.mr-lt-card-saved')).toHaveText('—');
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await card.screenshot({ path: shotName(page, 'k05-unpriced-card', theme) });
    }
  });

  test('pipeline links show their "open in Cribl" icon at rest; rows under the sticky totals fade instead of being sliced', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, 'the totals row is desktop only');
    await page.setViewportSize({ width: 1440, height: 900 });
    await openLedger(page, '/ledger?quiet=show');
    const icon = page.locator(`${ROWS} .mr-lt-link-icon`).first();
    expect(Number(await icon.evaluate((el) => getComputedStyle(el).opacity))).toBeCloseTo(0.6, 2);
    const table = page.locator('.mr-lt');
    await expect(table).toHaveAttribute('data-more-below', 'true');
    const fade = () => page.locator('.mr-lt-foot').evaluate((el) => Number(getComputedStyle(el, '::before').opacity));
    await expect.poll(fade).toBe(1);
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await page.locator('.mr-ledger-flows').screenshot({ path: shotName(page, 'k05-totals-fade', theme) });
    }
    await page.getByTestId('ledger-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(table).toHaveAttribute('data-more-below', 'false');
    await expect.poll(fade).toBe(0);
  });

  test('with WCAG text spacing applied no figure loses a leading digit', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the figure columns are desktop only');
    await openLedger(page);
    await page.addStyleTag({ content: TEXT_SPACING_CSS });
    await page.waitForTimeout(100);
    const clipped = await page.locator('.mr-lt-td--end .mr-num').evaluateAll((els) =>
      els
        .filter((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          const text = range.getBoundingClientRect();
          // The nearest ancestor that clips: the figure must fit inside it.
          for (let n = el.parentElement; n; n = n.parentElement) {
            const cs = getComputedStyle(n);
            if (cs.overflowX !== 'visible' || cs.overflow !== 'visible') {
              const box = n.getBoundingClientRect();
              return text.left < box.left - 0.5 || text.right > box.right + 0.5;
            }
          }
          return false;
        })
        .map((el) => el.textContent ?? ''),
    );
    expect(clipped).toEqual([]);
    await page.locator('.mr-ledger-flows').screenshot({ path: shotName(page, 'k05-text-spacing', 'light') });
  });
});

test.describe('Ledger loading and error states (P1-K06)', () => {
  test('the skeleton is the loaded page\'s frame: within 10 % of its height, lower row included', async ({ page }) => {
    await openLedger(page);
    await mockControl(page, { action: 'config', options: { latencyMs: 2500 } });
    await page.reload({ waitUntil: 'domcontentloaded' });
    const skeleton = page.locator('.mr-ledger[data-state="loading"]');
    await expect(skeleton).toBeVisible();
    await expect(skeleton.locator('.mr-ledger-lower')).toBeVisible();
    const loadingH = (await skeleton.boundingBox())?.height ?? 0;
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await page.screenshot({ path: shotName(page, 'k06-skeleton', theme), fullPage: true });
    }
    await expect(page.locator(ROWS).first()).toBeVisible({ timeout: 30_000 });
    await mockControl(page, { action: 'config', options: { latencyMs: 0 } });
    await setTheme(page, 'light');
    const loadedH = (await page.locator('.mr-ledger[data-state="ready"]').boundingBox())?.height ?? 0;
    const parts = await page.evaluate(() =>
      ['.mr-ledger-flows', '.mr-ledger-lower', '.mr-ledger-timeline', '.mr-ledger-rail'].map((sel) => `${sel} ${Math.round(document.querySelector(sel)?.getBoundingClientRect().height ?? 0)}`),
    );
    console.log(`[ledger-skeleton] parts ${parts.join(' · ')}`);
    console.log(`[ledger-skeleton] ${page.viewportSize()?.width}: skeleton ${loadingH} px, loaded ${loadedH} px`);
    expect(Math.abs(loadingH - loadedH) / loadedH).toBeLessThanOrEqual(0.1);
  });

  test('a snapshot 503 with nothing on screen: one alert, and no first-run "No flows yet"', async ({ page }) => {
    await openLedger(page);
    await mockControl(page, { action: 'fault', method: 'GET', path: '/kvstore/snapshot', status: 503, times: -1 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    const ledger = page.locator('.mr-ledger');
    await expect(ledger).toHaveAttribute('data-state', 'error');
    await expect(ledger.locator('[data-state="server-error"]')).toHaveCount(1);
    await expect(ledger.locator('[data-state="forbidden"], [data-state="network"], [data-state="rate-limited"]')).toHaveCount(0);
    await expect(page.getByText('No flows yet')).toHaveCount(0);
    await expect(page.getByText('No history yet')).toHaveCount(0);
    await expect(page.getByText('No open alerts')).toHaveCount(0);
    await expect(ledger.locator('[data-state="unreadable"]')).toContainText("Flows can't be listed right now");
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await page.screenshot({ path: shotName(page, 'k06-503', theme), fullPage: true });
    }
    await mockControl(page, { action: 'clearFaults' });
  });
});

// ─── Wave 2: every commit priced (P2-W07) ────────────────────────────────────

/** The fixture's commits of the last 7 days, by short hash (what the "Changes" list must list, once each). */
function weekCommits(): string[] {
  const end = Date.parse(fixture.snapshot.windowEnd);
  const hashes = fixture.snapshot.timeline
    .filter((c) => {
      const t = Date.parse(c.deployedAt ?? c.committedAt);
      return t >= end - 7 * 86_400_000 && t <= end;
    })
    .map((c) => c.hash.slice(0, 7));
  return [...new Set(hashes)];
}

test.describe('Every commit priced (P2-W07)', () => {
  test('the commit card carries a dollar line, and the chart names the largest priced change in view', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openLedger(page);
    const timeline = page.getByTestId('change-timeline');
    const marker = timeline.locator('[data-callout="change-marker"]');
    await marker.scrollIntoViewIfNeeded();
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await timeline.screenshot({ path: shotName(page, 'w07-annotation', theme) });
    }
    await setTheme(page, 'light');
    await marker.click();
    const impact = page.getByTestId('commit-card').getByTestId('commit-impact');
    await expect(impact).toBeVisible();
    // The newest commit broke the trim on the payments flow: a loss, priced by the alert that names it.
    await expect(impact.locator('.mr-ct-card-impact-line')).toHaveText(/^−\$[\d,]+ a day since this deploy$/);
    await expect(impact).toHaveAttribute('data-basis', 'alert');
    await expect(impact).toContainText(/−\$[\d,]+ a year/);
    await expect(impact).toContainText('Priced by the alert that names it');
    await expect(page.getByTestId('commit-card').locator('.mr-ct-moved-money').first()).toHaveText(/^[+−]\$[\d,]+ \/ day$/);
    const annotation = timeline.getByTestId('timeline-annotation');
    await expect(annotation).toHaveCount(1);
    await expect(annotation).toContainText(/^[+−]\$[\d,]+ \/ day\s*since [0-9a-f]{7} · /);
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await page.locator('.mr-ledger-lower').screenshot({ path: shotName(page, 'w07-card', theme) });
    }
    expect(errors()).toEqual([]);
  });

  test('the "Changes" list: one row per commit of the last 7 days, sorted by dollars, each opening its commit', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openLedger(page);
    const list = page.getByTestId('changes-list');
    await expect(list.getByRole('heading', { name: 'Changes' })).toBeVisible();
    const rows = list.locator('[data-changes-row]');
    await expect(rows).toHaveCount(weekCommits().length);
    expect((await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-commit')))).sort()).toEqual([...weekCommits()].sort());
    // Priced first, biggest |$| first.
    const amounts = await list.locator('[data-status="priced"] .mr-changes-amount').allInnerTexts();
    expect(amounts.length).toBeGreaterThanOrEqual(2);
    const dollars = amounts.map((a) => Number(a.replace(/[^0-9]/g, '')));
    expect(dollars).toEqual([...dollars].sort((a, b) => b - a));
    // Both directions: a gain and a loss are both on the receipt.
    await expect(list.locator('.mr-changes-amount.is-up').first()).toBeVisible();
    await expect(list.locator('.mr-changes-amount.is-down').first()).toBeVisible();
    await expect(list.getByTestId('changes-net')).toContainText('Net of the priced changes');
    // On a phone a message keeps one line and the figure its own, with no stranded leader (review W2).
    if ((page.viewportSize()?.width ?? 0) <= 640) {
      const lines = await list.locator('[data-changes-row] .mr-changes-message').evaluateAll((els) =>
        els.map((e) => Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight))),
      );
      for (const n of lines) expect(n).toBe(1);
      for (const leader of await list.locator('.mr-changes-leader').all()) await expect(leader).toBeHidden();
    }
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await list.screenshot({ path: shotName(page, 'w07-changes', theme) });
    }
    await setTheme(page, 'light');
    // A row opens its commit on the timeline, and the URL keeps it.
    const first = rows.first();
    const hash = (await first.getAttribute('data-commit')) ?? '';
    await first.click();
    await expect.poll(() => search(page).get('commit')).toBe(hash);
    const card = page.getByTestId('commit-card');
    await expect(card).toBeVisible();
    await expect(card.locator('.mr-ct-card-hash')).toContainText(hash);
    await expect(first).toHaveAttribute('aria-pressed', 'true');
    // A pasted link opens the same card.
    await page.goto(`/ledger?commit=${hash}`, { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await expect(page.getByTestId('commit-card').locator('.mr-ct-card-hash')).toContainText(hash);
    await page.getByTestId('commit-card').getByRole('button', { name: 'Close' }).click();
    await expect.poll(() => search(page).get('commit')).toBeNull();
    expect(errors()).toEqual([]);
  });
});

// ─── Wave 2: the ledger reads as a ledger (P2-W17) ───────────────────────────

/** The listed (active) flows' money, summed like totals(): unpriced flows add no money. */
function listedSums(): { whp: number; paid: number; saved: number } {
  const active = fixture.snapshot.flows.filter((f) => f.inBPerDay > 0 || f.outBPerDay > 0 || f.whpPerDayM > 0 || f.paidPerDayM > 0);
  const priced = active.filter((f) => f.state !== 'unpriced');
  return {
    whp: priced.reduce((a, f) => a + f.whpPerDayM, 0),
    paid: priced.reduce((a, f) => a + f.paidPerDayM, 0),
    saved: priced.reduce((a, f) => a + f.savedPerDayM, 0),
  };
}

test.describe('The ledger reads as a ledger (P2-W17)', () => {
  test("every row has a saved bar as wide as its saved dollars against the column's largest (review W2)", async ({ page }) => {
    await openLedger(page);
    const bars = await page.locator(`${ROWS}`).evaluateAll((rows) =>
      rows.map((r) => {
        const track = r.querySelector('.mr-lt-bar');
        const fill = r.querySelector('.mr-lt-bar-fill');
        return {
          id: r.getAttribute('data-row-id') ?? '',
          track: track?.getBoundingClientRect().width ?? -1,
          fill: fill?.getBoundingClientRect().width ?? -1,
        };
      }),
    );
    expect(bars.length).toBe(activeCount());
    const flowOf = (id: string) => fixture.snapshot.flows.find((x) => x.key === id);
    const max = Math.max(...bars.map((b) => flowOf(b.id)).filter((f) => f && f.state !== 'unpriced').map((f) => f!.savedPerDayM));
    for (const b of bars) {
      const f = flowOf(b.id);
      if (!f) throw new Error(`no flow ${b.id}`);
      expect(b.track, b.id).toBeGreaterThan(20);
      const share = f.state !== 'unpriced' && max > 0 ? Math.min(1, Math.max(0, f.savedPerDayM / max)) : 0;
      expect(Math.abs(b.fill - share * b.track), `${b.id}: ${b.fill} vs ${share} × ${b.track}`).toBeLessThanOrEqual(2);
    }
  });

  test('the money strip is the table’s totals, per day, with a named basis and a 24-hour delta', async ({ page, isMobile }) => {
    await openLedger(page);
    const strip = page.getByTestId('ledger-strip');
    const sums = listedSums();
    const value = async (tile: string) => Number(await strip.locator(`[data-tile="${tile}"] .mr-ledger-tile-figure`).getAttribute('data-value'));
    expect(await value('whp')).toBe(sums.whp);
    expect(await value('paid')).toBe(sums.paid);
    expect(await value('saved')).toBe(sums.saved);
    await expect(strip).toContainText("Per day at the last hour's rate");
    await expect(strip.locator('[data-tile="saved"]')).toContainText(/of would have paid/);
    await expect(strip.locator('[data-tile="saved"] [data-delta="true"]')).toContainText(/since this time yesterday|Level with this time yesterday/);
    if (!isMobile) {
      // The strip and the sticky totals row say the same figures.
      const totalsSaved = await page.locator('.mr-lt-totals .mr-lt-td--saved .mr-num').innerText();
      await expect(strip.locator('[data-tile="saved"] .mr-num').first()).toHaveText(totalsSaved);
      // The totals label is a receipt line: mono face, a dot leader to the figures.
      const label = page.locator('.mr-lt-totals-label');
      expect(await label.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/Source Code Pro/);
      await expect(label.locator('.mr-lt-leader')).toHaveCount(1);
    } else {
      // On a phone the strip carries the count the toolbar hides, and replaces the old summary line.
      await expect(strip.locator('.mr-ledger-strip-count')).toBeVisible();
      await expect(page.locator('.mr-ledger-summary')).toHaveCount(0);
    }
    // A filter moves the strip with the table, and drops the workspace-wide delta.
    await page.goto('/ledger?state=regression', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    const pay = fixture.snapshot.flows.find((f) => f.inputId === 'mrd_payments_api');
    expect(await value('saved')).toBe(pay?.savedPerDayM);
    await expect(strip.locator('[data-delta="true"]')).toHaveCount(0);
  });

  test('the trend ends with its value and colours only what came after the newest commit', async ({ page }) => {
    await openLedger(page);
    const pay = row(page, 'mrd_payments_api');
    const flow = fixture.snapshot.flows.find((f) => f.inputId === 'mrd_payments_api');
    const last = flow?.sparkline.at(-1) ?? 0;
    await expect(pay.locator('.mr-lt-trend-end')).toHaveText(`${Math.round(last * 100)}%`);
    // The newest commit broke this flow's trim inside its 30-minute line: before it quiet, after it red.
    await expect(pay.locator('.mr-sparkline--split .mr-sparkline-after')).toHaveCount(1);
  });

  test('table ↔ timeline: a row lights its commits on the chart, a diamond lights its rows', async ({ page, isMobile }) => {
    test.skip(isMobile, 'hover is a pointer affordance');
    await openLedger(page);
    const timeline = page.getByTestId('change-timeline');
    const pay = row(page, 'mrd_payments_api');
    await pay.hover();
    await expect(timeline.getByTestId('timeline-link')).toHaveClass(/is-highlighted/);
    await expect(timeline.locator('[data-callout="change-marker"]')).toHaveClass(/is-linked/);
    await expect(timeline.locator('.mr-ct-readout')).toContainText('Payments API sampling · ');
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await page.locator('.mr-ledger').screenshot({ path: shotName(page, 'w17-row-hover', theme) });
    }
    await setTheme(page, 'light');
    await page.mouse.move(0, 0);
    await expect(timeline.getByTestId('timeline-link')).toHaveCount(0);
    // The other way: the newest diamond names the payments flow's row.
    const newest = timeline.locator('[data-callout="change-marker"]');
    await newest.scrollIntoViewIfNeeded();
    await newest.hover();
    await expect(pay).toHaveClass(/is-linked/);
    await expect(page.locator(`${ROWS}.is-linked`)).toHaveCount(1);
    await page.mouse.move(0, 0);
    await expect(page.locator(`${ROWS}.is-linked`)).toHaveCount(0);
  });

  test('screens: the strip and the table in both themes', async ({ page }) => {
    await openLedger(page);
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: shotName(page, 'w17-ledger', theme), fullPage: false });
    }
  });
});

// ─── Wave 2: the Receipt's range on the Ledger (P2-W14) ──────────────────────

test.describe("The Receipt's custom range on the Ledger (P2-W14)", () => {
  test('/ledger?range=7d: the money columns sum the window, and their totals reconcile to the Receipt’s figure', async ({ page, isMobile }) => {
    test.setTimeout(120_000);
    const errors = trackConsoleErrors(page);
    await openLedger(page);
    // Seven days of rollup history for the same rig, as the sweep would have written it.
    const at = await page.evaluate(() => Date.now());
    const since = Date.parse(fixture.snapshot.collectingSince);
    const seeded = await mockControl(page, { action: 'seedRollups', at, since, tz: fixture.settings.displayTimezone });
    expect(seeded.keys as number).toBeGreaterThan(20);

    await page.goto('/ledger?range=7d', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    const banner = page.getByTestId('ledger-window');
    await expect(banner).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    await expect(banner).toContainText('Money columns sum');
    await expect(banner).toContainText('(7 days)');
    await expect(page.locator('.mr-lt')).toHaveAttribute('data-window', 'true');
    if (!isMobile) {
      // A window header on each money column instead of "/ day".
      for (const key of ['whp', 'paid', 'saved']) {
        await expect(page.locator(`[role="columnheader"] button[data-sort-key="${key}"] .mr-lt-th-unit`)).toHaveText('7 days');
      }
    }
    const strip = page.getByTestId('ledger-strip');
    await expect(strip).toHaveAttribute('data-window', 'true');
    await expect(strip).toContainText('Summed over');
    const listedSaved = Number(await strip.locator('[data-tile="saved"] .mr-ledger-tile-figure').getAttribute('data-value'));
    if (!isMobile) expect(Number(await page.locator('.mr-lt-totals .mr-lt-td--saved').getAttribute('data-value-m'))).toBe(listedSaved);
    const unlisted = page.getByTestId('ledger-unlisted');
    const unlistedSaved = (await unlisted.count()) > 0 ? Number(await unlisted.getAttribute('data-saved-m')) : 0;
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: shotName(page, 'w14-range', theme) });
    }
    await setTheme(page, 'light');

    // The Receipt, same window (the range is a sticky param): its hero figure is the table's total plus the
    // flows the window metered that the latest sweep no longer lists.
    await page.goto('/?range=7d', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    const hero = page.getByTestId('receipt-hero');
    await expect(hero).toHaveAttribute('data-range-status', 'ready', { timeout: 30_000 });
    const receiptSaved = Number(await hero.locator('[data-callout="saved"]').getAttribute('data-value-m'));
    expect(listedSaved + unlistedSaved).toBe(receiptSaved);

    // "Show per day" clears the range: the columns are rates again.
    await page.goto('/ledger?range=7d', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await expect(banner).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    await banner.getByRole('button', { name: 'Show per day' }).click();
    await expect.poll(() => search(page).get('range')).toBeNull();
    await expect(page.locator('.mr-lt')).not.toHaveAttribute('data-window', 'true');
    await expect(strip).toContainText("Per day at the last hour's rate");
    expect(errors()).toEqual([]);
  });
});

// ─── Beauty grid ─────────────────────────────────────────────────────────────

const WIDTHS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;
const THEMES: Theme[] = ['light', 'dark'];

/** Text the Ledger draws itself, checked for WCAG contrast against the colour actually painted behind it. */
const CONTRAST_TARGETS = [
  { name: 'page subtitle', selector: '.mr-ledger .mr-page-subtitle' },
  { name: 'column header', selector: '.mr-lt-th-label' },
  { name: 'column unit', selector: '.mr-lt-th-unit' },
  { name: 'body text', selector: '.mr-lt-row:not(.is-highlighted) .mr-lt-td :is(.mr-lt-name, .mr-truncate)' },
  { name: 'saved figure', selector: '.mr-lt-row:not(.is-highlighted) .mr-lt-td--saved .mr-saved .mr-num' },
  { name: 'saved figure, selected row', selector: '.mr-lt-row.is-highlighted .mr-lt-td--saved .mr-saved .mr-num' },
  { name: 'would-have-paid figure', selector: '.mr-lt-row:not(.is-highlighted) .mr-lt-td--whp .mr-whp .mr-num' },
  { name: 'zero figure', selector: '.mr-lt-row .mr-lt-zero .mr-num' },
  { name: 'high chip', selector: '.mr-lt-chip--high .mr-lt-chip-text' },
  { name: 'medium chip', selector: '.mr-lt-chip--medium .mr-lt-chip-text' },
  { name: 'status text', selector: '.mr-lt-ok' },
  { name: 'narrow path caption', selector: '.mr-lt-card-path' },
  { name: 'toolbar count', selector: '.mr-ledger-count' },
  { name: 'timeline caption', selector: '.mr-ct-caption' },
  { name: 'timeline axis label', selector: '.mr-ct-axis-label', svg: true },
  { name: 'timeline readout', selector: '.mr-ct-readout' },
  { name: 'rail caption', selector: '.mr-rail-caption' },
] as const;

/** WCAG 2.x contrast of each visible target against its composited background (both parsed from computed styles). */
async function contrastReport(page: Page): Promise<{ name: string; ratio: number; fg: string; bg: string }[]> {
  return page.evaluate(
    (targets) => {
      const probe = document.createElement('canvas').getContext('2d');
      type RGBA = [number, number, number, number];
      // Normalizes any CSS colour (rgb(), color(srgb …), oklch(), color-mix results …) through a 2D context fill.
      const parse = (css: string): RGBA | null => {
        if (!probe || !css) return null;
        probe.clearRect(0, 0, 1, 1);
        probe.fillStyle = '#000';
        probe.fillStyle = css;
        probe.fillRect(0, 0, 1, 1);
        const d = probe.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2], d[3] / 255];
      };
      const over = (top: RGBA, under: RGBA): RGBA => {
        const a = top[3] + under[3] * (1 - top[3]);
        if (a === 0) return [0, 0, 0, 0];
        const c = (i: number) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a;
        return [c(0), c(1), c(2), a];
      };
      const backdrop = (el: Element): RGBA => {
        const layers: RGBA[] = [];
        for (let n: Element | null = el; n; n = n.parentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c && c[3] > 0) {
            layers.push(c);
            if (c[3] >= 1) break;
          }
        }
        let acc: RGBA = parse(getComputedStyle(document.body).backgroundColor) ?? [255, 255, 255, 1];
        for (const layer of layers.reverse()) acc = over(layer, acc);
        return acc;
      };
      const lum = ([r, g, b]: RGBA) => {
        const f = (v: number) => {
          const x = v / 255;
          return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const out: { name: string; ratio: number; fg: string; bg: string }[] = [];
      for (const t of targets) {
        const el = [...document.querySelectorAll(t.selector)].find((e) => e.getClientRects().length > 0);
        if (!el) continue;
        const style = getComputedStyle(el);
        const bg = backdrop(el);
        const raw = parse('svg' in t && t.svg ? style.fill : style.color);
        if (!raw) continue;
        const fg = over(raw, bg);
        const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
        out.push({
          name: t.name,
          ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100,
          fg: `rgb(${fg.slice(0, 3).map(Math.round).join(',')})`,
          bg: `rgb(${bg.slice(0, 3).map(Math.round).join(',')})`,
        });
      }
      return out;
    },
    CONTRAST_TARGETS as unknown as { name: string; selector: string; svg?: boolean }[],
  );
}

test.describe('Ledger beauty grid', () => {
  for (const theme of THEMES) {
    for (const size of WIDTHS) {
      test(`screenshot ${theme} ${size.width}`, async ({ page }, info) => {
        test.skip(info.project.name !== 'chromium', 'the grid is shot once, from the chromium project');
        await page.setViewportSize(size);
        const errors = trackConsoleErrors(page);
        await openLedger(page, '/ledger?object=route:default:mrd_payments_api');
        await setTheme(page, theme);
        // No horizontal page scroll at any width (PRD 8.8 item 9).
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBeLessThanOrEqual(0);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(150);
        await page.screenshot({ path: `tests/report/beauty/ledger-${theme}-${size.width}.png`, fullPage: true });
        // PRD 8.8 item 3 / DESIGN_BRIEF 2: every text/background pair ≥ 4.5:1, checked by the test, not by eye.
        const contrast = await contrastReport(page);
        info.annotations.push({ type: 'contrast', description: JSON.stringify(contrast) });
        expect(contrast.length).toBeGreaterThanOrEqual(8); // phones have no header / table cells, so fewer pairs
        const worst = [...contrast].sort((a, b) => a.ratio - b.ratio)[0];
        console.log(`[ledger-contrast] ${theme} ${size.width}: ${contrast.length} pairs, lowest ${worst.ratio}:1 (${worst.name})`);
        for (const c of contrast) expect.soft(c.ratio, `${c.name} ${c.fg} on ${c.bg}`).toBeGreaterThanOrEqual(4.5);
        if (size.width === 390) {
          // The commit card at phone width: docked under the chart, inside the screen, nothing clipped (P1-K03).
          const marker = page.locator('[data-callout="change-marker"]');
          await marker.scrollIntoViewIfNeeded();
          await marker.click();
          const card = page.locator('[data-testid="commit-card"]');
          await expect(card).toBeVisible();
          const box = await card.boundingBox();
          expect(box !== null && box.x >= 0 && box.x + box.width <= size.width).toBe(true);
          await card.screenshot({ path: `tests/report/beauty/ledger-commit-card-${theme}-390.png` });
        }
        expect(errors()).toEqual([]);
      });
    }
  }
});
