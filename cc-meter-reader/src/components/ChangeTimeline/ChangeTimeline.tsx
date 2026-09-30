// src/components/ChangeTimeline/ChangeTimeline.tsx — savings ratio over 24 h / 7 d with commit diamonds
// (PRD 8.3, DESIGN_BRIEF 5.4, SPEC 10). SVG only (no canvas), Capra tokens through CSS classes.
//
// Click (or Enter / Space on) a diamond → a hover card: the commit hash and message, who shipped it and
// when, the files it touched, and what moved after it (whatMoved in model.ts). The newest diamond carries
// data-callout="change-marker" for Story mode and the video. Diamonds that an open alert names are drawn
// in the incident colour, so "this commit caused that" reads at a glance.
//
// Zoom (BEAUTY F12): when the last 24 h has commits and they all sit in its last quarter, the chart opens on
// "Changes" — the window from shortly before the first commit to now — so the commits, the dip and the
// recovery fill the plot instead of its last 15 px. "24 h" shows the whole day; the choice is view state only
// (the URL keeps ?timeline=24h|7d). Diamonds closer than a diamond's width stagger upward in rows, and a commit an
// alert names is drawn last, so it is never hidden under another.
//
// Phones and short charts (P1-K03): commits sit in a strip between the axis and its labels, and ones too close to
// tell apart fan out sideways with a leader to their true time — never stacked into the plot, where a column of
// diamonds reads as values. 7 d thins its day labels to fit and runs to now. The commit card docks under the chart
// where it cannot float beside its diamond (narrow or short), and floats beside the diamond — below the legend —
// where it can. Opening it focuses its Close button, not the card.

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { area, curveMonotoneX, line } from 'd3-shape';
import { ToggleButtonGroup, type Key } from '@capra/core';
import { ArrowRight, CloseOutlined } from '@capra/icons';
import type { CommitImpact } from '../../../core/commitImpacts.ts';
import type { Snapshot } from '../../../core/types.ts';
import { Ghost } from '../common/Ghost.tsx';
import { t, tn } from '../../copy/en.ts';
import { commitAuthor } from '../../lib/author.ts';
import { formatPct, formatRelative, formatTimeOfDay } from '../../lib/format.ts';
import { isUnattributedShift, largestAttributed, reversals, settledText, signedMoney } from './money.ts';
import { useNow } from '../../lib/ticker.ts';
import {
  buildMarkers,
  buildSeries,
  markerTime,
  canFit,
  dayTicks,
  fileLabel,
  spreadMarkers,
  timeTicks,
  whatMoved,
  type MovedItem,
  type SeriesPoint,
  type TimelineMarker,
  type TimelineRange,
} from './model.ts';
import './ChangeTimeline.css';

export interface ChangeTimelineProps {
  snapshot: Pick<Snapshot, 'ratioSeries' | 'trend' | 'windowEnd' | 'sweepAt' | 'timeline' | 'flows' | 'incidents'> | null;
  range: TimelineRange;
  onRangeChange: (range: TimelineRange) => void;
  /** IANA zone for axis labels and times (settings.displayTimezone) */
  timeZone?: string;
  humanize?: Record<string, string>;
  /** a "what moved" object was clicked (the Ledger selects its row) */
  onSelectObject?: (objectKey: string) => void;
  /** the snapshot could not be read (P1-K06): the empty chart says so instead of the first-run "No history yet" */
  unavailable?: boolean;
  /** every commit priced (core/commitImpacts.ts, P2-W07), by full hash: the card's dollar line and the chart's annotation */
  impacts?: ReadonlyMap<string, CommitImpact>;
  /**
   * The open commit card, as a short hash, when the parent owns it (the Ledger keeps it in ?commit=, so a "Changes"
   * row can open it). Omit `onSelectCommit` and the timeline keeps its own selection.
   */
  selectedCommit?: string | null;
  onSelectCommit?: (hash: string | null) => void;
  /**
   * The flow a Ledger row's pointer is on (P2-W17): its commits' diamonds light up, its per-minute history is marked
   * on the chart, and the readout names it. The chart never re-scales the flow's own ratio onto the workspace's axis.
   */
  linkedFlow?: LinkedFlow | null;
  /** the pointer (or focus) is on a commit diamond, or left it: the Ledger lights the rows it names (P2-W17) */
  onHoverCommit?: (hash: string | null) => void;
}

export interface LinkedFlow {
  label: string;
  /** the flow's savings ratio now (its sparkline's last point) */
  ratio?: number;
  /** when its per-minute history starts (epoch ms) */
  since?: number;
  /** short hashes of the commits that moved or touched it */
  commits: ReadonlySet<string>;
}

/** The commit strip under the axis (P1-K03): its height, where a marker's centre sits in it, and the axis labels' baseline under it. */
const STRIP = 22;
const MARKER_DY = 11;
const LABEL_DY = STRIP + 14;
const MARGIN = { top: 12, right: 16, bottom: STRIP + 22, left: 44 };
const DIAMOND = 5.5;
/** Centre-to-centre distance of markers fanned out in the strip (a diamond is 11 px wide; the hit boxes just meet). */
const MARKER_GAP = 14;
/** The commit card floats beside its diamond only where it fits: a chart at least this wide and this tall. */
const CARD_W = 340;
const FLOAT_MIN_W = 560;
const FLOAT_MIN_H = 250;
/** Side of the diamond the floating card opens on: left of it once the diamond is past this share of the chart. */
const FLIP_AT = 0.6;
const CARD_OFFSET = 16;

/**
 * The chart box's size, tracked with ResizeObserver. The SVG is absolutely positioned inside it (CSS), so the
 * box's height comes from the card around it (min-height, or the Ledger's lower row stretching it to the alerts
 * rail, P1-K02) and never from the SVG itself — no feedback loop between the two.
 */
function useSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (w: number, h: number) =>
      setSize((prev) => (Math.abs(prev.width - w) < 0.5 && Math.abs(prev.height - h) < 0.5 ? prev : { width: w, height: h }));
    const r = el.getBoundingClientRect();
    apply(r.width, r.height);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) apply(box.width, box.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

function safeZone(tz: string | undefined): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

function tickLabel(ms: number, range: TimelineRange, tz: string, stepIsHour: boolean): string {
  if (range === '7d') {
    const weekday = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      timeZone: tz,
    }).format(ms);
    const day = new Intl.DateTimeFormat('en-US', {
      day: 'numeric',
      timeZone: tz,
    }).format(ms);
    return `${weekday} ${day}`;
  }
  const opts: Intl.DateTimeFormatOptions = stepIsHour
    ? { hour: 'numeric', timeZone: tz }
    : { hour: 'numeric', minute: '2-digit', timeZone: tz };
  return new Intl.DateTimeFormat('en-US', opts).format(ms).replace(/ /g, ' ');
}

function pointTimeLabel(ms: number, range: TimelineRange, tz: string, live = false): string {
  // 7 d's live point is "now", so it reads as a time of day ("Sat 5:20 PM"), not as the day's average.
  if (range === '7d' && live)
    return `${new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz }).format(ms)} ${pointTimeLabel(ms, '24h', tz)}`;
  if (range === '7d')
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: tz,
    }).format(ms);
  return formatTimeOfDay(ms, tz).replace(/ /g, ' ');
}

function diamondPath(cx: number, cy: number, r: number): string {
  return `M${cx},${cy - r}L${cx + r},${cy}L${cx},${cy + r}L${cx - r},${cy}Z`;
}

function nearest(points: readonly SeriesPoint[], t: number): SeriesPoint | undefined {
  if (points.length === 0) return undefined;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid;
    else hi = mid;
  }
  return Math.abs(points[lo].t - t) <= Math.abs(points[hi].t - t) ? points[lo] : points[hi];
}

// ─── Hover card ──────────────────────────────────────────────────────────────

/** Where the card floats inside the chart box (px), or null: docked under the chart, in the card's flow. */
interface CardPlacement {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

interface CommitCardProps {
  marker: TimelineMarker;
  moved: MovedItem[];
  impact?: CommitImpact;
  tz: string;
  placement: CardPlacement | null;
  onClose: () => void;
  onSelectObject?: (objectKey: string) => void;
  /** settings.humanize: an API client's name, when a member gave it one (src/lib/author.ts) */
  labels?: Record<string, string>;
  /** Founder-build r2 ui-13 (BO-15): how the change settled ("Recovered Mon 2:04 AM, reverted by c8b6350"), as Changes lists it. */
  settled?: string;
}

const MAX_FILES = 4;

/** The commit card's money: what the change is worth a day and a year, how many flows moved, and how it was measured. */
function ImpactBlock({ impact }: { impact: CommitImpact }) {
  const moved = impact.moved.length;
  // A workspace or daily price is the whole workspace's shift, not this change's: said as such, no year, neutral ink.
  const shift = isUnattributedShift(impact);
  const tone = impact.status !== 'priced' || shift ? 'flat' : impact.perDayM > 0 ? 'up' : 'down';
  const headline = shift
    ? t('ledger.timeline.impactShiftLine', { amount: signedMoney(impact.perDayM) })
    : impact.status === 'priced'
      ? t('ledger.timeline.impactLine', { amount: signedMoney(impact.perDayM) })
      : impact.status === 'flat'
        ? t('ledger.timeline.impactFlat')
        : t('ledger.timeline.impactUnpriced');
  const detail = [
    impact.status === 'priced' && !shift ? t('ledger.timeline.impactYear', { amount: signedMoney(impact.perYearM) }) : '',
    moved > 0 ? tn('ledger.timeline.impactMoved', moved, { n: moved }) : '',
  ].filter(Boolean);
  return (
    <div
      className={`mr-ct-card-impact is-${tone}`}
      data-testid="commit-impact"
      data-status={impact.status}
      data-basis={impact.basis}
      data-attributed={impact.status === 'priced' ? (shift ? 'false' : 'true') : undefined}
    >
      <p className="mr-ct-card-impact-line mr-num">{headline}</p>
      {detail.length > 0 ? <p className="mr-ct-card-impact-detail mr-num">{detail.join(' · ')}</p> : null}
      {impact.basis ? (
        <p className="mr-ct-card-impact-basis">
          {impact.status === 'priced' && impact.basis !== 'alert'
            ? `${t(`ledger.timeline.impactBasis.${impact.basis}`)}, ${t('ledger.timeline.impactVolume')}`
            : t(`ledger.timeline.impactBasis.${impact.basis}`)}
        </p>
      ) : null}
      {shift ? <p className="mr-ct-card-impact-basis">{t('ledger.timeline.unattributed')}</p> : null}
    </div>
  );
}

function CommitCard({ marker, moved, impact, tz, placement, onClose, onSelectObject, labels, settled }: CommitCardProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const docked = placement === null;
  const now = useNow();
  const c = marker.commit;
  const when = formatTimeOfDay(marker.t, tz).replace(/ /g, ' ');
  const whenLine = t(c.deployedAt ? 'ledger.timeline.deployed' : 'ledger.timeline.committed', { time: when });
  const files = c.files ?? [];

  // Focus lands on Close, not on the card: after keyboard use the card itself would otherwise wear a focus ring
  // around its whole box (P1-K03). A docked card opens below the chart, so it is brought into view.
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    if (docked) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [marker.commit.hash, docked]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div
      ref={ref}
      className={`mr-ct-card${marker.cause ? ' is-cause' : ''}${docked ? ' mr-ct-card--docked' : ''}`}
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      style={placement ?? undefined}
      onKeyDown={onKeyDown}
      data-testid="commit-card"
      data-placement={docked ? 'docked' : 'float'}
    >
      <div className="mr-ct-card-head">
        <span className="mr-ct-card-hash" id={titleId}>
          <span className="mr-ct-card-glyph" aria-hidden="true" />
          {c.hash.slice(0, 7)}
        </span>
        <span className="mr-ct-card-when">
          {whenLine} · {formatRelative(Math.min(marker.t, now), now)}
        </span>
        <button ref={closeRef} type="button" className="mr-ct-card-close" onClick={onClose} aria-label={t('ledger.timeline.close')}>
          <CloseOutlined size="sm" />
        </button>
      </div>
      <p className="mr-ct-card-message">{c.message || t('common.dash')}</p>
      <p className="mr-ct-card-author">{t('ledger.timeline.by', { author: commitAuthor(c.author, labels) })}</p>
      {impact ? <ImpactBlock impact={impact} /> : null}
      {settled ? (
        <p className="mr-ct-card-impact-basis" data-testid="commit-settled">
          {settled}
        </p>
      ) : null}

      <div className="mr-ct-card-section">
        <div className="mr-ct-card-label">{t('ledger.timeline.filesTitle')}</div>
        {files.length === 0 ? (
          <p className="mr-ct-card-empty">{t('ledger.timeline.filesNone')}</p>
        ) : (
          <ul className="mr-ct-card-files">
            {files.slice(0, MAX_FILES).map((f) => (
              <li key={f} className="mr-truncate" title={f}>
                {fileLabel(f)}
              </li>
            ))}
            {files.length > MAX_FILES ? (
              <li className="mr-ct-card-more">
                {t('ledger.timeline.moreFiles', {
                  n: files.length - MAX_FILES,
                })}
              </li>
            ) : null}
          </ul>
        )}
      </div>

      <div className="mr-ct-card-section">
        <div className="mr-ct-card-label">{t('ledger.timeline.movedTitle')}</div>
        {moved.length === 0 ? (
          <p className="mr-ct-card-empty">{t('ledger.timeline.movedNone')}</p>
        ) : (
          <ul className="mr-ct-card-moved">
            {moved.map((m) => {
              const dir = m.before === undefined ? 'new' : m.delta < 0 ? 'down' : 'up';
              const content = (
                <>
                  <span className="mr-ct-moved-label mr-truncate">{m.label}</span>
                  <span className={`mr-ct-moved-figs mr-num is-${dir}`}>
                    {m.before === undefined ? (
                      t('ledger.timeline.movedNow', {
                        after: formatPct(m.after),
                      })
                    ) : (
                      <>
                        {formatPct(m.before)}
                        <span className="mr-ct-moved-arrow" aria-hidden="true">
                          <ArrowRight size="xs" />
                        </span>
                        <span className="mr-visually-hidden"> {t('incidents.arrow')} </span>
                        {formatPct(m.after)}
                      </>
                    )}
                  </span>
                  {m.perDayM !== undefined ? (
                    <span className={`mr-ct-moved-money mr-num is-${m.perDayM < 0 ? 'down' : 'up'}`}>
                      {t('ledger.timeline.movedPerDay', { amount: signedMoney(m.perDayM) })}
                    </span>
                  ) : null}
                </>
              );
              return (
                <li key={m.key}>
                  {onSelectObject ? (
                    <button type="button" className="mr-ct-moved-row" onClick={() => onSelectObject(m.key)}>
                      {content}
                    </button>
                  ) : (
                    <span className="mr-ct-moved-row">{content}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── Chart ───────────────────────────────────────────────────────────────────

export function ChangeTimeline({
  snapshot,
  range,
  onRangeChange,
  timeZone,
  humanize,
  onSelectObject,
  unavailable = false,
  impacts,
  selectedCommit,
  onSelectCommit,
  linkedFlow,
  onHoverCommit,
}: ChangeTimelineProps) {
  const tz = safeZone(timeZone);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const size = useSize(wrapRef);
  const width = size.width;
  // The chart's floor: taller where there is room, so the ratio's bends read at a glance. Beside the alerts rail
  // the card stretches to the rail's height and the chart takes the extra (P1-K02).
  // (Each floor includes the commit strip under the axis, P1-K03.)
  const minHeight = width >= 720 ? 268 : width > 0 && width < 560 ? 184 : 216;
  const height = Math.max(minHeight, Math.floor(size.height));
  const [ownSelected, setOwnSelected] = useState<string | null>(null);
  const controlled = onSelectCommit !== undefined;
  const [hoverT, setHoverT] = useState<number | null>(null);
  const markerRefs = useRef(new Map<string, SVGGElement>());
  const clipId = useId();
  const descId = useId();
  // "Changes" (zoomed) is the default whenever it helps; the member can widen to the whole day.
  const [fitPreferred, setFitPreferred] = useState(true);
  const fitAvailable = useMemo(() => (snapshot ? canFit(snapshot, tz) : false), [snapshot, tz]);
  // A commit the parent selected (a "Changes" row, a pasted ?commit=) that the zoomed view does not show opens the
  // whole day instead (derived, so the zoom preference itself is untouched, P2-W07); older than the day → 7 d below.
  const wantedT = useMemo(() => {
    if (!onSelectCommit || !selectedCommit || !snapshot) return undefined;
    const c = (snapshot.timeline ?? []).find((x) => x.hash.slice(0, 7) === selectedCommit.slice(0, 7));
    return c ? markerTime(c) : undefined;
  }, [onSelectCommit, selectedCommit, snapshot]);
  const fitStart = useMemo(() => (snapshot && fitAvailable ? buildSeries('24h', snapshot, tz, { fit: true }).domain[0] : undefined), [snapshot, fitAvailable, tz]);
  const wantedOutsideFit = wantedT !== undefined && fitStart !== undefined && wantedT < fitStart;
  const fitOn = range === '24h' && fitPreferred && fitAvailable && !wantedOutsideFit;

  const series = useMemo(() => (snapshot ? buildSeries(range, snapshot, tz, { fit: fitOn }) : null), [snapshot, range, tz, fitOn]);
  const markers = useMemo(
    () => (snapshot && series ? buildMarkers(snapshot.timeline ?? [], snapshot.incidents ?? [], series.domain) : []),
    [snapshot, series],
  );

  const plotW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const baseY = MARGIN.top + plotH;

  const x = useCallback(
    (ms: number) => {
      if (!series) return MARGIN.left;
      const [a, b] = series.domain;
      return MARGIN.left + ((ms - a) / (b - a || 1)) * plotW;
    },
    [series, plotW],
  );
  const y = useCallback(
    (ratio: number) => {
      const [lo, hi] = series?.yDomain ?? [0, 1];
      const clamped = Math.min(hi, Math.max(lo, ratio));
      return MARGIN.top + (1 - (clamped - lo) / (hi - lo || 1)) * plotH;
    },
    [series, plotH],
  );

  const paths = useMemo(() => {
    if (!series || plotW <= 0) return { line: [] as string[], area: [] as string[] };
    const ln = line<SeriesPoint>()
      .x((p) => x(p.t))
      .y((p) => y(p.ratio))
      .curve(curveMonotoneX);
    const ar = area<SeriesPoint>()
      .x((p) => x(p.t))
      .y0(baseY)
      .y1((p) => y(p.ratio))
      .curve(curveMonotoneX);
    return {
      line: series.segments.map((s) => (s.length === 1 ? `M${x(s[0].t) - 2},${y(s[0].ratio)}h4` : (ln(s) ?? ''))),
      area: series.segments.filter((s) => s.length > 1).map((s) => ar(s) ?? ''),
    };
  }, [series, plotW, x, y, baseY]);

  const ticks = useMemo(() => {
    if (!series || plotW <= 0) return { xs: [] as number[], hourly: true };
    // One day label per 64 px of plot at most, so they never run into each other on a phone (P1-K03).
    if (range === '7d') return { xs: dayTicks(series.domain, tz, Math.max(2, Math.floor(plotW / 64))), hourly: true };
    const xs = timeTicks(series.domain, tz, Math.min(8, Math.max(4, Math.floor(plotW / 96))));
    const hourly = xs.length < 2 || xs[1] - xs[0] >= 3_600_000;
    return { xs, hourly };
  }, [series, plotW, range, tz]);

  // Each marker's drawn x in the strip under the axis: its true x, fanned out sideways where commits crowd (P1-K03).
  const markerXs = useMemo(
    () =>
      spreadMarkers(
        markers.map((m) => x(m.t)),
        MARKER_GAP,
        [MARGIN.left, MARGIN.left + plotW],
      ),
    [markers, x, plotW],
  );
  const markerY = baseY + MARKER_DY;

  // Paint order: ordinary commits first, then the ones an alert names, so a red diamond is never underneath.
  const drawOrder = useMemo(() => markers.map((_, i) => i).sort((a, b) => Number(markers[a].cause) - Number(markers[b].cause) || a - b), [markers]);

  const selectedMarker =
    markers.find((m) =>
      controlled ? !!selectedCommit && m.commit.hash.slice(0, 7) === selectedCommit.slice(0, 7) : m.commit.hash === ownSelected,
    ) ?? null;
  const select = useCallback(
    (hash: string | null) => {
      if (onSelectCommit) onSelectCommit(hash ? hash.slice(0, 7) : null);
      else setOwnSelected(hash);
    },
    [onSelectCommit],
  );
  const moved = useMemo(
    () => (selectedMarker && snapshot ? whatMoved(selectedMarker.commit, snapshot, { humanize }) : []),
    [selectedMarker, snapshot, humanize],
  );

  // Older than the whole day: the parent's range widens to the week so its diamond is in view (P2-W07).
  useEffect(() => {
    if (wantedT === undefined || selectedMarker || !series || fitOn) return;
    if (range === '24h' && wantedT < series.domain[0]) onRangeChange('7d');
  }, [wantedT, selectedMarker, series, fitOn, range, onRangeChange]);

  // A selection whose commit left the domain (range change, new sweep) simply shows no card.
  const openHash = selectedMarker ? selectedMarker.commit.hash : null;
  const close = useCallback(() => {
    const hash = openHash;
    select(null);
    if (hash) markerRefs.current.get(hash)?.focus();
  }, [openHash, select]);
  useEffect(() => {
    if (!openHash) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      // A "Changes" row opens a card itself: a press on one is not a press outside.
      if (target?.closest('.mr-ct-card') || target?.closest('.mr-ct-marker') || target?.closest('[data-changes-row]')) return;
      select(null);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [openHash, select]);

  const toggle = (m: TimelineMarker) => select(openHash === m.commit.hash ? null : m.commit.hash);

  // The largest priced change in view: the chart shades the time after it and names its dollars (P2-W07).
  // The named change is one priced on its own flows (with its author on the plate): never a workspace or daily shift.
  // A drop that recovered, and the change that undid it, are never the one named (usefulness review, round 2).
  const annotation = useMemo(() => {
    if (!impacts || !series) return undefined;
    const all = [...impacts.values()];
    return largestAttributed(all, series.domain, reversals(all, snapshot));
  }, [impacts, series, snapshot]);
  const annotationBox = useMemo(() => {
    if (!annotation || plotW <= 0) return undefined;
    const ax = x(annotation.t);
    const amount = t('ledger.timeline.movedPerDay', { amount: signedMoney(annotation.perDayM) });
    const text = t('ledger.timeline.annotation', {
      amount: signedMoney(annotation.perDayM),
      hash: annotation.commit.hash.slice(0, 7),
      author: commitAuthor(annotation.commit.author, humanize),
    });
    // One line where it fits inside the shade, else two ("+$66 / day" over "since ec5c108 · s.koelpin"), anchored
    // inside the shade so the words sit on the time they describe; against the plot's right edge when the shade is
    // narrower still. 12 px Open Sans runs about 6.6 px a character: the plate is sized from it, the text never is.
    const width = (str: string) => Math.ceil(str.length * 6.6);
    const right = MARGIN.left + plotW;
    const room = right - ax - 12;
    const oneLine = width(text) <= room;
    const lines = oneLine ? [text] : [amount, text.slice(amount.length).trim()];
    const labelW = Math.max(...lines.map(width));
    const labelX = labelW <= room ? ax + 8 : Math.max(MARGIN.left + 4, right - 4 - labelW);
    // Top of the plot, unless the line runs through there under the label: then its foot, if the line leaves that clear.
    const plateH = 6 + 16 * lines.length;
    const [a, b] = series?.domain ?? [0, 1];
    const tAt = (px: number) => a + ((px - MARGIN.left) / (plotW || 1)) * (b - a);
    const under = (series?.points ?? []).filter((p) => p.t >= tAt(labelX - 8) && p.t <= tAt(labelX + labelW + 8)).map((p) => y(p.ratio));
    const topEdge = MARGIN.top + 4 + plateH;
    const bottomTop = baseY - 4 - plateH;
    const clearTop = under.every((py) => py > topEdge + 2);
    const clearBottom = under.every((py) => py < bottomTop - 2);
    const plateY = clearTop ? MARGIN.top + 4 : bottomTop;
    // Nowhere clear of the line (a short chart on a phone): the words move under the chart and the shade stays.
    const inPlot = clearTop || clearBottom;
    return { x: ax, tone: annotation.perDayM > 0 ? 'up' : 'down', text, lines, labelW, labelX, plateY, plateH, inPlot, hash: annotation.commit.hash.slice(0, 7) };
  }, [annotation, plotW, x, y, series, baseY, humanize]);

  const onPointerMove = (e: ReactPointerEvent<SVGRectElement>) => {
    if (!series) return;
    const rect = (e.currentTarget.ownerSVGElement ?? e.currentTarget).getBoundingClientRect();
    const px = e.clientX - rect.left;
    const [a, b] = series.domain;
    setHoverT(a + ((px - MARGIN.left) / (plotW || 1)) * (b - a));
  };

  const hovered = hoverT !== null && series ? nearest(series.points, hoverT) : undefined;
  const latest = series?.points[series.points.length - 1];
  const readoutPoint = hovered ?? latest;
  const readout =
    linkedFlow && !hovered
      ? linkedFlow.ratio !== undefined
        ? t('ledger.timeline.linkedReadout', { label: linkedFlow.label, pct: formatPct(linkedFlow.ratio) })
        : linkedFlow.label
      : readoutPoint
        ? t('ledger.timeline.readout', {
            time: pointTimeLabel(readoutPoint.t, range, tz, readoutPoint.live === true),
            pct: formatPct(readoutPoint.ratio),
          })
        : '';

  const rangeCaption =
    range === '7d'
      ? t('ledger.timeline.last7d')
      : series?.fitted
        ? t('ledger.timeline.fitCaption', { time: pointTimeLabel(series.domain[0], '24h', tz) })
        : series?.since
        ? t('ledger.timeline.since', {
            time: pointTimeLabel(series.since, '24h', tz),
          })
        : t('ledger.timeline.last24h');
  const hasData = !!series && (series.points.length > 0 || markers.length > 0);
  const weekThin = range === '7d' && !!series && series.points.filter((p) => !p.live).length < 2;
  const yTicks = series ? [series.yDomain[0], (series.yDomain[0] + series.yDomain[1]) / 2, series.yDomain[1]] : [];

  // The commit card (P1-K03). Where the chart is wide and tall enough it floats beside its diamond — left of it
  // past 60 % of the width, right of it before — from the top of the plot, so it never covers the legend's readout
  // or the diamond itself. Elsewhere (phones, short charts) it docks under the chart, inside this card.
  const selIndex = selectedMarker ? markers.indexOf(selectedMarker) : -1;
  const floats = width >= FLOAT_MIN_W && height >= FLOAT_MIN_H;
  let placement: CardPlacement | null = null;
  if (floats && selIndex >= 0) {
    const cardWidth = Math.min(CARD_W, width);
    const at = markerXs[selIndex];
    const left = at > width * FLIP_AT ? at - CARD_OFFSET - cardWidth : at + CARD_OFFSET;
    placement = {
      left: Math.max(0, Math.min(width - cardWidth, left)),
      top: MARGIN.top,
      width: cardWidth,
      maxHeight: Math.max(0, height - MARGIN.top),
    };
  }

  // Founder-build r2 ui-13 (BO-15): how a change settled (recovered / undone), for the commit card as Changes lists it.
  const settledRev = useMemo(() => (impacts ? reversals([...impacts.values()], snapshot) : undefined), [impacts, snapshot]);
  const settledFor = (hash: string): string | undefined => {
    const impact = impacts?.get(hash);
    return impact && settledRev && impact.status === 'priced' && !isUnattributedShift(impact) ? settledText(impact, settledRev, tz) : undefined;
  };

  const cardFor = (marker: TimelineMarker, at: CardPlacement | null) => (
    <CommitCard
      marker={marker}
      moved={moved}
      impact={impacts?.get(marker.commit.hash)}
      tz={tz}
      placement={at}
      labels={humanize}
      settled={settledFor(marker.commit.hash)}
      onClose={close}
      onSelectObject={
        onSelectObject
          ? (key) => {
              // A parent that owns the selection closes the card in the same URL update as it selects the object
              // (two updates in one tick would each start from the same URL, and the second would undo the first).
              if (!controlled) select(null);
              onSelectObject(key);
            }
          : undefined
      }
    />
  );

  return (
    <section className="mr-ct mr-panel" aria-labelledby="mr-ct-title" data-testid="change-timeline">
      <header className="mr-ct-head">
        <div className="mr-ct-titles">
          <h2 id="mr-ct-title" className="mr-ct-title">
            {t('ledger.timeline.title')}
          </h2>
          <p className="mr-ct-caption">
            {t('ledger.timeline.caption')} · {rangeCaption}
          </p>
        </div>
        <div className="mr-ct-toggle">
          <ToggleButtonGroup
            aria-label={t('ledger.timeline.rangeLabel')}
            size="sm"
            disallowEmptySelection
            selectedKeys={new Set<Key>([range === '7d' ? '7d' : fitOn ? 'fit' : '24h'])}
            onSelectionChange={(keys: Set<Key>) => {
              const next = [...keys][0];
              if (next === 'fit') {
                setFitPreferred(true);
                if (range !== '24h') onRangeChange('24h');
              } else if (next === '24h') {
                setFitPreferred(false);
                if (range !== '24h') onRangeChange('24h');
              } else if (next === '7d') {
                onRangeChange('7d');
              }
            }}
            items={[
              ...(fitAvailable ? [{ key: 'fit', text: t('ledger.timeline.rangeFit') }] : []),
              { key: '24h', text: t('ledger.timeline.range24h') },
              { key: '7d', text: t('ledger.timeline.range7d') },
            ]}
          />
        </div>
      </header>

      {hasData ? (
        <div className="mr-ct-legend">
          <span className="mr-ct-legend-item">
            <span className="mr-ct-swatch mr-ct-swatch--line" aria-hidden="true" />
            {t('ledger.timeline.legendRatio')}
          </span>
          <span className="mr-ct-legend-item">
            <span className="mr-ct-swatch mr-ct-swatch--commit" aria-hidden="true" />
            {t('ledger.timeline.legendCommit')}
          </span>
          {markers.some((m) => m.cause) ? (
            <span className="mr-ct-legend-item">
              <span className="mr-ct-swatch mr-ct-swatch--cause" aria-hidden="true" />
              {t('ledger.timeline.legendCause')}
            </span>
          ) : null}
          <span className="mr-ct-readout mr-num" aria-live="off">
            {readout}
          </span>
        </div>
      ) : null}

      <div ref={wrapRef} className="mr-ct-chart" style={{ minHeight }}>
        {!hasData ? (
          <div className="mr-ct-empty">
            <Ghost shape="chart" className="mr-ct-empty-ghost" />
            <p className="mr-ct-empty-title">{t(unavailable ? 'ledger.timeline.unavailableTitle' : 'ledger.timeline.emptyTitle')}</p>
            <p className="mr-ct-empty-body">{t(unavailable ? 'ledger.timeline.unavailableBody' : 'ledger.timeline.emptyBody')}</p>
          </div>
        ) : width > 0 && series ? (
          // A group, not an image (P1-K04, WCAG 4.1.2): an img's children are presentational, which would hide the
          // focusable commit buttons from assistive tech. The drawing itself is aria-hidden; the buttons are named.
          <svg
            className="mr-ct-svg"
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="group"
            aria-label={tn('ledger.timeline.chartName', markers.length, {
              range: range === '7d' ? t('ledger.timeline.last7d') : series.fitted ? rangeCaption : t('ledger.timeline.last24h'),
            })}
            aria-describedby={markers.length > 0 ? descId : undefined}
          >
            {markers.length > 0 ? <desc id={descId}>{t('ledger.timeline.keyboardHint')}</desc> : null}
            <defs>
              <clipPath id={clipId}>
                <rect x={MARGIN.left} y={0} width={plotW} height={baseY + 1} />
              </clipPath>
            </defs>
            <g aria-hidden="true">
              {/* grid + y labels */}
              {yTicks.map((v, i) => (
                <g key={`y${i}`}>
                  <line className="mr-ct-grid" x1={MARGIN.left} x2={MARGIN.left + plotW} y1={y(v)} y2={y(v)} />
                  <text className="mr-ct-axis-label" x={MARGIN.left - 8} y={y(v)} dy="0.32em" textAnchor="end">
                    {formatPct(v)}
                  </text>
                </g>
              ))}
              {/* the largest priced change in view: the time after it, shaded in its direction (P2-W07) */}
              {annotationBox ? (
                <rect
                  className={`mr-ct-shade is-${annotationBox.tone}`}
                  x={annotationBox.x}
                  y={MARGIN.top}
                  width={Math.max(0, MARGIN.left + plotW - annotationBox.x)}
                  height={Math.max(0, plotH)}
                />
              ) : null}
              {/* x axis */}
              <line className="mr-ct-axis" x1={MARGIN.left} x2={MARGIN.left + plotW} y1={baseY} y2={baseY} />
              {ticks.xs.map((ms) => (
                <text key={ms} className="mr-ct-axis-label" x={x(ms)} y={baseY + LABEL_DY} textAnchor="middle">
                  {tickLabel(ms, range, tz, ticks.hourly)}
                </text>
              ))}

              {/* commit guides behind the line, down to the axis at the commit's true time; a marker the strip moved
                  sideways is joined to that point by a short leader */}
              {markers.map((m, i) => {
                const tx = x(m.t);
                const cls = `${m.cause ? ' is-cause' : ''}${openHash === m.commit.hash ? ' is-selected' : ''}`;
                return (
                  <g key={`g${m.commit.hash}`}>
                    <line className={`mr-ct-guide${cls}`} x1={tx} x2={tx} y1={MARGIN.top} y2={baseY} />
                    {Math.abs(markerXs[i] - tx) > 1 ? (
                      <line className={`mr-ct-leader${cls}`} x1={tx} y1={baseY} x2={markerXs[i]} y2={markerY - DIAMOND} />
                    ) : null}
                  </g>
                );
              })}

              {/* the hovered row's flow (P2-W17): its per-minute history marked on the chart */}
              {linkedFlow && series ? (
                <g className="mr-ct-link is-highlighted" data-testid="timeline-link">
                  {linkedFlow.since !== undefined && linkedFlow.since < series.domain[1] ? (
                    <rect
                      className="mr-ct-link-band"
                      x={x(Math.max(series.domain[0], linkedFlow.since))}
                      y={MARGIN.top}
                      width={Math.max(0, MARGIN.left + plotW - x(Math.max(series.domain[0], linkedFlow.since)))}
                      height={Math.max(0, plotH)}
                    />
                  ) : null}
                </g>
              ) : null}
              {/* the ratio (clipped to the plot: a zoomed view keeps one sample before its window) */}
              <g clipPath={`url(#${clipId})`}>
                {paths.area.map((d, i) => (
                  <path key={`a${i}`} className="mr-ct-area" d={d} />
                ))}
                {paths.line.map((d, i) => (
                  <path key={`l${i}`} className="mr-ct-line" d={d} />
                ))}
              </g>
              {latest ? <circle className="mr-ct-now" cx={x(latest.t)} cy={y(latest.ratio)} r={3.5} /> : null}
              {annotationBox?.inPlot ? (
                <g className={`mr-ct-annotation is-${annotationBox.tone}`} data-testid="timeline-annotation" data-commit={annotationBox.hash}>
                  <rect
                    className="mr-ct-annotation-plate"
                    x={annotationBox.labelX - 4}
                    y={annotationBox.plateY}
                    width={annotationBox.labelW + 8}
                    height={annotationBox.plateH}
                    rx={4}
                  />
                  <text className="mr-ct-annotation-text" x={annotationBox.labelX} y={annotationBox.plateY + 14}>
                    {annotationBox.lines.map((line, i) => (
                      <tspan key={i} x={annotationBox.labelX} dy={i === 0 ? 0 : 16}>
                        {line}
                      </tspan>
                    ))}
                  </text>
                </g>
              ) : null}

              {/* hover readout */}
              {hovered ? (
                <g className="mr-ct-hover" aria-hidden="true">
                  <line x1={x(hovered.t)} x2={x(hovered.t)} y1={MARGIN.top} y2={baseY} />
                  <circle cx={x(hovered.t)} cy={y(hovered.ratio)} r={3.5} />
                </g>
              ) : null}
              <rect
                className="mr-ct-hit"
                x={MARGIN.left}
                y={MARGIN.top}
                width={plotW}
                height={Math.max(0, plotH)}
                onPointerMove={onPointerMove}
                onPointerLeave={() => setHoverT(null)}
              />
            </g>

            {/* commit diamonds (in the strip under the axis, fanned out sideways when they crowd; alert-named ones drawn last) */}
            {drawOrder.map((i) => {
              const m = markers[i];
              const cx = markerXs[i];
              const cy = markerY;
              const isSel = openHash === m.commit.hash;
              return (
                <g
                  key={m.commit.hash}
                  ref={(el) => {
                    if (el) markerRefs.current.set(m.commit.hash, el);
                    else markerRefs.current.delete(m.commit.hash);
                  }}
                  className={`mr-ct-marker${m.cause ? ' is-cause' : ''}${isSel ? ' is-selected' : ''}${
                    linkedFlow?.commits.has(m.commit.hash.slice(0, 7)) ? ' is-linked' : ''
                  }`}
                  role="button"
                  tabIndex={0}
                  aria-label={t('ledger.timeline.markerLabel', {
                    hash: m.commit.hash.slice(0, 7),
                    author: commitAuthor(m.commit.author, humanize),
                    time: formatTimeOfDay(m.t, tz).replace(/ /g, ' '),
                  })}
                  aria-expanded={isSel}
                  aria-haspopup="dialog"
                  data-callout={m.newest ? 'change-marker' : undefined}
                  data-commit={m.commit.hash.slice(0, 7)}
                  onClick={() => toggle(m)}
                  onPointerEnter={onHoverCommit ? () => onHoverCommit(m.commit.hash.slice(0, 7)) : undefined}
                  onPointerLeave={onHoverCommit ? () => onHoverCommit(null) : undefined}
                  onFocus={onHoverCommit ? () => onHoverCommit(m.commit.hash.slice(0, 7)) : undefined}
                  onBlur={onHoverCommit ? () => onHoverCommit(null) : undefined}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggle(m);
                    }
                  }}
                >
                  <rect className="mr-ct-marker-hit" x={cx - MARKER_GAP / 2} y={cy - 10} width={MARKER_GAP} height={20} />
                  <path className="mr-ct-marker-ring" d={diamondPath(cx, cy, DIAMOND + 3.5)} />
                  <path className="mr-ct-marker-diamond" d={diamondPath(cx, cy, DIAMOND)} />
                </g>
              );
            })}
          </svg>
        ) : null}

        {weekThin && hasData ? <p className="mr-ct-note">{t('ledger.timeline.weekEmpty')}</p> : null}

        {selectedMarker && placement ? cardFor(selectedMarker, placement) : null}
      </div>

      {annotationBox && !annotationBox.inPlot ? (
        <p className={`mr-ct-annotation-note mr-num is-${annotationBox.tone}`} data-testid="timeline-annotation" data-commit={annotationBox.hash}>
          <span className="mr-ct-annotation-swatch" aria-hidden="true" />
          {annotationBox.text}
        </p>
      ) : null}

      {selectedMarker && !placement ? cardFor(selectedMarker, null) : null}

      {hasData ? <p className="mr-ct-foot">{markers.length === 0 ? t('ledger.timeline.noCommits') : t('ledger.timeline.hint')}</p> : null}
    </section>
  );
}
