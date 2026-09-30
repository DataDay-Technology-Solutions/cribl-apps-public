// tests/unit/r1-core-deeplinks.test.ts — founder-build r1 core-8 (FINDINGS_R1 M10 #34, contract C2). The release's
// deep links ("Open in Ledger", "Open the Receipt") were built on the iframe's base path, `/app-ui/meter-reader`. From
// Slack's web client, Gmail or PagerDuty's web UI (a cross-site click) that path answers the bare iframe page, the init
// script returns early and the member lands on "Meter Reader couldn't start…". The shell's own path,
// `https://<org>.cribl.cloud/apps/a/meter-reader`, works from anywhere; the runner already used it. A tab's sweep now
// builds every link on it, whatever CRIBL_BASE_PATH says.

import { describe, expect, it } from 'vitest';
import { runSweep } from '../../core/sweep.ts';
import { runWeeklyReceipt } from '../../core/weekly.ts';
import { createBrowserDeps } from '../../core/runtime.ts';
import { breakTrim } from '../../core/demo/levers.ts';
import { renderAlert } from '../../core/delivery.ts';
import type { CanonicalPayload } from '../../core/types.ts';
import { MINUTE, createWorld, emulatorFetch } from '../integration/harness.ts';

describe('core-8 · every link a sweep sends is /apps/a/meter-reader (C2)', () => {
  it('a tab inside the iframe (CRIBL_BASE_PATH /app-ui/meter-reader): webhook payloads, bell text, target text and the weekly receipt carry no /app-ui/', async () => {
    const w = await createWorld();
    const deps = createBrowserDeps(
      {
        CRIBL_API_URL: 'https://main-example-org.cribl.cloud/mock-api/v1/',
        CRIBL_BASE_PATH: '/app-ui/meter-reader',
        fetch: emulatorFetch(w.em),
        crypto: { randomUUID: () => 'tab1' },
      },
      { appVersion: '1.1.1', build: 'demo', logger: w.deps.logger },
    );
    expect(deps.linkBase).toBe('https://main-example-org.cribl.cloud/apps/a/meter-reader');
    // The world's own transports (its bell answers), with the link base the tab derives.
    const sweep = () => runSweep({ ...w.deps, linkBase: deps.linkBase }, { mode: 'ui' });
    expect((await sweep()).error).toBeUndefined();
    const b = await breakTrim(w.lever, { pipelineId: 'mrd_pay_sample' });
    expect(b.ok).toBe(true);
    let opened = 0;
    for (let i = 0; i < 5; i++) {
      w.set(Math.floor(w.now() / MINUTE) * MINUTE + MINUTE + 20_000);
      opened += (await sweep()).opened;
    }
    expect(opened).toBeGreaterThan(0);
    const weekly = await runWeeklyReceipt({ ...w.deps, linkBase: deps.linkBase }, { mode: 'manual' });
    expect(weekly.receipt?.link).toMatch(/^https:\/\/main-example-org\.cribl\.cloud\/apps\/a\/meter-reader\//);

    const sink = w.em.sink().map((e) => JSON.stringify(e.json));
    expect(sink.length).toBeGreaterThan(0);
    // The bell's text and a notification target's message are rendered from the same canonical payload the generic
    // webhook received (core/delivery.ts renderAlert): render them from it.
    const rendered = w.em
      .sink()
      .map((e) => e.json as CanonicalPayload)
      .filter((c) => c && c.app === 'meter-reader')
      .flatMap((c) => {
        const r = renderAlert(c);
        return [r.title, r.line, r.text];
      });
    expect(rendered.some((t) => t.includes('Open in Ledger: https://main-example-org.cribl.cloud/apps/a/meter-reader/ledger?object='))).toBe(true);
    for (const body of [...sink, ...rendered, weekly.text ?? '']) expect(body).not.toContain('/app-ui/');
    expect(sink.some((s) => s.includes('https://main-example-org.cribl.cloud/apps/a/meter-reader/ledger?object='))).toBe(true);
    expect(JSON.stringify(await w.docs.getSnapshot())).not.toContain('/app-ui/');
  }, 120_000);
});
