// src/lib/env.ts — build flags and platform globals, read in one place.
//
// Build flag rule (SPEC 13): the release bundle must contain no Demo Console. Code that gates a
// dynamic import on the build must test `import.meta.env.VITE_MR_BUILD === 'demo'` INLINE at the
// import site (see src/router.tsx) so Vite's static replacement lets the bundler drop the branch;
// `IS_DEMO_BUILD` below is for ordinary runtime decisions (labels, nav visibility).

// The platform globals' ambient types, for every program that reaches this module (the app, the tests, the backend).
import type {} from './globals.d.ts';
import type { Build, Settings } from '../../core/types.ts';
import { version as packageJsonVersion } from '../../package.json';

declare global {
  interface ImportMetaEnv {
    /** 'backend' in the Enterprise backend variant (scripts/package.mjs); unset (front-end runtime) otherwise. */
    readonly VITE_MR_RUNTIME?: string;
  }
}

export const IS_DEMO_BUILD: boolean = import.meta.env.VITE_MR_BUILD === 'demo';
export const BUILD: Build = IS_DEMO_BUILD ? 'demo' : 'release';

/** The runtime a build flag selects: 'backend' for 'backend' (case and spaces ignored), else the front-end 'ui' (D12b). */
export function runtimeFromEnv(value: unknown): Settings['runtime'] {
  return typeof value === 'string' && value.trim().toLowerCase() === 'backend' ? 'backend' : 'ui';
}

/**
 * The default `settings.runtime` of this bundle: 'backend' in the Enterprise backend variant
 * (`VITE_MR_RUNTIME=backend`), 'ui' in the release and demo builds. Passed to `defaultSettings`; a
 * stored settings document still wins.
 */
export const DEFAULT_RUNTIME: Settings['runtime'] = runtimeFromEnv(import.meta.env.VITE_MR_RUNTIME);

/** Base URL the in-browser Cribl emulator (MSW, dev/Playwright only) answers on. */
export const MOCK_API_BASE = '/mock-api/v1';

/**
 * The version this bundle was built from (package.json). A named JSON import, so the bundler inlines
 * just this one field — not the whole manifest. `meta.appVersion` wins when present.
 */
export const PACKAGE_VERSION: string = typeof packageJsonVersion === 'string' ? packageJsonVersion : '0.0.0';

/** What a sweep started from this bundle records in `meta` (appVersion, build). */
export const APP_BUILD_INFO: { appVersion: string; build: Build } = { appVersion: PACKAGE_VERSION, build: BUILD };

/**
 * Footer label: `v1.0.1` — the version of the INSTALLED package, i.e. the one this bundle was built as
 * (scripts/package.mjs writes it into the stage's package.json before `vite build`). Never
 * `meta.appVersion`: that records whoever swept last, and the runner writes 'runner' there (REVIEW-3a #10).
 * Demo packages are plain numeric (DECISIONS D22), so no `-demo` suffix is added; the footer's
 * "demo build" label carries the marker. A stray leading `v` or legacy `-demo` suffix is dropped.
 */
export function versionLabel(version: string = PACKAGE_VERSION): string {
  const base = version.trim() || PACKAGE_VERSION;
  const bare = (base.startsWith('v') ? base.slice(1) : base).replace(/-demo$/, '');
  return `v${bare}`;
}

/** Whether the in-browser mock API may be started by this bundle (never in a plain release build). */
export function mockModeAllowed(): boolean {
  return import.meta.env.DEV || import.meta.env.VITE_MR_MOCK === '1';
}

/**
 * Base URL for every Cribl API call. Set by the platform inside Cribl; in mock mode `main.tsx` points
 * it at the emulator before anything reads it. Throws when neither happened, because a silent relative
 * URL would send KV writes to the dev server.
 */
export function apiBaseUrl(): string {
  const url = typeof window === 'undefined' ? undefined : window.CRIBL_API_URL;
  if (!url) throw new Error('CRIBL_API_URL is not set: Meter Reader must run inside Cribl or in mock mode.');
  return url.replace(/\/+$/, '');
}

/** Router basename (AGENTS.md "React Router"); '/' outside Cribl. */
export function basePath(): string {
  const raw = typeof window === 'undefined' ? undefined : window.CRIBL_BASE_PATH;
  if (!raw) return '/';
  const trimmed = raw.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/** True when this document is framed by the Cribl shell (or any parent). */
export function isEmbedded(): boolean {
  try {
    return window.parent !== window;
  } catch {
    // Accessing a cross-origin parent can throw in some sandboxes; being framed is then certain.
    return true;
  }
}

/**
 * The signed-in Cribl member as people should read them (AGENTS.md "How to Get User Info"): the profile's first and last
 * name ("Steve Koelpin"), else the username; undefined outside Cribl, when the platform refuses, or when it does not
 * answer within `timeoutMs`. Used to sign price versions (EPIC_AUDIT P2-W24), so "set by Steve Koelpin" reads as the
 * incident card's "closed by" and the Demo Console's commits do; a save never waits longer than the timeout for it.
 */
export async function criblMemberName(timeoutMs = 2_000): Promise<string | undefined> {
  const get = typeof window === 'undefined' ? undefined : window.getCriblUser;
  if (typeof get !== 'function') return undefined;
  try {
    const user = await Promise.race([get(), new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs))]);
    const full = [user?.firstName, user?.lastName].filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()).join(' ');
    const name = full || (typeof user?.username === 'string' ? user.username.trim() : '');
    return name === '' ? undefined : name;
  } catch {
    return undefined;
  }
}
