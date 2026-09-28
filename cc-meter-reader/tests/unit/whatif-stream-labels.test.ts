// tests/unit/whatif-stream-labels.test.ts — "Biggest unclaimed savings" names each stream as the Stream picker does
// (App QA 9/27: two lines both read "Windows XML pack on Windows workstations" for two different streams).

import { describe, expect, it } from 'vitest';
import { unclaimedSavings } from '../../core/whatif.ts';
import { streamOptions } from '../../src/components/WhatIf/useWhatIf.ts';
import { streamLabels } from '../../src/components/WhatIf/streamLabel.ts';
import { t, type CopyKey } from '../../src/copy/en.ts';
import { buildTourDoc } from '../../testdata/tour.ts';

describe('What if stream names', () => {
  it('a Source feeding one stream is named alone; one feeding several is "Source → Destination"', () => {
    const labels = streamLabels([
      { key: 'a', flow: { inputId: 'mrd_windows_workstations', outputId: 'mrd_siem_prod' } },
      { key: 'b', flow: { inputId: 'mrd_windows_workstations', outputId: 'mrd_archive_s3' } },
      { key: 'c', flow: { inputId: 'mrd_payments_api', outputId: 'mrd_siem_apps' } },
    ]);
    expect(labels.get('a')).toMatch(/ → /);
    expect(labels.get('b')).toMatch(/ → /);
    expect(labels.get('a')).not.toBe(labels.get('b'));
    expect(labels.get('c')).not.toMatch(/ → /);
  });

  it('on the sample tour, no two unclaimed lines read alike, and each names its stream as the picker does', () => {
    const { doc } = buildTourDoc();
    const groups = [...new Set(doc.snapshot.flows.map((f) => f.groupId))];
    let sharedSource = 0;
    for (const groupId of groups) {
      const streams = streamOptions(doc.snapshot, groupId);
      const lines = unclaimedSavings(streams.map((s) => s.flow), doc.snapshot, { groupId, limit: 5 });
      const labels = streamLabels(streams, doc.settings.humanize);
      const texts = lines.map((l) => t('whatif.unclaimed.line', { treatment: t(`whatif.treatments.${l.treatment}` as CopyKey), stream: labels.get(l.streamKey) ?? '?' }));
      expect(new Set(texts).size, `${groupId}: ${texts.join(' | ')}`).toBe(texts.length);
      expect(texts.every((x) => !x.endsWith(' on ?'))).toBe(true);
      const inputs = lines.map((l) => l.flow.inputId);
      sharedSource += inputs.length - new Set(inputs).size;
    }
    // Not vacuous: the tour has a Source with two unclaimed streams (the line QA saw twice).
    expect(sharedSource).toBeGreaterThan(0);
  });
});
