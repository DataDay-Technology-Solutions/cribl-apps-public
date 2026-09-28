// src/views/Demo/panels.tsx — the Demo Console's sections: the alert slot, scenes, levers and tools
// (PRD 8.7, DESIGN_BRIEF 5.7). Presentational: state comes in as props, actions go out as callbacks.

import type { ReactNode } from 'react';
import { Button, Pill, Switch } from '@capra/core';
import { Play } from '@capra/icons';
import type { Incident } from '../../../core/types.ts';
import { t, type CopyKey } from '../../copy/en.ts';
import { formatClock, formatMoney, formatPct, formatRelative } from '../../lib/format.ts';
import { fmtDollars } from '../../../core/format.ts';
import { IncidentCard } from '../../components/IncidentCard/index.ts';
import { sceneTitle, streamLabel } from '../../demo/actions.tsx';
import type { NextAlert, ProjectorLine, RateState, StreamState, TrimLeverPhase, TrimState } from '../../demo/derive.ts';
import { lagBasis, type ConfirmItem } from '../../demo/confirm.ts';
import {
  SCENES,
  VISIBLE_SCENES,
  runOfShow,
  sceneProgress,
  type LeftScene,
  type PersistedScene,
  type SceneName,
  type ShowBeat,
} from '../../demo/scenes.ts';
import { rigSource } from '../../../core/demo/rig-ids.ts';
import type { JobOutcome } from '../../demo/client.ts';

/** The expected alert after a break (src/demo/confirm.ts `alertEta`). */
export interface AlertEta {
  eta: string;
  measured: boolean;
}

/** "Alert expected in ~2:07 after a break · measured lag". */
export function EtaLine({ eta, testId }: { eta: AlertEta; testId?: string }) {
  return (
    <span className="mr-demo-eta mr-demo-tnum" data-testid={testId}>
      <span className="mr-demo-eta-lead">{t('demo.alertEta', { eta: eta.eta })}</span>
      <span aria-hidden="true"> · </span>
      <span>{lagBasis(eta.measured)}</span>
    </span>
  );
}

const secs = (ms: number) => Math.max(0, Math.round(ms / 1000));

function Kbd({ k }: { k: string }) {
  return (
    <>
      <kbd className="mr-kbd mr-demo-kbd" aria-hidden="true">
        {k}
      </kbd>
      <span className="mr-visually-hidden">{t('demo.keyHint', { key: k })}</span>
    </>
  );
}

function SectionHead({ title, id, aside }: { title: string; id: string; aside?: ReactNode }) {
  return (
    <div className="mr-demo-section-head">
      <h2 className="mr-demo-section-title" id={id}>
        {title}
      </h2>
      {aside ? <div className="mr-demo-section-aside">{aside}</div> : null}
    </div>
  );
}

// ─── Alert slot ──────────────────────────────────────────────────────────────
export interface AlertSlotProps {
  focus: { incident: Incident; recovered: boolean } | undefined;
  next: NextAlert | undefined;
  measuredLagSec: number;
  eta: AlertEta;
  nowMs: number;
}

/**
 * The incident card (390 px, no scrolling), the "Next alert expected in ~1:40" countdown, or the quiet state
 * with "Alert expected in ~2:07 after a break" (the measured lag).
 */
export function AlertSlot({ focus, next, measuredLagSec, eta, nowMs }: AlertSlotProps) {
  if (focus) {
    return (
      <section className="mr-demo-alert" aria-labelledby="mr-demo-alert-title" data-testid="demo-alert">
        <h2 className="mr-visually-hidden" id="mr-demo-alert-title">
          {t('demo.sections.alert')}
        </h2>
        {/* Open: the full card, the payoff. Recovered: the compact card with the "closed itself" line. */}
        <IncidentCard incident={focus.incident} variant={focus.recovered ? 'compact' : 'full'} headingLevel="h3" slackPreview="never" />
      </section>
    );
  }
  if (next) {
    const due = next.inMs <= 0;
    const eta = formatClock(secs(next.inMs));
    return (
      <section className="mr-demo-alert" aria-labelledby="mr-demo-alert-title" data-testid="demo-alert">
        <div className="mr-demo-panel mr-demo-next" data-due={due ? 'true' : undefined}>
          <div className="mr-demo-next-text">
            {/* One sentence for screen readers (SPEC 17); the eye reads the lead and the big clock. */}
            <h2 className="mr-visually-hidden" id="mr-demo-alert-title">
              {due ? t('demo.nextAlertDue') : t('demo.nextAlertIn', { eta })}
            </h2>
            <p className="mr-demo-next-title" aria-hidden="true">
              {due ? t('demo.nextAlertDue') : t('demo.nextAlertLead')}
            </p>
            <p className="mr-type-caption mr-demo-tnum">
              {t(`demo.nextAlertCause.${next.cause}` as CopyKey, {
                ago: formatRelative(next.sinceMs, nowMs),
              })}
              <span aria-hidden="true"> · </span>
              {t('demo.nextAlertBasis', { lag: formatClock(measuredLagSec) })}
            </p>
          </div>
          {/* At zero the clock keeps its size and reads 0:00 in the incident colour (EPIC_AUDIT P1-L03). */}
          <span className="mr-demo-next-clock mr-num" aria-hidden="true" data-testid="demo-next-alert">
            {due ? formatClock(0) : `~${eta}`}
          </span>
        </div>
      </section>
    );
  }
  return (
    <section className="mr-demo-alert" aria-labelledby="mr-demo-alert-title" data-testid="demo-alert" data-state="quiet">
      <div className="mr-demo-panel mr-demo-quiet">
        <span className="mr-demo-quiet-dot" aria-hidden="true" />
        <div>
          <h2 className="mr-demo-quiet-title" id="mr-demo-alert-title">
            {t('demo.noAlerts')}
          </h2>
          <p className="mr-type-caption">{t('demo.noAlertsBody')}</p>
          <p className="mr-demo-quiet-eta">
            <EtaLine eta={eta} testId="demo-alert-eta" />
          </p>
        </div>
      </div>
    </section>
  );
}

// ─── Scenes ──────────────────────────────────────────────────────────────────
export interface ScenesPanelProps {
  scene: PersistedScene | null;
  owned: boolean;
  aborting: boolean;
  failed?: JobOutcome;
  brokenAtMs?: number;
  measuredLagSec: number;
  nowMs: number;
  /** Levers can't start (one in flight, demo mode off, sample data). */
  blocked: boolean;
  onStart(name: SceneName): void;
  onAbort(): void;
}

function SceneProgressCard({
  scene,
  owned,
  aborting,
  failed,
  brokenAtMs,
  measuredLagSec,
  nowMs,
  onAbort,
}: Omit<ScenesPanelProps, 'blocked' | 'onStart'> & { scene: PersistedScene }) {
  const p = sceneProgress(scene, nowMs, {
    measuredLagSec,
    ...(brokenAtMs !== undefined ? { brokenAtMs } : {}),
  });
  if (!p) return null;
  const title = t('demo.sceneRunning', { scene: sceneTitle(p.name) });
  const stepText = t(`demo.step.${p.label}` as CopyKey);
  let detail: string | undefined;
  if (p.sinceBreakMs !== undefined && (p.label === 'waitingAlert' || p.label === 'breaking')) {
    detail =
      p.alertInMs !== undefined && p.alertInMs > 0
        ? t('demo.progressBroke', {
            ago: formatRelative(nowMs - p.sinceBreakMs, nowMs),
            eta: formatClock(secs(p.alertInMs)),
          })
        : t('demo.progressBrokeDue', {
            ago: formatRelative(nowMs - p.sinceBreakMs, nowMs),
          });
  } else if (p.stepRemainingMs !== undefined) {
    detail =
      p.label === 'holding' || p.label === 'applied' || p.label === 'pausing'
        ? t('demo.progressLeft', { left: formatClock(secs(p.stepRemainingMs)) })
        : t('demo.progressWaitsUpTo', {
            left: formatClock(secs(p.stepRemainingMs)),
          });
  }
  return (
    <div className="mr-demo-panel mr-demo-scene-run" data-testid="demo-scene-running" data-scene={p.name} data-step={p.label}>
      <div className="mr-demo-scene-run-head">
        <div>
          <p className="mr-demo-scene-run-title">{title}</p>
          <p className="mr-type-caption mr-num">
            {t('demo.stepOf', {
              n: Math.min(p.index + 1, p.total),
              total: p.total,
            })}
          </p>
        </div>
        {failed ? (
          <Pill appearance="danger" variant="muted">
            {t('demo.sceneFailedTitle')}
          </Pill>
        ) : null}
      </div>
      <RunOfShow beats={runOfShow(scene, nowMs, { measuredLagSec })} />
      <p className="mr-demo-scene-run-step">{stepText}</p>
      {detail ? (
        <p className="mr-demo-scene-run-detail mr-demo-tnum" data-testid="demo-scene-progress">
          {detail}
        </p>
      ) : null}
      {failed ? <p className="mr-demo-scene-run-error">{failed.message ?? failed.error}</p> : null}
      <div className="mr-demo-actions-1">
        <Button
          variant="secondary"
          appearance="danger"
          size="xl"
          block
          pending={aborting}
          disabled={aborting || (!owned && !scene)}
          onPress={onAbort}
        >
          {aborting ? t('demo.aborting') : t('demo.abort')}
        </Button>
      </div>
      <p className="mr-type-caption">{t('demo.abortHint')}</p>
    </div>
  );
}

/** A beat in words: "Apply the pack · Windows workstations", "Spike Payments API ×5", "Alert lands". */
function beatText(b: ShowBeat): string {
  const source = b.inputId ? (rigSource(b.inputId)?.label ?? b.inputId) : '';
  return t(`demo.show.beat.${b.label}` as CopyKey, {
    stream: b.routeKey ? streamLabel(b.routeKey) : '',
    source,
    multiplier: String(b.multiplier ?? ''),
  });
}

/**
 * The scene's run of show (EPIC_AUDIT P2-W18): its beats as receipt lines with the time each happened — or,
 * with "~", when it is expected — and a caret on the one that happens next. Replaces the anonymous progress
 * segments. src/demo/scenes.ts `runOfShow` holds the timing.
 */
function RunOfShow({ beats }: { beats: ShowBeat[] }) {
  if (beats.length === 0) return null;
  return (
    <div className="mr-demo-show-wrap">
      <ol className="mr-demo-show" aria-label={t('demo.show.title')} data-testid="demo-run-of-show">
        {beats.map((b) => {
          const clock = b.atMs === undefined ? undefined : formatClock(secs(b.atMs));
          return (
            <li
              key={b.index}
              className="mr-demo-show-beat"
              data-state={b.state}
              data-label={b.label}
              data-estimated={b.estimated ? 'true' : undefined}
              aria-current={b.state === 'now' ? 'step' : undefined}
              data-testid="demo-show-beat"
            >
              <span className="mr-demo-show-mark" aria-hidden="true" />
              <span className="mr-demo-show-label">{beatText(b)}</span>
              {b.state === 'done' ? <span className="mr-visually-hidden">{` · ${t('demo.show.done')}`}</span> : null}
              <span className="mr-demo-show-leader" aria-hidden="true" />
              <span className="mr-demo-show-time mr-num">
                {clock === undefined ? t('common.dash') : b.estimated ? t('demo.show.estimate', { time: clock }) : clock}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="mr-type-caption">{t('demo.show.basis')}</p>
    </div>
  );
}

export function ScenesPanel(props: ScenesPanelProps) {
  const { scene, blocked, onStart } = props;
  return (
    <section className="mr-demo-section" aria-labelledby="mr-demo-scenes">
      <SectionHead title={t('demo.sections.scenes')} id="mr-demo-scenes" />
      {scene ? <SceneProgressCard {...props} scene={scene} /> : null}
      <ul className="mr-demo-list mr-demo-panel" data-testid="demo-scenes">
        {VISIBLE_SCENES.map((name) => {
          const def = SCENES[name];
          const title = sceneTitle(name);
          const disabled = blocked || Boolean(scene);
          return (
            <li key={name} className="mr-demo-row mr-demo-scene" data-scene={name}>
              <div className="mr-demo-row-text">
                <div className="mr-demo-row-title">
                  <span>{title}</span>
                  <span className="mr-demo-duration mr-num">{t('demo.sceneMinutes', { n: def.approxMinutes })}</span>
                </div>
                <p className="mr-type-caption">{t(`demo.scene.${name}.body` as CopyKey)}</p>
              </div>
              <div className="mr-demo-row-action">
                <Button
                  variant="secondary"
                  size="xl"
                  leadingIcon={Play}
                  disabled={disabled}
                  aria-label={t('demo.startSceneLabel', { scene: title })}
                  onPress={() => onStart(name)}
                >
                  {t('demo.startScene')}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ─── A scene left running (REVIEW-3a #8) ─────────────────────────────────────
export interface LeftScenePromptProps {
  left: LeftScene;
  nowMs: number;
  /** What Abandon and restore undoes (src/demo/confirm.ts `abandonItems`). */
  restores: { items: ConfirmItem[]; deployGroup?: string };
  /** Demo mode off, a lever in flight here or on another device. */
  disabled: boolean;
  onResume(): void;
  onAbandon(): void;
  onDismiss(): void;
}

function ItemList({ items }: { items: ConfirmItem[] }) {
  return (
    <ul className="mr-demo-left-list">
      {items.map((a, i) => (
        <li key={`${a.id ?? a.label}-${i}`} className="mr-demo-left-item">
          <span className="mr-demo-left-label">{a.label}</span>
          {a.id ? <code className="mr-demo-left-id">{a.id}</code> : null}
          <span className="mr-demo-left-action">{a.action}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * "A scene was left running (Regression, step 2 of 5, started 12 min ago) — Resume / Abandon and restore".
 * Nothing resumes on mount; this card is the question, so it names what each choice touches. A scene that
 * has not moved for 30 minutes is shown as abandoned: restore what it changed, or dismiss it.
 */
export function LeftScenePrompt({ left, nowMs, restores, disabled, onResume, onAbandon, onDismiss }: LeftScenePromptProps) {
  const scene = sceneTitle(left.name);
  const detail = t('demo.left.detail', {
    scene,
    n: left.step,
    total: left.total,
    ago: formatRelative(left.startedMs, nowMs),
  });
  const nothing = restores.items.length === 0;
  const list = nothing ? (
    <p className="mr-type-caption">{t('demo.left.nothing')}</p>
  ) : (
    <>
      <p className="mr-demo-left-caption">{left.abandoned ? t('demo.left.restoreTitle') : t('demo.left.restores')}</p>
      <ItemList items={restores.items} />
      {restores.deployGroup ? (
        <p className="mr-type-caption">{t('demo.confirm.deploys', { group: restores.deployGroup })}</p>
      ) : null}
    </>
  );
  return (
    <section
      className="mr-demo-panel mr-demo-left"
      aria-labelledby="mr-demo-left-title"
      data-testid="demo-left-scene"
      data-abandoned={left.abandoned ? 'true' : 'false'}
      data-scene={left.name}
    >
      <div className="mr-demo-left-text">
        <h2 className="mr-demo-left-title" id="mr-demo-left-title">
          {left.abandoned ? t('demo.left.abandonedTitle') : t('demo.left.title')}
        </h2>
        <p className="mr-demo-left-detail mr-demo-tnum">
          {detail}
          {left.abandoned ? null : (
            <>
              <span aria-hidden="true"> · </span>
              {t('demo.left.moved', { ago: formatRelative(left.movedMs, nowMs) })}
            </>
          )}
        </p>
        {left.abandoned ? (
          <p className="mr-type-caption">{t('demo.left.abandonedBody')}</p>
        ) : left.next ? (
          <p className="mr-type-caption">{t('demo.left.next', { step: t(`demo.step.${left.next.label}` as CopyKey) })}</p>
        ) : null}
        {list}
      </div>
      <div className="mr-demo-actions-2 mr-demo-left-actions">
        {left.abandoned ? (
          <>
            <Button variant="secondary" size="xl" block disabled={disabled || nothing} onPress={onAbandon}>
              {t('demo.left.restore')}
            </Button>
            <Button variant="secondary" size="xl" block disabled={disabled} onPress={onDismiss}>
              {t('demo.left.dismiss')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="primary" size="xl" block disabled={disabled} onPress={onResume}>
              {t('demo.left.resume')}
            </Button>
            <Button variant="secondary" appearance="danger" size="xl" block disabled={disabled} onPress={onAbandon}>
              {t('demo.left.abandon')}
            </Button>
          </>
        )}
      </div>
      {left.abandoned ? <p className="mr-type-caption">{t('demo.left.dismissHint')}</p> : null}
    </section>
  );
}

// ─── Levers ──────────────────────────────────────────────────────────────────
const STREAM_KEY: Record<StreamState['key'], string> = {
  windows_workstations: '1',
  pan_firewall: '2',
  vpc_flow: '3',
};

function StateDot({ tone, label, testId }: { tone: 'raw' | 'saved' | 'broken' | 'warm'; label: string; testId?: string }) {
  return (
    <span className="mr-demo-state" data-tone={tone} data-testid={testId}>
      <span className="mr-demo-state-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export interface LeversPanelProps {
  streams: StreamState[];
  trim: TrimState;
  /** Break → countdown → Restore (src/demo/derive.ts `trimLever`). */
  lever: TrimLeverPhase;
  rate: RateState;
  eta: AlertEta;
  disabled: boolean;
  onApply(key: StreamState['key']): void;
  onRevert(key: StreamState['key']): void;
  onAggressive(): void;
  onRevertAll(): void;
  onBreak(): void;
  onRestore(): void;
  onSpike(): void;
  onCalm(): void;
}

function measured(s: { ratio?: number; savedPerDayM?: number; measuring?: boolean }): string {
  if (s.measuring) return t('demo.measuring');
  if (s.ratio === undefined) return t('demo.notMeasured');
  const pct = t('demo.saving', { pct: formatPct(s.ratio) });
  return s.savedPerDayM !== undefined ? `${pct} · ${formatMoney(s.savedPerDayM)} ${t('units.perDay')}` : pct;
}

export function LeversPanel(p: LeversPanelProps) {
  const anyApplied = p.streams.some((s) => s.level !== 'raw');
  const windows = p.streams.find((s) => s.key === 'windows_workstations');
  return (
    <section className="mr-demo-section" aria-labelledby="mr-demo-levers">
      <SectionHead title={t('demo.sections.levers')} id="mr-demo-levers" />

      <div className="mr-demo-panel mr-demo-group" data-testid="demo-packs">
        <h3 className="mr-demo-group-title">{t('demo.sections.packs')}</h3>
        <ul className="mr-demo-list">
          {p.streams.map((s) => {
            const applied = s.level !== 'raw';
            const label = streamLabel(s.key);
            return (
              <li key={s.key} className="mr-demo-row" data-stream={s.key} data-level={s.level}>
                <div className="mr-demo-row-text">
                  <p className="mr-demo-row-title">{label}</p>
                  <p className="mr-demo-row-meta">
                    <StateDot
                      tone={applied ? 'saved' : 'raw'}
                      label={t(`demo.level.${s.level}` as CopyKey)}
                      testId={`demo-level-${s.key}`}
                    />
                    <span className="mr-type-caption mr-demo-tnum">{applied ? measured(s) : t(`demo.packName.${s.key}` as CopyKey)}</span>
                  </p>
                </div>
                <div className="mr-demo-row-action mr-demo-keyed">
                  <Button
                    variant="secondary"
                    size="xl"
                    disabled={p.disabled}
                    aria-label={applied ? t('demo.revertOn', { stream: label }) : t('demo.applyTo', { stream: label })}
                    onPress={() => (applied ? p.onRevert(s.key) : p.onApply(s.key))}
                  >
                    {applied ? t('demo.revert') : t('demo.apply')}
                  </Button>
                  {/* Key 1 / 2 / 3 only ever applies, so Revert carries no key. */}
                  {applied ? null : <Kbd k={STREAM_KEY[s.key]} />}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="mr-demo-actions-2">
          <div className="mr-demo-keyed">
            <Button variant="secondary" size="xl" block disabled={p.disabled || windows?.level === 'aggressive'} onPress={p.onAggressive}>
              {t('demo.goAggressive')}
            </Button>
            <Kbd k="G" />
          </div>
          <div className="mr-demo-keyed">
            <Button variant="secondary" size="xl" block disabled={p.disabled || !anyApplied} onPress={p.onRevertAll}>
              {t('demo.revertAll')}
            </Button>
            <Kbd k="V" />
          </div>
        </div>
      </div>

      <div className="mr-demo-panel mr-demo-group" data-testid="demo-trim">
        <h3 className="mr-demo-group-title">{t('demo.sections.trim')}</h3>
        <div className="mr-demo-row mr-demo-row--flat">
          <div className="mr-demo-row-text">
            <p className="mr-demo-row-title">{t('demo.trimTarget')}</p>
            <p className="mr-demo-row-meta">
              <StateDot
                tone={p.trim.broken ? 'broken' : 'saved'}
                label={p.trim.broken ? t('demo.trimBrokenState') : t('demo.trimIntact')}
                testId="demo-trim-state"
              />
              <span className="mr-type-caption mr-demo-tnum">{measured(p.trim)}</span>
            </p>
            {p.trim.broken ? null : (
              <p className="mr-type-caption">
                <EtaLine eta={p.eta} testId="demo-trim-eta" />
              </p>
            )}
          </div>
        </div>
        <TrimLeverButtons
          className="mr-demo-actions-2 mr-demo-trim-actions"
          lever={p.lever}
          disabled={p.disabled}
          keys
          onBreak={p.onBreak}
          onRestore={p.onRestore}
        />
      </div>

      <div className="mr-demo-panel mr-demo-group" data-testid="demo-rate">
        <h3 className="mr-demo-group-title">{t('demo.sections.rate')}</h3>
        <div className="mr-demo-row mr-demo-row--flat">
          <div className="mr-demo-row-text">
            <p className="mr-demo-row-meta">
              <StateDot
                tone={p.rate.multiplier > 1 ? 'warm' : 'raw'}
                label={p.rate.multiplier > 1 ? t('demo.rateSpiked', { multiplier: String(p.rate.multiplier) }) : t('demo.rateNormal')}
                testId="demo-rate-state"
              />
            </p>
          </div>
        </div>
        <div className="mr-demo-actions-2">
          <div className="mr-demo-keyed">
            <Button variant="secondary" size="xl" block disabled={p.disabled || p.rate.multiplier > 1} onPress={p.onSpike}>
              {t('demo.spike')}
            </Button>
            <Kbd k="S" />
          </div>
          <div className="mr-demo-keyed">
            <Button variant="secondary" size="xl" block disabled={p.disabled || p.rate.multiplier === 1} onPress={p.onCalm}>
              {t('demo.calm')}
            </Button>
            <Kbd k="C" />
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Tools ───────────────────────────────────────────────────────────────────
export interface ToolsPanelProps {
  disabled: boolean;
  replayOn: boolean;
  replayDisabled: boolean;
  onReset(): void;
  onResetBaselines(): void;
  onWeekly(): void;
  onReplay(next: boolean): void;
  onPresenter(): void;
  onTour(): void;
  onStory(): void;
  onStoryLive(): void;
}

/**
 * Resets, the replay switch, and the four ways onto the stage as real buttons (EPIC_AUDIT P1-L02): Open
 * presenter (the stage, /?present=1 — what P opens from the Receipt), the tour, the story on the enterprise
 * sample, and the story of the recorded live run (?story=live, D44). On the laptop this panel is a third
 * column at ≥ 1440 px and sits under Scenes below that, so every lever and tool is above the fold of a
 * 1440 × 900 presenter laptop.
 */
export function ToolsPanel(p: ToolsPanelProps) {
  return (
    <section className="mr-demo-section" aria-labelledby="mr-demo-tools" data-testid="demo-tools">
      <SectionHead title={t('demo.sections.tools')} id="mr-demo-tools" />
      <div className="mr-demo-panel mr-demo-group">
        <div className="mr-demo-tools-grid">
          <div className="mr-demo-keyed">
            <Button variant="secondary" size="xl" block disabled={p.disabled} onPress={p.onReset}>
              {t('demo.resetEverything')}
            </Button>
            <Kbd k="0" />
          </div>
          <Button variant="secondary" size="xl" block disabled={p.disabled} onPress={p.onResetBaselines}>
            {t('demo.resetBaselines')}
          </Button>
          <div className="mr-demo-keyed">
            <Button variant="secondary" size="xl" block disabled={p.disabled} onPress={p.onWeekly}>
              {t('demo.weeklyNow')}
            </Button>
            <Kbd k="W" />
          </div>
        </div>
        <div className="mr-demo-divider" role="presentation" />
        <div className="mr-demo-row mr-demo-row--flat mr-demo-replay">
          <div className="mr-demo-row-text">
            <p className="mr-demo-row-title" id="mr-demo-replay-label">
              {t('demo.replay')}
            </p>
            <p className="mr-type-caption">{p.replayOn ? t('demo.replayOn') : t('demo.replayOff')}</p>
          </div>
          <div className="mr-demo-switch">
            <Switch
              aria-labelledby="mr-demo-replay-label"
              checked={p.replayOn}
              disabled={p.replayDisabled}
              onChange={(e) => p.onReplay(e.target.checked)}
            />
          </div>
        </div>
        <div className="mr-demo-divider" role="presentation" />
        <div className="mr-demo-tools-grid mr-demo-tools-grid--stage" data-testid="demo-stage-tools">
          <div className="mr-demo-keyed">
            <Button variant="secondary" size="xl" block onPress={p.onPresenter}>
              {t('demo.openPresenter')}
            </Button>
            <Kbd k="P" />
          </div>
          <Button variant="secondary" size="xl" block onPress={p.onTour}>
            {t('demo.tour')}
          </Button>
          <Button variant="secondary" size="xl" block onPress={p.onStory}>
            {t('demo.story')}
          </Button>
          <Button variant="secondary" size="xl" block onPress={p.onStoryLive}>
            {t('demo.storyLive')}
          </Button>
        </div>
        <p className="mr-type-caption mr-demo-hint-desktop">{t('demo.presenterHint')}</p>
      </div>
    </section>
  );
}

// ─── The trim lever: Break → countdown → Restore (EPIC_AUDIT P2-W18) ─────────
/**
 * Intact: Break the trim (danger) + Restore (disabled). Broken, alert not in yet: the Break slot becomes the
 * countdown — "Alert in ~1:40", disabled, tabular, red edge — beside Restore. The alert is open: one Restore,
 * the only thing left to do. Keys (B, R) only on the laptop's page lever.
 */
function TrimLeverButtons({
  className,
  testId,
  lever,
  disabled,
  keys,
  onBreak,
  onRestore,
}: {
  className: string;
  testId?: string;
  lever: TrimLeverPhase;
  disabled: boolean;
  keys?: boolean;
  onBreak(): void;
  onRestore(): void;
}) {
  const keyed = (button: ReactNode, k: string) =>
    keys ? (
      <div className="mr-demo-keyed">
        {button}
        <Kbd k={k} />
      </div>
    ) : (
      button
    );
  if (lever.phase === 'open') {
    return (
      <div className={className} data-lever="open" data-testid={testId}>
        <div className="mr-demo-lever-solo">
          {keyed(
            <Button variant="primary" size="xl" block disabled={disabled} onPress={onRestore}>
              {t('demo.restore')}
            </Button>,
            'R',
          )}
        </div>
      </div>
    );
  }
  const broken = lever.phase !== 'intact';
  const first =
    lever.phase === 'waiting' ? (
      <div className="mr-demo-countdown" data-due={lever.inMs <= 0 ? 'true' : undefined} data-testid="demo-lever-countdown">
        <Button variant="secondary" size="xl" block disabled>
          {lever.inMs > 0 ? t('demo.alertIn', { eta: formatClock(secs(lever.inMs)) }) : t('demo.nextAlertDue')}
        </Button>
      </div>
    ) : (
      keyed(
        <Button variant="primary" appearance="danger" size="xl" block disabled={disabled || broken} onPress={onBreak}>
          {t('demo.breakTrim')}
        </Button>,
        'B',
      )
    );
  return (
    <div className={className} data-lever={lever.phase} data-testid={testId}>
      {first}
      {keyed(
        <Button variant="secondary" size="xl" block disabled={disabled || !broken} onPress={onRestore}>
          {t('demo.restore')}
        </Button>,
        'R',
      )}
    </div>
  );
}

// ─── What the room sees (phone) ──────────────────────────────────────────────
/** "Projector: $8,112,345 · no alert" — one line under the pinned status on the phone (EPIC_AUDIT P2-W18). */
export function ProjectorStrip({ line }: { line: ProjectorLine | undefined }) {
  if (!line) return null;
  return (
    <p className="mr-demo-projector mr-demo-tnum" data-testid="demo-projector" data-alert={line.alertOpen ? 'true' : undefined}>
      <span className="mr-demo-projector-figure">{t('demo.projector', { amount: fmtDollars(line.valueM) })}</span>
      <span aria-hidden="true"> · </span>
      <span className="mr-demo-projector-state">{line.alertOpen ? t('demo.projectorAlert') : t('demo.projectorQuiet')}</span>
    </p>
  );
}

// ─── Bottom bar (phone) ──────────────────────────────────────────────────────
export function BottomBar({
  lever,
  disabled,
  onBreak,
  onRestore,
}: {
  lever: TrimLeverPhase;
  disabled: boolean;
  onBreak(): void;
  onRestore(): void;
}) {
  return (
    <TrimLeverButtons
      className="mr-demo-bottombar"
      testId="demo-bottombar"
      lever={lever}
      disabled={disabled}
      onBreak={onBreak}
      onRestore={onRestore}
    />
  );
}
