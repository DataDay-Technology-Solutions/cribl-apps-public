// tests/e2e/incident-actions.spec.ts — WP-F wave 2, P1-F07: a deliberate change stops alerting. On the Ledger fixture
// (the demo rig's week, ending in the trim broken on mrd_pay_sample: an open regression naming its commit), a member
// opens the alert's actions on its card:
//   Accept as the new normal → a confirmation that names the level it will learn → the card reads "Accepted as the
//     new normal by Steve Koelpin", the Receipt shows no open alert, and App KV holds what the next sweep reads: the
//     incident closed ('accepted', by whom) in its day's doc and the object's baseline re-seated at that level;
//   Leave out of metering → a confirmation saying its dollars leave every total → Settings → Alerts lists the object;
//   Mute for 24 hours → the card reads "Muted by Steve Koelpin" and settings.mutes holds the mute.
// Nothing here writes Cribl configuration: every request the actions make is to /kvstore.
//
// Screenshots: tests/report/screens/wave2-f-<shot>-<light|dark>-<width>.png from chromium (1440) and mobile (390);
// chromium-1920 and the cross-browser projects run the assertions only.

import { expect, test, type Locator, type Page } from '@playwright/test';
import type { BaselinesDoc, Incident, IncidentsDoc, Settings } from '../../core/types.ts';
import { incidentsDocKey } from '../../core/incidents.ts';
import { gotoApp, kvGet, screenPath, setTheme, trackConsoleErrors, waitForHydration, waitForMock, type Theme } from './helpers/index.ts';
import { injectLedgerDocs, loadDemoFixture, type LedgerDocs } from './ledger-fixture.ts';

const THEMES: readonly Theme[] = ['light', 'dark'];
/** WebKit reports a ResizeObserver that settles over two frames (Capra's menu popover) as a page error; it is not one. */
const BENIGN = [/ResizeObserver loop completed with undelivered notifications/];
const MEMBER = 'Steve Koelpin'; // src/mock/types.ts MOCK_USER: firstName + lastName
const shoots = (): boolean => ['chromium', 'mobile'].includes(test.info().project.name);

let fixture: LedgerDocs;
let openIncident: Incident;

test.beforeAll(() => {
  fixture = loadDemoFixture();
  const open = fixture.snapshot.incidents.find((i) => !i.closedAt && i.type === 'regression');
  if (!open) throw new Error('the Ledger fixture has no open regression');
  openIncident = open;
});

async function openApp(page: Page, path: string): Promise<void> {
  await gotoApp(page, '/ledger');
  await injectLedgerDocs(page, fixture);
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await waitForMock(page);
  await waitForHydration(page);
}

/** The open regression's card in the Ledger's alerts rail (the rail lists open and recently closed alerts). */
function railCard(page: Page): Locator {
  return page.locator(`[data-incident-id="${openIncident.id}"]`).first();
}

async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.mouse.move(0, 0);
}

async function kvJson<T>(page: Page, key: string): Promise<T | null> {
  const raw = await kvGet(page, key);
  return raw === null ? null : (JSON.parse(raw) as T);
}

/** Every request the page makes that is not a KV read or write, a metrics read, or a static asset. */
function trackConfigWrites(page: Page): () => string[] {
  const writes: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    if (req.method() === 'GET' || !url.includes('/mock-api/')) return;
    if (url.includes('/kvstore/') || url.includes('/system/metrics/query')) return;
    writes.push(`${req.method()} ${url}`);
  });
  return () => writes;
}

async function openActions(page: Page, card: Locator): Promise<void> {
  // Centred, so the menu opens below its trigger inside the viewport at every width.
  await card.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await expect(page.getByRole('menu')).toHaveCount(0);
  // A press that lands while the rail re-renders on the second tick can be dropped on a loaded machine: press again.
  await expect(async () => {
    if ((await page.getByRole('menu').count()) === 0) await card.getByTestId('incident-actions-trigger').click();
    await expect(page.getByRole('menu')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

/**
 * Picks a menu item. A pointer click can race the popover's placement on a loaded machine (the click's own scroll
 * moves the rail under it), so the item gets the click a screen reader or keyboard would send (React Aria treats a
 * detail-0 click as a virtual press), after it is visible and still.
 */
async function choose(page: Page, name: RegExp): Promise<void> {
  const item = page.getByRole('menuitem', { name });
  await expect(item).toBeVisible();
  await item.dispatchEvent('click');
}

async function closeActions(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
}

test.describe('P1-F07 · accept, mute or leave out an open alert', () => {
  test('Accept as the new normal: the card says who accepted it, and App KV holds what the next sweep reads', async ({ page }) => {
    const configWrites = trackConfigWrites(page);
    await openApp(page, '/ledger');
    // After the fixture's reload: Firefox and WebKit report the first load's lazy imports, aborted by it, as errors.
    const consoleErrors = trackConsoleErrors(page, BENIGN);
    const card = railCard(page);
    await expect(card).toBeVisible();
    await expect(card).not.toContainText('Accepted');

    if (shoots()) {
      for (const theme of THEMES) {
        await setTheme(page, theme);
        await openActions(page, card);
        await page.screenshot({ path: screenPath('wave2-f-actions-menu', theme, page) });
        await closeActions(page);
      }
      await setTheme(page, 'light');
    }

    await openActions(page, card);
    await choose(page, /Accept as the new normal/);
    const confirm = page.getByTestId('incident-confirm-accept');
    await expect(confirm).toBeVisible();
    // The confirmation names the level it will learn, in the incident's own unit.
    await expect(confirm).toContainText(/learns \d+% as normal for this (pipeline|route)/);
    if (shoots()) {
      for (const theme of THEMES) {
        await setTheme(page, theme);
        await blur(page);
        await page.screenshot({ path: screenPath('wave2-f-accept-confirm', theme, page) });
      }
      await setTheme(page, 'light');
    }
    await page.getByRole('button', { name: 'Accept', exact: true }).click();

    await expect(card).toContainText(`Accepted as the new normal by ${MEMBER}`);
    await expect(card.locator('[data-closed-reason="accepted"]')).toBeVisible();

    // What the next sweep reads: the closed copy in the doc of the day it opened, and the re-seated baseline.
    const doc = await kvJson<IncidentsDoc>(page, incidentsDocKey(Date.parse(openIncident.openedAt)));
    const stored = doc?.items.find((i) => i.id === openIncident.id);
    expect(stored).toMatchObject({ closedReason: 'accepted', closedBy: MEMBER });
    const baselines = await kvJson<BaselinesDoc>(page, 'baselines');
    const seeded = baselines?.byObject[openIncident.objectKey];
    expect(seeded?.mean).toBeGreaterThanOrEqual(0);
    expect(seeded?.mean).toBeLessThan(openIncident.before - 0.1); // re-seated at the drop, not the old baseline
    expect(baselines?.rules[`regression|${openIncident.objectKey}`]).toBeUndefined();

    if (shoots()) {
      for (const theme of THEMES) {
        await setTheme(page, theme);
        await blur(page);
        await card.scrollIntoViewIfNeeded();
        await page.screenshot({ path: screenPath('wave2-f-accepted-ledger', theme, page) });
      }
    }

    // The Receipt no longer lists it as an open alert.
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await expect(page.locator(`[data-testid="receipt-alerts"] [data-incident-id="${openIncident.id}"]`)).toHaveCount(0);

    expect(configWrites()).toEqual([]);
    expect(consoleErrors()).toEqual([]);
  });

  test('Leave out of metering: the confirmation says its dollars leave every total, and Settings lists the object', async ({ page }) => {
    await openApp(page, '/ledger');
    const consoleErrors = trackConsoleErrors(page, BENIGN);
    const card = railCard(page);
    await openActions(page, card);
    await choose(page, /Leave out of metering/);
    const confirm = page.getByTestId('incident-confirm-exclude');
    await expect(confirm).toContainText('their dollars leave every total');
    if (shoots()) {
      for (const theme of THEMES) {
        await setTheme(page, theme);
        await blur(page);
        await page.screenshot({ path: screenPath('wave2-f-exclude-confirm', theme, page) });
      }
      await setTheme(page, 'light');
    }
    await page.getByRole('button', { name: 'Leave out', exact: true }).click();
    await expect(card).toContainText(`Left out of metering by ${MEMBER}`);

    const settings = await kvJson<Settings>(page, 'settings');
    expect(settings?.excludedObjectKeys).toContain(openIncident.objectKey);

    await page.goto('/settings', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    // Settings → Alerts (the side navigation on a desktop, the section picker on a phone).
    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    const picker = page.getByRole('button', { name: /Section/ });
    await expect(nav.or(picker).first()).toBeVisible();
    if (await nav.isVisible()) await nav.getByRole('link', { name: /^Alerts/ }).click();
    else {
      await picker.click();
      await page.getByRole('option', { name: /^Alerts/ }).click();
    }
    const chip = page.locator(`[data-testid="alerts-excluded"] [data-object-key="${openIncident.objectKey}"]`);
    await expect(chip).toBeVisible();
    if (shoots()) {
      for (const theme of THEMES) {
        await setTheme(page, theme);
        await chip.scrollIntoViewIfNeeded();
        await blur(page);
        await page.screenshot({ path: screenPath('wave2-f-excluded-settings', theme, page) });
      }
    }
    expect(consoleErrors()).toEqual([]);
  });

  test('Mute for 24 hours: the card reads muted by the member, and settings.mutes holds it until tomorrow', async ({ page }) => {
    await openApp(page, '/ledger');
    const consoleErrors = trackConsoleErrors(page, BENIGN);
    const card = railCard(page);
    const before = Date.now();
    await openActions(page, card);
    // The mute's description wraps inside the menu rather than losing its end (review W2: "…Sep 28, 1:24" without "AM").
    const hint = page.getByRole('menuitem', { name: /Mute for 24 hours/ }).getByText(/^Nothing new opens on it until /);
    await expect(hint).toContainText(/\d{1,2}:\d\d\s?[AP]M$/);
    // Nothing in the item overflows it (the description may be an inline box, whose clientWidth is 0 in Firefox).
    expect(await page.getByRole('menuitem', { name: /Mute for 24 hours/ }).evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    const menuBox = (await page.getByRole('menu').boundingBox())!;
    const hintBox = (await hint.boundingBox())!;
    expect(hintBox.x + hintBox.width).toBeLessThanOrEqual(menuBox.x + menuBox.width + 1);
    await choose(page, /Mute for 24 hours/);
    await expect(card).toContainText(`Muted by ${MEMBER}`);
    const settings = await kvJson<Settings>(page, 'settings');
    const until = Date.parse(settings?.mutes?.[openIncident.objectKey]?.until ?? '');
    expect(until - before).toBeGreaterThan(23.9 * 3_600_000);
    expect(until - before).toBeLessThan(24.1 * 3_600_000);
    expect(settings?.mutes?.[openIncident.objectKey]?.by).toBe(MEMBER);
    // The Ledger row reads the member's mute, with how long is left (never "after a demo change").
    const vw = page.viewportSize()?.width ?? 0;
    if (vw >= 760) {
      const row = page.locator(`[data-row-id*="|${openIncident.objectKey.split(':')[2]}|"]`).first();
      await expect(row).toContainText(/muted · 2[34] h left/);
    }
    if (shoots()) {
      for (const theme of THEMES) {
        await setTheme(page, theme);
        await card.scrollIntoViewIfNeeded();
        await blur(page);
        await page.screenshot({ path: screenPath('wave2-f-muted-ledger', theme, page) });
      }
    }
    expect(consoleErrors()).toEqual([]);
  });
});
