// src/demo/keyboard.ts — the lever keys of the one keyboard map (SPEC 13, PRD 8.7). DEMO BUILD ONLY.
//
//   1 / A  apply the pack: Windows      2  Palo Alto      3  VPC Flow      G  go aggressive (Windows)
//   V      revert all                   B  break the trim                  R  restore
//   S      spike payments-api ×5        C  calm           W  weekly receipt now      0  reset everything
//
// The shell owns the single keydown listener (src/components/Shell/useShellEffects.ts) and P / Y / ? / '/'.
// This module only ADDS handlers to the same registry (src/lib/shortcuts.ts `registerShortcut`), so text
// fields and modifier chords are already excluded there. The keys are registered only while demo mode is
// on, the data on screen is live, and settings are hydrated; they are unregistered the moment that stops.
// Every key shows the 2-second chip and opens the same confirmation the console's button opens
// (REVIEW-3a #7): the confirm button has focus, so a lever on stage is its key, then Enter (Esc cancels).
// While a confirmation is up, lever keys do nothing (one question at a time).

import { registerShortcut, showShortcutChip } from '../lib/shortcuts.ts';
import { t, type CopyKey } from '../copy/en.ts';
import type { DemoActions } from './actions.tsx';

export interface LeverKeyDef {
  /** As printed on the key cap. */
  key: string;
  /** The chip / sheet label. */
  chip: CopyKey;
  run(actions: DemoActions): unknown;
}

export const LEVER_KEYS: readonly LeverKeyDef[] = [
  {
    key: '1',
    chip: 'shortcuts.lever.applyWindows',
    run: (a) => a.applyPack('windows_workstations'),
  },
  {
    key: 'A',
    chip: 'shortcuts.lever.applyWindows',
    run: (a) => a.applyPack('windows_workstations'),
  },
  {
    key: '2',
    chip: 'shortcuts.lever.applyPaloAlto',
    run: (a) => a.applyPack('pan_firewall'),
  },
  {
    key: '3',
    chip: 'shortcuts.lever.applyVpc',
    run: (a) => a.applyPack('vpc_flow'),
  },
  {
    key: 'G',
    chip: 'shortcuts.lever.aggressive',
    run: (a) => a.applyPack('windows_workstations', 'aggressive'),
  },
  { key: 'V', chip: 'shortcuts.lever.revertAll', run: (a) => a.revertAll() },
  {
    key: 'B',
    chip: 'shortcuts.lever.breakTrim',
    run: (a) => a.breakTrim(),
  },
  { key: 'R', chip: 'shortcuts.lever.restore', run: (a) => a.restore() },
  { key: 'S', chip: 'shortcuts.lever.spike', run: (a) => a.spike() },
  { key: 'C', chip: 'shortcuts.lever.calm', run: (a) => a.calm() },
  { key: 'W', chip: 'shortcuts.lever.weekly', run: (a) => a.weekly() },
  { key: '0', chip: 'shortcuts.lever.reset', run: (a) => a.resetAll() },
];

export interface LeverKeysDeps {
  actions: DemoActions;
  /** Demo build + demo mode on + live data + hydrated. */
  isEnabled(): boolean;
  /** Re-checks `isEnabled` whenever this fires (the store subscription). */
  subscribe(listener: () => void): () => void;
  /** A lever is in flight here (keys then only show the busy chip). */
  isBusy(): boolean;
  /** Overridable for tests. */
  register?: typeof registerShortcut;
  chip?: (label: string) => void;
}

/** Registers the lever keys while enabled; returns the teardown. */
export function installLeverKeys(deps: LeverKeysDeps): () => void {
  const register = deps.register ?? registerShortcut;
  const chip = deps.chip ?? showShortcutChip;
  let offs: (() => void)[] = [];

  const on = () => {
    offs = LEVER_KEYS.map((def) =>
      register(def.key, () => {
        if (deps.actions.isConfirming()) return;
        if (deps.isBusy()) {
          chip(t('demo.chipBusy'));
          return;
        }
        chip(t(def.chip));
        void def.run(deps.actions);
      }),
    );
  };
  const off = () => {
    for (const fn of offs) fn();
    offs = [];
  };

  let enabled = false;
  const check = () => {
    const next = deps.isEnabled();
    if (next === enabled) return;
    enabled = next;
    if (next) on();
    else off();
  };
  const unsubscribe = deps.subscribe(check);
  check();
  return () => {
    unsubscribe();
    off();
    enabled = false;
  };
}
