// @vitest-environment jsdom
// r2 ui-11 (FINDINGS_R2 #13 + #14, FINDINGS_EXTRA BO-16 + IC-14 residue): the previews print what is delivered, and the
// tour's words match what the release does.
//   • #13 / BO-16: Settings' "What the target receives" and the tour's View message called renderAlert without the display
//     zone (its default is UTC): "Opened 8:02 PM UTC" beside a target that receives "4:02 PM" (app-assurance r2/3,
//     preview-vs-sent.txt, zz-r23-tourtext.test.ts).
//   • IC-14 residue: the weekly toast said "Leadership gets this in Slack"; a non-target tour delivery opened a Slack
//     Block Kit card. The release hands plain text to Cribl (D57): the tour says so.
//   • #14: the "Caught in" clock counted past the measured catch while the delivery was owed (2:51 → 2:57), then
//     snapped back to 2:51; once caughtInSec is known it is the figure, still.

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderAlert } from '../../core/delivery.ts';
import { testPayload } from '../../core/payloads.ts';
import type { DeliveryLog, Incident } from '../../core/types.ts';
import { en } from '../../src/copy/en.ts';
import { caughtState } from '../../src/components/IncidentCard/model.ts';
import { testTargetText } from '../../src/components/EndpointEditor/model.ts';
import { formatTimeOfDay } from '../../src/lib/format.ts';
import { targetTextFor } from '../../src/tour/narration.ts';
import { TourDialog } from '../../src/tour/TourDialog.tsx';

afterEach(() => cleanup());

const AT = '2026-09-28T20:02:00.000Z';
const ORIGIN = { workspace: 'acme', linkBase: 'https://acme.cribl.cloud/apps/a/meter-reader' };

describe('#13: the target preview is the delivered text, in the display zone', () => {
  for (const tz of ['America/New_York', 'America/Chicago', 'Asia/Kolkata', 'UTC']) {
    it(`Settings' preview in ${tz}`, () => {
      const preview = testTargetText({ ...ORIGIN, nowIso: AT, tz });
      expect(preview).toBe(renderAlert(testPayload(ORIGIN.workspace, AT, ORIGIN.linkBase), tz).text);
      if (tz !== 'UTC') expect(preview).not.toMatch(/\bUTC\b/);
      expect(preview).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    });
  }

  it('the tour\'s View message prints its time in the zone the toast uses', () => {
    const inc = {
      ...(testPayload('x', AT) as unknown as { incident: Incident }).incident,
      id: 'inc_x',
      objectKey: 'pipe:default:p',
      label: 'P',
      openedAt: AT,
      deliveries: [],
      notes: [],
      impactPerDayM: 2_500_000,
      severity: 'high',
      type: 'regression',
    } as unknown as Incident;
    const store = { getState: () => ({ settings: { humanize: {}, displayTimezone: 'America/Chicago' } }) } as never;
    const text = targetTextFor(store, inc, { at: AT, endpointId: 'finops', status: 200, attempt: 1, event: 'incident.opened' } as unknown as DeliveryLog);
    expect(text).toContain(formatTimeOfDay(AT, 'America/Chicago'));
    expect(text).not.toMatch(/\bUTC\b/);
  });
});

describe('IC-14 residue: the tour speaks of Cribl, never Slack', () => {
  it('the weekly toast does not promise Slack', () => {
    expect(en.tour.toast.weeklyBody).not.toMatch(/Slack/);
    expect(en.tour.toast.weeklyBody).toContain('{amount}');
  });

  it('the tour dialog has no Slack card: a delivery reads "Handed to Cribl for …" with the plain text', () => {
    render(<TourDialog content={{ kind: 'target', endpoint: 'FinOps alerts', text: 'Savings dropped: P', time: '3:02 PM' }} onClose={() => undefined} />);
    expect(document.body.textContent).toContain('Handed to Cribl for FinOps alerts');
    expect(document.querySelector('[data-tour-dialog="slack"]')).toBeNull();
    expect(Object.keys(en.tour.dialog)).not.toContain('slackTitle');
  });
});

describe('#14: "Caught in" is the measured catch once it is known', () => {
  const T = Date.parse('2026-09-28T13:04:57.000Z');
  const inc = {
    type: 'regression',
    severity: 'high',
    openedAt: new Date(T).toISOString(),
    caughtInSec: 171,
    commit: { hash: 'a', message: 'm', author: 's', at: new Date(T - 171_000).toISOString() },
  } as unknown as Incident;

  it('holds at 2:51 while the delivery is owed (the live flag says it is on its way), and after it lands', () => {
    for (const dt of [0, 1_000, 3_000, 6_000, 9_000]) {
      const s = caughtState(inc, [], T + dt, true)!;
      expect(s.seconds, `+${dt} ms`).toBe(171);
      expect(s.live).toBe(true);
    }
    expect(caughtState(inc, [{ endpointId: 'x', status: 200, at: new Date(T + 6_000).toISOString() }], T + 9_000, true)).toEqual({ seconds: 171, live: false });
  });
});
