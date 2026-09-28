// src/components/LedgerTable/status.ts — the words for a row's status (chips, filter options).

import { t } from '../../copy/en.ts';
import type { LedgerRow, RowStatus } from './model.ts';

export const STATUS_COPY: Readonly<Record<RowStatus, string>> = {
  regression: t('ledger.states.regression'),
  spike: t('ledger.states.spike'),
  budget: t('ledger.states.budget'),
  goodnews: t('ledger.states.goodnews'),
  muted: t('ledger.states.muted'),
  unpriced: t('ledger.states.unpriced'),
  learning: t('ledger.states.learning'),
  ok: t('ledger.states.ok'),
  idle: t('ledger.states.idle'),
};

/**
 * "Savings dropped", or the muted chip: after a demo change "Muted · 6 min", short enough to read whole in its column
 * (P1-K05); a member's "Mute for 24 hours" reads "muted · 23 h left" (P1-F07).
 */
export function statusText(row: Pick<LedgerRow, 'status' | 'mutedMinutes' | 'mutedByMember'>): string {
  if (row.status === 'muted' && row.mutedMinutes !== undefined && row.mutedByMember) {
    const m = row.mutedMinutes;
    const left = m >= 60 ? t('ledger.mutedLeftHours', { n: Math.floor(m / 60) }) : t('ledger.mutedLeftMinutes', { n: m });
    return t('ledger.mutedMemberChip', { left });
  }
  if (row.status === 'muted' && row.mutedMinutes !== undefined) return t('ledger.mutedChipShort', { minutes: row.mutedMinutes });
  return STATUS_COPY[row.status];
}

/** The chip's hover title: the whole sentence for a demo mute ("Muted after a demo change · 6 min left"), else the words. */
export function statusTitle(row: Pick<LedgerRow, 'status' | 'mutedMinutes' | 'mutedByMember'>): string {
  if (row.status === 'muted' && row.mutedMinutes !== undefined && row.mutedByMember) return statusText(row);
  if (row.status === 'muted' && row.mutedMinutes !== undefined) return t('ledger.mutedTitle', { minutes: row.mutedMinutes });
  return STATUS_COPY[row.status];
}
