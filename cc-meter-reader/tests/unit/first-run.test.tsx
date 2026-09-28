// @vitest-environment jsdom
// First run, empty and loading states (EPIC_AUDIT WP-M), as component rules:
//   P1-M01  the empty-state ghosts: the Flow / What-if map outline and the stack of setting cards
//   P1-M02  the tour's status for the main bundle (src/tour/status.ts) and the sticky ?tour=1 param
//   P2-W27  the strip's mount sequence, the card's meter, the stamp band and its beat chip

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fmtDollars } from '../../core/format.ts';
import { defaultSettings } from '../../core/settings.ts';
import tourJson from '../../demo/sample/tour.json';
import { EmptyBlock } from '../../src/components/common/EmptyBlock.tsx';
import { Ghost } from '../../src/components/common/Ghost.tsx';
import { SampleBand } from '../../src/components/common/SampleBand.tsx';
import { HOW_SEQUENCE_STEP_MS, HowItWorks } from '../../src/components/HowItWorks/HowItWorks.tsx';
import { hrefWithStickyParams, patchSearchParams, readAppParams } from '../../src/lib/params.ts';
import { AppProviders } from '../../src/state/providers.tsx';
import type { AppServices } from '../../src/state/services.ts';
import { createAppStore } from '../../src/state/store.ts';
import { beatOf, clearTourStop, getTourBeat, resetTourBeat, setTourBeat, subscribeTourBeat } from '../../src/tour/status.ts';
import { sampleOpeningMtdM } from '../../src/tour/controller.ts';
import type { TourFixture } from '../../src/tour/types.ts';
import { CardMeter } from '../../src/views/FirstRun/CardMeter.tsx';

afterEach(() => {
  cleanup();
  resetTourBeat();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('P1-M01 · every empty state is the ghost of what will fill it', () => {
  it("the Flow map ghost is a Sankey outline (three ribbons between two nodes), never table rows", () => {
    const { container } = render(<EmptyBlock title="Set a price to see dollars on this map" ghost="flow" size="lg" />);
    const ghost = container.querySelector('[data-ghost="flow"][aria-hidden="true"]');
    expect(ghost).not.toBeNull();
    expect(ghost!.querySelectorAll('path.mr-ghost-ribbon')).toHaveLength(3);
    expect(ghost!.querySelectorAll('rect.mr-ghost-node')).toHaveLength(2);
    expect(container.querySelector('[data-ghost="rows"]')).toBeNull();
    expect(container.querySelector('.mr-empty')?.getAttribute('data-empty')).toBe('flow');
  });

  it("the 'card' ghost is two setting cards: a title with badge and switch, a line beside a field, one action", () => {
    const { container } = render(<Ghost shape="card" />);
    const ghost = container.querySelector('[data-ghost="card"]');
    expect(ghost?.getAttribute('aria-hidden')).toBe('true');
    const cards = ghost!.querySelectorAll('.mr-ghost-card');
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.querySelectorAll('.mr-ghost-card-head .mr-ghost-pill')).toHaveLength(1);
      expect(card.querySelectorAll('.mr-ghost-card-head .mr-ghost-switch')).toHaveLength(1);
      expect(card.querySelectorAll('.mr-ghost-card-body .mr-ghost-field')).toHaveLength(1);
      expect(card.querySelectorAll('.mr-ghost-card-foot .mr-ghost-button')).toHaveLength(1);
    }
    // The two titles differ so the stack never looks stamped.
    const titles = [...cards].map((c) => (c.querySelector('.mr-ghost-bar--title') as HTMLElement).style.width);
    expect(new Set(titles).size).toBe(2);
  });

  it("EmptyBlock passes ghost='card' through (Settings → Where to send alerts)", () => {
    const { container } = render(<EmptyBlock title="No endpoints yet" ghost="card" />);
    expect(container.querySelector('.mr-empty [data-ghost="card"]')).not.toBeNull();
  });
});

describe('P1-M02 · the tour lives in the URL, and its status is readable without the tour chunk', () => {
  it('?tour=1 is read as a flag and follows the tabs like the other sticky params', () => {
    expect(readAppParams(new URLSearchParams('tour=1')).tour).toBe(true);
    expect(readAppParams(new URLSearchParams('tour=true')).tour).toBe(true);
    expect(readAppParams(new URLSearchParams('')).tour).toBe(false);
    expect(hrefWithStickyParams('/flow', new URLSearchParams('tour=1&object=x&present=1'))).toBe('/flow?tour=1');
    expect(patchSearchParams(new URLSearchParams('tour=1&period=mtd'), { tour: null }).toString()).toBe('period=mtd');
  });

  it('beats: the start, then one per distinct scripted second already played', () => {
    const seconds = [25, 25, 31, 50, 70, 70, 76, 110, 110, 112, 130];
    expect(beatOf(seconds, 0)).toEqual({ beat: 1, beats: 9 });
    expect(beatOf(seconds, 1)).toEqual({ beat: 2, beats: 9 }); // half of second 25 applied
    expect(beatOf(seconds, 2)).toEqual({ beat: 2, beats: 9 });
    expect(beatOf(seconds, 3)).toEqual({ beat: 3, beats: 9 });
    expect(beatOf(seconds, seconds.length)).toEqual({ beat: 9, beats: 9 });
    expect(beatOf([], 0)).toEqual({ beat: 1, beats: 1 });
  });

  it('the status store notifies on change only, and forgets why the last tour ended on request', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTourBeat(listener);
    setTourBeat({ active: true, phase: 'running', beat: 1, beats: 9 });
    setTourBeat({ active: true, phase: 'running', beat: 1, beats: 9 });
    expect(listener).toHaveBeenCalledTimes(1);
    setTourBeat({ active: false, phase: 'stopped', beat: 0, beats: 0, lastStop: 'cleared' });
    expect(getTourBeat()).toMatchObject({ active: false, lastStop: 'cleared' });
    clearTourStop();
    expect(getTourBeat().lastStop).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
  });
});

/** The steps' data-active values, in order. */
const activeOf = (root: HTMLElement): string[] => [...root.querySelectorAll('li[data-step]')].map((li) => li.getAttribute('data-active') ?? '');
const drawnOf = (root: HTMLElement): string => (root.querySelector('ol') as HTMLElement).style.getPropertyValue('--mr-how-drawn');

describe('P2-W27 · the product explains itself', () => {
  it('the strip lights its steps one by one on mount, 400 ms apart, the hairline drawing ahead of them', () => {
    vi.useFakeTimers();
    const { container } = render(<HowItWorks variant="strip" sequence />);
    expect(activeOf(container)).toEqual(['false', 'false', 'false', 'false']);
    expect(drawnOf(container)).toBe('0');
    expect(container.querySelector('ol')?.getAttribute('data-sequence')).toBe('playing');
    const seen: string[][] = [];
    for (let i = 0; i < 4; i++) {
      act(() => vi.advanceTimersByTime(HOW_SEQUENCE_STEP_MS));
      seen.push(activeOf(container));
    }
    expect(seen).toEqual([
      ['true', 'false', 'false', 'false'],
      ['true', 'true', 'false', 'false'],
      ['true', 'true', 'true', 'false'],
      ['true', 'true', 'true', 'true'],
    ]);
    expect(HOW_SEQUENCE_STEP_MS * 4).toBe(1_600);
    expect(drawnOf(container)).toBe('1');
    expect(container.querySelector('ol')?.getAttribute('data-sequence')).toBe('done');
    act(() => vi.advanceTimersByTime(5_000)); // and it stays put: nothing loops
    expect(activeOf(container)).toEqual(['true', 'true', 'true', 'true']);
  });

  it('under reduced motion every step is lit at once; Story and the static strip never sequence', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
    const reduced = render(<HowItWorks sequence />);
    expect(activeOf(reduced.container)).toEqual(['true', 'true', 'true', 'true']);
    expect(reduced.container.querySelector('ol')?.hasAttribute('data-sequence')).toBe(false);
    cleanup();
    vi.unstubAllGlobals();

    const story = render(<HowItWorks activeStep={1} sequence />);
    expect(activeOf(story.container)).toEqual(['true', 'true', 'false', 'false']);
    expect(Number(drawnOf(story.container))).toBeCloseTo(1 / 3, 5);
    cleanup();
    const plain = render(<HowItWorks />);
    expect(activeOf(plain.container)).toEqual(['true', 'true', 'true', 'true']);
    expect(drawnOf(plain.container)).toBe('1');
  });

  it("the stage variant is the strip at presenter scale, with larger icons", () => {
    const { container } = render(<HowItWorks variant="stage" className="mr-pv-how" />);
    const ol = container.querySelector('ol')!;
    expect(ol.className).toBe('mr-how mr-how--stage mr-pv-how');
    expect(container.querySelectorAll('li[data-step]')).toHaveLength(4);
  });

  it("the card meter idles on dashes and rolls to the sample's month to date (the tour's opening figure)", () => {
    const valueM = (tourJson as unknown as TourFixture).snapshot.headline.mtdM;
    const figure = fmtDollars(valueM);
    expect(figure).toBe('$544,974');
    // Before the tour chunk answers: six dashes, and a roll request changes nothing.
    const pending = render(<CardMeter valueM={null} rolled />);
    expect(pending.container.querySelector('[data-testid="first-run-meter"]')?.getAttribute('data-rolled')).toBe('false');
    expect([...pending.container.querySelectorAll<HTMLElement>('.mr-fr-meter-strip')].map((w) => w.style.getPropertyValue('--mr-fr-cell'))).toEqual(['0', '0', '0', '0', '0', '0']);
    cleanup();

    const idle = render(<CardMeter valueM={valueM} rolled={false} />);
    const wheels = () => [...idle.container.querySelectorAll<HTMLElement>('.mr-fr-meter-strip')];
    expect(wheels()).toHaveLength(6);
    expect(wheels().map((w) => w.style.getPropertyValue('--mr-fr-cell'))).toEqual(['0', '0', '0', '0', '0', '0']);
    expect(idle.container.querySelector('.mr-fr-meter-figure')?.getAttribute('data-value')).toBe('');
    expect(idle.container.querySelector('.mr-fr-meter-figure')?.getAttribute('aria-hidden')).toBe('true');
    expect(idle.container.querySelector('.mr-visually-hidden')?.textContent).toBe('Saved by Cribl: no figure until prices are set.');
    // Never a zero on display: the idle cell is the dash.
    expect(wheels()[0].firstElementChild?.textContent).toBe('–');

    idle.rerender(<CardMeter valueM={valueM} rolled />);
    expect(wheels().map((w) => Number(w.style.getPropertyValue('--mr-fr-cell')) - 1).join('')).toBe('544974');
    // Staggered left to right.
    expect(wheels().map((w) => w.style.getPropertyValue('--mr-fr-delay'))).toEqual(['0ms', '45ms', '90ms', '135ms', '180ms', '225ms']);
    expect(idle.container.querySelector('.mr-fr-meter-figure')?.getAttribute('data-value')).toBe(figure);
    expect(idle.container.querySelector('.mr-fr-meter-caption')?.textContent).toBe('The sample workspace, month to date');
    expect(idle.container.querySelector('.mr-visually-hidden')?.textContent).toBe(`Saved by Cribl in the sample workspace: ${figure} month to date.`);
  });

  it('sampleOpeningMtdM is the month to date the tour opens on: re-summed over the days moved onto the wall clock', () => {
    const doc = tourJson as unknown as TourFixture;
    const anchor = Date.parse(doc.anchor ?? doc.generatedAt);
    const saved = (from: string, to: string) => doc.snapshot.trend.filter((p) => p.day >= from && p.day <= to).reduce((sum, p) => sum + p.savedM, 0);
    // Played at the recording's own moment: the recorded figure.
    expect(sampleOpeningMtdM(anchor, doc)).toBe(doc.snapshot.headline.mtdM);
    // Two days later (Sep 26): the trend moves two days on, so Sep 1–26 holds the recorded Aug 30 – Sep 24.
    expect(sampleOpeningMtdM(anchor + 2 * 86_400_000, doc)).toBe(saved('2026-08-30', '2026-09-24'));
    // On Oct 1 month to date is one day: the recording's last day, moved onto the first.
    expect(sampleOpeningMtdM(anchor + 7 * 86_400_000, doc)).toBe(saved('2026-09-24', '2026-09-24'));
  });

  it('the sample band: a stamp, the note, the full sentence for screen readers, and the tour beat as a visual chip', () => {
    const store = createAppStore(defaultSettings('2026-09-26T00:00:00.000Z', 'UTC'), { source: 'sample' });
    const clearSample = vi.fn();
    const services = { store, actions: { clearSample } } as unknown as AppServices;
    const { container, getByRole } = render(
      <AppProviders services={services}>
        <SampleBand />
      </AppProviders>,
    );
    const band = container.querySelector('[data-callout="sample-band"]')!;
    expect(band.querySelector('.mr-sample-band-cap')?.getAttribute('aria-hidden')).toBe('true');
    expect(band.querySelector('.mr-sample-band-stamp')?.textContent).toBe('Sample data');
    expect(band.querySelector('.mr-sample-band-full')?.textContent).toBe('Sample data. This is how Meter Reader looks once it is metering your traffic.');
    expect(band.querySelector('.mr-sample-band-note')?.textContent).toBe('How Meter Reader looks once it is metering your traffic. Nothing is written to your workspace.');
    // No tour running (Story, or a sample shown some other way): no chip.
    expect(band.querySelector('[data-testid="sample-band-beat"]')).toBeNull();

    act(() => setTourBeat({ active: true, phase: 'running', beat: 3, beats: 9 }));
    const chip = band.querySelector('[data-testid="sample-band-beat"]')!;
    expect(chip.getAttribute('aria-hidden')).toBe('true');
    expect(chip.querySelector('.mr-sample-band-beat-long')?.textContent).toBe('Tour · beat 3 of 9');
    expect(chip.querySelector('.mr-sample-band-beat-short')?.textContent).toBe('3 of 9');

    getByRole('button', { name: 'Clear sample data' }).click();
    expect(clearSample).toHaveBeenCalledTimes(1);

    act(() => store.setState({ source: 'replay' }));
    expect(band.querySelector('.mr-sample-band-stamp')?.textContent).toBe('Replay');
    expect(band.querySelector('[data-testid="sample-band-beat"]')).toBeNull();
    act(() => store.setState({ source: 'live' }));
    expect(container.querySelector('[data-callout="sample-band"]')).toBeNull();
  });
});
