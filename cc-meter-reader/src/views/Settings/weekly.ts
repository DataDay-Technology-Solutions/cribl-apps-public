// src/views/Settings/weekly.ts — how a weekly-receipt run reads in Settings → Where to send alerts (SPEC 11,
// 12.4, 17; DECISIONS D12b). Pure, so the exact wording per outcome is unit-tested.
//
// The default Cribl bell counts as an endpoint (EPIC_AUDIT P1-G09): on a Leader without the bell API it is
// skipped quietly (D27, no attempt logged), and the run then says so on the bell's own line instead of
// "none of the 0 endpoints accepted it".

import type { DeliveryLog, NotificationEndpoint } from '../../../core/types.ts';
import type { WeeklyResult } from '../../../core/weekly.ts';
import { resolveEndpoints, wantsWeeklyReceipt } from '../../../core/delivery.ts';
import { t, tn } from '../../copy/en.ts';
import { endpointDisplayName } from '../../state/selectors.ts';

export type WeeklyTone = 'ok' | 'warn' | 'error';

export interface WeeklyView {
  tone: WeeklyTone;
  /** One sentence: "Sent to 1 of 2 endpoints." */
  summary: string;
  /** Per endpoint, newest attempt: "Ops Slack: failed (403)"; `skipped` for the default bell with no bell here. */
  lines: { endpointId: string; text: string; ok: boolean; skipped?: boolean }[];
}

/** The newest attempt per endpoint, in the order the endpoints were first attempted. */
function lastPerEndpoint(deliveries: readonly DeliveryLog[]): DeliveryLog[] {
  const byId = new Map<string, DeliveryLog>();
  for (const d of deliveries) byId.set(d.endpointId, d);
  return [...byId.values()];
}

/** The summary and per-endpoint lines for one weekly run. */
export function weeklyView(outcome: WeeklyResult, endpoints: readonly NotificationEndpoint[]): WeeklyView {
  if (outcome.skipped === 'no_endpoints') return { tone: 'warn', summary: t('settings.notify.weeklyReceipt.noEndpoints'), lines: [] };
  if (outcome.skipped === 'rate_limited') return { tone: 'warn', summary: t('settings.notify.weeklyReceipt.rateLimited'), lines: [] };
  if (outcome.skipped === 'locked') return { tone: 'warn', summary: t('settings.notify.weeklyReceipt.busy'), lines: [] };
  if (outcome.error !== undefined && outcome.endpoints === 0) {
    return { tone: 'error', summary: t('settings.notify.weeklyReceipt.failed', { error: outcome.error }), lines: [] };
  }

  const lines: WeeklyView['lines'] = lastPerEndpoint(outcome.deliveries).map((d) => {
    const name = endpointDisplayName(d.endpointId, endpoints);
    const ok = d.status >= 200 && d.status < 300;
    const text = ok
      ? t('settings.notify.weeklyReceipt.endpointSent', { name, status: d.status })
      : d.status === 0
        ? t('settings.notify.weeklyReceipt.endpointNoResponse', { name })
        : t('settings.notify.weeklyReceipt.endpointFailed', { name, status: d.status });
    return { endpointId: d.endpointId, text, ok };
  });

  const n = outcome.endpoints;
  // Nothing was attempted although the run went out: the default bell took the receipt and was skipped quietly
  // because this Leader has no bell for the App (D27). Say so on the bell's line; beside endpoints that were
  // attempted, the skip stays quiet.
  if (n === 0) {
    const attempted = new Set(outcome.deliveries.map((d) => d.endpointId));
    const skipped = resolveEndpoints(endpoints).filter((ep) => ep.implicit && wantsWeeklyReceipt(ep) && !attempted.has(ep.id));
    if (skipped.length > 0) {
      for (const ep of skipped) {
        const name = endpointDisplayName(ep.id, endpoints);
        lines.push({ endpointId: ep.id, text: t('settings.notify.weeklyReceipt.endpointSkipped', { name }), ok: false, skipped: true });
      }
      return { tone: 'warn', summary: t('settings.notify.weeklyReceipt.bellOnlyUnavailable'), lines };
    }
    // Nothing took the receipt at all: say which switch to turn on, never "none of the 0 endpoints".
    if (lines.length === 0) return { tone: 'warn', summary: t('settings.notify.weeklyReceipt.noEndpoints'), lines };
  }
  let tone: WeeklyTone;
  let summary: string;
  if (n > 0 && outcome.sent >= n) {
    tone = 'ok';
    summary = tn('settings.notify.weeklyReceipt.sent', n);
  } else if (outcome.sent > 0) {
    tone = 'warn';
    summary = tn('settings.notify.weeklyReceipt.partial', n, { sent: outcome.sent });
  } else {
    tone = 'error';
    summary = tn('settings.notify.weeklyReceipt.noneSent', n);
  }

  return { tone, summary, lines };
}
