# KV store, backend endpoints, schedules, logging, rate limits: what the reference apps show

Researched 2026-09-25 for Meter Reader. Sources:

- **Scaffold:** `AGENTS.md` (the authoritative guide), plus `node_modules/@cribl/apps@1.1.0`.
- **Reference clones:** the 16 repos under `scratchpad/ref/`. Each citation starts with its repo name, e.g. `cc-visicore-spl-to-kql/backend/lib/kv.ts:27`.
- **Scaffold paths:** a citation with no repo prefix, such as `AGENTS.md:67` or `backend/hello.ts:14`, points into `cc-meter-reader` itself.

Evidence tags:

- **[MEASURED yyyy-mm-dd]:** a repo records a live measurement against Cribl. It is dated where the repo gives a date; plain [MEASURED] means the repo says "confirmed live" or "verified against Cloud" with no date.
- **[CODE]:** the code does it, or a code comment asserts it with no date.
- **[NOTES] / [CODE/notes]:** a repo's own AGENTS.md or README project notes, undated.
- **[DOC]:** the scaffold `AGENTS.md` (identical managed block in every repo) says so.
- **[INFERRED]:** my reading, not visible anywhere.

Only one repo ships a backend: **cc-visicore-spl-to-kql** (`config/backend.yml`, `config/schedules.yml`, `backend/`). The other 14 app repos are frontend-only. None of the `openapi.json` copies (versions 4.18.2 to 4.19.0) contain any `/kvstore`, `/endpoints`, `backend` or `schedule` path. They list `/apps`, `/apps/{id}`, `/apps/{id}/policies|proxies|acl…` only. `cc-gigamon-ami/AGENTS.md:148-153` says the same.

---

## 0. Findings that change METER_READER_SPEC

| # | Spec claim | What the references show |
|---|---|---|
| A | "platform default is **50 per minute per App backend**" (SPEC §7, line 259) | **NOT FOUND in any repo.** The only number anywhere is "Requests are rate-limited per app (100 requests/minute)". It appears in `AGENTS.md:168`, in the **proxies.yml security notes**, which cover external egress through `/a/{appId}/proxy/…`, not Leader API calls. No repo documents a Leader-API or backend-invocation rate limit. |
| B | Backend calls `/api/v1/system/metrics/query` and other product APIs | **No shipped backend calls any Cribl product API.** spl-to-kql backends call only KV (`/api/v1/kvstore/…`) and external hosts. The only backend→product call in existence is the scaffold sample: `fetch('/api/v1/system/info')` (`backend/hello.ts:16`). Group-scoped (`/api/v1/m/<gid>/…`) calls from a backend are unverified. |
| C | "Sweep now" = UI `POST /endpoints/meter` | The UI proxy drops requests after **30 s** (`AGENTS.md:74-76`). Endpoint `timeout` can be up to 120 s (`AGENTS.md:264`). spl-to-kql declares `timeout: 120` (`cc-visicore-spl-to-kql/config/backend.yml:9,14`) and calls it from the UI with no AbortController (`cc-visicore-spl-to-kql/src/api.ts:426-442`). Nothing shows whether a UI-invoked endpoint response survives past 30 s. **Open risk:** keep the manual sweep under ~28 s, or return early and let the UI poll KV. Exec-dashboard caps at 28 s for exactly this reason (`cc-cribl-executive-dashboard/src/api/criblFetch.ts:28-29`). |
| D | Keys like `demo:state`, `secret:notify:<endpointId>:url` | **Colons are untested in every shipped app.** Every real key uses `/` separators or is a flat identifier. The only colon usage is advice text (`claude-cribl-app-plugins/.../cribl-apps-guidance.md:101`, `myapp:has_mysecret`). A **`|` in a key 404s even when percent-encoded**: two independent live measurements (see §1.5). Use `/`-separated keys. |
| E | Encrypted `secret:notify:<id>:url` "only if backend can read it back" (spike k) | spl-to-kql (backend section): "Encrypted keys (`?encrypted=true`) return **403 on read** and can only be used via `${kv.<key>}` in proxies.yml" (`cc-visicore-spl-to-kql/AGENTS.md:562-563`) [CODE/notes]. So the backend cannot read them. Also, `kv.<name>` in proxies.yml is a JS-like expression (`AGENTS.md:160-163`). A key with `:` in it would not be a valid member name there [INFERRED]. |
| F | Every-minute cron `* * * * *` | The only real schedule in any repo is daily (`'0 3 * * *'`, `cc-visicore-spl-to-kql/config/schedules.yml:5`). Minute granularity is untested. **There is no uninstall hook:** "the platform gives an app no uninstall hook. Remove the app and these … documents stay in the app-scoped store, the two saved searches stay in `/search/saved`, and the cron keeps firing" (`cc-gigamon-ami/src/cribl/accel/store.ts:24-31`, decision I-D28). That note is about Cribl Search saved-search crons. Whether backend schedules are removed on uninstall is **not visible** [UNKNOWN]. |

---

## 1. KV store

### 1.1 URLs: UI and backend are different paths to the same store

| Caller | Exact URL form | Evidence |
|---|---|---|
| UI (iframe) | `fetch(window.CRIBL_API_URL + '/kvstore/<key>')` | [DOC] `AGENTS.md:101-108`. The proxy rewrites it to `/api/v1/a/{appId}/kvstore/<key>` (`AGENTS.md:67`) |
| Backend fn | `fetch('/api/v1/kvstore/<key>')`: **relative, no `/a/<appId>/`** | [CODE] `cc-visicore-spl-to-kql/backend/lib/kv.ts:27,39,48,55,62`. Notes: "KV from inside an endpoint: relative `fetch('/api/v1/kvstore/<key>')` is app-scoped" (`cc-visicore-spl-to-kql/AGENTS.md:559`) |
| List keys (UI) | `POST CRIBL_API_URL + '/kvstore/keys'`, body `{ prefix: 'my/key/prefix' }` | [DOC] `AGENTS.md:108` |
| List keys (backend) | `POST /api/v1/kvstore/keys` | [notes] `cc-visicore-spl-to-kql/AGENTS.md:562`. No backend code calls it |

Both paths reach the **same** store:

- spl-to-kql's backend writes `knowledge/shared` and `knowledge/status` (`cc-visicore-spl-to-kql/backend/lib/kv.ts:79-86`).
- Its UI reads the same keys through the proxy (`cc-visicore-spl-to-kql/src/api.ts:408-410`).
- Its README lists them as shared keys (`cc-visicore-spl-to-kql/README.md:186`).

The backend does not need to know its appId to reach KV: scoping is implicit in the runtime's relative fetch. The mechanism is not visible [INFERRED].

Other URL-base variants in use:

- `window.CRIBL_API_URL ?? '/api/v1'` (`cc-firewall-monitor/src/config.ts:14-16`)
- sample-sanitizer strips `/api/v1` and re-adds it: `${base}/api/v1/kvstore` (`cc-sample-sanitizer/src/settings-store.ts:414-421`)

The localhost dev page (`npm run dev` outside Cribl) cannot reach KV: "That proxy rewrites `/capi` → `/api/v1` without the `/a/{appId}/` scope, and `__dev__<name>` is not a registered app, so every `/kvstore/…` call 404s" (`cc-gigamon-ami/CLAUDE.md:132-137`; `cc-gigamon-ami/src/cribl/kv.ts:36-40`). It works in the in-UI Live Preview.

### 1.2 Writes: `Content-Type: text/plain` + `JSON.stringify` (most important KV fact)

A PUT with `application/json` answers **200** and stores the literal string `[object Object]`.

| Evidence | Where |
|---|---|
| [MEASURED 2026-07-31 & 2026-09-15, Cribl.Cloud] "`application/json` → the 15-byte literal **`[object Object]`** … `text/plain` → the JSON verbatim … **The PUT answers `200` either way**" | `cc-gigamon-ami/AGENTS.md:118-140` |
| [MEASURED 2026-09-15, `__dev__` app] same result (spike K-S10) | `cc-gigamon-ami/src/cribl/kv.ts:24-29, 171-175` |
| [MEASURED, "Verified against Cloud"] "application/json → 400 / "[object Object]"; text/plain → intact". Also: the proxy "rejects non-object JSON with a 400" | `cc-cribl-executive-dashboard/src/api/kv.ts:89-100` |
| [MEASURED, "confirmed live against the real org"] same | `cc-di-data-flow-monitor/src/api/client.ts:83-97` |
| [CODE] "Sending the JSON string as application/json is rejected 400 by the strict body parser" | `cc-edge-tag-monitoring/src/api/cribl.ts:587-594` |
| [CODE] backend: "it stringifies object bodies to "[object Object]"" | `cc-visicore-spl-to-kql/backend/lib/kv.ts:33-45`; `cc-visicore-spl-to-kql/AGENTS.md:559-562` |
| [CODE] "JSON-encoding a scalar here would be rejected 400" | `cc-cribl-power-tools/src/api/kv.ts:54-65` |

The canonical backend write, verbatim from `cc-visicore-spl-to-kql/backend/lib/kv.ts:38-45`:

```ts
const res = await fetch(`/api/v1/kvstore/${key}`, {
  method: 'PUT',
  headers: { 'content-type': 'text/plain' },
  body: JSON.stringify(value),
});
```

Contradictions and edge cases:

- **cc-visicore-lookup-sync** PUTs with `contentType: 'application/json'` and reads with `resp.json()` (`cc-visicore-lookup-sync/src/api.ts:189-203`). That contradicts four repos' measurements. Whether it works cannot be determined from the code. Treat it as a latent bug [INFERRED].
- **cc-firewall-monitor** PUTs a JSON string with **no** Content-Type (`cc-firewall-monitor/src/config.ts:36-42`). This works only because a string body defaults to `text/plain;charset=UTF-8` under the Fetch spec [INFERRED].
- **Reading:** use `res.text()` then `JSON.parse`, and treat `'[object Object]'` as absent (`cc-gigamon-ami/src/cribl/kv.ts:66-68, 132-152`; `cc-visicore-spl-to-kql/backend/lib/kv.ts:8-24, 59`). spl-to-kql also unwraps a JSON string that contains JSON (double-encoded legacy values), in `parseValue` (`cc-visicore-spl-to-kql/backend/lib/kv.ts:9-24`; `cc-visicore-spl-to-kql/src/api.ts:299-318`).
- **Defensive unwrappers:** `{ value: … }` in `cc-visicore-criblvision/src/lib/prefs.ts:49-53`; `items[0]` / `{value}` / `{data}` in `cc-edge-tag-monitoring/src/api/cribl.ts:547-574`. These have **no measured basis**. The measured behaviour is a raw-text round-trip.
- **Envelope pattern:** gigamon wraps every document as `{ version: 1, updatedAt, doc }` (`cc-gigamon-ami/src/cribl/kv.ts:57-64, 169`).

### 1.3 Missing key

- **Backend:** `if (res.status === 404) return null;` (`cc-visicore-spl-to-kql/backend/lib/kv.ts:28, 56`). The UI treats 404 the same way: `cc-visicore-spl-to-kql/src/api.ts:300-301`, `cc-di-data-flow-monitor/src/api/kv.ts:15-22`, `cc-cribl-power-tools/src/api/kv.ts:45-52`, `cc-visicore-lake-credit-usage/src/api.ts:148-150`, `cc-gigamon-ami/src/cribl/kv.ts:142`.
- **UI, second failure shape** [CODE, observed]: "Inside Cribl, reading a KV key that was never written fails this way rather than with a 404: the proxy … rejects with `Failed to execute 'close' on 'ReadableStreamDefaultController': "[object Object]" is not valid JSON`" (`cc-cribl-executive-dashboard/src/api/criblFetch.ts:180-197`). Exec-dashboard resolves it by listing keys (`cc-cribl-executive-dashboard/src/api/kv.ts:40-67`). Its dev mock reproduces the rejection and keeps a `#kv404` switch "for the deployments that answer that way" (`cc-cribl-executive-dashboard/dev/mock-api.js:387-395`).
- **DELETE of an absent key:** spl-to-kql accepts 404 (`cc-visicore-spl-to-kql/backend/lib/kv.ts:47-50`). Power-tools accepts **400 or 404**: "an already-absent key can surface as 404 or 400 depending on the store" (`cc-cribl-power-tools/src/api/kv.ts:67-77`). Gigamon counts 404 as deleted (`cc-gigamon-ami/src/cribl/kv.ts:199-214`).
- **PUT response** [MEASURED, "Confirmed live"]: "Cribl's own KV store PUT returns 201 with a genuinely EMPTY body (no Content-Length, no Content-Type) — not 204. A bare `res.json()` throws on that" (`cc-di-data-flow-monitor/src/api/client.ts:58-69`). Check `res.ok`; never parse a PUT response.

### 1.4 List keys: request and response shape

Request, from `cc-visicore-lake-credit-usage/src/api.ts:173-183`:

```ts
fetch(`${API()}/kvstore/keys`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix }) })
```

The body **is** `application/json`: it is an argument, not a stored value (`cc-gigamon-ami/src/cribl/kv.ts:243-261`).

Response:

- [MEASURED 2026-09-15] "the call answers `200` with a **bare JSON array of key names** — no `{ items: [...] }` envelope" (`cc-gigamon-ami/AGENTS.md:142-162`; `cc-gigamon-ami/src/cribl/kv.ts:30-32`). Gigamon cautions this is "an observation rather than a contract", because the endpoint is absent from openapi 4.19.0.
- Every consumer parses both shapes: `Array.isArray(body) ? body : body?.items ?? body?.keys`, and accepts entries that are strings or objects with `key|name|id` (`cc-gigamon-ami/src/cribl/kv.ts:216-241`; `cc-cribl-executive-dashboard/src/api/kv.ts:16-38`; `cc-visicore-lake-credit-usage/src/api.ts:180-182`).
- **Whether names include the full prefix, or a leading `/`, is not measured.** lake-credit-usage passes the returned names straight back to `kvGet` after stripping leading slashes, `k.replace(/^\/+/, '')` (`cc-visicore-lake-credit-usage/src/api.ts:209-213`). That implies full key names, possibly with a leading `/` [INFERRED]. Exec-dashboard matches `entry === prefix/key || entry === key || entry.endsWith('/'+key)` (`cc-cribl-executive-dashboard/src/api/kv.ts:60-63`), which is defensive.

### 1.5 Key naming

- **Slashes are standard** and work as path segments:
  - spl-to-kql: `knowledge/shared`, `knowledge/status`, `splunk/connection`, `users/<id>/prefs|history|knowledge` (`cc-visicore-spl-to-kql/backend/lib/kv.ts:79-86`; `cc-visicore-spl-to-kql/src/api.ts:326,348,358`)
  - gigamon: `app/settings/<name>`, `<ns>/prefs/<userId>`, `<ns>/log/<epochMs>` (`cc-gigamon-ami/src/cribl/kv.ts:19-22`); `accel/state`, `accel/prefs/<user>`, `accel/log/<ms>` (`cc-gigamon-ami/src/cribl/accel/store.ts:33-45`)
  - lake-credit-usage: `snapshots/YYYY-MM-DD`, `cache/ingest-<n>d`, `settings` (`cc-visicore-lake-credit-usage/src/api.ts:187-231, 260`)
  - criblvision: `vision/prefs` (`cc-visicore-criblvision/src/lib/prefs.ts:20`)
  - exec-dashboard namespaces keys under `cc-cribl-executive-dashboard/<key>` (`cc-cribl-executive-dashboard/src/api/kv.ts:10-14`)
- **Encode each segment, keep the slashes:** `key.split('/').filter(Boolean).map(encodeURIComponent).join('/')` (`cc-gigamon-ami/src/cribl/kv.ts:90-97`; `cc-di-data-flow-monitor/src/api/kv.ts:7-13`).
- **The `|` character breaks routing, even percent-encoded:**
  - [MEASURED] "a KV key containing a literal `|` character — anywhere in it … 404s on Cribl's real KV store route every time … `user.id` for an Auth0-backed org is always shaped like `auth0|<hex>`" (`cc-di-data-flow-monitor/src/state/AppState.tsx:41-54`). Fix: `id.replace(/[^A-Za-z0-9_-]/g, '_')`.
  - [MEASURED 2026-09-25, Live Preview] "a PUT to `kvstore/accel/prefs/auth0%7C669a…` … answered 404" (`cc-gigamon-ami/src/cribl/user.ts:53-73`). Fix: the injective `userKeySegment` (`|` → `_7c`). Tested at `cc-gigamon-ami/src/cribl/accel/store.test.ts:255-261` and `cc-gigamon-ami/src/cribl/user.test.ts:66-70`.
  - **Rule for Meter Reader:** any user id or user-supplied string in a key must be reduced to `[A-Za-z0-9_-]`.
- **Colons:** no repo code uses them. di-data-flow sanitizes `:` pre-emptively: "a different identity provider could plausibly produce other unsafe characters, e.g. `:`" (`cc-di-data-flow-monitor/src/state/AppState.tsx:48-50`). **Untested either way.**
- **Keys read by proxies.yml injection are flat, top-level identifiers:** `splunk_token` (`cc-visicore-spl-to-kql/src/api.ts:416`), `finopsBasic` / `finopsToken` (`cc-cribl-executive-dashboard/src/api/finops.ts:29-30`, `cc-cribl-executive-dashboard/config/proxies.yml:28,39`), `packCopyToken` (`cc-cribl-power-tools/src/api/kv.ts:15-25`, `cc-cribl-power-tools/config/proxies.yml:40`). Power-tools: "Flat KV keys. These are top-level so config/proxies.yml can reference the token via `kv.packCopyToken`" (`cc-cribl-power-tools/src/api/kv.ts:15-18`).
- **Per-user state** needs the user id in the key, because the store is per app, not per user (`cc-di-data-flow-monitor/src/state/AppState.tsx:56-68`; `cc-gigamon-ami/AGENTS.md:139-140`).

### 1.6 Value size and chunking (spl-to-kql)

- [notes] "KV values are capped at ~100 KB (HTTP 413)" (`cc-visicore-spl-to-kql/AGENTS.md:564`). Also "KV values are capped at roughly 100 KB" (`cc-visicore-spl-to-kql/src/knowledge/kvpack.ts:4`) and "limited to about 100 KB" (`cc-visicore-spl-to-kql/README.md:187`). The test double throws `'413'` above `100_000` chars (`cc-visicore-spl-to-kql/tests/kvpack.test.ts:16`). No other repo states a size limit.
- **Scheme (`cc-visicore-spl-to-kql/src/knowledge/kvpack.ts`):**
  - `JSON.stringify` → pako `gzip` → base64 (`Buffer` in the backend, `btoa` in the browser; lines 34-49), split every `CHUNK_CHARS = 80_000` characters (lines 15-16, 51-57).
  - Chunk keys are `<key>/g<gen>/c<n>`. Legacy chunks are `<key>/c<n>` (line 63).
  - `<key>` holds the index `{ packed: 1, chunks, gen, bytes, updatedAt }` (lines 18-26). `gen` is `updatedAt.toString(36) + random6` (line 120).
  - **Write order:** all chunks in parallel, then an optional version check, then the index PUT, then an optional settle-and-reread, then the previous generation's chunks are dropped (lines 117-140). On failure, the new chunks are dropped.
  - **Read:** index, then every chunk in parallel. If chunks are missing and the index moved, retry up to 4 times (lines 75-89).
  - **Delete:** the index first, then the chunks (lines 142-147).
- **There is no compare-and-set:** "The KV store has no compare-and-set, so a save that switches the index after that final read can still replace this one" (`cc-visicore-spl-to-kql/src/knowledge/kvpack.ts:115-116`; `cc-visicore-spl-to-kql/AGENTS.md:515-517`). The read-modify-write retry loop, with `ATTEMPTS = 8`, `SETTLE_MS = 250` and jittered backoff, is at `cc-visicore-spl-to-kql/backend/lib/merge.ts:5-30`.
- pako is a runtime dependency, bundled into the backend by esbuild (`cc-visicore-spl-to-kql/package.json` dependencies; `backend/import-url.ts:10`).
- **Append-only logs:** gigamon writes one document per entry at `<ns>/log/<epochMs>`, nudging to the next free millisecond on collision, instead of one growing array. The reason is lost-update safety (`cc-gigamon-ami/src/cribl/kv.ts:277-303`).

### 1.7 `encrypted=true`

- **Write:** `PUT CRIBL_API_URL + '/kvstore/<key>?encrypted=true'`, `Content-Type: text/plain`, raw string body:
  - spl-to-kql: `fetch(api() + '/kvstore/splunk_token?encrypted=true', { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: token })` (`cc-visicore-spl-to-kql/src/api.ts:412-419`)
  - sample-sanitizer: `cc-sample-sanitizer/src/settings-store.ts:424-428, 782-788`
- **Read-back:** "Encrypted keys (`?encrypted=true`) return 403 on read and can only be used via `${kv.<key>}` in proxies.yml" (`cc-visicore-spl-to-kql/AGENTS.md:562-563`). UI comment: "Encrypted keys are write-only for app code" (`cc-visicore-spl-to-kql/src/api.ts:415`).
- **Injection does not require the flag.** Exec-dashboard's `kvSetSecret` and power-tools' `kvSet` store the secrets they inject **without** `?encrypted=true`. Their comments call the store "encrypted", but the calls pass no flag (`cc-cribl-executive-dashboard/src/api/kv.ts:69-86`; `cc-cribl-power-tools/src/api/kv.ts:59-65`). `kv.<name>` resolves those plain keys. Exec-dashboard lists this as an "ASSUMPTION TO VERIFY IN CLOUD" (`cc-cribl-executive-dashboard/config/proxies.yml:15-18`).
- **Guidance only, never implemented:** a sentinel key `myapp:has_mysecret` records that a secret is set (`claude-cribl-app-plugins/plugins/app-creation/skills/app-implement/references/cribl-apps-guidance.md:100-101`).
- **Injection syntax** in shipped files:
  - `"'Bearer ' + kv.finopsToken"` (`cc-cribl-executive-dashboard/config/proxies.yml:39`)
  - template form `` '`Bearer ${kv.splunk_token}`' `` (`cc-visicore-spl-to-kql/config/proxies.yml:23`; scaffold `config/proxies.yml:14`)
  - the proxy strips any `Authorization` header the app sets (`AGENTS.md:166`)

---

## 2. Backend endpoints

### 2.1 Declaration

Verbatim from `cc-visicore-spl-to-kql/config/backend.yml:3-15`:

```yaml
runtime: js
endpoints:
  - name: importUrl
    script: backend/import-url.ts
    description: …
    timeout: 120
    memory: 512
  - name: splunkSync
    script: backend/splunk-sync.ts
    description: …
    timeout: 120
    memory: 512
```

Schema, mirrored from the Leader (`node_modules/@cribl/apps/lib/build/backendManifestSchema.js:18-81`):

- `runtime` must be `'js'`.
- `endpoints` needs at least 1 item.
- `name` must match `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`.
- `timeout` is an integer, 1-120, default 30.
- `memory` is an integer MB, 1-1024, default 256.
- `description` is documentation only.
- Each built bundle is capped at `MAX_BACKEND_SCRIPT_BYTES = 5 * 1024 * 1024`.
- Duplicate names fail at build (`backendBuild.js:108-117`).

**Build** (`node_modules/@cribl/apps/lib/build/backendBuild.js:121-167`):

- esbuild runs with `bundle: true, platform: 'node', format: 'cjs', target: 'node22', sourcemap: true`. `node:*` builtins stay external.
- The bundle is `require()`d at build time to check `typeof mod.onRequest === 'function'`, so module top-level code runs during the build.
- **Packing:** `default/backend.yml` has its script paths rewritten to `.js`, and the bundles are copied to `default/backend/*.js` (`node_modules/@cribl/apps/lib/package/pkgutil.js:149-160`; `cc-visicore-spl-to-kql/scripts/prepare-git-pack.mjs:30-37`).

### 2.2 `onRequest` signature and `context`

- Scaffold: `export async function onRequest(request: Request, context: { appId: string }): Promise<Response>` (`backend/hello.ts:14`; `AGENTS.md:268-282`).
- spl-to-kql: `context: { appId: string; invocationId?: string }` (`cc-visicore-spl-to-kql/backend/import-url.ts:37`) and `context: { appId: string }` (`cc-visicore-spl-to-kql/backend/splunk-sync.ts:51`).
- **Only `appId` is ever used:** `console.log(\`[importUrl] ${context.appId} …\`)` (`cc-visicore-spl-to-kql/backend/import-url.ts:45`; `cc-visicore-spl-to-kql/backend/splunk-sync.ts:84`).
- **No repo types or reads a `userId`, caller or user identity on `context`.** Whether the backend knows who invoked it, and which identity a scheduled run executes as, is **not visible**. The SPEC's "Backend calls run with these grants; UI calls run as the member" has no evidence either way.
- **Local preview engine:** `computeEngine.invoke(install.appId, event, opts)`, where `event.endpoint` names the endpoint (`node_modules/@cribl/apps/lib/preview/preview.js:60-74`). Deploy calls `newEngine.deploy(appId, BACKEND_BUNDLE_PATH, shapes, version)` with a `LocalComputeEngine` and an `InMemoryKeyValueStore`. The Vite dev server receives both in a `deploy` message over the `/ws/compute` WebSocket (`preview.js:46-58, 79-97`). Who sends it (the Live Preview client or the Leader) is not in the code [INFERRED: the Live Preview page].

### 2.3 Request body parsing

- `const body = (await request.json().catch(() => ({}))) as { url?: string; replace?: boolean };` (`cc-visicore-spl-to-kql/backend/import-url.ts:40`)
- `const body = (await request.json().catch(() => ({}))) as { test?: boolean; scheduledFor?: string };` (`cc-visicore-spl-to-kql/backend/splunk-sync.ts:53`)
- The method is checked explicitly: `if (request.method !== 'POST') return json({...}, 405)` (`cc-visicore-spl-to-kql/backend/import-url.ts:39`).
- Unit tests call the handler directly: `onRequest(new Request('https://app.test/sync', { method: 'POST', body: '{}' }), { appId: 'test' })` with `fetch` stubbed (`cc-visicore-spl-to-kql/tests/splunk-sync.test.ts:9-31`). This is a usable test harness pattern for Meter Reader.

### 2.4 Backend → Cribl API and → external hosts

- **Cribl API:** relative `/api/v1/...`, as in `fetch('/api/v1/system/info')` (`backend/hello.ts:16`). "Inside a handler, `fetch()` reaches the Cribl API with relative paths" (`AGENTS.md:290`). Permissions come from `config/policies.yml`, app-wide for the frontend and every endpoint (`AGENTS.md:292`; `config/backend.yml:7-8`). **No shipped backend exercises this** (Finding B).
- **External:** absolute URL; the host must be in `config/proxies.yml`:
  - `fetch(target, { redirect: 'follow' })` (`cc-visicore-spl-to-kql/backend/import-url.ts:46`)
  - Undeclared host → HTTP 403. "`github.com` and `raw.githubusercontent.com` fail with "private broker request failed" even when declared; `codeload.github.com` works … Redirects are not followed across hosts" (`cc-visicore-spl-to-kql/AGENTS.md:567-570`)
  - Proxy `timeout` is set per host, up to 120000 ms (`cc-visicore-spl-to-kql/config/proxies.yml:6-13`; `AGENTS.md:133`)
- **Runtime globals:** `Buffer` is available. `kvpack.ts` uses `globalThis.Buffer` when present (`cc-visicore-spl-to-kql/src/knowledge/kvpack.ts:34-49`). `setTimeout` is used in the backend (`cc-visicore-spl-to-kql/backend/lib/merge.ts:27`). `tsconfig.backend.json` says the "fused runtime" is "not Node and not the browser bundle" and supplies `fetch`/`Request`/`Response` via lib DOM (`tsconfig.backend.json:5-9`).

### 2.5 How the UI invokes an endpoint

`cc-visicore-spl-to-kql/src/api.ts:426-427`:

```ts
const resp = await fetch(`${api()}/endpoints/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
```

- The documented target is `/api/v1/a/{yourAppId}/endpoints/{name}` (`AGENTS.md:290`; `cc-visicore-spl-to-kql/README.md:159`: `POST /api/v1/a/cc-visicore-spl-to-kql/endpoints/<name>`; `cc-visicore-spl-to-kql/AGENTS.md:554`).
- **[INFERRED]** The proxy rewrites `CRIBL_API_URL + '/endpoints/…'` to `/a/{appId}/endpoints/…`. The rewrite table (`AGENTS.md:61-72`) lists only `/kvstore` and `/proxy`, and says standard calls are "passed through as-is" (`AGENTS.md:70`). The policies section says `/api/v1/system/lookups` **is** rewritten to `/api/v1/a/{yourAppId}/system/lookups` (`AGENTS.md:250`). The guide contradicts itself. spl-to-kql's working code is the evidence that the `/endpoints/` form works.
- **Status and schedule inspection:** `GET /api/v1/apps/<appId>/backend/status|endpoints`; schedules at `GET /api/v1/a/<appId>/backend-schedules` (`cc-visicore-spl-to-kql/AGENTS.md:555-556`). None of these is in any openapi.json.
- **Live Preview:** "Deploy from Live Preview installs BOTH `__dev__` and the real app id. Invoking `__dev__` endpoints through the REST API times out (its backend runs in the local ws engine); test against the real app" (`cc-visicore-spl-to-kql/AGENTS.md:557-558`). "In Live Preview, click Deploy first so the backend endpoints exist" (`cc-visicore-spl-to-kql/src/api.ts:437-438`; `cc-visicore-spl-to-kql/README.md:207-211`). spl-to-kql says it needs "Cribl 4.20 or later" (`cc-visicore-spl-to-kql/README.md:40,152`).

### 2.6 Response wrapping and errors

- **Convention (spl-to-kql, not platform-mandated):** JSON `{ ok: true, ... }` or `{ ok: false, error }`. Helpers: `json(body, status=200)` → `new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })`; `errorResponse(e, 500)` logs and wraps (`cc-visicore-spl-to-kql/backend/lib/kv.ts:68-76`).
- **Platform gateway statuses:** "The platform answers 502/503/504 itself when the app's backend is not running" (`cc-visicore-spl-to-kql/src/api.ts:437`). So app-level failures deliberately use **422**, not 502, "which the UI treats as "backend did not answer"" (`cc-visicore-spl-to-kql/AGENTS.md:513-514`; `cc-visicore-spl-to-kql/backend/splunk-sync.ts:80`).
- **UI parse:** read `resp.text()`, `JSON.parse`, then fail if `!resp.ok || data.ok === false` (`cc-visicore-spl-to-kql/src/api.ts:428-441`).

### 2.7 Timeouts and memory actually used

- spl-to-kql uses `timeout: 120`, `memory: 512` on both endpoints (`cc-visicore-spl-to-kql/config/backend.yml:9-10,14-15`).
- UI proxied requests time out after 30 s (`AGENTS.md:74-76`); exec-dashboard uses `REQUEST_TIMEOUT_MS = 28_000` (`cc-cribl-executive-dashboard/src/api/criblFetch.ts:28-29`).
- **Unresolved:** a UI-invoked endpoint that runs longer than 30 s (Finding C).

### 2.8 Logging

- **Backends use `console.*` only:**
  - `console.log(\`[importUrl] ${context.appId} fetching ${target}\`)` (`cc-visicore-spl-to-kql/backend/import-url.ts:45`)
  - `console.log(\`[splunkSync] … [scheduled]\`)` and `console.warn(...)` (`cc-visicore-spl-to-kql/backend/splunk-sync.ts:84,106`)
  - `console.error('endpoint error:', message)` (`cc-visicore-spl-to-kql/backend/lib/kv.ts:74`)
- **`@cribl/logger`:** no repo imports it. The only mention is the preview shim `'@cribl/logger': { getLogger: () => ({ info: noop, warn: noop, debug: noop, error: console.error, isDebug: () => false }) }` (`node_modules/@cribl/apps/lib/preview/preview.js:15-25`). It sits in the `require` of modules loaded from the Leader-shipped engine bundle. No evidence shows the app runtime exposes it to app bundles, and esbuild would try to bundle it from node_modules [INFERRED].
- **Where backend logs surface on the platform: UNKNOWN.** spl-to-kql's README says only that endpoints and their schedules are "visible … under the app's Settings > Backend Functions" (`cc-visicore-spl-to-kql/README.md:159`).
- **Frontend:** `console.debug('[lake-credit-usage]', ...)` (`cc-visicore-lake-credit-usage/src/api.ts:144-146`). Gigamon warns once per session (`cc-gigamon-ami/src/cribl/kv.ts:73-84`).

---

## 3. Schedules (`config/schedules.yml`)

The only real schedule in any repo, verbatim from `cc-visicore-spl-to-kql/config/schedules.yml:1-6`:

```yaml
# Scheduled backend runs (platform Schedule API). Top-level keys are schedule ids.
# The nightly sync is a no-op until a Splunk connection is saved in the app.
splunk-sync-nightly:
  endpoint: splunkSync
  cronSchedule: '0 3 * * *'
  bodyExpression: '{ scheduleId, scheduledFor }'
```

- **Contract [DOC]:**
  - Top-level key = schedule id, with no nested `id:`. Fields: `endpoint`, `cronSchedule` (five-field UTC cron), optional `bodyExpression` (a JS expression evaluated at fire time; its result is POSTed as the body).
  - At most 10 per app. No `onSchedule` handler, and no `schedule:` field in backend.yml (`AGENTS.md:296-324`; `config/schedules.yml:1-15`).
  - The packer copies `config/schedules.yml` to `default/schedules.yml` (`node_modules/@cribl/apps/lib/package/pkgutil.js:124,146-148`). The installed copy lives at `default/<appId>/schedules.yml` on the Leader (`AGENTS.md:303-306`).
  - In `npm run dev`, a change to `config/schedules.yml` triggers a live reload (`vite.config.ts:20`; `AGENTS.md:252`).
- **Handling `scheduledFor` [CODE]:** the same `onRequest` serves both paths; its presence marks a scheduled run.
  - `if (body.scheduledFor) return json({ ok: true, skipped: 'no Splunk connection configured' });` (`cc-visicore-spl-to-kql/backend/splunk-sync.ts:55-57`)
  - `if (conn.enabled === false && body.scheduledFor) return json({ ok: true, skipped: 'connection disabled' });` (`cc-visicore-spl-to-kql/backend/splunk-sync.ts:59`)
  - A scheduled run with nothing to do returns **200 `{ok:true, skipped}`**, not an error. Header comment: "Scheduled runs (config/schedules.yml) hit this same handler with a body containing `scheduledFor`" (`cc-visicore-spl-to-kql/backend/splunk-sync.ts:11-12`).
- **Unknown values:**
  - `scheduledFor` is typed as `string` (`cc-visicore-spl-to-kql/backend/splunk-sync.ts:53`). Its actual format (ISO string or epoch) and `scheduleId`'s value never appear in any repo.
  - No repo uses a `bodyExpression` with extra literals, such as the SPEC's `{ scheduleId, scheduledFor, mode: "scheduled" }`. That is plausible as JS, but unverified.
  - No repo uses sub-hourly backend cron (Finding F).
  - Overlapping runs (a run longer than its interval) and missed-run catch-up are not addressed anywhere.
- **Different mechanism, same app:** gigamon's "accel" schedules are **Cribl Search saved-search** crons (e.g. `51 * * * *` for `gno_web_trend_c1h`, `cc-gigamon-ami/src/cribl/accel/provision.test.ts:926`), not backend schedules. They bill Search compute and outlive uninstall (`cc-gigamon-ami/src/cribl/accel/store.ts:24-31`; `cc-gigamon-ami/CLAUDE.md:317`).

---

## 4. 429 and rate limits

- **Documented limit:** "Requests are rate-limited per app (100 requests/minute)". It appears only under proxies.yml security notes, meaning external egress (`AGENTS.md:168`; identical in every repo's AGENTS.md). **No Leader-API, KV or backend-invocation limit is stated anywhere, and the SPEC's "50/min per App backend" was not found** (Finding A).
- **The only 429 handling in app code:** gigamon's Search client, verbatim from `cc-gigamon-ami/src/cribl/search.ts:61-81`:

  ```ts
  /** Fetch with retry on 429 / 5xx (Cribl search queue back-pressure). */
  async function fetchRetry(url, init, signal, tries = 4) {
    ... if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
          if (attempt < tries - 1) { await wait(300 * Math.pow(2, attempt) + Math.random() * 200); continue }
  ```

  The non-Search transport (`capi.ts`) deliberately does **not** retry: "retry-on-429, cancellation and abort semantics are the product there, and bolting them onto a provisioning call would retry writes" (`cc-gigamon-ami/CLAUDE.md:210`).
- **Measured Search throttle:** "every job is a place in the per-user admission queue (~1.6 s apart)" (`cc-gigamon-ami/CLAUDE.md:49`). A tab that fires 6 jobs on mount starts its sixth after ~8 s (`cc-gigamon-ami/CLAUDE.md:211`).
- **Client-side concurrency caps:** `mapWithConcurrency(items, limit, fn)` with `GROUP_CONCURRENCY = 5`, or 6 for dataset ACL reads (`cc-cribl-power-tools/src/lib/concurrency.ts:1-23`; `cc-cribl-power-tools/src/workflows/FunctionFinder.tsx:22,98`; `cc-cribl-power-tools/src/workflows/SearchBulkEdit.tsx:258,384`). In-flight dedupe plus a 30-minute KV cache of an expensive search: `cc-visicore-lake-credit-usage/src/api.ts:243-285`.
- **Partial failure per group:** `Promise.allSettled` over groups, collecting errors instead of throwing (`cc-cribl-executive-dashboard/src/api/criblFetch.ts:199-220`).
- **No KV call or endpoint invocation in any repo handles 429.** `Retry-After: 30` in the `scripts/pkgutil.mjs` copies (e.g. `cc-firewall-monitor/scripts/pkgutil.mjs:209`) belongs to the local dev package server, not the platform.
- **SDK (not in-app):** `cribl-control-plane-sdk-typescript/examples/auth.ts:130-134` retries a 429 up to 10 times with a 1 s sleep on token fetch. Its changelog template shows a placeholder, "Rate limit is now 60 requests per minute instead of 100" (`cribl-control-plane-sdk-typescript/.github/changelog-template.md:67`). **That is template text, not a real limit.**
- **Advice only:** "Implement retry logic with exponential backoff; Respect rate limits (check headers, honor X-RateLimit-Reset)" (`claude-cribl-app-plugins/plugins/app-creation/skills/app-implement/references/cribl-apps-guidance.md:112-119`). No repo reads `X-RateLimit-*` headers.

---

## 5. Environment, demo and build-flag detection

| Pattern | Code | Where |
|---|---|---|
| "Inside Cribl" = `CRIBL_API_URL` set | `typeof window.CRIBL_API_URL === 'string' && window.CRIBL_API_URL.length > 0` | `cc-visicore-spl-to-kql/src/api.ts:13-16`; `cc-gigamon-ami/src/cribl/config.ts:30-32` (`IS_INSTALLED`) |
| Demo = no API | `export const IS_DEMO = !API_URL;` → fixtures from `${import.meta.env.BASE_URL}fixtures.json`, "DEMO DATA" badge | `cc-visicore-criblvision/src/api/client.ts:44-47,142`; `cc-visicore-criblvision/src/components/Layout.tsx:120,133`. Prefs fall back to localStorage in demo only: `cc-visicore-criblvision/src/lib/prefs.ts:1-4,43-44` |
| Dev server | `export const IS_DEV_SERVER = import.meta.env?.DEV === true` ("True … the localhost page AND Cribl's Live Preview") | `cc-gigamon-ami/src/cribl/config.ts:34-41` |
| Three-way run mode incl. backend | `if (typeof window === 'undefined') return 'backend'; … CRIBL_API_URL ? 'iframe' : 'standalone'` | `cc-sample-sanitizer/src/run-mode.ts:14-21` ("'backend' … a Cribl Backend Function's Node runtime — no `window` at all") |
| Dev app id | the vite plugin injects `window.CRIBL_APP_ID = '__dev__${appName}'` (scaffold; same in all repos) | `vite.config.ts:60-64`; type `CRIBL_APP_ID?: string` ("Dev-only app id") at `cc-visicore-spl-to-kql/src/global.d.ts:9-10` |
| Build-time constants | `define: { BUILD_NUMBER: …, APP_VERSION: … }` | `cc-sample-sanitizer/vite.config.ts:92-95`; `__APP_VERSION__` in `cc-gigamon-ami/src/cribl/config.ts:49-51` |
| Build-time env | `VITE_*` via `import.meta.env` (`VITE_GOLDEN_REPO`, `VITE_SHARE_GOLDENS === 'true'`, `VITE_REQUIRE_SANITISED_SAMPLES`) | `cc-sample-sanitizer/src/vite-env.d.ts:7-10`; `cc-sample-sanitizer/src/settings-store.ts:581-611` |
| Backend | no env or flag mechanism visible. A build flag (e.g. the SPEC's `VITE_MR_BUILD`) would have to be compiled into the esbuild bundle. `apps build` passes no `define` (`node_modules/@cribl/apps/lib/build/backendBuild.js:135-145`) | [INFERRED] a demo/release distinction in the backend must come from separate `backend.yml` endpoint sets, from KV, or from a code-generated constant file, not from `process.env` |

The scaffold vite config's `injectScriptFromQueryPlugin` also takes the `?init=` script the Cribl UI passes to Live Preview and injects it (`vite.config.ts:34-83`). Gigamon documents per-origin handling of it (`cc-gigamon-ami/CLAUDE.md:127`).

---

## Adjacent, decision-relevant (outside the five topics)

- **Cribl.Cloud FinOps billing** is reachable from an app. Exec-dashboard exchanges a Billing-Reader API credential at `https://login.cribl.cloud/oauth/token` (`{ grant_type: 'client_credentials', audience: 'https://api.cribl.cloud' }`), then reads `https://gateway.cribl.cloud/v1/organizations/{orgId}/…`, with headers injected from KV (`cc-cribl-executive-dashboard/src/api/finops.ts:20-30,81,111`; `cc-cribl-executive-dashboard/config/proxies.yml:20-40`).
- **proxies.yml host keys are exact:** "wildcard/subdomain keys such as `*.cribl.cloud` … are NOT honored". Admins can add hosts after install under App Settings → External API Access (`cc-cribl-power-tools/config/proxies.yml:14-18`; `cc-visicore-spl-to-kql/AGENTS.md:573-574`).
