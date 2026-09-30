// @vitest-environment jsdom
// founder-build r3 ui-4 (FINDINGS_R3 #18 ui half, the r2 carry H6; contract C2): on a sub-dollar workspace the Receipt's
// trend chart labelled its y-axis "$0 · $0 · $0" (compact whole dollars), and the goal strip printed "$0" for a real
// projection. A sub-dollar axis is now labelled in cents, and an axis under $10 keeps a half tick's cents ("$1.50", not
// "$2"); every other axis is unchanged. The goal strip never prints "$0" for a non-zero figure (it reads "< $1", as every
// other figure does, D82). The formatter is local to src/ (no new core import).

import { cleanup, render as rtlRender } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defaultSettings } from '../../core/settings.ts';
import type { TrendPoint } from '../../core/types.ts';
import { addDaysToKey } from '../../core/time.ts';
import type { GoalPace } from '../../core/goal.ts';
import { TrendChart } from '../../src/components/TrendChart/TrendChart.tsx';
import { niceMax } from '../../src/components/TrendChart/trendMath.ts';
import { AppProviders } from '../../src/state/providers.tsx';
import type { AppServices } from '../../src/state/services.ts';
import { createAppStore } from '../../src/state/store.ts';
import { HeroCard } from '../../src/views/Receipt/HeroCard.tsx';
import { formatAxisMoney, formatMoney, formatMoneyNeverZero } from '../../src/lib/format.ts';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
  window.matchMedia ??= ((query: string) =>
    ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }) as unknown as MediaQueryList);
});
afterEach(() => cleanup());

function render(ui: ReactElement) {
  const store = createAppStore(defaultSettings('2026-09-28T00:00:00.000Z', 'America/Chicago'));
  const services = { store, actions: {} } as unknown as AppServices;
  return rtlRender(
    <AppProviders services={services}>
      <MemoryRouter>{ui}</MemoryRouter>
    </AppProviders>,
  );
}

const TODAY = '2026-09-28';
/** Six whole days before today, the largest saving `topM`. */
function points(topM: number): TrendPoint[] {
  const out: TrendPoint[] = [];
  for (let back = 6; back >= 1; back--) {
    const savedM = back === 3 ? topM : Math.round(topM * (0.4 + back * 0.05));
    out.push({ day: addDaysToKey(TODAY, -back), savedM, whpM: savedM * 2, paidM: savedM });
  }
  return out;
}

function yLabels(topM: number): string[] {
  const { container } = render(<TrendChart points={points(topM)} todayKey={TODAY} commits={[]} tz="America/Chicago" />);
  return [...container.querySelectorAll('.mr-trend-ylabel')].map((el) => el.textContent ?? '');
}

describe('r3 ui-4: the trend chart y-axis', () => {
  it('a $0.45 top reads in cents; only the zero tick reads $0', () => {
    const labels = yLabels(45_000);
    expect(niceMax(45_000)).toBe(50_000);
    expect(labels).toEqual(['$0', '$0.25', '$0.50']);
    expect(labels.filter((l) => l === '$0')).toHaveLength(1);
  });

  it('a $0.08 top reads in cents too', () => {
    expect(yLabels(8_000)).toEqual(['$0', '$0.04', '$0.08']);
  });

  it('an axis under $10 keeps a half tick in cents ($1.50, not $2)', () => {
    expect(yLabels(270_000)).toEqual(['$0', '$1.50', '$3']);
  });

  it('a $1,000 axis is unchanged (compact whole dollars)', () => {
    const top = 95_000_000;
    const max = niceMax(top);
    expect(yLabels(top)).toEqual([0, max / 2, max].map((v) => formatMoney(v, { compact: true })));
    expect(yLabels(top)).toEqual(['$0', '$500', '$1k']);
  });

  it('formatAxisMoney: the rule by itself', () => {
    expect(formatAxisMoney(0, 50_000)).toBe('$0');
    expect(formatAxisMoney(25_000, 50_000)).toBe('$0.25');
    expect(formatAxisMoney(100_000, 200_000)).toBe('$1');
    expect(formatAxisMoney(150_000, 300_000)).toBe('$1.50');
    expect(formatAxisMoney(5_000_000, 10_000_000)).toBe('$50');
    expect(formatAxisMoney(750_000_000, 1_500_000_000)).toBe(formatMoney(750_000_000, { compact: true }));
  });
});

describe('r3 ui-4: the goal strip never prints $0 for a real figure', () => {
  const pace = (over: Partial<GoalPace>): GoalPace => ({
    goalM: 50_000_000,
    savedM: 12_000,
    projectedM: 40_000,
    gapM: 40_000 - 50_000_000,
    onPace: false,
    meteredMinutes: 600,
    lastDayMs: Date.parse('2026-10-01T04:59:59.999Z'),
    ...over,
  });

  function stripText(goal: GoalPace): string {
    const { getByTestId } = render(
      <HeroCard
        period="mtd"
        onPeriod={() => undefined}
        figures={{ period: 'mtd', savedM: goal.savedM, whpM: goal.savedM * 2, paidM: goal.savedM, ratio: 0.5, accrues: true }}
        meterLabel="Saved by Cribl"
        caption="month to date"
        sweepAtMs={Date.parse('2026-09-28T12:00:00.000Z')}
        ratePerSecM={0}
        net={null}
        onShowMath={() => undefined}
        onCopy={() => undefined}
        onApplyRange={() => undefined}
        tz="America/Chicago"
        goal={goal}
        reducedMotion
      />,
    );
    return getByTestId('goal-pace').textContent ?? '';
  }

  it('behind pace on a sub-dollar projection: "< $1", never "$0"', () => {
    const text = stripText(pace({}));
    expect(text).toContain('on track for < $1 by');
    expect(text).not.toMatch(/\$0(?![.\d])/);
  });

  it('ahead with a sub-dollar goal', () => {
    const text = stripText(pace({ goalM: 30_000, projectedM: 40_000, gapM: 10_000, onPace: true }));
    expect(text).toContain('On pace for < $1 by');
    expect(text).toContain('goal < $1');
    expect(text).not.toMatch(/\$0(?![.\d])/);
  });

  it('formatMoneyNeverZero: compact, except a real amount that would read $0', () => {
    expect(formatMoneyNeverZero(0)).toBe('$0');
    expect(formatMoneyNeverZero(40_000)).toBe('< $1');
    expect(formatMoneyNeverZero(60_000)).toBe('$1');
    expect(formatMoneyNeverZero(50_000_000)).toBe(formatMoney(50_000_000, { compact: true }));
    expect(formatMoneyNeverZero(123_456_789)).toBe('$1.2k');
  });
});
