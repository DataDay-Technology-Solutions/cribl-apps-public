// src/components/EndpointEditor/EndpointEditor.tsx — one "Where to send alerts" endpoint (SPEC 5, 12, 17;
// DESIGN_BRIEF 5.5): name, Cribl notification target, minimum severity, weekly receipt, enabled, and "Send a test alert" with its
// exact inline result (through core/delivery.ts).
//
// Channel (DECISIONS D23, D57): a Cribl notification target — type the target id an administrator configured in
// Cribl, or press "Load targets" to pick from the list (loading is explicit because Cribl returns every target's full
// configuration to the browser; only the id is stored); a one-time, confirmed Connect creates the Search relay. The
// App stores no webhook URL in any build (hackathon rule 4.5): direct webhooks are the runner's, from its .env. The
// parent owns the target list, the relay states and the Connect confirmation.
//
// Errors arrive already filtered by the parent (EPIC_AUDIT P1-G05: a field shows its error once left, or after
// a Save attempt); the editor reports each field it leaves through `onTouch`. Status spends no colour
// (P1-G08): neutral pills and a neutral "sent" line; danger only for a failure.

import { useId, useState } from 'react';
import { Alert, Button, Pill, SelectField, Switch, TextField, type Key } from '@capra/core';
import { CheckOutlined } from '@capra/icons';
import type { CriblHttp, Settings, Severity, WebhookSender } from '../../../core/types.ts';
import type { TargetSummary } from '../../../core/adapters/cribl-notify.ts';
import { t } from '../../copy/en.ts';
import { RelativeTime } from '../common/RelativeTime.tsx';
import {
  arrivalConfirmed,
  draftToEndpoint,
  isTargetIdShaped,
  lastTestCaption,
  sendCriblTest,
  testTargetText,
  type EndpointDraft,
  type EndpointField,
  type EndpointFieldErrors,
  type TestMessageOptions,
  type TestResult,
} from './model.ts';
import { CHANNEL_COPY, cc, targetTypeLabel } from './copy.ts';
import { tn } from '../../copy/en.ts';
import './EndpointEditor.css';

export interface EndpointEditorProps {
  draft: EndpointDraft;
  /** Position in the list (field ids, test ids). */
  index: number;
  errors?: EndpointFieldErrors;
  /** Read-only (sample data, not hydrated). */
  disabled?: boolean;
  onChange: (draft: EndpointDraft) => void;
  /** Remove: the parent confirms saved endpoints (AGENTS.md) and drops unsaved ones. */
  onRemove: () => void;
  /** Where the test posts from: workspace, link base, display timezone, clock. */
  testContext: Omit<TestMessageOptions, 'nowIso'>;
  sender: WebhookSender;
  /** Called after each test (the parent records `lastTest` for saved endpoints). */
  onTested?: (result: TestResult) => void;
  /** The Cribl notification-target channel: the parent's target list, relay states and Connect action. */
  cribl: CriblChannelProps;
  /** Called when the member leaves a field that can carry an error (the parent then shows that error). */
  onTouch?: (field: EndpointField) => void;
  /** The draft differs from what is stored (the leading-edge dirty marker, P1-G07). */
  dirty?: boolean;
  /** Where metering runs: the weekly receipt's caption says when it goes out (default 'ui'). */
  runtime?: Settings['runtime'];
}

/** The notification targets as the parent loaded them (lazily, the first time a target channel is shown). */
export interface TargetsView {
  status: 'idle' | 'loading' | 'ok' | 'error';
  /** Pickable targets (the bell's own target excluded). */
  targets: readonly TargetSummary[];
  /** HTTP status of a failed listing. */
  errorStatus?: number;
}

/** One target's relay, as the parent last checked it. */
export interface RelayView {
  status: 'unknown' | 'checking' | 'ready' | 'missing' | 'error';
  errorStatus?: number;
}

export interface CriblChannelProps {
  /** Leader API as the member, for the target test. */
  http: CriblHttp;
  targets: TargetsView;
  relayFor: (targetId: string) => RelayView;
  /** Asks the parent to confirm and create the relay for this target (AGENTS.md: a confirmed, explicit write). */
  onConnect: (targetId: string) => void;
  /** "Load targets": the member asks for the list (GET /notification-targets); never loaded on its own. */
  onLoadTargets?: () => void;
}

const SEVERITY_OPTIONS = (): { id: Severity; label: string }[] => [
  { id: 'info', label: t('settings.notify.severityInfo') },
  { id: 'medium', label: t('settings.notify.severityMedium') },
  { id: 'high', label: t('settings.notify.severityHigh') },
];


/**
 * One list endpoint: a Cribl notification target (DECISIONS D57: the App stores no webhook URL, so the target is the
 * only list channel; direct webhooks are the runner's, from its .env).
 */
export function EndpointEditor(props: EndpointEditorProps) {
  return <TargetEndpointEditor {...props} />;
}

/** The relay state of the chosen target, with Connect when it is missing. */
function RelayLine({
  relay,
  targetId,
  index,
  disabled,
  onConnect,
  stored,
}: {
  relay: RelayView;
  targetId: string;
  index: number;
  disabled?: boolean | undefined;
  onConnect: (targetId: string) => void;
  /** This endpoint is stored with this target (founder-build r1 ui-5, M1): only then do alerts reach it. */
  stored: boolean;
}) {
  if (!targetId) return null;
  const testId = `endpoint-${index}-relay`;
  if (relay.status === 'ready') {
    // Connected in Cribl is not the same as sending here: an unsaved draft never claims delivery (M1).
    return (
      <p className="mr-ep-relay" data-testid={testId} data-relay="ready" data-saved={stored ? 'true' : 'false'}>
        {stored ? cc(CHANNEL_COPY.target.ready, { target: targetId }) : CHANNEL_COPY.target.readyUnsaved}
      </p>
    );
  }
  if (relay.status === 'missing') {
    return (
      <div className="mr-ep-relay mr-ep-relay--missing" data-testid={testId} data-relay="missing">
        <p className="mr-ep-relay-text">{CHANNEL_COPY.target.missing}</p>
        <Button variant="secondary" size="sm" disabled={disabled} onPress={() => onConnect(targetId)}>
          {CHANNEL_COPY.target.connect}
        </Button>
      </div>
    );
  }
  if (relay.status === 'error') {
    return (
      <p className="mr-ep-relay" data-testid={testId} data-relay="error">
        {cc(CHANNEL_COPY.target.checkFailed, { status: relay.errorStatus ?? 0 })}
      </p>
    );
  }
  return (
    <p className="mr-ep-relay" data-testid={testId} data-relay="checking">
      {CHANNEL_COPY.target.checking}
    </p>
  );
}

/** A list endpoint delivered through a Cribl Notification target (only the target id is stored). */
function TargetEndpointEditor(props: EndpointEditorProps) {
  const { draft, index, errors, disabled, onChange, onRemove, testContext, sender, onTested, cribl, onTouch, dirty } = props;
  /** After a load, the member may still prefer typing an id. */
  const [typing, setTyping] = useState(false);
  const uid = useId();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [previewAt, setPreviewAt] = useState<string | null>(null);

  const set = (patch: Partial<EndpointDraft>) => onChange({ ...draft, ...patch });
  const title = draft.name.trim() || t('settings.notify.unnamed');
  // Rule 4.5 (D57): only an id-shaped value is checked, connected or sent to; a pasted URL waits under its error.
  const typedId = draft.criblTargetId.trim();
  const targetId = isTargetIdShaped(typedId) ? typedId : '';
  const relay: RelayView = targetId ? cribl.relayFor(targetId) : { status: 'unknown' };
  // A target whose relay is missing (or still being checked) cannot take a test yet (P1-G09): the button waits
  // for Connect instead of answering with a red "Connect this target first".
  const needsConnect = relay.status === 'missing';
  // Not before the relay is known either (r1 ui-9, FINDINGS_R1 m14): an id whose relay was not yet checked read enabled,
  // then disabled while the check ran, then enabled again, and a press in that window was silently dropped.
  const canTest = !disabled && !testing && targetId !== '' && !needsConnect && relay.status !== 'checking' && relay.status !== 'unknown';
  const ids = { name: `${uid}-name`, target: `${uid}-target`, weekly: `${uid}-weekly`, enabled: `${uid}-enabled` };

  const runTest = async () => {
    if (!canTest) return;
    setTesting(true);
    const nowIso = new Date().toISOString();
    try {
      const { result: r } = await sendCriblTest({ ...testContext, nowIso, http: cribl.http, sender, endpoint: draftToEndpoint(draft) });
      setResult(r);
      setPreviewAt(nowIso);
      onTested?.(r);
    } finally {
      setTesting(false);
    }
  };

  const { targets } = cribl;
  const known = targets.targets;
  const items = known.map((tg) => ({ id: tg.id, label: `${tg.id} · ${targetTypeLabel(tg.type)}` }));
  if (targetId && !known.some((tg) => tg.id === targetId)) items.push({ id: targetId, label: targetId });
  if (typedId && !targetId && !known.some((tg) => tg.id === typedId)) items.push({ id: typedId, label: typedId });
  const usePicker = targets.status === 'ok' && known.length > 0 && !typing;
  const chosen = known.find((tg) => tg.id === targetId);
  // The list is loaded only when the member asks (DECISIONS: GET /notification-targets hands every target's
  // full configuration to this browser); until then, and whenever it fails, the id is typed.
  const listCaption =
    targets.status === 'idle'
      ? CHANNEL_COPY.target.loadHint
      : targets.status === 'loading'
        ? CHANNEL_COPY.target.loading
        : targets.status === 'error'
          ? cc(CHANNEL_COPY.target.loadFailed, { status: targets.errorStatus ?? 0 })
          : known.length === 0
            ? CHANNEL_COPY.target.none
            : usePicker
              ? (chosen?.description ?? tn('settings.notify.channels.target.loaded', known.length))
              : tn('settings.notify.channels.target.loaded', known.length);
  const canLoad = !!cribl.onLoadTargets && (targets.status === 'idle' || targets.status === 'error' || (targets.status === 'ok' && typing));
  const loadAction =
    canLoad && cribl.onLoadTargets ? (
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled}
        onPress={() => {
          setTyping(false);
          if (targets.status !== 'ok') cribl.onLoadTargets?.();
        }}
      >
        {CHANNEL_COPY.target.load}
      </Button>
    ) : targets.status === 'loading' ? (
      <Button variant="secondary" size="sm" pending disabled>
        {CHANNEL_COPY.target.load}
      </Button>
    ) : usePicker ? (
      <Button variant="tertiary" size="sm" disabled={disabled} onPress={() => setTyping(true)}>
        {CHANNEL_COPY.target.typeInstead}
      </Button>
    ) : null;

  return (
    <article
      className="mr-ep"
      data-enabled={draft.enabled ? 'true' : 'false'}
      data-dirty={dirty ? 'true' : undefined}
      data-endpoint-id={draft.id}
      data-testid={`endpoint-${index}`}
      data-channel="cribl-target"
      aria-label={title}
      tabIndex={-1}
    >
      <header className="mr-ep-head">
        <div className="mr-ep-title-line">
          <h3 className="mr-ep-title">{title}</h3>
          <span className="mr-ep-badge" data-host-status="cribl-target">
            <Pill appearance="default" variant="outline" inline>
              {CHANNEL_COPY.target.pill}
            </Pill>
          </span>
        </div>
        <div className="mr-ep-head-actions">
          <div className="mr-ep-switch">
            <span className="mr-switch">
              <Switch aria-labelledby={ids.enabled} checked={draft.enabled} disabled={disabled} onChange={(e) => set({ enabled: e.target.checked })} />
            </span>
            <span id={ids.enabled} className="mr-ep-switch-label">
              {t('settings.notify.enabled')}
            </span>
          </div>
          {/* Neutral here; the confirmation carries the danger (P1-G08). */}
          <Button variant="tertiary" appearance="neutral" size="sm" disabled={disabled} onPress={onRemove}>
            {t('settings.notify.remove')}
          </Button>
        </div>
      </header>

      <div className="mr-ep-grid">
        <div className="mr-ep-name" onBlur={() => onTouch?.('name')}>
          <TextField
            id={ids.name}
            label={t('settings.notify.name')}
            placeholder={t('settings.notify.namePlaceholder')}
            value={draft.name}
            disabled={disabled}
            appearance={errors?.name ? 'danger' : 'default'}
            helperText={errors?.name}
            onChange={(name) => set({ name })}
            autoComplete="off"
          />
        </div>

        <div className="mr-ep-url">
          <div data-testid={`endpoint-${index}-target`}>
            {usePicker ? (
              <SelectField
                label={CHANNEL_COPY.target.label}
                placeholder={CHANNEL_COPY.target.placeholder}
                items={items}
                value={typedId || null}
                disabled={disabled}
                appearance={errors?.criblTargetId ? 'danger' : 'default'}
                helperText={errors?.criblTargetId}
                onChange={(key: Key | null) => {
                  if (key !== null) set({ criblTargetId: String(key) });
                }}
              />
            ) : (
              <span className="mr-ep-touch" onBlur={() => onTouch?.('criblTargetId')}>
                <TextField
                  id={ids.target}
                  label={CHANNEL_COPY.target.idLabel}
                  placeholder={CHANNEL_COPY.target.idPlaceholder}
                  value={draft.criblTargetId}
                  disabled={disabled}
                  autoComplete="off"
                  spellCheck={false}
                  appearance={errors?.criblTargetId ? 'danger' : 'default'}
                  helperText={errors?.criblTargetId}
                  onChange={(next) => set({ criblTargetId: next })}
                />
              </span>
            )}
          </div>
          <div className="mr-ep-targets-line" data-testid={`endpoint-${index}-targets`} data-targets={targets.status}>
            {listCaption ? <p className="mr-ep-host-hint">{listCaption}</p> : null}
            {loadAction ? <span className="mr-ep-targets-action">{loadAction}</span> : null}
          </div>
          <RelayLine relay={relay} targetId={targetId} index={index} disabled={disabled} onConnect={cribl.onConnect} stored={draft.saved && draft.savedTargetId === targetId} />
        </div>

        <div className="mr-ep-severity">
          <SelectField
            label={t('settings.notify.minSeverity')}
            items={SEVERITY_OPTIONS()}
            value={draft.minSeverity}
            disabled={disabled}
            appearance={errors?.minSeverity ? 'danger' : 'default'}
            helperText={errors?.minSeverity}
            onChange={(key: Key | null) => {
              if (key !== null) set({ minSeverity: String(key) as Severity });
            }}
          />
        </div>
        <div className="mr-ep-weekly">
          <span className="mr-ep-field-label" aria-hidden="true">
            {t('settings.notify.weekly')}
          </span>
          <div className="mr-ep-switch mr-ep-switch--field">
            <span className="mr-switch">
              <Switch aria-labelledby={ids.weekly} checked={draft.weeklyReceipt} disabled={disabled} onChange={(e) => set({ weeklyReceipt: e.target.checked })} />
            </span>
            <span id={ids.weekly} className="mr-ep-switch-caption">
              {props.runtime === 'backend' ? t('settings.notify.weeklyHint') : t('settings.notify.weeklyHintUi')}
            </span>
          </div>
        </div>
        <p className="mr-ep-channel-body mr-ep-channel-body--wide">{CHANNEL_COPY.target.hint}</p>
      </div>

      <footer className="mr-ep-foot">
        <div className="mr-ep-test">
          <span className="mr-ep-test-button" data-testid={`endpoint-${index}-test`}>
            <Button variant="secondary" pending={testing} disabled={!canTest} onPress={() => void runTest()}>
              {t('settings.sendTest')}
            </Button>
          </span>
          {!targetId ? (
            <span className="mr-ep-caption">{CHANNEL_COPY.target.chooseFirst}</span>
          ) : needsConnect ? (
            <span className="mr-ep-caption" data-testid={`endpoint-${index}-connect-first`}>
              {CHANNEL_COPY.target.connectFirst}
            </span>
          ) : draft.lastTest && !result ? (
            <span className="mr-ep-caption mr-num">
              <RelativeTime at={draft.lastTest.at} render={(ago) => (draft.lastTest ? lastTestCaption(draft.lastTest, ago) : '')} />
            </span>
          ) : null}
        </div>
        {result ? <ResultLine result={result} testId={`endpoint-${index}-result`} /> : null}
        {result?.kind === 'sent' ? (
          <div className="mr-ep-arrive" data-testid={`endpoint-${index}-arrive`}>
            <p className="mr-ep-caption">{CHANNEL_COPY.target.didItArrive}</p>
            {!arrivalConfirmed(draft) ? (
              <Button variant="secondary" size="sm" disabled={disabled} onPress={() => set({ confirmedAt: new Date().toISOString(), confirmedTargetId: targetId })}>
                {CHANNEL_COPY.target.arrived}
              </Button>
            ) : null}
          </div>
        ) : null}
        {targetId && !needsConnect ? (
          arrivalConfirmed(draft) && draft.confirmedAt ? (
            <p className="mr-ep-caption mr-ep-confirmed" data-testid={`endpoint-${index}-confirmed`} data-confirmed="true">
              <RelativeTime at={draft.confirmedAt} render={(ago) => cc(CHANNEL_COPY.target.confirmed, { ago })} />
            </p>
          ) : (
            <p className="mr-ep-caption mr-ep-unconfirmed" data-testid={`endpoint-${index}-confirmed`} data-confirmed="false">
              {CHANNEL_COPY.target.unconfirmed}
            </p>
          )
        ) : null}
        {result && previewAt ? (
          <div className="mr-ep-preview">
            <p className="mr-ep-preview-title">{CHANNEL_COPY.target.previewTitle}</p>
            <pre className="mr-ep-json">{testTargetText({ ...testContext, nowIso: previewAt })}</pre>
          </div>
        ) : null}
      </footer>
    </article>
  );
}

/**
 * A test's outcome (P1-G08): a sent test is a quiet neutral line with a check glyph; only a failure takes the
 * incident colour, as an inline danger alert.
 */
export function ResultLine({ result, testId }: { result: TestResult; testId: string }) {
  if (result.kind === 'sent') {
    return (
      <div className="mr-ep-result" data-testid={testId} data-result={result.kind}>
        <p className="mr-ep-result-ok" role="status">
          <CheckOutlined size="sm" aria-hidden="true" />
          <span>{result.message}</span>
        </p>
      </div>
    );
  }
  return (
    <div className="mr-ep-result" data-testid={testId} data-result={result.kind}>
      <Alert appearance="danger" layout="inline">
        {result.message}
      </Alert>
    </div>
  );
}
