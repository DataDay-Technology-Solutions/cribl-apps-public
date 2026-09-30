// r2 ui-9 (FINDINGS_EXTRA BO-6, major): on a phone the Ledger's card for a diverted flow read "$2,502 / dayVolume reduced
// diverted": the saved figure's box shrank to 62 px under its 81.6 px of ink, so "/ day" ran into the caption (gap −3.4 px
// at 390; "DNS to Cribl Lake" on the tour). The saved column is now sized to its figure and the caption keeps a gap.
// Template: app-assurance extra/skeptic1-ledger-card-overlap (sk.spec.ts). Checked at 360, 390 and 414 in both themes, on
// every card of the tour's Ledger: the figure's ink right edge + 8 px ≤ the caption's left edge, the reduction's words
// clear the trend by 8 px, the saved box holds its ink, and the card stays inside its row.
// r3 ui-7 (FINDINGS_R3 #13, r3/5 F3): ui-9's fix moved the collision to 320 px, where "Volume reduced" (one unbroken
// line) ran under the trend sparkline on every card. 320 and 340 are checked too; below ≈340 px the caption wraps.

import { expect, test } from '@playwright/test';
import { gotoApp, resetMock, setTheme } from './helpers/index.ts';

interface CardMeasure {
  name: string;
  reductionTextRight: number;
  trendLeft: number;
  savedTextRight: number;
  captionLeft: number;
  savedOverflow: number;
  cardOverflow: number;
  cardBottom: number;
  rowBottom: number;
}

for (const width of [320, 340, 360, 390, 414] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${width} px, ${theme}: every Ledger card's saved figure clears its caption by 8 px`, async ({ page }, info) => {
      test.skip(info.project.name !== 'mobile' && info.project.name !== 'chromium', 'phone widths, set here');
      test.setTimeout(120_000);
      await page.setViewportSize({ width, height: 844 });
      await gotoApp(page, '/first-run');
      await resetMock(page);
      await gotoApp(page, '/ledger?tour=1');
      await setTheme(page, theme);
      await expect(page.locator('[data-callout="sample-band"]').first()).toBeVisible({ timeout: 30_000 });
      const cards = page.locator('.mr-lt-card');
      await expect(cards.first()).toBeVisible({ timeout: 30_000 });
      // Every card, including the diverted ones further down (the list is virtual: scroll each into view).
      const seen = new Map<string, CardMeasure>();
      for (let pass = 0; pass < 40; pass++) {
        const batch = await cards.evaluateAll((els) =>
          els.map((el) => {
            const saved = el.querySelector('.mr-lt-card-saved') as HTMLElement | null;
            const cap = el.querySelector('.mr-lt-card-caption');
            let savedTextRight = -1;
            if (saved) {
              const w = document.createTreeWalker(saved, NodeFilter.SHOW_TEXT);
              for (let t = w.nextNode(); t; t = w.nextNode()) {
                if (!t.textContent?.trim()) continue;
                const rg = document.createRange();
                rg.selectNodeContents(t);
                for (const rr of Array.from(rg.getClientRects())) savedTextRight = Math.max(savedTextRight, rr.right);
              }
            }
            let captionLeft = Number.POSITIVE_INFINITY;
            if (cap) {
              const rg = document.createRange();
              rg.selectNodeContents(cap);
              for (const rr of Array.from(rg.getClientRects())) captionLeft = Math.min(captionLeft, rr.left);
            }
            // The reduction's words and the trend beside them must not touch either.
            const red = el.querySelector('.mr-lt-card-reduction');
            let reductionTextRight = -1;
            if (red) {
              const w = document.createTreeWalker(red, NodeFilter.SHOW_TEXT);
              for (let t = w.nextNode(); t; t = w.nextNode()) {
                if (!t.textContent?.trim()) continue;
                const rg = document.createRange();
                rg.selectNodeContents(t);
                for (const rr of Array.from(rg.getClientRects())) reductionTextRight = Math.max(reductionTextRight, rr.right);
              }
            }
            const trendEl = el.querySelector('.mr-lt-card-trend');
            const trendLeft = trendEl ? trendEl.getBoundingClientRect().left : Number.POSITIVE_INFINITY;
            const row = el.closest('[role="row"]') as HTMLElement | null;
            const card = el as HTMLElement;
            return {
              name: (el.querySelector('.mr-lt-card-top') as HTMLElement | null)?.innerText.split('\n')[0] ?? '',
              savedTextRight,
              captionLeft,
              reductionTextRight,
              trendLeft,
              savedOverflow: saved ? saved.scrollWidth - saved.clientWidth : 0,
              cardOverflow: card.scrollWidth - card.clientWidth,
              cardBottom: card.getBoundingClientRect().bottom,
              rowBottom: row ? row.getBoundingClientRect().bottom : Number.POSITIVE_INFINITY,
            };
          }),
        );
        for (const m of batch) if (m.name) seen.set(m.name, m);
        const atEnd = await page.evaluate(() => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2);
        if (atEnd) break;
        await page.mouse.wheel(0, 600);
        await page.waitForTimeout(150);
      }
      expect(seen.size, 'cards measured').toBeGreaterThan(5);
      expect([...seen.keys()].some((n) => /Cribl Lake/.test(n)), 'a diverted flow was measured').toBe(true);
      for (const [name, m] of seen) {
        expect(m.savedTextRight + 8, `${name}: the figure's ink clears the caption by 8 px`).toBeLessThanOrEqual(m.captionLeft);
        expect(m.reductionTextRight + 8, `${name}: the reduction's words clear the trend by 8 px`).toBeLessThanOrEqual(m.trendLeft);
        expect(m.savedOverflow, `${name}: the saved box holds its figure`).toBeLessThanOrEqual(0);
        expect(m.cardOverflow, `${name}: nothing spills out of the card`).toBeLessThanOrEqual(0);
        expect(m.cardBottom, `${name}: the card stays inside its row`).toBeLessThanOrEqual(m.rowBottom + 0.5);
      }
    });
  }
}
