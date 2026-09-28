// backend/weeklyReceipt.ts — the `weeklyReceipt` endpoint (backend variant): Monday 12:00 UTC from the
// schedule, or "Weekly receipt now" (`{ mode: 'manual' }`). Core `runWeeklyReceipt()` does the work.

import { runWeeklyReceipt } from '../core/weekly.ts';
import { depsFor } from './lib/deps.ts';
import { json, readJsonBody, type BackendContext } from './lib/http.ts';

export async function onRequest(request: Request, context: BackendContext): Promise<Response> {
  const body = await readJsonBody(request);
  const mode = body.mode === 'manual' ? 'manual' : 'scheduled';
  const result = await runWeeklyReceipt(depsFor(request, context, body), {
    mode,
  });
  return json(result.error !== undefined && result.skipped === undefined ? 422 : 200, { ok: result.error === undefined, ...result });
}
