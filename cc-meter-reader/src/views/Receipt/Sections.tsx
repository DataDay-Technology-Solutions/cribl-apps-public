// src/views/Receipt/Sections.tsx — the Receipt's cards below the hero (DESIGN_BRIEF 5.1 rows 2–3), its
// unpriced notice, the layout-matching skeleton and the waiting / unavailable states. Every empty state is a
// ghost of the real layout plus one sentence (BEAUTY F14); the unpriced notice is neutral (BEAUTY F10).

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Link, Modal } from '@capra/core';
import { CircleCheck } from '@capra/icons';
import type { Commit, Incident, Snapshot, TopSaver } from '../../../core/types.ts';
import { canonicalPayload, slackPayload } from '../../../core/payloads.ts';
import { commitImpacts } from '../../../core/commitImpacts.ts';
import { largestAttributed, reversals } from '../../components/ChangeTimeline/money.ts';
import { Money } from '../../components/common/Figures.tsx';
import { SlackPreview } from '../../components/SlackPreview/index.ts';
import { addDaysToKey, formatLocalMonthDay, formatLocalTime, fromIso } from '../../../core/time.ts';
import { titleFor as incidentTitle } from '../../../core/incidents.ts';
import { t, tn } from '../../copy/en.ts';
import { formatInt } from '../../lib/format.ts';
import { Ghost, type GhostShape } from '../../components/common/Ghost.tsx';
import { InlineNotice } from '../../components/common/InlineNotice.tsx';
import { IncidentCard } from '../../components/IncidentCard/index.ts';
import { Page } from '../../components/Shell/Page.tsx';
import { ReceiptList, type ReceiptLine } from '../../components/ReceiptList/ReceiptList.tsx';
import { TrendChart } from '../../components/TrendChart/TrendChart.tsx';
import { annotationDomain, collectedDays, nothingSaved, type TrendAnnotation } from '../../components/TrendChart/trendMath.ts';
import { WhereMoneyGoes } from '../../components/WhereMoneyGoes/WhereMoneyGoes.tsx';
import { HeroFrame } from './HeroCard.tsx';
import type { DestinationRow, SaverTotals, WatchCoverage, WeekCardData } from './model.ts';
import { saverTotalLines, topSaverLines } from './text.ts';
import { useDeepLinks } from '../../lib/deepLinks.ts';

/** A card with a section heading and a caption under it (one card style: `.mr-panel`). */
export function Card({
  title,
  caption,
  span,
  children,
  testId,
  action,
  footer,
  fit = false,
}: {
  title: string;
  caption?: string;
  /** Grid columns; omitted inside a stack that spans for it. */
  span?: 4 | 8 | 12;
  children: ReactNode;
  testId?: string;
  action?: ReactNode;
  footer?: ReactNode;
  /**
   * W3-RECEIPT-3 (P1-H04): the card ends at its content instead of stretching to its row's height, for a row whose
   * two cards' heights depend on the data (the destinations beside the alerts): the shorter one never holds a void.
   */
  fit?: boolean;
}) {
  return (
    <section className={['mr-panel mr-receipt-card', span ? `mr-span-${span}` : '', fit ? 'mr-receipt-card--fit' : ''].filter(Boolean).join(' ')} data-testid={testId}>
      <header className="mr-receipt-card-head">
        <div className="mr-receipt-card-titles">
          <h2 className="mr-receipt-card-title">{title}</h2>
          {caption ? <p className="mr-receipt-card-caption">{caption}</p> : null}
        </div>
        {action ? <div className="mr-receipt-card-action">{action}</div> : null}
      </header>
      <div className="mr-receipt-card-body">{children}</div>
      {footer ? <footer className="mr-receipt-card-foot">{footer}</footer> : null}
    </section>
  );
}

/** Empty state inside a card: a 40 % ghost of what will fill the card, then the title and one line (no box). */
export function CardEmpty({ title, body, ghost }: { title: string; body: string; ghost: GhostShape }) {
  return (
    <div className="mr-receipt-empty">
      <Ghost shape={ghost} />
      <p className="mr-receipt-empty-title">{title}</p>
      <p className="mr-type-caption">{body}</p>
    </div>
  );
}

/**
 * "Saved over the last 30 days". A workspace younger than the window says when its chart starts and how many
 * days it holds — "Saved per day since Sep 22 · 4 days metered so far" (P0-18); the chart itself never draws a
 * day before collecting began.
 */
/** The largest priced change in the trend's window, or undefined (P2-W07 c; see TrendCard). */
function trendAnnotation(snapshot: Snapshot, todayKey: string | undefined, tz: string): TrendAnnotation | undefined {
  const sinceMs = fromIso(snapshot.collectingSince);
  const days = collectedDays(snapshot.trend ?? [], todayKey, Number.isFinite(sinceMs) ? sinceMs : undefined, tz).days;
  const domain = annotationDomain(days, tz, fromIso(snapshot.sweepAt));
  if (!domain) return undefined;
  // Only a change priced on its own flows (an alert names it, or its flows moved) is named here: a workspace or daily
  // price is the whole workspace's day-over-day shift, and the Receipt never hands that to one commit.
  // Nor a drop that recovered, or the change that undid it (usefulness review, round 2).
  const all = commitImpacts(snapshot, { days: 31, timeZone: tz });
  const best = largestAttributed(all, domain, reversals(all, snapshot));
  return best ? { hash: best.commit.hash, t: best.t, perDayM: best.perDayM } : undefined;
}

export function TrendCard({ snapshot, todayKey, tz }: { snapshot: Snapshot; todayKey?: string; tz: string }) {
  // P2-W07 (c): the largest priced change in the charted window, priced exactly as the Ledger's Changes list
  // prices it (core/commitImpacts.ts; the window runs to the sweep, so a change that landed today counts).
  const annotation = useMemo(() => trendAnnotation(snapshot, todayKey, tz), [snapshot, todayKey, tz]);
  const sinceMs = fromIso(snapshot.collectingSince);
  const collectingSinceMs = Number.isFinite(sinceMs) ? sinceMs : undefined;
  const collected = collectedDays(snapshot.trend ?? [], todayKey, collectingSinceMs, tz);
  const windowStart = todayKey ? addDaysToKey(todayKey, -29) : undefined;
  const young = collectingSinceMs !== undefined && collected.sinceKey !== undefined && windowStart !== undefined && collected.sinceKey > windowStart;
  const title = young ? t('receiptView.trend.titleSince', { date: formatLocalMonthDay(collectingSinceMs, tz) }) : t('sections.trend');
  // Under two whole days the chart's learning panel already counts them; the caption stays the plain basis. With
  // nothing saved on any day the chart draws no line and no diamonds, so the caption doesn't mention them.
  const caption =
    collected.days.length >= 2 && nothingSaved(collected.days)
      ? t('receiptView.trend.captionEmpty')
      : young && collected.days.length >= 2
        ? tn('receiptView.trend.captionSince', collected.days.length)
        : t('receiptView.trend.caption');
  return (
    <Card title={title} caption={caption} span={8} testId="receipt-trend">
      <TrendChart
        points={snapshot.trend ?? []}
        todayKey={todayKey}
        commits={(snapshot.timeline ?? []) as Commit[]}
        tz={tz}
        collectingSinceMs={collectingSinceMs}
        annotation={annotation}
      />
    </Card>
  );
}

export function TopSaversCard({ savers, totals }: { savers: TopSaver[]; totals?: SaverTotals }) {
  const linksOut = useDeepLinks();
  // The list holds only the flows with savings, so the caption counts what is shown ("Top 3 …"); with one line
  // or none it names the basis alone.
  const caption = savers.length > 1 ? t('receiptView.topSavers.captionTop', { n: formatInt(savers.length) }) : t('receiptView.topSavers.caption');
  return (
    <Card
      title={t('sections.topSavers')}
      caption={caption}
      span={4}
      testId="receipt-top-savers"
      footer={savers.length > 0 ? <Link href="/ledger">{t('receiptView.topSavers.viewAll')}</Link> : null}
    >
      <ReceiptList
        lines={topSaverLines(savers, linksOut ? undefined : null, totals)}
        ariaLabel={t('receiptView.topSavers.listLabel')}
        empty={<CardEmpty title={t('receiptView.topSavers.emptyTitle')} body={t('receiptView.topSavers.emptyBody')} ghost="list" />}
      />
      {totals && savers.length > 0 ? (
        // The totals keep the savers' link column only when the savers link out (none on sample data, OQ-01), so the
        // amounts share one right edge either way.
        <ReceiptList className="mr-rlist--totals" lines={saverTotalLines(savers, totals)} ariaLabel={t('receiptView.topSavers.totalsLabel')} linkSlot={linksOut} />
      ) : null}
    </Card>
  );
}

/** `read`: how many destinations the sweep read; with none carrying money the empty state says so (P1-D06). */
export function DestinationsCard({ rows, read = 0, onOpen, colorIds }: { rows: DestinationRow[]; read?: number; onOpen?: (key: string) => void; colorIds?: readonly string[] }) {
  return (
    <Card
      title={t('sections.destinations')}
      caption={t('receiptView.destinations.caption')}
      span={8}
      testId="receipt-destinations"
      fit
      action={
        rows.some((r) => !r.unpriced) ? (
          <span className="mr-receipt-legend" aria-hidden="true">
            <span className="mr-receipt-legend-item">
              <span className="mr-receipt-legend-swatch mr-receipt-legend-swatch--paid" />
              {t('receiptView.destinations.legendPaid')}
            </span>
            <span className="mr-receipt-legend-item">
              <span className="mr-receipt-legend-swatch mr-receipt-legend-swatch--saved" />
              {t('receiptView.destinations.legendSaved')}
            </span>
          </span>
        ) : null
      }
    >
      <WhereMoneyGoes
        rows={rows}
        onOpen={onOpen}
        colorIds={colorIds}
        empty={
          read > 0 ? (
            <CardEmpty title={t('receiptView.destinations.emptyZeroTitle')} body={tn('receiptView.destinations.emptyZeroBody', read)} ghost="bars" />
          ) : (
            <CardEmpty title={t('receiptView.destinations.emptyTitle')} body={t('receiptView.destinations.emptyBody')} ghost="bars" />
          )
        }
      />
    </Card>
  );
}

const MAX_ALERTS = 3;
const MAX_CLOSED = 3;

/**
 * "Alerts": open incidents as compact cards, most severe first. With none open, the card is not an empty box
 * (P1-H04): one calm line, then what the detector is watching right now (routes for the savings ratio, sources
 * for cost spikes, destinations with a budget) and the alerts that closed in the last 24 hours, as receipt lines.
 */
export function AlertsCard({
  incidents,
  closed = [],
  coverage,
  tz = 'UTC',
}: {
  incidents: Incident[];
  closed?: Incident[];
  coverage?: WatchCoverage;
  tz?: string;
}) {
  const shown = incidents.slice(0, MAX_ALERTS);
  const more = incidents.length - shown.length;
  const watchLines: ReceiptLine[] = coverage
    ? ([
        coverage.routes > 0 ? { id: 'routes', label: t('receiptView.alerts.watchRoutes'), amountM: 0, valueText: tn('receiptView.alerts.routes', coverage.routes) } : null,
        coverage.sources > 0 ? { id: 'sources', label: t('receiptView.alerts.watchSources'), amountM: 0, valueText: tn('receiptView.alerts.sources', coverage.sources) } : null,
        coverage.budgets > 0 ? { id: 'budgets', label: t('receiptView.alerts.watchBudgets'), amountM: 0, valueText: tn('receiptView.alerts.destinations', coverage.budgets) } : null,
      ] as (ReceiptLine | null)[]).filter((l): l is ReceiptLine => l !== null)
    : [];
  const closedLines: ReceiptLine[] = closed.slice(0, MAX_CLOSED).map((i) => ({
    id: i.id,
    label: incidentTitle(i),
    amountM: 0,
    valueText: formatLocalTime(fromIso(i.closedAt ?? ''), tz),
    muted: true,
  }));
  return (
    <Card title={t('receiptView.alerts.title')} caption={t('receiptView.alerts.caption')} span={4} testId="receipt-alerts" fit>
      {shown.length === 0 ? (
        <div className="mr-receipt-calm-stack">
          <div className="mr-receipt-calm" data-state="no-open-alerts">
            <span className="mr-receipt-calm-mark" aria-hidden="true">
              <CircleCheck size="sm" />
            </span>
            <div>
              <p className="mr-receipt-empty-title">{t('receiptView.alerts.emptyTitle')}</p>
              <p className="mr-type-caption">{t('receiptView.alerts.emptyBody')}</p>
            </div>
          </div>
          {watchLines.length > 0 ? (
            <div className="mr-receipt-calm-block" data-testid="alerts-watching">
              <p className="mr-receipt-eyebrow">{t('receiptView.alerts.watchTitle')}</p>
              <ReceiptList lines={watchLines} ariaLabel={t('receiptView.alerts.watchLabel')} />
            </div>
          ) : null}
          {closedLines.length > 0 ? (
            <div className="mr-receipt-calm-block" data-testid="alerts-closed">
              <p className="mr-receipt-eyebrow">{t('receiptView.alerts.closedTitle')}</p>
              <ReceiptList lines={closedLines} ariaLabel={t('receiptView.alerts.closedLabel')} />
            </div>
          ) : null}
        </div>
      ) : (
        <ul className="mr-receipt-alerts">
          {shown.map((incident) => (
            <li key={incident.id}>
              {/* Each card keeps its own clock for its "… ago" (the view no longer re-renders once a second, P1-B05). */}
              <IncidentCard incident={incident} variant="compact" deliveries={incident.deliveries} headingLevel="h3" />
            </li>
          ))}
        </ul>
      )}
      {more > 0 ? (
        <p className="mr-receipt-alerts-more">
          <Link href="/ledger">{tn('receiptView.alerts.more', more)}</Link>
        </p>
      ) : null}
    </Card>
  );
}

/**
 * "This week so far" (P2-W20): the last row, the whole width — Monday to now as a receipt (the total, how it compares
 * with the same span last week, what saved it) beside the message the weekly receipt would send if it went now, drawn
 * as Slack draws it, so the leadership artefact exists in the app before Monday. On a phone the message opens from a
 * button. Sending stays in Settings, where the endpoints are.
 */
export function WeekCard({ data, tz, labels, onVisible }: { data: WeekCardData; tz: string; labels?: Record<string, string>; onVisible?: () => void }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  // The week's rollups are read once the card nears the viewport (the Leader's API budget: a Receipt opened and
  // left at the top never reads them).
  const sentinel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!onVisible) return;
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      onVisible();
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          onVisible();
        }
      },
      { rootMargin: '200px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [onVisible]);
  const caption = t(data.throughLastHour ? 'receiptView.week.captionHours' : 'receiptView.week.caption', { span: data.span });
  const lines: ReceiptLine[] = (data.lines ?? []).map((l, i) => ({ id: `${i}:${l.label}`, label: l.label, amountM: l.savedM }));
  const message = useMemo(
    () => (data.receipt ? slackPayload(canonicalPayload('receipt.weekly', { receipt: data.receipt, workspace: '', linkBase: '' }), { tz, labels }) : undefined),
    [data.receipt, tz, labels],
  );
  let body: ReactNode;
  if (data.status === 'loading') {
    body = (
      <div className="mr-week-ghost" aria-busy="true">
        <span className="mr-skel" style={{ width: 160, height: 28 }} />
        {[0, 1, 2].map((i) => (
          <span key={i} className="mr-skel" style={{ width: '100%', height: 14 }} />
        ))}
      </div>
    );
  } else if (data.status === 'error') {
    body = <p className="mr-type-caption">{t('receiptView.week.failed')}</p>;
  } else {
    body = (
      <div
        className="mr-week"
        data-from={data.fromMs !== undefined ? new Date(data.fromMs).toISOString() : undefined}
        data-to={data.toMs !== undefined ? new Date(data.toMs).toISOString() : undefined}
        data-sample={data.sample && !data.lines ? 'true' : undefined}
      >
        <div className="mr-week-sum">
          <p className="mr-week-total" data-testid="week-total">
            <Money value={data.savedM} className="mr-week-amount" />
          </p>
          {data.changePct !== undefined ? (
            <p className="mr-week-change" data-sign={data.changePct >= 0 ? 'up' : 'down'} data-testid="week-change">
              {t('receiptView.week.vsPrior', { pct: `${data.changePct > 0 ? '+' : data.changePct < 0 ? '−' : ''}${Math.abs(data.changePct)}%` })}
            </p>
          ) : null}
          {data.sample && !data.lines ? <p className="mr-type-caption">{t('receiptView.week.sampleLines')}</p> : null}
          {data.receipt ? (
            <div className="mr-week-actions">
              <span className="mr-week-open">
                <Button variant="secondary" size="sm" onPress={() => setPreviewOpen(true)}>
                  {t('receiptView.week.preview')}
                </Button>
              </span>
              <Link href="/settings/notifications">{t('receiptView.week.settings')}</Link>
            </div>
          ) : null}
        </div>
        {data.sample && !data.lines ? null : (
          <div className="mr-week-lines">
            {lines.length > 0 ? (
              <ReceiptList lines={lines} ariaLabel={t('receiptView.week.linesLabel')} />
            ) : data.savedM === 0 ? (
              // r2 ui-13 (IC-7): minutes metered with nothing flowing is "no traffic", never "nothing metered" beside a
              // hero that counts the minutes metered; traffic that saved nothing says that.
              <p className="mr-type-caption" data-testid="week-empty">
                {t(data.whpM !== undefined && data.whpM > 0 ? 'receiptView.week.emptySaved' : 'receiptView.week.empty')}
              </p>
            ) : null}
          </div>
        )}
        {message ? (
          <div className="mr-week-message" data-testid="week-message">
            <p className="mr-receipt-eyebrow">{t('receiptView.week.previewTitle')}</p>
            <SlackPreview message={message} callout="weekly-preview" />
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <Card title={t('receiptView.week.title')} caption={caption} span={12} testId="receipt-week">
      <div ref={sentinel} className="mr-week-sentinel" aria-hidden="true" />
      {body}
      {previewOpen && message ? (
        <Modal
          isOpen
          onIsOpenChange={(open) => {
            if (!open) setPreviewOpen(false);
          }}
          title={t('receiptView.week.previewTitle')}
          size="md"
          confirmButtonText={t('receiptView.week.close')}
          cancelButtonText={null}
          onConfirm={() => setPreviewOpen(false)}
        >
          <div className="mr-week-preview" data-testid="week-preview">
            <p className="mr-type-caption">{t('receiptView.week.previewNote')}</p>
            <SlackPreview message={message} callout="weekly-preview" />
          </div>
        </Modal>
      ) : null}
    </Card>
  );
}

/** "N destinations are unpriced" — a neutral setup note, counted from snapshot.unpricedOutputIds only (REVIEW #11). */
export function UnpricedNotice({ count, onSetPrices }: { count: number; onSetPrices: () => void }) {
  if (count <= 0) return null;
  return (
    <InlineNotice data-testid="unpriced-notice" action={{ label: t('unpriced.link'), onClick: onSetPrices }}>
      {tn('unpriced.banner', count)}
    </InlineNotice>
  );
}

/** The hero's right column as static lines (P1-H01): the loading and waiting heroes keep the finished shape. */
function HeroAsideGhost() {
  return (
    <div className="mr-hero-aside mr-hero-aside--ghost" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className="mr-skel mr-hero-aside-skel" />
      ))}
      <span className="mr-skel mr-hero-aside-skel mr-hero-aside-skel--now" />
    </div>
  );
}

/** Loading: the same grid as the loaded view, as static blocks (no shimmer, PRD 8.8 item 4). */
export function ReceiptSkeleton() {
  return (
    <Page className="mr-receipt-view" aria-busy="true" aria-label={t('receiptView.states.loading')} data-testid="receipt-skeleton">
      <HeroFrame>
        <section className="mr-panel mr-hero mr-hero--skeleton">
          <div className="mr-hero-id">
            <span className="mr-skel" style={{ width: 120, height: 16 }} />
            <span className="mr-skel" style={{ width: 280, height: 24 }} />
          </div>
          <div className="mr-hero-number">
            <span className="mr-skel mr-skel--number" />
          </div>
          <HeroAsideGhost />
          <span className="mr-skel" style={{ width: 260, height: 14 }} />
          <div className="mr-hero-bar">
            <span className="mr-skel" style={{ width: 200, height: 14 }} />
            <span className="mr-skel" style={{ width: '100%', height: 16, borderRadius: 999 }} />
            <span className="mr-skel" style={{ width: '40%', height: 14 }} />
          </div>
        </section>
      </HeroFrame>
      <div className="mr-grid">
        {[8, 4, 8, 4].map((span, i) => (
          <section key={i} className={`mr-panel mr-receipt-card mr-span-${span}`}>
            <span className="mr-skel" style={{ width: 180, height: 16 }} />
            <span className="mr-skel" style={{ width: '60%', height: 12 }} />
            <span className="mr-skel mr-skel--block" />
          </section>
        ))}
      </div>
    </Page>
  );
}

/**
 * Waiting for the first sweep, or the snapshot can't be read: the Receipt's own layout as a 40 % ghost — hero
 * with "$—" and an empty receipt bar, the four cards as their chart, list, bars and alert outlines — and one
 * sentence where the number will be (BEAUTY F14). No stock illustration, no page of blank space.
 *
 * Once nothing will load (`stopped`: sweeps are failing before the first figures, or the snapshot read failed), the
 * outlines would read as a page still loading (craft review, round 2): the cards then say so in one still line, and
 * the hero drops its placeholder lines, so only the caption and the notice above speak.
 */
export function ReceiptGhost({
  caption,
  state,
  stopped,
  children,
}: {
  caption: string;
  state: 'waiting' | 'error';
  /** Nothing will load until a sweep succeeds ('failing') or the saved figures can be read ('error'). */
  stopped?: 'failing' | 'error';
  children?: ReactNode;
}) {
  return (
    <Page className="mr-receipt-view mr-receipt-view--ghost" data-state={state} data-stopped={stopped}>
      {children}
      <HeroFrame>
        <section className="mr-panel mr-hero mr-hero--ghost" aria-label={t('receiptView.heroLabel')}>
          <div className="mr-hero-id">
            <h1 className="mr-hero-label">{t('receiptView.heroLabel')}</h1>
          </div>
          <div className="mr-hero-number">
            <span className="mr-hero-dash" aria-hidden="true">
              ${t('common.dash')}
            </span>
          </div>
          <p className="mr-hero-caption" data-testid="hero-caption">
            {caption}
          </p>
          {stopped ? null : <HeroAsideGhost />}
          {stopped ? null : (
            <div className="mr-hero-bar" aria-hidden="true">
              <span className="mr-hero-ghostbar" />
            </div>
          )}
        </section>
      </HeroFrame>
      <div className="mr-grid mr-receipt-grid" aria-hidden="true">
        {(
          [
            [8, 'chart', t('sections.trend')],
            [4, 'list', t('sections.topSavers')],
            [8, 'bars', t('sections.destinations')],
            [4, 'rows', t('receiptView.alerts.title')],
          ] as const
        ).map(([span, shape, title]) => (
          <section key={shape} className={`mr-panel mr-receipt-card mr-span-${span}`}>
            <p className="mr-receipt-card-title mr-receipt-card-title--ghost">{title}</p>
            {stopped ? (
              <p className="mr-receipt-card-stopped" data-testid="ghost-card-stopped">
                {t(`receiptView.ghostCardEmpty.${stopped}`)}
              </p>
            ) : (
              <Ghost shape={shape} />
            )}
          </section>
        ))}
      </div>
    </Page>
  );
}
