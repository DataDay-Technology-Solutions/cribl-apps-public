// @vitest-environment jsdom
// founder-build r3 ui-5 (the r2 carry H9): on a large estate the sweep keeps minute documents for fewer than 25 hours
// (meta.minuteRetentionHours, r1 core-7 / M11), and core's planner plans the minute family only within that retention
// since r2 core-11 (b), but the UI never passed it: the custom range read, the picker's preview and document count, the
// Receipt's comparison plan and its words all planned minute documents that had already expired (holes in the sum).
// The reader now reads meta.minuteRetentionHours through its deps; the picker, the hero and the Receipt pass it.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { planRangeReads, resolveRange, type RangeSpec } from '../../core/range.ts';
import { HOUR_MS, MINUTE_MS, minuteFloor } from '../../core/time.ts';
import { createRangeReader } from '../../src/state/rangeReader.ts';
import type { RollupDocs } from '../../src/state/ports.ts';
import { RangeControl } from '../../src/views/Receipt/RangePicker.tsx';
import { rangePreview } from '../../src/views/Receipt/text.ts';

const NOW = Date.parse('2026-09-28T15:00:20.000Z');
const THROUGH = minuteFloor(NOW) - MINUTE_MS;
const SINCE = NOW - 10 * 86_400_000;

beforeAll(() => {
  window.matchMedia ??= ((query: string) =>
    ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }) as unknown as MediaQueryList);
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => cleanup());

/** A store that answers every document empty and records the keys read. */
function recordingRollups(): RollupDocs & { keys: string[] } {
  const keys: string[] = [];
  const empty = async (key: string): Promise<null> => {
    keys.push(key);
    return null;
  };
  return { keys, readMinute: empty, readHour: empty, readDay: empty } as RollupDocs & { keys: string[] };
}

/** The start of the UTC hour a minute-family key names ('roll/min/2026-09-28T03' → its ms), else undefined. */
function minuteKeyHourMs(key: string): number | undefined {
  const m = /^roll\/min\/(\d{4}-\d{2}-\d{2}T\d{2})$/.exec(key);
  return m ? Date.parse(`${m[1]}:00:00Z`) : undefined;
}

const TWENTY_HOURS: RangeSpec = { kind: 'relative', hours: 20 };

describe('r3 ui-5: the range reader honours meta.minuteRetentionHours', () => {
  it('retention 12 h: no minute-family read older than 12 h', async () => {
    const rollups = recordingRollups();
    const reader = createRangeReader({ rollups, now: () => NOW, minuteRetentionHours: () => 12 });
    const out = await reader.read(TWENTY_HOURS, SINCE, THROUGH);
    expect(out.ok).toBe(true);
    expect(rollups.keys.length).toBeGreaterThan(0);
    for (const key of rollups.keys) {
      const hourMs = minuteKeyHourMs(key);
      if (hourMs !== undefined) expect(hourMs, key).toBeGreaterThanOrEqual(minuteFloor(NOW) - 12 * HOUR_MS);
    }
  });

  it('no retention: exactly today’s plan (the minute family for the ragged edges of a 20 h window)', async () => {
    const rollups = recordingRollups();
    const reader = createRangeReader({ rollups, now: () => NOW });
    await reader.read(TWENTY_HOURS, SINCE, THROUGH);
    const r = resolveRange(TWENTY_HOURS, NOW, SINCE);
    // The plan's documents are read first (an empty coarse bucket is then refined from the finer family).
    const planned = planRangeReads(r.fromMs, r.toMs, NOW, THROUGH).keys;
    expect([...rollups.keys.slice(0, planned.length)].sort()).toEqual([...planned].sort());
    expect(rollups.keys.some((k) => (minuteKeyHourMs(k) ?? Infinity) < NOW - 12 * HOUR_MS)).toBe(true);
  });

  it('a retention of 25 h or more changes nothing', async () => {
    const a = recordingRollups();
    const b = recordingRollups();
    await createRangeReader({ rollups: a, now: () => NOW, minuteRetentionHours: () => 25 }).read(TWENTY_HOURS, SINCE, THROUGH);
    await createRangeReader({ rollups: b, now: () => NOW }).read(TWENTY_HOURS, SINCE, THROUGH);
    expect(a.keys).toEqual(b.keys);
  });
});

describe('r3 ui-5: the Receipt’s words and plans honour it', () => {
  it('rangePreview: a 20 h window is summed in whole hours under a 12 h retention, minute-exact without', () => {
    expect(rangePreview(TWENTY_HOURS, NOW, SINCE, 'UTC').granularity).toBe('minute');
    expect(rangePreview(TWENTY_HOURS, NOW, SINCE, 'UTC', 12).granularity).toBe('hour');
    expect(rangePreview(TWENTY_HOURS, NOW, SINCE, 'UTC', 25).granularity).toBe('minute');
  });
});

describe('r3 ui-5: the picker previews and counts with it', () => {
  async function openCustom(retention?: number): Promise<HTMLElement> {
    render(
      <RangeControl
        period="mtd"
        onPeriod={() => undefined}
        onApplyRange={() => undefined}
        tz="UTC"
        nowMs={NOW}
        collectingSinceMs={SINCE}
        meteredThroughMs={THROUGH}
        {...(retention !== undefined ? { minuteRetentionHours: retention } : {})}
      />,
    );
    const group = screen.getByRole('radiogroup', { name: 'Headline period', hidden: true });
    fireEvent.click(within(group).getByRole('radio', { name: 'Custom', hidden: true }));
    const dialog = await screen.findByRole('dialog', { name: 'Custom range' });
    fireEvent.change(within(dialog).getByLabelText('From') as HTMLInputElement, { target: { value: '2026-09-27T19:00' } });
    fireEvent.change(within(dialog).getByLabelText('To') as HTMLInputElement, { target: { value: '2026-09-28T15:00' } });
    return dialog;
  }

  it('retention 12 h: the 20 h window is summed in whole hours and its note names 11 hours', async () => {
    await openCustom(12);
    expect(screen.getByTestId('range-preview').textContent).toMatch(/^Summed in whole hours as /);
    expect(screen.getByTestId('range-note').textContent).toBe(
      'Times are in UTC. Windows older than 11 hours are summed in whole hours; older than 31 days, in whole UTC days.',
    );
    const r = resolveRange({ kind: 'absolute', fromMs: Date.parse('2026-09-27T19:00Z'), toMs: Date.parse('2026-09-28T15:00Z') }, NOW, SINCE);
    const planned = planRangeReads(r.fromMs, r.toMs, NOW, THROUGH, { minuteRetentionHours: 12 });
    expect(screen.getByTestId('range-reads').textContent).toBe(`Reads ${planned.keys.length} history documents.`);
  });

  it('no retention: minute-exact, as before', async () => {
    await openCustom();
    expect(screen.getByTestId('range-preview').textContent).toMatch(/^Summed minute-exact as /);
    expect(screen.getByTestId('range-note').textContent).toBe(
      'Times are in UTC. Windows older than 24 hours are summed in whole hours; older than 31 days, in whole UTC days.',
    );
  });
});

