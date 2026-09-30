// tests/e2e/settings.spec.ts — Settings (PRD 8.4, 6; SPEC 5, 6, 8, 12.5, 12.6, 13, 17; DESIGN_BRIEF 5.5).
//
// Runs against the in-browser Cribl emulator (VITE_MR_MOCK=1, release build flags). Each test gets a fresh
// browser context, so the emulator's localStorage-backed Leader — and its KV — start empty. The 'ui' runtime
// does not sweep until prices exist (REVIEW-3a #3), so the Prices page lists the destinations it reads
// straight from the Leader; the first sweep runs the moment prices are saved.
//
// The beauty test saves the screenshot grid to tests/report/beauty/settings-<theme>-<width>.png.

import { expect, test, type Page } from '@playwright/test';
import { fmtBytes, fmtDollars, footColumn } from '../../core/format.ts';
import { clearSink, expectPath, gotoApp, kvGet, mockCalls, resetCalls, resetMock, seedPrices, setTheme, trackConsoleErrors, waitForHydration, waitForMock, type Theme } from './helpers/index.ts';

const SIEM = 'mrd_siem_prod';
const ANALYTICS = 'mrd_analytics';
const ARCHIVE = 'mrd_archive_s3';
/** The emulated group's built-in DevNull output — a real, listed destination. */
const DEVNULL = 'devnull';
/** The dev server re-optimizing a dependency mid-run is an environment artifact, not an app error. */
const ALLOW = [/Outdated Optimize Dep/];
const SLACK_URL = 'https://hooks.slack.com/services/T0000/B0000/XXXXabcd';

/** Destinations appear after the first sweep writes the inventory. */
async function waitForRows(page: Page): Promise<void> {
  await expect(page.getByTestId(`price-row-${SIEM}`)).toBeVisible({ timeout: 40_000 });
}

function priceInput(page: Page, outputId: string) {
  return page.getByTestId(`price-input-${outputId}`);
}

async function saveCard(page: Page, section: string): Promise<void> {
  // A never-priced workspace's first Prices save reads "Start the meter" (P2-W09).
  await page.locator(`section[data-section="${section}"]`).getByRole('button', { name: /^(Save changes|Start the meter)$/ }).click();
}

async function expectSavedToast(page: Page): Promise<void> {
  await expect(page.getByText(/^(Changes saved|The meter is running\.)/).first()).toBeVisible();
}

async function kvJson<T>(page: Page, key: string): Promise<T | null> {
  const raw = await kvGet(page, key);
  return raw === null ? null : (JSON.parse(raw) as T);
}

interface StoredSettings {
  budgets?: Record<string, { centsPerMonth: number }>;
  criblCostCentsPerMonth?: number;
  thresholds?: { regressionPoints: number; ewmaAlpha: number };
  notifications?: { url: string; host?: string; channel?: string; criblTargetId?: string; weeklyReceipt?: boolean; lastTest?: { status: number } }[];
}
const settingsDoc = (page: Page): Promise<StoredSettings | null> => kvJson<StoredSettings>(page, 'settings');

/** Opens a section from the rail (desktop) or the section picker (phones). */
async function openSection(page: Page, label: string, section: string): Promise<void> {
  const link = page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: label, exact: true });
  if (await link.isVisible()) await link.click();
  else {
    await page.getByRole('button', { name: /Section/ }).click();
    await page.getByRole('option', { name: label, exact: true }).click();
  }
  await expect(page.locator(`section[data-section="${section}"]`)).toBeVisible();
}

test.describe('settings', () => {
  test('prices: lists every destination, validates inline, saves a version, persists across reload', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await gotoApp(page, '/settings/prices');
    await waitForRows(page);

    // Every rig destination is listed (read straight from the Leader: nothing has swept yet), humanized,
    // with id · type · group (the id only when the name does not already say it, P1-G03) and an unpriced badge
    // (no prices document exists yet).
    for (const id of [SIEM, ANALYTICS, ARCHIVE, DEVNULL]) {
      const row = page.getByTestId(`price-row-${id}`);
      await expect(row).toBeVisible();
      await expect(row.locator('[data-status="unpriced"]')).toBeVisible();
      await expect(row.locator('.mr-pt-meta')).toHaveText(id === DEVNULL ? 'devnull · default' : `${id} · devnull · default`);
    }
    await expect(page.getByTestId(`price-row-${SIEM}`)).toContainText('SIEM (prod)');
    await expect(page.getByTestId('prices-counts')).toContainText('4 destinations');
    await expect(page.getByTestId('prices-counts')).toContainText('4 unpriced');

    // A suggestion is not a price: the field is empty with the suggestion as its placeholder.
    await expect(priceInput(page, SIEM)).toHaveValue('');

    // Unpriced workspace: the tab has not metered anything (no $0 seed hour), and says why.
    expect(await kvGet(page, 'snapshot')).toBeNull();
    expect(await kvGet(page, 'meta')).toBeNull();
    await expect(page.getByTestId('footer-runtime')).toHaveText('Set prices to start the meter');

    // Invalid input shows the SPEC 17 error inline and never writes.
    await priceInput(page, SIEM).fill('abc');
    await expect(page.getByText("Enter a number, 0 or more.")).toBeVisible();
    await expect(page.getByText('Fix 1 field to save.')).toBeVisible();
    await saveCard(page, 'prices');
    expect(await kvGet(page, 'prices')).toBeNull();

    await priceInput(page, SIEM).fill('0.0234');
    await expect(page.getByText("At most 3 decimals.")).toBeVisible();

    // Valid prices: $2.50 typed, analytics via "use suggested" (its Datadog preset), archive $0.03 with
    // counterfactual "Nowhere". The built-in devnull suggests nothing to fill: it is a free sink (P0-04).
    await priceInput(page, SIEM).fill('2.50');
    await priceInput(page, ARCHIVE).fill('0.03');
    await page.getByRole('button', { name: 'Use suggested prices (1)' }).click();
    await expect(priceInput(page, ANALYTICS)).toHaveValue('1.80');
    await expect(priceInput(page, DEVNULL)).toHaveValue('');

    const archiveRow = page.getByTestId(`price-row-${ARCHIVE}`);
    await archiveRow.getByRole('button', { name: /Without Cribl this data would go to/ }).click();
    await page.getByRole('option', { name: 'Nowhere (archive-only data)' }).click();
    await expect(page.getByText('3 unsaved changes')).toBeVisible();

    await saveCard(page, 'prices');
    await expectSavedToast(page);
    await expect.poll(() => kvGet(page, 'prices')).not.toBeNull();
    // The first sweep runs right after the save (no timer to wait for), and this tab is the one metering.
    await expect.poll(() => kvGet(page, 'snapshot'), { timeout: 20_000 }).not.toBeNull();
    await expect(page.getByTestId('footer-runtime')).toHaveText('Metered by this tab, every minute', { timeout: 20_000 });

    const prices = await kvJson<{ versions: { effectiveFrom: string; byOutputId: Record<string, { milliCentsPerGb: number; preset?: string; counterfactual?: { kind: string } }> }[] }>(page, 'prices');
    expect(prices?.versions).toHaveLength(1);
    const v = prices!.versions[0].byOutputId;
    expect(v[`default:${SIEM}`]).toMatchObject({ milliCentsPerGb: 250_000, counterfactual: { kind: 'same' } });
    expect(v[`default:${ARCHIVE}`]).toMatchObject({ milliCentsPerGb: 3_000, counterfactual: { kind: 'none' } });
    expect(v[`default:${ANALYTICS}`]).toMatchObject({ milliCentsPerGb: 180_000, preset: 'datadog' });
    // The built-in devnull is never written: with prices saved it reads as free, not unpriced.
    expect(v[`default:${DEVNULL}`]).toBeUndefined();
    expect(Math.abs(Date.parse(prices!.versions[0].effectiveFrom) - Date.now())).toBeLessThan(120_000);

    // Badges flip to priced.
    await expect(page.getByTestId(`price-row-${SIEM}`).locator('[data-status="priced"]')).toBeVisible();

    // Persistence: reload, the stored values come back.
    await page.reload();
    await waitForMock(page);
    await waitForHydration(page);
    await waitForRows(page);
    await expect(priceInput(page, SIEM)).toHaveValue('2.50');
    await expect(priceInput(page, ARCHIVE)).toHaveValue('0.03');
    await expect(page.getByTestId('prices-counts')).toContainText('All priced');

    // A change appends a second version (history is never rewritten).
    await priceInput(page, SIEM).fill('2.25');
    await saveCard(page, 'prices');
    await expect.poll(async () => (await kvJson<{ versions: unknown[] }>(page, 'prices'))?.versions.length).toBe(2);

    // A priced destination cannot be emptied.
    await priceInput(page, SIEM).fill('');
    await expect(page.getByText("Enter a number, 0 or more.")).toBeVisible();
    expect(errors()).toEqual([]);
  });

  test('prices: "Use suggested prices" on the DevNull rig fills sourced, non-zero presets; an unpriced one stays unpriced (P0-04)', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await gotoApp(page, '/settings/prices');
    await waitForRows(page);

    // Every rig destination suggests the preset it stands for (its description names it); the built-in devnull
    // suggests nothing, and its field offers a dash rather than a $0.00 that reads as a price.
    for (const [id, name] of [[SIEM, 'Splunk Cloud'], [ANALYTICS, 'Datadog Logs'], [ARCHIVE, 'Amazon S3'], [DEVNULL, 'Internal / free']] as const) {
      await expect(page.getByTestId(`price-row-${id}`).getByRole('button', { name: /Preset, / })).toContainText(name);
    }
    await expect(priceInput(page, DEVNULL)).toHaveAttribute('placeholder', '—');
    await expect(priceInput(page, SIEM)).toHaveAttribute('placeholder', '2.25');

    // The button counts only the fills worth money, and the toast never counts a $0 fill.
    await page.getByRole('button', { name: 'Use suggested prices (3)' }).click();
    await expect(page.getByText('Filled 3 suggested prices. Review them, then save.')).toBeVisible();
    await expect(priceInput(page, SIEM)).toHaveValue('2.25');
    await expect(priceInput(page, ANALYTICS)).toHaveValue('1.80');
    await expect(priceInput(page, ARCHIVE)).toHaveValue('0.023');
    await expect(priceInput(page, DEVNULL)).toHaveValue('');
    await expect(page.getByRole('button', { name: /Use suggested prices/ })).toHaveCount(0);
    await expect(page.getByText('3 unsaved changes')).toBeVisible();

    // Save only siem-prod (Discard, then one suggested price by hand).
    await page.locator('section[data-section="prices"]').getByRole('button', { name: 'Discard' }).click();
    await priceInput(page, SIEM).fill('2.25');
    await saveCard(page, 'prices');
    await expectSavedToast(page);

    // analytics and archive-s3 are DevNull outputs with no price: still unpriced, here and on the Receipt;
    // the built-in devnull is a free sink and is not counted.
    await expect(page.getByTestId('prices-counts')).toContainText('2 unpriced');
    await expect(page.getByTestId(`price-row-${ANALYTICS}`).locator('[data-status="unpriced"]')).toBeVisible();
    await expect(page.getByTestId(`price-row-${DEVNULL}`).locator('[data-status="priced"]')).toBeVisible();
    await expect.poll(() => kvGet(page, 'snapshot'), { timeout: 20_000 }).not.toBeNull();
    const snapshot = await kvJson<{ unpricedOutputIds: string[] }>(page, 'snapshot');
    expect(snapshot?.unpricedOutputIds.sort()).toEqual([ANALYTICS, ARCHIVE]);
    await page.getByRole('navigation').first().getByRole('link', { name: /receipt/i }).click();
    await expect(page.getByTestId('unpriced-notice')).toContainText('2 destinations are unpriced. Set prices to include them.', { timeout: 20_000 });
    expect(errors()).toEqual([]);
  });

  test('prices: no inert column; every visible field on an unpriced row is a change or an inline error (P0-19)', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await gotoApp(page, '/settings/prices');
    await waitForRows(page);

    // Four columns, no committed rate (nothing in core reads it in 1.0); the price says what it is.
    const table = page.getByRole('table', { name: 'Prices' });
    if (await table.getByRole('columnheader').first().isVisible()) {
      await expect(table.getByRole('columnheader')).toHaveText(['Destination', 'Preset', '$ / GB', 'Without Cribl this data would go to']);
    }
    await expect(page.locator('[data-testid^="committed-input-"]')).toHaveCount(0);
    await expect(page.getByText(/Committed/)).toHaveCount(0);
    await expect(page.getByTestId(`price-row-${ANALYTICS}`)).toContainText('Your contract rate');
    const save = page.locator('section[data-section="prices"]').getByRole('button', { name: 'Start the meter' });
    await expect(save).toBeDisabled();

    // Without Cribl this data would go to: a change the bar counts, and the price field says what it needs.
    const analytics = page.getByTestId(`price-row-${ANALYTICS}`);
    await analytics.getByRole('button', { name: /Without Cribl this data would go to/ }).click();
    await page.getByRole('option', { name: 'Nowhere (archive-only data)' }).click();
    await expect(analytics).toHaveAttribute('data-dirty', 'true');
    await expect(analytics.getByText("Couldn't save: enter a price.")).toBeVisible();
    await expect(page.getByText('Fix 1 field to save.')).toBeVisible();
    await saveCard(page, 'prices');
    expect(await kvGet(page, 'prices')).toBeNull();

    // $ / GB: typed junk is an inline error; a price clears it and the row saves with its counterfactual.
    await priceInput(page, ANALYTICS).fill('junk');
    await expect(analytics.getByText("Enter a number, 0 or more.")).toBeVisible();
    await priceInput(page, ANALYTICS).fill('1.80');
    await expect(analytics.getByText(/Couldn't save/)).toHaveCount(0);
    await expect(analytics).toContainText('Your contract rate');
    await expect(page.getByText('1 unsaved change', { exact: true })).toBeVisible();

    // Preset: picking one fills its typical price, a second change.
    await page.getByTestId(`price-row-${ARCHIVE}`).getByRole('button', { name: /Preset, / }).click();
    await page.getByRole('option', { name: /^Cribl Lake/ }).click();
    await expect(priceInput(page, ARCHIVE)).toHaveValue('0.05');
    await expect(page.getByText('2 unsaved changes')).toBeVisible();

    await saveCard(page, 'prices');
    await expectSavedToast(page);
    const prices = await kvJson<{ versions: { byOutputId: Record<string, unknown> }[] }>(page, 'prices');
    expect(prices!.versions[0].byOutputId[`default:${ANALYTICS}`]).toMatchObject({ milliCentsPerGb: 180_000, counterfactual: { kind: 'none' } });
    expect(prices!.versions[0].byOutputId[`default:${ARCHIVE}`]).toMatchObject({ milliCentsPerGb: 5_000, preset: 'cribl_lake' });
    expect(errors()).toEqual([]);
  });

  test('prices on the tour at 320 × 740: the "At these prices" lines wrap inside their card, nothing overflows (r1 ui-9, m22, WCAG 1.4.10)', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await gotoApp(page, '/first-run');
    await resetMock(page);
    await gotoApp(page, '/settings/prices?tour=1');
    await expect(page.locator('[data-callout="sample-band"]')).toBeVisible({ timeout: 20_000 });
    const lines = page.locator('.mr-pt-totals-line');
    await expect(lines.first()).toBeVisible({ timeout: 30_000 });
    // Every line (and its amount, the "~ $84,435 / day" that ran 5 px out of its box) stays inside its own box.
    const overflowing = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.mr-pt-totals-line, .mr-pt-totals-line .mr-pt-totals-amount')]
        .filter((el) => {
          const box = el.getBoundingClientRect();
          const parent = (el.closest('.mr-pt-totals') ?? el.parentElement)!.getBoundingClientRect();
          return el.scrollWidth > el.clientWidth + 1 || box.right > parent.right + 0.5 || box.right > window.innerWidth;
        })
        .map((el) => el.textContent),
    );
    expect(overflowing).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });

  test('prices: the preset picker is a grid of vendor tiles, at least 320 px wide, on screen, over no card copy (P0-20, P2-W24)', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await gotoApp(page, '/settings/prices');
    await waitForRows(page);
    const width = page.viewportSize()!.width;
    const description = page.locator('section[data-section="prices"]').getByText('Enter what each destination charges per GB');

    // The first row and the last: the last sits lowest, where a tall list would flip up over the card.
    for (const id of [DEVNULL, SIEM]) {
      await page.getByTestId(`price-row-${id}`).getByRole('button', { name: /Preset, / }).click();
      const picker = page.getByTestId('preset-picker');
      await expect(picker).toBeVisible();
      await page.waitForTimeout(150); // the popover's entry transition
      const list = picker.getByRole('listbox');

      const box = (await picker.boundingBox())!;
      expect(box.width, `picker width (${id})`).toBeGreaterThanOrEqual(320);
      expect(box.x, 'on screen').toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, 'on screen').toBeLessThanOrEqual(width);
      const desc = (await description.boundingBox())!;
      expect(box.y >= desc.y + desc.height || box.y + box.height <= desc.y, `the picker (${Math.round(box.y)}–${Math.round(box.y + box.height)}) covers the card description (${Math.round(desc.y)}–${Math.round(desc.y + desc.height)})`).toBe(true);

      // Every tile is a monogram beside its name over its typical price: one line each, never a wrapped sentence.
      const lines = await list.getByRole('option').evaluateAll((els) =>
        els.map((el) => {
          const count = (sel: string) => {
            const part = el.querySelector<HTMLElement>(sel);
            return part ? Math.round(part.getBoundingClientRect().height / parseFloat(getComputedStyle(part).lineHeight)) : 99;
          };
          return count('.mr-pp-name') + count('.mr-pp-caption');
        }),
      );
      expect(lines).toHaveLength(16);
      expect(Math.max(...lines), 'lines per tile').toBeLessThanOrEqual(2);
      await expect(list.getByRole('option', { name: 'Splunk Cloud · typical $2.25 / GB · range $1.47–$4.85' })).toHaveCount(1);
      await expect(list.getByText('Typical list prices', { exact: true })).toHaveCount(1);
      await expect(list.getByText('Other', { exact: true })).toHaveCount(1);
      const names = await list.locator('.mr-pp-name').allTextContents();
      expect(names.slice(-2)).toEqual(['Custom price', 'Internal / free']);
      await page.keyboard.press('Escape');
      await expect(picker).toHaveCount(0);
    }
    expect(errors()).toEqual([]);
  });

  test('prices: a typed contract rate reads Custom, and Show the math sets it beside the list price (P1-G01, P1-F10)', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await gotoApp(page, '/settings/prices');
    await waitForRows(page);
    const picker = (id: string) => page.getByTestId(`price-row-${id}`).getByRole('button', { name: /Preset, / });
    const note = (id: string) => page.getByTestId(`preset-note-${id}`);

    // A contract rate on a preset row: the vendor stays, the note says the rate is the member's own.
    await expect(note(SIEM)).toHaveText('$2.25 typical · $1.47–$4.85');
    await priceInput(page, SIEM).fill('1.80');
    await expect(note(SIEM)).toHaveText('Custom price · typical $2.25');
    await expect(picker(SIEM)).toContainText('Splunk Cloud');
    // The preset's own value is not custom.
    await priceInput(page, ANALYTICS).fill('1.80');
    await expect(note(ANALYTICS)).toHaveText('$1.80 typical · $0.95–$3.85');
    // A rate above $0 on Internal / free: the picker moves to Custom price (never "No destination charge" over $0.40).
    await expect(picker(DEVNULL)).toContainText('Internal / free');
    await priceInput(page, DEVNULL).fill('0.40');
    await expect(picker(DEVNULL)).toContainText('Custom price');
    await expect(note(DEVNULL)).toHaveText('Not a list price');
    await expect(page.getByTestId(`price-row-${DEVNULL}`).getByTestId('preset-info-button')).toHaveCount(0);
    await priceInput(page, ARCHIVE).fill('0.023');

    await saveCard(page, 'prices');
    await expectSavedToast(page);
    const prices = await kvJson<{ versions: { byOutputId: Record<string, { milliCentsPerGb: number; preset?: string }> }[] }>(page, 'prices');
    const v = prices!.versions[0].byOutputId;
    expect(v[`default:${SIEM}`]).toMatchObject({ milliCentsPerGb: 180_000, preset: 'splunk_cloud' });
    expect(v[`default:${DEVNULL}`].milliCentsPerGb).toBe(40_000);
    expect(v[`default:${DEVNULL}`].preset).toBeUndefined();

    // Show the math: a typed rate over a preset sets it beside the list price it replaced (P1-F10: "Your rate ·
    // Splunk Cloud list $2.25"), the preset's own value names the preset.
    await expect.poll(() => kvGet(page, 'snapshot'), { timeout: 20_000 }).not.toBeNull();
    await page.getByRole('navigation').first().getByRole('link', { name: /receipt/i }).click();
    await page.locator('.mr-hero-actions').getByRole('button', { name: 'Show the math' }).click();
    const drawer = page.getByTestId('math-drawer');
    await expect(drawer.locator('.mr-math-dest', { hasText: 'SIEM (prod)' })).toContainText('$1.80 / GB · Your rate · Splunk Cloud list $2.25', { timeout: 20_000 });
    await expect(drawer.locator('.mr-math-dest', { hasText: 'analytics' })).toContainText('$1.80 / GB · Preset: Datadog Logs');
    await expect(drawer.locator('.mr-math-dest', { hasText: 'SIEM (prod)' })).not.toContainText('Preset:');
    expect(errors()).toEqual([]);
  });

  test('budgets, Cribl cost and alerts validate, preview and save', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await gotoApp(page, '/settings?section=budgets');
    await expect(page.getByTestId(`budget-row-${SIEM}`)).toBeVisible({ timeout: 40_000 });

    await page.getByTestId(`budget-input-${SIEM}`).fill('-5');
    await expect(page.getByText("Couldn't save: budget must be 0 or more.")).toBeVisible();
    await page.getByTestId(`budget-input-${SIEM}`).fill('12,000');
    await saveCard(page, 'budgets');
    await expectSavedToast(page);
    await expect.poll(async () => (await settingsDoc(page))?.budgets?.[SIEM]).toEqual({ centsPerMonth: 1_200_000 });

    // Cribl cost with the net / payback preview.
    await openSection(page, 'Cribl cost', 'cost');
    await page.getByTestId('cost-input').fill('4000');
    await saveCard(page, 'cost');
    await expect.poll(async () => (await settingsDoc(page))?.criblCostCentsPerMonth).toBe(400_000);
    expect((await settingsDoc(page))?.budgets?.[SIEM]).toBeDefined(); // a section save never clobbers another section

    // Alerts: out-of-range regression points is refused inline; memory 6 h maps to α = 2/(360+1).
    await openSection(page, 'Alerts', 'alerts');
    await page.getByTestId('alerts-regressionPoints').fill('60');
    await expect(page.getByText("Couldn't save: regression points must be between 5 and 50.")).toBeVisible();
    await saveCard(page, 'alerts');
    expect((await settingsDoc(page))?.thresholds?.regressionPoints).toBe(15);

    await page.getByTestId('alerts-regressionPoints').fill('20');
    await page.getByRole('button', { name: /Baseline memory/ }).click();
    await page.getByRole('option', { name: '6 hours' }).click();
    await saveCard(page, 'alerts');
    await expect.poll(async () => (await settingsDoc(page))?.thresholds?.regressionPoints).toBe(20);
    const s4 = await settingsDoc(page);
    expect(s4?.thresholds?.ewmaAlpha).toBeCloseTo(2 / 361, 10);
    expect(s4?.criblCostCentsPerMonth).toBe(400_000);
    expect(errors()).toEqual([]);
  });

  test('Cribl cost offers the list-price figure for this workspace; nothing is stored until Save (usefulness review, round 1)', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    // A priced workspace with a first sweep (the suggestion reads the bytes it receives per day).
    await gotoApp(page, '/settings?section=cost');
    await seedPrices(page);
    await page.reload();
    await waitForMock(page);
    await waitForHydration(page);
    await expect(page.getByTestId('cost-preview').or(page.getByText('Enter a monthly cost to preview net savings.'))).toBeVisible({ timeout: 40_000 });
    const suggestion = page.getByTestId('cost-suggestion');
    await expect(suggestion).toContainText(/^At Cribl's list price: [\d.,]+ [KMGT]?B a day received × \$0\.32 per GB × 365 ÷ 12 ≈ \$[\d,]+ a month\. Enter your contract rate if it differs\./);
    await expect(suggestion).toContainText('0.32 credits per GB received, at $1 a credit');
    // At a phone's width the arithmetic wraps inside the card: nothing scrolls sideways.
    const width = page.viewportSize()!.width;
    const box = (await suggestion.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const use = suggestion.getByRole('button', { name: /^Use \$[\d,]+$/ });
    const amount = ((await use.textContent()) ?? '').replace(/^Use \$/, '').replace(/,/g, '');
    await use.click();
    await expect(page.getByTestId('cost-input')).toHaveValue(amount);
    await expect(use).toHaveCount(0);
    // Offered, not stored: KV holds no Cribl cost until the admin saves.
    expect((await settingsDoc(page))?.criblCostCentsPerMonth).toBeUndefined();
    await saveCard(page, 'cost');
    await expect.poll(async () => (await settingsDoc(page))?.criblCostCentsPerMonth).toBe(Number(amount) * 100);
    expect(errors()).toEqual([]);
  });

  test('where to send alerts (D57): no direct webhook in the App; a Cribl target stored by id, tested, sent the weekly receipt, removed', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await gotoApp(page, '/settings/notifications');
    // Hackathon rule 4.5: no build stores a webhook URL. Nothing offers one; the section says where they live.
    await expect(page.getByTestId('runner-webhooks')).toContainText('Meter Reader stores no webhook URL');
    await page.getByRole('button', { name: 'Add endpoint' }).first().click();
    const ep = page.getByTestId('endpoint-0');
    await expect(ep).toHaveAttribute('data-channel', 'cribl-target');
    await expect(page.locator('main')).not.toContainText('Direct webhook ·');
    await expect(page.getByTestId('endpoint-0-url')).toHaveCount(0);
    await expect(page.getByTestId('endpoint-0-channel')).toHaveCount(0);
    await ep.getByLabel('Name').fill('Ops Slack');
    // Errors show once Save is pressed (or the field is left, P1-G05); invalid input never writes.
    await saveCard(page, 'notifications');
    await expect(page.getByText("Couldn't save: choose a Cribl notification target.")).toBeVisible();
    expect(await kvGet(page, 'settings')).toBeNull();

    // Pick the Slack target from the list, connect its relay (confirmed first), save: only the id is stored.
    await ep.getByRole('button', { name: 'Load targets' }).click();
    await page.getByTestId('endpoint-0-target').getByRole('button').click();
    await page.getByRole('option', { name: /mrd_slack_finops/ }).click();
    await page.getByTestId('endpoint-0-relay').getByRole('button', { name: 'Connect' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByTestId('endpoint-0-relay')).toHaveAttribute('data-relay', 'ready');
    // M1 (founder-build r1 ui-5): a Connect that succeeded stores the endpoint at once; nothing is left to save.
    await expect(page.locator('section[data-section="notifications"] .mr-set-savebar')).toContainText('No unsaved changes');
    await expect.poll(async () => (await settingsDoc(page))?.notifications?.[0]?.criblTargetId).toBe('mrd_slack_finops');
    const stored = (await kvGet(page, 'settings')) ?? '';
    expect(stored).not.toContain('hooks.slack.com');
    expect(stored).not.toContain('not-a-real-secret');
    expect((await settingsDoc(page))?.notifications?.[0]).toMatchObject({ channel: 'cribl-target', url: '', host: '', weeklyReceipt: true });

    // Test alert → handed to Cribl, which delivers it to the target; lastTest recorded on the saved endpoint.
    await clearSink(page);
    await page.getByTestId('endpoint-0-test').getByRole('button').click();
    await expect(page.getByTestId('endpoint-0-result')).toContainText('Handed to Cribl for mrd_slack_finops (200)');
    await expect.poll(async () => (await settingsDoc(page))?.notifications?.[0]?.lastTest?.status).toBe(200);

    // Send the last 7 days now: the target (Weekly receipt on, the default) and the Cribl bell both take it.
    await clearSink(page);
    const weekly = page.getByTestId('weekly-receipt');
    await weekly.getByRole('button', { name: 'Send the last 7 days now' }).click();
    await expect(page.getByTestId('weekly-result')).toContainText('Sent to all 2 endpoints.');
    await expect(page.getByTestId('weekly-result')).toContainText('Ops Slack: sent (200)');
    await expect(page.getByTestId('weekly-result')).toContainText('Cribl notifications: sent (200)');

    // Remove: confirmed first (AGENTS.md), naming the target id, saved at once.
    await page.getByTestId('endpoint-0').getByRole('button', { name: 'Remove' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Remove Ops Slack?');
    await expect(dialog).toContainText('mrd_slack_finops');
    await dialog.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText('Endpoint removed')).toBeVisible();
    await expect.poll(async () => (await settingsDoc(page))?.notifications?.length ?? 0).toBe(0);
    expect(errors().filter((e) => !/Failed to load resource: the server responded with a status of 40[34]/.test(e))).toEqual([]);
  });

  test('where to send alerts (D57): a direct webhook an older build stored is never shown and never written back', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await gotoApp(page, '/settings/notifications');
    // A valid settings document first (switch the bell off and save), then a legacy direct webhook written into it, as
    // a build before 1.0.14 / 1.1.0 could store it.
    await page.getByTestId('endpoint-bell').getByRole('switch').click();
    await saveCard(page, 'notifications');
    await expect.poll(async () => (await kvGet(page, 'settings')) !== null).toBe(true);
    await page.evaluate(async (url) => {
      const base = (await (await fetch('/mock-api/v1/kvstore/settings')).json()) as Record<string, unknown> & { notifications: unknown[] };
      const legacy = { id: 'legacy', name: 'Legacy hook', url, host: 'hooks.slack.com', format: 'slack', minSeverity: 'medium', weeklyReceipt: true, enabled: true };
      await fetch('/mock-api/v1/kvstore/settings', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ ...base, notifications: [...base.notifications, legacy] }) });
    }, SLACK_URL);
    // Not vacuous: the stored document holds the URL now.
    expect((await kvGet(page, 'settings')) ?? '').toContain(SLACK_URL);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForMock(page);
    await waitForHydration(page);
    // The stored bell (switched off) came back, so the document was read; the legacy hook did not.
    await expect(page.getByTestId('endpoint-bell')).toHaveAttribute('data-enabled', 'false');
    await expect(page.getByTestId('endpoints-empty')).toBeVisible();
    await expect(page.locator('main')).not.toContainText('Legacy hook');
    await expect(page.locator('main')).not.toContainText('hooks.slack.com');
    // Any save rewrites the document without it (every KV write goes through core storableSettings).
    await page.getByTestId('endpoint-bell').getByRole('switch').click();
    await saveCard(page, 'notifications');
    await expect.poll(async () => ((await kvGet(page, 'settings')) ?? '').includes('Legacy hook')).toBe(false);
    expect((await kvGet(page, 'settings')) ?? '').not.toContain(SLACK_URL);
    expect(errors()).toEqual([]);
  });

  test('runtime: sweep now waits for prices, then shows the result and throttles', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await gotoApp(page, '/settings?section=runtime');
    await expect(page.getByTestId('runtime-value')).toContainText('This browser tab');
    await expect(page.locator('section[data-section="runtime"]')).toContainText(
      "Meters every completed minute while this app is open (it checks twice a minute); when you reopen it, it catches up from Cribl's metrics history.",
    );
    // No prices: nothing meters, and Sweep now says why instead of metering at $0 (REVIEW-3a #3).
    const button = page.locator('section[data-section="runtime"]').getByRole('button', { name: 'Sweep now' });
    await expect(page.getByTestId('runtime-metering')).toContainText('Starts as soon as prices are saved');
    await expect(button).toBeDisabled();
    await expect(page.getByTestId('sweep-now-status')).toHaveText('Set prices to start the meter.');
    expect(await kvGet(page, 'meta')).toBeNull();

    await page.evaluate(async (body) => {
      await fetch('/mock-api/v1/kvstore/prices', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body });
    }, JSON.stringify(STAGED_PRICES()));
    await page.reload();
    await waitForMock(page);
    await waitForHydration(page);
    // The first timed sweep lands (≈ 3 s), then Sweep now.
    await expect(page.getByTestId('runtime-metering')).toHaveText('Metered by this tab, every minute', { timeout: 40_000 });
    await expect(button).toBeEnabled({ timeout: 20_000 });
    await button.click();
    await expect(page.getByTestId('sweep-now-status')).toContainText(/Sweep finished · \d+ calls · |Another tab is sweeping|Sweeping/, { timeout: 40_000 });
    await expect(button).toBeDisabled();
    await expect(page.getByTestId('sweep-now-status')).toContainText(/available again in \d+\u00a0s/);
    expect(errors()).toEqual([]);
  });
});

// ─── Beauty grid (PRD 8.8 item 12) ──────────────────────────────────────────

/** Rig prices as a stored document (SPEC 4 `prices`): Splunk Cloud $2.50, Datadog $1.50, S3 $0.03. */
function STAGED_PRICES() {
  const at = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
  return {
    schemaVersion: 1,
    updatedAt: at,
    versions: [
      {
        effectiveFrom: at,
        byOutputId: {
          [`default:${SIEM}`]: { milliCentsPerGb: 250_000, preset: 'splunk_cloud', counterfactual: { kind: 'same' } },
          [`default:${ANALYTICS}`]: { milliCentsPerGb: 150_000, preset: 'datadog', counterfactual: { kind: 'same' } },
          [`default:${ARCHIVE}`]: { milliCentsPerGb: 3_000, preset: 's3', counterfactual: { kind: 'none' } },
        },
      },
    ],
  };
}

/**
 * WCAG contrast of every visible text node in the Settings view against its effective background
 * (PRD 8.8 line 3: ≥ 4.5:1, checked by the test). Disabled controls are exempt (WCAG 1.4.3), and so is
 * Capra's primary button fill (see below).
 */
async function contrastFailures(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const parse = (c: string): [number, number, number, number] | null => {
      // color-mix() computes to color(srgb r g b / a) with 0–1 channels (the hovered Prices row, P1-G03).
      const srgb = /color\(srgb ([^)]+)\)/.exec(c);
      if (srgb) {
        const p = srgb[1].split(/[ ,/]+/).filter(Boolean).map(Number);
        return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1];
      }
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return null;
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bgOf = (el: Element | null): [number, number, number] => {
      const layers: [number, number, number, number][] = [];
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c && c[3] > 0) {
          layers.push(c);
          if (c[3] >= 1) break;
        }
      }
      let base: [number, number, number] = [255, 255, 255];
      for (const [r, g, b, a] of layers.reverse()) base = [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)];
      return base;
    };
    const out: string[] = [];
    const root = document.querySelector('.mr-settings');
    if (!root) return ['no .mr-settings'];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.textContent ?? '').trim();
      const el = n.parentElement;
      if (!text || !el) continue;
      if (el.closest('[disabled],[aria-disabled="true"],[data-disabled="true"],[aria-hidden="true"]')) continue;
      // Capra's own primary button (white on accent.solid, 3.3:1) is the design system's choice, shared by every
      // Cribl screen; it is reported in the builder's notes rather than restyled here.
      if (el.closest('button[data-variant="primary"]')) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || getComputedStyle(el).visibility === 'hidden') continue;
      const fg = parse(getComputedStyle(el).color);
      if (!fg) continue;
      const bg = bgOf(el);
      const fgRgb: [number, number, number] = [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3])];
      const [l1, l2] = [lum(fgRgb), lum(bg)].sort((a, b) => b - a);
      const ratio = (l1 + 0.05) / (l2 + 0.05);
      if (ratio < 4.5) out.push(`${ratio.toFixed(2)} "${text.slice(0, 40)}"`);
    }
    return [...new Set(out)];
  });
}

/** Closes open toasts so they never sit in a screenshot. */
async function dismissToasts(page: Page): Promise<void> {
  await page.getByText(/^(Changes saved|The meter is running\.)/).first().waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => undefined);
}

const WIDTHS = [390, 1440, 1920] as const;
const THEMES: Theme[] = ['light', 'dark'];

test.describe('settings beauty', () => {
  test.skip(({ browserName }) => browserName !== 'chromium');

  test('screenshot grid', async ({ page }, info) => {
    test.skip(info.project.name !== 'chromium', 'one project owns the grid');
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoApp(page, '/settings/prices');
    await waitForRows(page);
    // One destination priced (its suggested Splunk Cloud preset at the typical $2.25), the rest waiting: both
    // badge states show.
    await expect(page.getByTestId(`price-row-${SIEM}`).getByRole('button', { name: /Preset, SIEM \(prod\)/ })).toContainText('Splunk Cloud');
    await priceInput(page, SIEM).fill('2.25');
    await saveCard(page, 'prices');
    await expectSavedToast(page);
    await page.getByText('Changes saved').first().waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => undefined);

    // The row's ⓘ: what the typical price rests on, its sources, and that it is not a quote (SPEC 6).
    for (const theme of THEMES) {
      await setTheme(page, theme);
      for (const width of [1440, 390] as const) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.getByTestId(`price-row-${SIEM}`).getByTestId('preset-info-button').click();
        const panel = page.getByTestId('preset-info-splunk_cloud');
        await expect(panel).toBeVisible();
        await expect(panel).toContainText('Splunk Cloud · typical $2.25 / GB');
        await expect(panel).toContainText('Typical range $1.47–$4.85 per GB');
        await expect(panel.getByTestId('preset-disclaimer')).toHaveText('Typical list pricing, not a quote. Enter your contract rate.');
        await expect(panel.getByRole('link')).toHaveCount(3);
        const box = (await panel.boundingBox())!;
        expect(box.x, 'the popover stays on screen').toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, 'the popover stays on screen').toBeLessThanOrEqual(width);
        await page.waitForTimeout(250);
        await page.screenshot({ path: `tests/report/beauty/settings-preset-info-${theme}-${width}.png` });
        expect(await contrastFailures(page), `contrast < 4.5:1 (preset info, ${theme}, ${width})`).toEqual([]);
        await page.keyboard.press('Escape');
        await expect(panel).toHaveCount(0);
      }
    }
    // Resting state for the grid below: focus went back to the ⓘ when the popover closed.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    for (const theme of THEMES) {
      await setTheme(page, theme);
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : width === 1920 ? 1080 : 900 });
        await page.waitForTimeout(250);
        await page.screenshot({ path: `tests/report/beauty/settings-${theme}-${width}.png`, fullPage: true });
        // No horizontal page scroll at any width.
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `horizontal overflow at ${width}`).toBeLessThanOrEqual(0);
        expect(await contrastFailures(page), `contrast < 4.5:1 (${theme}, ${width})`).toEqual([]);
      }
    }
  });

  test('section screenshots', async ({ page }, info) => {
    test.skip(info.project.name !== 'chromium', 'one project owns the grid');
    test.setTimeout(240_000);
    const shot = async (name: string, widths: readonly number[] = [1440]) => {
      await dismissToasts(page);
      // Resting state: no hover or focus styling in the evidence.
      await page.mouse.move(0, 0);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      for (const theme of THEMES) {
        await setTheme(page, theme);
        for (const width of widths) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
          await page.waitForTimeout(300);
          await page.screenshot({ path: `tests/report/beauty/settings-${name}-${theme}-${width}.png`, fullPage: true });
          expect(await contrastFailures(page), `contrast < 4.5:1 (${name}, ${theme}, ${width})`).toEqual([]);
        }
      }
      await setTheme(page, 'light');
      await page.setViewportSize({ width: 1440, height: 900 });
    };
    const nav = (name: string) => page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name, exact: true }).click();

    // Staging for the previews: prices exist BEFORE the first sweep, so its 60-minute seed is priced.
    // (The UI path for pricing is covered by the behaviour tests above.)
    await gotoApp(page, '/settings?section=runtime');
    await page.evaluate(async (body) => {
      await fetch('/mock-api/v1/kvstore/prices', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body });
    }, JSON.stringify(STAGED_PRICES()));
    await expect(page.getByTestId('runtime-calls')).not.toContainText('—', { timeout: 40_000 });
    await page.reload();
    await waitForMock(page);
    await waitForHydration(page);
    await expect(page.getByTestId('runtime-calls')).not.toContainText('—', { timeout: 40_000 });
    await dismissToasts(page);
    await shot('runtime', [1440, 390]);

    await nav('Budgets');
    await expect(page.getByTestId(`budget-row-${SIEM}`)).toBeVisible();
    await page.getByTestId(`budget-input-${SIEM}`).fill('25');
    await page.getByTestId(`budget-input-${ANALYTICS}`).fill('2,500');
    await page.getByTestId(`budget-input-${ARCHIVE}`).fill('0.10');
    await shot('budgets', [1440, 390]);

    await nav('Cribl cost');
    await page.getByTestId('cost-input').fill('40');
    await shot('cost', [1440, 390]);

    await nav('Alerts');
    await shot('alerts', [1440, 390]);

    await nav('Where to send alerts');
    await page.getByRole('button', { name: 'Add endpoint' }).first().click();
    await page.getByTestId('endpoint-0').getByLabel('Name').fill('Ops Slack');
    await page.getByTestId('endpoint-0-target').getByRole('textbox').fill('mrd_slack_finops');
    await page.getByTestId('endpoint-0-relay').getByRole('button', { name: 'Connect' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByTestId('endpoint-0-relay')).toHaveAttribute('data-relay', 'ready');
    // M1 (founder-build r1 ui-5): Connect stored the endpoint; nothing is left to save.
    await expect(page.locator('section[data-section="notifications"] .mr-set-savebar')).toContainText('No unsaved changes');
    await page.getByTestId('endpoint-0-test').getByRole('button').click();
    await expect(page.getByTestId('endpoint-0-result')).toContainText('Handed to Cribl for mrd_slack_finops (200)');
    await page.getByText('Target connected').first().waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => undefined);
    await page.getByText('Changes saved').first().waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => undefined);
    await shot('notifications', [1440, 390]);
  });
});

// ─── Prices, wave 2 (EPIC_AUDIT P1-F11, P1-G02, P1-G03, P2-W09, P2-W24) ─────────────────────────────────────

/** A prices document effective three hours ago holding only the given rig rows. */
function pricesOnly(byOutputId: Record<string, { milliCentsPerGb: number; preset?: string }>) {
  const at = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
  const entries = Object.fromEntries(Object.entries(byOutputId).map(([id, e]) => [`default:${id}`, { ...e, counterfactual: { kind: 'same' } }]));
  return { schemaVersion: 1, updatedAt: at, versions: [{ effectiveFrom: at, byOutputId: entries }] };
}

test.describe('prices, wave 2', () => {
  test('receipt: storage and metered prices only: the bar shows, the renewal line does not (P1-F11)', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await gotoApp(page, '/first-run');
    await seedPrices(page, pricesOnly({ [ANALYTICS]: { milliCentsPerGb: 180_000, preset: 'datadog' }, [ARCHIVE]: { milliCentsPerGb: 2_300, preset: 's3' } }));
    await gotoApp(page, '/');
    await expect(page.getByTestId('receipt-saved-pct')).toBeVisible({ timeout: 40_000 });
    await expect(page.getByTestId('entitlement-note')).toHaveCount(0);
    expect(errors()).toEqual([]);
  });

  test('receipt: an entitlement-billed destination carrying money adds the renewal line under the bar (P1-F11)', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await gotoApp(page, '/first-run');
    await seedPrices(page, pricesOnly({ [SIEM]: { milliCentsPerGb: 225_000, preset: 'splunk_cloud' }, [ARCHIVE]: { milliCentsPerGb: 2_300, preset: 's3' } }));
    await gotoApp(page, '/');
    await expect(page.getByTestId('entitlement-note')).toHaveText(
      'Splunk Cloud is billed as a prepaid entitlement: its share of these dollars is realized at renewal, not on the next bill.',
      { timeout: 40_000 },
    );
    const bar = await page.locator('.mr-rbar-track').boundingBox();
    const note = await page.getByTestId('entitlement-note').boundingBox();
    expect(bar && note && note.y > bar.y).toBe(true);
    expect(errors()).toEqual([]);
  });

  test('inventory: one Leader walk serves every section and every hop on an unpriced install; no re-read between sweeps (P1-G02)', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    const groupWalks = async (): Promise<number> =>
      Object.entries((await mockCalls(page)).byRoute)
        .filter(([route]) => /^GET \/(master|products\/stream)\/groups$/.test(route))
        .reduce((n, [, count]) => n + count, 0);
    await gotoApp(page, '/settings/prices');
    await waitForRows(page);
    expect(await groupWalks()).toBe(1);
    // Prices → Alerts → Budgets → Prices: the destinations come back from the one walk, instantly.
    await openSection(page, 'Alerts', 'alerts');
    await openSection(page, 'Budgets', 'budgets');
    await expect(page.getByTestId(`budget-row-${SIEM}`)).toBeVisible();
    await openSection(page, 'Prices', 'prices');
    await expect(page.getByTestId(`price-row-${SIEM}`)).toBeVisible();
    expect(await groupWalks()).toBe(1);

    // Priced: the sweep's KV document takes over; hopping between sections reads it no more than once per sweep.
    await seedPrices(page, STAGED_PRICES());
    await gotoApp(page, '/settings/prices');
    await expect.poll(() => kvGet(page, 'inventory'), { timeout: 40_000 }).not.toBeNull();
    await expect(page.getByTestId(`price-row-${SIEM}`)).toBeVisible();
    const sweeps = async (): Promise<number> => ((await kvJson<{ sweepCount?: number }>(page, 'meta'))?.sweepCount ?? 0);
    const before = await sweeps();
    await resetCalls(page);
    for (let i = 0; i < 3; i++) {
      await openSection(page, 'Budgets', 'budgets');
      await expect(page.getByTestId(`budget-row-${SIEM}`)).toBeVisible();
      await openSection(page, 'Prices', 'prices');
      await expect(page.getByTestId(`price-row-${SIEM}`)).toBeVisible();
    }
    const inventoryReads = (await mockCalls(page)).recent.filter((c) => c.method === 'GET' && /\/kvstore\/inventory(\/|$|\?)/.test(c.path)).length;
    const swept = (await sweeps()) - before;
    // Six mounts; before P1-G02 each read the document. Now: the tab's reads plus each sweep's own, at most one each per sweep.
    expect(inventoryReads).toBeLessThanOrEqual(2 * swept);
    expect(await groupWalks()).toBe(0);
    expect(errors()).toEqual([]);
  });

  test('polish: short numeric errors, publishers not hosts, a 44 px info target, hovered rows pass contrast (P1-G03)', async ({ page }, info) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await gotoApp(page, '/settings/prices');
    await waitForRows(page);
    const phone = (page.viewportSize()?.width ?? 1440) < 760;

    // A numeric error under the price field takes at most two lines at 1440 (it wrapped four).
    await priceInput(page, SIEM).fill('abc');
    const error = page.getByTestId(`price-row-${SIEM}`).getByText('Enter a number, 0 or more.');
    await expect(error).toBeVisible();
    await expect(page.getByText('Fix 1 field to save.')).toBeVisible();
    const lines = await error.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
    expect(lines).toBeLessThanOrEqual(2);
    await priceInput(page, SIEM).fill('0.0234');
    await expect(page.getByTestId(`price-row-${SIEM}`).getByText('At most 3 decimals.')).toBeVisible();
    await priceInput(page, SIEM).fill('');

    // The ⓘ: a 32 px button whose hit area is 44 px; its sources read as publishers, never raw hosts.
    const infoButton = page.getByTestId(`price-row-${SIEM}`).getByTestId('preset-info-button');
    const box = await infoButton.boundingBox();
    expect(box && Math.round(box.width)).toBe(32);
    const hit = await infoButton.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const after = getComputedStyle(el, '::after');
      return { w: r.width - 2 * parseFloat(after.left), h: r.height - 2 * parseFloat(after.top) };
    });
    expect(Math.round(hit.w)).toBeGreaterThanOrEqual(44);
    expect(Math.round(hit.h)).toBeGreaterThanOrEqual(44);
    await infoButton.click();
    const popover = page.getByTestId('preset-info-splunk_cloud');
    await expect(popover).toBeVisible();
    const links = await popover.locator('ol a').allTextContents();
    expect(links).toEqual(['UK G-Cloud 14 price list (Somerford, Jan 2025)', 'UK G-Cloud 14 price list (Networkology, Apr 2024)', 'SIEM Cost Calculator: Splunk pricing']);
    for (const text of links) expect(text).not.toMatch(/\.(com|net|uk|io)\b/);
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();

    // Every row, hovered, in both themes: no text under 4.5:1 (the outlined 'unpriced' pill measured 4.41:1).
    if (!phone) {
      for (const theme of THEMES) {
        await setTheme(page, theme);
        for (const id of [SIEM, ANALYTICS, ARCHIVE, DEVNULL]) {
          await page.getByTestId(`price-row-${id}`).locator('.mr-pt-meta').hover();
          await page.waitForTimeout(200);
          expect(await contrastFailures(page), `${theme} ${id} hovered`).toEqual([]);
        }
      }
    }
    void info;
    expect(errors()).toEqual([]);
  });

  test('first save: "Start the meter", the save bar says what starts, Cmd/Ctrl+S saves, the toast links to the Receipt (P2-W09)', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    // ?section= opens Prices inside the one Settings route; since W3-LS-1 every section (and /settings/prices) shares
    // that frame and the view's error boundary is keyed by view, so the hop below keeps the unsaved drafts.
    await gotoApp(page, '/settings?section=prices');
    await waitForRows(page);
    const section = page.locator('section[data-section="prices"]');
    const primary = section.getByRole('button', { name: 'Start the meter' });
    await expect(primary).toBeVisible();
    await expect(primary).toBeDisabled();
    // Never swept: no traffic to price yet, so no row line and no card receipt (never a guess).
    await expect(page.locator('[data-testid^="price-receipt-"]')).toHaveCount(0);
    await expect(page.getByTestId('prices-receipt')).toHaveCount(0);

    await priceInput(page, SIEM).fill('2.50');
    await priceInput(page, ARCHIVE).fill('0.023');
    await expect(section.getByText('Meters every minute from the moment you save', { exact: true })).toBeVisible();
    await expect(section.getByText('2 unsaved changes', { exact: true })).toBeVisible();
    const pending = page.getByTestId('prices-pending');
    await expect(pending).toBeVisible();
    await expect(page.getByTestId(`prices-pending-default:${SIEM}`)).toContainText('unpriced → $2.50');
    await expect(page.getByTestId(`prices-pending-default:${ARCHIVE}`)).toContainText('unpriced → $0.023');
    await expect(pending).toContainText(/(⌘S|Ctrl\+S) saves/);

    // On another section, ⌘S is not Prices' to take (the frame keeps dirty Prices mounted, hidden).
    await openSection(page, 'Alerts', 'alerts');
    await page.keyboard.press('ControlOrMeta+s');
    await page.waitForTimeout(500);
    expect(await kvGet(page, 'prices')).toBeNull();
    // Back to Prices, in the same Settings frame (Back returns to ?section=prices; see the note at the top of the test).
    await page.goBack();
    await expect(page.locator('section[data-section="prices"]')).toBeVisible();
    await expect(priceInput(page, SIEM)).toHaveValue('2.50');

    // Cmd/Ctrl+S saves (the browser's own save dialog never opens) and the meter starts.
    await priceInput(page, SIEM).focus();
    await page.keyboard.press('ControlOrMeta+s');
    const toast = page.getByText('The meter is running.', { exact: false }).first();
    await expect(toast).toBeVisible();
    await expect.poll(() => kvGet(page, 'prices')).not.toBeNull();
    await expect(page.getByTestId('prices-pending')).toHaveCount(0);
    await expect(section.getByRole('button', { name: 'Save changes' })).toBeVisible();
    await page.getByRole('button', { name: 'See the receipt' }).click();
    await expectPath(page, '/');
    expect(errors()).toEqual([]);
  });

  test('live receipt: typing a price prints its row line from the last sweep, and the card totals the receipt (P2-W09)', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await gotoApp(page, '/first-run');
    await seedPrices(page, pricesOnly({ [SIEM]: { milliCentsPerGb: 250_000, preset: 'splunk_cloud' }, [ARCHIVE]: { milliCentsPerGb: 2_300, preset: 's3' } }));
    await gotoApp(page, '/settings/prices');
    await waitForRows(page);
    await expect.poll(() => kvGet(page, 'snapshot'), { timeout: 40_000 }).not.toBeNull();
    await expect(page.getByTestId(`price-receipt-${SIEM}`)).toBeVisible({ timeout: 40_000 });
    const section = page.locator('section[data-section="prices"]');
    await expect(section.getByRole('button', { name: 'Save changes' })).toBeVisible();

    // The expected figure, from the snapshot the page reads: Σ over the SIEM's flows of GB/day × $2.25 (core/pricing.priceMinute).
    const outOf = async (id: string) =>
      page.evaluate(async (outputId) => {
        const snap = (await (await fetch('/mock-api/v1/kvstore/snapshot')).json()) as { flows: { outputId: string; outBPerDay: number }[] };
        return snap.flows.filter((f) => f.outputId === outputId).map((f) => f.outBPerDay);
      }, id);
    const flows = await outOf(SIEM);
    const archiveFlows = await outOf(ARCHIVE);
    await priceInput(page, SIEM).fill('2.25');
    const paidAt = (outs: number[], mcPerGb: number) => outs.reduce((n, outB) => n + Math.round((outB * mcPerGb) / 1e9), 0);
    const paidM = paidAt(flows, 225_000);
    // D53: a destination's line is footed to the card's printed Paid (core/format.ts footColumn over the priced
    // destinations, here the SIEM at $2.25 and the archive at its seeded $0.023), so it can sit a dollar from its own
    // rounding, by the clock's traffic; the lines always add up to the card. Whole dollars, as every receipt list prints
    // money (review W2), the unit as a secondary suffix.
    const line = page.getByTestId(`price-receipt-${SIEM}`);
    await expect(line).toContainText('× $2.25'); // the card below has re-priced at the typed price too
    await expect(page.getByTestId('prices-receipt-paid')).toContainText(/~ \$[\d,]+ \/ day/);
    const cardPaidM = Number((await page.getByTestId('prices-receipt-paid').innerText()).replace(/[^\d]/g, '')) * 100_000;
    const [shownM] = footColumn([paidM, paidAt(archiveFlows, 2_300)], cardPaidM);
    expect(Math.abs(shownM - paidM)).toBeLessThanOrEqual(100_000);
    const amount = paidM > 0 && paidM < 50_000 ? '< $1' : fmtDollars(shownM);
    await expect(page.getByTestId(`price-receipt-amount-${SIEM}`)).toHaveText(`~ ${amount} / day`);
    await expect(line).toContainText(`${fmtBytes(flows.reduce((a, b) => a + b, 0))} / day × $2.25`);
    await expect(line).toContainText('was ');
    await expect(page.getByTestId(`prices-pending-default:${SIEM}`)).toContainText('$2.50 → $2.25');

    // The card's receipt: would have paid, paid, saved per day at the prices on screen.
    const totals = page.getByTestId('prices-receipt');
    await expect(totals).toContainText('At these prices');
    await expect(totals).toContainText("The last sweep's traffic, 2 destinations priced");
    for (const key of ['whp', 'paid', 'saved']) await expect(page.getByTestId(`prices-receipt-${key}`)).toContainText(/~ \$[\d,.]+ \/ day/);
    // Typing Analytics' price adds it to the receipt, live.
    await priceInput(page, ANALYTICS).fill('1.80');
    await expect(totals).toContainText("The last sweep's traffic, 3 destinations priced");
    await expect(page.getByTestId(`price-receipt-${ANALYTICS}`)).toBeVisible();
    expect(errors()).toEqual([]);
  });

  test('authorship: a save names who made it, per destination and in Show the math (P2-W24)', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await gotoApp(page, '/settings/prices');
    await waitForRows(page);
    await priceInput(page, SIEM).fill('2.50');
    await saveCard(page, 'prices');
    await expectSavedToast(page);
    // The emulated platform's member (window.getCriblUser) signs the version by name, as the incident card and the
    // Demo Console name them (src/lib/env.ts criblMemberName), and the footer says so.
    await expect(page.getByTestId('prices-last-changed')).toContainText('changed by Steve Koelpin');
    const stored = await kvJson<{ versions: { changedBy?: string }[] }>(page, 'prices');
    expect(stored!.versions.at(-1)!.changedBy).toBe('Steve Koelpin');

    // A second price: the destination's history lists both, newest first, each with its author.
    await priceInput(page, SIEM).fill('2.25');
    await saveCard(page, 'prices');
    await expectSavedToast(page);
    await page.getByTestId(`price-history-toggle-${SIEM}`).click();
    const history = page.getByTestId(`price-row-${SIEM}`).getByTestId('price-history');
    await expect(history.locator('li')).toHaveCount(2);
    await expect(history.locator('li').first()).toContainText('$2.25 · Splunk Cloud · by Steve Koelpin');
    await expect(history.locator('li').last()).toContainText('$2.50 · Splunk Cloud · by Steve Koelpin');

    // Show the math carries the author of the price in force.
    await expect.poll(() => kvGet(page, 'snapshot'), { timeout: 30_000 }).not.toBeNull();
    await page.getByRole('navigation').first().getByRole('link', { name: /receipt/i }).click();
    await page.locator('.mr-hero-actions').getByRole('button', { name: 'Show the math' }).click();
    const drawer = page.getByTestId('math-drawer');
    await expect(drawer.locator('.mr-math-dest', { hasText: 'SIEM (prod)' }).getByTestId('math-set-by')).toHaveText('set by Steve Koelpin', { timeout: 30_000 });
    expect(errors()).toEqual([]);
  });

  test('vendor tiles: the suggestion first, search filters, arrows, type-ahead and Enter pick (P2-W24)', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await gotoApp(page, '/settings/prices');
    await waitForRows(page);
    const trigger = page.getByTestId(`price-row-${ANALYTICS}`).getByRole('button', { name: /Preset, / });
    await expect(trigger).toContainText('Datadog Logs');
    await trigger.click();
    const picker = page.getByTestId('preset-picker');
    await expect(picker).toBeVisible();
    // The search field has focus; the row's suggestion is pinned first, the vendors as monogram tiles.
    await expect(page.getByTestId('preset-search').locator('input').or(page.getByTestId('preset-search'))).toBeFocused();
    const groups = picker.locator('[data-group]');
    await expect(groups.first()).toHaveAttribute('data-group', 'suggested');
    await expect(groups.first().getByRole('option')).toHaveCount(1);
    await expect(groups.first().getByRole('option')).toHaveAttribute('data-preset', 'datadog');
    await expect(groups.first().locator('.mr-pp-mono')).toHaveText('DD');
    await expect(picker.getByRole('option', { selected: true })).toHaveAttribute('data-preset', 'datadog');

    // Search filters by vendor, id or destination type.
    await page.keyboard.type('splunk');
    await expect(picker.getByRole('option')).toHaveCount(2);
    await expect(picker.locator('.mr-pp-name')).toHaveText(['Splunk Cloud', 'Splunk Enterprise']);
    await page.getByTestId('preset-search').locator('input').or(page.getByTestId('preset-search')).first().fill('zzz');
    await expect(picker.getByRole('option')).toHaveCount(0);
    await expect(picker.getByRole('status')).toContainText('No preset matches "zzz"');
    await page.getByTestId('preset-search').locator('input').or(page.getByTestId('preset-search')).first().fill('');

    // ArrowDown enters the grid on the selected tile; arrows move; type-ahead jumps; Enter picks and closes.
    await page.keyboard.press('ArrowDown');
    await expect(picker.locator('[data-preset="datadog"]').first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(picker.locator('[data-preset="splunk_cloud"]')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(picker.locator('[data-preset="splunk_enterprise"]')).toBeFocused();
    await page.keyboard.type('am');
    await expect(picker.locator('[data-preset="s3"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(picker).toHaveCount(0);
    await expect(trigger).toContainText('Amazon S3');
    await expect(priceInput(page, ANALYTICS)).toHaveValue('0.023');
    expect(errors()).toEqual([]);
  });
});
