#!/usr/bin/env node
// scripts/package.mjs — builds one installable Meter Reader package (.tgz) from a staged copy of the repo.
//
//   node scripts/package.mjs [--variant release|backend|demo] [--version X.Y.Z] [--demo-version V]
//                            [--ref GIT-REF] [--out-dir release] [--keep-stage] [--verbose]
//
// Variants (SPEC 1 "two packages, one commit"; DECISIONS D5, D11, D12b, D17):
//   release  The primary asset. Front-end runtime, read-only: config/policies.yml, no proxies.yml (D23),
//            no backend.yml, no schedules.yml, VITE_MR_BUILD=release.      → release/meter-reader-X.Y.Z.tgz
//   backend  The release plus the optional backend runtime for workspaces with App backend compute:
//            config/enterprise/{backend,schedules}.yml → config/ (Enterprise variant; no proxies.yml since D57:
//            no build stores a webhook URL, so no build posts to a webhook host) and
//            config/schedules.yml (backend/ sources bundled by `apps build`), VITE_MR_BUILD=release,
//            VITE_MR_RUNTIME=backend.                                        → release/meter-reader-X.Y.Z-backend.tgz
//   demo     The stage build with the levers: config/demo/policies.yml, VITE_MR_BUILD=demo, front-end
//            runtime, version X.Y.Z-demo and displayName "Meter Reader (demo build)".
//                                                                            → release/meter-reader-X.Y.Z-demo.tgz
//            D5 fallback, if a Leader refuses the pre-release version: --demo-version 1.0.1 packs a plain
//            numeric version; the displayName and the file name still carry the demo marker.
//
// How: copy the repo (minus node_modules, .git, planning docs, build outputs, every .env file, and every
// test source: of tests/ only the fixtures the mock layer imports) into .stage/pkg-<variant>, give it a node_modules of symlinks to the real packages (build caches
// stay private to the stage), overlay the variant's config, set the stage's package.json version and
// displayName, run `npm run build` (tsc -b && vite build && apps build) there with the variant's env, then
// pack it with `createAppPack(stageDir, false)` from `@cribl/apps/package` and stream the tarball into the
// output directory. The working tree is never modified: everything happens under .stage/ (git-ignored)
// and the only file written outside it is the finished .tgz.
//
// --ref GIT-REF stages that commit (`git archive`) instead of the working tree: the way to build a release
// from exactly the tagged commit, whatever is in progress around it.
//
// Every package also carries the notices the minifier strips (rule 4.7): static/LICENSE and
// static/THIRD-PARTY-LICENSES.md, written by `writeNotices()` from the Vite build's own list of bundled packages
// (vite.config.ts build.license) and the fonts it copies. The repository keeps the same THIRD-PARTY-LICENSES.md at its
// root, refreshed after a rebuild with
//   tar -xzOf release/meter-reader-X.Y.Z.tgz ./static/THIRD-PARTY-LICENSES.md > THIRD-PARTY-LICENSES.md
// (tests/compliance.test.ts holds the two equal).
//
// The README inside every package is the Marketplace overview (AGENTS.md "Cribl Marketplace listing"), and a
// package holds only README.md, package.json, static/ and default/. So the stage's README is rewritten by
// `packagedReadme()` (the working tree's README is never touched): the hero image points at static/hero.gif,
// which the stage copies from video/hero.gif into dist/ after the build; links and images into docs/images/ (the
// screenshot grid) point at static/images/, which the stage copies from docs/images/ the same way; every other
// relative link becomes an absolute link into the repository of record (REPO_URL, the App Metadata table's
// Repository); and the two sections written for the hackathon judges (REPO_ONLY_SECTIONS) are left out, with any
// in-page link to them pointed at the repository README. `readmeLinkProblems()` then fails the package on any
// relative link, image or #anchor that does not resolve inside it, and on an image that would render as a GitHub
// page; tests/compliance.test.ts runs the same check. The hero is capped at 5 MB (HERO_MAX_BYTES): a larger one fails
// the build. The screenshots are not capped; `npm run audit` prints every packaged file's size.

import { cp, mkdir, readFile, readdir, rename, rm, rmdir, stat, symlink, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** Top-level entries never copied into a stage. */
const EXCLUDE_TOP = new Set([
  'node_modules',
  '.git',
  'meter-reader-v4.16', // private planning documents (DECISIONS D1)
  '.stage',
  'build',
  'dist',
  'release',
  'package-build',
  'backend-build',
  'coverage',
  'test-results',
  'playwright-report',
  'video',
  'openapi.json', // Cribl's spec, local reference only (DECISIONS D18)
]);
/** Nested paths never copied (repo-relative, '/'-separated). */
const EXCLUDE_NESTED = ['tests/report'];
/**
 * Of tests/, only the fixtures are staged: the mock layer (src/mock) type-checks against them. Test sources
 * are never part of a package, and leaving them out keeps a package build independent of test files that
 * are mid-edit; `npm run typecheck` and the test suites check them.
 */
const TESTS_KEPT = 'tests/fixtures';
/** node_modules entries that hold build caches: the stage gets its own. */
const PRIVATE_NODE_MODULES = new Set(['.tmp', '.vite', '.vite-temp', '.cache', '.vitest']);
/** The App's icon (index.html's <link rel="icon">), from public/; shipped as static/<this>. */
export const APP_ICON = 'favicon.svg';
/** The scaffold template's icon (a purple bolt, #863bff), which an App must not ship as its own. */
export const SCAFFOLD_ICON = /#863bff/i;
/** Mock-only asset (MSW's worker for dev and Playwright); a package never runs the mock. */
const MOCK_WORKER = 'public/mockServiceWorker.js';

/**
 * The public repository that holds the App (README "App Metadata" → Repository): the submission's home,
 * Cribl-Community/cc-meter-reader (hackathon rules 3.2, 3.3: "All submitted work must reside in a public
 * repository within that organization"; DECISIONS D58). The owner pushes it there himself as the last step (STATE
 * 0y); the staging copy in DataDay-Technology-Solutions/cribl-apps-public/cc-meter-reader carries the same package.
 * Packaged README links point into it through repoFileUrl(). To point a build elsewhere, change PUBLIC_REPO (and
 * REPO_SUBDIR for a subfolder) here and core/settings.ts DEFAULT_QR_URL, then rebuild.
 */
export const PUBLIC_REPO = 'https://github.com/Cribl-Community/cc-meter-reader';
export const REPO_SUBDIR = '';
export const REPO_URL = REPO_SUBDIR ? `${PUBLIC_REPO}/tree/main/${REPO_SUBDIR}` : PUBLIC_REPO;
/** A file (blob) or folder (tree, for a path ending in '/') of the App's tree in the public repository. */
export function repoFileUrl(path, publicRepo = PUBLIC_REPO) {
  return `${publicRepo}/${path.endsWith('/') ? 'tree' : 'blob'}/main/${REPO_SUBDIR ? `${REPO_SUBDIR}/` : ''}${path}`;
}
/** The README's hero image: tracked at `from`, shipped in every package as static/<to> (dist/<to>). */
export const HERO_IMAGE = { from: 'video/hero.gif', to: 'hero.gif' };
/**
 * The hero's ceiling. It is the first image on GitHub and in every package's Marketplace overview, and every package
 * carries it, so a re-render that balloons it fails the build instead of quietly tripling the download (efficiency
 * audit: "about 1280 px wide and under about 5 MB").
 */
export const HERO_MAX_BYTES = 5 * 1024 * 1024;
/**
 * The README's other images (the screenshot grid): tracked under `from`, shipped in every package under static/<to>
 * (dist/<to>), and every README link or image into `from` is rewritten to it. Only image files are copied.
 */
export const README_IMAGES = { from: 'docs/images/', to: 'images/' };
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg)$/i;
/** README sections written for the hackathon judges; the Marketplace overview leaves them out. */
export const REPO_ONLY_SECTIONS = ['## Stage One checklist', '## Pitch'];

// ─── Third-party notices (hackathon rule 4.7) ────────────────────────────────
// The minifier strips every license comment from the bundle, so each package carries the notices as files:
// static/LICENSE (the App's Apache-2.0 text) and static/THIRD-PARTY-LICENSES.md (every npm package whose code the
// bundle holds, from the Vite build's own module list, plus the fonts the build copies from @capra/theme). The same
// THIRD-PARTY-LICENSES.md is committed at the repository root; tests/compliance.test.ts holds it to the release package.

/** Where `vite build` writes the bundled packages' licenses (vite.config.ts build.license), relative to dist/. */
export const LICENSE_JSON = '.vite/third-party-licenses.json';
/** The notices file every package ships as static/<this> and the repository keeps at its root. */
export const THIRD_PARTY_FILE = 'THIRD-PARTY-LICENSES.md';
/**
 * Fonts the build copies into static/assets (from @capra/theme's fonts.css), matched by file name, each with the
 * license text it ships under (licenses/, verbatim from each font project). A font file matching none fails the build.
 */
export const FONT_NOTICES = [
  { family: 'Open Sans', file: /^OpenSans-/, from: '@capra/theme', license: 'OFL-1.1', text: 'licenses/OFL-1.1-Open-Sans.txt' },
  { family: 'Source Code Pro', file: /^source-code-pro-/, from: '@capra/theme', license: 'OFL-1.1', text: 'licenses/OFL-1.1-Source-Code-Pro.txt' },
];
const FONT_FILE = /\.(ttf|otf|woff2?|eot)$/i;

/** The font families among `assetNames` (static/assets), in FONT_NOTICES order; throws on a font with no notice. */
export function shippedFonts(assetNames) {
  const used = new Set();
  for (const name of assetNames.filter((n) => FONT_FILE.test(n))) {
    const font = FONT_NOTICES.find((f) => f.file.test(name));
    if (!font) throw new Error(`static/assets/${name} is a font with no license notice: add it to FONT_NOTICES in scripts/package.mjs`);
    used.add(font);
  }
  return FONT_NOTICES.filter((f) => used.has(f));
}

/** A fence that no line of `text` can close: one tilde more than the longest tilde run opening a line. */
function fenceFor(text) {
  const longest = Math.max(2, ...[...text.matchAll(/^ {0,3}(~+)/gm)].map((m) => m[1].length));
  return '~'.repeat(longest + 1);
}

const cell = (s) => String(s).replace(/\|/g, '\\|');
/** The license a package declares, as a reader knows it: Capra's "SEE LICENSE IN LICENSE.txt" is the Cribl Developer Agreement. */
function licenseName(p) {
  if (!p.identifier) return 'not declared';
  if (/^SEE LICENSE IN /i.test(p.identifier) && /Cribl Developer Agreement/.test(p.text ?? '')) return `Cribl Developer Agreement (${p.identifier})`;
  return p.identifier;
}

/**
 * static/THIRD-PARTY-LICENSES.md: `packages` is Vite's license JSON ([{ name, version, identifier?, text? }]), `fonts`
 * is [{ family, from, license, text }] with the license text read. Deterministic for one dependency set (no hashed
 * file names), so the release, Enterprise and demo builds of one commit agree unless their bundles differ.
 */
export function thirdPartyNotices(packages, fonts) {
  const sorted = [...packages].sort((a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)));
  const out = [
    '# Third-party licenses',
    '',
    `Meter Reader is licensed under Apache-2.0 (\`LICENSE\`: at the root of the repository, and beside this file in every package). Its built App (\`static/\` in a package) bundles the third-party components below: ${sorted.length} npm packages and ${fonts.length} font ${fonts.length === 1 ? 'family' : 'families'}. Each entry gives the license the component declares and the license text it ships.`,
    '',
    'Generated by `scripts/package.mjs` from the Vite build\'s own list of bundled modules (`build.license` in `vite.config.ts`) and the fonts the build copies; do not edit by hand. Rebuild the packages to refresh it.',
    '',
    '## npm packages',
    '',
    '| Package | Version | License |',
    '| --- | --- | --- |',
    ...sorted.map((p) => `| \`${cell(p.name)}\` | ${cell(p.version)} | ${cell(licenseName(p))} |`),
    '',
    '## Fonts',
    '',
    '| Font | Shipped in | License |',
    '| --- | --- | --- |',
    ...fonts.map((f) => `| ${f.family} | \`${f.from}\` | ${f.license} |`),
    '',
    '## License texts',
  ];
  for (const p of sorted) {
    out.push('', `### ${p.name} ${p.version} (${licenseName(p)})`, '');
    if (p.text) {
      const fence = fenceFor(p.text);
      out.push(`${fence}text`, p.text.replace(/\r\n?/g, '\n').trimEnd(), fence);
    } else out.push(`The package ships no license file; its package.json declares ${p.identifier ?? 'no license'}.`);
  }
  for (const f of fonts) {
    const fence = fenceFor(f.text);
    out.push('', `### ${f.family} (${f.license})`, '', `${fence}text`, f.text.replace(/\r\n?/g, '\n').trimEnd(), fence);
  }
  return `${out.join('\n')}\n`;
}

/**
 * Writes the notices into the stage's dist/ (shipped as static/): LICENSE, and THIRD-PARTY-LICENSES.md rendered from
 * the build's license JSON, which then leaves dist/. Everything is read from the stage, so a --ref build uses that
 * commit's LICENSE and font texts.
 */
async function writeNotices(stageDir) {
  const dist = join(stageDir, 'dist');
  const jsonPath = join(dist, LICENSE_JSON);
  if (!(await exists(jsonPath))) {
    throw new Error(`the build wrote no dist/${LICENSE_JSON}: vite.config.ts must keep build.license { fileName: '${LICENSE_JSON}' } (rule 4.7)`);
  }
  const packages = JSON.parse(await readFile(jsonPath, 'utf8'));
  await rm(jsonPath);
  await rmdir(dirname(jsonPath)).catch(() => {}); // .vite/ goes too, unless something else is in it
  const fonts = await Promise.all(
    shippedFonts(await readdir(join(dist, 'assets'))).map(async (f) => ({ ...f, text: await readFile(join(stageDir, f.text), 'utf8') })),
  );
  await writeFile(join(dist, THIRD_PARTY_FILE), thirdPartyNotices(packages, fonts));
  await cp(join(stageDir, 'LICENSE'), join(dist, 'LICENSE'));
  return { packages: packages.length, fonts: fonts.length };
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens (github-slugger). */
export function headingSlug(heading) {
  return heading
    .replace(/^#{1,6}\s+/, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/** Every heading's anchor in a Markdown text (fenced code skipped; repeats get -1, -2 like GitHub). */
export function headingAnchors(markdown) {
  const seen = new Map();
  const out = new Set();
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    else if (!fenced && /^#{1,6} /.test(line)) {
      const base = headingSlug(line);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      out.add(n === 0 ? base : `${base}-${n}`);
    }
  }
  return out;
}

/**
 * The inline links and images of one line, `[text](target)` / `![alt](target)`, as { image, target, start, end } with
 * start/end indexing the target, ordered by where each opens. Brackets are matched as a stack, so a linked image
 * `[![alt](a.png)](b.png)` yields both targets (a single left-to-right pattern saw only the inner one, and the outer
 * link shipped unrewritten and unchecked). A backslash-escaped bracket is text. The target grammar is the one this
 * file always used: no space, no ')' and nothing after it but the ')', so a titled link is left alone.
 */
export function linkSpans(line) {
  const spans = [];
  const open = [];
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '[') open.push({ at: i, image: i > 0 && line[i - 1] === '!' });
    else if (c === ']' && open.length > 0) {
      const opener = open.pop();
      const m = line[i + 1] === '(' ? /^\(([^)\s]+)\)/.exec(line.slice(i + 1)) : null;
      if (m) {
        spans.push({ at: opener.at, image: opener.image, target: m[1], start: i + 2, end: i + 2 + m[1].length });
        i += m[0].length;
      }
    }
  }
  return spans.sort((a, b) => a.at - b.at).map(({ image, target, start, end }) => ({ image, target, start, end }));
}

/** Inline Markdown links and images outside fenced code: `[text](target)` / `![alt](target)`, linked images included. */
export function markdownLinks(markdown) {
  const links = [];
  let fenced = false;
  markdown.split('\n').forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    for (const { image, target } of linkSpans(line)) links.push({ line: i + 1, image, target });
  });
  return links;
}

const isExternal = (target) => /^[a-z][a-z0-9+.-]*:/i.test(target);
/** A GitHub file page (…/blob/…): an HTML page, so as an image it renders as a broken icon. */
const GITHUB_BLOB = /^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\//;

/**
 * Where one README link or image points in a package: the hero → static/<HERO_IMAGE.to>, anything under
 * README_IMAGES.from → static/<README_IMAGES.to>…, an anchor into a dropped section → the repository README, every
 * other relative path → its page in the repository; external links and kept anchors unchanged.
 */
function packagedTarget(target, dropped, repoUrl, publicRepo) {
  if (target.startsWith('#')) return dropped.has(target.slice(1)) ? `${repoUrl}${target}` : target;
  if (isExternal(target)) return target;
  const path = target.replace(/^\.\//, '');
  if (path === HERO_IMAGE.from) return `static/${HERO_IMAGE.to}`;
  if (path.startsWith(README_IMAGES.from)) return `static/${README_IMAGES.to}${path.slice(README_IMAGES.from.length)}`;
  return repoFileUrl(path, publicRepo);
}

/**
 * The README a package carries (see the header): hero → static/<HERO_IMAGE.to>, the screenshot grid
 * (README_IMAGES.from) → static/<README_IMAGES.to>, relative links → REPO_URL, REPO_ONLY_SECTIONS dropped (each runs
 * to the next heading of its level or higher) and in-page links to them sent to the repository README.
 */
export function packagedReadme(markdown, repoUrl = REPO_URL, publicRepo = PUBLIC_REPO) {
  const lines = markdown.split('\n');
  const kept = [];
  const dropped = new Set();
  let dropLevel = 0;
  let fenced = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const heading = !fenced && /^(#{1,6}) /.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (dropLevel && level <= dropLevel) dropLevel = 0;
      if (!dropLevel && REPO_ONLY_SECTIONS.includes(line.trimEnd())) {
        dropLevel = level;
        dropped.add(headingSlug(line));
      }
    }
    if (!dropLevel) kept.push(line);
  }
  fenced = false;
  return kept
    .map((line) => {
      if (/^\s*```/.test(line)) fenced = !fenced;
      if (fenced) return line;
      // Right to left, so each splice leaves the indices of the spans before it intact.
      let out = line;
      for (const { target, start, end } of linkSpans(line).sort((a, b) => b.start - a.start)) {
        out = `${out.slice(0, start)}${packagedTarget(target, dropped, repoUrl, publicRepo)}${out.slice(end)}`;
      }
      return out;
    })
    .join('\n')
    .replace(/\n{3,}$/, '\n');
}

/**
 * Links in a packaged README that would be dead on the Marketplace overview: a relative link or image whose
 * path is not a file in the package (`has`), an #anchor that is not a heading in it, or an image that points at a
 * GitHub file page (what the transform makes of an image outside README_IMAGES.from and the hero: a page, not an
 * image, so it renders broken). Returns messages.
 */
export function readmeLinkProblems(markdown, has) {
  const anchors = headingAnchors(markdown);
  const problems = [];
  for (const { line, image, target } of markdownLinks(markdown)) {
    if (image && GITHUB_BLOB.test(target)) {
      problems.push(`README.md:${line} shows ${target}, a GitHub page rather than an image: put the image under ${README_IMAGES.from} so the package ships it`);
      continue;
    }
    if (isExternal(target)) continue;
    if (target.startsWith('#')) {
      if (!anchors.has(target.slice(1))) problems.push(`README.md:${line} links to #${target.slice(1)}, which is not a heading in the package README`);
      continue;
    }
    const path = target.replace(/^\.\//, '').split('#')[0];
    if (!has(path)) problems.push(`README.md:${line} ${image ? 'shows' : 'links to'} ${target}, which is not in the package`);
  }
  return problems;
}

export const VARIANTS = {
  release: {
    build: 'release',
    runtime: 'ui',
    displayName: 'Meter Reader',
    policies: 'config/policies.yml',
    backend: false,
    suffix: '',
  },
  backend: {
    // The Enterprise variant: App backend compute + a declared proxy host (both need an Enterprise plan).
    build: 'release',
    runtime: 'backend',
    displayName: 'Meter Reader',
    policies: 'config/policies.yml',
    backend: true,
    suffix: '-backend',
  },
  demo: {
    build: 'demo',
    runtime: 'ui',
    displayName: 'Meter Reader (demo build)',
    policies: 'config/demo/policies.yml',
    backend: false,
    suffix: '-demo',
  },
};

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DEMO_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-demo)?$/;

function usage(code = 2) {
  console.error(
    [
      'usage: node scripts/package.mjs [--variant release|backend|demo] [--version X.Y.Z]',
      '                                [--demo-version X.Y.Z-demo|X.Y.Z] [--ref GIT-REF] [--out-dir release]',
      '                                [--keep-stage] [--verbose]',
      '  --demo and --backend are shorthands for --variant demo / --variant backend.',
    ].join('\n'),
  );
  process.exit(code);
}

export function parseArgs(argv) {
  const opts = { variant: 'release', version: undefined, demoVersion: undefined, ref: undefined, outDir: 'release', keepStage: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) usage();
      return v;
    };
    if (a === '--variant') opts.variant = next();
    else if (a.startsWith('--variant=')) opts.variant = a.slice('--variant='.length);
    else if (a === '--demo') opts.variant = 'demo';
    else if (a === '--backend') opts.variant = 'backend';
    else if (a === '--release') opts.variant = 'release';
    else if (a === '--version') opts.version = next();
    else if (a.startsWith('--version=')) opts.version = a.slice('--version='.length);
    else if (a === '--demo-version') opts.demoVersion = next();
    else if (a.startsWith('--demo-version=')) opts.demoVersion = a.slice('--demo-version='.length);
    else if (a === '--ref') opts.ref = next();
    else if (a.startsWith('--ref=')) opts.ref = a.slice('--ref='.length);
    else if (a === '--out-dir') opts.outDir = next();
    else if (a.startsWith('--out-dir=')) opts.outDir = a.slice('--out-dir='.length);
    else if (a === '--keep-stage') opts.keepStage = true;
    else if (a === '--verbose') opts.verbose = true;
    else if (a === '--help' || a === '-h') usage(0);
    else {
      console.error(`unknown argument: ${a}`);
      usage();
    }
  }
  if (!Object.hasOwn(VARIANTS, opts.variant)) {
    console.error(`unknown variant "${opts.variant}" (release | backend | demo)`);
    usage();
  }
  return opts;
}

/** The version written into the package and the file-name label, per variant. */
export function resolveVersions(variant, releaseVersion, demoVersion) {
  if (!SEMVER.test(releaseVersion)) throw new Error(`--version must be X.Y.Z (got "${releaseVersion}")`);
  if (variant !== 'demo') {
    if (demoVersion) throw new Error('--demo-version applies only to --variant demo');
    return { packageVersion: releaseVersion, fileLabel: `${releaseVersion}${VARIANTS[variant].suffix}` };
  }
  const v = demoVersion ?? `${releaseVersion}-demo`;
  if (!DEMO_VERSION.test(v)) throw new Error(`--demo-version must be X.Y.Z-demo or X.Y.Z (got "${v}")`);
  // D5: the -demo marker lives in the version when the Leader accepts it, and always in the displayName
  // and the file name, so the numeric fallback is still unmistakably the demo build.
  return { packageVersion: v, fileLabel: v.endsWith('-demo') ? v : `${v}-demo` };
}

function log(...args) {
  console.log('[package]', ...args);
}

/** The hero image's bytes: from the working tree, or from the staged commit when building --ref. */
async function heroImage(commit) {
  if (!commit) return readFile(join(ROOT, HERO_IMAGE.from));
  return execFileSync('git', ['show', `${commit}:${HERO_IMAGE.from}`], { cwd: ROOT, maxBuffer: 1 << 26 });
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function isExcluded(rel) {
  const top = rel.split(sep)[0];
  if (EXCLUDE_TOP.has(top)) return true;
  const base = rel.split(sep).pop() ?? '';
  if (base === '.DS_Store') return true;
  if (base === '.env' || base.startsWith('.env.')) return true; // secrets never enter a stage (or a bundle)
  const posix = rel.split(sep).join('/');
  if (posix.startsWith('tests/') && posix !== TESTS_KEPT && !posix.startsWith(`${TESTS_KEPT}/`)) return true;
  return EXCLUDE_NESTED.some((n) => posix === n || posix.startsWith(`${n}/`));
}

/** Copies the repo into `stageDir` entry by entry (a stage lives under the repo, so one recursive cp can't). */
async function copyRepo(stageDir) {
  await mkdir(stageDir, { recursive: true });
  for (const entry of await readdir(ROOT)) {
    if (isExcluded(entry)) continue;
    await cp(join(ROOT, entry), join(stageDir, entry), {
      recursive: true,
      verbatimSymlinks: true,
      filter: (src) => !isExcluded(relative(ROOT, src)),
    });
  }
}

/** Stages one commit instead of the working tree. Returns the full commit hash. */
async function exportRef(stageDir, ref) {
  const sha = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: ROOT, encoding: 'utf8' }).trim();
  await mkdir(stageDir, { recursive: true });
  const archive = execFileSync('git', ['archive', '--format=tar', sha], { cwd: ROOT, maxBuffer: 1 << 30 });
  execFileSync('tar', ['-xf', '-', '-C', stageDir], { input: archive });
  for (const entry of await readdir(stageDir)) {
    if (isExcluded(entry)) await rm(join(stageDir, entry), { recursive: true, force: true });
  }
  for (const nested of EXCLUDE_NESTED) await rm(join(stageDir, nested), { recursive: true, force: true });
  if (await exists(join(stageDir, 'tests'))) {
    for (const entry of await readdir(join(stageDir, 'tests'))) {
      if (isExcluded(join('tests', entry))) await rm(join(stageDir, 'tests', entry), { recursive: true, force: true });
    }
  }
  return sha;
}

/** node_modules for the stage: one symlink per real package, but private build caches. */
async function linkNodeModules(stageDir) {
  const real = join(ROOT, 'node_modules');
  if (!(await exists(real))) throw new Error('node_modules is missing: run `npm ci` first');
  const staged = join(stageDir, 'node_modules');
  await mkdir(staged, { recursive: true });
  for (const entry of await readdir(real)) {
    if (PRIVATE_NODE_MODULES.has(entry)) continue;
    await symlink(join(real, entry), join(staged, entry));
  }
}

async function overlayConfig(stageDir, variant) {
  const v = VARIANTS[variant];
  const cfg = (p) => join(stageDir, p);
  // Start every variant from the release declarations with no backend, whatever the tree holds.
  await rm(cfg('config/backend.yml'), { force: true });
  await rm(cfg('config/schedules.yml'), { force: true });
  await rm(cfg(MOCK_WORKER), { force: true });
  if (v.policies !== 'config/policies.yml') {
    await cp(join(ROOT, v.policies), cfg('config/policies.yml'));
  }
  // DECISIONS D23: App proxies (and App backend compute) require an Enterprise plan, so the release and
  // demo packages declare no proxies.yml and install on every Cribl.Cloud plan. D57: no build stores a webhook URL
  // (a credential in plain KV), so the Enterprise variant declares no host either; it carries only the backend.
  await rm(cfg('config/proxies.yml'), { force: true });
  if (v.backend) {
    const backendSrc = join(ROOT, 'config/enterprise/backend.yml');
    const schedulesSrc = join(ROOT, 'config/enterprise/schedules.yml');
    for (const p of [backendSrc, schedulesSrc]) {
      if (!(await exists(p))) throw new Error(`backend variant needs ${relative(ROOT, p)} (the backend overlay); it is missing`);
    }
    await cp(backendSrc, cfg('config/backend.yml'));
    await cp(schedulesSrc, cfg('config/schedules.yml'));
  }
}

async function stampPackageJson(stageDir, variant, packageVersion) {
  const path = join(stageDir, 'package.json');
  const pkg = JSON.parse(await readFile(path, 'utf8'));
  pkg.version = packageVersion;
  pkg.displayName = VARIANTS[variant].displayName;
  // The pack copies `license` into the installed package.json; the repo is Apache-2.0 (LICENSE).
  if (!pkg.license) pkg.license = 'Apache-2.0';
  await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`);
  return pkg;
}

function buildEnv(variant) {
  const v = VARIANTS[variant];
  const env = { ...process.env, VITE_MR_BUILD: v.build, VITE_MR_RUNTIME: v.runtime };
  // Set, not unset: Vite replaces a defined import.meta.env key with a constant, so the mock branch in
  // src/main.tsx (DEV || VITE_MR_MOCK === '1') is dropped from every package even if the caller's shell
  // exported VITE_MR_MOCK=1 (Playwright does).
  env.VITE_MR_MOCK = '0';
  delete env.NODE_OPTIONS;
  // Vite keeps a NODE_ENV the caller already set, and any value but 'production' makes `import.meta.env.DEV`
  // true in the bundle — so a build spawned from vitest (NODE_ENV=test; tests/compliance.test.ts builds a
  // missing package) shipped the mock layer. Unset, `vite build` sets production itself.
  delete env.NODE_ENV;
  return env;
}

function run(cmd, args, { cwd, env, verbose }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    let out = '';
    const onData = (chunk) => {
      const s = chunk.toString();
      out += s;
      if (verbose) process.stdout.write(s);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolvePromise(out);
      else {
        const err = new Error(`${cmd} ${args.join(' ')} exited with code ${code}`);
        err.output = out;
        reject(err);
      }
    });
  });
}

async function sha256(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

function listTgz(file) {
  return execFileSync('tar', ['-tzf', file], { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.replace(/^\.\//, ''))
    .filter((l) => l && l !== '.' && l !== './');
}

function readFromTgz(file, member) {
  return execFileSync('tar', ['-xzOf', file, `./${member}`], { encoding: 'utf8' });
}

/** Post-pack sanity checks; the full rule set lives in tests/compliance.test.ts. */
function verifyPackage(file, variant, packageVersion) {
  const entries = listTgz(file);
  const has = (p) => entries.includes(p);
  const pkg = JSON.parse(readFromTgz(file, 'package.json'));
  const problems = [];
  if (pkg.name !== 'meter-reader') problems.push(`name is ${pkg.name}`);
  if (pkg.version !== packageVersion) problems.push(`version is ${pkg.version}, expected ${packageVersion}`);
  if (pkg.displayName !== VARIANTS[variant].displayName) problems.push(`displayName is ${pkg.displayName}`);
  if (pkg.cribl?.type !== 'app') problems.push('package.json lacks cribl.type "app"');
  // The App is signed by its builder (README "App Metadata" → Author; CREDIT_STRINGS.builder).
  if (!pkg.author) problems.push('package.json names no author');
  for (const required of ['README.md', 'static/index.html', 'default/policies.yml', 'static/LICENSE', `static/${THIRD_PARTY_FILE}`]) {
    if (!has(required)) problems.push(`missing ${required}`);
  }
  if (entries.some((e) => e.startsWith('static/.vite/'))) problems.push('static/.vite/ shipped (the build\'s license JSON belongs in THIRD-PARTY-LICENSES.md)');
  // The scaffold's public/icons.svg (brand-logo symbols nothing references) was removed; never ship it again.
  if (has('static/icons.svg')) problems.push('static/icons.svg shipped (the scaffold\'s unused brand-logo sprite)');
  // The App's icon is its own meter mark, never the scaffold's template bolt (rules review r2, the same class as icons.svg).
  if (has(`static/${APP_ICON}`) && SCAFFOLD_ICON.test(readFromTgz(file, `static/${APP_ICON}`))) problems.push(`static/${APP_ICON} is the scaffold's template icon, not the Meter Reader mark`);
  if (has('default/proxies.yml')) problems.push('default/proxies.yml present (D23, D57: no package declares an external host)');
  const hasBackend = has('default/backend.yml') || has('default/schedules.yml');
  if (VARIANTS[variant].backend && !has('default/backend.yml')) problems.push('backend variant without default/backend.yml');
  if (VARIANTS[variant].backend && !has('default/schedules.yml')) problems.push('backend variant without default/schedules.yml');
  if (!VARIANTS[variant].backend && hasBackend) problems.push(`${variant} package must not declare a backend`);
  if (entries.some((e) => e.endsWith('mockServiceWorker.js'))) problems.push('mock service worker shipped');
  if (entries.some((e) => /(^|\/)\.env(\.|$)/.test(e))) problems.push('an .env file shipped');
  if (!has(`static/${HERO_IMAGE.to}`)) problems.push(`missing static/${HERO_IMAGE.to} (the README's hero image)`);
  if (has('README.md')) problems.push(...readmeLinkProblems(readFromTgz(file, 'README.md'), has));
  return { entries, pkg, problems };
}

/** The hero's size, read from the stage's dist/ before it is packed, keyed by its path in a package (static/…). */
async function stagedMediaSizes(stageDir) {
  const hero = join(stageDir, 'dist', HERO_IMAGE.to);
  return new Map((await exists(hero)) ? [[`static/${HERO_IMAGE.to}`, (await stat(hero)).size]] : []);
}

/** A package's hero over HERO_MAX_BYTES; `sizes` maps a packaged path (static/…) → bytes. */
export function mediaSizeProblems(sizes) {
  const problems = [];
  const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
  const hero = sizes.get(`static/${HERO_IMAGE.to}`);
  if (hero !== undefined && hero > HERO_MAX_BYTES) problems.push(`static/${HERO_IMAGE.to} is ${mb(hero)}, over the ${mb(HERO_MAX_BYTES)} ceiling (HERO_MAX_BYTES): re-render it smaller`);
  return problems;
}

/** Copies the README's images (README_IMAGES.from in the stage, image files only) into dist/; returns how many. */
async function copyReadmeImages(stageDir) {
  const from = join(stageDir, README_IMAGES.from);
  if (!(await exists(from))) return 0;
  let n = 0;
  for (const entry of await readdir(from, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !IMAGE_FILE.test(entry.name)) continue;
    const rel = relative(from, join(entry.parentPath, entry.name));
    await mkdir(dirname(join(stageDir, 'dist', README_IMAGES.to, rel)), { recursive: true });
    await cp(join(from, rel), join(stageDir, 'dist', README_IMAGES.to, rel));
    n++;
  }
  return n;
}

export async function buildPackage(opts) {
  const variant = opts.variant;
  const rootPkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const releaseVersion = opts.version ?? rootPkg.version;
  const { packageVersion, fileLabel } = resolveVersions(variant, releaseVersion, opts.demoVersion);

  const stageDir = join(ROOT, '.stage', `pkg-${variant}`);
  const outDir = resolve(ROOT, opts.outDir);
  const outFile = join(outDir, `meter-reader-${fileLabel}.tgz`);
  const tmpFile = `${outFile}.tmp`;
  const t0 = Date.now();

  log(`variant ${variant} · version ${packageVersion} · stage ${relative(ROOT, stageDir)}${opts.ref ? ` · from ${opts.ref}` : ''}`);
  await rm(stageDir, { recursive: true, force: true });
  let commit;
  if (opts.ref) commit = await exportRef(stageDir, opts.ref);
  else await copyRepo(stageDir);
  await linkNodeModules(stageDir);
  await overlayConfig(stageDir, variant);
  await stampPackageJson(stageDir, variant, packageVersion);
  const stageReadme = join(stageDir, 'README.md');
  await writeFile(stageReadme, packagedReadme(await readFile(stageReadme, 'utf8')));

  const env = buildEnv(variant);
  log(`npm run build (VITE_MR_BUILD=${env.VITE_MR_BUILD}, VITE_MR_RUNTIME=${env.VITE_MR_RUNTIME})`);
  try {
    await run('npm', ['run', 'build'], { cwd: stageDir, env, verbose: opts.verbose });
  } catch (e) {
    const tail = String(e.output ?? '').split('\n').slice(-60).join('\n');
    throw new Error(`build failed in ${relative(ROOT, stageDir)} (kept for inspection)\n${tail}`);
  }
  if (!(await exists(join(stageDir, 'dist', 'index.html')))) throw new Error('build produced no dist/index.html');
  // The hero image is excluded from the stage with the rest of video/; it ships as static/<to>.
  await writeFile(join(stageDir, 'dist', HERO_IMAGE.to), await heroImage(commit));
  // The README's screenshot grid ships beside it as static/<README_IMAGES.to> (the stage holds docs/, from the tree or the ref).
  const images = await copyReadmeImages(stageDir);
  if (images > 0) log(`README images: ${images} from ${README_IMAGES.from} → static/${README_IMAGES.to}`);
  const media = mediaSizeProblems(await stagedMediaSizes(stageDir));
  if (media.length > 0) throw new Error(`the hero image is too large:\n  - ${media.join('\n  - ')}`);
  const notices = await writeNotices(stageDir);
  log(`notices: static/LICENSE, static/${THIRD_PARTY_FILE} (${notices.packages} npm packages, ${notices.fonts} font families)`);

  const { createAppPack } = require('@cribl/apps/package');
  await mkdir(outDir, { recursive: true });
  await rm(tmpFile, { force: true });
  const { stdout, closePromise } = await createAppPack(stageDir, false);
  await Promise.all([pipeline(stdout, createWriteStream(tmpFile)), closePromise]);
  await rename(tmpFile, outFile);

  const { entries, pkg, problems } = verifyPackage(outFile, variant, packageVersion);
  if (problems.length > 0) {
    throw new Error(`package ${relative(ROOT, outFile)} failed its checks:\n  - ${problems.join('\n  - ')}`);
  }
  const bytes = (await stat(outFile)).size;
  const digest = await sha256(outFile);
  if (!opts.keepStage) await rm(stageDir, { recursive: true, force: true });

  const summary = {
    variant,
    source: commit ? `commit ${commit}` : 'working tree',
    file: relative(ROOT, outFile),
    name: pkg.name,
    version: pkg.version,
    displayName: pkg.displayName,
    bytes,
    files: entries.filter((e) => !e.endsWith('/')).length,
    sha256: digest,
    seconds: Math.round((Date.now() - t0) / 100) / 10,
  };
  log(`wrote ${summary.file} · ${(bytes / 1024).toFixed(0)} KB · ${summary.files} files · sha256 ${digest.slice(0, 16)}… · ${summary.seconds} s`);
  return summary;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    const summary = await buildPackage(opts);
    console.log(JSON.stringify(summary));
  } catch (e) {
    console.error(`[package] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

