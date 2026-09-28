// src/views/Settings/WeeklyReceiptBlock.tsx — "Send the last 7 days now" under Where to send alerts (SPEC 11,
// 12.4; DECISIONS D12b; REVIEW-3a #4). The button sends the seven days before today to every enabled endpoint
// with Weekly receipt on (core/weekly.ts, through the meter loop), and reports each endpoint's exact result.
// The automatic Monday send is the meter loop's; its last run shows as "Last sent automatically …".
// A run that went out reads as a neutral line with a check glyph; only a warning or a failure takes a colour
// (EPIC_AUDIT P1-G08: green is for money saved).

import { useState } from 'react';
import { Alert, Button } from '@capra/core';
import { CheckOutlined } from '@capra/icons';
import { t } from '../../copy/en.ts';
import { formatDateTime } from '../../lib/format.ts';
import { shallowEqual, useActions, useAppState } from '../../state/react.tsx';
import { canWrite } from '../../state/selectors.ts';
import type { WeeklySendResult } from '../../state/meterLoop.ts';
import { weeklyView, type WeeklyView } from './weekly.ts';
import { descriptorEndpoints } from '../../../core/env-webhooks.ts';

const ALERT_APPEARANCE = { warn: 'warning', error: 'danger' } as const;

function viewOf(result: WeeklySendResult, endpoints: Parameters<typeof weeklyView>[1]): WeeklyView {
  switch (result.status) {
    case 'done':
      return weeklyView(result.outcome, endpoints);
    case 'busy':
      return { tone: 'warn', summary: t('settings.notify.weeklyReceipt.busy'), lines: [] };
    default:
      return {
        tone: 'warn',
        summary: result.reason === 'not-live' ? t('settings.readOnlySample') : t('settings.readOnlyLoading'),
        lines: [],
      };
  }
}

export function WeeklyReceiptBlock() {
  const { sendWeeklyReceipt } = useActions();
  const view = useAppState(
    (s) => ({
      writable: canWrite(s),
      runtime: s.settings.runtime,
      endpoints: s.settings.notifications,
      webhooks: s.meta?.deliveryWebhooks,
      lastAutoAt: s.meta?.lastWeeklySentAt,
      tz: s.settings.displayTimezone,
    }),
    shallowEqual,
  );
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<WeeklyView | null>(null);

  const send = async () => {
    if (sending) return;
    setSending(true);
    try {
      setResult(viewOf(await sendWeeklyReceipt(), [...view.endpoints, ...descriptorEndpoints(view.webhooks)]));
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="mr-nt-weekly" aria-labelledby="mr-nt-weekly-title" data-testid="weekly-receipt">
      <div className="mr-nt-weekly-copy">
        <h3 id="mr-nt-weekly-title" className="mr-nt-weekly-title">
          {t('settings.notify.weeklyReceipt.title')}
        </h3>
        <p className="mr-set-caption">
          {view.runtime === 'backend' ? t('settings.notify.weeklyReceipt.bodyBackend') : t('settings.notify.weeklyReceipt.bodyUi')}
        </p>
        {view.lastAutoAt ? (
          <p className="mr-set-caption mr-num" data-testid="weekly-last-auto">
            {t('settings.notify.weeklyReceipt.lastAuto', { time: formatDateTime(view.lastAutoAt, view.tz) })}
          </p>
        ) : null}
      </div>
      <div className="mr-nt-weekly-action">
        <Button variant="secondary" pending={sending} disabled={!view.writable || sending} onPress={() => void send()}>
          {t('settings.notify.weeklyReceipt.send')}
        </Button>
        <span className="mr-set-caption">{t('settings.notify.weeklyReceipt.sendHint')}</span>
      </div>
      {result ? (
        <div className="mr-nt-weekly-result" data-testid="weekly-result" data-tone={result.tone} aria-live="polite">
          {result.tone === 'ok' ? (
            <p className="mr-nt-weekly-ok" role="status">
              <CheckOutlined size="sm" aria-hidden="true" />
              <span>{result.summary}</span>
            </p>
          ) : (
            <Alert appearance={ALERT_APPEARANCE[result.tone]} layout="inline">
              {result.summary}
            </Alert>
          )}
          {result.lines.length > 0 ? (
            <ul className="mr-nt-weekly-lines">
              {result.lines.map((line) => (
                <li key={line.endpointId} className="mr-num" data-ok={line.ok ? 'true' : 'false'} data-skipped={line.skipped ? 'true' : undefined}>
                  {line.text}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
