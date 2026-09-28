#!/usr/bin/env -S npx tsx
// Deletes every key in the App's KV store in the configured org (demo org maintenance only), then
// optionally seeds meta.collectingSince so the next sweep backfills from that minute.
// Usage: npx tsx scripts/reset-app-kv.ts --yes [--since 2026-09-26T05:46:00Z]
// @ts-expect-error — plain ESM helper
import { api } from './cribl-api.mjs';
import type { Meta } from '../core/types.ts';

if (!process.argv.includes('--yes')) {
  console.error('Refusing to delete without --yes (this wipes the App KV store in the org in .env).');
  process.exit(2);
}
const sinceArg = process.argv.includes('--since') ? process.argv[process.argv.indexOf('--since') + 1] : undefined;
const list = await api('POST', '/a/meter-reader/kvstore/keys', { prefix: '' });
const raw = list.json as unknown;
const keys: string[] = Array.isArray(raw) ? (raw as string[]) : ((raw as { items?: unknown[] })?.items ?? []).map((k) => (typeof k === 'string' ? k : (k as { key: string }).key));
for (const k of keys) {
  const key = k.replace(/^\/+/, '');
  const r = await api('DELETE', `/a/meter-reader/kvstore/${key}`);
  if (r.status >= 300 && r.status !== 404) console.error('delete failed', key, r.status);
}
console.log(`deleted ${keys.length} key(s)`);
if (sinceArg) {
  const since = new Date(sinceArg).toISOString();
  const meta: Meta = {
    schemaVersion: 1,
    installedAt: since,
    collectingSince: since,
    appVersion: 'runner',
    build: 'demo',
    metricsSource: 'metrics-query',
    sweepErrors: 0,
    consecutiveRateLimited: 0,
    sweepCount: 0,
  };
  const r = await api('PUT', '/a/meter-reader/kvstore/meta', JSON.stringify(meta), { contentType: 'text/plain' });
  console.log('meta.collectingSince =', since, 'PUT', r.status);
}
