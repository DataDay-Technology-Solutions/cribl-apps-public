#!/usr/bin/env -S npx tsx
// scripts/redact-recording.ts — strip credentials from a recording before it is committed or bundled.
//
// A real run (scripts/record-replay.ts) captures what the Leader returns, and two things in it are ours
// rather than the product's: commits made with the API credential carry the OAuth client id as their author
// (`<client id>@clients`, NOTIFY-3a issue 8), and the stored settings carry the demo receiver's webhook URL
// from .env. Both would end up in the demo build (static/assets/replay-*.js, story-live-*.js).
//
//   npx tsx scripts/redact-recording.ts            redact demo/sample/replay.json in place
//   npx tsx scripts/redact-recording.ts --check    exit 1 if a recording still holds either
//
// Client-id authors become `api-client@clients`, which core/humanize.ts displayAuthor() already renders as
// "API client", so nothing on screen changes. A Cribl.Cloud host (`<workspace>-<org id>.cribl.cloud`, which names
// the build org: a delivered alert's "Open in Ledger" link) becomes `main-example-org.cribl.cloud` (EPIC_AUDIT
// P1-N02; tests/forbidden.txt refuses the org's id in anything published). A secret-shaped .env value (the compliance test's rule) that is
// a URL keeps its origin and loses its path; any other value becomes `redacted`. Run scripts/story.ts after
// redacting so story-live.json follows.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain ESM helper without type declarations
import { loadEnv } from './cribl-api.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** The same rule as tests/compliance.test.ts: .env keys whose values must appear nowhere we publish. */
const SECRET_KEY = /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|CLIENT_ID|WEBHOOK|DSN|AUTH|COOKIE|SESSION)/i;
const CLIENT_AUTHOR = /\b[A-Za-z0-9_-]{8,}@clients\b/g;
const SAFE_AUTHOR = 'api-client@clients';
/** Any Cribl.Cloud host: Leader, workspace or worker endpoint. */
const CLOUD_HOST = /\b[a-z0-9][a-z0-9.-]*\.cribl(?:-staging)?\.cloud\b/gi;
export const SAFE_HOST = 'main-example-org.cribl.cloud';

export interface Redaction {
  text: string;
  /** How many client-id authors and secret values were replaced. */
  replaced: number;
}

/** Secret-shaped values from an env map (at least 8 characters, as the compliance scan counts them). */
export function secretValues(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([k, v]) => SECRET_KEY.test(k) && typeof v === 'string' && v.length >= 8)
    .map(([, v]) => v as string)
    .sort((a, b) => b.length - a.length); // longest first, so a value inside another is not split
}

function standIn(value: string): string {
  try {
    const u = new URL(value);
    if (u.protocol === 'http:' || u.protocol === 'https:') return `${u.origin}/redacted`;
  } catch {
    /* not a URL */
  }
  return 'redacted';
}

/** Replaces client-id authors, Cribl.Cloud hosts and every secret value in a recording's text. */
export function redactRecording(text: string, env: Record<string, string | undefined>): Redaction {
  let replaced = 0;
  let out = text.replace(CLIENT_AUTHOR, (m) => {
    if (m === SAFE_AUTHOR) return m;
    replaced += 1;
    return SAFE_AUTHOR;
  });
  out = out.replace(CLOUD_HOST, (m) => {
    if (m.toLowerCase() === SAFE_HOST) return m;
    replaced += 1;
    return SAFE_HOST;
  });
  for (const value of secretValues(env)) {
    const parts = out.split(value);
    if (parts.length > 1) {
      replaced += parts.length - 1;
      out = parts.join(standIn(value));
    }
  }
  return { text: out, replaced };
}

/** What a recording still leaks: client-id authors, Cribl.Cloud hosts and secret values (named by kind, never printed). */
export function leaks(text: string, env: Record<string, string | undefined>): string[] {
  const found: string[] = [];
  const authors = (text.match(CLIENT_AUTHOR) ?? []).filter((m) => m !== SAFE_AUTHOR);
  if (authors.length > 0) found.push(`${authors.length} client-id commit author(s)`);
  const hosts = (text.match(CLOUD_HOST) ?? []).filter((m) => m.toLowerCase() !== SAFE_HOST);
  if (hosts.length > 0) found.push(`${hosts.length} Cribl.Cloud host name(s)`);
  const keys = Object.entries(env).filter(([k, v]) => SECRET_KEY.test(k) && typeof v === 'string' && v.length >= 8 && text.includes(v));
  for (const [k] of keys) found.push(`the value of ${k}`);
  return found;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const check = process.argv.includes('--check');
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const targets = files.length > 0 ? files.map((f) => join(process.cwd(), f)) : [join(ROOT, 'demo', 'sample', 'replay.json')];
  const env = loadEnv() as Record<string, string>;
  let bad = 0;
  for (const file of targets) {
    const name = relative(ROOT, file);
    const text = readFileSync(file, 'utf8');
    if (check) {
      const found = leaks(text, env);
      if (found.length > 0) {
        bad += 1;
        console.error(`${name}: ${found.join(', ')}. Run: npx tsx scripts/redact-recording.ts ${name}`);
      } else console.log(`${name}: clean`);
      continue;
    }
    const r = redactRecording(text, env);
    if (r.replaced > 0) writeFileSync(file, r.text);
    console.log(`${name}: ${r.replaced} replaced`);
  }
  if (bad > 0) process.exit(1);
}
