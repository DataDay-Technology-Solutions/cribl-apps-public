// src/components/EndpointEditor/copy.ts — the delivery-channel strings (DECISIONS D23), as the editor reads them.
//
// Every string ships from src/copy/en.ts (SPEC 17) under `settings.notify.channels`; this module only gives
// the editor a short handle on that object (`CHANNEL_COPY.target.sent`) plus the `cc` interpolation helper
// and the target-type labels.

import { en, interpolate } from '../../copy/en.ts';

export const CHANNEL_COPY = en.settings.notify.channels;

/** Friendly names for Cribl notification target types; unknown types show as they are. */
export function targetTypeLabel(type: string): string {
  const labels: Readonly<Record<string, string>> = CHANNEL_COPY.typeLabels;
  return Object.prototype.hasOwnProperty.call(labels, type) ? labels[type] : type;
}

/** Interpolates one of the strings above. */
export function cc(template: string, vars?: Record<string, string | number>): string {
  return interpolate(template, vars);
}
