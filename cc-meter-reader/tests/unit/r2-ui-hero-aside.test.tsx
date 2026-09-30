// @vitest-environment jsdom
// r2 ui-8 (FINDINGS_EXTRA BO-7 residue, major): the hero's aside prints what its meter prints. The aside floored every
// ticking period "as the wheels show them", but a static meter (reduced motion, or a rate of 0) prints its figure through
// fmtDollars, half up: on the demo ledger fixture (mtdM = d30M = 184,352,245 m¢) the hero read $1,844 and the aside
// "Last 30 days $1,843". Now the aside floors only while the meter would tick, and rounds half up when it is static
// (the Annualized variant was fixed on round1, r1 ui-8 m12: staticFigureM).

import { cleanup, render as rtlRender } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings } from '../../core/settings.ts';
import type { HeadlinePeriod } from '../../core/types.ts';
import { AppProviders } from '../../src/state/providers.tsx';
import type { AppServices } from '../../src/state/services.ts';
import { createAppStore } from '../../src/state/store.ts';
import { HeroCard, type HeroCardProps } from '../../src/views/Receipt/HeroCard.tsx';
import { asideWholeM } from '../../src/views/Receipt/model.ts';

function render(ui: ReactElement) {
  const store = createAppStore(defaultSettings('2026-09-28T00:00:00.000Z', 'America/Chicago'));
  const services = { store, actions: {} } as unknown as AppServices;
  return rtlRender(
    <AppProviders services={services}>
      <MemoryRouter>{ui}</MemoryRouter>
    </AppProviders>,
  );
}

afterEach(() => cleanup());

const MTD_M = 184_352_245; // $1,843.52
const ANNUAL_M = 9_556_176_001; // $95,561.76

function heroProps(period: HeadlinePeriod, reducedMotion: boolean, ratePerSecM: number): HeroCardProps {
  const savedM = period === 'annualized' ? ANNUAL_M : MTD_M;
  return {
    period,
    onPeriod: () => undefined,
    figures: { period, savedM, whpM: savedM * 2, paidM: savedM, ratio: 0.5, accrues: period !== 'annualized' },
    meterLabel: 'Saved by Cribl',
    caption: 'month to date',
    sweepAtMs: Date.parse('2026-09-28T12:00:00.000Z'),
    ratePerSecM,
    net: null,
    onShowMath: () => undefined,
    onCopy: () => undefined,
    onApplyRange: () => undefined,
    tz: 'America/Chicago',
    aside: {
      periods: [
        { period: 'mtd', savedM: MTD_M },
        { period: 'today', savedM: 12_345_678 },
        { period: '30d', savedM: MTD_M },
        { period: 'annualized', savedM: ANNUAL_M },
      ],
      perDayNowM: 6_000_000,
    },
    reducedMotion,
  };
}

const heroText = () => (document.querySelector('[data-callout="saved"]')?.textContent ?? '').replace(/\s/g, '');
const asideText = (p: HeadlinePeriod) => (document.querySelector(`[data-testid="hero-aside-${p}"]`)?.textContent ?? '').replace(/\s/g, '');

describe('r2 ui-8: the aside prints what its meter prints (BO-7)', () => {
  it('asideWholeM: floored while the meter would tick, half up when it is static', () => {
    expect(asideWholeM('30d', MTD_M, true)).toBe(184_300_000);
    expect(asideWholeM('30d', MTD_M, false)).toBe(184_400_000);
    // The run rate never ticks: half up either way.
    expect(asideWholeM('annualized', ANNUAL_M, true)).toBe(9_556_200_000);
    expect(asideWholeM('annualized', ANNUAL_M, false)).toBe(9_556_200_000);
  });

  it('reduced motion on month to date: the hero prints $1,844 and so does the aside\'s Last 30 days', () => {
    render(<HeroCard {...heroProps('mtd', true, 1_000)} />);
    expect(heroText()).toContain('$1,844');
    expect(asideText('30d')).toContain('$1,844');
    expect(asideText('annualized')).toContain('$95,562');
  });

  it('a rate of 0 (a static meter without reduced motion): half up too', () => {
    render(<HeroCard {...heroProps('mtd', false, 0)} />);
    expect(asideText('30d')).toContain('$1,844');
  });

  it('ticking (motion allowed, a rate): the aside floors like the wheels ($1,843)', () => {
    render(<HeroCard {...heroProps('mtd', false, 1_000)} />);
    expect(asideText('30d')).toContain('$1,843');
    expect(asideText('annualized')).toContain('$95,562');
  });

  it('the Annualized hero: its figure and the aside elsewhere agree ($95,562)', () => {
    render(<HeroCard {...heroProps('annualized', true, 1_000)} />);
    expect(heroText()).toContain('$95,562');
    expect(asideText('mtd')).toContain('$1,844');
  });
});
