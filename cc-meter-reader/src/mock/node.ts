// src/mock/node.ts — the Cribl emulator for Node (Vitest integration tests, scripts).
//
//   const mock = createMockServer({ clock: () => t });
//   beforeAll(() => mock.listen()); afterAll(() => mock.close());
//   await fetch(`${mock.baseUrl}/system/metrics/query`, { method: 'POST', body: … });
//
// `fetch` in Node needs absolute URLs, so the API answers on any origin under `/mock-api/v1` (and the
// backend runtime's `/api/v1`). For speed — the 2,000-flow bench — skip MSW and use the direct
// adapters re-exported below (`mock.http`, `mock.kv`, `mock.webhook`).

import { setupServer, type SetupServer } from 'msw/node';
import type { CriblHttp, KvStore, WebhookSender } from '../../core/types.ts';
import { createDirectHttp, createDirectKv, createDirectWebhook, createEmulator, type EmulatorSetup } from './direct.ts';
import type { CriblEmulator } from './emulator.ts';
import { createHandlers } from './handlers.ts';
import { MOCK_API_BASE, type CallsSummary, type ControlAction, type SinkEntry } from './types.ts';

export { createDirectHttp, createDirectKv, createDirectWebhook, createEmulator, DirectKvError } from './direct.ts';
export { CriblEmulator, materialize, normalizeRoute } from './emulator.ts';
export { createMemoryStore } from './store.ts';
export * from './types.ts';

/** Base URL tests hand to fetch-based transports (any host works; this one is obviously fake). */
export const NODE_BASE_URL = `http://cribl.mock${MOCK_API_BASE}`;

export interface MockServer {
  server: SetupServer;
  emulator: CriblEmulator;
  baseUrl: string;
  /** direct (no-fetch) adapters over the same emulator */
  http: CriblHttp;
  kv: KvStore;
  webhook: WebhookSender;
  listen(): void;
  close(): void;
  control(action: ControlAction): Record<string, unknown>;
  sink(): SinkEntry[];
  calls(): CallsSummary;
  resetCalls(): void;
}

export function createMockServer(setup: EmulatorSetup = {}): MockServer {
  const emulator = createEmulator(setup);
  const server = setupServer(...createHandlers(emulator, { backendPaths: true }));
  return {
    server,
    emulator,
    baseUrl: NODE_BASE_URL,
    http: createDirectHttp(emulator),
    kv: createDirectKv(emulator),
    webhook: createDirectWebhook(emulator),
    listen: () => server.listen({ onUnhandledRequest: 'bypass' }),
    close: () => server.close(),
    control: (a) => emulator.control(a),
    sink: () => emulator.sink(),
    calls: () => emulator.calls(),
    resetCalls: () => emulator.resetCalls(),
  };
}
