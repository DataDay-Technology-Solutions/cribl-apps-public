// @vitest-environment jsdom
// r2 ui-15 (r1 core-12 carry, M12): an Output Router that splits its traffic across destinations reads unpriced on
// Prices (core/presets.ts no longer calls it free); its row says how to price it. A router priced already, or any other
// destination, carries no hint.

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PricesDoc } from '../../core/types.ts';
import { PriceTable } from '../../src/components/PriceTable/PriceTable.tsx';
import { buildRows, initialDraft, type Destination } from '../../src/components/PriceTable/model.ts';

afterEach(() => cleanup());
beforeAll(() => {
  // jsdom has no ResizeObserver (Capra's menus measure themselves).
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const T = Date.parse('2026-09-28T01:00:00Z');
const DESTS = [
  { groupId: 'default', outputId: 'my_router', type: 'router', rules: [{ output: 'splunk_prod' }, { output: 's3_archive' }] },
  { groupId: 'default', outputId: 'splunk_prod', type: 'splunk_hec' },
] as unknown as Destination[];

function renderTable(prices: PricesDoc | null) {
  const rows = buildRows(DESTS, prices, T);
  const drafts = Object.fromEntries(rows.map((r) => [r.key, initialDraft(r)]));
  render(<PriceTable rows={rows} drafts={drafts} errors={{}} dirty={new Set()} onChange={() => undefined} tz="UTC" />);
  return rows;
}

describe('r2 ui-15: the splitting router\'s Prices hint', () => {
  it('an unpriced router says to price it at its destinations\' rate', () => {
    const rows = renderTable(null);
    expect(rows.find((r) => r.outputId === 'my_router')!.unpriced).toBe(true);
    expect(screen.getByTestId('price-router-hint-my_router').textContent).toBe("Splits its traffic across destinations: price it at its destinations' rate.");
    expect(screen.queryByTestId('price-router-hint-splunk_prod')).toBeNull();
  });

  it('a router with a price has no hint', () => {
    const priced = {
      schemaVersion: 1,
      updatedAt: '2026-09-28T00:59:00Z',
      versions: [{ effectiveFrom: '2026-09-28T00:59:00Z', byOutputId: { 'default:my_router': { milliCentsPerGb: 225_000 } } }],
    } as PricesDoc;
    renderTable(priced);
    expect(screen.queryByTestId('price-router-hint-my_router')).toBeNull();
  });
});
