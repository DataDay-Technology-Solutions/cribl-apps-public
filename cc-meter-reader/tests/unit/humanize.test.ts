import { describe, expect, it } from 'vitest';
import { DEMO_LABELS, HUMANIZE_DICTIONARY, displayAuthor, humanize, humanizeObjectKey, routeLabel } from '../../core/humanize.ts';

describe('humanize', () => {
  it('names a Pack on a route by its Dispensary name, never "Pack:cribl palo alto networks"', () => {
    expect(humanize('pack:cribl-palo-alto-networks')).toBe('Palo Alto Networks pack');
    expect(humanize('pack:cribl_splunk_forwarder_windows_xml_events_to_json')).toBe('Splunk Forwarder Windows XML Events to JSON pack');
    expect(humanize('pack:cc-cardinality-reduction')).toBe('Cardinality Reduction pack');
    expect(humanize('pack:acme-vpc-flow')).toBe('Acme VPC Flow pack');
    expect(humanize('pack:cribl-palo-alto-networks', { 'pack:cribl-palo-alto-networks': 'PAN pack' })).toBe('PAN pack');
  });
  it('returns every demo label exactly', () => {
    for (const [id, label] of Object.entries(DEMO_LABELS)) expect(humanize(id)).toBe(label);
    expect(humanize('mrd_pay_sample')).toBe('Payments API sampling');
  });
  it('names the rig destinations as the rig declares them, title-cased, never as slugs (P1-I04)', async () => {
    const { readFileSync } = await import('node:fs');
    const rig = JSON.parse(readFileSync(new URL('../../demo/rig/destinations.json', import.meta.url), 'utf8')) as { destinations: { id: string; label: string }[] };
    expect(rig.destinations.length).toBeGreaterThanOrEqual(4);
    for (const d of rig.destinations) {
      expect(humanize(d.id)).toBe(d.label);
      expect(humanize(d.id)).toMatch(/^[A-Z]/);
      expect(humanize(d.id)).not.toMatch(/[_-]/);
    }
    expect(humanize('mrd_siem_prod')).toBe('SIEM (prod)');
    expect(humanize('mrd_analytics')).toBe('Analytics');
    expect(humanize('mrd_archive_s3')).toBe('Archive (S3)');
  });
  it('applies the dictionary, strips prefixes and title-cases the first word', () => {
    expect(humanize('win_trim')).toBe('Windows trimming');
    expect(humanize('mr_fw_dedupe')).toBe('Firewall duplicate suppression');
    expect(humanize('mrd_k8s_noise_extra')).toBe('Kubernetes noise filter extra');
    expect(humanize('cdn-agg')).toBe('CDN aggregation');
    expect(humanize('siem_prod')).toBe('SIEM prod');
    expect(humanize('archive_s3')).toBe('Archive S3');
    expect(humanize('pan_xml_docs_reduce')).toBe('Palo Alto XML docs reduction');
    expect(humanize('vpc_dc_sample')).toBe('VPC DC sampling');
    expect(humanize('main')).toBe('Main');
    expect(humanize('other')).toBe('Other');
  });
  it('produces the same text for demo ids through the dictionary where derivable', () => {
    // Not in DEMO_LABELS once a user override clears it; the dictionary still reads well.
    expect(humanize('x_win_xml_pack')).toBe('X Windows XML pack');
    expect(humanize('win_xml_pack')).toBe('Windows XML pack');
  });
  it('lets overrides win (raw or stripped id)', () => {
    expect(humanize('mrd_pay_sample', { mrd_pay_sample: 'Payments trims' })).toBe('Payments trims');
    expect(humanize('mrd_custom', { custom: 'Custom thing' })).toBe('Custom thing');
    expect(humanize('mrd_pay_sample', { mrd_pay_sample: '  ' })).toBe('Payments API sampling');
  });
  it('handles degenerate ids', () => {
    expect(humanize('')).toBe('');
    expect(humanize('___')).toBe('___');
    expect(humanize('mrd_')).toBe('Mrd');
    expect(humanize(undefined as unknown as string)).toBe('');
  });
  it('humanizes object keys', () => {
    expect(humanizeObjectKey('pipe:default:mrd_pay_sample')).toBe('Payments API sampling');
    expect(humanizeObjectKey('route:default:mrd_windows_dc')).toBe('Windows DC security events');
    expect(humanizeObjectKey('plain_id')).toBe('Plain id');
  });
  it('dictionary covers the SPEC words', () => {
    for (const k of ['win', 'fw', 'k8s', 'agg', 'dedupe', 'trim', 'sample']) expect(HUMANIZE_DICTIONARY[k]).toBeTruthy();
  });
});

describe('routeLabel', () => {
  it("reads a route by the member's override, else its Cribl name, else its id humanized", () => {
    expect(routeLabel('r_win_servers', 'Windows member servers')).toBe('Windows member servers');
    expect(routeLabel('r_win_servers', 'Windows member servers', { r_win_servers: 'Member servers' })).toBe('Member servers');
    expect(routeLabel('r_vpc', undefined)).toBe('R VPC');
    expect(routeLabel('r_vpc', '  ')).toBe('R VPC');
  });
});

describe('displayAuthor (NOTIFY-3a issue 8)', () => {
  it("reads an API credential's client id as 'API client' with its last four characters, and leaves people alone", () => {
    // Rules round 2: two automations (a GitOps pipeline, a CI job) read apart; the id itself never travels.
    expect(displayAuthor('Zx9QvK3mTt0pLr7bN2cW5yH8dJ4aF6gE@clients')).toBe('API client ··F6gE');
    expect(displayAuthor('Ab12Cd34Ef56Gh78@clients')).toBe('API client ··Gh78');
    expect(displayAuthor(' abc@CLIENTS ')).toBe('API client');
    expect(displayAuthor('s.koelpin')).toBe('s.koelpin');
    expect(displayAuthor('Cribl System')).toBe('Cribl System');
    expect(displayAuthor('jane@example.com')).toBe('jane@example.com');
    expect(displayAuthor('two words@clients')).toBe('two words@clients');
    expect(displayAuthor('')).toBe('unknown');
    expect(displayAuthor('   ')).toBe('unknown');
    expect(displayAuthor(undefined)).toBe('unknown');
    expect(displayAuthor(null)).toBe('unknown');
  });
});
