// src/components/EndpointEditor/BellRow.tsx — the Cribl notification bell as a delivery channel (DECISIONS D23).
//
// On by default with nothing to configure: every alert of the chosen severity and up is posted to the Cribl
// notification bell (POST /system/messages). The member can switch it off or raise the minimum severity; the
// bell is stored in settings only once changed. "Send a test alert" posts one test message to the bell.
// Status spends no colour (EPIC_AUDIT P1-G08): the "no setup" pill is a neutral outline with a check glyph,
// and a delivered test is a neutral line; only a failure takes the incident colour.

import { useId, useState } from 'react';
import { Button, Pill, SelectField, Switch, type Key } from '@capra/core';
import { CheckOutlined } from '@capra/icons';
import type { CriblHttp, Severity, WebhookSender } from '../../../core/types.ts';
import { defaultBellEndpoint } from '../../../core/delivery.ts';
import { t } from '../../copy/en.ts';
import { CHANNEL_COPY } from './copy.ts';
import { sendCriblTest, type BellDraft, type TestMessageOptions, type TestResult } from './model.ts';
import { ResultLine } from './EndpointEditor.tsx';
import './EndpointEditor.css';

export interface BellRowProps {
  bell: BellDraft;
  disabled?: boolean;
  onChange: (bell: BellDraft) => void;
  http: CriblHttp;
  sender: WebhookSender;
  testContext: Omit<TestMessageOptions, 'nowIso'>;
  /** The switch or the minimum severity differs from what is stored (the leading-edge dirty marker, P1-G07). */
  dirty?: boolean;
}

const SEVERITY_OPTIONS = (): { id: Severity; label: string }[] => [
  { id: 'info', label: t('settings.notify.severityInfo') },
  { id: 'medium', label: t('settings.notify.severityMedium') },
  { id: 'high', label: t('settings.notify.severityHigh') },
];

export function BellRow({ bell, disabled, onChange, http, sender, testContext, dirty }: BellRowProps) {
  const uid = useId();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  const runTest = async () => {
    if (disabled || testing) return;
    setTesting(true);
    try {
      const endpoint = { ...defaultBellEndpoint(), enabled: bell.enabled, minSeverity: bell.minSeverity };
      const { result: r } = await sendCriblTest({ ...testContext, nowIso: new Date().toISOString(), http, sender, endpoint });
      setResult(r);
    } finally {
      setTesting(false);
    }
  };

  const enabledId = `${uid}-enabled`;
  return (
    <article
      className="mr-ep mr-ep--bell"
      data-enabled={bell.enabled ? 'true' : 'false'}
      data-dirty={dirty ? 'true' : undefined}
      data-testid="endpoint-bell"
      data-channel="cribl-bell"
      aria-label={CHANNEL_COPY.bell.title}
    >
      <header className="mr-ep-head">
        <div className="mr-ep-title-line">
          <h3 className="mr-ep-title">{CHANNEL_COPY.bell.title}</h3>
          <span className="mr-ep-badge">
            <Pill appearance="default" variant="outline" inline icon={<CheckOutlined />}>
              {CHANNEL_COPY.bell.pill}
            </Pill>
          </span>
        </div>
        <div className="mr-ep-head-actions">
          <div className="mr-ep-switch">
            <span className="mr-switch">
              <Switch aria-labelledby={enabledId} checked={bell.enabled} disabled={disabled} onChange={(e) => onChange({ ...bell, enabled: e.target.checked })} />
            </span>
            <span id={enabledId} className="mr-ep-switch-label">
              {t('settings.notify.enabled')}
            </span>
          </div>
        </div>
      </header>

      <div className="mr-ep-grid">
        <p className="mr-ep-channel-body">{CHANNEL_COPY.bell.body}</p>
        <div className="mr-ep-severity">
          <SelectField
            label={t('settings.notify.minSeverity')}
            items={SEVERITY_OPTIONS()}
            value={bell.minSeverity}
            disabled={disabled}
            onChange={(key: Key | null) => {
              if (key !== null) onChange({ ...bell, minSeverity: String(key) as Severity });
            }}
          />
        </div>
      </div>

      <footer className="mr-ep-foot">
        <div className="mr-ep-test">
          <span className="mr-ep-test-button" data-testid="endpoint-bell-test">
            <Button variant="secondary" pending={testing} disabled={disabled || testing} onPress={() => void runTest()}>
              {t('settings.sendTest')}
            </Button>
          </span>
        </div>
        {result ? <ResultLine result={result} testId="endpoint-bell-result" /> : null}
      </footer>
    </article>
  );
}
