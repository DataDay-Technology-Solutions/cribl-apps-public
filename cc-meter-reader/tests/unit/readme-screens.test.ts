// tests/unit/readme-screens.test.ts — the README's "What it does → Screens" names what shipped, in the words the
// App shows (W3-DOCS-1). The README is also the Marketplace overview inside every package (scripts/package.mjs
// packagedReadme), so a judge reads these bullets before opening the App. Every label the bullets quote in bold
// is held to src/copy/en.ts (a renamed control fails here until the README follows it), and every URL parameter
// they name is held to the code that reads it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '../../src/copy/en.ts';
import { parseCompareParam } from '../../core/range.ts';
import { hrefWithStickyParams } from '../../src/lib/params.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/** The Screens list: from "**Screens**" to the next bold block ("**Alerts**"), on one line per paragraph. */
function screensSection(): string {
  const readme = read('README.md');
  const from = readme.indexOf('**Screens**');
  const to = readme.indexOf('**Alerts**', from);
  expect(from, 'README keeps its **Screens** list').toBeGreaterThanOrEqual(0);
  expect(to, 'README keeps its **Alerts** block after Screens').toBeGreaterThan(from);
  return readme.slice(from, to);
}

/** "Price history ({n})" → "Price history": a label's text before its first placeholder. */
const bare = (s: string): string => s.replace(/\s*\(?\{[^}]+\}\)?/g, '').trim();

describe('README Screens names the wave-2 features in the words the App shows (W3-DOCS-1)', () => {
  const screens = screensSection();

  // [what the README quotes in bold, the en.ts string the control or heading renders]
  const LABELS: readonly (readonly [string, string])[] = [
    // Receipt (src/views/Receipt/HeroCard.tsx, Sections.tsx; src/components/DestinationStatement)
    ['at your contract rates', en.receiptView.priceBasis.contract],
    ['at typical list prices', en.receiptView.priceBasis.preset],
    ['This week so far', en.receiptView.week.title],
    ['Compare with', en.meter.range.compare.label],
    ['What moved', en.meter.range.compare.movers],
    ['Settings → Cribl cost', `Settings → ${en.settings.groups.criblCost}`],
    // Presenter (src/views/Presenter/index.tsx session line; src/components/IncidentTakeover lost counter)
    ['Saved since you started watching', en.presenter.session.label],
    ['Lost since the deploy', en.incidents.lostSinceDeploy],
    // Flow (src/components/FlowDiagram/FlowMap.tsx, FlowDiagram.tsx; src/views/Flow/FlowScreen.tsx)
    ['Width: Dollars | Bytes', `${en.flow.weight.label}: ${en.flow.weight.dollars} | ${en.flow.weight.bytes}`],
    ['Present', en.flow.stage.enter],
    ['Removed by Cribl', en.flow.sink.name],
    // What if (src/components/WhatIf/Unclaimed.tsx)
    ['Biggest unclaimed savings', en.whatif.unclaimed.title],
    // Ledger (src/components/ChangeTimeline/ChangesList.tsx)
    ['Changes', en.ledger.timeline.changes.title],
    // Settings (src/components/PriceTable)
    ['Price history', bare(en.settings.prices.historyToggle)],
    ['Sweep now', en.palette.sweepNow],
  ];

  it.each(LABELS)('quotes "%s" as the App renders it', (quoted, rendered) => {
    expect(rendered, `en.ts no longer says "${quoted}": update the README with it`).toBe(quoted);
    // Bold and whole: "**Present**", never the "**Present" of "**Presenter**"; a menu item may end in "…".
    const escaped = quoted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(screens, `README Screens does not name "${quoted}"`).toMatch(new RegExp(`\\*\\*${escaped}…?\\*\\*`));
  });

  it('names the statement, the savings goal and the price-basis chip on the Receipt', () => {
    expect(en.receiptView.statement.title).toMatch(/statement$/);
    expect(screens).toContain('opens its **statement**');
    expect(en.settings.cost.fieldGoal).toBe('Savings goal');
    expect(screens).toMatch(/savings goal \(\*\*Settings → Cribl cost\*\*\)/);
  });

  it('names the URL parameters the code reads', () => {
    // ?vs= (core/range.ts parseCompareParam) follows the range from tab to tab (src/lib/params.ts STICKY_PARAMS).
    expect(parseCompareParam('prev')).toEqual({ kind: 'prev' });
    expect(parseCompareParam('week')).toEqual({ kind: 'week' });
    expect(parseCompareParam('9b1c2f3')).toEqual({ kind: 'commit', hash: '9b1c2f3' });
    expect(screens).toContain('`?vs=`');
    // ?weight=bytes and ?stage=1 on the Flow view.
    const flow = read('src/views/Flow/FlowScreen.tsx');
    expect(flow).toContain("search.get('weight') === 'bytes'");
    expect(flow).toContain("search.get('stage') === '1'");
    expect(flow).toContain("useShortcut('F'");
    expect(screens).toContain('`?weight=bytes`');
    expect(screens).toContain('`F`, `?stage=1`');
    // The booth loop: the palette's action and the Shell's booth mode read ?story=1&stage=1.
    expect(read('src/components/common/paletteItems.ts')).toContain("to: '/?story=1&stage=1'");
    expect(read('src/components/Shell/Shell.tsx')).toContain('useBoothMode(params.story && params.stage)');
    expect(screens).toContain('`?story=1&stage=1`');
    // The Ledger sums the Receipt's range.
    expect(hrefWithStickyParams('/ledger', new URLSearchParams('range=7d&vs=prev'))).toBe('/ledger?range=7d&vs=prev');
    expect(screens).toContain('custom range (`?range=`)');
  });

  it('names the keys the views bind: M for the chime, Ctrl+K or ⌘K for the palette', () => {
    expect(read('src/views/Presenter/index.tsx')).toMatch(/useShortcut\(\s*'M'/);
    expect(read('src/components/Shell/useShellEffects.ts')).toContain("(event.metaKey || event.ctrlKey)");
    expect(screens).toContain('`M` turns a chime on or off');
    expect(screens).toContain('`Ctrl+K` or `⌘K` opens a palette');
  });

  it('describes the Flow ribbons as the code sizes them: dollars, with bytes an option', () => {
    // src/components/FlowDiagram/layout.ts bandSlot: √($/day) by default, √(GB/day) only under ?weight=bytes.
    expect(read('src/components/FlowDiagram/layout.ts')).toMatch(/weightBy === 'bytes' \? f\.inBPerDay \/ GB : f\.whpPerDayM \/ DOLLAR_M/);
    expect(screens).not.toMatch(/ribbons sized by volume/);
    expect(screens).toContain('ribbons sized by dollars');
  });
});
