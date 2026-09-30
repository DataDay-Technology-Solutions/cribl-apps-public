// src/views/Receipt/useViewZone.ts — the zone every money view reads its days in (founder-build r3 ui-1, contract C3).
//
// The Receipt's resolver (receiptZone, r2 ui-3): the stored settings' zone, else the zone the workspace was metered in
// (snapshot.zone), else this browser's. The boot defaults always carry the browser's zone, so `settings.displayTimezone`
// alone is not the member's choice on a settings-less workspace; `settingsStored` says whether it is. A tour or replay
// shows its own sample settings, stored or not. The Report card passes the snapshot it pinned; the Ledger reads the
// store's. One resolver, so the Receipt, the Report and the Ledger never print different days for one workspace.

import { shallowEqual, useAppState } from '../../state/react.tsx';
import { browserTimeZone, receiptZone } from '../../lib/zone.ts';

export function useViewZone(snapshotZone?: string): string {
  const view = useAppState(
    (s) => ({
      settingsStored: s.settingsStored,
      displayTimezone: s.settings.displayTimezone,
      live: s.source === 'live',
      storeZone: s.snapshot?.zone,
    }),
    shallowEqual,
  );
  return receiptZone(
    { settingsStored: view.settingsStored || !view.live, displayTimezone: view.displayTimezone },
    snapshotZone ?? view.storeZone,
    browserTimeZone(),
  );
}
