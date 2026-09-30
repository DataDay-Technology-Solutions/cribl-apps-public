import { describe, expect, it } from 'vitest';
import {
  FREE_OUTPUT_TYPES,
  PRESETS,
  PRESET_NOTES,
  isDemoTagged,
  isCustomPrice,
  isFreeOutput,
  isFreeOutputType,
  isUnpricedPreset,
  presetById,
  presetFromDescription,
  presetFromName,
  presetNote,
  suggestPreset,
  suggestPresetFor,
} from '../../core/presets.ts';
import rigDestinations from '../../demo/rig/destinations.json';
import { mcToDollarInput, parseDollarsToMc } from '../../core/format.ts';

describe('PRESETS', () => {
  it('holds the verified typical prices in SPEC 6 order (millicents per GB)', () => {
    expect(PRESETS.map((p) => [p.id, p.milliCentsPerGb])).toEqual([
      ['splunk_cloud', 225_000],
      ['splunk_enterprise', 200_000],
      ['sentinel', 250_000],
      ['crowdstrike_ngsiem', 200_000],
      ['datadog', 180_000],
      ['elastic', 35_000],
      ['google_secops', 150_000],
      ['sumo', 250_000],
      ['newrelic', 40_000],
      ['s3', 2_300],
      ['azure_blob', 1_800],
      ['cribl_lake', 5_000],
      ['databricks', 5_000],
      ['snowflake', 3_400],
      ['internal', 0],
    ]);
  });
  it('every preset value is a valid price entry (at most three decimals), so picking one never fails validation', () => {
    for (const p of PRESETS) {
      const typed = mcToDollarInput(p.milliCentsPerGb);
      expect(parseDollarsToMc(typed), `${p.id} → ${typed}`).toEqual({ ok: true, value: p.milliCentsPerGb });
    }
  });
  it('has unique ids and labels', () => {
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
    expect(presetById('datadog')?.label).toBe('Datadog Logs');
    expect(presetById('nope')).toBeUndefined();
    expect(presetById(undefined)).toBeUndefined();
  });
});

describe('PRESET_NOTES', () => {
  it('has a note for every preset, and each typical price lies inside its range', () => {
    expect(Object.keys(PRESET_NOTES).sort()).toEqual(PRESETS.map((p) => p.id).sort());
    for (const p of PRESETS) {
      const n = presetNote(p.id)!;
      const [lo, hi] = n.rangeUsd;
      const typical = p.milliCentsPerGb / 100_000;
      expect(lo, p.id).toBeLessThanOrEqual(hi);
      expect(typical, `${p.id} typical $${typical} in [${lo}, ${hi}]`).toBeGreaterThanOrEqual(lo);
      expect(typical, `${p.id} typical $${typical} in [${lo}, ${hi}]`).toBeLessThanOrEqual(hi);
    }
  });
  it('states a basis, a confidence and at least one https source with its quote', () => {
    for (const [id, n] of Object.entries(PRESET_NOTES)) {
      expect(n.basis.length, id).toBeGreaterThan(40);
      expect(['published', 'reported', 'estimate']).toContain(n.confidence);
      expect(n.sources.length, id).toBeGreaterThan(0);
      for (const src of n.sources) {
        expect(new URL(src.url).protocol, `${id} ${src.url}`).toBe('https:');
        expect(src.quote.length, `${id} ${src.url}`).toBeGreaterThan(10);
      }
    }
  });
  it('the internal preset is free, and unknown ids have no note', () => {
    expect(PRESET_NOTES.internal.rangeUsd).toEqual([0, 0]);
    expect(presetNote('nope')).toBeUndefined();
    expect(presetNote(undefined)).toBeUndefined();
  });
});

describe('suggestPreset', () => {
  it('auto-suggests from the destination type', () => {
    expect(suggestPreset('splunk_hec')).toBe('splunk_cloud');
    expect(suggestPreset('splunk')).toBe('splunk_enterprise');
    expect(suggestPreset('splunk', 'inputs.acme.splunkcloud.com:9997')).toBe('splunk_cloud');
    expect(suggestPreset('splunk', 'idx1.corp.local')).toBe('splunk_enterprise');
    expect(suggestPreset('splunk_lb')).toBe('splunk_enterprise');
    expect(suggestPreset('sentinel')).toBe('sentinel');
    expect(suggestPreset('crowdstrike_next_gen_siem')).toBe('crowdstrike_ngsiem');
    expect(suggestPreset('humio_hec')).toBe('crowdstrike_ngsiem');
    expect(suggestPreset('S3')).toBe('s3');
    expect(suggestPreset('cribl_lake')).toBe('cribl_lake');
    expect(suggestPreset('databricks_zerobus')).toBe('databricks');
    expect(suggestPreset('devnull')).toBe('internal');
    expect(suggestPreset('webhook')).toBe('internal');
    expect(suggestPreset('')).toBe('internal');
  });
});

describe('isUnpricedPreset', () => {
  it('flags missing presets and the internal fallback on non-free types', () => {
    expect(isUnpricedPreset(undefined)).toBe(true);
    expect(isUnpricedPreset('internal')).toBe(true);
    expect(isUnpricedPreset('internal', 'webhook')).toBe(true);
    for (const t of FREE_OUTPUT_TYPES) expect(isUnpricedPreset('internal', t)).toBe(false);
    expect(isUnpricedPreset('splunk_cloud', 'webhook')).toBe(false);
  });
});

describe('isCustomPrice (P1-G01)', () => {
  it("is the member's own rate: no preset, or a price that is not the preset's typical", () => {
    expect(isCustomPrice(undefined)).toBe(false);
    expect(isCustomPrice({ preset: 'splunk_cloud', milliCentsPerGb: 225_000 })).toBe(false);
    expect(isCustomPrice({ preset: 'internal', milliCentsPerGb: 0 })).toBe(false);
    expect(isCustomPrice({ preset: 'splunk_cloud', milliCentsPerGb: 180_000 })).toBe(true);
    expect(isCustomPrice({ preset: 'internal', milliCentsPerGb: 180_000 })).toBe(true);
    expect(isCustomPrice({ milliCentsPerGb: 180_000 })).toBe(true);
    expect(isCustomPrice({ preset: 'retired_vendor', milliCentsPerGb: 180_000 })).toBe(true);
  });
});

describe('isFreeOutputType', () => {
  it('is true only for the genuinely free types (case and spacing ignored)', () => {
    for (const t of FREE_OUTPUT_TYPES) expect(isFreeOutputType(t)).toBe(true);
    expect(isFreeOutputType(' DevNull ')).toBe(true);
    expect(isFreeOutputType('cribl_lake')).toBe(false);
    expect(isFreeOutputType('splunk_hec')).toBe(false);
    expect(isFreeOutputType(undefined)).toBe(false);
  });
});

// ─── P0-04: suggestions on DevNull rigs ─────────────────────────────────────

const TAG = '[meter-reader-demo]';

describe('suggestPresetFor (P0-04)', () => {
  it('honours a preset the description names, by id or by label, before the type', () => {
    expect(presetFromDescription(`${TAG} Simulated SIEM destination (DevNull). Priced with the splunk_cloud preset in Meter Reader.`)).toBe('splunk_cloud');
    expect(presetFromDescription('Priced as Datadog Logs preset')).toBe('datadog');
    expect(presetFromDescription('priced with the S3 preset')).toBe('s3'); // ids and labels match in any case
    expect(presetFromDescription('Priced with the Amazon S3 preset')).toBe('s3');
    expect(presetFromDescription('Priced with the google-secops preset')).toBe('google_secops');
    expect(presetFromDescription('Priced with the Microsoft Sentinel preset')).toBe('sentinel');
    expect(presetFromDescription('Priced at the s3 preset')).toBe('s3');
    expect(presetFromDescription('Priced with the nope preset')).toBeUndefined();
    expect(presetFromDescription('a SIEM destination')).toBeUndefined();
    expect(presetFromDescription(undefined)).toBeUndefined();
    expect(suggestPresetFor({ type: 'splunk_hec', description: 'Priced with the sentinel preset' })).toBe('sentinel');
  });

  it('reads vendor words in the id only when the type names no paid preset', () => {
    expect(presetFromName('mrd_siem_prod')).toBe('splunk_cloud');
    expect(presetFromName('mrd_analytics')).toBe('datadog');
    expect(presetFromName('mrd_archive_s3')).toBe('s3');
    expect(presetFromName('mrd_siem_apps')).toBe('splunk_cloud');
    expect(presetFromName('Sentinel-EU')).toBe('sentinel');
    expect(presetFromName('devnull')).toBeUndefined();
    expect(presetFromName(undefined)).toBeUndefined();
    expect(presetFromName('lakehouse_x')).toBeUndefined(); // whole words only
    expect(presetFromName('siemens_plant')).toBeUndefined();
    expect(suggestPresetFor({ type: 'devnull', id: 'mrd_siem_prod' })).toBe('splunk_cloud');
    expect(suggestPresetFor({ type: 'webhook', id: 'datadog_relay' })).toBe('datadog');
    expect(suggestPresetFor({ type: 's3', id: 'siem_archive' })).toBe('s3'); // the type wins over the name
    expect(suggestPresetFor({ type: 'splunk_hec', id: 'archive' })).toBe('splunk_cloud');
    expect(suggestPresetFor({ type: 'devnull', id: 'devnull' })).toBe('internal');
    expect(suggestPresetFor({ type: 'webhook', id: 'hook' })).toBe('internal');
    expect(suggestPresetFor({ type: 'splunk', host: 'in.acme.splunkcloud.com' })).toBe('splunk_cloud');
    expect(suggestPresetFor({ type: 'default', id: 'default' })).toBe('internal');
    expect(suggestPresetFor({})).toBe('internal');
  });

  it('every demo rig destination (all DevNull) suggests its rig pricePreset, never Internal / free', () => {
    for (const d of rigDestinations.destinations) {
      expect(d.output.type).toBe('devnull');
      expect(suggestPresetFor({ ...d.output, id: d.output.id }), d.id).toBe(d.pricePreset);
      expect(presetById(suggestPresetFor(d.output))?.milliCentsPerGb, d.id).toBeGreaterThan(0);
    }
  });
});

describe('isFreeOutput (P0-04)', () => {
  it('is a free type that nothing marks as standing in for a paid destination', () => {
    expect(isFreeOutput({ type: 'devnull', id: 'devnull' })).toBe(true);
    expect(isFreeOutput({ type: 'router', id: 'fanout' })).toBe(true);
    // Founder-build r1 core-12 (M12): a router that splits across destinations is not free (its traffic reads unpriced).
    expect(isFreeOutput({ type: 'router', id: 'fanout', rules: [{ output: 'splunk' }, { output: 's3' }] })).toBe(false);
    expect(isFreeOutput({ type: 'router', id: 'fanout', rules: [{ output: 'splunk' }, { output: 's3', disabled: true }] })).toBe(true);
    expect(isFreeOutput('devnull')).toBe(true);
    expect(isFreeOutput(undefined)).toBe(false);
    expect(isFreeOutput({ type: 'devnull', id: 'mrd_siem_prod' })).toBe(false);
    expect(isFreeOutput({ type: 'devnull', id: 'sink', description: 'Priced with the s3 preset' })).toBe(false);
    expect(isFreeOutput({ type: 'devnull', id: 'mrd_other', description: `${TAG} demo sink` })).toBe(false);
    expect(isDemoTagged({ description: `${TAG} x` })).toBe(true);
    expect(isDemoTagged({ description: 'a sink' })).toBe(false);
    expect(isFreeOutput({ type: 'splunk_hec', id: 'devnull' })).toBe(false);
  });
});
