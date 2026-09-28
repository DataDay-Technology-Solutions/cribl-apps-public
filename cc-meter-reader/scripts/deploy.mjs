#!/usr/bin/env node
// Deploy a packaged .tgz to the Cribl.Cloud workspace in .env through the documented Apps API:
// PUT /apps (stage) → POST /apps/preinstall-check (the Review App data) → POST /apps (install) or
// PATCH /apps/{id} (upgrade) → poll GET /apps/{id}/backend/status until the backend is live.
// Usage: node scripts/deploy.mjs build/meter-reader-1.0.0.tgz [--id meter-reader]
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { api } from './cribl-api.mjs';

const file = process.argv[2];
const id = process.argv.includes('--id') ? process.argv[process.argv.indexOf('--id') + 1] : 'meter-reader';
if (!file) { console.error('usage: deploy.mjs <tgz> [--id meter-reader]'); process.exit(2); }

const up = await api('PUT', `/apps?filename=${encodeURIComponent(basename(file))}`, readFileSync(file), { contentType: 'application/octet-stream' });
if (up.status !== 200) { console.error('upload failed', up.status, JSON.stringify(up.json).slice(0, 500)); process.exit(1); }
const source = up.json.source;
console.log('staged', source);

const pre = await api('POST', '/apps/preinstall-check', { source });
console.log('preinstall-check', pre.status, JSON.stringify(pre.json).slice(0, 1500));

const existing = await api('GET', `/apps/${id}`);
let res;
if (existing.status === 200) res = await api('PATCH', `/apps/${id}`, { source });
else res = await api('POST', '/apps', { source, id });
console.log(existing.status === 200 ? 'upgrade' : 'install', res.status, JSON.stringify(res.json).slice(0, 800));
if (res.status >= 300) process.exit(1);

const t0 = Date.now();
while (Date.now() - t0 < 180_000) {
  const st = await api('GET', `/apps/${id}/backend/status`);
  const item = st.json?.items?.[0] ?? st.json;
  const state = item?.state ?? item?.status;
  process.stdout.write(`backend ${st.status} ${state ?? JSON.stringify(item).slice(0, 200)}\n`);
  if (st.status === 404 || state === 'succeeded' || state === 'failed' || state === 'none' || (Array.isArray(st.json?.items) && st.json.items.length === 0)) {
    if (state === 'failed') { console.error(JSON.stringify(item, null, 2).slice(0, 3000)); process.exit(1); }
    break;
  }
  await new Promise((r) => setTimeout(r, 4000));
}
console.log(`deployed ${id} in ${Math.round((Date.now() - t0) / 1000)} s`);
