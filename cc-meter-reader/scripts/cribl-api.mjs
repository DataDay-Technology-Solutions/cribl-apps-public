#!/usr/bin/env node
// Tiny Cribl.Cloud API client for build/deploy/validation scripts. Reads credentials from .env
// (git-ignored) and NEVER prints them. Usage:
//   node scripts/cribl-api.mjs GET /system/info
//   node scripts/cribl-api.mjs POST /m/default/version/commit '{"message":"x"}'
//   node scripts/cribl-api.mjs PUT-FILE /apps build/meter-reader-0.1.0.tgz
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv() {
  const env = {};
  const p = join(root, '.env');
  if (!existsSync(p)) return env;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return env;
}

const TOKEN_CACHE = join(root, 'node_modules', '.cache', 'mr-token.json');

export async function token() {
  const env = loadEnv();
  if (!env.CRIBL_CLIENT_ID || !env.CRIBL_CLIENT_SECRET) throw new Error('CRIBL_CLIENT_ID / CRIBL_CLIENT_SECRET missing in .env');
  try {
    const c = JSON.parse(readFileSync(TOKEN_CACHE, 'utf8'));
    if (c.expiresAt > Date.now() + 5 * 60_000) return c.token;
  } catch { /* no cache */ }
  const res = await fetch('https://login.cribl.cloud/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: env.CRIBL_CLIENT_ID, client_secret: env.CRIBL_CLIENT_SECRET, audience: 'https://api.cribl.cloud' }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  mkdirSync(dirname(TOKEN_CACHE), { recursive: true });
  writeFileSync(TOKEN_CACHE, JSON.stringify({ token: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 }), { mode: 0o600 });
  return j.access_token;
}

export function baseUrl() {
  const env = loadEnv();
  return `https://${env.CRIBL_WORKSPACE || 'main'}-${env.CRIBL_ORG}.cribl.cloud/api/v1`;
}

export async function api(method, path, body, { raw = false, contentType } = {}) {
  const t = await token();
  const headers = { authorization: `Bearer ${t}` };
  let payload;
  if (body !== undefined) {
    if (Buffer.isBuffer(body)) { payload = body; headers['content-type'] = contentType ?? 'application/octet-stream'; }
    else if (typeof body === 'string') { payload = body; headers['content-type'] = contentType ?? 'application/json'; }
    else { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  }
  const res = await fetch(baseUrl() + path, { method, headers, body: payload });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return raw ? { status: res.status, text, json, headers: Object.fromEntries(res.headers) } : { status: res.status, json: json ?? text };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [method, path, arg] = process.argv.slice(2);
  let r;
  if (method === 'PUT-FILE') r = await api('PUT', path, readFileSync(arg), { contentType: 'application/octet-stream' });
  else r = await api(method, path, arg ? arg : undefined);
  console.log(JSON.stringify(r, null, 2).slice(0, Number(process.env.MAX ?? 6000)));
}
