// @vitest-environment jsdom
// The phone's Flow list keeps the open-regression marker the desktop map draws (craft review, round 2): the row of a
// flow with an open alert is outlined in the alert's tone and carries the map plate's words ('−$25 / day since
// 5:01 PM · 2db02e5'), and a small flow with an alert keeps its own row instead of folding into "smaller flows".

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Incident } from '../../core/types.ts';
import { FlowList } from '../../src/components/FlowDiagram/FlowList.tsx';
import { listRows } from '../../src/components/FlowDiagram/listRows.ts';
import { GB, groupSmallFlows, type LayoutFlow } from '../../src/components/FlowDiagram/layout.ts';
import { incidentMarks } from '../../src/components/FlowDiagram/marks.ts';

afterEach(() => cleanup());

function flow(inputId: string, pipelineId: string, outputId: string, inGb: number, outGb: number, mcPerGb = 250_000): LayoutFlow {
  const whp = Math.round(inGb * mcPerGb);
  const paid = Math.round(outGb * mcPerGb);
  return {
    key: `default|${inputId}|${inputId}|${pipelineId}|${outputId}`,
    groupId: 'default',
    inputId,
    routeId: inputId,
    pipelineId,
    outputId,
    inBPerDay: inGb * GB,
    outBPerDay: outGb * GB,
    whpPerDayM: whp,
    paidPerDayM: paid,
    savedPerDayM: whp - paid,
    ratePerHourM: Math.round(paid / 24),
  };
}

const NOW = Date.parse('2026-09-27T22:10:00.000Z');
const FLOWS: LayoutFlow[] = [
  flow('mrd_windows_dc', 'mrd_win_xml_pack', 'mrd_siem_prod', 149.8, 100.3),
  flow('mrd_windows_workstations', 'mrd_passthrough', 'mrd_siem_prod', 79.8, 79.8),
  flow('mrd_payments_api', 'mrd_pay_sample', 'mrd_siem_prod', 40, 30),
  flow('mrd_tiny_a', 'mrd_passthrough', 'mrd_siem_prod', 0.2, 0.2),
  flow('mrd_tiny_b', 'mrd_passthrough', 'mrd_siem_prod', 0.2, 0.2),
];

function regression(objectKey: string, over: Partial<Incident> = {}): Incident {
  return {
    id: `inc-${objectKey}`,
    type: 'regression',
    severity: 'high',
    objectKey,
    label: objectKey,
    openedAt: '2026-09-27T22:01:00.000Z',
    commit: { hash: '2db02e5aa11bb22cc33', author: 'jdoe', message: 'sampling change', committedAt: '2026-09-27T22:00:00.000Z', groupId: 'default', match: 'files' },
    before: 0.75,
    after: 0.25,
    impactPerDayM: 2_500_000,
    notes: [],
    deliveries: [],
    ...over,
  };
}

describe('the phone Flow list marks an open alert', () => {
  it('listRows carries the mark of the flow the alert names; other rows carry none', () => {
    const marks = incidentMarks(FLOWS, [regression('route:default:mrd_payments_api')], NOW, 'UTC');
    const rows = listRows(groupSmallFlows(FLOWS, undefined, Object.keys(marks)).flows, new Map(), undefined, marks);
    const pay = rows.find((r) => r.flow.inputId === 'mrd_payments_api');
    expect(pay?.mark?.tone).toBe('high');
    expect(pay?.mark?.text).toBe('−$25 / day since 10:01 PM · 2db02e5');
    expect(rows.filter((r) => r.mark)).toHaveLength(1);
  });

  it('a small flow with an alert keeps its own row instead of folding', () => {
    const marks = incidentMarks(FLOWS, [regression('route:default:mrd_tiny_a', { impactPerDayM: 10_000 })], NOW, 'UTC');
    const folded = groupSmallFlows(FLOWS, undefined, Object.keys(marks)).flows;
    const rows = listRows(folded, new Map(), undefined, marks);
    const tiny = rows.find((r) => r.flow.inputId === 'mrd_tiny_a');
    expect(tiny?.mark?.tone).toBe('high');
    // without the keep, it would have folded with its neighbour
    expect(groupSmallFlows(FLOWS).flows.some((f) => f.inputId === 'mrd_tiny_a')).toBe(false);
  });

  it('the row is outlined in the tone and shows the plate words', () => {
    const marks = incidentMarks(FLOWS, [regression('route:default:mrd_payments_api', { severity: 'medium' })], NOW, 'UTC');
    const rows = listRows(FLOWS, new Map(), undefined, marks);
    render(<FlowList rows={rows} groupId="default" selectedId={null} onSelect={() => undefined} />);
    const line = screen.getByTestId('flow-list-incident');
    expect(line.textContent).toBe('−$25 / day since 10:01 PM · 2db02e5');
    const row = line.closest('button')!;
    expect(row.className).toContain('is-incident--medium');
    expect(row.getAttribute('data-incident')).toBe('medium');
    expect(screen.getAllByTestId('flow-list-incident')).toHaveLength(1);
  });
});
