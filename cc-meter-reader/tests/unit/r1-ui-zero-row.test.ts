// r1 ui-11, FOUNDER_PLAN row 14: the mixed $0 case names the $0 destinations the pipelines reduce into.
import { describe, expect, it } from 'vitest';
import type { DestinationFigures, FlowFigures, Snapshot } from '../../core/types.ts';
import { zeroPricedReducers } from '../../src/state/selectors.ts';

const GB = 1e9;
const flow = (p: Partial<FlowFigures>): FlowFigures => ({ groupId: 'default', inputId: 'in', routeId: 'r', pipelineId: 'p', outputId: 'devnull', inBPerDay: 0, outBPerDay: 0, savedPerDayM: 0, ...p }) as FlowFigures;
const dest = (p: Partial<DestinationFigures>): DestinationFigures => ({ groupId: 'default', outputId: 'devnull', type: 'devnull', milliCentsPerGb: 0, unpriced: false, ...p }) as DestinationFigures;
const snap = (flows: FlowFigures[], destinations: DestinationFigures[], mtdM = 0): Snapshot => ({ flows, destinations, headline: { mtdM } }) as unknown as Snapshot;

describe('zeroPricedReducers (row 14)', () => {
  const reducing = flow({ outputId: 'devnull', inBPerDay: 43 * GB, outBPerDay: 21.5 * GB });
  const passthrough = flow({ inputId: 'fw', outputId: 'splunk_siem', inBPerDay: 29 * GB, outBPerDay: 29 * GB });
  const priced = dest({ outputId: 'splunk_siem', type: 'splunk_hec', milliCentsPerGb: 225_000 });

  it('names a $0 destination a pipeline reduces into, when nothing is saved and another destination has a price', () => {
    expect(zeroPricedReducers(snap([reducing, passthrough], [dest({}), priced]))).toEqual(['DevNull']);
  });

  it('says nothing when something is saved, when every price is $0, or when no pipeline reduces into the $0 destination', () => {
    expect(zeroPricedReducers(snap([reducing, { ...passthrough, savedPerDayM: 5 }], [dest({}), priced]))).toEqual([]);
    expect(zeroPricedReducers(snap([reducing, passthrough], [dest({}), priced], 1))).toEqual([]);
    expect(zeroPricedReducers(snap([reducing], [dest({})]))).toEqual([]);
    expect(zeroPricedReducers(snap([flow({ inBPerDay: 10 * GB, outBPerDay: 10 * GB }), passthrough], [dest({}), priced]))).toEqual([]);
    expect(zeroPricedReducers(null)).toEqual([]);
  });

  it('an unpriced destination is not "$0": it has its own unpriced notice', () => {
    expect(zeroPricedReducers(snap([reducing, passthrough], [dest({ unpriced: true }), priced]))).toEqual([]);
  });
});
