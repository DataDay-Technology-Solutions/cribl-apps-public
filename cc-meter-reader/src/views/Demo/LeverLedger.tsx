// src/views/Demo/LeverLedger.tsx — the lever ledger (EPIC_AUDIT P2-W18, day-2 slice): the last five levers as
// receipt lines, so anyone holding the remote (or judging the demo) sees that every lever is a real,
// attributed commit — "7:03 PM  Break the trim · Payments API sampling ........ 8c9c4cf  Steve Koelpin ·
// deployed · caught in 2:22". The data is src/demo/ledger.ts; this file only names and lays it out.
// A record, not a control: no buttons (the phone's 48 px rule counts every button on the console).

import { t, type CopyKey } from '../../copy/en.ts';
import { displayAuthor, humanize } from '../../../core/humanize.ts';
import { PACK_ROUTE_KEYS, rigSource } from '../../../core/demo/rig-ids.ts';
import { formatClock, formatDateTime, formatTimeOfDay } from '../../lib/format.ts';
import { streamLabel } from '../../demo/actions.tsx';
import { pipelineName } from '../../demo/confirm.ts';
import type { LedgerEntry } from '../../demo/ledger.ts';
import type { PackRouteKey } from '../../demo/scenes.ts';

/** What the lever touched, in the console's own words ("Windows workstations", "Payments API sampling"). */
function leverTarget(entry: Pick<LedgerEntry, 'kind' | 'target'>): string | undefined {
  const id = entry.target;
  if (!id) return undefined;
  switch (entry.kind) {
    case 'applyPack':
    case 'revertPack': {
      const key = rigSource(id)?.key;
      if (key && (PACK_ROUTE_KEYS as readonly string[]).includes(key)) return streamLabel(key as PackRouteKey);
      return rigSource(id)?.label ?? humanize(id);
    }
    case 'breakTrim':
    case 'restoreTrim':
      return pipelineName(id);
    default:
      return rigSource(id)?.label ?? humanize(id);
  }
}

/** "Break the trim", "Spike ×5". */
function leverName(entry: Pick<LedgerEntry, 'kind' | 'multiplier'>): string {
  return t(`demo.ledger.lever.${entry.kind}` as CopyKey, { multiplier: String(entry.multiplier ?? '') });
}

export interface LeverLedgerProps {
  entries: LedgerEntry[];
  /** The display timezone (settings.displayTimezone). */
  tz?: string;
  /** settings.humanize: an API client's name, when a member gave it one (r2 ui-15, H2). */
  labels?: Record<string, string>;
}

export function LeverLedger({ entries, tz, labels }: LeverLedgerProps) {
  return (
    <section className="mr-demo-section mr-demo-ledger" aria-labelledby="mr-demo-ledger" data-testid="demo-ledger">
      <div className="mr-demo-section-head">
        <h2 className="mr-demo-section-title" id="mr-demo-ledger">
          {t('demo.ledger.title')}
        </h2>
      </div>
      <div className="mr-demo-panel mr-demo-ledger-panel">
        <p className="mr-type-caption mr-demo-ledger-caption">{t('demo.ledger.caption')}</p>
        {entries.length === 0 ? (
          <p className="mr-demo-ledger-empty" data-testid="demo-ledger-empty">
            {t('demo.ledger.empty')}
          </p>
        ) : (
          <ol className="mr-demo-ledger-list">
            {entries.map((e) => {
              const target = leverTarget(e);
              // r2 ui-15 (H2): an API client reads by the name a member gave it (settings.humanize).
              const status = [displayAuthor(e.author, labels), e.deployed ? t('demo.ledger.deployed') : t('demo.ledger.committed')];
              return (
                <li
                  key={e.hash}
                  className="mr-demo-ledger-item"
                  data-testid="demo-ledger-item"
                  data-lever={e.kind}
                  data-hash={e.short}
                  data-caught={e.caughtInSec !== undefined ? 'true' : undefined}
                >
                  <time className="mr-demo-ledger-time mr-num" dateTime={new Date(e.atMs).toISOString()} title={formatDateTime(e.atMs, tz)}>
                    {formatTimeOfDay(e.atMs, tz)}
                  </time>{' '}
                  <span className="mr-demo-ledger-lever">{leverName(e)}</span>
                  {/* Beside the lever from 1024 px ("Break the trim · Payments API sampling"), under it on a phone,
                      where the separator is for screen readers only. (Whitespace between grid items is not laid out.) */}
                  {target ? (
                    <span className="mr-demo-ledger-target">
                      <span className="mr-demo-ledger-sep"> · </span>
                      {target}
                    </span>
                  ) : null}{' '}
                  <span className="mr-demo-ledger-leader" aria-hidden="true" />
                  <code className="mr-demo-ledger-hash" aria-label={t('demo.ledger.commit', { hash: e.short })}>
                    {e.short}
                  </code>{' '}
                  <span className="mr-demo-ledger-meta mr-demo-tnum">
                    {status.join(' · ')}
                    {e.caughtInSec !== undefined ? (
                      <>
                        <span aria-hidden="true"> · </span>
                        <span className="mr-demo-ledger-caught">{t('demo.ledger.caught', { duration: formatClock(e.caughtInSec) })}</span>
                      </>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
