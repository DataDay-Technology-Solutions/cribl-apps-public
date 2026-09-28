// backend/sendTest.ts — the `sendTest` endpoint (backend variant): `{ endpointId }` → posts the SPEC 12.5 test
// payload to that endpoint and answers `{ status, hostAuthorized }` (false when the proxy refused the host).

import { sendTestNotification } from '../core/weekly.ts';
import { depsFor } from './lib/deps.ts';
import { json, readJsonBody, stringField, type BackendContext } from './lib/http.ts';

export async function onRequest(request: Request, context: BackendContext): Promise<Response> {
  const body = await readJsonBody(request);
  const endpointId = stringField(body, 'endpointId');
  if (!endpointId) return json(400, { error: 'endpointId is required' });
  const result = await sendTestNotification(depsFor(request, context, body), {
    endpointId,
  });
  if (result.error === 'not_found') return json(404, { error: 'not_found', endpointId });
  return json(200, result);
}
