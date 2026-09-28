// src/views/Presenter/index.tsx — the stage view (PRD 8.1 presenter + incident takeover, 8.8 item 8;
// DESIGN_BRIEF 5.2). `?present=1` or key P; the shell hides all chrome and hands this view the frame.
//
//   top      wordmark · data status · (sample / replay chip) · "P leaves presenter mode · ? shows keys" (fades);
//            "?" opens the stage's own key list and Escape leaves presenter mode (StageKeys.tsx)
//   hero     "Saved by Cribl" · the Meter (≥ 160 px at 1920, one soft glow) · its basis (≥ 28 px) · "Saved since
//            you started watching $12.40 · ~$0.04 a second" (P2-W01, live data only; session.ts)
//   savers   "What's saving the most": five receipt lines with dot leaders (≥ 32 px)
//   rest     the lower half at rest: the month's receipt bar at stage scale and the 30-day savings line (P2-W04,
//            RestPanel.tsx) — the takeover's footprint, so it fades out as a card lands
//   bottom   scene indicator (demo build) · QR (≥ 220 px at 1440; the code is the address) with the ask above it
//   takeover the incident card over the lower half when a high-severity alert opens
//
// The stage is split at half height (BEAUTY F1): the hero and the savers live in the upper half, the
// takeover owns the lower half, and the QR column on the right is never covered — so at the payoff the
// audience still reads the number, its basis, all five savers and the vote ask. Presenter.css scales the
// whole stage by min(width, height) so the split holds on any projector, not only at 16:9.
//
// Before there is a figure (never priced, no sweep yet, Leader unreachable) the hero shows "$—" and says
// what to do next; a display-size zero never goes on the screen (BEAUTY F2).
//
// The figure is the Receipt's own Meter (one odometer, one roll timing, reduced motion followed live), rolling
// even the static annualized run rate to each sweep's value, and sized from a fixed character budget so crossing
// a magnitude ($999,999 → $1,000,000) never resizes the hero or moves its caption (P0-16, P1-B03).
//
// Period: ?period= wins, else settings.presenter.headlinePeriod (default: annualized run rate).

import { Suspense, lazy, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { HeadlinePeriod, Incident, TopSaver } from '../../../core/types.ts';
import { fmtDollars } from '../../../core/format.ts';
import { DEFAULT_QR_URL } from '../../../core/settings.ts';
import { useLeaderReach } from './leaderReach.ts';
import { saverDrops, saverLabel, stageSaverLabels } from './savers.ts';
import { presenterQrCaption } from './qrCaption.ts';
import { t } from '../../copy/en.ts';
import { IS_DEMO_BUILD } from '../../lib/env.ts';
import { formatRelative, formatTimeOfDay } from '../../lib/format.ts';
import { useAppParams } from '../../lib/params.ts';
import { prefersReducedMotion } from '../../lib/dom.ts';
import { showShortcutChip, useShortcut } from '../../lib/shortcuts.ts';
import { primeChime } from '../../components/IncidentTakeover/chime.ts';
import { useNow } from '../../lib/ticker.ts';
import { shallowEqual, useAppState } from '../../state/react.tsx';
import { HowItWorks } from '../../components/HowItWorks/HowItWorks.tsx';
import { IncidentTakeover } from '../../components/IncidentTakeover/index.ts';
import { Meter } from '../../components/Meter/index.ts';
import { Credit } from '../../components/common/Credit.tsx';
import { QrBlock } from '../../components/QrBlock/index.ts';
import { dataUpdatedAt, deriveDataStatus, type DataStatus } from '../../components/Shell/status.ts';
import { periodBasis } from './basis.ts';
import { nextSegment, sessionRateText, SESSION_MAX_EXTRAPOLATION_SEC, startSession, type SessionSegment } from './session.ts';
import { figureBudget, periodFigure } from './heroValue.ts';
import { RestPanel } from './RestPanel.tsx';
import { StageKeys } from './StageKeys.tsx';
import { usePresenterTestHook } from './testHook.ts';
import './Presenter.css';

const EXIT_HINT_MS = 6_000;

/** The stage's own reading of the chrome's data status (P0-08): never "Live" unless the data is. */
type StageStatus = DataStatus | 'unpriced';

/** The label for a stage status; null for a status the stage has no word for (it then shows nothing). */
function stageStatusLabel(status: StageStatus): string | null {
  switch (status) {
    case 'live':
      return t('presenter.live');
    case 'stale':
      return t('status.stale');
    case 'offline':
      return t('status.offline');
    case 'rate-limited':
      return t('status.rateLimited');
    case 'connecting':
      return t('status.connecting');
    case 'waiting':
      return t('status.short.waiting');
    case 'unpriced':
      return t('presenter.statusUnpriced');
    // WP-D's statuses (P0-07, P1-D01): sweeps failing, the session expired, the role can't read the App's data.
    case 'failing':
      return t('status.failing');
    case 'signed-out':
      return t('status.signedOut');
    case 'no-access':
      return t('status.noAccess');
    default:
      return null;
  }
}

/** Data status on the stage: a neutral dot while live, amber when stale or rate limited, red when offline. */
function LiveStatus({ hasPrices }: { hasPrices: boolean }) {
  const now = useNow();
  const view = useAppState(
    (s) => ({
      status: deriveDataStatus(s, now),
      updatedAt: dataUpdatedAt(s),
      backoffUntil: s.status.live.backoffUntil,
      timeZone: s.settings.displayTimezone,
    }),
    shallowEqual,
  );
  // Nothing can meter without prices (WP-D's 'not-metering'): the stage says so, never "Waiting".
  const status: StageStatus = (view.status === 'waiting' && !hasPrices) || view.status === 'not-metering' ? 'unpriced' : view.status;
  const label = stageStatusLabel(status);
  if (!label) return null;
  let caption: string | null = null;
  if (status === 'rate-limited' && view.backoffUntil !== undefined && view.backoffUntil > now) {
    caption = t('presenter.nextCheck', { time: formatTimeOfDay(view.backoffUntil, view.timeZone) });
  } else if ((status === 'live' || status === 'stale' || status === 'offline' || status === 'rate-limited' || status === 'failing') && view.updatedAt !== undefined) {
    caption = t('presenter.updated', { ago: formatRelative(Math.min(view.updatedAt, now), now) });
  }
  return (
    <span className="mr-pv-live" data-status={status}>
      <span className="mr-pv-live-dot" aria-hidden="true" />
      <span className="mr-pv-live-label">{label}</span>
      {caption ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="mr-num">{caption}</span>
        </>
      ) : null}
    </span>
  );
}

/**
 * "Saved since you started watching $12.40 · ~$0.04 a second" (P2-W01): a running total from $0.00 when the stage
 * opened, accruing at the measured rate while the data is live, frozen and greyed when it is not. The only money on
 * stage with cents (DESIGN_BRIEF 5.2). The segment re-anchors during render when the rate or the snapshot changes
 * (React's "adjust state when a prop changes" pattern), so the total carries over and the Meter eases, never jumps.
 */
function SessionTicker() {
  const now = useNow();
  const live = useAppState((s) => deriveDataStatus(s, now) === 'live');
  const rate = useAppState((s) => s.snapshot?.ratePerSecM ?? 0);
  const sweepAt = useAppState((s) => s.snapshot?.sweepAt ?? '');
  const effRate = live ? rate : 0;
  const key = `${effRate}|${sweepAt}`;
  // `now` (the stage's one-second clock) marks the switch: the Meter extrapolates each segment from its own anchor,
  // so the line is one continuous total whichever second the switch lands on.
  const [seg, setSeg] = useState<SessionSegment>(() => startSession(Date.now(), effRate, key));
  if (seg.key !== key) setSeg(nextSegment(seg, now, effRate, key));
  const frozen = seg.ratePerSecM <= 0;
  const rateText = frozen ? t('presenter.session.paused') : sessionRateText(seg.ratePerSecM);
  return (
    <p className="mr-pv-session" data-frozen={frozen ? 'true' : 'false'} data-testid="session-ticker">
      <span className="mr-pv-session-label">{t('presenter.session.label')}</span>
      <span className="mr-pv-session-figure mr-num">
        <Meter
          valueM={seg.baseM}
          ratePerSecM={seg.ratePerSecM}
          anchorMs={seg.fromMs}
          maxExtrapolationSec={SESSION_MAX_EXTRAPOLATION_SEC}
          label={t('presenter.session.label')}
          size="inherit"
          callout={null}
        />
      </span>
      {rateText ? <span className="mr-pv-session-rate">{rateText}</span> : null}
    </p>
  );
}

/** A new saver row rises into place (P2-W19: a pack applied on stage); its amount's tint lasts a second. */
const SAVER_INSERT_MS = 400;

/**
 * The top five as receipt lines. When a sweep changes them (a pack applied on stage), a row that was not there
 * rises 0.6 em into place over 400 ms and a changed amount glows green for a second (P2-W19) — so the room sees
 * which line the change made. Rows are keyed by object; the first render (the stage opening) animates nothing,
 * and under reduced motion nothing moves.
 *
 * W3-STAGE-1: while an open regression names a saver, its line keeps its own figure and carries the drop as a red
 * chip at the end of its leader, so the amounts stay one column and the line keeps its place; a screen reader hears
 * the drop as a sentence after the amount. The line turns plain again when the incident closes.
 */
function SaversList({ savers, labels, incidents }: { savers: TopSaver[]; labels: Record<string, string>; incidents: readonly Incident[] | null }) {
  const amounts = savers.map((s) => fmtDollars(s.savedPerDayM));
  const names = stageSaverLabels(savers, labels);
  const drops = saverDrops(savers, incidents);
  const listRef = useRef<HTMLOListElement | null>(null);
  useLeaderReach(listRef, '.mr-pv-item-label', '.mr-pv-leader');
  const seen = useRef<Map<string, string> | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    const before = seen.current;
    seen.current = new Map(savers.map((s, i) => [s.objectKey, amounts[i]]));
    if (!list || !before || prefersReducedMotion()) return;
    for (const li of list.querySelectorAll<HTMLLIElement>(':scope > .mr-pv-item')) {
      const key = li.dataset.key ?? '';
      const was = before.get(key);
      if (was === undefined) {
        li.animate?.([{ transform: 'translateY(0.6em)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: SAVER_INSERT_MS, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
      } else if (was !== li.dataset.amount) {
        const amount = li.querySelector<HTMLElement>('.mr-pv-item-amount');
        amount?.classList.remove('mr-pv-changed');
        void amount?.offsetWidth; // restart the tint when two sweeps change it in a row
        amount?.classList.add('mr-pv-changed');
      }
    }
  });
  return (
    <ol ref={listRef} className="mr-pv-list">
      {savers.map((s, i) => {
        const drop = drops.get(s.objectKey);
        const perDay = drop !== undefined ? fmtDollars(drop) : '';
        return (
          <li key={s.objectKey} className="mr-pv-item" data-key={s.objectKey} data-amount={amounts[i]} data-drop-m={drop}>
            <span className="mr-pv-item-label" title={saverLabel(s, labels)}>
              {names[i]}
            </span>
            <span className="mr-pv-leader" aria-hidden="true" />
            {drop !== undefined ? (
              <span className="mr-pv-drop mr-num" aria-hidden="true" title={t('presenter.saverDropTitle', { perDay })}>
                {t('presenter.saverDrop', { perDay })}
              </span>
            ) : null}
            <span className="mr-pv-item-amount">
              <span className="mr-num">{amounts[i]}</span>
              <span className="mr-pv-unit">{t('units.perDay')}</span>
              {drop !== undefined ? <span className="mr-visually-hidden">{t('presenter.saverDropHidden', { perDay })}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// Demo build only: the scene indicator in the bottom-left corner. Loaded behind the INLINE build flag so the
// release bundle drops it and everything it imports — the demo scenes and the rig's id table (P1-B04).
const SceneIndicator =
  import.meta.env.VITE_MR_BUILD === 'demo' ? lazy(() => import('../../components/SceneIndicator/index.ts').then((m) => ({ default: m.SceneIndicator }))) : null;

// Dev / mock builds only (the beauty grid): the incident card family and the Slack message on one page.
// The flag is tested inline so a release build drops the import and the chunk.
const Gallery = import.meta.env.DEV || import.meta.env.VITE_MR_MOCK === '1' ? lazy(() => import('./Gallery.tsx')) : null;

export default function PresenterView() {
  const [search] = useSearchParams();
  if (Gallery && search.get('gallery') === 'incidents') {
    return (
      <Suspense fallback={null}>
        <Gallery />
      </Suspense>
    );
  }
  return <PresenterStage />;
}

function PresenterStage() {
  usePresenterTestHook();
  const [params] = useAppParams();
  const snapshot = useAppState((s) => s.snapshot);
  const settings = useAppState((s) => s.settings);
  const source = useAppState((s) => s.source);
  const hydrating = useAppState((s) => s.status.hydrate.phase === 'idle' || s.status.hydrate.phase === 'loading');
  const snapshotError = useAppState((s) => s.errors.snapshot);
  const hasPrices = useAppState((s) => s.prices !== null);
  const saversId = useId();

  // The chime (P2-W19): off unless settings turn it on; M toggles it for this stage session. Any key or click on
  // the stage primes the audio (browsers start sound only after a gesture), so a later alert can sound.
  const [chimeOverride, setChimeOverride] = useState<boolean | null>(null);
  const chime = chimeOverride ?? settings.presenter?.chime ?? false;
  useShortcut('M', () => {
    const next = !chime;
    if (next) primeChime();
    setChimeOverride(next);
    showShortcutChip(t(next ? 'presenter.chimeOn' : 'presenter.chimeOff'));
  });
  useEffect(() => {
    if (!chime) return;
    const prime = () => primeChime();
    window.addEventListener('keydown', prime, { capture: true });
    window.addEventListener('pointerdown', prime, { capture: true });
    return () => {
      window.removeEventListener('keydown', prime, { capture: true });
      window.removeEventListener('pointerdown', prime, { capture: true });
    };
  }, [chime]);

  const [hintVisible, setHintVisible] = useState(true);
  useEffect(() => {
    const timer = window.setTimeout(() => setHintVisible(false), EXIT_HINT_MS);
    return () => window.clearTimeout(timer);
  }, []);

  const period: HeadlinePeriod = params.period ?? settings.presenter?.headlinePeriod ?? 'annualized';
  const headline = snapshot?.headline ?? null;
  const figure = useMemo(() => periodFigure(headline, period), [headline, period]);
  const budget = figureBudget(headline);
  const basis = periodBasis(period, headline);
  const anchorMs = snapshot ? Date.parse(snapshot.sweepAt) : Number.NaN;
  const labels = settings.humanize ?? {};
  const savers = (snapshot?.topSavers ?? []).filter((s) => s.savedPerDayM > 0).slice(0, 5);
  const incidents = snapshot?.incidents ?? null;
  const qrUrl = settings.presenter?.qrUrl?.trim() || DEFAULT_QR_URL;
  const qrCaption = presenterQrCaption(qrUrl);
  const loading = !snapshot && hydrating;

  let heroNote: string | null = null;
  if (!snapshot && !loading)
    heroNote = snapshotError ? t('presenter.unreachable') : hasPrices ? t('presenter.waiting') : t('presenter.noPrices');
  else if (snapshot && snapshotError) heroNote = t('presenter.unreachable');
  const empty = !snapshot && !loading;

  return (
    <div className="mr-pv" data-period={period} data-source={source} role="region" aria-label={t('presenter.viewLabel')}>
      <header className="mr-pv-top">
        <div className="mr-pv-brand">
          {/* The wordmark signed: "Meter Reader by Steve Koelpin", the byline quieter than the name it follows. */}
          <span className="mr-pv-wordmark">
            {t('app.name')} <Credit copyKey="credit.byline" className="mr-pv-byline" testId="presenter-credit" />
          </span>
          {source === 'live' ? <LiveStatus hasPrices={hasPrices} /> : null}
          {source === 'sample' ? <span className="mr-pv-chip mr-pv-chip--sample">{t('presenter.sampleChip')}</span> : null}
          {source === 'replay' ? <span className="mr-pv-chip mr-pv-chip--sample">{t('presenter.replayChip')}</span> : null}
        </div>
        <p className="mr-pv-exit" data-visible={hintVisible ? 'true' : 'false'}>
          {t('presenter.exitHint')}
        </p>
      </header>

      <section className="mr-pv-hero" aria-busy={loading || undefined}>
        <h1 className="mr-pv-label">{t('meter.caption')}</h1>
        {loading ? (
          <div className="mr-pv-figure-skeleton" aria-hidden="true" />
        ) : empty ? (
          <p className="mr-pv-figure mr-pv-figure--empty" data-callout="saved">
            <span aria-hidden="true">{t('presenter.emptyFigure')}</span>
            <span className="mr-visually-hidden">{t('presenter.emptyLabel', { status: heroNote ?? '' })}</span>
          </p>
        ) : (
          // data-value: the authoritative figure in millicents (the Story spec compares the stage with its beats).
          <p className="mr-pv-figure mr-num" data-value={figure.valueM} style={{ '--mr-hero-chars': String(budget) } as CSSProperties}>
            <Meter
              key={period}
              valueM={figure.valueM}
              ratePerSecM={figure.accrue ? (snapshot?.ratePerSecM ?? 0) : 0}
              anchorMs={anchorMs}
              label={t('presenter.heroMeterLabel', { period: basis })}
              size="inherit"
              rollStatic
              rollIn="presenter-hero"
            />
          </p>
        )}
        {loading ? (
          // Before any data there is no basis to name (never "from today so far"): a caption-height ghost.
          <p className="mr-pv-caption mr-pv-caption--ghost" aria-hidden="true" />
        ) : (
          <p className={`mr-pv-caption${empty ? ' mr-pv-caption--next' : ''}`}>{heroNote ?? basis}</p>
        )}
        {/* Live data only: a sample or a replay has no "while you watched" to show (P2-W01). */}
        {source === 'live' && snapshot ? <SessionTicker /> : null}
      </section>

      {/* Never priced: the stage still pitches — the four steps at caption size under the hero, lit in sequence (P2-W27). */}
      {empty && !hasPrices ? <HowItWorks variant="stage" sequence className="mr-pv-how" ariaLabel={t('tour.howTitle')} /> : null}

      <section className="mr-pv-savers" aria-labelledby={saversId}>
        <h2 id={saversId} className="mr-pv-savers-title">
          {t('presenter.topSavers')}
        </h2>
        {loading ? (
          <div className="mr-pv-list-skeleton" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} />
            ))}
          </div>
        ) : savers.length > 0 ? (
          <SaversList savers={savers} labels={labels} incidents={incidents} />
        ) : (
          <p className="mr-pv-empty">{t('presenter.topSaversEmpty')}</p>
        )}
      </section>

      {/* The lower half at rest (P2-W04): what the incident card may cover, fading out as a card lands. */}
      {snapshot && !loading ? <RestPanel snapshot={snapshot} tz={settings.displayTimezone} /> : null}

      <footer className="mr-pv-bottom">
        <div className="mr-pv-scene">
          {SceneIndicator && IS_DEMO_BUILD ? (
            <Suspense fallback={null}>
              <SceneIndicator />
            </Suspense>
          ) : null}
        </div>
        <div className="mr-pv-qr">
          {/* The code is the address: no URL line on stage (P1-B03); its aria-label still names it. */}
          <QrBlock url={qrUrl} caption={qrCaption} layout="over" showUrl={false} />
        </div>
      </footer>

      <IncidentTakeover chime={chime} />
      <StageKeys />
    </div>
  );
}
