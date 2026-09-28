// backend/lib/deps.ts — SweepDeps for one backend invocation (runtime 'backend').

import { createBackendDeps, createOwnerId } from '../../core/runtime.ts';
import type { SweepDeps } from '../../core/sweep.ts';
import { APP_VERSION, BUILD } from './build-info.ts';
import { stringField, type BackendContext, type JsonBody } from './http.ts';

/**
 * Dependencies for this invocation. The lock owner is the invocation id, so a retried invocation re-enters
 * its own lock; `workspace` / `linkBase` come from the body when the UI passes them (it knows its own URL),
 * else from the request URL.
 */
export function depsFor(request: Request, context: BackendContext, body: JsonBody): SweepDeps {
  const workspace = stringField(body, 'workspace');
  const linkBase = stringField(body, 'linkBase');
  return createBackendDeps({
    appVersion: APP_VERSION,
    build: BUILD,
    owner: context?.invocationId ? `backend:${context.invocationId}` : createOwnerId('backend'),
    requestUrl: request.url,
    ...(workspace ? { workspace } : {}),
    ...(linkBase ? { linkBase } : {}),
  });
}
