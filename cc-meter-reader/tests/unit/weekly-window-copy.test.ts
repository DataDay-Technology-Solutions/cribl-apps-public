// tests/unit/weekly-window-copy.test.ts — the weekly receipt's automatic window, as the App states it (rules round 2).
//
// core/weekly.ts sends last week's receipt the first time the App meters after Monday 12:00 UTC, any day of that week
// (WEEKLY_AUTO_WINDOW_MS), marked late after the first day (WEEKLY_ON_TIME_MS). The Settings copy once said "in the
// 24 hours after Monday 12:00 UTC", the window before D63. No user-facing string may name a one-day window again while
// the code keeps a whole week.

import { describe, expect, it } from 'vitest';
import { DAY_MS } from '../../core/time.ts';
import { WEEKLY_AUTO_WINDOW_MS, WEEKLY_ON_TIME_MS } from '../../core/weekly.ts';
import { en, t } from '../../src/copy/en.ts';

function strings(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(strings);
  if (node && typeof node === 'object') return Object.values(node).flatMap(strings);
  return [];
}

describe('weekly receipt window copy', () => {
  it('matches core/weekly.ts: a whole week, late after the first day', () => {
    expect(WEEKLY_AUTO_WINDOW_MS).toBe(7 * DAY_MS);
    expect(WEEKLY_ON_TIME_MS).toBe(DAY_MS);
  });

  it('no string names a 24-hour window after Monday while the window is a week', () => {
    const oneDay = /24 hours after Monday|in the 24 hours after|before Tuesday 12:00/i;
    const offenders = strings(en).filter((s) => oneDay.test(s));
    expect(offenders).toEqual([]);
  });

  it('the Settings hint and the weekly block say any day that week, and when it is marked late', () => {
    expect(t('settings.notify.weeklyHintUi')).toBe('After Monday 12:00 UTC, any day that week');
    const body = t('settings.notify.weeklyReceipt.bodyUi');
    expect(body).toContain('after Monday 12:00 UTC, any day that week');
    expect(body).toContain('marked late after the first 24 hours');
  });
});
