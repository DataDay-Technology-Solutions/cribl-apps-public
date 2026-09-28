// The stage at rest draws the last 30 days of savings as one line (P2-W04). Today is partial, so like the Receipt's
// trend (trendMath completeDays) the line leaves it out: drawn as a whole day it dived at the right edge (review W2).

import { describe, expect, it } from 'vitest';
import { restTrendDays } from '../../src/views/Presenter/trend.ts';
import { trendPaths } from '../../src/views/Presenter/trend.ts';

const day = (d: string, savedM: number) => ({ day: d, savedM, whpM: 0, paidM: 0 });

describe('the stage rest trend', () => {
  const trend = [day('2026-09-24', 2_700_000_000), day('2026-09-25', 2_800_000_000), day('2026-09-26', 2_780_000_000), day('2026-09-27', 120_000_000)];

  it("leaves today's partial day out, in the display zone", () => {
    // 2026-09-27T06:30Z is 1:30 AM on the 27th in Chicago: the 27th is today there.
    const drawn = restTrendDays({ trend, sweepAt: '2026-09-27T06:30:00.000Z' }, 'America/Chicago');
    expect(drawn.map((p) => p.day)).toEqual(['2026-09-24', '2026-09-25', '2026-09-26']);
    // In Tokyo it is already the 28th: the 27th is a completed day.
    expect(restTrendDays({ trend, sweepAt: '2026-09-27T16:00:00.000Z' }, 'Asia/Tokyo')).toHaveLength(4);
    expect(restTrendDays({ trend, sweepAt: 'soon' }, 'America/Chicago')).toHaveLength(4);
  });

  it('so the line ends at a whole day, not at a dive', () => {
    const paths = trendPaths(restTrendDays({ trend, sweepAt: '2026-09-27T06:30:00.000Z' }, 'America/Chicago'))!;
    const lastY = Number(/,([\d.]+)$/.exec(paths.line)?.[1]);
    expect(lastY).toBeLessThan(40); // near the top (max at 90 % of the 200 px height), never near the baseline
  });
});

describe('the stage savers (review W2)', () => {
  it('name the pipeline alone when that tells them apart, else the route it runs on', async () => {
    const { stageSaverLabels } = await import('../../src/views/Presenter/savers.ts');
    const saver = (label: string) => ({ objectKey: label, label, savedPerDayM: 1, ratio: 0.5, groupId: 'g', pipelineId: 'p' });
    expect(
      stageSaverLabels([saver('Windows DC security events · Windows XML pack'), saver('Payments API sampling'), saver('Windows workstation events · Windows XML pack')], {}),
    ).toEqual(['Windows DC security events', 'Payments API sampling', 'Windows workstation events']);
    expect(stageSaverLabels([saver('Windows DC security events · Windows XML pack'), saver('Payments API sampling')], {})).toEqual(['Windows XML pack', 'Payments API sampling']);
  });
});
