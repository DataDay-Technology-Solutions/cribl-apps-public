// tests/unit/readme-alerts-range.test.ts — two README truth gaps from the wave-2 reviews (W3-DOCS-2), held to the
// code that decides them:
//   (a) "Good news (off by default)" was false under the demo profile: core/settings.ts goodNewsActive runs the rule
//       when goodNewsEnabled is on OR demo mode and its profile are, so each pack a lever applies on stage opens a
//       good-news card; the release shows that card only with the switch on (src/components/WhatIf/landing.ts).
//   (b) The Custom range paragraph did not mention Compare with… or ?vs=, which follows ?range= to every tab
//       (src/lib/params.ts STICKY_PARAMS) while only the Receipt reads it (the Ledger and the Report card ignore it).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultSettings, goodNewsActive } from '../../core/settings.ts';
import { effectiveThresholds } from '../../core/detector.ts';
import { COMMIT_COMPARE_MS, parseCompareParam, parseRangeParam, planComparison, WEEK_MS } from '../../core/range.ts';
import { landedAllowed } from '../../src/components/WhatIf/landing.ts';
import { hrefWithStickyParams } from '../../src/lib/params.ts';
import { en } from '../../src/copy/en.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const oneLine = (s: string): string => s.replace(/\s+/g, ' ');
const readme = read('README.md');

/** The README paragraph (one line) that starts with `start`. */
function paragraph(start: string): string {
  const line = readme.split('\n').find((l) => l.startsWith(start));
  expect(line, `README has a paragraph starting "${start}"`).toBeDefined();
  return oneLine(line ?? '');
}

describe('README: good news under the demo profile (W3-DOCS-2a)', () => {
  const base = defaultSettings('2026-09-27T00:00:00.000Z', 'UTC', 'ui');
  const demoProfile = { ...base, goodNewsEnabled: false, demo: { enabled: true, replayMode: false, profile: true } };

  it('the code: off by default, on under the demo profile whatever the switch says, the switch left as stored', () => {
    expect(base.goodNewsEnabled).toBe(false);
    expect(goodNewsActive(base)).toBe(false);
    expect(goodNewsActive(demoProfile)).toBe(true);
    expect(demoProfile.goodNewsEnabled).toBe(false);
    expect(goodNewsActive({ ...demoProfile, demo: { ...demoProfile.demo, profile: false } })).toBe(false);
    // The rule holds for the regression's confirmation: 3 minutes by default, 1 under the demo profile.
    expect(effectiveThresholds(base).regressionMinutes).toBe(3);
    expect(effectiveThresholds(demoProfile).regressionMinutes).toBe(1);
    // The release (this test runs without VITE_MR_BUILD=demo) shows the card only with the switch on.
    expect(landedAllowed(demoProfile)).toBe(false);
    expect(landedAllowed({ ...demoProfile, goodNewsEnabled: true })).toBe(true);
    // Who switches demo mode on: the demo build's Settings → Demo, and the runner's demo-org setup.
    expect(read('src/views/Settings/index.tsx')).toContain("import.meta.env.VITE_MR_BUILD === 'demo' ? lazy(() => import('./DemoSection.tsx'))");
    expect(read('scripts/runner.ts')).toContain('demo: { ...base.demo, enabled: true, profile: true }');
  });

  it('the Alerts table and its paragraph say so', () => {
    const row = readme.split('\n').find((l) => l.startsWith('| Good news'));
    expect(row).toBe(
      '| Good news (off by default; on under the demo profile) | a commit followed by a ratio rise of 15 points held for 3 minutes (1 under the demo profile) | info | "your change is saving $X/day", commit, author |',
    );
    const p = paragraph('Recovery closes an incident by itself');
    expect(p).toContain(`**Settings → ${en.settings.groups.alerts} → ${en.settings.alerts.goodNewsTitle}**`);
    expect(p).toContain(`**Settings → ${en.settings.groups.demo}**`);
    expect(p).toContain('runs the rule whatever that switch says, without changing it');
    expect(p).toContain('the release build puts that card on the presenter view only when the switch is on');
  });
});

describe('README: Compare with… and ?vs= in the Custom range (W3-DOCS-2b)', () => {
  const p = paragraph('**Compare with…** in the same picker');

  it('names the three comparisons as the URL spells them and the picker labels them', () => {
    expect(en.meter.range.compare.label).toBe('Compare with');
    for (const vs of ['prev', 'week']) {
      expect(parseCompareParam(vs)).toEqual({ kind: vs });
      expect(p).toContain(`\`?vs=${vs}\``);
    }
    expect(parseCompareParam('a1f3c9e')).toEqual({ kind: 'commit', hash: 'a1f3c9e' });
    expect(p).toContain('`?vs=<commit hash>`');
    // The week earlier compares windows of 7 days or less; a commit's range is the 24 hours after its deploy.
    expect(en.meter.range.compare.refused.weekTooLong).toBe('A week earlier compares windows of 7 days or less.');
    expect(WEEK_MS).toBe(7 * 24 * 3_600_000);
    const range = parseRangeParam('30d');
    expect(range).toBeDefined();
    if (range) expect(planComparison(range, { kind: 'week' }, { nowMs: Date.UTC(2026, 8, 27, 12) })).toMatchObject({ ok: false, reason: 'week-too-long' });
    expect(p).toContain('(`?vs=week`, for windows of 7 days or less)');
    expect(COMMIT_COMPARE_MS).toBe(24 * 3_600_000);
    expect(p).toContain('the range becoming the 24 hours after its deploy');
    expect(p).toContain(`**${en.meter.range.compare.movers}**`);
  });

  it('?vs= follows ?range= from tab to tab; only the Receipt reads it; a period clears both', () => {
    const here = new URLSearchParams('range=7d&vs=prev&object=x&timeline=7d');
    expect(hrefWithStickyParams('/ledger', here)).toBe('/ledger?range=7d&vs=prev');
    expect(hrefWithStickyParams('/report', here)).toBe('/report?range=7d&vs=prev');
    for (const view of ['src/views/Ledger/index.tsx', 'src/views/Report/index.tsx']) {
      expect(read(view), `${view} reads ?vs=`).not.toMatch(/params\.vs\b|\bvs:/);
    }
    expect(read('src/views/Receipt/index.tsx')).toContain('rangeSpec ? params.vs : undefined');
    expect(read('src/views/Receipt/index.tsx')).toContain('setParams({ period: next, range: undefined, vs: undefined })');
    expect(p).toContain('`?range=` and `?vs=` follow the member from tab to tab: the Ledger sums the range and ignores `vs`, the Report card offers the range as its period and ignores `vs` too');
    expect(p).toContain('Picking a period clears both.');
  });

  it('sits in the money model, right after the Custom range paragraph', () => {
    const custom = readme.indexOf('**Custom range.** The hero');
    const compare = readme.indexOf('**Compare with…** in the same picker');
    expect(custom).toBeGreaterThan(readme.indexOf('## The money model'));
    expect(compare).toBeGreaterThan(custom);
    expect(readme.slice(custom, compare).split('\n\n')).toHaveLength(2);
  });
});
