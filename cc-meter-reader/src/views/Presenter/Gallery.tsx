// src/views/Presenter/Gallery.tsx — the incident card family and the Slack message on one page, for the beauty
// grid (PRD 8.8: "the incident card, the Slack message" are scored screens of their own). Reached with
// `/?present=1&gallery=incidents` in DEV / mock builds only — the lazy import is gated inline in index.tsx,
// so no release bundle contains this file. The data below is fixture data, not UI copy.

import { useMemo, useState } from 'react';
import type { Incident, NotificationEndpoint, WeeklyReceipt } from '../../../core/types.ts';
import { canonicalPayload, slackPayload } from '../../../core/payloads.ts';
import { IncidentCard, formatClockTime } from '../../components/IncidentCard/index.ts';
import { SlackPreview } from '../../components/SlackPreview/index.ts';
import { usePresenterTestHook } from './testHook.ts';
import './Gallery.css';

const MC = 100_000;
const TZ = 'America/Chicago';

const ENDPOINTS: NotificationEndpoint[] = [
  {
    id: 'ep_slack',
    name: 'Slack',
    url: 'https://hooks.slack.com/services/T0/B0/abcd',
    host: 'hooks.slack.com',
    format: 'slack',
    minSeverity: 'medium',
    weeklyReceipt: true,
    enabled: true,
  },
  {
    id: 'ep_hook',
    name: 'Ops webhook',
    url: 'https://webhook.site/abcd',
    host: 'webhook.site',
    format: 'generic',
    minSeverity: 'medium',
    weeklyReceipt: false,
    enabled: true,
  },
];

function fixtures(now: number): {
  full: Incident[];
  compact: Incident[];
  receipt: WeeklyReceipt;
} {
  const iso = (deltaSec: number) => new Date(now + deltaSec * 1000).toISOString();
  const regression: Incident = {
    id: 'inc_7f3a01',
    type: 'regression',
    severity: 'high',
    objectKey: 'pipe:default:mrd_pay_sample',
    label: 'Payments API sampling',
    outputId: 'mrd_siem_prod',
    openedAt: iso(-40),
    cause: 'commit',
    commit: {
      hash: 'a1f3c9e5b2',
      message: 'demo: break the trim on mrd_pay_sample',
      author: 's.koelpin',
      committedAt: iso(-219),
      deployedAt: iso(-210),
      groupId: 'default',
      match: 'message',
    },
    before: 0.75,
    after: 0.5,
    impactPerDayM: 25 * MC,
    caughtInSec: 170,
    notes: ['demo-profile'],
    deliveries: [{ endpointId: 'ep_slack', status: 200, at: iso(-38) }],
  };
  const spike: Incident = {
    id: 'inc_51c2aa',
    type: 'spike',
    severity: 'high',
    objectKey: 'in:default:mrd_payments_api',
    label: 'Payments API',
    openedAt: iso(-25),
    cause: 'unknown',
    before: 412 * MC,
    after: 1_904 * MC,
    impactPerDayM: 35_808 * MC,
    caughtInSec: 120,
    notes: [],
    deliveries: [{ endpointId: 'ep_hook', status: 503, at: iso(-20) }],
  };
  const budget: Incident = {
    id: 'inc_b0d9e1',
    type: 'budget',
    severity: 'medium',
    objectKey: 'out:default:mrd_siem_prod',
    label: 'siem-prod',
    outputId: 'mrd_siem_prod',
    openedAt: iso(-3_600),
    cause: 'commit',
    commit: {
      hash: '9be410d77f',
      message: 'raise Windows event volume for the audit',
      author: 'j.alvarez',
      committedAt: iso(-4_200),
      deployedAt: iso(-4_180),
      groupId: 'default',
      match: 'nearby',
    },
    before: 90,
    after: 94.2,
    impactPerDayM: 140 * MC,
    notes: [],
    deliveries: [{ endpointId: 'ep_slack', status: 200, at: iso(-3_590) }],
  };
  // Closed: the drop it kept (75% → 50%) and where it recovered to (D47).
  const recovered: Incident = {
    ...regression,
    id: 'inc_7f3a00',
    openedAt: iso(-7_200),
    closedAt: iso(-6_900),
    recoveredTo: 0.74,
    deliveries: [{ endpointId: 'ep_slack', status: 200, at: iso(-6_899) }],
  };
  // Closed before D47: `after` held the reading at close, so the card shows the recovery alone.
  const legacy: Incident = {
    ...regression,
    id: 'inc_7f3a02',
    openedAt: iso(-10_800),
    closedAt: iso(-10_500),
    after: 0.72,
    deliveries: [{ endpointId: 'ep_slack', status: 200, at: iso(-10_499) }],
  };
  const blocked: Incident = {
    ...spike,
    id: 'inc_51c2ab',
    objectKey: 'in:default:mrd_k8s_prod',
    label: 'Kubernetes prod',
    severity: 'medium',
    openedAt: iso(-900),
    before: 96 * MC,
    after: 188 * MC,
    impactPerDayM: 2_208 * MC,
    deliveries: [
      {
        endpointId: 'ep_hook',
        status: 403,
        at: iso(-898),
        error: 'host_not_authorized',
      },
    ],
  };
  const receipt: WeeklyReceipt = {
    periodStart: '2026-09-21T05:00:00.000Z',
    periodEnd: '2026-09-28T05:00:00.000Z',
    label: 'Sep 21–27, 2026',
    lines: [
      { label: 'Windows event trimming', savedM: 9_380 * MC },
      { label: 'Firewall duplicate suppression', savedM: 6_384 * MC },
      { label: 'Kubernetes noise filter', savedM: 4_480 * MC },
      { label: 'Payments API sampling', savedM: 2_716 * MC },
      { label: 'CDN log aggregation', savedM: 847 * MC },
    ],
    savedM: 23_807 * MC,
    whpM: 39_678 * MC,
    paidM: 15_871 * MC,
    ratio: 0.6,
    priorSavedM: 22_891 * MC,
    trendPct: 4,
    openIncidents: [{ title: 'Savings dropped: Payments API sampling' }],
  };
  return {
    full: [regression, spike, recovered],
    compact: [regression, budget, recovered, blocked, legacy],
    receipt,
  };
}

export default function Gallery() {
  // The spec drives the store here too (the full card's drawn drop reads the snapshot's flows, P2-W15).
  usePresenterTestHook();
  const [now] = useState(() => Date.now());
  const data = useMemo(() => fixtures(now), [now]);
  const linkBase = 'https://example.cribl.cloud/apps/a/meter-reader';
  const incidentMessage = useMemo(
    () =>
      slackPayload(
        canonicalPayload('incident.opened', {
          incident: data.full[0],
          workspace: 'main',
          linkBase,
        }),
        { tz: TZ },
      ),
    [data],
  );
  const receiptMessage = useMemo(
    () =>
      slackPayload(
        canonicalPayload('receipt.weekly', {
          receipt: data.receipt,
          workspace: 'main',
          linkBase,
        }),
        { tz: TZ },
      ),
    [data],
  );
  const mutes: Record<string, string> = {
    'out:default:mrd_siem_prod': new Date(now + 6 * 60_000).toISOString(),
  };

  return (
    <div className="mr-gallery" data-gallery="incidents">
      <div className="mr-gallery-full" data-shot="incident-card">
        {data.full.map((i) => (
          <IncidentCard key={i.id} incident={i} endpoints={ENDPOINTS} tz={TZ} slackPreview="always" />
        ))}
      </div>
      <div className="mr-gallery-compact" data-shot="incident-card-compact">
        {data.compact.map((i) => (
          <IncidentCard key={i.id} incident={i} variant="compact" endpoints={ENDPOINTS} tz={TZ} mutedUntil={mutes[i.objectKey]} />
        ))}
      </div>
      <div className="mr-gallery-slack" data-shot="slack-message">
        <SlackPreview message={incidentMessage} time={formatClockTime(now - 38_000, TZ)} />
        <SlackPreview message={receiptMessage} time={formatClockTime(now, TZ)} callout="slack-receipt" />
      </div>
    </div>
  );
}
