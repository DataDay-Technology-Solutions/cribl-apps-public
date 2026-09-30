// r2 ui-13 (FINDINGS_EXTRA BO-14, BO-15, IC-17, IC-6; IC-7 is a unit test, r2-ui-week-empty): layout and a11y polish.
//   • BO-14: the presenter takeover's delivery line is whole at 1440 / 1920 / 2560 with the demo-profile note showing
//     (it was cut to "#finops-alert…" and lost its time: the note took its width first).
//   • BO-15: the Ledger's Changes list wraps a row's outcome instead of cutting "Recovered …, reverted by …" off on
//     desktop, and the commit card says it too.
//   • IC-17: a top tab's focus ring is at least 3:1 on the header in both themes, drawn inside the tab row's clip.
//   • IC-6: Prices says a new destination takes a few minutes to appear (Sweep now to check).

import { expect, test, type Page } from '@playwright/test';
import { gotoApp, resetMock, seedPrices, setTheme, waitForHydration, waitForMock } from './helpers/index.ts';
import { injectLedgerDocs, loadDemoFixture, type LedgerDocs } from './ledger-fixture.ts';

let fixture: LedgerDocs;
test.beforeAll(() => {
  fixture = loadDemoFixture();
});

async function openFixture(page: Page, path: string): Promise<void> {
  await gotoApp(page, '/ledger');
  await injectLedgerDocs(page, structuredClone(fixture));
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await waitForMock(page);
  await waitForHydration(page);
}

for (const [w, h] of [
  [1440, 900],
  [1920, 1080],
  [2560, 1440],
] as const) {
  test(`BO-14 ${w}: the takeover's delivery line is whole beside the demo-profile note`, async ({ page }, info) => {
    test.skip(info.project.name !== 'chromium', 'projector widths, set here');
    test.setTimeout(120_000);
    await page.setViewportSize({ width: w, height: h });
    await openFixture(page, '/ledger');
    await gotoApp(page, '/?present=1');
    await page.waitForFunction(() => '__MR_PRESENTER__' in window, undefined, { timeout: 15_000 });
    // Re-open the fixture's regression as a fresh alert (it keeps its demo-profile note), so the takeover lands.
    await page.evaluate(() => {
      type St = { snapshot: { incidents: { id: string; closedAt?: string; openedAt: string; type: string; notes?: string[] }[]; openIncidents: number } | null };
      const hook = (window as unknown as { __MR_PRESENTER__: { store: { getState(): St; setState(p: Record<string, unknown>): void }; stop(): void } }).__MR_PRESENTER__;
      hook.stop();
      const s = hook.store.getState().snapshot!;
      const open = s.incidents.filter((i) => !i.closedAt && i.type === 'regression');
      hook.store.setState({ snapshot: { ...s, incidents: s.incidents.filter((i) => !open.includes(i)), openIncidents: 0 } });
      setTimeout(() => {
        const fresh = open.map((i) => ({ ...i, id: `${i.id}_x`, openedAt: new Date(Date.now() - 1000).toISOString(), notes: [...new Set([...(i.notes ?? []), 'demo-profile'])] }));
        hook.store.setState({ snapshot: { ...s, incidents: [...s.incidents.filter((i) => !open.includes(i)), ...fresh], openIncidents: fresh.length } });
      }, 600);
    });
    const delivery = page.locator('.mr-takeover .mr-tk-delivery').first();
    await expect(delivery).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.mr-takeover .mr-tk-note').first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.waitForTimeout(600);
    const m = await delivery.evaluate((d) => ({ sw: d.scrollWidth, cw: d.clientWidth, text: d.textContent }));
    expect(m.sw, `"${m.text}" is cut`).toBeLessThanOrEqual(m.cw + 1);
  });
}

test('BO-15: a settled change\'s outcome reads whole in Changes at 1440, and the commit card says it', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'desktop width, set here');
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFixture(page, '/ledger');
  const list = page.getByTestId('changes-list');
  const settled = list.getByTestId('changes-settled').first();
  await expect(settled).toBeVisible();
  const note = (await settled.innerText()).replace(/^ · /, '').trim();
  expect(note).toMatch(/^(Recovered|Undid)/);
  const meta = settled.locator('xpath=ancestor::*[contains(@class, "mr-changes-meta")][1]');
  const clip = await meta.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(clip.sw, 'the outcome is not clipped').toBeLessThanOrEqual(clip.cw + 1);
  await expect(meta).toHaveAttribute('title', new RegExp(note.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await settled.locator('xpath=ancestor::button[1]').click();
  await expect(page.getByTestId('commit-card').getByTestId('commit-settled')).toHaveText(note);
});

function contrast(a: number[], b: number[]): number {
  const lum = (c: number[]) => {
    const [r, g, bl] = c.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

for (const theme of ['light', 'dark'] as const) {
  test(`IC-17 ${theme}: a focused top tab's ring is 3:1 or more and inside the tab row`, async ({ page }, info) => {
    test.skip(info.project.name === 'mobile', 'keyboard, desktop');
    await gotoApp(page, '/first-run');
    await resetMock(page);
    await seedPrices(page);
    await gotoApp(page, '/');
    await setTheme(page, theme);
    await page.waitForTimeout(400);
    await page.locator('body').click({ position: { x: 5, y: 400 } });
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => !!document.activeElement?.closest('.mr-topnav-tabs'))) break;
    }
    const probe = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement;
      const cs = getComputedStyle(a);
      const rgb = (s: string) => (s.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
      // The header's own background under the tab (the first opaque ancestor).
      let bg = 'rgb(255, 255, 255)';
      for (let el: HTMLElement | null = a; el; el = el.parentElement) {
        const c = getComputedStyle(el).backgroundColor;
        if (c && !/rgba\(\d+, \d+, \d+, 0\)|transparent/.test(c)) {
          bg = c;
          break;
        }
      }
      if (bg === 'rgb(255, 255, 255)') bg = getComputedStyle(document.body).backgroundColor || bg;
      const box = a.getBoundingClientRect();
      const off = parseFloat(cs.outlineOffset) || 0;
      const width = parseFloat(cs.outlineWidth) || 0;
      const clip = (a.closest('.mr-topnav-tabs') as HTMLElement).getBoundingClientRect();
      return {
        inTabs: !!a.closest('.mr-topnav-tabs'),
        ring: rgb(cs.outlineColor),
        bg: rgb(bg),
        style: cs.outlineStyle,
        ringTop: box.top - off - width,
        ringBottom: box.bottom + off + width,
        clipTop: clip.top,
        clipBottom: clip.bottom,
      };
    });
    expect(probe.inTabs).toBe(true);
    expect(probe.style).toBe('solid');
    expect(contrast(probe.ring, probe.bg), `ring ${probe.ring} on ${probe.bg}`).toBeGreaterThanOrEqual(3);
    expect(probe.ringTop).toBeGreaterThanOrEqual(probe.clipTop - 0.5);
    expect(probe.ringBottom).toBeLessThanOrEqual(probe.clipBottom + 0.5);
  });
}

test('IC-6: Prices says new destinations take a few minutes to appear', async ({ page }) => {
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await seedPrices(page);
  await page.goto('/settings/prices', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  await expect(page.getByTestId('prices-new-destinations')).toHaveText('New destinations appear within a few minutes · Sweep now to check', { timeout: 40_000 });
});
