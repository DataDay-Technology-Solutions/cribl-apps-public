// backend/meter.ts — the `meter` endpoint (backend variant): the scheduled sweep every minute
// (`{ scheduleId, scheduledFor, mode: 'scheduled' }`) and "Sweep now" (`{ mode: 'manual' }`, at most once per
// 30 s from the UI). All the work is core `runSweep()`; this is the HTTP shell.

import { runSweep } from '../core/sweep.ts';
import { depsFor } from './lib/deps.ts';
import { json, readJsonBody, type BackendContext } from './lib/http.ts';

export async function onRequest(request: Request, context: BackendContext): Promise<Response> {
  const body = await readJsonBody(request);
  const mode = body.mode === 'manual' ? 'manual' : 'scheduled';
  const result = await runSweep(depsFor(request, context, body), { mode });
  // The snapshot goes back only to a person waiting on "Sweep now"; a schedule discards the body.
  const { snapshot, ...summary } = result;
  const payload = {
    ok: result.error === undefined || result.skipped !== undefined,
    ...summary,
    ...(mode === 'manual' && snapshot ? { snapshot } : {}),
  };
  return json(result.error !== undefined && result.skipped === undefined ? 422 : 200, payload);
}
