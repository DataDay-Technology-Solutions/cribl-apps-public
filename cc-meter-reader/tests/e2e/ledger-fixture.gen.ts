// tests/e2e/ledger-fixture.gen.ts — builds the Ledger's demo fixture with the real sweep pipeline and prints it
// as JSON on stdout. Run by ledger-fixture.ts in a child `tsx` process: `npx tsx tests/e2e/ledger-fixture.gen.ts [endMs]`.
// (The in-process emulator imports JSON the Vite way, which only tsx/Vite resolve — not Playwright's loader.)

import { applyPack, breakTrim, restoreTrim } from '../../core/demo/levers.ts';
import type { Meta, PricesDoc, Settings, Snapshot } from '../../core/types.ts';
import { createWorld, DAY, HOUR, MINUTE, SINK_ENDPOINT } from '../integration/harness.ts';

interface LedgerDocs {
  settings: Settings;
  prices: PricesDoc;
  meta: Meta;
  snapshot: Snapshot;
}

const SLACK_ENDPOINT = {
  ...SINK_ENDPOINT,
  id: 'ep_slack',
  name: 'Slack · #finops-alerts',
  url: 'https://hooks.slack.com/services/T0000/B0000/meterreaderdemo',
  host: 'hooks.slack.com',
  format: 'slack' as const,
};

/** Settings the injected fixture runs under: no metering in the tab, the slowest polling, demo mode off. */
function viewerSettings(base: Settings): Settings {
  return {
    ...base,
    runtime: 'backend',
    live: { pollSeconds: 60, presenterPollSeconds: 30 },
    demo: { ...base.demo, enabled: false, replayMode: false },
  };
}

/** The demo rig, metered for a week and driven through a spike, a pack and a broken trim. Ends at `endMs`. */
async function buildDemoFixture(endMs: number = Date.now()): Promise<LedgerDocs> {
  const end = Math.floor(endMs / MINUTE) * MINUTE;
  const start = end - 7 * DAY + 20_000;
  const w = await createWorld({
    start,
    options: { retentionHours: 24 * 9 },
    settings: (s) => {
      s.displayTimezone = 'America/Chicago';
      s.notifications = [{ ...SLACK_ENDPOINT }];
    },
  });
  await w.docs.putMeta({
    schemaVersion: 1,
    installedAt: new Date(start - HOUR).toISOString(),
    collectingSince: new Date(start - HOUR).toISOString(),
    appVersion: '1.0.0',
    build: 'release',
    metricsSource: 'metrics-query',
    sweepErrors: 0,
    consecutiveRateLimited: 0,
    sweepCount: 0,
  });
  // A week of catch-up, one sweep an hour (each backfills its hour; the detector skips backfilled minutes).
  const liveFrom = end - 70 * MINUTE;
  while (w.now() + HOUR < liveFrom) {
    w.advance(HOUR);
    await w.sweep('ui');
  }
  w.set(liveFrom - MINUTE + 20_000);
  const untilMinute = async (t: number) => {
    while (w.now() + MINUTE <= t) await w.sweepMinutes(1);
  };
  const ok = (r: { ok: boolean }, what: string) => {
    if (!r.ok) throw new Error(`fixture lever failed: ${what} ${JSON.stringify(r)}`);
  };
  await untilMinute(end - 56 * MINUTE); // warm the baselines on live minutes
  ok(await breakTrim(w.lever, { pipelineId: 'mrd_k8s_noise' }), 'break k8s trim');
  await untilMinute(end - 46 * MINUTE);
  ok(await restoreTrim(w.lever, { pipelineId: 'mrd_k8s_noise' }), 'restore k8s trim');
  await untilMinute(end - 27 * MINUTE);
  ok(await applyPack(w.lever, { routeId: 'mrd_windows_workstations' }), 'apply pack');
  await untilMinute(end - 19 * MINUTE);
  ok(await breakTrim(w.lever, { pipelineId: 'mrd_pay_sample' }), 'break trim');
  await untilMinute(end);

  const snapshot = await w.docs.getSnapshot();
  const settings = await w.settings();
  const prices = await w.docs.getPrices();
  const meta = await w.meta();
  if (!snapshot || !prices || !meta) throw new Error('fixture: the world produced no snapshot');
  return { snapshot, settings: viewerSettings(settings), prices, meta };
}

const endArg = Number(process.argv[2]);
const docs = await buildDemoFixture(Number.isFinite(endArg) && endArg > 0 ? endArg : Date.now());
process.stdout.write(JSON.stringify(docs));
