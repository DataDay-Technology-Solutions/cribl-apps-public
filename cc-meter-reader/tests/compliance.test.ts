// tests/compliance.test.ts — Stage One and package compliance (SPEC 16 "Compliance", PRD 2.1, 2.2, 12 item 5,
// 13; DECISIONS D5, D11, D12b, D13, D17 N13/N26, D22, D23, D30).
//
// Proves, on every run:
//   • LICENSE is the full Apache-2.0 text with the copyright line filled in.
//   • README.md carries every PRD 13 section, in order, plus the facts the judges check (every release
//     grant, the Enterprise variant's declared host, the SPEC 12.6 sentence, the dry-run caveat of any
//     preview grant, a Stage One checklist, the dependency table with the exact license of each package),
//     no raw HTML (the Marketplace ignores it), and no relative link that points at nothing.
//   • The README inside the release package is the Marketplace overview (scripts/package.mjs
//     `packagedReadme`): the hero image is in the package, every other link is absolute, the hackathon-only
//     sections are out, and no link, image or #anchor in it fails to resolve (EPIC_AUDIT P0-11).
//   • package.json version === the primary release .tgz version (=== the git tag on HEAD, when tagged).
//   • No forbidden string (tests/forbidden.txt) in any file git would publish or in any packaged file, and
//     no value of a secret-shaped .env key anywhere. The rule file is private (it lists the strings it refuses), so
//     the public export leaves it out: there the forbidden-string half is skipped, by name, and the .env half still
//     runs; scripts/publish-public.sh scans the export with the private copy instead.
//   • The RELEASE package writes nothing but the documented notification posts (D23, D30): every grant in
//     default/policies.yml is a GET, a metrics-query POST, a dry-run POST (DRY_RUN_POSTS) or exactly one of
//     NOTIFICATION_WRITES; no default/backend.yml, default/schedules.yml or default/proxies.yml (D23: the
//     release installs on every plan); no demo route, chunk or "Demo Console" string; no mock.
//   • The DEMO package carries the -demo marker (file name + displayName; its version is plain numeric, D22),
//     is a real demo build, is a superset of the release grants, and is never the primary asset. The
//     optional BACKEND package (the Enterprise variant) declares no demo endpoints, stays inside the
//     platform's limits, and declares no host either (D57: no build stores a webhook URL).
//   • NO BUILD STORES A CREDENTIAL IN KV (D57, rule 4.5): no package carries the direct-webhook editor's copy, and
//     core refuses and strips a webhook endpoint or URL in the settings document.
//
// Packages are read from release/. A missing release or Enterprise package is built there first with
// scripts/package.mjs; a demo build (never committed) is built into a temporary directory when release/ holds none,
// so a test run leaves nothing new in release/. MR_COMPLIANCE_REBUILD=1 rebuilds all of them.

import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_ICON,
  HERO_IMAGE,
  HERO_MAX_BYTES,
  README_IMAGES,
  REPO_ONLY_SECTIONS,
  REPO_URL,
  SCAFFOLD_ICON,
  THIRD_PARTY_FILE,
  headingAnchors,
  linkSpans,
  markdownLinks,
  mediaSizeProblems,
  packagedReadme,
  readmeLinkProblems,
  repoFileUrl,
  shippedFonts,
  thirdPartyNotices,
} from '../scripts/package.mjs';
import { COMMUNITY_REPO, PUSHED_AT_SUBMISSION, exportClaudeMd, stagingReadme } from '../scripts/export-wording.mjs';
import { SAVED_SEARCHES_PATH, SEARCH_NOTIFY_PATH, relayNotificationsPath, savedSearchPath } from '../core/adapters/cribl-notify.ts';
import { en } from '../src/copy/en.ts';
import { CREDIT_STRINGS } from '../core/strings.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
/** The strings nothing published may hold (word | text | regex). Private: the public export leaves it out. */
const FORBIDDEN_RULES = 'tests/forbidden.txt';

// YAML: @cribl/apps' own parser (a dependency of our devDependency), resolved the way @cribl/apps resolves it.
const nodeRequire = createRequire(import.meta.url);
const YAML = createRequire(nodeRequire.resolve('@cribl/apps/package'))('yaml') as { parse(src: string): unknown };

// ─── The contract ────────────────────────────────────────────────────────────

/** PRD 13 "README must contain, in this order" (items 1–11), then the scaffold's gallery table last. */
const README_HEADINGS: readonly string[] = [
  '# Meter Reader', // 1. hero GIF and the pitch
  '## Summary', // Marketplace template: App title and summary, with the intended users
  '## Try it', // 2. (no install-time claim until the post-freeze clean install measures one: FOUNDER_PLAN rows 3, 5, 7)
  '### Before you install', // Marketplace template
  '### Install', // 2. (second half)
  '### Configuration', // Marketplace template
  '## What it does', // 3.
  '### When to use', // Marketplace template
  '## How it uses the platform', // 4. APIs, KV keys, runtimes, proxy hosts, two packages, policies.yml
  '### Permissions and external access', // Marketplace template
  '### Data and storage', // Marketplace template
  '## Backend functions and schedules', // 5.
  '## The money model', // 6.
  '## Demo rig', // 7.
  '## Known limitations', // Marketplace template: known limitations and troubleshooting
  '## Troubleshooting', // Marketplace template
  '## Build disclosure', // 8.
  '## AI tool and third-party disclosure', // 9.
  '## What exists and what Meter Reader adds', // 10.
  '### Roadmap', // 10.
  '## Engineering notes', // 10a.
  '## Accessibility and keyboard', // 10a.
  '## Evidence report', // 10a.
  '## Stage One checklist', // 10a.
  '## Pitch', // 11.
  '## Support model', // Marketplace template
  '## App Metadata', // scaffold gallery table (kept last)
];

/**
 * SPEC 12.6 as D57 rewrote it (hackathon rule 4.5): where webhook URLs live, which is never KV. The README says it in
 * the KV keys section and in the Engineering notes; the old sentence ("Webhook URLs are stored as App settings in the
 * KV store") must not come back.
 */
const NO_CREDENTIAL_IN_KV = '**No credential is stored in KV, in any build** (D57)';
const OLD_WEBHOOK_SENTENCE = 'Webhook URLs are stored as App settings in the KV store';

/** Non-GET grants that are reads despite the verb: metrics queries. */
const READ_ONLY_POSTS = new Set(['/system/metrics/query', '/system/metrics/enum']);
/**
 * Non-GET grants that change no configuration: the What-if dry run (DECISIONS D16, D30). `POST /preview`
 * (`createPreview`, group-scoped) runs sample events through a pipeline and returns them; Meter Reader sends
 * `mode: 'pipe'` only. The grant cannot restrict the mode, and Cribl's `routeAndSend` mode would deliver the
 * sample events to Destinations, so a release that declares it must say so in the README (asserted below).
 * Allowed, not required: the release passes with or without it.
 */
const DRY_RUN_POSTS = new Set(['/m/:gid/preview']);
/**
 * The release's only writes (DECISIONS D23, D30, docs/NOTIFICATIONS.md): alert delivery through Cribl. Each
 * one creates — a bell message, the never-scheduled relay saved search and its notification (only on a
 * confirmed Connect in Settings), a forwarded alert — and none replaces or deletes. Listed exactly, so any
 * new write fails this test until it is documented here and in the README. The relay's paths are literal
 * (EPIC_AUDIT P1-N01): the Search group and the relay's id are fixed (core/adapters/cribl-notify.ts), so a
 * notification can be attached to the relay only, never to another saved search.
 */
const NOTIFICATION_WRITES: readonly string[] = [
  'POST /system/messages',
  'POST /m/default_search/search/saved',
  'POST /m/default_search/search/saved/meter_reader_alert_relay/notifications',
  'POST /search/notifications',
];
/** The one relay read: the relay saved search itself (literal, P1-N01), to show whether a target is connected. */
const RELAY_READ = 'GET /m/default_search/search/saved/meter_reader_alert_relay';
/**
 * No package declares an external host: the release and the demo build because App proxies need an Enterprise plan
 * (D23), and the Enterprise variant since D57 (no build stores a webhook URL, so no build posts to a webhook host;
 * alerts go through Cribl's bell and notification targets, and the runner sends direct webhooks from its .env).
 */
const DECLARED_HOSTS: string[] = [];
/** Permissive licenses compatible with Apache-2.0. Capra is disclosed separately (Cribl Developer Agreement). */
const ALLOWED_LICENSES = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD']);
/** .env keys whose values are secrets. Their values must appear nowhere we publish. */
const SECRET_KEY = /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|CLIENT_ID|WEBHOOK|DSN|AUTH|COOKIE|SESSION)/i;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|ttf|otf|woff2?|eot|tgz|gz|zip|crbl|pdf|mp4|mov|webm|mp3|wav|m4a)$/i;
/** Claims the front-end runtime cannot make (DECISIONS D12b: "Copy never claims 'with the tab closed'"). */
const CLOSED_TAB_CLAIM = /(with|even with) the (tab|app) closed|\b(tab|app) (is )?closed\b|open or closed|even when closed|nobody (is )?watching/i;

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface PackageJson {
  name?: string;
  version?: string;
  displayName?: string;
  license?: string;
  author?: string;
  cribl?: { type?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
interface Policy {
  object: string;
  actions: string[];
}
interface Extracted {
  file: string;
  dir: string;
  /** '/'-separated paths of every regular file, relative to the archive root. */
  files: string[];
  pkg: PackageJson;
  has(path: string): boolean;
  text(path: string): string;
}
interface Rule {
  line: number;
  kind: 'word' | 'text' | 'regex';
  re: RegExp;
  /**
   * 'all': every file git would publish and every package. 'public' (after `# scope: public` in the rule file,
   * EPIC_AUDIT P1-N02): every package and every file scripts/publish-public.sh exports, i.e. not its PRIVATE_PATHS.
   */
  scope: 'all' | 'public';
}

const ROOT_PKG = JSON.parse(read('package.json')) as PackageJson;
const VERSION = ROOT_PKG.version ?? '';
const PRIMARY_TGZ = `release/meter-reader-${VERSION}.tgz`;
const DEMO_TGZ_DEFAULT = `release/meter-reader-${VERSION}-demo.tgz`;
const BACKEND_TGZ = `release/meter-reader-${VERSION}-backend.tgz`;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

const extracted: Extracted[] = [];
/** Extracts a package: `fileRel` is relative to the repository, or absolute (a demo build in a temporary directory). */
function extract(fileRel: string): Extracted {
  const dir = mkdtempSync(join(tmpdir(), 'mr-compliance-'));
  execFileSync('tar', ['-xzf', resolve(ROOT, fileRel), '-C', dir]);
  const files = walk(dir).map((p) => relative(dir, p).split(sep).join('/'));
  const set = new Set(files);
  const x: Extracted = {
    file: fileRel,
    dir,
    files,
    pkg: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson,
    has: (p) => set.has(p),
    text: (p) => readFileSync(join(dir, p), 'utf8'),
  };
  extracted.push(x);
  return x;
}

function isBinary(path: string, buf: Buffer): boolean {
  if (BINARY_EXT.test(path)) return true;
  return buf.subarray(0, 8000).includes(0);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadRules(): Rule[] {
  const rules: Rule[] = [];
  let scope: Rule['scope'] = 'all';
  read(FORBIDDEN_RULES)
    .split('\n')
    .forEach((raw, i) => {
      const line = raw.trim();
      const directive = /^#\s*scope:\s*(\S+)\s*$/.exec(line);
      if (directive) {
        if (directive[1] !== 'public') throw new Error(`tests/forbidden.txt:${i + 1}: unknown scope "${directive[1]}" (public)`);
        scope = 'public';
        return;
      }
      if (line === '' || line.startsWith('#')) return;
      const space = line.indexOf(' ');
      const kind = line.slice(0, space);
      const pattern = line.slice(space + 1).trim();
      if (space < 0 || pattern === '') throw new Error(`tests/forbidden.txt:${i + 1}: expected "<kind> <pattern>"`);
      if (kind === 'word') rules.push({ line: i + 1, kind, scope, re: new RegExp(`(?<![A-Za-z0-9])${escapeRe(pattern)}(?![A-Za-z0-9])`, 'i') });
      else if (kind === 'text') rules.push({ line: i + 1, kind, scope, re: new RegExp(escapeRe(pattern), 'i') });
      else if (kind === 'regex') rules.push({ line: i + 1, kind, scope, re: new RegExp(pattern) });
      else throw new Error(`tests/forbidden.txt:${i + 1}: unknown kind "${kind}" (word | text | regex)`);
    });
  return rules;
}

/**
 * The positive samples the public-scope rules must catch, kept in the rule file as `# must-match <what>: <sample>`
 * comment lines (both parsers skip comments), so this file never holds the strings the rules refuse, not even
 * built from parts: the public export publishes this file and leaves the rule file out.
 */
function mustMatchSamples(): { what: string; sample: string }[] {
  return read(FORBIDDEN_RULES)
    .split('\n')
    .map((raw) => /^#\s*must-match\s+([^:]+):\s*(\S.*?)\s*$/.exec(raw.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ what: m[1].trim(), sample: m[2] }));
}

/** The script that builds the public export; the export itself leaves it out (it is one of its PRIVATE_PATHS). */
const PUBLISH_SCRIPT = 'scripts/publish-public.sh';
/**
 * The private-by-policy paths scripts/publish-public.sh drops from the public export (its PRIVATE_PATHS array),
 * read from the script so the two can never disagree. Files under them are still scanned for the 'all' rules.
 * In the exported tree the script is absent and so are those paths: everything there is public, so none.
 */
function privatePaths(): string[] {
  if (!existsSync(join(ROOT, PUBLISH_SCRIPT))) return [];
  const m = /^PRIVATE_PATHS=\(\n([\s\S]*?)\n\)/m.exec(read(PUBLISH_SCRIPT));
  if (!m) throw new Error('scripts/publish-public.sh has no PRIVATE_PATHS=( … ) array');
  return m[1].split(/\s+/).filter(Boolean);
}
/** Exact files under PRIVATE_PATHS that the export keeps anyway (the script's PUBLIC_KEEP array); none in the export. */
function publicKeep(): string[] {
  if (!existsSync(join(ROOT, PUBLISH_SCRIPT))) return [];
  const m = /^PUBLIC_KEEP=\(\n([\s\S]*?)\n\)/m.exec(read(PUBLISH_SCRIPT));
  return m ? m[1].split(/\s+/).filter(Boolean) : [];
}
const isUnder = (rel: string, paths: readonly string[]): boolean => paths.some((p) => rel === p || rel.startsWith(`${p}/`));
/** True in the public export, which leaves scripts/publish-public.sh out along with its PRIVATE_PATHS. */
const IN_PUBLIC_EXPORT = !existsSync(join(ROOT, PUBLISH_SCRIPT));
/**
 * Files this test reads that the public export drops (a subset of PRIVATE_PATHS, checked against it in the private
 * tree): required or read only in the private tree, so the export passes its own npm test (RELEASE_PLAN B3).
 */
const EXPORT_DROPS = ['STATE.md', 'docs/POSTS.md', 'tests/forbidden.txt'] as const;
const inThisTree = (rel: string): boolean => !(IN_PUBLIC_EXPORT && (EXPORT_DROPS as readonly string[]).includes(rel));
/**
 * The forbidden-string rules run wherever the rule file belongs: always in the private tree (a missing file fails
 * there), never in the public export, which leaves the file out because it lists the very strings it refuses.
 */
const RULES_HERE = inThisTree(FORBIDDEN_RULES);
const RULES_SKIPPED =
  ' [forbidden-string rules skipped: tests/forbidden.txt is private and not in the public export; scripts/publish-public.sh scans the export with it]';

/** Files git would publish: tracked, plus untracked files that are not ignored. */
function publishableFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  return [...new Set(out.split('\0').filter(Boolean))].filter((p) => {
    const abs = join(ROOT, p);
    return existsSync(abs) && statSync(abs).isFile();
  });
}

/**
 * The files scripts/publish-public.sh exports: tracked files minus its PRIVATE_PATHS (plus its PUBLIC_KEEP files). In
 * the export itself PRIVATE_PATHS is empty, so this is every tracked file there: the same set, checked in both trees.
 */
function exportedFiles(): string[] {
  const privates = privatePaths();
  const keep = publicKeep();
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((rel) => rel && existsSync(join(ROOT, rel)) && (!isUnder(rel, privates) || keep.includes(rel)));
}

/**
 * License and notice texts: they must keep their authors' copyright lines, email addresses included, so the address
 * scan skips them (LICENSE, the generated THIRD-PARTY-LICENSES.md, the font licenses under licenses/).
 */
const LICENSE_NOTICE = /(^|\/)(LICENSE|LICENSE\.txt|NOTICE|THIRD-PARTY-LICENSES\.md)$|^licenses\//;
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
/** Domains that name no one: the reserved example and test names (RFC 2606, RFC 6761) and GitHub's no-reply host. */
const NOBODY_DOMAIN = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost|users\.noreply\.github\.com)$/i;
/** `name@2x.png` is an image suffix, not an address. */
const FILE_SUFFIX = /\.(png|jpe?g|gif|svg|webp|ico|json|md|txt|m?js|tsx?|css|html|ya?ml)$/i;
/**
 * Personal email addresses in a text, as "<line> (<domain>)" (the address itself is never printed). Not addresses: an
 * example or test domain, URL userinfo (`https://token@host`), an image suffix, and the SSH remote `git@github.com`.
 */
function personalAddresses(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(EMAIL)) {
    const domain = (m[1] ?? '').toLowerCase();
    if (NOBODY_DOMAIN.test(domain) || FILE_SUFFIX.test(domain)) continue;
    // URL userinfo: the address-shaped run sits inside a token that already holds '://' (`https://user:pass@host`).
    const tokenStart = Math.max(...[' ', '\n', '\t', '(', '"', "'", '`', '<', '['].map((c) => text.lastIndexOf(c, m.index - 1))) + 1;
    if (text.slice(tokenStart, m.index).includes('://')) continue;
    if (m[0].toLowerCase() === 'git@github.com') continue;
    out.push(`${text.slice(0, m.index).split('\n').length} (${domain})`);
  }
  return out;
}

interface EnvSecret {
  file: string;
  key: string;
  value: string;
}
/** Values of secret-shaped keys in .env and .env.* (never .env.example). Unreadable files are skipped. */
function envSecrets(): { secrets: EnvSecret[]; unreadable: string[] } {
  const secrets: EnvSecret[] = [];
  const unreadable: string[] = [];
  for (const name of readdirSync(ROOT)) {
    if (!/^\.env(\..+)?$/.test(name) || name === '.env.example') continue;
    let text: string;
    try {
      text = readFileSync(join(ROOT, name), 'utf8');
    } catch {
      unreadable.push(name);
      continue;
    }
    for (const line of text.split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
      if (SECRET_KEY.test(m[1]) && value.length >= 8) secrets.push({ file: name, key: m[1], value });
    }
  }
  return { secrets, unreadable };
}

interface Hit {
  where: string;
  what: string;
}
/** Scans one text for every rule and every secret value; reports file:line and the rule's location only. */
function scanText(where: string, text: string, rules: Rule[], secrets: EnvSecret[]): Hit[] {
  const hits: Hit[] = [];
  const lineOf = (index: number) => text.slice(0, index).split('\n').length;
  for (const rule of rules) {
    const m = rule.re.exec(text);
    if (m) hits.push({ where: `${where}:${lineOf(m.index)}`, what: `tests/forbidden.txt line ${rule.line} (${rule.kind})` });
  }
  for (const s of secrets) {
    const i = text.indexOf(s.value);
    if (i >= 0) hits.push({ where: `${where}:${lineOf(i)}`, what: `the value of ${s.key} from ${s.file}` });
  }
  return hits;
}

function policiesOf(yamlText: string): Policy[] {
  const doc = YAML.parse(yamlText) as { policies?: unknown } | null;
  const list = doc?.policies;
  if (!Array.isArray(list)) throw new Error('policies.yml has no `policies:` list');
  return list.map((p: unknown) => {
    const rec = p as { object?: unknown; actions?: unknown };
    if (typeof rec.object !== 'string' || !Array.isArray(rec.actions)) throw new Error(`malformed policy ${JSON.stringify(p)}`);
    return { object: rec.object, actions: rec.actions.map(String) };
  });
}

function yamlMap(text: string): Record<string, unknown> {
  const doc = YAML.parse(text) as unknown;
  return doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>) : {};
}

/** Every .js/.css/.html under static/, concatenated per file. */
function staticTexts(x: Extracted): { path: string; text: string }[] {
  return x.files.filter((f) => f.startsWith('static/') && /\.(js|mjs|css|html)$/.test(f)).map((f) => ({ path: f, text: x.text(f) }));
}

function headingLines(markdown: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    else if (!fenced && /^#{1,6} /.test(line)) out.push(line.trimEnd());
  }
  return out;
}

/** The body of the section that starts at `heading`, up to the next heading of the same or a higher level. */
function sectionOf(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.trimEnd() === heading);
  if (start < 0) return '';
  const level = heading.indexOf(' ');
  const end = lines.findIndex((l, i) => i > start && /^#{1,6} /.test(l) && l.indexOf(' ') <= level);
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

/** The README's "## Try it" heading line, exactly (the first screen ends there). */
const TRY_IT = /\n## Try it\n/;

/** The README's first screen: everything before "## Try it" (the title, the hero, the Summary). */
function firstScreen(markdown: string): string {
  return markdown.split(TRY_IT)[0];
}

function licenseOf(pkgName: string): string {
  const pj = JSON.parse(read(`node_modules/${pkgName}/package.json`)) as { license?: unknown };
  return typeof pj.license === 'string' ? pj.license : JSON.stringify(pj.license);
}

/**
 * Builds a missing package with scripts/package.mjs. `outDir` (absolute) sends it somewhere other than release/: the
 * demo build this test makes when release/ holds none goes to a temporary directory, because a `X.Y.Z-demo` package
 * left in release/ is the undeployable version D22 names and would read as a published asset (craft review r1).
 */
function buildIfMissing(
  variant: 'release' | 'demo' | 'backend',
  fileRel: string,
  force: boolean,
  outDir?: string,
): { built: boolean; skipped?: string } {
  if (!outDir && existsSync(join(ROOT, fileRel)) && !force) return { built: false };
  if (variant === 'backend' && !existsSync(join(ROOT, 'config/enterprise/backend.yml'))) {
    return { built: false, skipped: 'the backend overlay (config/enterprise/backend.yml) is not in this checkout' };
  }
  const args = ['scripts/package.mjs', '--variant', variant, '--version', VERSION, ...(outDir ? ['--out-dir', outDir] : [])];
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`scripts/package.mjs --variant ${variant} failed:\n${r.stdout}\n${r.stderr}`);
  return { built: true };
}

// ─── Fixtures shared by the suites ───────────────────────────────────────────

let primary: Extracted;
let demos: Extracted[] = [];
let backend: Extracted | undefined;
let backendSkipped: string | undefined;

beforeAll(() => {
  const force = process.env.MR_COMPLIANCE_REBUILD === '1';
  buildIfMissing('release', PRIMARY_TGZ, force);
  const demoIn = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((f) => /^meter-reader-.+-demo\.tgz$/.test(f)) : []);
  // D22: demo builds carry their own plain numeric version (meter-reader-1.0.2-demo.tgz), so any demo package
  // present in release/ is the one to check. When there is none (a fresh clone: the demo package is never committed),
  // or on a forced rebuild, the default demo build goes to a temporary directory, never into release/.
  // scripts/audit.mjs hands over the demo build it just made in a temporary directory (MR_COMPLIANCE_DEMO_DIR).
  const handed = process.env.MR_COMPLIANCE_DEMO_DIR;
  const present = handed ? demoIn(handed).map((f) => join(handed, f)) : demoIn(join(ROOT, 'release')).map((f) => `release/${f}`);
  let demoTmp: string | undefined;
  if (force || present.length === 0) {
    demoTmp = mkdtempSync(join(tmpdir(), 'mr-demo-'));
    buildIfMissing('demo', DEMO_TGZ_DEFAULT, true, demoTmp);
  }
  backendSkipped = buildIfMissing('backend', BACKEND_TGZ, force).skipped;

  primary = extract(PRIMARY_TGZ);
  demos = (demoTmp ? demoIn(demoTmp).map((f) => join(demoTmp, f)) : present).map((f) => extract(f));
  backend = existsSync(join(ROOT, BACKEND_TGZ)) ? extract(BACKEND_TGZ) : undefined;
  return () => {
    for (const x of extracted) rmSync(x.dir, { recursive: true, force: true });
    if (demoTmp) rmSync(demoTmp, { recursive: true, force: true });
  };
}, 15 * 60_000);

// ─── Repository ──────────────────────────────────────────────────────────────

describe('LICENSE', () => {
  const text = existsSync(join(ROOT, 'LICENSE')) ? read('LICENSE') : '';

  it('is the full Apache License 2.0 text', () => {
    expect(text.length).toBeGreaterThan(11_000);
    expect(text).toMatch(/^\s*Apache License\s*\n\s*Version 2\.0, January 2004\s*\n\s*http:\/\/www\.apache\.org\/licenses\/\s*\n/);
    for (const clause of [
      'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION',
      '1. Definitions.',
      '2. Grant of Copyright License.',
      '3. Grant of Patent License.',
      '4. Redistribution.',
      '5. Submission of Contributions.',
      '6. Trademarks.',
      '7. Disclaimer of Warranty.',
      '8. Limitation of Liability.',
      '9. Accepting Warranty or Additional Liability.',
      'END OF TERMS AND CONDITIONS',
      'APPENDIX: How to apply the Apache License to your work.',
      'Licensed under the Apache License, Version 2.0 (the "License");',
    ]) {
      expect(text, clause).toContain(clause);
    }
  });

  it('names the copyright holder and leaves no template placeholder', () => {
    expect(text).toMatch(/^ {3}Copyright 2026 Steve Koelpin$/m);
    expect(text).not.toMatch(/\[yyyy\]|\{yyyy\}|\[name of copyright owner\]|\{name of copyright owner\}/);
  });
});

describe('README.md', () => {
  const readme = read('README.md');
  const headings = headingLines(readme);

  it('contains every PRD 13 section, in order', () => {
    let last = -1;
    for (const h of README_HEADINGS) {
      const at = headings.indexOf(h);
      expect(at, `README heading missing: "${h}"`).toBeGreaterThanOrEqual(0);
      expect(at, `README heading out of order: "${h}"`).toBeGreaterThan(last);
      last = at;
    }
  });

  it('keeps the App Metadata table last, with the scaffold labels and the current version', () => {
    expect(headings[headings.length - 1]).toBe('## App Metadata');
    const meta = sectionOf(readme, '## App Metadata');
    for (const label of [
      'App Name',
      'App ID',
      'Version',
      'Author',
      'Support Model',
      'Support Label',
      'Support Contact',
      'License',
      'License File',
      'Product Tags',
      'Category',
      'Audience',
      'Availability',
      'Requires External Access',
      'Repository',
      'Documentation',
      'README Schema Version',
    ]) {
      expect(meta, label).toMatch(new RegExp(`^\\| ${escapeRe(label)} \\|`, 'm'));
    }
    expect(meta).toMatch(new RegExp(`^\\| App ID \\| meter-reader \\|`, 'm'));
    expect(meta).toMatch(new RegExp(`^\\| Version \\| ${escapeRe(VERSION)} \\|`, 'm'));
    expect(meta).toMatch(/^\| License \| Apache-2\.0 \|/m);
    // D58 (rules 3.2, 3.3): the gallery links name the submission repository, Cribl-Community/cc-meter-reader, the one
    // scripts/package.mjs points every packaged link at; the install step links this version's committed package.
    for (const label of ['Support Contact', 'Repository', 'Documentation']) {
      expect(meta, label).toMatch(new RegExp(`^\\| ${label} \\| \\[[^\\]]*\\]\\(https://github\\.com/Cribl-Community/cc-meter-reader[/#)]`, 'm'));
    }
    expect(meta).not.toContain('cribl-apps-public');
    expect(readme).toContain(`[\`release/meter-reader-${VERSION}.tgz\`](release/meter-reader-${VERSION}.tgz)`);
  });

  it('uses Markdown only (the Marketplace ignores raw HTML)', () => {
    let fenced = false;
    const offenders: string[] = [];
    readme.split('\n').forEach((line, i) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        return;
      }
      if (fenced) return;
      const outsideCode = line.replace(/`[^`]*`/g, '');
      if (/<\/?[A-Za-z][A-Za-z0-9-]*(\s[^>]*)?\/?>/.test(outsideCode)) offenders.push(`README.md:${i + 1}`);
    });
    expect(offenders).toEqual([]);
  });

  it('lists every grant of the release policies.yml (and any declared proxy host: none since D57)', () => {
    const platform = sectionOf(readme, '## How it uses the platform');
    for (const p of policiesOf(read('config/policies.yml'))) {
      expect(platform, `README platform section lacks ${p.object}`).toContain(`\`${p.object}\``);
    }
    for (const host of DECLARED_HOSTS) expect(platform).toContain(`\`${host}\``);
  });

  it('names every notification write and states the caveat of any dry-run grant (D30)', () => {
    const platform = sectionOf(readme, '## How it uses the platform');
    for (const w of NOTIFICATION_WRITES) {
      const [method, object] = w.split(' ');
      const row = platform.split('\n').find((l) => l.startsWith(`| ${method} | \`${object}\` |`));
      expect(row, `README grant table has no "${method} ${object}" row`).toBeDefined();
    }
    expect(platform).toContain('NOTIFICATION_WRITES');
    const dryRuns = policiesOf(read('config/policies.yml')).filter((p) => DRY_RUN_POSTS.has(p.object) && p.actions.includes('POST'));
    for (const p of dryRuns) {
      const row = platform.split('\n').find((l) => l.startsWith(`| POST | \`${p.object}\` |`));
      expect(row, `README grant table has no "POST ${p.object}" row`).toBeDefined();
      expect(row, `README row for POST ${p.object} must name the mode it sends and the mode it cannot rule out`).toMatch(/`mode: 'pipe'`[\s\S]*routeAndSend/);
    }
  });

  it('states that no credential is stored in KV and where direct webhooks live instead (SPEC 12.6 as D57 rewrote it)', () => {
    expect(sectionOf(readme, '### KV keys')).toContain(NO_CREDENTIAL_IN_KV);
    expect(readme).toContain('No token, password, key or webhook URL is stored in plain text anywhere.');
    expect(readme).not.toContain(OLD_WEBHOOK_SENTENCE);
    expect(readme).not.toMatch(/apart from a direct-webhook URL/);
  });

  it('discloses every dependency with the license its package declares', () => {
    const table = sectionOf(readme, '## AI tool and third-party disclosure');
    const rows = table.split('\n').filter((l) => l.startsWith('|'));
    const all = { ...(ROOT_PKG.dependencies ?? {}), ...(ROOT_PKG.devDependencies ?? {}) };
    expect(Object.keys(all).length).toBeGreaterThan(0);
    for (const name of Object.keys(all)) {
      const row = rows.find((r) => r.includes(`\`${name}\``));
      expect(row, `README disclosure table has no row for ${name}`).toBeDefined();
      const license = licenseOf(name);
      const expected = license.startsWith('SEE LICENSE') ? 'Cribl Developer Agreement' : license;
      expect(row, `README row for ${name} must state its license (${expected})`).toContain(expected);
    }
    expect(table).toMatch(/Claude Code/);
    expect(table).toMatch(/Anthropic/);
  });

  it('every production package (transitive, from package-lock.json) is permissive or disclosed', () => {
    const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { dev?: boolean; devOptional?: boolean; license?: string }> };
    const bad: string[] = [];
    for (const [path, p] of Object.entries(lock.packages)) {
      if (!path.startsWith('node_modules/') || p.dev || p.devOptional) continue;
      const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
      if (name.startsWith('@capra/')) {
        if (!readme.includes(`\`${name}\``)) bad.push(`${name} (undisclosed)`);
        continue;
      }
      if (!p.license || !ALLOWED_LICENSES.has(p.license)) bad.push(`${name} (${p.license ?? 'no license'})`);
    }
    expect(bad).toEqual([]);
  });

  it('every relative link and image in README.md points at something in the repository', () => {
    const missing = markdownLinks(readme)
      .filter(({ target }) => !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('#'))
      .filter(({ target }) => !existsSync(join(ROOT, target.split('#')[0])))
      .map(({ line, target }) => `README.md:${line} → ${target}`);
    expect(missing).toEqual([]);
  });

  it('links the pitch, the license, the evidence report and a Stage One checklist', () => {
    expect(readme).toContain('(PITCH.md)');
    expect(readme).toContain('(LICENSE)');
    expect(sectionOf(readme, '## Evidence report')).toContain('tests/report/');
    const boxes = sectionOf(readme, '## Stage One checklist')
      .split('\n')
      .filter((l) => /^- \[( |x)\] /.test(l));
    expect(boxes.length).toBeGreaterThanOrEqual(6);
  });
});

/**
 * RELEASE_PLAN B1: a captured fixture once held a live Splunk HEC token (`authTokens[].token`, a real UUID). Every
 * tracked JSON file is walked for credential-named keys; a value there must be a placeholder: empty, the all-zero
 * UUID (00000000-0000-4000-8000-000000000000), a ${…} reference or a word like "redacted". A real-looking UUID, or
 * any long token-shaped string, fails.
 */
const CREDENTIAL_KEY = /^(?:token|authToken|auth_token|secret|clientSecret|client_secret|password|passwd|apiKey|api_key|hecToken|accessKey|access_key|secretKey|secret_key|privateKey|private_key|sharedSecret|shared_secret|bearer|credential|credentials|routingKey|routing_key)$/i;
const PLACEHOLDER_UUID = /^0{8}-0{4}-[0-9a-f]0{3}-[0-9a-f]0{3}-0{12}$/i;
const PLACEHOLDER_WORD = /^(?:<[^>]*>|\$\{[^}]*\}|\*+|x+|redacted|\[redacted\]|placeholder|example|changeme|secret|password|token|none|null)$/i;
function credentialLooksReal(value: string): boolean {
  const v = value.trim();
  if (v === '' || PLACEHOLDER_UUID.test(v) || PLACEHOLDER_WORD.test(v)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return true;
  // Long and token-shaped: letters and digits mixed, no spaces (prose, labels and URLs with words are not tokens).
  return v.length >= 16 && /^[A-Za-z0-9+/=_\-.:~]+$/.test(v) && /[0-9]/.test(v) && /[A-Za-z]/.test(v);
}
function credentialValues(node: unknown, path: string, out: { path: string; value: string }[]): void {
  if (Array.isArray(node)) node.forEach((v, i) => credentialValues(v, `${path}[${i}]`, out));
  else if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (CREDENTIAL_KEY.test(k) && typeof v === 'string') out.push({ path: `${path}.${k}`, value: v });
      credentialValues(v, `${path}.${k}`, out);
    }
  }
}

describe('repository hygiene', () => {
  it('ships the project files a reviewer expects', () => {
    const expected = ['LICENSE', 'README.md', 'CHANGELOG.md', 'CLAUDE.md', 'PITCH.md', 'VIDEO_SCRIPT.md', 'docs/RUNBOOK.md', 'docs/ARCHITECTURE.md', 'DECISIONS.md', 'STATE.md'];
    for (const f of expected.filter(inThisTree)) {
      expect(existsSync(join(ROOT, f)), f).toBe(true);
    }
    expect(read('CHANGELOG.md')).toContain(`## [v${VERSION}]`);
  });

  it('PITCH.md and VIDEO_SCRIPT.md never claim metering with the tab closed (front-end runtime, D12b)', () => {
    for (const f of ['PITCH.md', 'VIDEO_SCRIPT.md']) {
      const text = read(f);
      const m = CLOSED_TAB_CLAIM.exec(text);
      expect(m ? `${f}:${text.slice(0, m.index).split('\n').length}` : null, f).toBeNull();
    }
  });

  it('holds no real-looking credential in any tracked JSON file (RELEASE_PLAN B1)', () => {
    const files = execFileSync('git', ['ls-files', '-z', '--', '*.json'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter((f) => f && f !== 'package-lock.json' && existsSync(join(ROOT, f)));
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    let walked = 0;
    for (const f of files) {
      let doc: unknown;
      try {
        doc = JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
      } catch {
        continue; // not JSON after all (a template); the forbidden-string scan still reads it
      }
      const found: { path: string; value: string }[] = [];
      credentialValues(doc, '$', found);
      walked += found.length;
      for (const x of found) if (credentialLooksReal(x.value)) offenders.push(`${f} ${x.path}`);
    }
    expect(offenders).toEqual([]);
    expect(walked, 'the captured inputs fixtures hold zeroed tokens, so the walk sees them').toBeGreaterThan(0);
  });

  it('tells a placeholder credential from a real-looking one', () => {
    for (const v of ['', '00000000-0000-4000-8000-000000000000', '${SPLUNK_HEC_TOKEN}', '<redacted>', 'redacted', '***', 'changeme']) {
      expect(credentialLooksReal(v), v).toBe(false);
    }
    const uuid = ['3f2b9c1e', '7a4d', '4e8b', '9c0f', '1d2e3f4a5b6c'].join('-');
    for (const v of [uuid, uuid.toUpperCase(), ['xoxb', '1234567890', 'AbCdEfGhIjKlMnOp'].join('-'), 'a1B2c3D4e5F6g7H8i9J0']) {
      expect(credentialLooksReal(v), v.slice(0, 6)).toBe(true);
    }
    expect(credentialLooksReal('Splunk HEC token for the demo rig')).toBe(false); // prose is not a token
    const found: { path: string; value: string }[] = [];
    credentialValues({ items: [{ authTokens: [{ token: uuid, description: 'x' }] }] }, '$', found);
    expect(found).toEqual([{ path: '$.items[0].authTokens[0].token', value: uuid }]);
  });

  it('keeps every .env file out of git', () => {
    for (const name of ['.env', '.env.local']) {
      const tracked = execFileSync('git', ['ls-files', '--', name], { cwd: ROOT, encoding: 'utf8' }).trim();
      expect(tracked, `${name} is tracked`).toBe('');
      const ignored = spawnSync('git', ['check-ignore', '-q', name], { cwd: ROOT });
      expect(ignored.status, `${name} is not git-ignored`).toBe(0);
    }
  });

  it(`has no forbidden string or .env secret in any file git would publish${RULES_HERE ? '' : RULES_SKIPPED}`, () => {
    const rules = RULES_HERE ? loadRules() : [];
    if (RULES_HERE) expect(rules.length).toBeGreaterThanOrEqual(6);
    const { secrets, unreadable } = envSecrets();
    if (unreadable.length > 0) console.warn(`[compliance] could not read ${unreadable.join(', ')}; their values were not scanned`);
    const everywhere = rules.filter((r) => r.scope === 'all');
    const privates = privatePaths();
    const keep = publicKeep();
    const hits: Hit[] = [];
    let scanned = 0;
    for (const rel of publishableFiles()) {
      if (rel === FORBIDDEN_RULES) continue; // the one file allowed to hold the patterns
      const buf = readFileSync(join(ROOT, rel));
      if (isBinary(rel, buf)) continue;
      scanned++;
      const exported = !isUnder(rel, privates) || keep.includes(rel);
      hits.push(...scanText(rel, buf.toString('utf8'), exported ? rules : everywhere, secrets));
    }
    expect(scanned).toBeGreaterThan(100);
    expect(hits).toEqual([]);
  });

  it.skipIf(!RULES_HERE)(`holds the public-hygiene rules: the build org, a home directory, bearer JWTs, webhook.site inboxes (P1-N02)${RULES_HERE ? '' : RULES_SKIPPED}`, () => {
    const pub = loadRules().filter((r) => r.scope === 'public');
    const matches = (s: string) => pub.some((r) => r.re.test(s));
    // The build org's host and a home directory come from the rule file's own `# must-match` lines (this file is
    // published and must not hold them, even built from parts); the synthetic JWT and inbox are built here.
    const samples = mustMatchSamples();
    for (const what of ['org', 'home']) expect(samples.map((x) => x.what), `a "# must-match ${what}:" line in ${FORBIDDEN_RULES}`).toContain(what);
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'].join('.');
    const uuid = ['0f6d1c1e', '8f2d', '4b6a', '9c3e', '77aa55cc9e1d'].join('-');
    for (const { what, sample } of samples) expect(matches(sample), `${FORBIDDEN_RULES} must-match ${what}`).toBe(true);
    for (const s of [`Bearer ${jwt}`, `https://webhook.site/${uuid}`, `https://${uuid}.webhook.site/`]) {
      expect(matches(s), s.slice(0, 24)).toBe(true);
    }
    for (const s of ['https://main-example-org.cribl.cloud', 'https://webhook.site/redacted', 'https://webhook.site/meter-reader-e2e-9e1d', 'eyJ-not-a-token']) {
      expect(matches(s), s).toBe(false);
    }
  });

  it("reads the private-by-policy paths from scripts/publish-public.sh (the public export's own list)", () => {
    if (!existsSync(join(ROOT, PUBLISH_SCRIPT))) return; // the public export: no private paths to read
    const privates = privatePaths();
    expect(privates.length).toBeGreaterThanOrEqual(5);
    for (const p of ['STATE.md', 'REPORT.md', 'docs/POSTS.md', 'video/production', 'tests/report', FORBIDDEN_RULES]) expect(privates, p).toContain(p);
    // Every file this test skips in the export is one the export really drops (B3), and the rule file is never kept.
    const keep = publicKeep();
    for (const p of EXPORT_DROPS) expect(isUnder(p, privates) && !keep.includes(p), p).toBe(true);
    // PUBLIC_KEEP names tracked files under a private path (anything else would be a no-op or a typo).
    const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n'));
    for (const k of keep) expect(isUnder(k, privates) && tracked.has(k), k).toBe(true);
    // Never the evidence a judge reads, or the code.
    for (const p of ['README.md', 'PITCH.md', 'DECISIONS.md', 'docs', 'docs/review', 'src', 'core', 'tests']) expect(privates, p).not.toContain(p);
  });

  it('tracks no git-ignored file outside the private-by-policy paths, except release artifacts force-added at release time', () => {
    const privates = privatePaths();
    const releaseArtifact = (rel: string) => /^release\/[^/]+\.tgz$/.test(rel) || /^tests\/report\/beauty\/[^/]+\.png$/.test(rel);
    const ignored = execFileSync('git', ['ls-files', '-ci', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .filter((rel) => !isUnder(rel, privates) && !releaseArtifact(rel));
    expect(ignored).toEqual([]);
  });

  it('holds no personal email address in any file the public export carries or any package (rules 4.5, 5.2(e); stage-one review r1)', () => {
    const hits: string[] = [];
    let scanned = 0;
    for (const rel of exportedFiles()) {
      if (rel === FORBIDDEN_RULES) continue;
      const buf = readFileSync(join(ROOT, rel));
      if (isBinary(rel, buf) || LICENSE_NOTICE.test(rel)) continue;
      scanned++;
      hits.push(...personalAddresses(buf.toString('utf8')).map((h) => `${rel}:${h}`));
    }
    for (const x of [primary, ...demos, ...(backend ? [backend] : [])]) {
      for (const f of x.files) {
        const buf = readFileSync(join(x.dir, f));
        if (isBinary(f, buf) || LICENSE_NOTICE.test(f)) continue;
        hits.push(...personalAddresses(buf.toString('utf8')).map((h) => `${x.file}!${f}:${h}`));
      }
    }
    expect(scanned).toBeGreaterThan(100);
    expect(hits).toEqual([]);
  });

  it('tells a personal address from an example address, a URL userinfo and an image suffix', () => {
    // A made-up person at a made-up company, built from parts (this file is published).
    expect(personalAddresses(`contact ${['jane.doe', 'acme-widgets.io'].join('@')} today`)).toEqual(['1 (acme-widgets.io)']);
    expect(personalAddresses(`line\n(${['ops', 'Acme-Widgets.IO'].join('@')})`)).toEqual(['2 (acme-widgets.io)']);
    expect(personalAddresses(`[mail](mailto:${['jane.doe', 'acme-widgets.io'].join('@')})`)).toEqual(['1 (acme-widgets.io)']);
    for (const s of [
      'someone@example.com',
      'ops@relay.example.com',
      'Admin@Example.COM',
      'x@leader.example',
      'y@build.test',
      'https://token@hooks.slack.com/services/x',
      'tests/report/audit/motion/flow-drift-zoom-light-1440@2x.png',
      'git@github.com:Cribl-Community/cc-meter-reader.git',
      '12345+someone@users.noreply.github.com',
    ]) {
      expect(personalAddresses(s), s).toEqual([]);
    }
  });

  it('every relative link in every exported Markdown file resolves in the export: file, folder or heading (completeness review r1)', () => {
    const exported = new Set(exportedFiles());
    const folders = new Set<string>();
    for (const f of exported) for (let d = posix.dirname(f); d !== '.'; d = posix.dirname(d)) folders.add(d);
    const anchorsOf = new Map<string, Set<string>>();
    const anchors = (rel: string): Set<string> => {
      let a = anchorsOf.get(rel);
      if (!a) anchorsOf.set(rel, (a = headingAnchors(read(rel))));
      return a;
    };
    const dead: string[] = [];
    let links = 0;
    // License texts are third parties' words, quoted verbatim inside fences: not our links.
    for (const rel of [...exported].filter((f) => f.endsWith('.md') && !LICENSE_NOTICE.test(f))) {
      for (const { line, target } of markdownLinks(read(rel))) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // https:, mailto: …
        links++;
        const [pathPart = '', anchor] = target.split('#');
        // A root-relative link resolves against github.com itself, never the repository: always dead.
        if (pathPart.startsWith('/')) {
          dead.push(`${rel}:${line} → ${target} (root-relative)`);
          continue;
        }
        let path = rel;
        if (pathPart !== '') {
          let decoded = pathPart;
          try {
            decoded = decodeURI(pathPart);
          } catch {
            /* keep it as written */
          }
          path = posix.normalize(posix.join(posix.dirname(rel), decoded)).replace(/\/$/, '');
        }
        if (!exported.has(path) && !folders.has(path)) {
          dead.push(`${rel}:${line} → ${target} (not in the export)`);
          continue;
        }
        if (anchor && !/^L\d+(-L\d+)?$/.test(anchor) && path.endsWith('.md') && exported.has(path) && !anchors(path).has(anchor.toLowerCase())) {
          dead.push(`${rel}:${line} → ${target} (no such heading)`);
        }
      }
    }
    expect(links).toBeGreaterThan(30);
    expect(dead).toEqual([]);
  });

  it('matches the git tag on HEAD, when HEAD is tagged', () => {
    const tags = spawnSync('git', ['tag', '--points-at', 'HEAD'], { cwd: ROOT, encoding: 'utf8' })
      .stdout.split('\n')
      .map((t) => t.trim())
      .filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
    for (const tag of tags) expect(tag).toBe(`v${VERSION}`);
  });
});

/**
 * Rule 9.2 (rules review r2): the staging export goes public before Cribl-Community/cc-meter-reader exists, so its README
 * must not tick that repository. scripts/publish-public.sh runs scripts/export-wording.mjs on the export; the same
 * function runs here over this tree's README, so a rewording that the matcher no longer recognises fails now, not after
 * a staging copy has shipped the tick. In the public export the README already reads "[ ] … (pushed at submission)"
 * (staging) or ticks the repository (community, once it exists): both pass.
 */
describe("the public export's wording (scripts/export-wording.mjs, rule 9.2)", () => {
  it("the staging rewrite holds back this README's Cribl-Community repository claim, and keeps its other ticked claims", () => {
    const readme = read('README.md');
    const r = stagingReadme(readme);
    expect(r.problems).toEqual([]);
    expect(r.mentions, `a Stage One checklist item names ${COMMUNITY_REPO}`).toBeGreaterThan(0);
    const items = (md: string) => md.split('\n').filter((l) => /^- \[( |x)\] /.test(l));
    const claims = items(r.text).filter((l) => l.includes(COMMUNITY_REPO));
    expect(claims.length).toBeGreaterThan(0);
    for (const l of claims) {
      expect(l.startsWith('- [ ] '), l).toBe(true);
      expect(l, l).toContain(PUSHED_AT_SUBMISSION);
    }
    // Nothing else is unticked: every claim that was ticked and is not the repository stays ticked.
    const ticked = (md: string) => items(md).filter((l) => l.startsWith('- [x] ') && !l.includes(COMMUNITY_REPO)).length;
    expect(ticked(r.text)).toBeGreaterThanOrEqual(ticked(readme));
    // Idempotent: the rewritten README passes a second time with nothing left to rewrite.
    expect(stagingReadme(r.text)).toMatchObject({ rewritten: [], problems: [] });
  });

  it('splits a combined item, unticks every wording of the claim, and refuses when no item names the repository', () => {
    const combined = stagingReadme(
      '## Stage One checklist\n- [x] An Apache-2.0 [LICENSE](LICENSE) at the root. The submission of record is `Cribl-Community/cc-meter-reader`, in the `Cribl-Community` organization.\n- [x] Other',
    );
    expect(combined.text.split('\n')).toEqual([
      '## Stage One checklist',
      '- [x] An Apache-2.0 [LICENSE](LICENSE) at the root.',
      `- [ ] The submission of record is \`Cribl-Community/cc-meter-reader\` ${PUSHED_AT_SUBMISSION}, in the \`Cribl-Community\` organization.`,
      '- [x] Other',
    ]);
    expect(combined).toMatchObject({ rewritten: [2], mentions: 1, problems: [] });
    // The round-1 wording, and a bare slug.
    expect(stagingReadme('- [x] Public repository in the `Cribl-Community` organization.').text).toBe(
      `- [ ] Public repository in the \`Cribl-Community\` organization ${PUSHED_AT_SUBMISSION}.`,
    );
    expect(stagingReadme('- [X] Public repository Cribl-Community/cc-meter-reader').text).toBe(`- [ ] Public repository Cribl-Community/cc-meter-reader ${PUSHED_AT_SUBMISSION}`);
    // A fenced example is not a claim; with no item naming the repository the export refuses instead of passing.
    const none = stagingReadme('```\n- [x] Public repository `Cribl-Community/cc-meter-reader`\n```\n- [x] An Apache-2.0 LICENSE');
    expect(none.rewritten).toEqual([]);
    expect(none.problems.join('\n')).toMatch(/no checklist item names/);
  });

  it('marks the files the export leaves out wherever CLAUDE.md names them', () => {
    const r = exportClaudeMd('1. **`STATE.md`**: the restart file.\n2. `tests/forbidden.txt` lists strings.\n3. `STATE.md` (private) already says so.');
    expect(r.problems).toEqual([]);
    expect(r.text).toContain('**`STATE.md`** (private restart file, not in this repository)');
    expect(r.text).toContain('`tests/forbidden.txt` (private, not exported)');
    expect(exportClaudeMd(read('CLAUDE.md')).problems).toEqual([]);
  });

  it('scripts/publish-public.sh runs it on every export (no inline copy of the rules to drift)', () => {
    if (IN_PUBLIC_EXPORT) return; // the export leaves the script out
    const script = read(PUBLISH_SCRIPT);
    expect(script).toContain('node "$ROOT/scripts/export-wording.mjs" "$OUT" "$TARGET"');
    expect(script).not.toMatch(/TICKS_COMMUNITY/);
    // The module ships in the export (this test imports it there too): never one of the private paths.
    expect(isUnder('scripts/export-wording.mjs', privatePaths())).toBe(false);
  });
});

/**
 * Launch copy claims the release cannot keep (EPIC_AUDIT P0-12). The release posts four creating writes and
 * Connect creates two Search objects, so "read-only" and "never touches config" overclaim: the scope is README
 * "never changes pipeline, route, source or destination configuration". The weekly receipt goes out on schedule
 * only from the runner or the Enterprise variant; the release sends it the first time the App is open after
 * Monday 12:00 UTC, so an unqualified "every Monday" overclaims. Recoveries closed 79–131 s after the restore
 * (not "within two minutes"), and catches took 1:27–2:13, median 1:43 (not "a minute and a half").
 */
const OVERCLAIMS: readonly { re: RegExp; why: string }[] = [
  { re: /\bnever touches (?:your )?config/i, why: 'say "never changes a pipeline, route, source or destination"' },
  { re: /\bdoesn['’]t touch config/i, why: 'say "never changes a pipeline, route, source or destination"' },
  { re: /\bnever changes your configuration\b/i, why: 'scope it: "never changes a pipeline, route, source or destination" (Connect creates two Search objects)' },
  { re: /\b(?:package|release|app)(?: you install)? is read-only\b/i, why: 'the release posts four creating writes (NOTIFICATION_WRITES)' },
  { re: /\bthe read-only release\b/i, why: 'the release posts four creating writes (NOTIFICATION_WRITES)' },
  { re: /(?:^|[.;:!?]\s+)read-only[,;.]/im, why: '"read-only" standing alone as a claim about the App' },
  { re: /\bevery Monday,? (?:leadership|it sends)\b/i, why: 'qualify the weekly receipt by runtime' },
  { re: /\ba minute and a half\b/i, why: 'catches took 1:27–2:13, median 1:43' },
  { re: /\bclosed (?:itself )?within two minutes\b/i, why: 'recoveries closed 79–131 s after the restore' },
];

/**
 * The copy a judge, a reader or the audience sees; PITCH's "Never say" list is where the phrases are named.
 * docs/POSTS.md is private by policy, so the public export checks the others.
 */
const LAUNCH_COPY = ['README.md', 'PITCH.md', 'docs/POSTS.md', 'src/copy/en.ts', 'VIDEO_SCRIPT.md', 'demo/sample/story.json'].filter((f) =>
  existsSync(join(ROOT, f)),
);

describe('launch copy says what the release does (EPIC_AUDIT P0-12)', () => {
  const textOf = (f: string): string => {
    const text = read(f);
    if (f !== 'PITCH.md') return text;
    const never = sectionOf(text, '## Never say');
    expect(never, 'PITCH.md keeps its "## Never say" section').not.toBe('');
    return text.replace(never, '');
  };

  it('never claims "read-only", "never touches config", an unqualified "every Monday" or timings the runs do not support', () => {
    const hits: string[] = [];
    for (const f of LAUNCH_COPY) {
      const text = textOf(f);
      for (const { re, why } of OVERCLAIMS) {
        const m = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
        for (const hit of text.matchAll(m)) hits.push(`${f}:${text.slice(0, hit.index).split('\n').length} "${hit[0].trim()}" (${why})`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('states the scope and qualifies the weekly receipt where the README makes the claims', () => {
    const readme = read('README.md');
    const first = firstScreen(readme).replace(/\s+/g, ' ');
    expect(first).toContain('It never changes pipeline, route, source or destination configuration');
    expect(first).toMatch(/closed itself 79 to 131 seconds after the fix was deployed/);
    const does = sectionOf(readme, '## What it does').replace(/\s+/g, ' ');
    expect(does).toContain('It never changes pipeline, route, source or destination configuration');
    expect(does).toMatch(/on schedule from the runner or the Enterprise variant; from the release, the first time the App meters after Monday 12:00 UTC, any day that week/);
  });

  it("names the runner's health check in PITCH's stage pre-flight, not a pgrep of a laptop runner", () => {
    const preflight = sectionOf(read('PITCH.md'), '## Stage pre-flight');
    expect(preflight).toContain('scripts/runner-health.sh');
    expect(preflight).not.toMatch(/pgrep/);
    expect(read('PITCH.md')).not.toMatch(/`pgrep -f scripts\/runner\.ts` before you start/);
  });

  it('qualifies the measured timings by the demo profile (wave 1 review)', () => {
    const readme = read('README.md');
    // The runs used the demo profile's one-minute confirmation and recovery (core/detector.ts effectiveThresholds);
    // the defaults are 3 and 5 minutes (core/settings.ts), and the release cannot switch the profile on. The first
    // screen names the demo profile; the Demo rig section says what it changes (README first screen, round 2).
    expect(firstScreen(readme)).toMatch(/\*\*Measured live\*\* \(demo profile/);
    expect(sectionOf(readme, '## Demo rig').replace(/\s+/g, ' ')).toContain(
      "with the demo profile's one-minute confirmation (the default confirms a drop in 3 minutes and a recovery in 5",
    );
  });

  // D63 widened the release's automatic weekly send from the day after Monday 12:00 UTC to the whole week (late after a
  // day), and this test used to hold the copy to the old one-day window, so the stale wording stayed in the README, PITCH
  // and the Settings copy (rules review r2: the window was stated three ways). The copy now follows core/weekly.ts.
  it("states the release's weekly send as core/weekly.ts makes it: any day that week, marked late after the first day (rules review r2)", async () => {
    const { WEEKLY_AUTO_WINDOW_MS, WEEKLY_ON_TIME_MS } = await import('../core/weekly.ts');
    const DAY_MS = 86_400_000;
    // The wording below describes these two numbers; change them and this test together.
    expect(WEEKLY_AUTO_WINDOW_MS).toBe(7 * DAY_MS);
    expect(WEEKLY_ON_TIME_MS).toBe(DAY_MS);
    // The sentence lives in "What it does" since the first screen was cut to 150 words.
    const does = sectionOf(read('README.md'), '## What it does').replace(/\s+/g, ' ');
    const release = /from the release, the first time the App (?:meters|is open) after Monday 12:00 UTC([^.]*)/.exec(does);
    expect(release, 'What it does names the release weekly send').not.toBeNull();
    expect(release?.[1] ?? '', 'the release sends any day that week').toMatch(/any day (?:of )?that week|any day before the next Monday/i);
    expect(release?.[1] ?? '', 'and says a send after the first day is marked late').toMatch(/\blate\b/i);
    // A one-day window, in any of the ways it was written (src/copy/en.ts is also held by tests/unit/weekly-window-copy.test.ts).
    const oneDay = /\b(?:in|within) the (?:24 hours|day) after Monday|24 hours after Monday|before Tuesday 12:00|within 24 hours of Monday/i;
    const hits: string[] = [];
    for (const f of ['README.md', 'PITCH.md', 'docs/POSTS.md', 'src/copy/en.ts', 'VIDEO_SCRIPT.md', 'docs/RUNBOOK.md', 'docs/ARCHITECTURE.md', 'docs/NOTIFICATIONS.md'].filter(inThisTree)) {
      const text = read(f);
      for (const m of text.matchAll(new RegExp(oneDay.source, 'gi'))) hits.push(`${f}:${text.slice(0, m.index).split('\n').length} "${m[0]}"`);
    }
    expect(hits, 'copy that names a one-day weekly window while core/weekly.ts sends any day that week').toEqual([]);
  });

  it('keeps the first screen short: at most 150 words between the hero and "Try it", with the 2×2 screenshot grid (efficiency audit)', () => {
    const readme = read('README.md');
    const heroLine = readme.split('\n').findIndex((l) => l.includes(`](${HERO_IMAGE.from})`));
    expect(heroLine).toBeGreaterThanOrEqual(0);
    const first = readme.split('\n').slice(heroLine + 1).join('\n').split(TRY_IT)[0];
    const words = first.split(/\s+/).filter(Boolean).length;
    expect(words, 'README first screen word count (whitespace tokens)').toBeLessThanOrEqual(150);
    for (const name of ['receipt', 'flow', 'alert', 'report']) {
      expect(first, `the grid shows docs/images/${name}.png`).toContain(`](docs/images/${name}.png)`);
      expect(existsSync(join(ROOT, `docs/images/${name}.png`)), `docs/images/${name}.png`).toBe(true);
    }
  });

  // FOUNDER_PLAN row 5: the four one-line bullets fold into the Summary (every commit priced, good or bad; the bell;
  // What if forecasts a pack before you apply it), and one "Measured live" line follows it. Row 3: What if is a
  // forecast, never "priced before install" or a dry run in general (a pack attached as a Pack is projected).
  it('folds the joins into the Summary: no bullet list on the first screen, and What if is a forecast (founder plan rows 3, 5)', () => {
    const readme = read('README.md');
    const summary = sectionOf(readme, '## Summary');
    expect(summary.split('\n').filter((l) => /^\s*[-*] /.test(l)), 'the first screen has no bullet list').toEqual([]);
    const flat = summary.replace(/\s+/g, ' ');
    expect(flat).toMatch(/every commit, good or bad/);
    expect(flat).toMatch(/Cribl bell/);
    expect(flat).toContain('What if forecasts a pack before you apply it');
    expect(firstScreen(readme)).not.toMatch(/priced before (?:you )?install|What if prices it from a dry run/i);
  });

  // FOUNDER_PLAN row 3 (the truth pass) and FINDINGS_R1 M1, m5, m24: phrases that are false or unmeasured today stay out
  // of the README; the install role is Cribl's (https://docs.cribl.io/apps/admin-guide/: "Only Organization
  // administrators can install"); a pack attached as a Pack is projected, not dry-run; a confirmed Connect keeps the
  // endpoint at once (founder-build r1 ui-5, NotificationsSection.tsx persistConnected; the judge-path validation's
  // scenario e), so step 6 never tells a member to press Save changes to keep it; "?" opens Go to anything (the
  // palette), not a full sheet; the licence claim is scoped (Capra is Cribl's).
  it('says only what is true today: no install time, the Organization administrator role, the pack projection, Connect keeps the endpoint, Go to anything and a scoped licence claim (founder plan row 3; M1, m5, m24)', () => {
    const readme = read('README.md');
    const never = /Try it in 5 minutes|(?<!every )\b30 seconds|about 5 minutes|confirmed live|PACK ALONE|Every step of that|just like the break|Workspace Administrator/gi;
    const hits = [...readme.matchAll(never)].map((m) => `README.md:${readme.slice(0, m.index).split('\n').length} "${m[0]}"`);
    expect(hits, 'row 3 "Never say" phrases in the README').toEqual([]);
    expect(sectionOf(readme, '### Before you install')).toContain('an **Organization administrator**');
    expect(sectionOf(readme, '### Install')).toContain('an **Organization administrator**');
    expect(sectionOf(readme, '## Known limitations').replace(/\s+/g, ' ')).toContain(
      'a pack attached as a Pack is projected from a similar stream or its published range, not dry-run in place',
    );
    const step6 = readme.split('\n').find((l) => l.startsWith('6. **Optional: connect a Cribl notification target.**')) ?? '';
    expect(step6, 'Try it step 6 says a confirmed Connect keeps the endpoint').toMatch(/\*\*Send a test alert\*\*[\s\S]*A confirmed \*\*Connect\*\* keeps the endpoint at once/);
    expect(step6, 'Try it step 6 no longer asks for Save changes to keep the endpoint').not.toMatch(/Save changes\*\* to keep the endpoint|alerts go only to saved endpoints/);
    const keys = sectionOf(readme, '## Accessibility and keyboard');
    expect(keys).toContain('**Go to anything**');
    expect(keys).not.toMatch(/`\?` the shortcut sheet/);
    const licence = sectionOf(readme, '## Stage One checklist').split('\n').find((l) => /Apache-2\.0-compatible/.test(l)) ?? '';
    expect(licence, 'the ticked licence line is scoped to the open-source components').toMatch(/open-source/);
    expect(licence, 'and states Capra\'s licence').toContain('Cribl Developer Agreement');
  });

  // FINDINGS_R2 #6 (founder-build round 2, docs-1): What if is a forecast with a named basis. It is a dry run through
  // Cribl's preview API only when the treatment's pipeline is defined in the worker group; otherwise (a pack attached as
  // a Pack included) it is projected from a similar stream or the pack's published range. So no text says What if is
  // "priced from a dry run" without that qualification. The submission kit outside the repository is held to the same
  // pattern by the docs lane's check script (ops/founder-build/r2-docs-check-submission.py).
  it('never says What if is priced from a dry run without its qualification: README, PITCH, VIDEO_SCRIPT and docs (founder plan row 3; FINDINGS_R2 #6)', () => {
    const dryRun = /priced? (?:it )?from a dry run|prices it from a dry run/gi;
    expect("and What if priced from a dry run on a Source's own events", 'the pattern catches JUDGES_GUIDE:56 as it was').toMatch(
      new RegExp(dryRun.source, 'i'),
    );
    const docs = walk(join(ROOT, 'docs'))
      .map((p) => relative(ROOT, p).split(sep).join('/'))
      .filter((rel) => /\.(?:md|json|txt|html)$/.test(rel));
    expect(docs, 'docs/** has text files to read').toContain('docs/RUNBOOK.md');
    const hits: string[] = [];
    for (const f of ['README.md', 'PITCH.md', 'VIDEO_SCRIPT.md', ...docs].filter((rel) => existsSync(join(ROOT, rel)))) {
      const text = read(f);
      for (const m of text.matchAll(dryRun)) hits.push(`${f}:${text.slice(0, m.index).split('\n').length} "${m[0]}"`);
    }
    expect(hits, 'What if "priced from a dry run" without its qualification').toEqual([]);
  });

  // Numbers ledger (STEVE_NOTES Sun 11:55 PM, Mon 12:12 AM): every $ a reader sees carries an asterisk and the footnote
  // is on the same screen; the 34% projection basis ($2.8M, $280K, $1.4M) is retired; no stale or live-org dollar
  // figure (the grep gate 140,500 | 283K | 31.6 TB) appears anywhere in the README.
  it('stars every $ on the first screen, with the demonstration footnote on the same screen, and carries no retired figure (numbers ledger)', () => {
    const readme = read('README.md');
    const first = firstScreen(readme);
    const unstarred: string[] = [];
    for (const m of first.matchAll(/\$\d[\d,.]*[KMB]?/g)) {
      const after = first.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 6);
      if (!/^(?:\/GB)?\\?\*/.test(after)) unstarred.push(`${m[0]}${after}`);
    }
    expect(unstarred, 'every $ figure on the first screen carries *').toEqual([]);
    expect(first).toContain('\\* For demonstration purposes only. Does not reflect actual prices.');
    const retired = /\$2\.8M|\$280K|\$1\.4M|2,792,250|279,225|1,396,125|\b283K|140,500|31\.6 TB/g;
    const hits = [...readme.matchAll(retired)].map((m) => `README.md:${readme.slice(0, m.index).split('\n').length} "${m[0]}"`);
    expect(hits, 'retired or stale figures in the README').toEqual([]);
  });

  // FINDINGS_R3 #2 (founder-build round 3, docs-1): one hero on every judge-facing surface in the repository. The
  // numbers standard (ops/numbers/NUMBERS_STANDARD.md; the owner, Mon 9/28 8:20–8:30 AM) is 10,000 GB/day × $1.50/GB\*
  // × 30% × 365 ≈ $1.6M\*, with the ladder $164K\* · $821K\* · $1.6M\*. So README.md, PITCH.md and docs/POSTS.md each
  // carry that math and ladder, quote no other projection ($N.NM\*) except the built-in sample's own figure on a line
  // that labels it the sample (round-3.md ruling 7), and hold no string of round-3.md §1's numbers gate. The README's
  // Presets section documents the App's own presets (Splunk Cloud's 1–2 TB/day tier, Sumo Logic's tier shares) and is
  // exempt; docs/review/**, docs/LIVE_VALIDATION.md, docs/RIG.md and docs/evidence/** are history and are not read.
  // The submission kit outside the repository is held to the same rules by
  // ops/founder-build/r3-docs-check-judge-surfaces.py.
  it('quotes one hero, $1.6M* with its math and ladder, and no retired figure: README, PITCH and docs/POSTS (numbers standard; FINDINGS_R3 #2)', () => {
    const gate =
      /2\.5M|2,463,750|246K|246,375|\$1\.2M|1,231,875|1\.3M|2\.8M|2,792,250|283K|280K|279,225|\$1\.4M|1,396,125|140,500|17,155|39,420|22,265|8,708|\$135|\$88|\$24 a day|measured 34|34 ?% (?:saved|less|live|measured)|45 ?%|37 ?%|we measured/g;
    const projection = /\$[0-9][0-9.,]*M\\?\*?/g;
    // The built-in sample's own figures (its annualized run rate, would have paid → paid, its Cribl cost), allowed only on a
    // line that labels them the sample (ruling 7); any other $N.NM* is a second projection.
    const SAMPLE_FIGURES = new Set(['$8.1M', '$23.1M', '$15.0M', '$3M']);
    const offenders = (file: string, lines: readonly string[]): string[] => {
      const out: string[] = [];
      lines.forEach((line, i) => {
        for (const m of line.matchAll(gate)) out.push(`${file}:${i + 1} gate "${m[0]}"`);
        for (const m of line.matchAll(projection)) {
          const figure = m[0].replace(/\\/g, '').replace(/\*$/, '');
          if (figure !== '$1.6M' && !(SAMPLE_FIGURES.has(figure) && /\bsample\b/i.test(line))) out.push(`${file}:${i + 1} projection "${m[0]}"`);
        }
      });
      return out;
    };
    // The patterns catch the retired hero as PITCH.md:52 had it, and let the labelled sample through.
    const retiredHero = ['one pack projects to about $2', '.5M\\* a year: 10,000 GB/day × $2.25/GB\\* × 30% × 365 = $2,463', ',750\\*. At 1 TB a day it\'s about $246', 'K\\*.'].join('');
    expect(offenders('probe', [retiredHero])).toEqual([
      'probe:1 gate "2.5M"',
      'probe:1 gate "2,463,750"',
      'probe:1 gate "246K"',
      'probe:1 projection "$2.5M\\*"',
    ]);
    expect(offenders('probe', [['Projected at 30%; 34', '% measured live on our demo feed.'].join(''), 'the sample reads $8.1M\\* a year', 'the sample reads $2.2M\\* at scale'])).toEqual([
      'probe:1 gate "34% measured"',
      'probe:3 projection "$2.2M\\*"',
    ]);
    // The README's Presets section (the App's own presets) is blanked, keeping line numbers.
    const readme = read('README.md').split('\n');
    const presets = readme.findIndex((l) => l === '### Presets');
    const presetsEnd = readme.findIndex((l, i) => i > presets && /^#{1,3} /.test(l));
    expect(presets, 'README has its Presets section').toBeGreaterThan(0);
    const readmeLines = readme.map((l, i) => (i > presets && i < presetsEnd ? '' : l));
    const hits: string[] = [];
    const surfaces: [string, readonly string[]][] = [
      ['README.md', readmeLines],
      ['PITCH.md', read('PITCH.md').split('\n')],
    ];
    // docs/POSTS.md is private (EXPORT_DROPS): held here in the private tree only, so the public export, which leaves it
    // out, passes its own npm test (final 1.1.4: a judge's fresh clone of the export failed on ENOENT here).
    if (inThisTree('docs/POSTS.md')) surfaces.push(['docs/POSTS.md', read('docs/POSTS.md').split('\n')]);
    for (const [file, lines] of surfaces) {
      hits.push(...offenders(file, lines));
      const text = lines.join('\n');
      expect(text, `${file} carries the standard's math`).toMatch(/10,000 GB\/day × \$1\.50\/GB\\?\* × 30% × 365/);
      expect(text, `${file} carries the hero`).toMatch(/\$1\.6M\\?\*/);
      expect(text, `${file} carries the ladder`).toMatch(/\$164K\\?\*[^\n]*\$821K\\?\*[^\n]*\$1\.6M\\?\*/);
    }
    expect(hits, 'a second projection or a retired figure on a judge-facing surface').toEqual([]);
  });

  // FINDINGS_R3 #17, #19, #20 (founder-build round 3, docs-3): the README says what the code does. One retry rule, the
  // per-endpoint one (core/incidents.ts nextEndpointRecord: a 4xx and the relay pre-check's 404 are final; a 5xx, the
  // relay forward's 500 included, a timeout or a dropped connection back off 2, 4 and 8 minutes), with the relay forward
  // "not retried within a call" (core/adapters/cribl-notify.ts); the `settings` row names the one write no Save made
  // (src/state/services.ts persistZoneBeforeSweep); and the contrast claim carries docs/DESIGN_BRIEF.md:26's carve-out.
  it('states one retry rule, the first-sweep settings write and the Capra contrast carve-out (FINDINGS_R3 #17, #19, #20)', () => {
    const readme = read('README.md');
    const flat = readme.replace(/\s+/g, ' ');
    expect(flat, 'the pre-round-2 rule (a failed attempt waits 2 minutes) is gone').not.toMatch(/failed delivery attempt waits 2 minutes/);
    expect(flat, 'forwards are retried across sweeps').not.toMatch(/so they are never retried/);
    expect(flat).toContain('a forward is not retried within a call; across sweeps the per-endpoint rule below applies');
    const retries = sectionOf(readme, '### Alert delivery').split('\n').find((l) => l.startsWith('- **Retries, per endpoint**')) ?? '';
    expect(retries, 'the relay pre-check 404 is final').toMatch(/relay the pre-check finds missing, logged `relay_missing` with 404/);
    expect(retries, "the relay forward's 500 is retryable").toMatch(/a forward Cribl answers 500[^)]*\) is sent again after 2, 4 and 8 minutes/);
    const settingsRow = sectionOf(readme, '### KV keys').split('\n').find((l) => l.startsWith('| `settings` |')) ?? '';
    expect(settingsRow, 'the settings row names the first-sweep zone write').toMatch(/the first tab to sweep a live workspace with no settings document \(its zone, once/);
    const themes = sectionOf(readme, '## Accessibility and keyboard').split('\n').find((l) => l.startsWith('- **Both themes.**')) ?? '';
    const brief = read('docs/DESIGN_BRIEF.md');
    for (const pair of ['3.26:1', '4.20:1', '`#0190ff`', '`#0072de` on `#e6f4fe`']) {
      expect(brief, `DESIGN_BRIEF records ${pair}`).toContain(pair);
      expect(themes, `README "Both themes" carries ${pair}`).toContain(pair);
    }
    expect(themes).toContain('every text and background pair Meter Reader defines is held to 4.5:1');
  });
});

/**
 * What the grants expose (EPIC_AUDIT P0-22), verbatim: a grant names a path and a method, never a body, and the
 * platform grants every declared path to each member the App is shared with. Three disclosures: the Source and
 * Destination reads return secrets decrypted; the four notification POSTs allow any body; the demo build's
 * lever grants reach every pipeline, route and Source whatever the demo tag says.
 */
const GRANT_DISCLOSURES = {
  writesOnlyCreate: "Meter Reader's code only creates: it never replaces or deletes anything, and nothing in the App ever deletes a bell message. The grants themselves allow any body.",
  sharedMember: '**What a shared member could do with these grants.** A grant names a path and a method, never a body,',
  sharedMemberEnd: 'Share the App with people you would trust with those four actions.',
  adminHeading: '**What an administrator should know before sharing the App.**',
  decryptedReads: '- **The Source and Destination reads return secrets, decrypted.** `GET /m/:gid/system/inputs` and `GET /m/:gid/system/outputs` answer with every Source\'s and Destination\'s full configuration,',
  decryptedReadsEnd: 'Share the App with the platform team, the people who could already read that configuration in Cribl.',
  demoGrants: 'the `[meter-reader-demo]` tag is checked by the App\'s code, not by Cribl, so a member calling those paths directly could replace, commit and deploy any of them. Install the demo build only in a demo organization and share it only with the people running the demo.',
} as const;
/** What a member calling the write paths directly could do, one clause per NOTIFICATION_WRITES entry. */
const WRITE_CAPABILITIES = [
  'post any message to the', // bell: POST /system/messages
  'create any saved search in Cribl Search, scheduled or not, and the saved-search schema lets that saved search carry its own notifications to a notification target an administrator already configured (`POST /m/default_search/search/saved`; not tried live)',
  "attach a notification to Meter Reader's relay saved search and to no other saved search (`POST /m/default_search/search/saved/meter_reader_alert_relay/notifications`)",
  "forward any text to the targets of any Search notification in the workspace, not only the relay's (`POST /search/notifications`)",
  'none can create a notification target',
];

/**
 * The docs say what the live log measured (EPIC_AUDIT P1-N03, P1-N05): the run table is numbered 1..N with no
 * gaps, and every timing the README and PITCH quote is recomputed from docs/LIVE_VALIDATION.md, so a new run
 * (or a corrected one) fails here until the claims follow it.
 */
describe('the docs say what the live log measured (EPIC_AUDIT P1-N03, P1-N05)', () => {
  const clock = (sec: number): string => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  const secs = (mss: string): number => {
    const [m, ss] = mss.split(':').map(Number);
    return (m ?? 0) * 60 + (ss ?? 0);
  };
  const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] ?? 0;
  const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

  const runs = sectionOf(read('docs/LIVE_VALIDATION.md'), '## Break the trim → alert → restore (Tier 0 payoff)')
    .split('\n')
    .filter((l) => /^\| \d+ \|/.test(l))
    .map((l) => l.split('|').map((c) => c.trim()));
  const caught = runs.map((c) => secs((c[5] ?? '').replace(/\*/g, '')));
  const recovered = runs.map((c) => Number(/\((?:≈\s*)?(\d+) s\b/.exec(c[c.length - 2] ?? '')?.[1] ?? Number.NaN));

  it('numbers the live runs 1..N in order, with no gaps, and the README counts the same N', () => {
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.map((c) => Number(c[1]))).toEqual(runs.map((_, i) => i + 1));
    const n = NUMBER_WORDS[runs.length] ?? String(runs.length);
    expect(read('README.md')).toContain(`${n} live runs`);
  });

  it("quotes the log's caught-in times and recovery range, recomputed from it", () => {
    expect(caught.every((x) => x > 0)).toBe(true);
    expect(recovered.every(Number.isFinite), `every run's "Closed itself" cell carries "(N s"`).toBe(true);
    const [lo, hi, med] = [Math.min(...caught), Math.max(...caught), median(caught)];
    const readme = read('README.md');
    const top = firstScreen(readme).replace(/\s+/g, ' ');
    expect(top).toContain(`caught in **${clock(lo)} to ${clock(hi)}** (median ${clock(med)})`);
    expect(readme).toContain(`(median ${clock(med)}; ${caught.map(clock).join(', ')})`);
    const [rlo, rhi] = [Math.min(...recovered), Math.max(...recovered)];
    expect(top).toContain(`closed itself ${rlo} to ${rhi} seconds after the fix was deployed`);
    expect(readme).toContain(`| Restore → incident closed itself | ${rlo}–${rhi} seconds after the restore deployed`);
    expect(read('PITCH.md')).toContain(`closed itself ${rlo} to ${rhi} seconds after the restore deployed`);
    expect(read('docs/LIVE_VALIDATION.md')).toContain(`closed itself ${rlo} to ${rhi} seconds after the restore deployed (median ${median(recovered)} s`);
  });

  it("gives the tour's length as recorded, and never states a Leader limit the tab was not measured against", () => {
    const tour = JSON.parse(read('demo/sample/tour.json')) as { durationSec: number };
    const halves = Math.round(tour.durationSec / 30);
    const words = `${NUMBER_WORDS[Math.floor(halves / 2)] ?? ''}${halves % 2 ? ' and a half' : ''} minutes`;
    expect(sectionOf(read('README.md'), '## Try it')).toContain(`in about ${words}.`);
    for (const f of ['README.md', 'PITCH.md']) {
      expect(read(f), `${f}: the 50-a-minute limit is documented for App backends only`).not.toMatch(/gives the app 50 API calls/i);
    }
    expect(read('README.md'), 'the reads between sweeps are listed, not "only snapshot and meta"').not.toMatch(/only reads `snapshot` and `meta`/);
    expect(read('README.md')).toMatch(/planned under 35 calls in steady state/);
  });

  it("quotes the first-run buttons as src/copy/en.ts has them, and the video script says where the produced cut differs", () => {
    const brief = read('docs/DESIGN_BRIEF.md');
    expect(brief).toContain(`"${en.firstRun.setPrices}" primary`);
    expect(brief).toContain(`"${en.firstRun.tour}" secondary`);
    const script = read('VIDEO_SCRIPT.md');
    expect(script).toContain('## The produced video');
    expect(script).not.toMatch(/so the video, its captions and the loop cannot disagree/);
  });
});

describe('the relay grants name exactly the paths the relay uses (EPIC_AUDIT P1-N01)', () => {
  const grants = (rel: string): string[] => policiesOf(read(rel)).flatMap((p) => p.actions.map((a) => `${a} ${p.object}`));
  // The adapter's own paths, so a grant can never drift from the call it authorizes.
  const RELAY_CALLS = [`GET ${savedSearchPath()}`, `POST ${SAVED_SEARCHES_PATH}`, `POST ${relayNotificationsPath()}`, `POST ${SEARCH_NOTIFY_PATH}`];

  it('the relay grants are the adapter\'s literal paths: no :gid or :id placeholder reaches another group or saved search', () => {
    expect(RELAY_CALLS).toEqual([RELAY_READ, ...NOTIFICATION_WRITES.slice(1)]);
    for (const rel of ['config/policies.yml', 'config/demo/policies.yml']) {
      const g = grants(rel);
      for (const call of RELAY_CALLS) expect(g, `${rel} lacks ${call}`).toContain(call);
      const searchGrants = g.filter((x) => /\/search\//.test(x));
      expect(searchGrants.sort(), `${rel}: every Search grant is one of the relay's calls`).toEqual([...RELAY_CALLS].sort());
      expect(searchGrants.filter((x) => /:(gid|id)\b/.test(x)), `${rel}: a placeholder in a Search grant`).toEqual([]);
    }
  });

  it('the README grant table has a row for the relay read, and the pending live check is logged (LIVE_VALIDATION)', () => {
    const platform = sectionOf(read('README.md'), '## How it uses the platform');
    const [method, object] = RELAY_READ.split(' ');
    expect(platform.split('\n').some((l) => l.startsWith(`| ${method} | \`${object}\` |`)), `README has no "${RELAY_READ}" row`).toBe(true);
    expect(read('docs/LIVE_VALIDATION.md')).toMatch(/literal relay grants/i);
  });
});

describe('the grants are disclosed where an administrator reads before sharing (EPIC_AUDIT P0-22)', () => {
  const oneLine = (s: string): string => s.replace(/\s+/g, ' ');

  function expectDisclosures(readme: string, where: string): void {
    const endpoints = oneLine(sectionOf(readme, '### Cribl API endpoints'));
    for (const [key, text] of Object.entries(GRANT_DISCLOSURES)) {
      if (key === 'demoGrants') continue;
      expect(endpoints, `${where}: Cribl API endpoints lacks the ${key} disclosure`).toContain(oneLine(text));
    }
    const shared = endpoints.slice(endpoints.indexOf(GRANT_DISCLOSURES.sharedMember), endpoints.indexOf(GRANT_DISCLOSURES.sharedMemberEnd));
    for (const w of NOTIFICATION_WRITES) expect(shared, `${where}: the shared-member paragraph names ${w}`).toContain(`\`${w}\``);
    for (const c of WRITE_CAPABILITIES) expect(shared, `${where}: the shared-member paragraph says "${c}"`).toContain(c);
    // The decrypted-reads bullet opens the administrator's list, ahead of the targets bullet.
    const admin = endpoints.slice(endpoints.indexOf(GRANT_DISCLOSURES.adminHeading));
    expect(admin.indexOf(oneLine(GRANT_DISCLOSURES.decryptedReads)), `${where}: decrypted reads first`).toBe(GRANT_DISCLOSURES.adminHeading.length + 1);
    expect(oneLine(sectionOf(readme, '## Demo rig')), `${where}: Demo rig lacks the demo-grants disclosure`).toContain(oneLine(GRANT_DISCLOSURES.demoGrants));
  }

  it('README: the reads return secrets decrypted, the writes allow any body, the demo grants reach every object', () => {
    expectDisclosures(read('README.md'), 'README.md');
  });

  it('the README inside the release package carries the same three disclosures', () => {
    expectDisclosures(primary.text('README.md'), primary.file);
  });

  it('docs/NOTIFICATIONS.md mirrors the write-grant paragraph; the demo policies and the Demo Console say who to share with', () => {
    const notifications = oneLine(read('docs/NOTIFICATIONS.md'));
    expect(notifications).toContain('the grants themselves allow any body');
    for (const w of NOTIFICATION_WRITES) expect(notifications).toContain(`\`${w}\``);
    for (const c of WRITE_CAPABILITIES.slice(1)) expect(notifications, c).toContain(c);
    expect(notifications).toContain('post any message to the bell (`POST /system/messages`)');
    expect(oneLine(read('config/demo/policies.yml'))).toMatch(/That check lives in the App's code, not in Cribl: these grants reach EVERY pipeline, route and Source/);
    expect(read('src/copy/en.ts')).toMatch(/subtitle: '[^']*Share this build only with the people running the demo: its write grants cover every pipeline, route and source/);
  });
});

describe('the packaged README transform (scripts/package.mjs)', () => {
  const md = [
    '# App',
    '',
    `![hero](${HERO_IMAGE.from})`,
    'See [the runbook](docs/RUNBOOK.md), [samples](./demo/rig/samples/), [a site](https://example.com/x) and [below](#more).',
    'Open question (see [Stage One checklist](#stage-one-checklist)).',
    '```text',
    '[not a link](docs/X.md)',
    '```',
    '## More',
    '## Stage One checklist',
    '- [ ] something',
    '### Inside the checklist',
    '## Pitch',
    'Read [PITCH.md](PITCH.md).',
    '## App Metadata',
    '| App ID | meter-reader |',
  ].join('\n');
  const out = packagedReadme(md);

  it('points the hero at static/ and every other relative link at the repository', () => {
    expect(out).toContain(`![hero](static/${HERO_IMAGE.to})`);
    expect(out).toContain(`[the runbook](${repoFileUrl('docs/RUNBOOK.md')})`);
    // D58: the submission's home, Cribl-Community/cc-meter-reader (rules 3.2, 3.3).
    expect(repoFileUrl('docs/RUNBOOK.md')).toBe('https://github.com/Cribl-Community/cc-meter-reader/blob/main/docs/RUNBOOK.md');
    expect(out).toContain(`[samples](${repoFileUrl('demo/rig/samples/')})`);
    expect(repoFileUrl('demo/rig/samples/')).toBe('https://github.com/Cribl-Community/cc-meter-reader/tree/main/demo/rig/samples/');
    expect(REPO_URL).toBe('https://github.com/Cribl-Community/cc-meter-reader');
    expect(out).toContain('[a site](https://example.com/x)');
    expect(out).toContain('[below](#more)');
    expect(out).toContain('[not a link](docs/X.md)'); // fenced code is left alone
  });

  it('leaves out the hackathon-only sections, down to the next heading of their level, and re-points links to them', () => {
    expect(out).not.toContain('## Stage One checklist');
    expect(out).not.toContain('Inside the checklist');
    expect(out).not.toContain('## Pitch');
    expect(out).not.toContain('PITCH.md');
    expect(out).toContain(`[Stage One checklist](${REPO_URL}#stage-one-checklist)`);
    expect(out.trimEnd().endsWith('| App ID | meter-reader |')).toBe(true);
  });

  it('finds links that would be dead in a package: relative paths outside it and anchors to no heading', () => {
    const has = (p: string) => p === `static/${HERO_IMAGE.to}`;
    expect(readmeLinkProblems(out, has)).toEqual([]);
    const problems = readmeLinkProblems('[a](docs/A.md) ![b](video/b.gif) [c](#nowhere) [d](#app)\n# App', has);
    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toMatch(/docs\/A\.md[\s\S]*video\/b\.gif[\s\S]*#nowhere/);
  });

  // The screenshot grid (efficiency audit #5): images under docs/images/ ship as static/images/, and a linked image
  // (`[![alt](a.png)](a.png)`) has both of its targets rewritten and checked, not only the inner one.
  it('ships the screenshot grid from docs/images/ as static/images/, linked images included', () => {
    const grid = [
      '# App',
      `| [![Receipt](${README_IMAGES.from}receipt.png)](${README_IMAGES.from}receipt.png) | ![Flow](./${README_IMAGES.from}flow.png) |`,
      '[the runbook](docs/RUNBOOK.md) and [a \\[bracketed\\] name](docs/X.md) and [titled](docs/Y.md "kept")',
    ].join('\n');
    expect(linkSpans(grid.split('\n')[1] ?? '').map((s) => [s.image, s.target])).toEqual([
      [false, `${README_IMAGES.from}receipt.png`],
      [true, `${README_IMAGES.from}receipt.png`],
      [true, `./${README_IMAGES.from}flow.png`],
    ]);
    const packaged = packagedReadme(grid);
    expect(packaged).toContain(`| [![Receipt](static/${README_IMAGES.to}receipt.png)](static/${README_IMAGES.to}receipt.png) | ![Flow](static/${README_IMAGES.to}flow.png) |`);
    expect(packaged).toContain(`[the runbook](${repoFileUrl('docs/RUNBOOK.md')}) and [a \\[bracketed\\] name](${repoFileUrl('docs/X.md')}) and [titled](docs/Y.md "kept")`);
    const shipped = new Set([`static/${README_IMAGES.to}receipt.png`, `static/${README_IMAGES.to}flow.png`]);
    expect(readmeLinkProblems(packaged, (p) => shipped.has(p))).toEqual([]);
    // Missing from the package: both the image and the link around it are reported.
    expect(readmeLinkProblems(packaged, (p) => p === `static/${README_IMAGES.to}flow.png`)).toHaveLength(2);
  });

  it('refuses an image the transform can only point at a GitHub page (it would render broken)', () => {
    const packaged = packagedReadme('# App\n![shot](docs/shot.png) ![external](https://example.com/x.png)');
    expect(packaged).toContain(`![shot](${repoFileUrl('docs/shot.png')})`);
    const problems = readmeLinkProblems(packaged, () => true);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/GitHub page rather than an image: put the image under docs\/images\//);
  });

  it('every image in README.md is one a package ships: the hero or under docs/images/', () => {
    const outside = markdownLinks(read('README.md'))
      .filter(({ image, target }) => image && !/^[a-z][a-z0-9+.-]*:/i.test(target))
      .map(({ line, target }) => ({ line, path: target.replace(/^\.\//, '') }))
      .filter(({ path }) => path !== HERO_IMAGE.from && !path.startsWith(README_IMAGES.from))
      .map(({ line, path }) => `README.md:${line} → ${path}`);
    expect(outside).toEqual([]);
  });

  it('caps the hero at 5 MB (the screenshots are not capped)', () => {
    expect(HERO_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(mediaSizeProblems(new Map([[`static/${HERO_IMAGE.to}`, HERO_MAX_BYTES]]))).toEqual([]);
    expect(mediaSizeProblems(new Map([[`static/${HERO_IMAGE.to}`, HERO_MAX_BYTES + 1]])).join()).toMatch(/HERO_MAX_BYTES/);
    expect(mediaSizeProblems(new Map([[`static/${README_IMAGES.to}a.png`, 3 * HERO_MAX_BYTES]]))).toEqual([]);
  });
});

// ─── Packages ────────────────────────────────────────────────────────────────

describe('release package (the primary asset)', () => {
  it('exists as release/meter-reader-<package.json version>.tgz and carries that version', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(primary.pkg.name).toBe('meter-reader');
    expect(primary.pkg.version).toBe(VERSION);
    expect(primary.pkg.displayName).toBe('Meter Reader');
    expect(primary.pkg.license).toBe('Apache-2.0');
    expect(primary.pkg.cribl?.type).toBe('app');
  });

  // Founder-build r1 (integrator): the certified package that is being published stays in release/ beside the next
  // checkpoint (1.1.0, the owner's certified asset, beside round 1's 1.1.1), so another primary may stay only as a
  // certified asset: listed in release/SHA256SUMS and byte-identical to that line. An unlisted or altered primary is
  // still a stale version beside the current one.
  it('is the only primary package in release/ (no stale versions beside it) apart from certified ones in SHA256SUMS', () => {
    const primaries = readdirSync(join(ROOT, 'release')).filter((f) => /^meter-reader-\d+\.\d+\.\d+\.tgz$/.test(f));
    expect(primaries).toContain(`meter-reader-${VERSION}.tgz`);
    const sumsFile = join(ROOT, 'release', 'SHA256SUMS');
    const sums = new Map<string, string>();
    if (existsSync(sumsFile)) {
      for (const line of readFileSync(sumsFile, 'utf8').split('\n')) {
        const m = /^([0-9a-f]{64}) [ *](\S+)$/.exec(line.trim());
        if (m) sums.set(m[2], m[1]);
      }
    }
    for (const f of primaries.filter((name) => name !== `meter-reader-${VERSION}.tgz`)) {
      expect(sums.get(f), `release/${f} is a stale version beside ${VERSION}: not listed in release/SHA256SUMS`).toBeDefined();
      const digest = createHash('sha256').update(readFileSync(join(ROOT, 'release', f))).digest('hex');
      expect(digest, `release/${f} differs from its release/SHA256SUMS line`).toBe(sums.get(f));
    }
  });

  it('contains the app, its declarations and the current README', () => {
    for (const f of ['package.json', 'README.md', 'static/index.html', 'default/policies.yml']) {
      expect(primary.has(f), f).toBe(true);
    }
    expect(primary.text('README.md'), 'the packaged README is stale: rebuild with npm run package:release').toBe(packagedReadme(read('README.md')));
  });

  it('carries a Marketplace README whose every link, image and anchor resolves inside the package (P0-11)', () => {
    const md = primary.text('README.md');
    expect(primary.has(`static/${HERO_IMAGE.to}`), `the hero image static/${HERO_IMAGE.to}`).toBe(true);
    expect(md).toContain(`](static/${HERO_IMAGE.to})`);
    expect(readmeLinkProblems(md, primary.has)).toEqual([]);
    const headings = headingLines(md);
    for (const h of REPO_ONLY_SECTIONS) expect(headings, `${h} is for the hackathon judges, not the Marketplace`).not.toContain(h);
    expect(headings[headings.length - 1]).toBe('## App Metadata');
  });

  it('declares only reads plus the documented notification posts: GET everywhere except the metrics query and dry-run POSTs and NOTIFICATION_WRITES', () => {
    const policies = policiesOf(primary.text('default/policies.yml'));
    expect(policies.length).toBeGreaterThan(0);
    const changesNothing = (a: string, object: string) => a === 'POST' && (READ_ONLY_POSTS.has(object) || DRY_RUN_POSTS.has(object));
    const writes = policies.flatMap((p) => p.actions.filter((a) => a !== 'GET' && !changesNothing(a, p.object)).map((a) => `${a} ${p.object}`));
    expect([...writes].sort()).toEqual([...NOTIFICATION_WRITES].sort());
    // A dry-run object is granted POST only: a GET/PUT/PATCH/DELETE on it would be something else.
    for (const p of policies.filter((q) => DRY_RUN_POSTS.has(q.object))) expect(p.actions, p.object).toEqual(['POST']);
    // scripts/audit.mjs labels the same objects a dry run, not a write, in the inventory a reviewer reads.
    const audit = read('scripts/audit.mjs');
    for (const object of DRY_RUN_POSTS) expect(audit, `scripts/audit.mjs DRY_RUN_POSTS names ${object}`).toContain(`'${object}'`);
    expect(policies).toEqual(policiesOf(read('config/policies.yml')));
  });

  it('has no backend: no default/backend.yml, no default/schedules.yml, no endpoint bundles (D12b, N26)', () => {
    expect(primary.has('default/backend.yml')).toBe(false);
    expect(primary.has('default/schedules.yml')).toBe(false);
    expect(primary.files.filter((f) => f.startsWith('default/backend/'))).toEqual([]);
  });

  it('declares no external hosts (D23: App proxies need an Enterprise plan; the release installs on every plan)', () => {
    expect(primary.has('default/proxies.yml')).toBe(false);
  });

  it('bundles no Demo Console: no demo route, no demo chunk, no "Demo Console" string', () => {
    expect(primary.files.filter((f) => /^static\/assets\/Demo[-.]/.test(f))).toEqual([]);
    const offenders = staticTexts(primary)
      .filter(({ text }) => /Demo Console|["'`]\/demo["'`/?#]|path:\s*["'`]demo["'`]/.test(text))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  // P1-B04: the stage's scene indicator (and through it the demo scenes and the rig's id table) loads only in the
  // demo build, and the demo lever copy is demo-gated. Markers that only the rig table and the lever sheet carry:
  // the emulator's route ids (mrd_rt_*), the rig-only pre-processing pipeline, the lever group's heading, and any
  // sentence naming the lever keys (the release's shortcut sheet names only the keys it has).
  // (Other demo ids still ship from core — the humanize label table, the demo-tag test in core/flows.ts, the
  // test-alert sample and the passthrough id set; they belong to their owners' packages.)
  const RIG_TABLE_MARKERS = /mrd_rt_|mrd_syslog_pre|Demo levers|lever keys/i;

  it('bundles no demo rig table and no demo lever copy (P1-B04)', () => {
    const offenders = staticTexts(primary)
      .filter(({ text }) => RIG_TABLE_MARKERS.test(text))
      .map(({ path, text }) => `${path}: ${text.match(RIG_TABLE_MARKERS)?.[0]}`);
    expect(offenders).toEqual([]);
    // The demo build still carries them (the check is not vacuous).
    for (const d of demos) expect(staticTexts(d).some(({ text }) => RIG_TABLE_MARKERS.test(text)), d.file).toBe(true);
  });

  // The owner's ask (9/27): the App is signed by its builder. The release bundle carries the footer's credit and the
  // report card's line as their copy templates, and core's one name that fills them; package.json names the author.
  it('is signed by its builder: the footer credit, the report card line and the name ship in the bundle', () => {
    for (const x of [primary, ...demos]) {
      const bundle = staticTexts(x)
        .map(({ text }) => text)
        .join('\n');
      // A minifier may write the middle dot as an escape; the words around it are plain ASCII.
      expect(bundle, x.file).toMatch(/Meter Reader (?:·|\\xB7|\\u00B7) built by \{name\}/i);
      expect(bundle, x.file).toContain(en.report.doc.credit);
      expect(bundle, x.file).toContain(CREDIT_STRINGS.signature);
      expect(bundle, x.file).toContain(CREDIT_STRINGS.builder);
      expect(x.pkg.author, x.file).toBe(CREDIT_STRINGS.builder);
    }
  });

  // D54: public surfaces never ask for votes. The vote ask is the demo build's alone (src/copy/en.ts tests the flag
  // inline; src/story/doc.ts swaps it into the Story there). Every text file of the release package, and of the
  // Enterprise variant built from the same release flag, is read: the bundle, the bundled story.json, the README.
  const VOTE_ASK = /vote in the CriblCon app/i;
  it('never asks for votes: no "vote in the CriblCon app" in the release or Enterprise package; the demo build keeps it (D54)', () => {
    const offenders: string[] = [];
    for (const x of [primary, ...(backend ? [backend] : [])]) {
      for (const f of x.files) {
        const buf = readFileSync(join(x.dir, f));
        if (isBinary(f, buf)) continue;
        if (VOTE_ASK.test(buf.toString('utf8'))) offenders.push(`${x.file}!${f}`);
      }
    }
    expect(offenders).toEqual([]);
    // The release signs off with the network to join instead (the check is not vacuous: the ask is there, swapped).
    const release = staticTexts(primary)
      .map(({ text }) => text)
      .join('\n');
    expect(release).toContain('Join the Cribl Innovators Network.');
    // The demo build still carries its vote ask.
    for (const d of demos) expect(staticTexts(d).some(({ text }) => VOTE_ASK.test(text)), d.file).toBe(true);
  });

  // D57 (hackathon rules 4.5 and 5.2: plain-text credentials in KV disqualify): no build can store a webhook URL.
  // The editor that took one is gone from every bundle, and core strips and refuses one in the settings document.
  const WEBHOOK_EDITOR = /Direct webhook"|'Direct webhook'|Webhook URL \(saved\)|Replace URL|hooks\.slack\.com\/services\/…/;
  it('no package carries a direct-webhook editor: nothing in the App can take a webhook URL (D57)', () => {
    const offenders: string[] = [];
    for (const x of [primary, ...demos, ...(backend ? [backend] : [])]) {
      for (const { path, text } of staticTexts(x)) if (WEBHOOK_EDITOR.test(text)) offenders.push(`${x.file}!${path}`);
    }
    expect(offenders).toEqual([]);
    // Not vacuous: the bundles do carry the Settings copy that says where direct webhooks live instead.
    expect(staticTexts(primary).some(({ text }) => text.includes('Meter Reader stores no webhook URL'))).toBe(true);
  });

  it('a settings document never stores a webhook URL: validation refuses it and every KV write strips it (D57)', async () => {
    const { defaultSettings, validateSettings, storableSettings, mergeSettings, WEBHOOK_NOT_STORED_MESSAGE } = await import('../core/settings.ts');
    const { createKvDocs, createMemoryKvStore } = await import('../core/kv.ts');
    const { identityCodec } = await import('../core/codec.ts');
    const base = defaultSettings('2026-09-27T00:00:00.000Z', 'UTC');
    const hook = { id: 'h', name: 'Ops', url: 'https://hooks.slack.com/services/T0/B0/x', host: 'hooks.slack.com', format: 'slack' as const, minSeverity: 'medium' as const, weeklyReceipt: true, enabled: true };
    const withHook = { ...base, notifications: [hook] };
    expect(validateSettings(withHook).errors).toContainEqual({ field: 'notifications[0].url', message: WEBHOOK_NOT_STORED_MESSAGE });
    expect(JSON.stringify(storableSettings(withHook))).not.toContain('hooks.slack.com');
    expect(mergeSettings(withHook, base).notifications).toEqual([]);
    const kv = createMemoryKvStore();
    const docs = createKvDocs({ kv, codec: identityCodec, clock: { now: () => 0 } });
    await docs.putSettings(withHook);
    expect(JSON.stringify([...kv.data.values()])).not.toContain('hooks.slack.com');
    expect((await docs.getSettings())?.notifications).toEqual([]);
  });

  it('a webhook URL typed as a notification target id is refused and never stored (rule 4.5)', async () => {
    const { defaultSettings, validateSettings, storableSettings, mergeSettings, WEBHOOK_NOT_STORED_MESSAGE } = await import('../core/settings.ts');
    const { createKvDocs, createMemoryKvStore } = await import('../core/kv.ts');
    const { identityCodec } = await import('../core/codec.ts');
    const base = defaultSettings('2026-09-27T00:00:00.000Z', 'UTC');
    const url = ['https:/', 'hooks.slack.com', 'services', 'T0FAKE000', 'B0FAKE000', 'fakeTokenNotReal0000'].join('/');
    const typed = { id: 'ep1', name: 'Ops', url: '', host: '', format: 'generic' as const, minSeverity: 'medium' as const, weeklyReceipt: true, enabled: true, channel: 'cribl-target' as const, criblTargetId: url };
    const withUrl = { ...base, notifications: [typed] };
    expect(validateSettings(withUrl).errors).toEqual([{ field: 'notifications[0].criblTargetId', message: WEBHOOK_NOT_STORED_MESSAGE }]);
    expect(JSON.stringify(storableSettings(withUrl))).not.toContain('hooks.slack.com');
    expect(mergeSettings(withUrl, base).notifications).toEqual([]);
    const kv = createMemoryKvStore();
    const docs = createKvDocs({ kv, codec: identityCodec, clock: { now: () => 0 } });
    await docs.putSettings(withUrl);
    expect(JSON.stringify([...kv.data.values()])).not.toContain('hooks.slack.com');
  });

  it('bundles no mock layer', () => {
    expect(primary.files.some((f) => f.endsWith('mockServiceWorker.js'))).toBe(false);
    const offenders = staticTexts(primary)
      .filter(({ text }) => /mockServiceWorker|\/mock-api\//.test(text))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it(`ships no .env file and no forbidden string or secret (every variant)${RULES_HERE ? '' : RULES_SKIPPED}`, () => {
    const rules = RULES_HERE ? loadRules() : [];
    const { secrets } = envSecrets();
    const hits: Hit[] = [];
    for (const x of [primary, ...demos, ...(backend ? [backend] : [])]) {
      expect(x.files.filter((f) => /(^|\/)\.env(\.|$)/.test(f)), x.file).toEqual([]);
      for (const f of x.files) {
        const buf = readFileSync(join(x.dir, f));
        if (isBinary(f, buf)) continue;
        hits.push(...scanText(`${x.file}!${f}`, buf.toString('utf8'), rules, secrets));
      }
    }
    expect(hits).toEqual([]);
  });
});

describe('demo package (stage build)', () => {
  it('exists and carries the -demo marker in its file name and its version or displayName', () => {
    expect(demos.length).toBeGreaterThan(0);
    for (const d of demos) {
      expect(d.file).toMatch(/-demo\.tgz$/);
      const marked = (d.pkg.version ?? '').endsWith('-demo') || /\(demo build\)/.test(d.pkg.displayName ?? '');
      expect(marked, `${d.file}: version ${d.pkg.version}, displayName ${d.pkg.displayName}`).toBe(true);
      expect(d.pkg.displayName).toBe('Meter Reader (demo build)');
      expect(d.pkg.name).toBe('meter-reader');
    }
  });

  it('is never the primary asset', () => {
    expect(primary.pkg.version).not.toMatch(/demo/i);
    expect(primary.pkg.displayName).not.toMatch(/demo/i);
    for (const d of demos) expect(d.file).not.toBe(PRIMARY_TGZ);
  });

  it('is a real demo build (the Demo Console chunk is present)', () => {
    for (const d of demos) expect(d.files.some((f) => /^static\/assets\/Demo[-.]/.test(f)), d.file).toBe(true);
  });

  it('grants the release reads plus the lever writes, and nothing on the backend', () => {
    const release = policiesOf(primary.text('default/policies.yml'));
    for (const d of demos) {
      const demo = policiesOf(d.text('default/policies.yml'));
      for (const r of release) {
        for (const a of r.actions) {
          expect(demo.some((p) => p.object === r.object && p.actions.includes(a)), `${d.file} lacks ${a} ${r.object}`).toBe(true);
        }
      }
      expect(demo).toEqual(policiesOf(read('config/demo/policies.yml')));
      expect(d.has('default/backend.yml')).toBe(false);
      expect(d.has('default/proxies.yml')).toBe(false);
    }
  });
});

describe('backend package (optional runtime for workspaces with App backend compute)', () => {
  it('builds, or is honestly absent', () => {
    if (!backend) {
      expect(backendSkipped, 'backend package missing without a reason').toBeTruthy();
      console.warn(`[compliance] backend package not checked: ${backendSkipped}`);
      return;
    }
    expect(backend.pkg.version).toBe(VERSION);
    expect(backend.pkg.displayName).toBe('Meter Reader');
  });

  it('declares no demo endpoint and stays inside the platform limits (D3, D4)', () => {
    if (!backend) return;
    const b = backend;
    const manifest = yamlMap(b.text('default/backend.yml')) as { runtime?: unknown; endpoints?: unknown };
    expect(manifest.runtime).toBe('js');
    const endpoints = (Array.isArray(manifest.endpoints) ? manifest.endpoints : []) as { name: string; script: string; timeout?: number; memory?: number }[];
    expect(endpoints.map((e) => e.name).sort()).toEqual(['meter', 'sendTest', 'weeklyReceipt']);
    for (const e of endpoints) {
      expect(e.name).not.toMatch(/^demo/i);
      expect(e.timeout ?? 30).toBeLessThanOrEqual(120);
      expect(e.memory ?? 256).toBeLessThanOrEqual(1024);
      expect(b.has(`default/${e.script}`), `bundle for ${e.name} (${e.script})`).toBe(true);
      // `apps build` rejects a bundle over 5 MB (AGENTS.md "Backend"); the packaged one is held to the same cap.
      expect(statSync(join(b.dir, `default/${e.script}`)).size, `bundle size of ${e.name}`).toBeLessThanOrEqual(5 * 1024 * 1024);
    }
    const schedules = yamlMap(b.text('default/schedules.yml')) as Record<string, { endpoint?: string; cronSchedule?: string }>;
    const ids = Object.keys(schedules);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThanOrEqual(10);
    for (const id of ids) {
      expect(endpoints.map((e) => e.name)).toContain(schedules[id].endpoint);
      expect(schedules[id].cronSchedule?.split(/\s+/).length).toBe(5);
    }
  });

  it('grants exactly what the release grants and declares no external host (D57: no webhook URL is stored anywhere)', () => {
    if (!backend) return;
    expect(policiesOf(backend.text('default/policies.yml'))).toEqual(policiesOf(primary.text('default/policies.yml')));
    expect(backend.has('default/proxies.yml')).toBe(false);
    expect(DECLARED_HOSTS).toEqual([]);
  });
});

// ─── Third-party notices (hackathon rule 4.7) ────────────────────────────────
// The minifier strips every license comment from the bundle, so every package carries the notices as files
// (scripts/package.mjs writeNotices): static/LICENSE and static/THIRD-PARTY-LICENSES.md, listing every npm package
// the Vite build bundled (its own module list, vite.config.ts build.license) and every font it copies, each with its
// license text. The repository keeps the release package's THIRD-PARTY-LICENSES.md at its root.

/**
 * The old sample commit author. The Story, the tour and the videos name the builder (CREDIT_STRINGS.builder) on the
 * sample commits now; the first hero GIF and the early sample data used this made-up name, and a package that still
 * carries it reads as unfinished next to the video and the judges' guide (efficiency audit, JUDGING #4).
 */
const OLD_SAMPLE_AUTHOR = /\bj\.rivera\b/i;

describe("every package's hero, screenshots and sample text (efficiency audit r2)", () => {
  const all = (): Extracted[] => [primary, ...demos, ...(backend ? [backend] : [])];

  it(`the hero static/${HERO_IMAGE.to} is at most 5 MB`, () => {
    for (const x of all()) {
      expect(x.has(`static/${HERO_IMAGE.to}`), `${x.file}: static/${HERO_IMAGE.to}`).toBe(true);
      const bytes = statSync(join(x.dir, `static/${HERO_IMAGE.to}`)).size;
      expect(bytes, `${x.file}: static/${HERO_IMAGE.to} bytes`).toBeLessThanOrEqual(HERO_MAX_BYTES);
      expect(mediaSizeProblems(new Map([[`static/${HERO_IMAGE.to}`, bytes]])), x.file).toEqual([]);
    }
  });

  // Rules review r2: the App's icon was still the scaffold's template bolt (the same class of leftover as icons.svg).
  it(`the App's icon is the Meter Reader mark, in the repository and in every package (static/${APP_ICON})`, () => {
    const icon = read(`public/${APP_ICON}`);
    expect(icon, `public/${APP_ICON} is the scaffold's template icon`).not.toMatch(SCAFFOLD_ICON);
    expect(icon).toContain('<title>Meter Reader</title>');
    expect(read('index.html')).toContain(`<link rel="icon" type="image/svg+xml" href="/${APP_ICON}" />`);
    for (const x of all()) {
      expect(x.has(`static/${APP_ICON}`), `${x.file}: static/${APP_ICON}`).toBe(true);
      expect(x.text(`static/${APP_ICON}`), `${x.file}: static/${APP_ICON} is stale: rebuild the package`).toBe(icon);
    }
  });

  it('every image and link in each packaged README resolves inside that package', () => {
    for (const x of all()) expect(readmeLinkProblems(x.text('README.md'), x.has), x.file).toEqual([]);
  });

  it('no packaged text carries the old sample author', () => {
    const hits: string[] = [];
    let scanned = 0;
    for (const x of all()) {
      for (const f of x.files) {
        const buf = readFileSync(join(x.dir, f));
        if (isBinary(f, buf)) continue;
        scanned++;
        const text = buf.toString('utf8');
        const m = OLD_SAMPLE_AUTHOR.exec(text);
        if (m) hits.push(`${x.file}!${f}:${text.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(scanned).toBeGreaterThan(10);
    expect(hits).toEqual([]);
  });
});

describe('third-party notices ship with every package (rule 4.7)', () => {
  const all = (): Extracted[] => [primary, ...demos, ...(backend ? [backend] : [])];
  const lock = (): Record<string, { version?: string }> =>
    (JSON.parse(read('package-lock.json')) as { packages: Record<string, { version?: string }> }).packages;
  const REFRESH = `refresh it: tar -xzOf ${PRIMARY_TGZ} ./static/${THIRD_PARTY_FILE} > ${THIRD_PARTY_FILE}`;

  it("every package carries static/LICENSE (the repository's Apache-2.0 text) and static/THIRD-PARTY-LICENSES.md", () => {
    for (const x of all()) {
      expect(x.has('static/LICENSE'), `${x.file}: static/LICENSE`).toBe(true);
      expect(x.text('static/LICENSE'), `${x.file}: static/LICENSE is the repository LICENSE`).toBe(read('LICENSE'));
      expect(x.has(`static/${THIRD_PARTY_FILE}`), `${x.file}: static/${THIRD_PARTY_FILE}`).toBe(true);
      // The build's license JSON is rendered into the notices and never ships itself.
      expect(x.files.filter((f) => f.startsWith('static/.vite/')), x.file).toEqual([]);
    }
  });

  it(`the repository's ${THIRD_PARTY_FILE} is the release package's`, () => {
    expect(existsSync(join(ROOT, THIRD_PARTY_FILE)), `${THIRD_PARTY_FILE} at the repository root (${REFRESH})`).toBe(true);
    expect(read(THIRD_PARTY_FILE), `${THIRD_PARTY_FILE} is stale: ${REFRESH}`).toBe(primary.text(`static/${THIRD_PARTY_FILE}`));
  });

  it('names every bundled npm package at its installed version, with an allowed license and its text, and every shipped font with the OFL', () => {
    const installed = lock();
    for (const x of all()) {
      const md = x.text(`static/${THIRD_PARTY_FILE}`);
      const rows = [...md.matchAll(/^\| `([^`]+)` \| ([^|]+) \| (.+) \|$/gm)].map((m) => ({ name: m[1] ?? '', version: (m[2] ?? '').trim(), license: (m[3] ?? '').trim() }));
      expect(rows.length, `${x.file}: bundled npm packages listed`).toBeGreaterThanOrEqual(20);
      // Not vacuous: the runtime dependencies the App imports directly are among them (react-router-dom re-exports react-router).
      for (const dep of ['react', 'react-dom', 'react-router', '@capra/core', '@capra/icons', '@capra/theme', '@tanstack/react-virtual', 'd3-sankey', 'd3-shape', 'qrcode']) {
        expect(rows.map((r) => r.name), `${x.file} lists ${dep}`).toContain(dep);
      }
      for (const r of rows) {
        const allowed = ALLOWED_LICENSES.has(r.license) || (r.name.startsWith('@capra/') && r.license.startsWith('Cribl Developer Agreement'));
        expect(allowed, `${x.file}: ${r.name} is under ${r.license}`).toBe(true);
        expect(installed[`node_modules/${r.name}`]?.version, `${x.file}: ${r.name} ${r.version} is the installed version`).toBe(r.version);
        const text = sectionOf(md, `### ${r.name} ${r.version} (${r.license})`);
        expect(text.trim().length, `${x.file}: license text of ${r.name}`).toBeGreaterThan(100);
      }
      const fonts = x.files.filter((f) => /^static\/assets\/[^/]+\.(ttf|otf|woff2?|eot)$/i.test(f)).map((f) => f.slice('static/assets/'.length));
      expect(fonts.length, `${x.file}: font files`).toBeGreaterThan(0);
      for (const font of shippedFonts(fonts)) {
        const text = sectionOf(md, `### ${font.family} (${font.license})`);
        expect(text, `${x.file}: ${font.family} license text, verbatim`).toContain(read(font.text).trimEnd());
        expect(text, `${x.file}: ${font.family}`).toContain('SIL OPEN FONT LICENSE Version 1.1');
      }
    }
  });

  // Rule 4.7(a): "all such tools and components are credited in the README". The notices file lists every package a
  // bundle holds; the README's disclosure must name each one (in backticks, with the license it declares on the same
  // line) and link the notices file for the texts (rules review r2: twelve bundled packages were named only as a class).
  it('README credits every bundled npm package by name and license, and links the notices file', () => {
    const disclosure = sectionOf(read('README.md'), '## AI tool and third-party disclosure');
    expect(disclosure.length).toBeGreaterThan(0);
    const lines = disclosure.split('\n');
    const uncredited = new Set<string>();
    if (!disclosure.includes(`](${THIRD_PARTY_FILE})`)) uncredited.add(`a link [${THIRD_PARTY_FILE}](${THIRD_PARTY_FILE})`);
    for (const x of all()) {
      const md = x.text(`static/${THIRD_PARTY_FILE}`);
      for (const m of md.matchAll(/^\| `([^`]+)` \| ([^|]+) \| (.+) \|$/gm)) {
        const name = m[1] ?? '';
        // "Cribl Developer Agreement (SEE LICENSE IN LICENSE.txt)" is credited as the agreement's name.
        const license = (m[3] ?? '').trim().replace(/ \(SEE LICENSE IN [^)]*\)$/, '');
        const credited = lines.some((l) => l.includes(`\`${name}\``) && l.includes(license));
        if (!credited) uncredited.add(`\`${name}\` (${license})`);
      }
    }
    expect([...uncredited].sort(), `README "## AI tool and third-party disclosure" must name these bundled packages with their licenses, and link the notices`).toEqual([]);
  });

  it('renders license texts that no line inside them can break, and refuses a font it has no notice for', () => {
    const md = thirdPartyNotices(
      [{ name: 'x', version: '1.0.0', identifier: 'MIT', text: '```\nCopyright\n~~~~\n# not a heading\n```' }],
      [{ family: 'F', from: 'p', license: 'OFL-1.1', text: 'OFL' }],
    );
    // The fence is longer than any tilde run in the text (a CommonMark fence closes only on its own character, at least
    // as long), so neither the inner backticks nor the four tildes close it, and the quoted heading stays text.
    expect(md).toContain('\n~~~~~text\n```\nCopyright\n~~~~\n# not a heading\n```\n~~~~~\n');
    expect(() => shippedFonts(['Mystery-Regular-abc123.woff2'])).toThrow(/no license notice/);
    expect(shippedFonts(['index-x.js', 'OpenSans-VariableFont_wdth_wght-SQU0RjE2.ttf']).map((f) => f.family)).toEqual(['Open Sans']);
  });
});

// ─── Journaled routes (EPIC_AUDIT P0-03) ─────────────────────────────────────
// The emulator journals every Leader call it answers. Drive the release runtime's own code paths through it —
// the Prices page's Leader inventory read on a fresh install, the tab's sweeps before and after prices, Sweep
// now, a regression delivered to the bell and a notification target, the weekly receipt, Connect and the
// What-if dry run — and every journaled route must be a grant in config/policies.yml (method + object). A
// member who was only shared the App has exactly those grants: an undeclared call is a 403 for them.

/** App-scoped paths the platform grants on its own (AGENTS.md: kvstore, proxy) and backend endpoints. */
const APP_SCOPED_ROUTE = /^\/(kvstore|proxy|endpoints)(\/|$)/;

/** A policy object as a path pattern: `:name` is one segment, `*` anything (AGENTS.md policies.yml). */
function policyPattern(object: string): RegExp {
  const source = object
    .split('/')
    .map((s) => (s === '*' ? '.*' : s.startsWith(':') ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${source}$`);
}

/** Journaled routes (`GET /m/:gid/pipelines`) that no policy grants. External hosts and app-scoped paths are skipped. */
function undeclaredRoutes(routes: Iterable<string>, policies: readonly Policy[]): string[] {
  const out: string[] = [];
  for (const route of routes) {
    const [method, rawPath = ''] = route.split(' ');
    const path = rawPath.split('?')[0];
    if (!path.startsWith('/') || APP_SCOPED_ROUTE.test(path)) continue;
    const granted = policies.some((p) => (p.actions.includes(method) || p.actions.includes('*')) && policyPattern(p.object).test(path));
    if (!granted) out.push(route);
  }
  return out.sort();
}

describe('journaled Leader routes (P0-03: every call the release runtime makes is a declared grant)', () => {
  const release = (): Policy[] => policiesOf(read('config/policies.yml'));

  it('the check can fail: an undeclared or wrong-method route is reported, app-scoped and external calls are not', () => {
    const policies = release();
    expect(undeclaredRoutes(['GET /master/groups', 'PATCH /m/:gid/pipelines/:id', 'DELETE /system/messages'], policies)).toEqual([
      'DELETE /system/messages',
      'GET /master/groups',
      'PATCH /m/:gid/pipelines/:id',
    ]);
    expect(
      undeclaredRoutes(
        ['GET /kvstore/*', 'POST /kvstore/keys', 'POST /proxy/*', 'POST /endpoints/:name', 'POST hooks.slack.com', 'GET /products/stream/groups', 'GET /m/:gid/version/show'],
        policies,
      ),
    ).toEqual([]);
  });

  it('a fresh install, the first sweeps, Sweep now, delivery, the weekly receipt, Connect and a dry run call only declared routes', async () => {
    const { createWorld, rigPrices, DAY, MINUTE } = await import('./integration/harness.ts');
    const { fetchInventory, listWorkerGroups } = await import('../core/adapters/config.ts');
    const { listTargets, ensureRelay, relayState } = await import('../core/adapters/cribl-notify.ts');
    const { runDryRun } = await import('../core/adapters/preview.ts');
    const { runWeeklyReceipt, sendTestNotification } = await import('../core/weekly.ts');
    const { defaultBellEndpoint } = await import('../core/delivery.ts');
    const { defaultSettings } = await import('../core/settings.ts');

    const w = await createWorld({ build: 'release', bare: true });
    const journaled = new Map<string, number>();
    // The raw paths too: a literal grant (the relay's, P1-N01) can only be checked against the path the runtime
    // called, never against the journal's normalized route (`/m/:gid/search/saved/:id`).
    const called = new Set<string>();
    const take = (): void => {
      const calls = w.em.calls();
      expect(calls.recent.length, 'the journal kept every call since the last take (none truncated)').toBe(calls.total);
      for (const [route, n] of Object.entries(calls.byRoute)) journaled.set(route, (journaled.get(route) ?? 0) + n);
      for (const e of calls.recent) if (e.kind === 'api') called.add(`${e.method} ${e.path}`);
      w.em.resetCalls();
    };
    const minute = async (): Promise<void> => {
      w.set(Math.floor(w.now() / MINUTE) * MINUTE + MINUTE + 25_000);
      await w.sweep('ui');
      take();
    };

    // Settings → Prices on a fresh install: the Leader inventory read (src/state/runtime.ts readLeaderInventory).
    w.em.resetCalls();
    const inventory = await fetchInventory(w.http, await listWorkerGroups(w.http));
    expect(Object.keys(inventory.byGroup)).toEqual(['default']);
    take();
    // The tab's sweep before any price (inventory only), then priced, with a bell and a notification target.
    expect((await w.sweep('ui')).skipped).toBe('no_prices');
    const settings = defaultSettings(new Date(w.now()).toISOString(), 'UTC');
    settings.notifications = [
      { ...defaultBellEndpoint(), id: 'ep_target', name: 'Ops via Cribl', channel: 'cribl-target', criblTargetId: 'ops-slack', minSeverity: 'medium' },
    ];
    await w.docs.putSettings(settings);
    await w.docs.putPrices(rigPrices(w.now() - DAY));
    await minute();
    await minute();
    await w.sweep('manual'); // Sweep now: the worker-group listing, inventory and timeline refreshes
    take();
    // A regression (the emulator's own control, not an API call) opens an incident the sweep delivers.
    w.em.control({ action: 'breakTrim', minutesAgo: 1 });
    for (let i = 0; i < 6; i++) await minute();
    await w.sweep('scheduled');
    take();
    await runWeeklyReceipt(w.deps, { mode: 'manual' });
    await sendTestNotification(w.deps, { endpoint: settings.notifications[0] });
    // Connect on a Cribl.Cloud Leader (the notification APIs on), so the relay's create and notification POSTs
    // really run: a Leader without them answers the first POST 404 and Connect stops there.
    w.em.control({ action: 'config', options: { notificationApis: true } });
    await listTargets(w.http);
    await relayState(w.http, 'ops-slack');
    expect((await ensureRelay(w.http, 'ops-slack')).ok, 'Connect created the relay').toBe(true);
    await runDryRun(w.http, { groupId: 'default', inputId: 'mrd_windows_workstations', treatment: 'pack-windows' });
    take();

    // The run exercised the paths it claims to (a silent no-op would pass vacuously).
    for (const route of ['GET /products/stream/groups', 'GET /m/:gid/system/inputs', 'POST /system/metrics/query', 'GET /m/:gid/version', 'POST /system/messages', 'GET /notification-targets']) {
      expect(journaled.has(route), `${route} was journaled`).toBe(true);
    }
    for (const call of [`GET ${savedSearchPath()}`, `POST ${SAVED_SEARCHES_PATH}`, `POST ${relayNotificationsPath()}`]) {
      expect(called.has(call), `${call} was called (Connect and the relay check)`).toBe(true);
    }
    expect(undeclaredRoutes(called, release())).toEqual([]);
  }, 60_000);
});
