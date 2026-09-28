// src/mock/handlers.ts — MSW v2 request handlers: a thin adapter from `Request` to the emulator.

import { http, HttpResponse, type RequestHandler } from 'msw';
import type { CriblEmulator } from './emulator.ts';
import type { MockRequest } from './types.ts';

async function toMockRequest(request: Request): Promise<MockRequest> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = request.method === 'GET' || request.method === 'HEAD' ? null : await request.text();
  return { method: request.method, url: request.url, headers, body };
}

/**
 * Handlers for the emulator: everything under `/mock-api/` on any origin (Node needs absolute URLs),
 * the captured webhook hosts, and — when asked — the backend runtime's `/api/v1/…` spelling.
 */
export function createHandlers(emulator: CriblEmulator, opts: { sinkHosts?: string[]; backendPaths?: boolean } = {}): RequestHandler[] {
  const resolve = async ({ request }: { request: Request }): Promise<Response> => {
    const res = await emulator.handle(await toMockRequest(request));
    return new HttpResponse(res.status === 204 || res.status === 304 ? null : res.body, { status: res.status, headers: res.headers });
  };
  const hosts = opts.sinkHosts ?? ['hooks.slack.com', 'webhook.site'];
  return [
    http.all('*/mock-api/*', resolve),
    ...hosts.map((h) => http.all(`https://${h}/*`, resolve)),
    ...(opts.backendPaths ? [http.all('*/api/v1/*', resolve)] : []),
  ];
}
