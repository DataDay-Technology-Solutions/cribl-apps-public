// Presenter pieces around the incident takeover: the stage's figure (which period, which size), the words
// under the hero (REVIEW-3a #12), the QR path (qrcode encoder → one SVG path) and the demo scene
// indicator's sentence.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DemoState, Headline } from '../../core/types.ts';
import { MIN_FIGURE_CHARS, figureBudget, periodFigure } from '../../src/views/Presenter/heroValue.ts';
import { annualizedBasis, periodBasis } from '../../src/views/Presenter/basis.ts';
import { displayUrl, qrPath } from '../../src/components/QrBlock/qrPath.ts';

const MC = 100_000;
const HEADLINE = {
  todayM: 1 * MC,
  mtdM: 2 * MC,
  d30M: 3 * MC,
  annualizedM: 4 * MC,
} as Headline;

describe('the stage figure', () => {
  it('picks the period figure; only running totals accrue', () => {
    expect(periodFigure(HEADLINE, 'today')).toEqual({
      valueM: 1 * MC,
      accrue: true,
    });
    expect(periodFigure(HEADLINE, 'mtd')).toEqual({
      valueM: 2 * MC,
      accrue: true,
    });
    expect(periodFigure(HEADLINE, '30d')).toEqual({
      valueM: 3 * MC,
      accrue: true,
    });
    expect(periodFigure(HEADLINE, 'annualized')).toEqual({
      valueM: 4 * MC,
      accrue: false,
    });
    expect(periodFigure(null, 'mtd')).toEqual({ valueM: 0, accrue: false });
  });

  // The stage's ticking, easing and holding are the shared Meter's since P0-16 (tests/unit/meter-math.test.ts).

  it('sizes the figure for at least $1,000,000, or the widest period figure (P1-B03)', () => {
    expect(MIN_FIGURE_CHARS).toBe(10);
    expect(figureBudget(null)).toBe(10);
    // $290,905 and $1,286,345 share one size: both fit the ten-character budget.
    expect(figureBudget({ ...HEADLINE, annualizedM: 290_905 * MC } as Headline)).toBe(10);
    expect(figureBudget({ ...HEADLINE, annualizedM: 1_286_345 * MC } as Headline)).toBe(10);
    // A figure past $10M widens the budget for every period, so switching periods never resizes the hero.
    expect(figureBudget({ ...HEADLINE, annualizedM: 12_345_678 * MC } as Headline)).toBe(11);
    expect(figureBudget({ ...HEADLINE, d30M: 123_456_789 * MC, annualizedM: Number.NaN } as Headline)).toBe(12);
  });
});

describe('hero basis caption (REVIEW-3a #12)', () => {
  it('tests the raw day count: a whole day or more names days, less names hours, under an hour minutes', () => {
    expect(annualizedBasis(5)).toBe('annualized run rate, from the last 5 days');
    expect(annualizedBasis(1)).toBe('annualized run rate, from the last 1 day');
    expect(annualizedBasis(1.6)).toBe('annualized run rate, from the last 2 days');
    // 12–24 h of partial data used to round to "1 day" before the ≥ 1 test.
    expect(annualizedBasis(0.5)).toBe('annualized run rate, from the last 12 hours');
    expect(annualizedBasis(0.97)).toBe('annualized run rate, from the last 23 hours');
    expect(annualizedBasis(5 / 24)).toBe('annualized run rate, from the last 5 hours');
    expect(annualizedBasis(1 / 24)).toBe('annualized run rate, from the last 1 hour');
    expect(annualizedBasis(10 / 1440)).toBe('annualized run rate, from the last 10 minutes');
    expect(annualizedBasis(1 / 1440)).toBe('annualized run rate, from the last 1 minute');
    // Nothing metered, or garbage: the honest "today so far".
    for (const v of [0, -1, Number.NaN, undefined, null]) expect(annualizedBasis(v)).toBe('annualized run rate, from today so far');
  });

  it('names the running-total periods', () => {
    const h = { annualizedFromDays: 3 } as Headline;
    expect(periodBasis('annualized', h)).toBe('annualized run rate, from the last 3 days');
    expect(periodBasis('annualized', null)).toBe('annualized run rate, from today so far');
    expect(periodBasis('mtd', h)).toBe('month to date');
    expect(periodBasis('today', h)).toBe('today');
    expect(periodBasis('30d', h)).toBe('last 30 days');
  });
});

describe('qrPath', () => {
  it('encodes the repo URL as one path of module rectangles with a quiet zone', () => {
    const qr = qrPath('https://github.com/Cribl-Community/cc-meter-reader');
    const modules = 4 * qr.version + 17;
    expect(qr.size).toBe(modules + 4);
    expect(qr.d.startsWith('M')).toBe(true);
    // Every rectangle sits inside the quiet zone.
    for (const [, x, y] of qr.d.matchAll(/M(\d+) (\d+)/g)) {
      expect(Number(x)).toBeGreaterThanOrEqual(2);
      expect(Number(y)).toBeGreaterThanOrEqual(2);
      expect(Number(y)).toBeLessThan(modules + 2);
    }
    // The three finder patterns: the top-left one is a 7-module run on its first row.
    expect(qr.d).toContain('M2 2h7v1h-7z');
    expect(qrPath('https://github.com/Cribl-Community/cc-meter-reader').d).toBe(qr.d); // deterministic
  });

  it('never throws on an empty URL and prints a short address', () => {
    expect(qrPath('').d.length).toBeGreaterThan(0);
    expect(displayUrl('https://github.com/Cribl-Community/cc-meter-reader/')).toBe('github.com/Cribl-Community/cc-meter-reader');
    expect(displayUrl('HTTP://x.io')).toBe('x.io');
  });
});

describe('scene indicator (demo build copy)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('counts down to the expected alert, then says it is due; names unknown scenes', async () => {
    vi.stubEnv('VITE_MR_BUILD', 'demo');
    vi.resetModules();
    const { sceneText } = await import('../../src/components/SceneIndicator/sceneText.ts');
    type Scene = NonNullable<DemoState['scene']>;
    const now = Date.parse('2026-09-30T16:40:00.000Z');
    const scene: Scene = {
      name: 'regression',
      step: 'waiting-incident',
      startedAt: '2026-09-30T16:38:00.000Z',
      expectedAlertAt: '2026-09-30T16:41:30.000Z',
      changed: { trims: [], rates: [], budgets: [], routes: [] },
    };
    expect(sceneText(scene, now)).toBe('Regression scene · alert expected in ~1:30');
    expect(sceneText(scene, now + 120_000)).toBe('Regression scene · alert due any moment');
    expect(sceneText({ ...scene, name: 'full', expectedAlertAt: undefined, step: 'hold' }, now)).toBe('Full show scene · Hold');
    expect(
      sceneText(
        {
          ...scene,
          name: 'mystery_tour',
          expectedAlertAt: undefined,
          step: 'go',
        },
        now,
      ),
    ).toBe('Mystery tour scene · Go');
  });
});
