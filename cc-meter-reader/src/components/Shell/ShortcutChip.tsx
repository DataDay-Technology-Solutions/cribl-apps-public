// src/components/Shell/ShortcutChip.tsx — the 2-second confirmation chip in the corner after a shortcut.

import { useShortcutChip } from '../../lib/shortcuts.ts';

export function ShortcutChip() {
  const chip = useShortcutChip();
  return (
    <div className="mr-chip-region" aria-live="polite">
      {chip ? (
        <div className="mr-chip" key={chip.id}>
          {chip.label}
        </div>
      ) : null}
    </div>
  );
}
