// src/views/Settings/DemoSection.tsx — Settings → Demo (DEMO BUILD ONLY; PRD 8.4, 8.7, 9; SPEC 5 `demo`).
//
// Loaded with a dynamic import guarded by `import.meta.env.VITE_MR_BUILD === 'demo'` (src/views/Settings/
// index.tsx), so the release bundle never contains it or core/demo/levers. Demo mode, the demo profile and
// replay are settings (saved with "Save changes"); Reset baselines deletes a KV document, so it is
// confirmed first (AGENTS.md) and refused by the lever unless demo mode is on.

import { useId, useState } from 'react';
import { Alert, Button, Switch } from '@capra/core';
import type { Settings } from '../../../core/types.ts';
import { resetBaselines } from '../../../core/demo/levers.ts';
import { createBrowserDeps, leverDepsFrom } from '../../../core/runtime.ts';
import type { FetchLike } from '../../../core/http.ts';
import { t } from '../../copy/en.ts';
import { ConfirmModal } from '../../components/common/ConfirmModal.tsx';
import { APP_BUILD_INFO } from '../../lib/env.ts';
import { useAppState } from '../../state/react.tsx';
import { draftsEqual } from './model.ts';
import { SaveBar, SectionCard } from './shared.tsx';
import { useCurrentSettings, useSaveSettings, useSectionDraft, useWritable } from './hooks.ts';

type DemoDraft = Settings['demo'];

function Toggle({ label, hint, checked, onChange, disabled, testId }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void; disabled: boolean; testId: string }) {
  const id = useId();
  return (
    <div className="mr-al-toggle mr-demo-toggle" data-testid={testId}>
      <span className="mr-switch">
        <Switch aria-labelledby={`${id}-label`} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      </span>
      <div className="mr-al-toggle-copy">
        <span id={`${id}-label`} className="mr-al-toggle-label">
          {label}
        </span>
        <span className="mr-set-caption">{hint}</span>
      </div>
    </div>
  );
}

async function currentUsername(): Promise<string> {
  try {
    const user = await window.getCriblUser?.();
    return user?.username ?? 'meter-reader';
  } catch {
    return 'meter-reader';
  }
}

export default function DemoSection() {
  const writable = useWritable();
  const storedDemoEnabled = useAppState((s) => s.settings.demo.enabled);
  const section = useSectionDraft<DemoDraft>((s) => ({ ...s.demo }));
  const currentSettings = useCurrentSettings();
  const { save, saving } = useSaveSettings();
  const [confirming, setConfirming] = useState(false);

  const d = section.draft;
  const set = (patch: Partial<DemoDraft>) => section.setDraft((prev) => ({ ...prev, ...patch }));
  const dirtyCount = (Object.keys(d) as (keyof DemoDraft)[]).filter((k) => d[k] !== section.stored[k]).length;

  const onSave = async () => {
    if (draftsEqual(d, section.stored)) return;
    await save({ ...currentSettings(), demo: { ...d } });
  };

  const runReset = async () => {
    const deps = createBrowserDeps({ CRIBL_API_URL: window.CRIBL_API_URL, CRIBL_BASE_PATH: window.CRIBL_BASE_PATH, fetch: window.fetch as unknown as FetchLike }, APP_BUILD_INFO);
    const result = await resetBaselines(leverDepsFrom(deps, await currentUsername()));
    if (!result.ok) throw new Error(result.message);
  };

  return (
    <SectionCard
      id="demo"
      title={t('settings.groups.demo')}
      description={t('settings.demoPanel.description')}
      footer={
        <SaveBar dirty={dirtyCount} errors={0} saving={saving} writable={writable} onSave={() => void onSave()} onDiscard={section.discard} />
      }
    >
      <Alert appearance="info" layout="inline">
        {t('settings.demoPanel.simulated')}
      </Alert>
      <div className="mr-demo-toggles">
        <Toggle label={t('settings.demoPanel.mode')} hint={t('settings.demoPanel.modeHint')} checked={d.enabled} onChange={(v) => set({ enabled: v })} disabled={!writable} testId="demo-mode" />
        <Toggle label={t('settings.demoPanel.profile')} hint={t('settings.demoPanel.profileHint')} checked={d.profile} onChange={(v) => set({ profile: v })} disabled={!writable} testId="demo-profile" />
        <Toggle label={t('settings.demoPanel.replay')} hint={t('settings.demoPanel.replayHint')} checked={d.replayMode} onChange={(v) => set({ replayMode: v })} disabled={!writable} testId="demo-replay" />
      </div>
      {d.enabled && d.profile ? (
        <p className="mr-set-caption" data-state="demo-profile">
          {t('demoProfile.notice')}
        </p>
      ) : null}
      <div className="mr-demo-reset">
        <div className="mr-al-toggle-copy">
          <span className="mr-al-toggle-label">{t('settings.demoPanel.resetBaselines')}</span>
          <span className="mr-set-caption">{storedDemoEnabled ? t('settings.demoPanel.resetHint') : t('settings.demoPanel.resetNeedsDemo')}</span>
        </div>
        <Button variant="secondary" appearance="danger" disabled={!writable || !storedDemoEnabled} onPress={() => setConfirming(true)}>
          {t('settings.demoPanel.resetBaselines')}
        </Button>
      </div>
      <ConfirmModal
        isOpen={confirming}
        title={t('settings.demoPanel.resetTitle')}
        body={t('settings.demoPanel.resetBody')}
        affects={[{ label: t('settings.demoPanel.resetAffects'), id: 'baselines', action: t('settings.demoPanel.resetAction') }]}
        irreversible
        confirmText={t('settings.demoPanel.resetBaselines')}
        onConfirm={runReset}
        onClose={() => setConfirming(false)}
        successMessage={t('settings.demoPanel.resetDone')}
      />
    </SectionCard>
  );
}
