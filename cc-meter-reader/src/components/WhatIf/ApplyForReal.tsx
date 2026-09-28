// src/components/WhatIf/ApplyForReal.tsx — "Apply for real" (DESIGN_BRIEF 5.9). DEMO BUILD ONLY: loaded
// through an inline `import.meta.env.VITE_MR_BUILD === 'demo'` lazy import (WhatIfPanel.tsx), so neither this
// file nor the lever client it reaches is in the release bundle.
//
// It runs the same lever the Demo Console runs (src/demo client → core/demo/levers.ts applyPack: commit +
// deploy, demo-tag enforced, one lever in flight), behind the AGENTS.md confirmation that names exactly what
// changes. On success the panel switches to projected-vs-actual (?applied=<deploy time>).

import { useState } from 'react';
import { Button } from '@capra/core';
import { humanize } from '../../../core/humanize.ts';
import { ConfirmModal } from '../common/ConfirmModal.tsx';
import { t, type CopyKey } from '../../copy/en.ts';
import { useDemoRuntime } from '../../demo/install.ts';
import { useAppState } from '../../state/react.tsx';
import { leverTarget } from './leverTarget.ts';
import type { WhatIfModel } from './useWhatIf.ts';

export default function ApplyForReal({ model }: { model: WhatIfModel }) {
  const runtime = useDemoRuntime();
  const demoEnabled = useAppState((s) => s.settings.demo.enabled && s.source === 'live');
  const [open, setOpen] = useState(false);
  const stream = model.stream;
  if (!stream) return null;
  const target = leverTarget(stream.flow.inputId, stream.flow.routeId, model.treatmentKey);
  if (!target) return <p className="mr-whatif-note">{t('whatifDemo.onlyRig')}</p>;
  if (!demoEnabled) return <p className="mr-whatif-note">{t('whatifDemo.demoOff')}</p>;

  const treatment = t(`whatif.treatments.${model.treatmentKey}` as CopyKey);
  const streamName = humanize(stream.flow.inputId);
  return (
    <>
      <Button variant="primary" onPress={() => setOpen(true)}>
        {t('whatifDemo.apply')}
      </Button>
      <ConfirmModal
        isOpen={open}
        title={t('whatifDemo.confirmTitle', { treatment, stream: streamName })}
        body={t('whatifDemo.confirmBody')}
        affects={[{ label: humanize(stream.flow.routeId), id: stream.flow.routeId, action: t('whatifDemo.affects', { pipeline: target.pipelineId }) }]}
        confirmText={t('whatifDemo.apply')}
        danger={false}
        successMessage={t('whatifDemo.applied')}
        onClose={() => setOpen(false)}
        onConfirm={async () => {
          const outcome = await runtime.client.run({ kind: 'applyPack', routeKey: target.routeKey, level: target.level });
          if (!outcome.ok) throw new Error(outcome.message ?? outcome.error ?? 'failed');
          const at = outcome.deployedAt ? Date.parse(outcome.deployedAt) : Date.now();
          model.markApplied(Number.isFinite(at) ? at : Date.now());
        }}
      />
    </>
  );
}
