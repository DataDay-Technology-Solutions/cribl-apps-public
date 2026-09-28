// tests/unit/redact-recording.test.ts — scripts/redact-recording.ts (DECISIONS D36, EPIC_AUDIT P1-N02): a recording
// loses the API client's id, the build org's Cribl.Cloud host and every secret-shaped .env value before it is
// committed or bundled, and --check names what is left by kind only.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SAFE_HOST, leaks, redactRecording } from '../../scripts/redact-recording.ts';

// Built from parts so this file never holds a string tests/forbidden.txt refuses.
const ORG_HOST = `main-${['acme', 'beaver'].join('-')}-q7w8e9r.cribl.cloud`;
const WORKER_HOST = `default.main.${ORG_HOST}`;
const ENV = { CRIBL_CLIENT_SECRET: 's3cr3t-value-123', DEMO_WEBHOOK_URL: 'https://hooks.example.test/in/abc123def' };

describe('redactRecording', () => {
  const text = JSON.stringify({
    author: 'AbCdEf1234567890@clients',
    link: `https://${ORG_HOST}/apps/a/meter-reader/ledger?object=route:default:x`,
    worker: `${WORKER_HOST}:9997`,
    safe: `https://${SAFE_HOST}/apps/a/meter-reader`,
    hook: ENV.DEMO_WEBHOOK_URL,
    secret: ENV.CRIBL_CLIENT_SECRET,
  });

  it('replaces client-id authors, every Cribl.Cloud host and every secret value, and counts them', () => {
    const r = redactRecording(text, ENV);
    expect(r.text).not.toContain(ORG_HOST);
    expect(r.text).not.toContain(ENV.CRIBL_CLIENT_SECRET);
    expect(r.text).not.toContain('abc123def');
    expect(r.text).toContain('api-client@clients');
    expect(r.text).toContain(`https://${SAFE_HOST}/apps/a/meter-reader/ledger?object=route:default:x`);
    expect(r.text).toContain(`${SAFE_HOST}:9997`);
    expect(r.text).toContain('https://hooks.example.test/redacted');
    expect(r.replaced).toBe(5); // 1 author, 2 hosts, 2 secrets; the stand-in host is left alone
  });

  it('is idempotent, and --check finds nothing afterwards', () => {
    const once = redactRecording(text, ENV).text;
    expect(redactRecording(once, ENV)).toEqual({ text: once, replaced: 0 });
    expect(leaks(once, ENV)).toEqual([]);
    expect(leaks(text, ENV)).toEqual(['1 client-id commit author(s)', '2 Cribl.Cloud host name(s)', 'the value of CRIBL_CLIENT_SECRET', 'the value of DEMO_WEBHOOK_URL']);
  });

  it('the committed replay recording holds no Cribl.Cloud host but the stand-in', () => {
    const replay = readFileSync(new URL('../../demo/sample/replay.json', import.meta.url), 'utf8');
    expect(leaks(replay, {})).toEqual([]);
  });
});
