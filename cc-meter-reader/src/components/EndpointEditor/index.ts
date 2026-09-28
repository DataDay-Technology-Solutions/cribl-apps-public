// src/components/EndpointEditor — one Cribl notification-target endpoint's editor and the "Where to send alerts"
// model (SPEC 5, 12; DECISIONS D57: no build stores a webhook URL).
export { EndpointEditor, type CriblChannelProps, type EndpointEditorProps, type RelayView, type TargetsView } from './EndpointEditor.tsx';
export { BellRow, type BellRowProps } from './BellRow.tsx';
export { CHANNEL_COPY, cc, targetTypeLabel } from './copy.ts';
export {
  MAX_ENDPOINTS,
  applyEndpoints,
  bellDirty,
  bellFromSettings,
  bellToEndpoint,
  countEndpointErrors,
  createEndpointId,
  describeCriblTest,
  draftFromEndpoint,
  draftToEndpoint,
  draftsFromSettings,
  endpointDirtyCount,
  endpointsDirty,
  isSaved,
  isTargetIdShaped,
  looksLikeUrl,
  lastTestCaption,
  newEndpointDraft,
  sendCriblTest,
  testCanonical,
  testTargetText,
  visibleEndpointErrors,
  type BellDraft,
  type CriblTestParams,
  type EndpointDraft,
  type EndpointField,
  type EndpointFieldErrors,
  type ListChannel,
  type TestMessageOptions,
  type TestResult,
  type TestResultKind,
  type TouchedFields,
} from './model.ts';
