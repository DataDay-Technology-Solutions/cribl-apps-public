// src/lib/zone.ts — the browser's IANA zone, canonicalised (core/time.ts), or 'UTC' when the browser can't say.
//
// One definition for every UI caller: the runtime's defaults (captured into KV at the first save, B1/C1'), the
// Receipt's fallback when no stored zone is valid, and the meter loop's `defaultTimeZone` for the sweep.

import { canonicalZoneName, isValidTimeZone } from '../../core/time.ts';

export function browserTimeZone(): string {
  try {
    return canonicalZoneName(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  } catch {
    return 'UTC';
  }
}

/**
 * The Receipt's view zone (founder-build r2 ui-3, contract C1''): the stored settings' zone, else the zone the workspace
 * was metered in (snapshot.zone, core's totals zone), else this browser's. A settings-less workspace (a 1.1.0 upgrade, or
 * one another runtime metered) therefore reads its days in the zone its figures were bucketed in, never the tab's own.
 */
export function receiptZone(
  settings: { settingsStored: boolean; displayTimezone: string | undefined },
  snapshotZone: string | undefined,
  browserZone: string,
): string {
  if (settings.settingsStored && settings.displayTimezone && isValidTimeZone(settings.displayTimezone)) return settings.displayTimezone;
  if (snapshotZone && isValidTimeZone(snapshotZone)) return snapshotZone;
  return browserZone;
}
