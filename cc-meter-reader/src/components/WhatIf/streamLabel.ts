// src/components/WhatIf/streamLabel.ts — one name per What-if stream, shared by the Stream picker and "Biggest
// unclaimed savings" (App QA 9/27: two unclaimed lines read "Windows XML pack on Windows workstations" for two
// different streams). A Source that feeds one stream is named alone; a Source that feeds several is named
// "Source → Destination" (whatif.streamOption), so no two streams ever read alike.

import { humanize } from '../../../core/humanize.ts';
import { t } from '../../copy/en.ts';

export interface StreamLike {
  key: string;
  flow: { inputId: string; outputId: string };
}

/** Labels by stream key over every stream given (a Source seen twice is named with its destination). */
export function streamLabels(streams: readonly StreamLike[], humanizeOverrides?: Record<string, string>): Map<string, string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const s of streams) {
    if (seen.has(s.flow.inputId)) dup.add(s.flow.inputId);
    seen.add(s.flow.inputId);
  }
  const out = new Map<string, string>();
  for (const s of streams) {
    const source = humanize(s.flow.inputId, humanizeOverrides) || s.flow.inputId;
    out.set(s.key, dup.has(s.flow.inputId) ? t('whatif.streamOption', { source, destination: humanize(s.flow.outputId, humanizeOverrides) }) : source);
  }
  return out;
}
