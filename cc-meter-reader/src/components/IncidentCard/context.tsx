// src/components/IncidentCard/context.tsx — what an incident card may read from the app store when it is
// rendered inside <AppProviders> (endpoint names, display timezone, humanize overrides, demo mutes), and
// nothing when it is not (unit tests, isolated previews). Props always win over the store.

import { Fragment, useCallback, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { DemoState, Meta, NotificationEndpoint, Settings } from '../../../core/types.ts';
import { descriptorEndpoints } from '../../../core/env-webhooks.ts';
import { useOptionalStoreApi } from '../../state/react.tsx';
import { browserTimeZone, receiptZone } from '../../lib/zone.ts';

export interface IncidentContextValue {
  endpoints?: readonly NotificationEndpoint[];
  tz?: string;
  labels?: Record<string, string>;
  muted?: Record<string, string>;
  /** P1-F07: a member's "Mute for 24 hours" (settings.mutes), with who muted it. */
  mutes?: Settings['mutes'];
  /** Founder-build r2 ui-4: the regression alert's $/day floor (settings.thresholds), for a below-floor close's words. */
  floorCentsPerDay?: number;
}

const noopUnsubscribe = () => {};

export function useIncidentContext(): IncidentContextValue {
  const store = useOptionalStoreApi();
  const subscribe = useCallback((listener: () => void) => (store ? store.subscribe(listener) : noopUnsubscribe), [store]);
  const getSettings = useCallback((): Settings | null => store?.getState().settings ?? null, [store]);
  const getDemo = useCallback((): DemoState | null => store?.getState().demoState ?? null, [store]);
  const getMeta = useCallback((): Meta | null => store?.getState().meta ?? null, [store]);
  // r3 ui-1 (C3): the Receipt's zone (stored settings → snapshot.zone → this browser's); the boot defaults carry the
  // browser's zone, so a settings-less workspace's cards would otherwise time its alerts in a zone its days are not in.
  const getZone = useCallback((): string | undefined => {
    const s = store?.getState();
    if (!s) return undefined;
    return receiptZone({ settingsStored: s.settingsStored || s.source !== 'live', displayTimezone: s.settings.displayTimezone }, s.snapshot?.zone, browserTimeZone());
  }, [store]);
  const settings = useSyncExternalStore(subscribe, getSettings, getSettings);
  const zone = useSyncExternalStore(subscribe, getZone, getZone);
  const demo = useSyncExternalStore(subscribe, getDemo, getDemo);
  const meta = useSyncExternalStore(subscribe, getMeta, getMeta);
  return useMemo(
    () => ({
      // The stored Cribl channels, then the runner's .env webhooks by name (D57: meta carries names, never URLs).
      endpoints: settings ? [...settings.notifications, ...descriptorEndpoints(meta?.deliveryWebhooks)] : undefined,
      tz: zone,
      labels: settings?.humanize,
      muted: demo?.muted,
      mutes: settings?.mutes,
      floorCentsPerDay: settings?.thresholds?.regressionMinCentsPerDay,
    }),
    [settings, demo, meta, zone],
  );
}

/**
 * Splits a copy template on `{placeholders}` and puts React nodes in their place, so a figure inside a
 * sentence can carry its own element (a `data-callout`, a mono face) while the words stay in en.ts.
 */
export function renderTemplate(template: string, nodes: Record<string, ReactNode>): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\{(\w+)\}/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = re.exec(template)) !== null) {
    if (match.index > last) out.push(template.slice(last, match.index));
    const name = match[1];
    const node = nodes[name];
    out.push(node === undefined ? match[0] : <Fragment key={`${name}-${i++}`}>{node}</Fragment>);
    last = match.index + match[0].length;
  }
  if (last < template.length) out.push(template.slice(last));
  return out;
}
