// src/demo/actions.tsx — the Demo Console's actions, shared by its buttons and the lever keys (SPEC 13).
// DEMO BUILD ONLY.
//
// Every volatile lever — apply / revert / go aggressive / break / restore / spike / calm / reset everything /
// reset baselines / weekly receipt now — and every scene start asks first (REVIEW-3a #7, AGENTS.md
// "Confirming Destructive Operations"). The question names exactly what changes (object ids, the change, and
// "Commits and deploys to worker group default") — see src/demo/confirm.ts — through Capra's imperative
// `Modal.confirm`, which mounts on document.body: the same confirmation opens from a button on the phone and
// from a lever key on the presenter laptop, where no console is mounted. The confirm button takes focus, so
// on stage a lever is its key, then Enter (Esc cancels). Only one confirmation is open at a time; lever keys
// pressed while it is up do nothing. After the job the outcome is reported in a toast.
//
// Not confirmed: Abort on a scene this tab is running (SPEC 11's one-tap brake; it only restores), and the
// left-scene prompt's Resume / Abandon and restore / Dismiss — that prompt is itself the question and names
// what each choice touches.

import { Modal } from '@capra/core';
import { RIG_GROUP_ID } from '../../core/demo/rig-ids.ts';
import type { DemoState } from '../../core/types.ts';
import { tn, t, type CopyKey } from '../copy/en.ts';
import { notify } from '../components/common/notify.tsx';
import type { DemoClient, DemoJob, JobOutcome } from './client.ts';
import { confirmSpecForJob, confirmSpecForScene, type ConfirmContext, type ConfirmSpec } from './confirm.ts';
import { ConfirmContent } from './ConfirmContent.tsx';
import type { SceneRunner } from './sceneRunner.ts';
import { SCENES, SPIKE_INPUT, SPIKE_MULTIPLIER, TRIM_PIPELINE, type PackRouteKey, type SceneName } from './scenes.ts';
import './demo.css';

export interface DemoActionsDeps {
  client: DemoClient;
  runner: SceneRunner;
  /** settings.demo.profile (the 1-minute confirmation), for the break-the-trim toast. */
  demoProfile(): boolean;
  /** demo/state as the store holds it: what the confirmation names (applied packs, broken trims, rates). */
  demoState(): DemoState | null;
  /** Enabled endpoints with the weekly receipt on (the weekly confirmation lists them). */
  weeklyEndpoints(): { id: string; name: string }[];
  /** Worker group the levers commit and deploy to (default: the rig's). */
  groupId?: string;
}

/** Each lever resolves with the job's outcome, or null when nothing ran (cancelled, busy, nothing to change). */
export interface DemoActions {
  applyPack(routeKey: PackRouteKey, level?: 'pack' | 'aggressive'): Promise<JobOutcome | null>;
  revertPack(routeKey: PackRouteKey): Promise<JobOutcome | null>;
  revertAll(): Promise<JobOutcome | null>;
  breakTrim(): Promise<JobOutcome | null>;
  restore(): Promise<JobOutcome | null>;
  spike(): Promise<JobOutcome | null>;
  calm(): Promise<JobOutcome | null>;
  weekly(): Promise<JobOutcome | null>;
  resetAll(): Promise<JobOutcome | null>;
  resetBaselines(): Promise<JobOutcome | null>;
  /** Asks, then starts the scene. Resolves true when it started. */
  startScene(name: SceneName, routeKey?: PackRouteKey): Promise<boolean>;
  /** Abort (one tap) a scene this tab runs; for a left scene, "Abandon and restore". */
  abortScene(): Promise<void>;
  /** Resume a scene left running (the prompt's Resume). */
  resumeScene(): void;
  /** Forget an abandoned scene without restoring anything. */
  dismissScene(): Promise<void>;
  /** A confirmation is on screen (lever keys wait). */
  isConfirming(): boolean;
}

export const streamLabel = (key: PackRouteKey): string => t(`demo.stream.${key}` as CopyKey);
export const sceneTitle = (name: SceneName): string => t(`demo.scene.${name}.title` as CopyKey);

/** The toast for a finished job (success, "already there", or the refusal in plain words). */
export function outcomeMessage(
  outcome: JobOutcome,
  opts: { demoProfile?: boolean } = {},
): { kind: 'success' | 'info' | 'warning' | 'error'; text: string } {
  const job = outcome.job;
  if (!outcome.ok) {
    switch (outcome.error) {
      case 'busy':
        return { kind: 'info', text: t('demo.chipBusy') };
      case 'cancelled':
        return { kind: 'info', text: t('demo.retryCancelled') };
      case 'demo_disabled':
        return { kind: 'warning', text: t('demo.disabledOff') };
      case 'budget':
      case 'rate_limited':
        return { kind: 'warning', text: t('demo.gaveUpBudget') };
      default:
        return {
          kind: 'error',
          text: t('demo.leverFailed', {
            lever: jobLabel(job),
            reason: outcome.message ?? outcome.error ?? '',
          }),
        };
    }
  }
  if (outcome.message === 'no_change') return { kind: 'info', text: t('demo.alreadyThere') };
  switch (job.kind) {
    case 'applyPack':
      return {
        kind: 'success',
        text: job.level === 'aggressive' ? t('demo.aggressiveApplied') : t('demo.packApplied', { stream: streamLabel(job.routeKey) }),
      };
    case 'revertPack':
      return {
        kind: 'success',
        text: t('demo.packReverted', { stream: streamLabel(job.routeKey) }),
      };
    case 'revertAll': {
      if (outcome.message === 'nothing_applied') return { kind: 'info', text: t('demo.nothingApplied') };
      const n = outcome.results.filter((r) => r.ok).length;
      return { kind: 'success', text: tn('demo.revertedAll', n) };
    }
    case 'breakTrim':
      return {
        kind: 'success',
        text: opts.demoProfile ? t('demo.trimBrokenProfile') : t('demo.trimBroken'),
      };
    case 'restoreTrim':
      return { kind: 'success', text: t('demo.trimRestored') };
    case 'setRate':
      return {
        kind: 'success',
        text: job.multiplier > 1 ? t('demo.rateSet') : t('demo.rateCalm'),
      };
    case 'resetAll':
      return { kind: 'success', text: t('demo.resetDone') };
    case 'resetBaselines':
      return { kind: 'success', text: t('demo.baselinesReset') };
    case 'weekly': {
      const w = outcome.weekly;
      if (w?.skipped === 'no_endpoints') return { kind: 'warning', text: t('demo.weeklyNone') };
      if (w && w.endpoints > 0 && w.sent === 0)
        return {
          kind: 'error',
          text: t('demo.weeklyFailed', {
            reason: w.deliveries.at(-1)?.error ?? String(w.deliveries.at(-1)?.status ?? ''),
          }),
        };
      return { kind: 'success', text: tn('receipt.weeklySent', w?.sent ?? 0) };
    }
  }
}

/** A job's name in plain words ("Break the trim", "Apply the pack: Windows"). */
export function jobLabel(job: DemoJob): string {
  switch (job.kind) {
    case 'applyPack':
      if (job.level === 'aggressive') return t('shortcuts.lever.aggressive');
      return job.routeKey === 'pan_firewall'
        ? t('shortcuts.lever.applyPaloAlto')
        : job.routeKey === 'vpc_flow'
          ? t('shortcuts.lever.applyVpc')
          : t('shortcuts.lever.applyWindows');
    case 'revertPack':
      return t('demo.revertOn', { stream: streamLabel(job.routeKey) });
    case 'revertAll':
      return t('shortcuts.lever.revertAll');
    case 'breakTrim':
      return t('shortcuts.lever.breakTrim');
    case 'restoreTrim':
      return t('shortcuts.lever.restore');
    case 'setRate':
      return job.multiplier > 1 ? t('shortcuts.lever.spike') : t('shortcuts.lever.calm');
    case 'resetAll':
      return t('shortcuts.lever.reset');
    case 'resetBaselines':
      return t('demo.resetBaselines');
    case 'weekly':
      return t('shortcuts.lever.weekly');
  }
}

/** The toast for a lever that would change nothing, instead of asking. */
function nothingToDo(job: DemoJob): { kind: 'info' | 'warning'; text: string } {
  switch (job.kind) {
    case 'revertPack':
    case 'revertAll':
      return { kind: 'info', text: t('demo.nothingApplied') };
    case 'weekly':
      return { kind: 'warning', text: t('demo.weeklyNone') };
    default:
      return { kind: 'info', text: t('demo.alreadyThere') };
  }
}

/**
 * Makes Enter confirm (the stage flow: a lever key, then Enter; Esc cancels). react-aria focuses the dialog
 * itself on open, so this moves focus to the confirm button for the first second the dialog is up — unless
 * the member has moved it to another control inside (Tab to Cancel) — and, until the dialog closes, treats
 * an Enter that lands on no button (the dialog, the page) as a press of the confirm button. The imperative
 * modal renders in its own React root, so the dialog is found through the content's `data-confirm-id`.
 * Returns the cleanup.
 */
function enterConfirms(id: string): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const find = () => {
    const dialog = document.querySelector(`[data-confirm-id="${id}"]`)?.closest<HTMLElement>('[role="dialog"]');
    return { dialog, button: dialog?.querySelector<HTMLButtonElement>('button[data-variant="primary"]') ?? null };
  };
  const started = Date.now();
  let timer: number | undefined;
  const tick = () => {
    const { dialog, button } = find();
    if (dialog && button) {
      const active = document.activeElement;
      const moved = active instanceof HTMLElement && dialog.contains(active) && active !== dialog && active !== button;
      if (moved) return;
      if (active !== button) button.focus();
    }
    if (Date.now() - started < 1_000) timer = window.setTimeout(tick, 25);
  };
  timer = window.setTimeout(tick, 0);
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || event.defaultPrevented || event.repeat) return;
    if (event.target instanceof Element && event.target.closest('button')) return; // that button's own Enter
    const { button } = find();
    if (!button || button.disabled) return;
    event.preventDefault();
    button.click();
  };
  document.addEventListener('keydown', onKey, true);
  return () => {
    if (timer !== undefined) window.clearTimeout(timer);
    document.removeEventListener('keydown', onKey, true);
  };
}

export function createDemoActions(deps: DemoActionsDeps): DemoActions {
  const { client, runner } = deps;
  const groupId = deps.groupId ?? RIG_GROUP_ID;
  const ctx = (): ConfirmContext => ({ demoState: deps.demoState(), weeklyEndpoints: deps.weeklyEndpoints(), groupId });
  let open: { close(): void } | null = null;
  let seq = 0;

  const report = (outcome: JobOutcome): JobOutcome => {
    const msg = outcomeMessage(outcome, { demoProfile: deps.demoProfile() });
    notify[msg.kind](msg.text);
    return outcome;
  };
  const run = async (job: DemoJob): Promise<JobOutcome> => report(await client.run(job));

  /** Opens the confirmation; `onConfirm` runs when the member confirms. Resolves true when confirmed. */
  const confirm = (spec: ConfirmSpec, onConfirm: () => void) =>
    new Promise<boolean>((resolve) => {
      const id = `mr-demo-confirm-${++seq}`;
      let confirmed = false;
      const modal = Modal.confirm({
        title: spec.title,
        content: <ConfirmContent spec={spec} id={id} />,
        confirmButtonText: spec.confirmText,
        cancelButtonText: t('demo.cancel'),
        onConfirm: () => {
          confirmed = true;
          // Not awaited: the modal closes at once and the status line shows the lever's progress.
          onConfirm();
        },
      });
      open = modal;
      const release = enterConfirms(id);
      void modal.closed.then(() => {
        release();
        if (open === modal) open = null;
        resolve(confirmed);
      });
    });

  /** Asks about `job`, then runs it. Null when nothing ran. */
  const ask = async (job: DemoJob): Promise<JobOutcome | null> => {
    if (open) return null;
    if (client.status().busy) {
      report({ ok: false, job, results: [], error: 'busy' });
      return null;
    }
    const spec = confirmSpecForJob(job, ctx());
    if (!spec) {
      const msg = nothingToDo(job);
      notify[msg.kind](msg.text);
      return null;
    }
    const started: { outcome?: Promise<JobOutcome> } = {};
    const confirmed = await confirm(spec, () => {
      started.outcome = run(job);
    });
    return confirmed && started.outcome ? started.outcome : null;
  };

  const actions: DemoActions = {
    applyPack: (routeKey, level = 'pack') => ask({ kind: 'applyPack', routeKey, level }),
    revertPack: (routeKey) => ask({ kind: 'revertPack', routeKey }),
    revertAll: () => ask({ kind: 'revertAll' }),
    breakTrim: () => ask({ kind: 'breakTrim', pipelineId: TRIM_PIPELINE }),
    restore: () => ask({ kind: 'restoreTrim' }),
    spike: () => ask({ kind: 'setRate', inputId: SPIKE_INPUT, multiplier: SPIKE_MULTIPLIER }),
    calm: () => ask({ kind: 'setRate', inputId: SPIKE_INPUT, multiplier: 1 }),
    weekly: () => ask({ kind: 'weekly' }),
    resetAll: () => ask({ kind: 'resetAll' }),
    resetBaselines: () => ask({ kind: 'resetBaselines' }),

    async startScene(name, routeKey) {
      if (open || !SCENES[name].supported) return false;
      if (runner.state().scene || deps.demoState()?.scene) {
        notify.info(t('demo.sceneRunningAlready'));
        return false;
      }
      if (client.status().busy) {
        notify.info(t('demo.chipBusy'));
        return false;
      }
      const started: { result?: Promise<boolean> } = {};
      const confirmed = await confirm(confirmSpecForScene(name, routeKey, ctx()), () => {
        started.result = runner.start(name, routeKey).then((r) => {
          if (!r.ok) notify.info(r.reason === 'busy' ? t('demo.chipBusy') : t('demo.sceneRunningAlready'));
          return r.ok;
        });
      });
      return confirmed && started.result ? started.result : false;
    },
    abortScene: () => runner.abort(),
    resumeScene: () => runner.adopt(),
    dismissScene: () => runner.dismiss(),
    isConfirming: () => open !== null,
  };
  return actions;
}
