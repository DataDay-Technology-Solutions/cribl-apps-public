// tests/e2e/helpers/mock.ts — drive the in-browser Cribl emulator from Playwright.
//
// MSW runs its handlers inside the page, so the control API is only reachable through the page:
// Playwright's `request` fixture talks to the Vite server directly and would bypass the emulator.
// Every helper here therefore runs `fetch` inside the page via `page.evaluate`.

import type { Page } from '@playwright/test';

/** Mirrors src/mock/types.ts ControlAction (kept structural so tests never import app code). */
export type MockAction =
  | { action: 'reset'; preset?: 'demo' | 'scale'; seed?: number; flows?: number; keepKv?: boolean; options?: Record<string, unknown> }
  | { action: 'advance'; minutes: number }
  | { action: 'setClock'; at: number }
  | { action: 'breakTrim'; pipelineId?: string; withPacks?: boolean; at?: number; minutesAgo?: number; author?: { name: string; email: string } }
  | { action: 'restore'; pipelineId?: string; at?: number; minutesAgo?: number }
  | { action: 'applyPack'; routeId: string; level?: 'pack' | 'aggressive'; at?: number; minutesAgo?: number }
  | { action: 'revertPack'; routeId: string; at?: number; minutesAgo?: number }
  | { action: 'setRate'; inputId: string; multiplier: number; at?: number; minutesAgo?: number }
  | { action: 'spike'; inputId?: string; multiplier?: number; at?: number; minutesAgo?: number }
  | { action: 'calm'; inputId?: string; at?: number; minutesAgo?: number }
  | { action: 'fault'; method?: string; path?: string; pattern?: string; status: number; body?: unknown; times?: number }
  | { action: 'clearFaults' }
  | { action: 'config'; options: Record<string, unknown> }
  | { action: 'clearKv' }
  | { action: 'clearSink' }
  | { action: 'resetCalls' }
  | { action: 'state' }
  | { action: 'seedRollups'; at?: number; since?: number; prices?: unknown; tz?: string; dayDays?: number }
  | { action: 'seedInventory'; at?: number }
  | { action: 'runnerSweep'; owner?: string; at?: number };

export interface SinkDelivery {
  id: number;
  at: number;
  method: string;
  url: string;
  host: string;
  /** 'cribl-target': handed to a Cribl notification target through the Search relay (the emulated notification service). */
  via: 'direct' | 'proxy' | 'cribl-target';
  contentType: string;
  body: string;
  json?: unknown;
  status: number;
}

export interface MockCalls {
  total: number;
  byRoute: Record<string, number>;
  endpointCalls: number;
  recent: { at: number; method: string; path: string; route: string; status: number; kind: string }[];
}

export class MockNotRunningError extends Error {
  constructor(detail: string) {
    super(
      `The Cribl emulator is not answering in this page (${detail}). The app must call start() from ` +
        `src/mock/browser.ts before rendering when window.CRIBL_API_URL is undefined, and the page must be ` +
        `on the app origin (call gotoApp first).`,
    );
    this.name = 'MockNotRunningError';
  }
}

async function pageFetch<T>(page: Page, path: string, init: { method: string; body?: unknown }): Promise<T> {
  if (!/^https?:/.test(page.url())) throw new MockNotRunningError(`page is at ${page.url() || 'about:blank'}`);
  const res = await page.evaluate(
    async ({ path: p, method, body }) => {
      const r = await fetch(p, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, contentType: r.headers.get('content-type') ?? '', text: await r.text() };
    },
    { path, method: init.method, body: init.body },
  );
  if (!res.contentType.includes('application/json')) throw new MockNotRunningError(`${init.method} ${path} answered ${res.status} ${res.contentType || 'without a content type'}`);
  const parsed = JSON.parse(res.text) as T;
  if (res.status >= 400) throw new Error(`mock ${init.method} ${path} → ${res.status}: ${res.text}`);
  return parsed;
}

/** POST /mock-api/_control — returns what changed (commits made, when their effect starts). */
export function mockControl(page: Page, action: MockAction): Promise<Record<string, unknown>> {
  return pageFetch(page, '/mock-api/_control', { method: 'POST', body: action });
}

/** GET /mock-api/_state — the emulated org at a glance (clock, commits, deploys, effects, pending files). */
export function mockState(page: Page): Promise<Record<string, unknown>> {
  return pageFetch(page, '/mock-api/_state', { method: 'GET' });
}

/** Webhook deliveries captured from hooks.slack.com / webhook.site (direct or via /proxy), newest first. */
export async function sinkDeliveries(page: Page): Promise<SinkDelivery[]> {
  return (await pageFetch<{ items: SinkDelivery[] }>(page, '/mock-api/_sink', { method: 'GET' })).items;
}

export async function clearSink(page: Page): Promise<void> {
  await pageFetch(page, '/mock-api/_sink', { method: 'DELETE' });
}

/** A message in the emulated Cribl notification bell (`POST /system/messages`; docs/NOTIFICATIONS.md §2.1). */
export interface BellMessage {
  id: string;
  severity: 'info' | 'warn' | 'error' | 'fatal';
  title: string;
  text: string;
  time: number;
}

/** The emulated bell's messages, newest first (read without touching the call journal). */
export async function bellMessages(page: Page): Promise<BellMessage[]> {
  return (await pageFetch<{ items: BellMessage[] }>(page, '/mock-api/_bell', { method: 'GET' })).items;
}

/** Empties the emulated bell. */
export async function clearBell(page: Page): Promise<void> {
  await pageFetch(page, '/mock-api/_bell', { method: 'DELETE' });
}

/**
 * Switches Cribl.Cloud's notification APIs (the bell, `/notification-targets`, the Search relay) on or off for
 * the emulated Leader: off, every one of them answers 404, as on a Leader that is not Cribl.Cloud.
 */
export function setNotificationApis(page: Page, on: boolean): Promise<Record<string, unknown>> {
  return mockControl(page, { action: 'config', options: { notificationApis: on } });
}

/** Leader API calls the app made since the last resetCalls (SPEC 16 S16 budget checks). */
export function mockCalls(page: Page): Promise<MockCalls> {
  return pageFetch(page, '/mock-api/_calls', { method: 'GET' });
}

export async function resetCalls(page: Page): Promise<void> {
  await pageFetch(page, '/mock-api/_calls', { method: 'DELETE' });
}

/** Starts the emulated org over: a fresh demo world, empty KV, empty sink and journal. */
export function resetMock(page: Page, opts: Omit<Extract<MockAction, { action: 'reset' }>, 'action'> = {}): Promise<Record<string, unknown>> {
  return mockControl(page, { action: 'reset', ...opts });
}

/** Waits until a webhook delivery matching `predicate` arrives (polling the sink). */
export async function waitForDelivery(page: Page, predicate: (d: SinkDelivery) => boolean, timeoutMs = 30_000): Promise<SinkDelivery> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = (await sinkDeliveries(page)).find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`no matching webhook delivery within ${timeoutMs} ms`);
    await page.waitForTimeout(500);
  }
}

/** Reads a KV value straight from the emulator (null when absent). */
export async function kvGet(page: Page, key: string): Promise<string | null> {
  if (!/^https?:/.test(page.url())) throw new MockNotRunningError(`page is at ${page.url() || 'about:blank'}`);
  return page.evaluate(async (k) => {
    const r = await fetch(`/mock-api/v1/kvstore/${k.split('/').map(encodeURIComponent).join('/')}`);
    return r.status === 404 ? null : r.text();
  }, key);
}

/** A prices document for the demo rig's four destinations (effective from 2026-01-01). */
export const RIG_PRICES = {
  schemaVersion: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  versions: [
    {
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      byOutputId: {
        mrd_siem_prod: { milliCentsPerGb: 250_000, preset: 'splunk_cloud' },
        mrd_analytics: { milliCentsPerGb: 150_000, preset: 'datadog' },
        mrd_archive_s3: { milliCentsPerGb: 3_000, preset: 's3' },
        devnull: { milliCentsPerGb: 0, preset: 'internal' },
      },
    },
  ],
};

/**
 * Stores a prices document in the emulator's KV (the app reads it at its next hydration). A priced workspace
 * is what makes `/` the Receipt; a never-priced one sends `/` to the first-run card (PRD 8.5).
 */
export async function seedPrices(page: Page, prices: unknown = RIG_PRICES): Promise<void> {
  if (!/^https?:/.test(page.url())) throw new MockNotRunningError(`page is at ${page.url() || 'about:blank'}`);
  const status = await page.evaluate(async (body) => {
    const r = await fetch('/mock-api/v1/kvstore/prices', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body });
    return r.status;
  }, JSON.stringify(prices));
  if (status !== 201) throw new Error(`PUT /kvstore/prices answered ${status}`);
}
