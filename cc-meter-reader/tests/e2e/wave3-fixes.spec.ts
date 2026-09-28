// tests/e2e/wave3-fixes.spec.ts — the wave-3 review's findings, checked in the browser on the sample tour.
//
// W3-RECEIPT-1 across views: the Flow map's "All flows" card, the Ledger's money strip and its Total row print one
// footed triple (would have paid − paid = saved, to the dollar) for one snapshot, never $654 on one and $655 on the
// other; the Receipt's Top savers add up to their "All flows" line. On a phone the Flow view is a list, so its card
// says what a tap does instead of "Hover or focus…".

import { expect, test, type Page } from '@playwright/test';
import { gotoApp, resetMock, waitForHydration } from './helpers/index.ts';

/** '$1,234' / '~ $1,234 / day' → 1234 (whole dollars). */
const dollars = (s: string | null | undefined): number => Number((s ?? '').replace(/\/.*$/, '').replace(/[^0-9]/g, ''));

async function openTour(page: Page): Promise<void> {
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  await page.getByRole('button', { name: 'Tour with sample data' }).click();
  await expect(page.getByTestId('receipt-hero')).toBeVisible({ timeout: 15_000 });
}

/** Client-side navigation through the tab row, so the tour's sample data stays on screen. */
async function openTab(page: Page, path: string): Promise<void> {
  await page.locator(`.mr-topnav-tabs a[href*="${path}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`${path}(\\?|$)`));
}

test.describe('W3-RECEIPT-1: one footed triple on every view', () => {
  test('the Flow card, the Ledger strip and the Ledger Total row print the same would have paid, paid and saved', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the phone Flow view is a list and the Ledger has no Total row there');
    await openTour(page);

    await openTab(page, '/flow');
    const card = page.getByTestId('flow-receipt');
    await expect(card).toBeVisible({ timeout: 15_000 });
    const flow = {
      whp: dollars(await card.getByTestId('receipt-whp').locator('.mr-num').textContent()),
      paid: dollars(await card.getByTestId('receipt-paid').locator('.mr-num').textContent()),
      saved: dollars(await card.getByTestId('receipt-saved').locator('.mr-num').textContent()),
    };
    expect(flow.whp).toBeGreaterThan(0);
    expect(flow.whp - flow.paid, JSON.stringify(flow)).toBe(flow.saved);

    // The Flow card totals one worker group ("All flows in default"); the Ledger lists every group unless ?group
    // names one, so the Ledger is opened on the card's group (the tour is a sticky URL parameter and survives).
    const heading = (await card.locator('.mr-receipt-title').textContent()) ?? '';
    const group = /All flows in (.+)$/.exec(heading.trim())?.[1];
    expect(group, heading).toBeTruthy();
    await page.goto(`/ledger?tour=1&group=${encodeURIComponent(group!)}`, { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    const strip = page.getByTestId('ledger-strip');
    await expect(strip).toBeVisible({ timeout: 15_000 });
    const tile = async (key: string) => dollars(await strip.locator(`[data-tile="${key}"] .mr-ledger-tile-figure .mr-num`).first().textContent());
    const ledger = { whp: await tile('whp'), paid: await tile('paid'), saved: await tile('saved') };
    expect(ledger.whp - ledger.paid, JSON.stringify(ledger)).toBe(ledger.saved);
    expect(ledger).toEqual(flow);

    const totals = page.locator('.mr-lt-totals');
    await expect(totals).toBeVisible();
    const total = {
      whp: dollars(await totals.locator('.mr-whp .mr-num').first().textContent()),
      paid: dollars(await totals.locator('.mr-paid .mr-num').first().textContent()),
      saved: dollars(await totals.locator('.mr-saved .mr-num').first().textContent()),
    };
    expect(total).toEqual(ledger);
  });

  test('the Top savers add up to their "All flows" line', async ({ page }) => {
    await openTour(page);
    const savers = page.getByTestId('receipt-top-savers');
    await expect(savers.getByTestId('savers-total')).toBeVisible();
    const total = dollars(await savers.getByTestId('savers-total').locator('.mr-rlist-amount').textContent());
    const amounts = await savers.locator('.mr-rlist-amount').allTextContents();
    // Every amount in the card but the total's own: the savers, then "N other flows" when there is one.
    const lines = amounts.map(dollars);
    const sum = lines.reduce((a, b) => a + b, 0) - total;
    expect(sum, amounts.join(' + ')).toBe(total);
  });
});

test.describe('the Flow view on a phone', () => {
  test('the list’s card says what a tap does, not "Hover or focus…"', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'the list replaces the map only on a phone');
    await openTour(page);
    await openTab(page, '/flow');
    const card = page.getByTestId('flow-receipt');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText('Tap a flow to see its receipt.');
    await expect(card).not.toContainText('Hover or focus');
  });
});
