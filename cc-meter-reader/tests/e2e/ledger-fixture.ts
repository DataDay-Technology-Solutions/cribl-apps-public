// tests/e2e/ledger-fixture.ts — realistic and large Ledger data for the E2E specs, injected into the browser's
// emulated KV the same way the app's own sweep would store it (core/kv.ts documents, chunked when large).
//
// loadDemoFixture(): the real pipeline, run in a child `tsx` process by ledger-fixture.gen.ts (the emulator
//   imports JSON the Vite way, which Playwright's loader refuses) — the demo rig on the in-process emulator,
//   a week of hourly catch-up sweeps (full 7-day trend and 24-hour ratio series), then live minutes: a broken-
//   then-restored Kubernetes trim (a recovered, "recent" alert), the Windows pack applied, and the trim broken
//   on mrd_pay_sample (an open regression naming its commit, delivered to Slack). Timestamps end "now".
// buildScaleSnapshot(): 2,000 synthetic flows across three worker groups (the PRD 8.8 item 6 / SPEC 18 gate).
// injectLedgerDocs(): writes settings (runtime 'backend' so the open tab does not re-meter over the fixture,
//   polling at the slowest allowed cadence), prices, meta and the snapshot into the page's emulator.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { detectCodec } from '../../core/codec.ts';
import { createKvDocs, createMemoryKvStore } from '../../core/kv.ts';
import type { FlowFigures, FlowState, Incident, Meta, PricesDoc, Settings, Snapshot } from '../../core/types.ts';

export interface LedgerDocs {
  settings: Settings;
  prices: PricesDoc;
  meta: Meta;
  snapshot: Snapshot;
}

const GENERATOR = fileURLToPath(new URL('./ledger-fixture.gen.ts', import.meta.url));

/** Runs ledger-fixture.gen.ts (≈ 4 s) and returns its documents; timestamps end at `endMs`. */
export function loadDemoFixture(endMs: number = Date.now()): LedgerDocs {
  const out = execFileSync('npx', ['tsx', GENERATOR, String(endMs)], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out) as LedgerDocs;
}

// ─── Scale: 2,000 flows ──────────────────────────────────────────────────────

const SOURCES = ['windows', 'linux', 'firewall', 'vpc', 'k8s', 'payments', 'cdn', 'dns', 'proxy', 'db', 'okta', 'cloudtrail'];
const DESTS = ['siem_prod', 'analytics', 'archive_s3', 'lake', 'datadog'];
const STATES: FlowState[] = ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'learning', 'unpriced', 'regression', 'spike'];

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    s ^= s >>> 12;
    return (s >>> 0) / 4294967296;
  };
}

/** A snapshot with `n` synthetic flows (three groups, 12 sources, 5 destinations, 30-point sparklines). */
export function buildScaleSnapshot(base: Snapshot, n = 2000): Snapshot {
  const rnd = prng(2026);
  const flows: FlowFigures[] = [];
  for (let i = 0; i < n; i++) {
    const groupId = ['default', 'edge-east', 'edge-west'][i % 3];
    const src = SOURCES[i % SOURCES.length];
    const dest = DESTS[Math.floor(i / 7) % DESTS.length];
    const inputId = `${src}_${String(i).padStart(4, '0')}`;
    const routeId = `rt_${src}_${String(i % 97).padStart(2, '0')}`;
    const pipelineId = `${src}_${['trim', 'sample', 'agg', 'dedupe'][i % 4]}`;
    const ratio = 0.1 + rnd() * 0.75;
    const inBPerDay = Math.round((1 + rnd() * 400) * 1e9);
    const outBPerDay = Math.round(inBPerDay * (1 - ratio));
    const whpPerDayM = Math.round((inBPerDay / 1e9) * 150_000);
    const paidPerDayM = Math.round(whpPerDayM * (1 - ratio));
    const state = STATES[i % STATES.length];
    const spark = Array.from({ length: 30 }, (_, k) =>
      Math.max(0, Math.min(1, ratio + (rnd() - 0.5) * 0.06 - (state === 'regression' && k > 20 ? 0.25 : 0))),
    );
    flows.push({
      key: `${groupId}|${inputId}|${routeId}|${pipelineId}|${dest}`,
      groupId,
      inputId,
      routeId,
      pipelineId,
      outputId: dest,
      inB: Math.round(inBPerDay / 1440),
      outB: Math.round(outBPerDay / 1440),
      whpM: Math.round(whpPerDayM / 1440),
      paidM: Math.round(paidPerDayM / 1440),
      savedM: Math.round((whpPerDayM - paidPerDayM) / 1440),
      ratio,
      ratePerHourM: Math.round(paidPerDayM / 24),
      savedPerDayM: whpPerDayM - paidPerDayM,
      whpPerDayM,
      paidPerDayM,
      inBPerDay,
      outBPerDay,
      attribution: 'route',
      sparkline: spark,
      state,
    });
  }
  const incidents: Incident[] = [];
  return { ...base, flows, incidents, sweepAt: base.sweepAt };
}

// ─── Injection ───────────────────────────────────────────────────────────────

/** Serializes the documents exactly as the app stores them (chunked + gzip when large) and PUTs them into the page's emulator. */
export async function injectLedgerDocs(page: Page, docs: LedgerDocs): Promise<void> {
  const mem = createMemoryKvStore({ maxValueBytes: 10_000_000 });
  const kvDocs = createKvDocs({
    kv: mem,
    codec: detectCodec(),
    clock: { now: () => Date.now() },
  });
  await kvDocs.putSettings(docs.settings);
  await kvDocs.putPrices(docs.prices);
  await kvDocs.putMeta(docs.meta);
  await kvDocs.putSnapshot(docs.snapshot);
  const entries = [...mem.data.entries()];
  await page.evaluate(async (items) => {
    for (const [key, value] of items) {
      const url = `/mock-api/v1/kvstore/${key.split('/').map(encodeURIComponent).join('/')}`;
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        body: value,
      });
      if (!res.ok) throw new Error(`PUT ${key} → ${res.status}`);
    }
  }, entries);
}
