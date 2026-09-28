// src/components/Shell/diagRows.ts — the diagnostics panel's rows (EPIC_AUDIT P1-A08), pure so they can be
// tested and copied as plain text: what the App knows about its own state, and nothing it does not read.

import type { Meta, MeteringGap } from '../../../core/types.ts';
import { unmeteredMinutesBetween } from '../../../core/sweep.ts';
import { APP_BUILD_INFO } from '../../lib/env.ts';
import { classifySweepError } from '../../state/selectors.ts';
import type { AppState, SweepSummary } from '../../state/store.ts';

/** The last sweep row turns amber past this age: a minute-cadence meter three sweeps late. */
export const DIAG_STALE_MS = 3 * 60_000;

function hostOf(url: string | undefined): string {
  if (!url) return '(unset)';
  try {
    return new URL(url, window.location.href).host + new URL(url, window.location.href).pathname.replace(/\/[^/]*$/, '/…');
  } catch {
    return '(unparseable)';
  }
}

function msOf(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** "42 s ago" / "7 min ago" / "3 h ago"; '—' when unknown. */
export function ago(value: number | string | undefined, now: number): string {
  const ms = msOf(value);
  if (ms === undefined) return '—';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 120) return `${s} s ago`;
  if (s < 2 * 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/** HH:MM:SSZ of an ISO time or epoch ms; '—' when unknown. */
function utc(value: number | string | undefined): string {
  const ms = msOf(value);
  return ms === undefined ? '—' : `${new Date(ms).toISOString().slice(11, 19)}Z`;
}

/** "in 6 min" / "in 40 s" until a future time; 'now' once it has passed. */
function until(ms: number, now: number): string {
  const s = Math.round((ms - now) / 1000);
  if (s <= 0) return 'now';
  return s < 120 ? `in ${s} s` : `in ${Math.round(s / 60)} min`;
}

/** A stretch of minutes as hours where it is an hour or more: 240 → "4 h (240 min)", 90 → "1.5 h (90 min)", 45 → "45 min". */
function minutesText(min: number): string {
  if (min < 60) return `${min} min`;
  return `${Math.round((min / 60) * 10) / 10} h (${min} min)`;
}

/** A gap's dates: "2026-09-29 12:00–16:00Z", or both dates when it crosses midnight UTC. */
function gapSpan(g: MeteringGap): string {
  const from = msOf(g.from);
  const to = msOf(g.to);
  if (from === undefined || to === undefined) return `${g.from} – ${g.to}`;
  const a = new Date(from).toISOString();
  const b = new Date(to).toISOString();
  return a.slice(0, 10) === b.slice(0, 10) ? `${a.slice(0, 10)} ${a.slice(11, 16)}–${b.slice(11, 16)}Z` : `${a.slice(0, 10)} ${a.slice(11, 16)}Z – ${b.slice(0, 10)} ${b.slice(11, 16)}Z`;
}

/**
 * EPIC_AUDIT P1-E04: the stretches no sweep could meter (older than the Leader keeps metrics when metering resumed),
 * in hours with their dates, newest first (three at most, then how many more). Undefined when there are none.
 */
export function notMeteredLine(gaps: readonly MeteringGap[] | undefined, now: number): string | undefined {
  if (!gaps?.length) return undefined;
  const minutes = unmeteredMinutesBetween(gaps, 0, now);
  if (minutes <= 0) return undefined;
  const newest = [...gaps].reverse();
  const shown = newest.slice(0, 3).map(gapSpan);
  const more = newest.length - shown.length;
  return `${minutesText(minutes)} · ${shown.join(', ')}${more > 0 ? ` · ${more} more` : ''}`;
}

/**
 * EPIC_AUDIT P1-E01: the rate-limit back-off, from meta: until when sweeps are skipped, since when they have met the
 * Leader's limit, and the streak. Undefined when neither time is set (no limit met since the last clean sweep).
 */
export function backOffLine(
  meta: (Pick<Meta, 'rateLimitedSince' | 'rateLimitedUntil'> & { consecutiveRateLimited?: number }) | null | undefined,
  now: number,
): string | undefined {
  const since = msOf(meta?.rateLimitedSince);
  const untilMs = msOf(meta?.rateLimitedUntil);
  if (since === undefined && untilMs === undefined) return undefined;
  const parts: string[] = [];
  if (untilMs !== undefined) parts.push(untilMs > now ? `sweeps skipped until ${utc(untilMs)} (${until(untilMs, now)})` : `back-off ended ${utc(untilMs)}`);
  if (since !== undefined) parts.push(`limited since ${utc(since)} (${ago(since, now)})`);
  parts.push(`${meta?.consecutiveRateLimited ?? 0} rate-limited in a row`);
  return parts.join(' · ');
}

/** The last sweep error, this tab's (with its streak) or meta's, as `kind status · ×n`; 'none' when none. */
function sweepErrorDiag(s: AppState): string {
  const mine = s.status.sweep.lastFailure;
  const code = mine?.code ?? s.meta?.lastError;
  if (!code) return 'none';
  const info = classifySweepError(code, mine?.status);
  const who = mine ? `this tab ×${s.status.sweep.failures ?? 0}` : `meta · ${s.meta?.sweepErrors ?? 0} total`;
  return `${info.kind}${info.status ? ` ${info.status}` : ''} · ${who}`;
}

/** A lock owner id, with whose it is: this tab, another tab, the runner, the backend. */
function ownerLabel(owner: string | undefined, mine: string | undefined): string {
  if (!owner) return '—';
  if (mine && owner === mine) return `${owner} (this tab)`;
  if (owner.startsWith('ui:')) return `${owner} (another tab)`;
  if (owner.startsWith('runner:')) return `${owner} (runner)`;
  if (owner.startsWith('backend:')) return `${owner} (backend)`;
  return owner;
}

/** This tab's last sweep as fields: `ok · ui · 23 calls · 812 ms`, `skipped locked`, `error rate_limited 429`. */
export function sweepResultLine(r: SweepSummary | undefined): string {
  if (!r) return 'none';
  const parts: string[] = [];
  if (r.skipped) parts.push(`skipped ${r.skipped}`);
  else parts.push(r.ok ? 'ok' : 'failed');
  parts.push(r.mode);
  if (r.calls !== undefined) parts.push(`${r.calls} calls`);
  if (r.durationMs !== undefined) parts.push(`${Math.round(r.durationMs)} ms`);
  if (r.error) parts.push(`error ${r.error.length > 80 ? `${r.error.slice(0, 79)}…` : r.error}${r.status ? ` (${r.status})` : ''}`);
  else if (r.status) parts.push(`status ${r.status}`);
  return parts.join(' · ');
}

export interface DiagRow {
  key: string;
  value: string;
  /** 'stale': the row is flagged (the last sweep is over 3 minutes old). */
  state?: 'stale';
}

/** Every row the panel shows (and copies), in order. Pure: `now` is passed in. */
export function diagRows(s: AppState, now: number, win: { apiUrl?: string; basePath?: string } = {}): DiagRow[] {
  const meta = s.meta;
  const sweep = s.status.sweep;
  const errors = Object.entries(s.errors)
    .filter(([, e]) => !!e)
    .map(([doc, e]) => `${doc}: ${e?.kind ?? ''} ${e?.status ?? ''} ${e?.message ?? ''}`.trim());
  const lastSweepMs = msOf(meta?.lastSweepAt);
  const sweepStale = s.source === 'live' && lastSweepMs !== undefined && now - lastSweepMs > DIAG_STALE_MS;
  const through = msOf(meta?.meteredThrough);
  const behindMin = through === undefined ? undefined : Math.max(0, Math.round((now - through) / 60_000));
  const known = meta?.groupsKnown;
  const metered = meta?.groupsMetered;
  // This tab's own Leader calls: its last sweep's, when that sweep ran in the last minute.
  const mineLastMinute = sweep.lastRunAt !== undefined && now - sweep.lastRunAt <= 60_000 ? (sweep.lastResult?.calls ?? 0) : 0;
  const budget = meta?.callsThisMinute;
  // P1-E04 / P1-E01: rows that exist only while there is something to say.
  const notMetered = notMeteredLine(meta?.gaps, now);
  const backOff = backOffLine(meta, now);

  return [
    { key: 'build', value: `${APP_BUILD_INFO.appVersion} · ${APP_BUILD_INFO.build}` },
    { key: 'api', value: hostOf(win.apiUrl) },
    { key: 'basePath', value: String(win.basePath ?? '(unset)') },
    { key: 'theme', value: s.theme },
    { key: 'hydrated', value: `${s.hasHydrated} · phase ${s.status.hydrate.phase} · settings ${s.settingsStored ? 'stored' : 'defaults'}` },
    { key: 'source', value: s.source },
    { key: 'runtime', value: `${s.settings.runtime} · demo ${s.settings.demo.enabled ? 'on' : 'off'}${s.settings.demo.profile ? ' (profile)' : ''}` },
    { key: 'prices', value: s.prices ? `${s.prices.versions.length} version(s)` : 'none' },
    {
      key: 'snapshot',
      value: s.snapshot ? `swept ${utc(s.snapshot.sweepAt)} · ${s.snapshot.flows.length} flows · ${s.snapshot.openIncidents} open` : 'none',
    },
    {
      key: 'last sweep',
      value: meta
        ? `${utc(meta.lastSweepAt)} · ${ago(meta.lastSweepAt, now)} · ${meta.lastSweepMode ?? '—'} · ${meta.lastSweepCalls ?? '—'} calls · ${
            meta.lastSweepMs !== undefined ? `${Math.round(meta.lastSweepMs)} ms` : '—'
          }`
        : 'none',
      ...(sweepStale ? { state: 'stale' as const } : {}),
    },
    { key: 'lock holder', value: `${ownerLabel(meta?.lastSweepOwner, sweep.ownerId)} · last sweep's; the lock's expiry is not read here` },
    {
      key: 'delivery',
      value: meta?.deliveryOwner ? `${ownerLabel(meta.deliveryOwner, sweep.ownerId)} · checked in ${ago(meta.deliveryOwnerAt, now)}` : 'this tab (no runner or backend)',
    },
    { key: 'runner seen', value: sweep.runnerSeenAt !== undefined ? ago(sweep.runnerSeenAt, now) : 'not seen by this tab' },
    {
      key: 'metered through',
      value: through === undefined ? '—' : `${utc(through)} · ${behindMin} min behind now (includes the settle minute and any held empty minutes)`,
    },
    ...(notMetered ? [{ key: 'not metered', value: notMetered }] : []),
    {
      key: 'sweeps',
      value: meta ? `${meta.sweepCount} done · ${meta.sweepErrors} errors · ${meta.consecutiveRateLimited} rate-limited in a row` : '—',
    },
    ...(backOff ? [{ key: 'back-off', value: backOff }] : []),
    { key: 'last error', value: meta?.lastError ?? 'none' },
    {
      key: 'groups',
      value:
        known || metered
          ? `known ${known?.length ?? '—'}${meta?.groupsListedAt ? ` (listed ${ago(meta.groupsListedAt, now)})` : ''} · metered ${metered?.length ?? '—'}${
              metered && metered.length > 0 ? ` (${metered.join(', ')})` : ''
            }`
          : '—',
    },
    {
      key: 'kv',
      value: meta
        ? `${meta.kvDatedKeys ?? '—'} dated keys · expiry pass ${ago(meta.lastExpiredAt, now)}${meta.kvWriteFailingSince ? ` · writes failing since ${utc(meta.kvWriteFailingSince)}` : ''}`
        : '—',
    },
    {
      key: 'calls',
      value: `this tab ${mineLastMinute} in the last minute · shared budget ${budget ? `${budget.calls} in ${budget.minute.slice(11, 16)}Z` : '—'}`,
    },
    { key: 'live', value: `${s.status.live.phase} · last poll ${ago(s.status.live.lastPollAt, now)} · ok ${ago(s.status.live.lastOkAt, now)}` },
    { key: 'this tab', value: `metering ${sweep.metering} · last run ${ago(sweep.lastRunAt, now)} · ${sweepResultLine(sweep.lastResult)}` },
    { key: 'errors', value: errors.length ? errors.join(' | ') : 'none' },
    { key: 'live error', value: s.status.live.lastError ? `${s.status.live.lastError.kind} ${s.status.live.lastError.status ?? ''}`.trim() : 'none' },
    // P0-07: the sweep error, this tab's streak or meta's, classified.
    { key: 'sweep error', value: sweepErrorDiag(s) },
  ];
}

/** The rows as the plain text Copy diagnostics puts on the clipboard. */
export function diagText(rows: readonly DiagRow[], now: number): string {
  const width = Math.max(...rows.map((r) => r.key.length));
  return [
    `Meter Reader diagnostics · ${new Date(now).toISOString()}`,
    ...rows.map((r) => `${r.key.padEnd(width)}  ${r.value}${r.state === 'stale' ? '  [over 3 min old]' : ''}`),
  ].join('\n');
}
