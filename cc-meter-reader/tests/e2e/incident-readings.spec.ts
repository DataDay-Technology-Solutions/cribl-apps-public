// tests/e2e/incident-readings.spec.ts — closed incidents keep their drop and add where they recovered to
// (DECISIONS D47), on every surface that prints an incident's figures: the compact card family (the dev
// gallery), the green takeover on the presenter view and the Ledger's alerts rail. Before D47 the detector
// rewrote `after` with the reading at close, so every closed card read "Savings dropped: 76% → 89%".
//
// Evidence: tests/report/screens/incident-card-<theme>-1440.png (and -390, the same cards at a phone's width),
// incident-takeover-<theme>-1440.png and incident-rail-<theme>-1440.png, written by the `chromium` project only
// (the 1920 and phone projects skip this file, so the grid is never overwritten at another width; the phone
// pass sets the viewport itself).

import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Incident, Snapshot } from '../../core/types.ts';
import { gotoApp, screenPath, setTheme, trackConsoleErrors, waitForHydration, waitForMock, type Theme } from './helpers/index.ts';
import { loadDemoFixture, injectLedgerDocs, type LedgerDocs } from './ledger-fixture.ts';

const MC = 100_000; // millicents per dollar
const THEMES: readonly Theme[] = ['light', 'dark'];

test.skip(({ browserName, viewport }) => browserName !== 'chromium' || viewport?.width !== 1440, 'evidence at 1440 in Chromium only');

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** The presenter spec's regression, opened a second before `now`: 75% → 50%, $25 a day, delivered to Slack. */
function regression(now: number, over: Partial<Incident> = {}): Incident {
  const iso = (ms: number) => new Date(ms).toISOString();
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
      author: 's.koelpin',
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
    deliveries: [{ endpointId: 'ep_slack', status: 200, at: iso(now + 2_000) }],
    ...over,
  };
}

const SLACK_ENDPOINT = {
  id: 'ep_slack',
  name: 'Slack',
  url: 'https://hooks.slack.com/services/T000/B000/abcd',
  host: 'hooks.slack.com',
  format: 'slack' as const,
  minSeverity: 'medium' as const,
  weeklyReceipt: true,
  enabled: true,
};

let fixture: LedgerDocs;

test.beforeAll(() => {
  fixture = loadDemoFixture();
});

// ─── Driving the page ────────────────────────────────────────────────────────

interface Hook {
  store: { getState(): { snapshot: Snapshot | null; settings: { notifications: unknown[]; presenter: { headlinePeriod: string } } }; setState(s: object): void };
  stop(): void;
}

/** Puts the Ledger fixture's snapshot on stage with polling paused, then publishes `incidents` as a sweep would. */
async function publishIncidents(page: Page, incidents: Incident[]): Promise<void> {
  await page.evaluate((incs) => {
    const h = (window as unknown as { __MR_PRESENTER__: Hook }).__MR_PRESENTER__;
    const snap = h.store.getState().snapshot;
    if (!snap) throw new Error('no snapshot on stage');
    h.store.setState({ snapshot: { ...snap, incidents: incs, openIncidents: incs.filter((i) => !i.closedAt).length } });
  }, incidents);
}

async function openPresenter(page: Page, theme: Theme): Promise<void> {
  await gotoApp(page, '/?present=1');
  await page.waitForFunction(() => '__MR_PRESENTER__' in window);
  await setTheme(page, theme);
  await page.evaluate(
    ({ snap, endpoint }) => {
      const h = (window as unknown as { __MR_PRESENTER__: Hook }).__MR_PRESENTER__;
      h.stop();
      const { settings } = h.store.getState();
      h.store.setState({
        snapshot: { ...snap, incidents: [], openIncidents: 0 },
        source: 'live',
        errors: {},
        settings: { ...settings, notifications: [endpoint], presenter: { ...settings.presenter, headlinePeriod: 'annualized' } },
      });
    },
    { snap: fixture.snapshot, endpoint: SLACK_ENDPOINT },
  );
  await expect(page.locator('.mr-pv-figure')).toBeVisible();
}

/** Waits until the takeover's enter animation (450 ms slide-up) has finished, so its box is final. */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const el = document.querySelector('.mr-takeover');
    return !!el && el.getAnimations().every((a) => a.playState !== 'running' && !a.pending);
  });
}

/**
 * Every "·" a compact card shows sits between two fragments on one line (IncidentCard.css hangs each in the
 * gap before what it introduces): one that would start a line falls outside the line's box and is clipped;
 * none is the last thing on its line.
 */
async function expectNoLoneSeparators(card: Locator): Promise<void> {
  const lone = await card.evaluate((el) => {
    const out: string[] = [];
    for (const line of el.querySelectorAll('.mr-inc-line')) {
      const box = line.getBoundingClientRect();
      for (const sep of line.querySelectorAll('.mr-inc-sep')) {
        const r = sep.getBoundingClientRect();
        if (r.right <= box.left + 0.5) continue; // hangs off the line's start: clipped, invisible
        const text = (sep.parentElement?.textContent ?? '').trim();
        if (r.left < box.left + 4) out.push(`leads a line: ${text}`);
        const next = sep.nextElementSibling?.getBoundingClientRect();
        if (!next || next.left < r.right - 0.5 || Math.abs(next.top - r.top) > r.height) out.push(`ends a line: ${text}`);
      }
    }
    return out;
  });
  expect(lone).toEqual([]);
}

async function shoot(page: Page, id: string, theme: Theme, selector?: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  const path = screenPath(id, theme, page);
  if (selector) await page.locator(selector).screenshot({ path });
  else await page.screenshot({ path, fullPage: false });
}

// ─── The card family ─────────────────────────────────────────────────────────

for (const theme of THEMES) {
  test(`closed cards keep the drop and add the recovery; a pre-D47 close shows the recovery alone (${theme})`, async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page, '/?present=1&gallery=incidents');
    await setTheme(page, theme);
    const compact = page.locator('[data-shot="incident-card-compact"] .mr-inc');
    await expect(compact).toHaveCount(5);

    // Closed since D47: the drop it kept (75% → 50%), then where it recovered to, and the recovery sentence.
    const recovered = compact.nth(2);
    await expect(recovered).toHaveAttribute('data-tone', 'recovered');
    await expect(recovered.locator('.mr-inc-line').first()).toHaveText('75% → to 50%·recovered to 74%·$25 a day above normal while it lasted · 5 min');
    await expect(recovered).toContainText('Recovered · savings back to 74% · closed itself.');

    // Closed before D47 (`after` was the reading at close): no arrow to a low it never kept, and the recovery
    // leads its line in sentence case.
    const legacy = compact.nth(4);
    await expect(legacy).toHaveAttribute('data-tone', 'recovered');
    await expect(legacy.locator('.mr-inc-line').first()).toHaveText('Recovered to 72%·$25 a day above normal while it lasted · 5 min');
    await expect(legacy.locator('.mr-inc-arrow-inline')).toHaveCount(0);
    await expect(legacy).toContainText('Recovered · savings back to 72% · closed itself.');

    // No closed card reads as a rise: the only arrows point at the drop.
    for (const line of await page.locator('[data-tone="recovered"] .mr-inc-ratio-inline').allTextContents()) {
      expect(line).toMatch(/^75% →\s+to 50%$/);
    }
    for (const card of await compact.all()) await expectNoLoneSeparators(card);
    await shoot(page, 'incident-card', theme, '[data-shot="incident-card-compact"]');

    // At a phone's width the closed card wraps: the money moves down whole, its "·" hangs off the line and is
    // clipped, and the recovery sentence breaks as two even lines, never on a trailing "·".
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(recovered.locator('.mr-inc-line').first()).toHaveText('75% → to 50%·recovered to 74%·$25 a day above normal while it lasted · 5 min');
    for (const card of await compact.all()) await expectNoLoneSeparators(card);
    const closedFullPhone = page.locator('[data-shot="incident-card"] .mr-inc').nth(2);
    await expect(closedFullPhone.locator('.mr-inc-recovered')).toHaveCount(1);
    expect(await closedFullPhone.locator('.mr-inc-recovered').evaluate((el) => getComputedStyle(el).textWrap)).toBe('balance');
    await shoot(page, 'incident-card', theme, '[data-shot="incident-card-compact"]');
    await page.setViewportSize({ width: 1440, height: 900 });

    // The full card: the drop as the big figures, where it recovered to beside them.
    const closedFull = page.locator('[data-shot="incident-card"] .mr-inc').nth(2);
    await expect(closedFull).toHaveAttribute('data-tone', 'recovered');
    await expect(closedFull.locator('.mr-inc-ratio-row')).toHaveText('75%→50%recovered to 74%');
    await expect(closedFull).toContainText('Recovered · savings back to 74% · closed itself.');
    await shoot(page, 'incident-card-full', theme, '[data-shot="incident-card"] .mr-inc:nth-child(3)');
    expect(errors()).toEqual([]);
  });

  // ─── The green takeover ────────────────────────────────────────────────────

  test(`the green takeover pairs the low the incident kept with where it recovered to (${theme})`, async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openPresenter(page, theme);
    const takeover = page.locator('.mr-takeover');
    const t0 = await page.evaluate(() => Date.now());
    await publishIncidents(page, [regression(t0)]);
    await expect(takeover).toHaveAttribute('data-mode', 'alert');
    await expect(takeover.locator('.mr-tk-before')).toHaveText('75%');
    await expect(takeover.locator('.mr-tk-after')).toHaveText('50%');
    await settled(page);
    await page.keyboard.press('Escape');
    await expect(takeover).toHaveCount(0);

    // The close keeps `after` (0.5) and records the recovered ratio; the card reads 50% → 75%, never 50% → 50%.
    await publishIncidents(page, [
      regression(t0, {
        closedAt: new Date(t0 + 96_000).toISOString(),
        recoveredTo: 0.75,
        deliveries: [
          { endpointId: 'ep_slack', status: 200, at: new Date(t0 + 2_000).toISOString() },
          { endpointId: 'ep_slack', status: 200, at: new Date(t0 + 97_000).toISOString() },
        ],
      }),
    ]);
    await expect(takeover).toHaveAttribute('data-mode', 'recovery');
    await expect(takeover.locator('.mr-tk-title')).toHaveText('Recovered · savings back to 75% · closed itself.');
    await expect(takeover.locator('.mr-tk-before')).toHaveText('50%');
    await expect(takeover.locator('.mr-tk-after')).toHaveText('75%');
    await expect(takeover.locator('.mr-tk-caught-text')).toHaveText('Alert open for 1:37');
    await expect(takeover).not.toContainText('Savings dropped');
    await settled(page);
    await page.waitForTimeout(300);
    await shoot(page, 'incident-takeover', theme);
    expect(errors()).toEqual([]);
  });

  // ─── The Ledger's alerts rail ──────────────────────────────────────────────

  test(`the Ledger rail's recent alerts read the recovery from the reading at close (${theme})`, async ({ page }) => {
    const errors = trackConsoleErrors(page);
    // The fixture's recovered Kubernetes alert closed through the real detector, so it carries `recoveredTo`;
    // beside it, the same alert as the org's KV held closes before D47 (`after` the reading at close).
    const closed = fixture.snapshot.incidents.find((i) => i.closedAt && i.type === 'regression');
    expect(closed?.recoveredTo, 'the fixture generator closes through core/detector.ts').toBeDefined();
    const legacy: Incident = {
      ...closed!,
      id: 'inc_legacy',
      objectKey: 'route:default:mrd_windows_dc',
      label: 'Windows DC trim (closed before D47)',
      after: closed!.recoveredTo!,
    };
    delete legacy.recoveredTo;
    const docs: LedgerDocs = {
      ...fixture,
      snapshot: { ...fixture.snapshot, incidents: [...fixture.snapshot.incidents, legacy] },
    };
    await gotoApp(page, '/ledger');
    await injectLedgerDocs(page, docs);
    await page.goto('/ledger', { waitUntil: 'domcontentloaded' });
    await waitForMock(page);
    await waitForHydration(page);
    await setTheme(page, theme);

    const rail = page.locator('[data-testid="incidents-rail"]');
    await rail.scrollIntoViewIfNeeded();
    const recent = rail.locator('.mr-rail-group').nth(1);
    await expect(recent).toContainText('Recent');
    const recovered = recent.locator(`[data-incident-id="${closed!.id}"]`);
    const recoveredPct = `${Math.round(closed!.recoveredTo! * 100)}%`;
    await expect(recovered).toContainText(`recovered to ${recoveredPct}`);
    await expect(recovered).toContainText(`Recovered · savings back to ${recoveredPct} · closed itself.`);
    await expect(recovered.locator('.mr-inc-arrow-inline')).toHaveCount(1);
    // The drop is the drop: its "after" is under its "before".
    const line = (await recovered.locator('.mr-inc-ratio-inline').textContent()) ?? '';
    const [before, after] = line.match(/\d+%/g)!.map((s) => Number.parseInt(s, 10));
    expect(after).toBeLessThan(before);
    const legacyCard = recent.locator('[data-incident-id="inc_legacy"]');
    await expect(legacyCard).toContainText(`Recovered to ${recoveredPct}`);
    await expect(legacyCard.locator('.mr-inc-arrow-inline')).toHaveCount(0);
    // The rail is 421 px wide at 1440: the closed card's money line wraps here, and no "·" leads the second line.
    expect(await rail.evaluate((el) => el.getBoundingClientRect().width)).toBeLessThan(440);
    for (const card of await rail.locator('.mr-inc').all()) await expectNoLoneSeparators(card);
    await shoot(page, 'incident-rail', theme, '[data-testid="incidents-rail"]');
    expect(errors()).toEqual([]);
  });
}
