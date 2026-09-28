#!/usr/bin/env -S npx tsx
// scripts/live-demo-run.ts — one full, measured Tier 0 demo cycle against the live org (PRD 12 validation
// agent: "demo script 3× in a row", "measured click-to-alert", hourly runs until Steve shows up).
//   break the trim → wait for the regression → check it names the trim commit + author → check the webhook
//   → restore → wait for the incident to close itself → append a row to docs/LIVE_VALIDATION.md
// Waits for any demo mute on the payments route to expire first (Restore mutes for 10 minutes, SPEC 11).
// Requires the runner (scripts/runner.ts) to be sweeping.   Usage: npx tsx scripts/live-demo-run.ts [--runs 3]
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { breakTrim, restoreTrim } from '../core/demo/levers.ts';
import { leverDepsFrom } from '../core/runtime.ts';
import { createKvDocs } from '../core/kv.ts';
import { fmtDollars, fmtDuration } from '../core/format.ts';
import { deps } from './runner.ts';
// @ts-expect-error — plain ESM helper
import { loadEnv } from './cribl-api.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = join(ROOT, 'docs', 'LIVE_VALIDATION.md');
const PIPE = 'mrd_pay_sample';
const OBJ = 'route:default:mrd_payments_api';
const author = process.env.MR_DEMO_AUTHOR || 's.koelpin';
const runs = process.argv.includes('--runs') ? Number(process.argv[process.argv.indexOf('--runs') + 1]) : 1;

const d = deps();
const docs = createKvDocs({ kv: d.kv, codec: d.codec, clock: d.clock });
const lever = leverDepsFrom(d, author);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hhmmss = (iso?: string) => (iso ? iso.slice(11, 19) : '—');

async function webhookCount(): Promise<number> {
  const uuid = String((loadEnv() as Record<string, string>).MR_DEMO_WEBHOOK_URL || '').split('/').pop();
  if (!uuid) return -1;
  const r = await fetch(`https://webhook.site/token/${uuid}/requests?per_page=1`, { headers: { accept: 'application/json' } });
  const j = (await r.json()) as { total?: number };
  return j.total ?? -1;
}

async function waitUntil<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v !== undefined) return v;
    await sleep(10_000);
  }
  console.error(`timed out waiting for ${what}`);
  return undefined;
}

async function oneRun(n: number): Promise<boolean> {
  const state = await docs.getDemoState();
  const mutedUntil = state?.muted?.[OBJ];
  if (mutedUntil && Date.parse(mutedUntil) > Date.now()) {
    const wait = Date.parse(mutedUntil) - Date.now() + 15_000;
    console.log(`run ${n}: ${OBJ} muted until ${mutedUntil}; waiting ${Math.round(wait / 1000)} s`);
    await sleep(wait);
  }
  const hooksBefore = await webhookCount();
  const br = await breakTrim(lever, { pipelineId: PIPE });
  if (!br.ok) { console.error('break refused', br); return false; }
  console.log(`run ${n}: broke the trim, commit ${br.commit}, deployed ${br.deployedAt}`);
  const since = Date.parse(br.deployedAt ?? new Date().toISOString()) - 5_000;
  const inc = await waitUntil('the regression', async () => {
    const s = await docs.getSnapshot();
    return s?.incidents.find((i) => i.objectKey === OBJ && i.type === 'regression' && Date.parse(i.openedAt) >= since && !i.closedAt);
  }, 8 * 60_000);
  const hooksAfterOpen = await webhookCount();
  const rsRaw = await restoreTrim(lever, { pipelineId: PIPE });
  if (!rsRaw.ok) { console.error('restore refused', rsRaw); return false; }
  const rs = rsRaw;
  console.log(`run ${n}: restored, commit ${rs.commit}, deployed ${rs.deployedAt}`);
  // D45: the open incident deepens while the drop settles (a deploy lands mid-minute); since D47 the close
  // keeps that deepest `after` and records the recovered ratio in `recoveredTo`. The row quotes the deepest
  // open reading, so it reports the settled drop rather than the partial minute it opened on.
  let deepest = inc;
  const closed = inc
    ? await waitUntil('recovery', async () => {
        const s = await docs.getSnapshot();
        const live = s?.incidents.find((i) => i.id === inc.id);
        if (live && !live.closedAt && deepest && live.after < deepest.after) deepest = live;
        return live?.closedAt ? live : undefined;
      }, 8 * 60_000)
    : undefined;
  const hooksAfterClose = await webhookCount();
  const namesTrim = !!inc?.commit && inc.commit.hash.startsWith(String(br.commit)) && inc.commit.author === author;
  const recoverySec = closed?.closedAt && rs.deployedAt ? Math.round((Date.parse(closed.closedAt) - Date.parse(rs.deployedAt)) / 1000) : undefined;
  const row = `| ${n}${process.argv.includes('--label') ? ` ${process.argv[process.argv.indexOf('--label') + 1]}` : ''} | ${hhmmss(br.deployedAt)} | ${hhmmss(inc?.openedAt)} | **${inc?.caughtInSec !== undefined ? fmtDuration(inc.caughtInSec) : 'none'}** | ${deepest ? `${deepest.before.toFixed(3)} → ${deepest.after.toFixed(3)}${deepest.after < inc!.after - 0.005 ? ` (opened at ${inc!.after.toFixed(3)})` : ''}` : '—'} | ${deepest ? `${fmtDollars(deepest.impactPerDayM)} · ${fmtDollars(deepest.impactPerDayM * 365)}` : '—'} | ${inc?.commit ? `\`${inc.commit.hash.slice(0, 7)}\` "${inc.commit.message}" · ${inc.commit.author} · matched by ${inc.commit.match}${namesTrim ? ' ✓' : ' ✗'}` : 'no commit ✗'} | ${hooksAfterOpen > hooksBefore ? `${hooksAfterOpen - hooksBefore} new` : 'none ✗'} | ${hhmmss(rs.deployedAt)} | ${closed ? `${hhmmss(closed.closedAt)} (${recoverySec} s), recovery webhooks +${hooksAfterClose - hooksAfterOpen}` : 'not closed ✗'} |`;
  appendFileSync(LOG, `${row}\n`);
  console.log(row);
  return !!inc && namesTrim && !!closed;
}

// Guard: the log must end with the run table (appended rows go under it).
if (!readFileSync(LOG, 'utf8').includes('| Run | Break (deploy returned) |')) throw new Error('docs/LIVE_VALIDATION.md is missing the run table');
let ok = 0;
for (let n = 1; n <= runs; n++) {
  if (await oneRun(n)) ok++;
}
console.log(`${ok}/${runs} clean`);
process.exit(ok === runs ? 0 : 1);
