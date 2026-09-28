// The tour fixture (testdata/tour.ts → demo/sample/tour.json): reproducible, under budget, and internally
// consistent — every figure agrees with the core function that is supposed to have produced it.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DeliveryLog, Incident, Snapshot, TourStep } from '../../core/types.ts';
import { canonicalPayload, slackPayload } from '../../core/payloads.ts';
import { buildWeeklyReceipt } from '../../core/receipt.ts';
import { buildFlows } from '../../core/flows.ts';
import { validateSettings } from '../../core/settings.ts';
import { fromIso } from '../../core/time.ts';
import { titleFor } from '../../core/incidents.ts';
import type { TourFixture } from '../../src/tour/types.ts';
import { SAMPLE_WORKSPACE } from '../../src/tour/workspace.ts';
import { presetById } from '../../core/presets.ts';
import {
  ENVELOPE,
  MAX_FIXTURE_BYTES,
  TARGET_IMPACT_M,
  TARGET_MTD_M,
  TOUR_AT,
  TOUR_GROUPS,
  TOUR_JSON_PATH,
  buildTourDoc,
  roundFloats,
  serializeTour,
  type BuiltTour,
} from '../../testdata/tour.ts';

let built: BuiltTour;
let doc: TourFixture;
let committed: string;

const $ = (m: number) => m / 100_000;
const steps = (action: TourStep['action']) => doc.script.filter((s) => s.action === action);
const snapshots = (): Snapshot[] => [doc.snapshot, ...steps('snapshot').map((s) => s.payload as Snapshot)];

beforeAll(() => {
  built = buildTourDoc();
  doc = built.doc;
  committed = readFileSync(resolve(__dirname, '../..', TOUR_JSON_PATH), 'utf8');
});

describe('tour fixture: reproducible and within budget', () => {
  it('the committed demo/sample/tour.json is exactly what the generator builds (run scripts/build-fixtures.ts)', () => {
    expect(committed).toBe(serializeTour(doc));
  });

  it('is deterministic', () => {
    expect(serializeTour(buildTourDoc().doc)).toBe(serializeTour(doc));
  });

  it('stays under 400 KB', () => {
    expect(Buffer.byteLength(committed, 'utf8')).toBeLessThan(MAX_FIXTURE_BYTES);
    expect(built.bytes).toBe(Buffer.byteLength(committed, 'utf8'));
  });

  it('matches the SPEC 15 document shape', () => {
    expect(doc.schemaVersion).toBe(1);
    expect(doc.source).toBe('tour');
    for (const key of ['settings', 'prices', 'snapshot', 'incidents', 'timeline', 'notifyLog', 'script', 'slackMessage', 'weeklyReceipt'] as const) {
      expect(doc[key], key).toBeDefined();
    }
    expect(doc.anchor).toBe(doc.snapshot.sweepAt);
    expect(Object.keys(doc.roll.day).length).toBe(doc.snapshot.flows.length);
  });
});

describe('tour fixture: an enterprise workspace', () => {
  it('has 40 sources in three worker groups, eight destinations and 30 days of history', () => {
    const groups = doc.inventory.byGroup;
    expect(Object.keys(groups)).toEqual([...TOUR_GROUPS]);
    expect(Object.values(groups).flatMap((g) => g.inputs)).toHaveLength(40);
    const outputs = Object.values(groups)
      .flatMap((g) => g.outputs)
      .filter((o) => o.type !== 'default')
      .map((o) => o.type)
      .sort();
    expect(outputs).toEqual(['cribl_lake', 'datadog', 'elastic', 'google_chronicle', 'newrelic', 's3', 'sentinel', 'splunk_hec']);
    expect(doc.workspace).toEqual({ name: 'sample-enterprise', sources: 40, destinations: 8, historyDays: 30 });
    expect(SAMPLE_WORKSPACE).toEqual(doc.workspace); // the first-run caption's copy of these facts
    expect(doc.snapshot.trend).toHaveLength(30);
    expect(doc.snapshot.headline.annualizedFromDays).toBe(30);
  });

  it("prices every destination at its preset's typical list price (core/presets.ts)", () => {
    const entries = Object.entries(doc.prices.versions[0].byOutputId);
    expect(entries).toHaveLength(8);
    for (const [key, e] of entries) expect(e.milliCentsPerGb, key).toBe(presetById(e.preset)!.milliCentsPerGb);
    // Diverted data is credited at the price of where it would have gone.
    expect(doc.prices.versions[0].byOutputId['datacenter:cribl_lake'].counterfactual).toEqual({ kind: 'other', outputId: 'splunk_cloud' });
  });

  it('is enterprise scale: ≈ 30 TB a day, $60–90k a day would-have-paid, $7–10M a year saved', () => {
    for (const k of Object.keys(ENVELOPE) as (keyof typeof ENVELOPE)[]) {
      expect(built.envelope[k], k).toBeGreaterThanOrEqual(ENVELOPE[k][0]);
      expect(built.envelope[k], k).toBeLessThanOrEqual(ENVELOPE[k][1]);
    }
    const h = doc.snapshot.headline;
    expect($(h.annualizedM)).toBe(built.envelope.annualizedUsd);
    // The trend's 30 days would-have-paid agrees with the envelope's daily figure (within the calendar's weekend mix).
    const whp30PerDay = $(h.whp30dM) / 30;
    expect(whp30PerDay / built.envelope.whpPerDayUsd).toBeGreaterThan(0.9);
    expect(whp30PerDay / built.envelope.whpPerDayUsd).toBeLessThan(1.1);
  });

  it('saves its month-to-date target, about a third of what it would have paid, and pays back its Cribl cost', () => {
    const h = doc.snapshot.headline;
    expect(Math.abs(h.mtdM - TARGET_MTD_M)).toBeLessThanOrEqual(TARGET_MTD_M * 0.01);
    expect(h.ratioMtd).toBeGreaterThan(0.25);
    expect(h.ratioMtd).toBeLessThan(0.5);
    expect(h.whpMtdM - h.paidMtdM).toBe(h.mtdM);
    expect(h.paybackX).toBeGreaterThan(1);
    expect(h.netMtdM).toBeLessThan(h.mtdM);
    // The Cribl cost is sized from the estate's own volume at the hybrid-worker credit rate (0.26 / GB).
    const costPerDayUsd = (doc.settings.criblCostCentsPerMonth! / 100) * (12 / 365);
    expect(costPerDayUsd / (built.envelope.tbPerDay * 1000 * 0.26)).toBeGreaterThan(0.97);
    expect(costPerDayUsd / (built.envelope.tbPerDay * 1000 * 0.26)).toBeLessThan(1.03);
  });

  it('the flows are exactly what buildFlows derives from the inventory', () => {
    const flows = buildFlows(doc.inventory, doc.settings).map((f) => f.key).sort();
    expect(doc.snapshot.flows.map((f) => f.key).sort()).toEqual(flows);
  });

  it('every destination is priced, and the month-to-date per destination sums to the headline', () => {
    for (const s of snapshots()) {
      expect(s.unpricedOutputIds).toEqual([]);
      expect(s.destinations.reduce((a, d) => a + d.mtdSavedM, 0)).toBe(s.headline.mtdM);
      expect(s.destinations.reduce((a, d) => a + d.mtdPaidM, 0)).toBe(s.headline.paidMtdM);
    }
  });

  it('budgets sit under the warning threshold', () => {
    for (const d of doc.snapshot.destinations) if (d.budget) expect(d.budget.pct).toBeLessThan(90);
  });

  it('its settings are valid and name every id the dictionary would mangle', () => {
    expect(validateSettings(doc.settings)).toEqual({ ok: true, errors: [] });
    expect(doc.snapshot.topSavers.map((s) => s.label)).not.toContainEqual(expect.stringMatching(/_/));
    expect(doc.settings.humanize.splunk_cloud).toBe('Splunk Cloud');
  });

  it('the headline only moves forward through the script', () => {
    const mtd = snapshots().map((s) => s.headline.mtdM);
    for (let i = 1; i < mtd.length; i++) expect(mtd[i]).toBeGreaterThanOrEqual(mtd[i - 1]);
  });

  it('floats are rounded to 4 decimals and money stays integer', () => {
    expect(roundFloats(doc.snapshot)).toEqual(doc.snapshot);
    for (const f of doc.snapshot.flows) {
      for (const k of ['whpM', 'paidM', 'savedM', 'savedPerDayM', 'whpPerDayM', 'paidPerDayM'] as const) expect(Number.isInteger(f[k])).toBe(true);
    }
  });
});

describe('tour fixture: the script (SPEC 15)', () => {
  it('plays the beats at 25, 31, 70, 110 and 130 seconds', () => {
    const at = (a: TourStep['action']) => steps(a).map((s) => s.at);
    expect(at('incident.open')).toEqual([TOUR_AT.regression, TOUR_AT.spike]);
    expect(at('incident.close')).toEqual([TOUR_AT.recovery]);
    expect(at('delivery')[0]).toBe(TOUR_AT.regressionDelivery);
    expect(at('caption')).toEqual([TOUR_AT.weeklyReceipt]);
    expect([TOUR_AT.regression, TOUR_AT.regressionDelivery, TOUR_AT.spike, TOUR_AT.recovery, TOUR_AT.weeklyReceipt]).toEqual([25, 31, 70, 110, 130]);
    expect(doc.durationSec).toBeGreaterThan(130);
  });

  it('the regression names the commit that caused it, caught in 2:51, ≈ $1,250 a day on a Splunk-bound flow', () => {
    const reg = steps('incident.open')[0].payload as Incident;
    expect(reg.type).toBe('regression');
    expect(reg.severity).toBe('high');
    expect(reg.cause).toBe('commit');
    expect(reg.label).toBe('Payments API sampling');
    expect(titleFor(reg)).toBe('Savings dropped: Payments API sampling');
    expect(reg.caughtInSec).toBe(171);
    expect(Math.abs(reg.impactPerDayM - TARGET_IMPACT_M)).toBeLessThanOrEqual(TARGET_IMPACT_M * 0.01);
    expect(reg.before).toBeCloseTo(0.75, 2);
    expect(reg.after).toBeCloseTo(0.5, 1);
    // 25 points of a flow worth $4–6k a day at the time it breaks.
    const flowWhpPerDay = $(reg.impactPerDayM) / (reg.before - reg.after);
    expect(flowWhpPerDay).toBeGreaterThan(4_000);
    expect(flowWhpPerDay).toBeLessThan(6_000);
    expect(reg.outputId).toBe('splunk_cloud');
    expect(reg.objectKey).toBe('route:datacenter:r_payments');
    const commit = doc.timeline.find((c) => c.hash === reg.commit?.hash);
    expect(commit?.groupId).toBe('datacenter');
    expect(commit?.files.some((f) => f.includes('groups/datacenter/') && f.includes('pipelines/pay_api_sample/'))).toBe(true);
    // Consistent in time: deployed 171 s before the alert, which opens 25 s after the anchor.
    expect(fromIso(reg.openedAt) - fromIso(commit!.deployedAt!)).toBe(171_000);
    expect(fromIso(reg.openedAt) - fromIso(doc.anchor)).toBe(25_000);
  });

  it('its Slack delivery lands 6 s after the alert, and the spike and recovery follow', () => {
    const [regDelivery] = steps('delivery').map((s) => s.payload as DeliveryLog);
    const reg = steps('incident.open')[0].payload as Incident;
    expect(regDelivery).toMatchObject({ event: 'incident.opened', incidentId: reg.id, status: 200 });
    expect(fromIso(regDelivery.at) - fromIso(reg.openedAt)).toBe(6_000);
    const spike = steps('incident.open')[1].payload as Incident;
    expect(spike).toMatchObject({ type: 'spike', label: 'Kubernetes prod', cause: 'unknown' });
    const closed = steps('incident.close')[0].payload as Incident;
    expect(closed.id).toBe(reg.id);
    expect(closed.closedAt).toBeDefined();
    // D47: the close keeps the drop and adds where it recovered to.
    expect(closed.after).toBeCloseTo(reg.after, 4);
    expect(closed.recoveredTo).toBeCloseTo(0.75, 2);
  });

  it('each scripted snapshot carries the incidents open at its time', () => {
    expect(snapshots().map((s) => s.openIncidents)).toEqual([0, 1, 2, 1]);
    const regFlow = (s: Snapshot) => s.flows.find((f) => f.routeId === 'r_payments')!;
    expect(snapshots().map((s) => regFlow(s).state)).toEqual(['ok', 'regression', 'regression', 'ok']);
    expect(snapshots().every((s) => s.mode === 'sample')).toBe(true);
  });

  it('the virtual clock never runs more than 60 s ahead of the tour clock', () => {
    const anchor = fromIso(doc.anchor);
    for (const s of doc.script) {
      const p = s.payload as { sweepAt?: string; at?: string; openedAt?: string; closedAt?: string; committedAt?: string };
      const t = p.sweepAt ?? p.closedAt ?? p.at ?? p.openedAt ?? p.committedAt;
      if (!t) continue;
      const lead = fromIso(t) - (anchor + s.at * 1000);
      expect(lead, `${s.action} at ${s.at}`).toBeLessThanOrEqual(60_000);
      expect(lead, `${s.action} at ${s.at}`).toBeGreaterThanOrEqual(-60_000);
    }
  });
});

describe('tour fixture: every derived artefact equals its core function', () => {
  it('the Slack message is slackPayload(canonicalPayload(the regression))', () => {
    const reg = steps('incident.open')[0].payload as Incident;
    const delivery = steps('delivery')[0].payload as DeliveryLog;
    const expected = slackPayload(
      canonicalPayload('incident.opened', { incident: reg, workspace: 'sample-enterprise', linkBase: '', labels: doc.settings.humanize, sentAt: delivery.at }),
      { tz: doc.timezone, labels: doc.settings.humanize },
    );
    expect(doc.slackMessage).toEqual(expected);
    expect(JSON.stringify(doc.slackMessage)).toContain('caught in 2:51');
  });

  it('the weekly receipt is buildWeeklyReceipt over the fixture’s own day rows', () => {
    const r = doc.weeklyReceipt!;
    const spike = steps('incident.open')[1].payload as Incident;
    const again = roundFloats(
      buildWeeklyReceipt({
        periodStartMs: fromIso(r.periodStart),
        periodEndMs: fromIso(r.periodEnd),
        tz: doc.timezone,
        rowsByFlow: doc.roll.day,
        labels: doc.settings.humanize,
        openIncidents: [spike],
      }),
    );
    expect(again).toEqual(r);
    expect(r.lines.length).toBe(5);
    expect(r.openIncidents).toEqual([{ title: 'Cost spike: Kubernetes prod' }]);
  });

  it('the notify log holds only deliveries that happened before the tour starts', () => {
    const anchor = fromIso(doc.anchor);
    expect(doc.notifyLog.length).toBeGreaterThan(0);
    for (const d of doc.notifyLog) expect(fromIso(d.at)).toBeLessThanOrEqual(anchor);
  });
});
