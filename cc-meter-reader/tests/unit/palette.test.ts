// The ⌘K palette's model (EPIC_AUDIT P2-W22): 'wind' finds the Windows flows; actions carry their key caps;
// levers only in the demo list; matching is ordered and forgiving; sticky params ride along.

import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../../core/types.ts';
import { filterItems, matchScore, paletteItems, withStickyParams } from '../../src/components/common/paletteItems.ts';

const flow = (inputId: string, pipelineId: string, outputId: string) => ({ groupId: 'default', inputId, routeId: `r_${inputId}`, pipelineId, outputId });
const snapshot = {
  flows: [
    flow('mrd_win_dc', 'mrd_win_xml_pack', 'mrd_siem_prod'),
    flow('mrd_win_ws', 'passthru', 'mrd_siem_prod'),
    flow('mrd_pan_fw', 'passthru', 'mrd_siem_prod'),
  ],
} as unknown as Snapshot;

describe('paletteItems', () => {
  it('lists actions with key caps, the pages, and each source, pipeline and destination once', () => {
    const items = paletteItems({ snapshot, labels: { mrd_win_dc: 'Windows DC security events', mrd_win_ws: 'Windows workstation events' } });
    expect(items.find((i) => i.id === 'act:presenter')).toMatchObject({ keyCap: 'P', run: { kind: 'shortcut', key: 'P' } });
    expect(items.find((i) => i.id === 'act:story')?.keyCap).toBe('Y');
    expect(items.filter((i) => i.group === 'goto').map((i) => i.run)).toContainEqual({ kind: 'navigate', to: '/settings/prices' });
    expect(items.filter((i) => i.group === 'sources')).toHaveLength(3);
    expect(items.filter((i) => i.group === 'pipelines')).toHaveLength(2);
    expect(items.filter((i) => i.group === 'destinations')).toHaveLength(1);
    expect(items.some((i) => i.group === 'levers')).toBe(false);
    expect(items.some((i) => i.id === 'act:sweep')).toBe(false);
    const withLevers = paletteItems({ snapshot: null, levers: [{ key: 'B', label: 'Break the trim' }], canSweep: true });
    expect(withLevers.find((i) => i.group === 'levers')).toMatchObject({ keyCap: 'B', run: { kind: 'shortcut', key: 'B' } });
    expect(withLevers.some((i) => i.id === 'act:sweep')).toBe(true);
  });

  it("'wind' puts the Windows flows first, each a deep link to its Ledger row", () => {
    const items = paletteItems({ snapshot, labels: { mrd_win_dc: 'Windows DC security events', mrd_win_ws: 'Windows workstation events' } });
    const found = filterItems(items, 'wind');
    expect(found.slice(0, 3).map((i) => i.label)).toEqual(['Windows DC security events', 'Windows workstation events', 'Windows XML pack']);
    expect(found[0].run).toEqual({ kind: 'navigate', to: '/ledger?object=in%3Adefault%3Amrd_win_dc' });
    expect(filterItems(items, 'zzzz')).toEqual([]);
    expect(filterItems(items, '')).toHaveLength(items.length);
  });
});

describe('matchScore and withStickyParams', () => {
  it('orders prefix > word start > substring > letters in order', () => {
    expect(matchScore('Presenter mode', 'pre')).toBe(100);
    expect(matchScore('Search the Ledger', 'led')).toBe(80);
    expect(matchScore('Passthrough', 'thro')).toBe(60);
    expect(matchScore('Presenter mode', 'pmd')).toBe(20);
    expect(matchScore('Presenter mode', 'x')).toBe(0);
  });

  it('keeps the sticky params and the item’s own query', () => {
    const current = new URLSearchParams('period=30d&object=x&present=1');
    expect(withStickyParams('/ledger', current)).toBe('/ledger?period=30d');
    expect(withStickyParams('/ledger?object=in%3Adefault%3Aa', current)).toBe('/ledger?period=30d&object=in%3Adefault%3Aa');
    expect(withStickyParams('/?story=1&stage=1', new URLSearchParams(''))).toBe('/?story=1&stage=1');
  });
});
