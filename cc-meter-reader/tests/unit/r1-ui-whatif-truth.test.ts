// r1 ui-4 (FOUNDER_PLAN rows 2 + 2b, HUNGER #5): What if tells the truth on any workspace and after a pack-only apply.
//
// Row 2 (A2): an empty "Biggest unclaimed savings" list no longer always says "Every stream here already runs the pack
// written for it." It says why: noneFit (no stream is one the packs are written for: a Datagen → DevNull workspace),
// none (only when every fitting stream runs its pack), noBasis (a fitting stream without its pack has no estimate: no
// similar stream here runs it and the pack publishes no range), or savesMore (the streams a pack fits already save at
// least what it would).
// Row 2b: a route whose pipeline is a Pack that is only part of the treatment (Cribl's Palo Alto Networks pack attached
// alone, `pack:cribl-palo-alto-networks`, against the two-pack "Palo Alto + syslog packs" treatment) runs PART of it;
// the imported `mrd_pan_pack` (the pack's functions behind a syslog header strip) runs all of it.

import { describe, expect, it } from 'vitest';
import type { FlowFigures, Snapshot } from '../../core/types.ts';
import { treatmentRunState, unclaimedEmptyReason, unclaimedSavings } from '../../core/whatif.ts';

const GB = 1_000_000_000;
const SIEM_MC_PER_BYTE = 250_000 / GB;

function fig(p: Partial<FlowFigures> & Pick<FlowFigures, 'inputId' | 'pipelineId'>): FlowFigures {
  const groupId = p.groupId ?? 'default';
  const routeId = p.routeId ?? p.inputId;
  const outputId = p.outputId ?? 'siem';
  const inBPerDay = p.inBPerDay ?? 100 * GB;
  const outBPerDay = p.outBPerDay ?? inBPerDay;
  const whp = Math.round(inBPerDay * SIEM_MC_PER_BYTE);
  const paid = Math.round(outBPerDay * SIEM_MC_PER_BYTE);
  return {
    key: `${groupId}|${p.inputId}|${routeId}|${p.pipelineId}|${outputId}`,
    groupId, inputId: p.inputId, routeId, pipelineId: p.pipelineId, outputId,
    inB: inBPerDay / 1440, outB: outBPerDay / 1440, whpM: 0, paidM: 0, savedM: 0,
    ratio: whp > 0 ? (whp - paid) / whp : 0, ratePerHourM: Math.round(paid / 24),
    savedPerDayM: whp - paid, whpPerDayM: whp, paidPerDayM: paid, inBPerDay, outBPerDay,
    attribution: 'route', sparkline: [], state: 'ok',
  };
}

const snap = (flows: FlowFigures[]): Pick<Snapshot, 'flows'> => ({ flows });

function reasonFor(flows: FlowFigures[]) {
  const list = unclaimedSavings(flows, snap(flows), { groupId: 'default', limit: 5 });
  return { list, reason: unclaimedEmptyReason(flows, snap(flows), { groupId: 'default' }) };
}

describe('row 2 (A2): why the unclaimed list is empty', () => {
  it('noneFit: a Datagen → Drop → DevNull workspace (the clean-install recipe) — no stream is one the packs are written for', () => {
    const { list, reason } = reasonFor([
      fig({ inputId: 'in_datagen_test', routeId: 'route_test', pipelineId: 'drop_half', inBPerDay: 21.6 * GB, outBPerDay: 10.8 * GB, outputId: 'devnull' }),
      fig({ inputId: 'in_syslog', routeId: 'default', pipelineId: 'main', inBPerDay: 5 * GB }),
    ]);
    expect(list).toEqual([]);
    expect(reason).toBe('noneFit');
  });

  it('none: only when every fitting stream already runs its pack (the Palo Alto Networks pack attached alone counts)', () => {
    const { list, reason } = reasonFor([
      fig({ inputId: 'mrd_windows_dc', pipelineId: 'mrd_win_xml_pack', inBPerDay: 150 * GB, outBPerDay: 100 * GB }),
      fig({ inputId: 'mrd_pan_firewall', pipelineId: 'pack:cribl-palo-alto-networks', inBPerDay: 60 * GB, outBPerDay: 40 * GB }),
      fig({ inputId: 'in_datagen_test', pipelineId: 'drop_half', inBPerDay: 10 * GB, outBPerDay: 5 * GB }),
    ]);
    expect(list).toEqual([]);
    expect(reason).toBe('none');
  });

  it('noBasis: a VPC Flow stream without its pack, no similar stream running it, and the VPC pack publishes no range', () => {
    const { list, reason } = reasonFor([
      fig({ inputId: 'aws_vpc_flow', pipelineId: 'passthrough', inBPerDay: 60 * GB }),
      fig({ inputId: 'in_datagen_test', pipelineId: 'drop_half', inBPerDay: 10 * GB, outBPerDay: 5 * GB }),
    ]);
    expect(list).toEqual([]);
    expect(reason).toBe('noBasis');
  });

  it('savesMore: a fitting stream that already saves more than its pack would add', () => {
    const { list, reason } = reasonFor([fig({ inputId: 'dc_windows', pipelineId: 'custom_heavy_trim', inBPerDay: 100 * GB, outBPerDay: 10 * GB })]);
    expect(list).toEqual([]);
    expect(reason).toBe('savesMore');
  });

  it('no reason while the list has a line (the demo rig: a Windows stream on passthrough with a similar stream on the pack)', () => {
    const flows = [
      fig({ inputId: 'mrd_windows_dc', pipelineId: 'mrd_win_xml_pack', inBPerDay: 150 * GB, outBPerDay: 100.5 * GB }),
      fig({ inputId: 'mrd_windows_workstations', pipelineId: 'mrd_passthrough', inBPerDay: 80 * GB }),
    ];
    const { list, reason } = reasonFor(flows);
    expect(list.length).toBeGreaterThan(0);
    expect(reason).toBeUndefined();
  });

  it('an empty workspace (no streams) reads noneFit, never "every stream already runs"', () => {
    expect(unclaimedEmptyReason([], snap([]))).toBe('noneFit');
  });
});

describe('row 2b: a Pack that is only part of the treatment', () => {
  it("pack:cribl-palo-alto-networks runs part of the Palo Alto + syslog packs; mrd_pan_pack runs all of it", () => {
    expect(treatmentRunState('pack:cribl-palo-alto-networks', 'pack-panos')).toEqual({ state: 'part', packId: 'cribl-palo-alto-networks' });
    expect(treatmentRunState('mrd_pan_pack', 'pack-panos')).toEqual({ state: 'all' });
  });

  it('a single-pack treatment attached as a Pack runs all of it; an unrelated pipeline runs none', () => {
    expect(treatmentRunState('pack:cribl-splunk-forwarder-windows-xml-events-to-json', 'pack-windows')).toEqual({ state: 'all' });
    expect(treatmentRunState('mrd_passthrough', 'pack-panos')).toEqual({ state: 'none' });
    expect(treatmentRunState('pack:cribl-palo-alto-networks', 'pack-windows')).toEqual({ state: 'none' });
    expect(treatmentRunState('', 'pack-panos')).toEqual({ state: 'none' });
  });
});
