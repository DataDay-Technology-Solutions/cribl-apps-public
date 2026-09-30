// src/components/ChangeTimeline/ChangesList.tsx — "Changes": every commit of the last 7 days as a receipt line
// (P2-W07, DESIGN_BRIEF 1 "The receipt"): who shipped it and what it is worth a day since, sorted by |$|, in Capra's
// mono face with dot leaders; the priced lines add up to a net under a dotted rule. Both directions are priced, so
// the list credits the good deploys with the same mechanism that blames the bad one. A row opens that commit on the
// change timeline (the Ledger keeps it in ?commit=).

import type { CommitImpact } from '../../../core/commitImpacts.ts';
import { t, tn } from '../../copy/en.ts';
import { commitAuthor } from '../../lib/author.ts';
import { NO_REVERSALS, changeWhen as when, isSettled, isUnattributedShift, settledText, signedMoney, type Reversals } from './money.ts';
import './ChangesList.css';

export interface ChangesListProps {
  /** core/commitImpacts.ts commitImpacts(): the last 7 days, already sorted */
  impacts: readonly CommitImpact[];
  /** IANA zone for the deploy times */
  timeZone: string;
  /** the commit whose card is open (a short hash) */
  selected?: string | null;
  onSelect?: (hash: string) => void;
  /** The snapshot left out commits of the last 7 days (Snapshot.timelineTruncated): the caption says "the latest N". */
  truncated?: boolean;
  /** money.ts reversals(): drops that recovered and the changes that undid them — listed, not in the net */
  reversals?: Reversals;
  /** settings.humanize: an API client's name, when a member gave it one (src/lib/author.ts) */
  labels?: Record<string, string>;
}

function amountText(i: CommitImpact): string {
  if (i.status === 'priced') return signedMoney(i.perDayM);
  return i.status === 'flat' ? t('ledger.timeline.changes.flat') : t('ledger.timeline.changes.unpriced');
}

export function ChangesList({ impacts, timeZone, selected, onSelect, truncated, reversals: rev = NO_REVERSALS, labels }: ChangesListProps) {
  // The net adds up only the changes priced on their own flows; a workspace or daily shift is listed, not summed,
  // and so is a drop that recovered with the change that undid it (money.ts reversals).
  const attributed = impacts.filter((i) => i.status === 'priced' && !isUnattributedShift(i));
  const priced = attributed.filter((i) => !isSettled(i, rev));
  const settled = attributed.length - priced.length;
  const shifts = impacts.some(isUnattributedShift);
  const net = priced.reduce((s, i) => s + i.perDayM, 0);
  return (
    <section className="mr-changes mr-panel" aria-labelledby="mr-changes-title" data-testid="changes-list">
      <header className="mr-changes-head">
        <h2 id="mr-changes-title" className="mr-changes-title">
          {t('ledger.timeline.changes.title')}
        </h2>
        <p className="mr-changes-caption" data-truncated={truncated ? 'true' : undefined}>
          {truncated ? tn('ledger.timeline.changes.captionLatest', impacts.length) : t('ledger.timeline.changes.caption')}
        </p>
      </header>
      {impacts.length === 0 ? (
        <p className="mr-changes-empty">{t('ledger.timeline.changes.empty')}</p>
      ) : (
        <ol className="mr-changes-list" aria-label={t('ledger.timeline.changes.listLabel')}>
          {impacts.map((i) => {
            const hash = i.commit.hash.slice(0, 7);
            const shift = isUnattributedShift(i);
            const settledNote = i.status === 'priced' && !shift ? settledText(i, rev, timeZone) : undefined;
            // An unattributed shift is neither a gain nor a loss of this change, and a drop that recovered (or the
            // change that undid it) no longer runs per day: both read in the neutral ink.
            const tone = i.status !== 'priced' || shift || settledNote ? 'flat' : i.perDayM > 0 ? 'up' : 'down';
            const meta = t(i.commit.deployedAt ? 'ledger.timeline.changes.meta' : 'ledger.timeline.changes.metaCommitted', {
              author: commitAuthor(i.commit.author, labels),
              time: when(i.t, timeZone),
            });
            const basis = shift ? t('ledger.timeline.unattributed') : i.basis ? t(`ledger.timeline.impactBasis.${i.basis}`) : undefined;
            const amount = amountText(i);
            return (
              <li key={i.commit.hash} className="mr-changes-item">
                <button
                  type="button"
                  className={`mr-changes-row is-${tone}${selected && selected.slice(0, 7) === hash ? ' is-selected' : ''}`}
                  data-changes-row
                  data-commit={hash}
                  data-status={i.status}
                  data-attributed={i.status === 'priced' ? (shift ? 'false' : 'true') : undefined}
                  data-settled={settledNote ? 'true' : undefined}
                  aria-label={t('ledger.timeline.changes.rowLabel', {
                    hash,
                    author: commitAuthor(i.commit.author, labels),
                    impact: shift
                      ? `${t('ledger.timeline.impactShiftLine', { amount })} (${t('ledger.timeline.unattributed')})`
                      : i.status === 'priced'
                        ? `${t('ledger.timeline.impactLine', { amount })}${settledNote ? ` (${settledNote})` : ''}`
                        : amount,
                  })}
                  aria-pressed={selected ? selected.slice(0, 7) === hash : false}
                  title={basis}
                  onClick={() => onSelect?.(hash)}
                >
                  <span className="mr-changes-hash">{hash}</span>
                  <span className="mr-changes-line">
                    <span className="mr-changes-message" title={i.commit.message || undefined}>
                      {i.commit.message || t('common.dash')}
                    </span>
                    <span className="mr-changes-leader" aria-hidden="true" />
                    <span className={`mr-changes-amount mr-num is-${tone}`}>{amount}</span>
                    {i.status === 'priced' ? <span className="mr-changes-per">{t('units.perDay')}</span> : null}
                  </span>
                  <span className="mr-changes-meta" title={[meta, basis, settledNote].filter(Boolean).join(' · ')}>
                    {meta}
                    {basis ? ` · ${basis}` : ''}
                    {settledNote ? (
                      <span className="mr-changes-settled" data-testid="changes-settled">
                        {` · ${settledNote}`}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
          {priced.length + settled > 1 ? (
            <li className="mr-changes-item mr-changes-item--total" data-testid="changes-net">
              <span className="mr-changes-line mr-changes-line--total">
                <span className="mr-changes-message">{t('ledger.timeline.changes.net')}</span>
                <span className="mr-changes-leader" aria-hidden="true" />
                <span className={`mr-changes-amount mr-num is-${net === 0 ? 'flat' : net > 0 ? 'up' : 'down'}`}>{signedMoney(net)}</span>
                <span className="mr-changes-per">{t('units.perDay')}</span>
              </span>
              {shifts ? (
                <span className="mr-changes-meta mr-changes-net-note" data-testid="changes-net-note">
                  {t('ledger.timeline.changes.netNote')}
                </span>
              ) : null}
              {settled > 0 ? (
                <span className="mr-changes-meta mr-changes-net-note" data-testid="changes-net-settled">
                  {t('ledger.timeline.changes.netNoteSettled')}
                </span>
              ) : null}
            </li>
          ) : null}
        </ol>
      )}
    </section>
  );
}
