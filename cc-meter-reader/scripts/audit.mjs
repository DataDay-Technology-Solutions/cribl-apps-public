#!/usr/bin/env node
// scripts/audit.mjs — the release audit: what exactly would a judge install?
//
//   node scripts/audit.mjs [--rebuild] [--version X.Y.Z] [--no-test]
//
// 1. Makes sure release/ holds the release and backend packages for the version (package.json's by default),
//    building any that is missing with scripts/package.mjs (--rebuild rebuilds them). Any demo package already in
//    release/ counts (D22: the deployable one is plain numeric, built with --demo-version); when there is none (a
//    fresh clone: demo packages are never committed), or with --rebuild, the demo build goes to a temporary
//    directory and is audited from there, so the audit never leaves an undeployable X.Y.Z-demo package in release/.
// 2. Prints, for every release/*.tgz: size, SHA-256, name, version and display name, every file with its
//    size, the declared Cribl API grants (method + object), the declared external hosts, backend endpoints
//    and schedules. This is the same information the Review App screen shows at install.
// 3. Runs tests/compliance.test.ts (the rules live there, not here) and exits with its status.
//
// Read-only apart from building a missing release or backend package: extraction happens in a temporary directory.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const YAML = createRequire(require.resolve('@cribl/apps/package'))('yaml');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (flag('--help') || flag('-h')) {
  console.log('usage: node scripts/audit.mjs [--rebuild] [--version X.Y.Z] [--no-test]');
  process.exit(0);
}

/** POSTs that change no configuration: the What-if preview (tests/compliance.test.ts DRY_RUN_POSTS; DECISIONS D16, D30). */
const DRY_RUN_POSTS = new Set(['/m/:gid/preview']);

const version = valueOf('--version') ?? JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const wanted = [
  { variant: 'release', file: `release/meter-reader-${version}.tgz` },
  { variant: 'demo', file: `release/meter-reader-${version}-demo.tgz` },
  { variant: 'backend', file: `release/meter-reader-${version}-backend.tgz` },
];

function hr(title) {
  console.log(`\n${'='.repeat(100)}\n${title}\n${'='.repeat(100)}`);
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function kb(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

// A deployable demo package carries a plain numeric version (D22: `package:demo -- --demo-version 1.0.12`), so any
// demo package already in release/ satisfies the audit. Only when there is none (or with --rebuild) does it build
// `${version}-demo`, and then into a temporary directory: the audit never adds an undeployable demo package to release/.
const demoPresent = existsSync(join(ROOT, 'release')) && readdirSync(join(ROOT, 'release')).some((f) => /^meter-reader-.+-demo\.tgz$/.test(f));
/** Where a demo build made by this audit lives (removed at exit). */
let demoTmp;
process.on('exit', () => {
  if (demoTmp) rmSync(demoTmp, { recursive: true, force: true });
});

// 1. Packages.
for (const { variant, file } of wanted) {
  const tmp = variant === 'demo' && (flag('--rebuild') || !demoPresent);
  if (variant === 'demo' && !tmp) continue;
  if (!tmp && existsSync(join(ROOT, file)) && !flag('--rebuild')) continue;
  if (variant === 'backend' && !existsSync(join(ROOT, 'config/enterprise/backend.yml'))) {
    console.warn(`[audit] skipping the backend package: config/enterprise/backend.yml is not in this checkout`);
    continue;
  }
  const args = ['scripts/package.mjs', '--variant', variant, '--version', version];
  if (tmp) {
    demoTmp = mkdtempSync(join(tmpdir(), 'mr-audit-demo-'));
    args.push('--out-dir', demoTmp);
  }
  console.log(`[audit] building ${tmp ? join(demoTmp, `meter-reader-${version}-demo.tgz`) : file}`);
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`[audit] scripts/package.mjs --variant ${variant} failed`);
    process.exit(1);
  }
}

// 2. Inventory.
const releaseDir = join(ROOT, 'release');
const tgzIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.tgz')).sort().map((f) => join(dir, f)) : []);
const archives = [...tgzIn(releaseDir), ...(demoTmp ? tgzIn(demoTmp) : [])];
if (archives.length === 0) {
  console.error('[audit] release/ holds no .tgz');
  process.exit(1);
}
for (const file of archives) {
  const name = basename(file);
  const bytes = statSync(file).size;
  const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
  const dir = mkdtempSync(join(tmpdir(), 'mr-audit-'));
  try {
    execFileSync('tar', ['-xzf', file, '-C', dir]);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const primary = name === `meter-reader-${version}.tgz`;
    hr(`${file.startsWith(ROOT) ? relative(ROOT, file) : `${file} (temporary demo build)`}${primary ? '   (PRIMARY ASSET)' : ''}`);
    console.log(`size ${kb(bytes)} · sha256 ${sha}`);
    console.log(`name ${pkg.name} · version ${pkg.version} · displayName ${pkg.displayName} · license ${pkg.license ?? '(none)'} · author ${pkg.author}`);

    console.log('\nfiles:');
    const files = walk(dir)
      .map((p) => ({ path: relative(dir, p).split(sep).join('/'), size: statSync(p).size }))
      .sort((a, b) => a.path.localeCompare(b.path));
    for (const f of files) console.log(`  ${kb(f.size).padStart(10)}  ${f.path}`);
    console.log(`  ${files.length} files, ${kb(files.reduce((n, f) => n + f.size, 0))} uncompressed`);

    const readYaml = (p) => (existsSync(join(dir, p)) ? YAML.parse(readFileSync(join(dir, p), 'utf8')) : undefined);
    const policies = readYaml('default/policies.yml')?.policies ?? [];
    console.log('\nCribl API grants (default/policies.yml):');
    for (const p of policies) {
      const writes = p.actions.filter((a) => a !== 'GET');
      const postOnly = writes.length > 0 && writes.every((a) => a === 'POST');
      const note =
        writes.length === 0
          ? ''
          : postOnly && p.object.startsWith('/system/metrics/')
            ? '   (a read despite the verb)'
            : postOnly && DRY_RUN_POSTS.has(p.object)
              ? "   (a dry run: sends mode 'pipe', saves nothing; the README names the caveat)"
              : '   <- WRITE';
      console.log(`  ${p.actions.join(', ').padEnd(14)} ${p.object}${note}`);
    }
    const proxies = readYaml('default/proxies.yml') ?? {};
    console.log('\nexternal hosts (default/proxies.yml):');
    for (const [host, conf] of Object.entries(proxies)) {
      console.log(`  ${host}  paths ${JSON.stringify(conf?.paths?.allowlist ?? ['(any)'])}  timeout ${conf?.timeout ?? 30000} ms  injected headers: ${conf?.headers?.inject ? Object.keys(conf.headers.inject).join(', ') : 'none'}`);
    }
    const backend = readYaml('default/backend.yml');
    console.log('\nbackend functions (default/backend.yml):');
    if (!backend) console.log('  none');
    else for (const e of backend.endpoints ?? []) console.log(`  ${e.name.padEnd(16)} ${e.script}  timeout ${e.timeout ?? 30} s  memory ${e.memory ?? 256} MB`);
    const schedules = readYaml('default/schedules.yml');
    console.log('\nschedules (default/schedules.yml):');
    if (!schedules) console.log('  none');
    else for (const [id, s] of Object.entries(schedules)) console.log(`  ${id.padEnd(22)} ${String(s.cronSchedule).padEnd(12)} -> ${s.endpoint}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 3. The rules.
if (flag('--no-test')) process.exit(0);
hr('tests/compliance.test.ts');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
// A demo build made above is handed to the test (MR_COMPLIANCE_DEMO_DIR), so it is checked without a second build.
const env = demoTmp ? { ...process.env, MR_COMPLIANCE_DEMO_DIR: demoTmp } : process.env;
const test = spawnSync(npx, ['vitest', 'run', 'tests/compliance.test.ts'], { cwd: ROOT, env, stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(test.status ?? 1);
