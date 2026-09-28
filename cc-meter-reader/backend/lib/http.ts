// backend/lib/http.ts — request/response plumbing shared by the backend endpoints (backend variant only,
// DECISIONS D12b). Endpoints answer JSON; app-level failures use 422 so they are never confused with the
// platform's own 502/503/504 ("backend not running").

/** What the platform passes as `onRequest`'s second argument (the scaffold types `appId`; the docs add the rest). */
export interface BackendContext {
  appId: string;
  installationId?: string;
  invocationId?: string;
  caller?: { userId?: string };
}

export type JsonBody = Record<string, unknown>;

/** The request body as a JSON object; an empty, non-JSON or non-object body reads as `{}`. */
export async function readJsonBody(request: Request): Promise<JsonBody> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return {};
  }
  if (text.trim() === '') return {};
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonBody) : {};
  } catch {
    return {};
  }
}

/** A JSON response. */
export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A non-empty string field of a body, else undefined. */
export function stringField(body: JsonBody, name: string): string | undefined {
  const v = body[name];
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}
