// r2 ui-7 (FINDINGS_EXTRA IC-2 + BO-13): What if on one rate basis.
//   • IC-2: the hero ("Saved by Cribl would read …") and its bar rest on the workspace at today's rates, the strip's own
//     basis, and say so ("a year at current rates"); the hero moves by exactly the strip's change.
//   • BO-13: after a dry run, the "Biggest unclaimed savings" line for the same stream and treatment moves to the dry
//     run's basis, so one pack never shows two yearly figures on one screen (before: projection $24,039 beside an
//     unclaimed $24,010). Its figure equals the hero bar's "+… from this change".
// The dry run is the emulator's preview API stubbed as flow.spec.ts stubs it (10 sample events, 1,000 B in, 660 B out).

import { expect, test, type Page } from '@playwright/test';
import { gotoApp, seedPrices, trackConsoleErrors } from './helpers/index.ts';

const WS = 'default|mrd_windows_workstations|mrd_windows_workstations|mrd_siem_prod';

async function stubPreviewApi(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const real = window.fetch.bind(window);
    const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, location.href).pathname;
      if (/\/m\/[^/]+\/system\/samples\/[^/]+\/content$/.test(path)) {
        return json(200, Array.from({ length: 10 }, (_, i) => ({ _raw: `<Event>${'x'.repeat(985)}</Event>`, _time: 1_790_000_000 + i })));
      }
      if (/\/m\/[^/]+\/preview$/.test(path) && (init?.method ?? 'GET') === 'POST') {
        const req = JSON.parse(String(init?.body ?? '')) as { pipelineId: string; events: { _raw: string; _time: number }[] };
        return json(200, {
          count: req.events.length,
          items: req.events.map((e, i) => ({ __criblEventType: 'event', __id: i, _time: e._time, _raw: e._raw.slice(0, 660), cribl_pipe: req.pipelineId })),
        });
      }
      return real(input, init);
    };
  });
}

const dollars = (text: string): number => Number(text.replace(/[^\d]/g, ''));

async function openWhatIf(page: Page, query: string): Promise<void> {
  await gotoApp(page, '/flow');
  await seedPrices(page);
  await gotoApp(page, `/whatif?${query}`);
  await expect(page.getByTestId('whatif-results')).toBeVisible({ timeout: 30_000 });
}

/** The hero bar's "+$X from this change", in whole dollars. */
async function heroDelta(page: Page): Promise<number> {
  return dollars((await page.getByTestId('whatif-hero').getByTestId('rbar-projected-legend').locator('.mr-rbar-amount').innerText()).trim());
}

/** The unclaimed line for a stream + treatment, in whole dollars (undefined when the list has none). */
async function unclaimedFor(page: Page, stream: string, treatment: string): Promise<number | undefined> {
  const line = page.locator(`a.mr-whatif-unclaimed-line[data-stream="${stream}"][data-treatment="${treatment}"]`);
  if ((await line.count()) === 0) return undefined;
  return dollars((await line.locator('.mr-rlist-amount').innerText()).trim());
}

test.describe('ui-7: What if on one rate basis', () => {
  test('the hero names its basis and moves by exactly the strip\'s change a year', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openWhatIf(page, `stream=${encodeURIComponent(WS)}&treatment=custom&drop=20`);
    const caption = page.getByTestId('whatif-hero-caption');
    await expect(caption).toHaveText(/^a year at current rates, \+\$[\d,]+ from \$[\d,]+ today$/);
    const text = (await caption.innerText()).replace(/\s+/g, ' ');
    const [, delta, from] = /\+\$([\d,]+) from \$([\d,]+)/.exec(text)!;
    const after = dollars(await page.getByTestId('whatif-hero-value').innerText());
    // The figure is today's rates plus the change (one dollar of rounding at most), and the bar's hatched part is it.
    expect(Math.abs(after - (dollars(from) + dollars(delta)))).toBeLessThanOrEqual(1);
    expect(Math.abs((await heroDelta(page)) - dollars(delta))).toBeLessThanOrEqual(1);
    expect(errors()).toEqual([]);
  });

  test('after a dry run the unclaimed line for that stream and treatment reads the projection\'s "+… from this change"', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await stubPreviewApi(page);
    await openWhatIf(page, `stream=${encodeURIComponent(WS)}&treatment=pack-windows`);
    await expect(page.getByTestId('whatif-basis')).toHaveAttribute('data-basis', 'similar');
    const before = await unclaimedFor(page, WS, 'pack-windows');
    expect(before, 'the unclaimed list offers the Windows pack on Windows workstations').toBeDefined();
    // On the similar stream's basis the two already agree.
    expect(Math.abs((await heroDelta(page)) - before!)).toBeLessThanOrEqual(1);

    await page.getByRole('button', { name: 'Dry run on sample events' }).click();
    await expect(page.getByTestId('whatif-basis')).toHaveAttribute('data-basis', 'dry-run', { timeout: 30_000 });
    const projected = await heroDelta(page);
    expect(projected, 'the dry run moved the projection off the similar stream\'s figure').not.toBe(before);
    await expect.poll(() => unclaimedFor(page, WS, 'pack-windows')).toBe(projected);
    // The list stays ranked.
    const deltas = await page.locator('a.mr-whatif-unclaimed-line').evaluateAll((els) => els.map((e) => Number((e as HTMLElement).dataset.delta)));
    expect([...deltas].sort((a, b) => b - a)).toEqual(deltas);
    expect(errors()).toEqual([]);
  });
});
