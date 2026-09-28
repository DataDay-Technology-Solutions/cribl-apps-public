# Config commit, deploy and commit history

Research notes for Meter Reader. Topic: change a pipeline in a worker group, commit it, deploy it on Cribl.Cloud, and list commit history per group with author, message, timestamp and changed files.

## Evidence labels

- **SEEN**: read in code or docs, with a `repo/path:line` citation. Reference repos are under `scratchpad/ref/`, at these HEADs: cc-visicore-lookup-sync `b3a0a10`, cc-gigamon-ami `f525e9c`, cc-cribl-power-tools `4606eef`, cc-edge-tag-monitoring `c43c384`, cc-visicore-criblvision `8aadf96`, cc-config-inspector `8445f39`, cribl-control-plane-sdk-typescript `0234e9d`.
- **SPEC**: this project's own `openapi.json` (`info.version` = `4.20.1-590ec085`), cited as `openapi.json:<line>`.
- **MEASURED**: live GET requests on 2026-09-25 against the project's dev Cribl.Cloud Leader (`/system/info` BUILD.VERSION `4.20.1-590ec085`, distMode `master`), made from the signed-in admin's browser session. Only GETs were sent. No commit, deploy, PATCH or other write was made.
- **UI-BUNDLE**: read-only inspection of the Leader UI's own JavaScript (`main.8b67f610.js`, served by that Leader). This shows how Cribl's own UI calls these APIs and how it spells their RBAC `object`s.
- **INFERRED** / **UNVERIFIED**: my conclusions, and questions that no source or measurement answers.

AGENTS.md (the authority) says only this on the topic: endpoints outside `/system/` are contextual and take the `/m/:groupId` prefix (AGENTS.md:112). Search always runs in `default_search` (AGENTS.md:114). Each prefix is a separate policy `object` (AGENTS.md:228). A collection path does not cover its children (AGENTS.md:248). PUT/PATCH/POST calls that overwrite configuration need an explicit user confirmation that names the object, and must never fire automatically (AGENTS.md:80-89).

---

## 1. Summary: how to make a pipeline change live (group `default`)

| # | Call | Body | What to read back |
|---|---|---|---|
| 1 | `GET /m/default/pipelines/<id>` | none | `items[0]` = `{ id, conf }`. MEASURED: `{"items":[{"id":"passthru","conf":{"functions":[]}}],"count":1}` |
| 2 | `PATCH /m/default/pipelines/<id>` | the **complete** `{ id, conf }`. Partial updates are not supported: "Cribl removes any omitted fields" (SPEC openapi.json:170617, `updatePipelinesById`) | `CountedPipeline` |
| 3 | `GET /m/default/version/status` | none | `items[0].files[].path`. MEASURED: repo-root-relative (`groups/default/...`) and scoped to the group |
| 4 | `POST /m/default/version/commit` | `{ "message": "...", "files": ["groups/default/local/cribl/pipelines/<id>/conf.yml"] }`. Cribl's own UI also sends `"effective": true` when committing in a group (UI-BUNDLE) | `items[0].commit` = full 40-char SHA-1 (SPEC `GitCommitSummary`, openapi.json:109631) |
| 5 | `PATCH /products/stream/groups/default/deploy` | `{ "version": "<items[0].commit>" }` | `CountedConfigGroup`, whose `items[0].configVersion` is the deployed hash |
| 5b | `PATCH /master/groups/default/deploy` | same | Deprecated. Use it **only on a 404** from 5 (cc-gigamon-ami/src/cribl/provision.ts:922-930) |

For a UI call the base is `window.CRIBL_API_URL`. For a backend call it is the relative `/api/v1` (AGENTS.md:275, 290).

Each shipped app uses a slightly different version of steps 3 to 5:

| App | Commit call | Body | Deploy call | Deploys which hash |
|---|---|---|---|---|
| cc-visicore-lookup-sync | `POST /m/${group}/version/commit` (src/api.ts:166-174) | `{ message, files }`, where files come from `/m/${group}/version/status` (src/api.ts:154-158) | `PATCH /master/groups/${group}/deploy` (src/api.ts:176-185) | the value of `GET /master/groups/${group}/configVersion` → `items[0]` (see §6, discrepancy 7) |
| cc-cribl-power-tools | `POST /m/${gid}/version/commit` (src/api/destinations.ts:80-91) | `{ message }` only (no files) | `PATCH /master/groups/${gid}/deploy` (src/api/destinations.ts:94-104) | the commit response `items[0].commit` (src/workflows/PipelineAssign.tsx:271-285) |
| cc-edge-tag-monitoring | `POST /m/${fleet}/version/commit` (src/api/cribl.ts:288-296) | `{ message }` only | `PATCH /master/groups/${fleet}/deploy` (src/api/cribl.ts:299-301) | the commit response. It throws if `items[0].commit` is missing (src/api/cribl.ts:293-294) |
| cc-gigamon-ami | `POST /version/commit`, **Leader-level with no `/m`** (src/cribl/provision.ts:1382; src/cribl/lakeLanding.ts:1231) | `{ message, files }`, with files always explicit (provision.ts:1342-1348) | `PATCH /products/stream/groups/${group}/deploy`, falling back to `/master/...` on 404 (provision.ts:922-930; lakeLanding.ts:1262-1266) | the commit response, `body.items[0].commit` or `body.commit` (provision.ts:1388-1389) |
| SDK examples | ``versions.commits.create({ message, effective: true, files: ["."] }, { serverURL: `${baseUrl}/m/${groupId}` })`` (examples/example-stream.ts:97, 142-146) | `{message, effective, files}` | `groups.deploy({ product: "stream", id, deployRequest: { version } })` → `PATCH /products/{product}/groups/{id}/deploy` (examples/example-stream.ts:150-154; src/funcs/groupsDeploy.ts:105, 142) | the commit response |
| Cribl UI itself | `POST ${A(group)}/commit`, where `A(group)` is `"/m/" + group + "/version"` when a group is given, else `"/version"` (UI-BUNDLE: ``function A(e){return`${e?`/m/${e}`:""}/version`}``) | `{ message, files }`, plus `effective: true` only when a group is given | `PATCH /products/:product/groups/${id}/deploy` | body `{ version, lookups }` (UI-BUNDLE) |

**Recommendation (INFERRED):** follow the UI's own pattern. Commit in group context (`/m/<gid>/version/commit`) with an explicit `files` list read from `/m/<gid>/version/status`. Deploy the `commit` hash that the commit call returned to `/products/stream/groups/<gid>/deploy`.

---

## 2. Changing the pipeline

- Path: `/m/:gid/pipelines/:id`, with GET, PATCH and DELETE (SPEC path `/pipelines/{id}`, openapi.json:170617. The group context comes from the prefix, AGENTS.md:112). In the SDK this is `pipelines.update({ id, pipeline })` → `pathToFunc("/pipelines/{id}")` (src/funcs/pipelinesUpdate.ts:100), with the group via `serverURL` (examples/example-stream.ts:97, 125).
- Body schema `Pipeline`: required `id` and `conf`. `conf` has `additionalProperties: false`, and its fields are `asyncFuncTimeout`, `output`, `description`, `streamtags`, `functions[]` (`PipelineFunctionConf`: `id`, `filter`, `disabled`, `conf`, `description`, …) and `groups` (SPEC `Pipeline` schema).
- Shipped pattern: GET, then PATCH if the pipeline exists, else POST to `/m/${fleet}/pipelines` (cc-edge-tag-monitoring/src/api/cribl.ts:321-341).
- The git file a pipeline edit dirties is `groups/<gid>/local/cribl/pipelines/<pipelineId>/conf.yml`. Sources: the SPEC commit example `groups/default/local/cribl/pipelines/http_input/conf.yml` (example `VersionCommitExamplesCommitSpecificFiles`) and cc-gigamon-ami/src/cribl/provision.ts:479, 489. INFERRED for Meter Reader's `mrd_*` pipelines: confirm by reading `/m/default/version/status` after the PATCH. gigamon matches by a layout-independent marker `local/cribl/pipelines/<id>/` (provision.ts:532-541).
- The demo lever that disables a function (`demoBreakTrim`) is a full-object PATCH. It must go through the confirmation rule in AGENTS.md:80-89.

---

## 3. Commit: `POST /version/commit` or `POST /m/:gid/version/commit`

**Request `GitCommitBody`** (SPEC openapi.json:113434):

```json
{ "message": "string (required)",
  "files": ["path relative to the configuration root", "..."],
  "effective": true }
```

- `files`: "If omitted, all pending changes are committed" (SPEC). cc-gigamon-ami reads this as repo-wide and always passes files (config/policies.yml:523-528; provision.ts:1344-1347). cc-visicore-lookup-sync also always passes files (src/api.ts:160-165). power-tools and edge-tag omit files in group context.
- `effective`: "If `true`, apply the commit to the group's effective configuration. Requires a group context" (SPEC). Without a group it returns 400 `{"status":"error","message":"\"effective\" param must be used with \"group\""}` (SPEC example `VersionCommitBadRequestExamplesEffectiveWithoutGroup`, openapi.json:151976). The Cribl UI sends `effective: true` whenever it commits with a group (UI-BUNDLE: ``gitCommit(e,t,n){const i={message:e,files:n};return t&&(i.effective=!0),r(`${A(t)}/commit`,i)}``).
- **The body has no `group` field.** `GitCommitBody` has only `message`, `files` and `effective` (SPEC). Every source puts the group in the `/m/<gid>` path prefix instead: the UI bundle, the SDK's `serverURL`, and lookup-sync, power-tools and edge-tag. INFERRED: "must be used with \"group\"" in the 400 message refers to that path context, not to a body key. Do not send `{ group: ... }` in the body. No shipped Community app sends it. Its exact semantics are **UNVERIFIED**.
- SPEC example of a scoped commit: `{"message":"Update Route and Pipeline for HTTP Sources","effective":true,"files":["groups/default/local/cribl/pipelines/http_input/conf.yml","groups/default/local/cribl/routes.yml"]}`.

**Response `CountedGitCommitSummary`** (SPEC openapi.json:109631):

```json
{ "count": 1,
  "items": [{
    "author":  { "email": "admin@example.com", "name": "Admin User" },
    "branch":  "main",
    "commit":  "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    "files":   { "created": [], "modified": ["groups/default/local/cribl/pipelines/http_input/conf.yml"], "deleted": [], "renamed": [] },
    "summary": { "changes": 1, "insertions": 5, "deletions": 2 } }] }
```

- The hash field is **`items[0].commit`** (full SHA-1). Every app reads that field: lookup-sync src/api.ts:172, power-tools src/api/destinations.ts:90, edge-tag src/api/cribl.ts:293, gigamon provision.ts:1389 (which also accepts a top-level `commit`).
- "Nothing to commit" shows up as `items: [{}]`, an item with no `commit`. gigamon's test stub encodes this (src/cribl/provision.test.ts:281), and gigamon reports it as "nothing to commit" (provision.ts:1390-1397). power-tools returns `undefined` and skips the deploy (PipelineAssign.tsx:278-286).
- Measured branch name on the Cloud Leader: **`master`**. The SPEC examples say `main`.
- gigamon's safety check (SEEN, provision.ts:1398-1418): after committing, it re-reads `/version/status`. If any of the run's files are still pending, it refuses to deploy.
- Commits take whole files. Anybody else's uncommitted edits in a named file are carried along (cc-gigamon-ami/src/cribl/landing.ts:1322).

---

## 4. Deploy: `PATCH /products/{product}/groups/{id}/deploy`

- Current path: `PATCH /products/{product}/groups/{id}/deploy`, where `product` ∈ `stream | edge | outpost` (`ProductsCore`) (SPEC openapi.json:201600).
- Deprecated path: `PATCH /master/groups/{id}/deploy` (SPEC openapi.json:200834, `deprecated: true`). It is still used by lookup-sync, power-tools and edge-tag.
- **Request `DeployRequest`** (SPEC openapi.json:85393): `{ "version": "<commit hash>" (required), "lookups"?: [{ "context": "cribl" | <packId>, "lookups": [{ "file", "version" }] }] }`. The Cribl UI sends `{version, lookups}` (UI-BUNDLE).
- **Response:** `CountedConfigGroup`, i.e. `{count:1, items:[{ id, name, cloud, type, onPrem, provisioned, configVersion, workerCount, incompatibleWorkerCount, deployingWorkerCount, lookupDeployments, ... }]}` (SPEC example `GroupDeployResponseExamplesWorkerGroup`).
- A deploy **moves the group to that commit**. Every commit between the group's current `configVersion` and the given hash goes live with it (cc-gigamon-ami/src/cribl/landing.ts:1323; provision.ts:1317-1324).
- A deploy **restarts the group's Worker Processes** (cc-gigamon-ami/config/policies.yml:263-266; landing.ts:1321).
- Fallback rule (SEEN, provision.ts:907-930): try `/products/stream/...` first and fall back to `/master/...` **only on 404**. Do not fall back on 403, because a second path cannot grant permission. Do not fall back on 5xx, because the deploy may already have started.
- **No deploy-history API exists.** criblvision says so explicitly (src/pages/CommitAuditLog.tsx:61-63). MEASURED: neither `/master/workers` items (`info.cribl` has no config version or deploy time) nor the group record carries a deploy timestamp. So `deployedAt` can only be recorded by Meter Reader itself, at the moment its own deploy call returns. This matches the fallback in METER_READER_SPEC.md:345.

---

## 5. Commit history per group

### 5.1 Endpoints

| Purpose | Call | Params | Response fields |
|---|---|---|---|
| **History for one group** | `GET /m/<gid>/version` | `count`, `offset`, `limit` | MEASURED: returns only commits that touch the group (`/m/default/version` → 1 item vs `/version` → 4) |
| Leader-wide history | `GET /version` | same | `PaginatedGitLogResult` (SPEC openapi.json:113519) |
| Files changed in one commit | `GET /m/<gid>/version/files?commit=<hash>` or `/version/files?commit=` | `commit` | `CountedGitFilesResponse` → `items[0] = { count, items: GitFile[], commitMessage }` |
| Diff and full message of one commit | `GET /m/<gid>/version/show?commit=<hash>&diffLineLimit=<n>&filename=` | `commit`, `diffLineLimit` (default 1000, 0 = all), `filename` | `items[0] = { commitMessage, diffJson[] }` |
| Pending (uncommitted) files | `GET /m/<gid>/version/status` | none | `GitStatusResult` |
| Latest commit and recent log with the group record | `GET /products/stream/groups/<gid>?fields=git.commit,git.localChanges,git.log`, or `GET /master/groups?fields=...` for every group | `fields` | `git: { commit, localChanges, log[] }` (SPEC ConfigGroup `git`, openapi.json:85108; `fields` param openapi.json:201491) |

SDK names: `Versions.Commits.list` → `GET /version` with query `count, limit, offset` (src/funcs/versionsCommitsList.ts:105-111). `Versions.Commits.Files.list` → `GET /version/files?commit=` (src/funcs/versionsCommitsFilesList.ts:94-98). `Versions.Commits.get` → `GET /version/show?commit=&diffLineLimit=&filename=` (src/funcs/versionsCommitsGet.ts:94-100). `Versions.Statuses.get` → `GET /version/status` (src/funcs/versionsStatusesGet.ts:76). None of them takes a group argument. The group comes from `serverURL = <base>/m/<gid>`, as in the examples (examples/example-stream.ts:97).

### 5.2 `GitLogResult` (one history row)

SPEC openapi.json:113551: `hash` (full), `date`, `message` (subject line), `body` (rest of the message), `author_name`, `author_email`, `refs`. `PaginatedGitLogResult` adds `count`, and `offset`, `limit` and `totalCount` "when offset/limit are provided".

MEASURED `GET /version` on the Cloud Leader:

```
9aad357… | 2026-09-24 00:10:18 +0000 | refs="HEAD -> master" | Cribl System | create group default_outpost
ede0c7b… | 2026-09-24 00:10:04 +0000 | refs=""               | Cribl System | create group default_fleet
bbef631… | 2026-09-24 00:09:51 +0000 | refs=""               | Cribl System | create group default
96a9674… | 2026-09-24 00:09:32 +0000 | refs=""               | Cribl System | Initial commit.
```

- Order: newest first (MEASURED). HEAD is the row whose `refs` contains `HEAD -> <branch>`. gigamon keys HEAD off that regex rather than the ordering (provision.ts:1005-1016).
- `date` format: **`"2026-09-24 00:09:51 +0000"`**. There is a space instead of `T`, and the offset has no colon, so it is not strict ISO 8601 even though the SPEC says it is. Chrome's `Date.parse` accepts it (MEASURED → `1790208591000`). criblvision uses `Date.parse` (src/api/client.ts:1454-1457). INFERRED: to be safe in the backend runtime, normalize it yourself: replace the first space with `T` and `+0000` with `+00:00`.
- Author: system commits are `author_name: "Cribl System"`, `author_email: "cribl@<leader-host>"` (MEASURED). **UNVERIFIED:** the author of a commit made through the app proxy. INFERRED to be the calling user, because the proxy injects the user's auth (AGENTS.md:51-53). METER_READER_SPEC.md:343 already plans to record the caller's username itself.
- criblvision maps rows as `hash`, `author_name`, `author_email`, `date`, `message`, `body` (src/api/client.ts:1514-1525) and fetches `GET /version?count=300` (client.ts:1516; CommitAuditLog.tsx:9). The SPEC says `/version` has no time-range parameter. criblvision filters by time on the client (CommitAuditLog.tsx:63-65, 79-85).

**Paging (MEASURED, 4.20.1):**
- `GET /version?limit=2` → **400** `missing 'offset' parameter, 'offset' is required when 'limit' is provided`. gigamon hit the same error (provision.ts:986-990; provision.test.ts:261-266).
- `GET /version?offset=0&limit=2` → keys `items, count, offset, limit, totalCount` (`totalCount` 4).
- `GET /version?count=2` → keys `items, count`, with 2 items.
- `GET /m/default/version?offset=0&limit=50` → the same paged keys, `count` 1.

### 5.3 Per-group scoping (MEASURED)

| Request | Result |
|---|---|
| `GET /version` | 4 commits, one per group creation, across the whole Leader repo |
| `GET /m/default/version` | 1 commit (`bbef631 create group default`) |
| `GET /master/groups?fields=git.commit,git.localChanges,git.log` | each group's `git.log` holds only its own commits: default → `bbef631`, default_fleet → `ede0c7b`, default_search → `96a9674 Initial commit.`, default_outpost → `9aad357`. `git.commit` is the 7-char short hash (`"bbef631"`). `localChanges` is 4 / 2 / 386 / 2 |
| `GET /version/status` | 399 files across every `groups/<gid>/…` plus the Leader's own root `local/cribl/auth/users.json` |
| `GET /m/default/version/status` | 4 files, all `groups/default/…` |
| `GET /m/default/version/files?commit=9aad357` (a commit that touched only `default_outpost`) | `count: 0`, no files, although `commitMessage` is still returned |
| `GET /m/default/version/show?commit=9aad357` | `{"items":[{"commitMessage":"","diffJson":[]}],"count":1}` |
| `GET /version/count` vs `/m/default/version/count` | 399 vs 4 |

The scoping means the `/m/<gid>/version*` family is the native per-group history. Without it, a Leader-level client has to walk `/version/files` for each commit and match `groups/<gid>/` itself, which is what gigamon does (provision.ts:1208-1239; `pathInGroup` at 557-560).

`git.log` from `?fields=git.log` rows have the GitLogResult shape (`hash, date, message, refs, body, author_name, author_email`, MEASURED). They do **not** have the `short` field that the SPEC `Commit` schema marks as required (openapi.json:84989). **UNVERIFIED:** how many rows `git.log` returns. Every group in this org has only one commit.

### 5.4 Changed files: `/version/files`

`GitFile` (SPEC openapi.json:110003): `name`, `state` (`M` | `A` | `D`), `children[]` (a recursive tree), `autoIncludedInCommit`.

MEASURED `GET /version/files?commit=bbef631` → `{ "items": [{ "count": 1, "items": [<tree>], "commitMessage": "create group default" }], "count": 1 }`. The tree uses one node per path segment: `{"name":"groups","children":[{"name":"default","children":[{"name":"data","children":[{"name":"lookups","children":[{"name":"model_relative_entropy_top_domains.csv","state":"A"}, ...`. Flattened, that is 383 paths, all `groups/default/...`. gigamon hit the same nested tree on a 4.20.x Cloud Leader (provision.test.ts:670-697). Its walker `versionFilePaths` handles both the tree and the flat `{name:"groups/.../x.yml"}` shape shown in the SPEC example (provision.ts:1018-1057).

**Meaning (MEASURED):** `/version/files?commit=X` returns the files of **commit X alone**. The SPEC says "changed since", but that is wrong:
- For the root commit, `GET /version/files?commit=96a9674` → **500** `{"status":"error","message":"fatal: bad revision '96a9674~..96a9674'\n"}`. The server runs `X~..X`, one commit. Guard against this, or skip the root commit.
- gigamon measured the same "one commit, not since" behaviour (provision.ts:1059-1068; CLAUDE.md:240).
- Contrast: `/version/count?commit=bbef631` → 1164, which **is** "since" (it counts later commits and pending files too).
- Without `commit`, `/version/files` returns the **uncommitted** working-tree files. `/m/default/version/files` gives 4 paths, the same as `/m/default/version/status`.

### 5.5 `/version/show`

- SPEC `GitShowResult` (openapi.json:110182) is `{ commitMessage, diffJson: DiffFiles }`.
- MEASURED: `commitMessage` is **URL-encoded** and holds the whole `git show` header, not just the message. Decoded: `"commit bbef631b46bd…\nAuthor: Cribl System <cribl@…>\nDate:   Thu Sep 24 00:09:51 2026 +0000\n\n    create group default\n"`.
- `diffJson[]` item keys (MEASURED): `blocks, deletedLines, addedLines, isGitDiff, newFileMode, isNew, checksumBefore, checksumAfter, oldName, language, newName, isCombined, isTooBig`. A created file has `oldName: "/dev/null"`. criblvision reads `oldName, newName, isNew, isDeleted, isRename, isBinary, addedLines, deletedLines, blocks[{header, lines}]` (src/api/client.ts:1528-1551).
- For Meter Reader's file-path matching (METER_READER_SPEC.md:344), `/m/<gid>/version/files?commit=` is cheaper than `/show`: it returns paths only, with no diff.

### 5.6 `/version/status` (`GitStatusResult`, SPEC openapi.json:113605)

MEASURED keys: `not_added, conflicted, created, deleted, modified, renamed, files, staged, ahead, behind, current, detached`. `detached` is not in the SPEC. `files[]` items are `{ "path": "groups/default/local/cribl/secrets.yml", "index": "?", "working_dir": "?" }`. `current` is `"master"`. lookup-sync reads `items[0].files[].path` (src/api.ts:154-158). gigamon reads `files[].path` plus the `created, deleted, modified, not_added, staged` arrays (provision.ts:508-525).

### 5.7 Other version endpoints (MEASURED)

- `/version/info` → `{"items":[{"versioning":true,"remote":""}],"count":1}`
- `/version/current-branch` → `{"branch":"master"}`
- `/version/branch` → `{"items":[{"id":"master"}],"count":1}`

---

## 6. `configVersion`: which hash is running

- The group record field `configVersion` is "Commit hash of the **deployed** configuration version" (SPEC ConfigGroup). The PATCH-group warning says not to change it.
- It uses the **abbreviated** hash. gigamon measured this on a Cloud Leader: `default` ran `e4396f3` while HEAD was 40 chars (provision.ts:932-946). Compare hashes with a ≥7-char prefix (`sameCommit`), never with `===`.
- Formats in a live capture from another org (cc-visicore-criblvision/public/fixtures.json:1, `capturedAt` 1783368904222): Stream groups have 7 chars (`default: "687c785"`), some Edge fleets have 40 chars, and some fleets have a composite `short-full` value (`home-assistant: "0b666d0-3f0eccad…"`). `default_search` and `default_outpost` have none.
- MEASURED on this org: **no group record has a `configVersion` field at all** (`/master/groups`, `/products/stream/groups/default`). INFERRED reason: nothing has been deployed since the org was created on 2026-09-24. Handle a missing value as "unknown", not "stale". cc-di-data-flow-monitor does the same (src/components/Overview/WorkerNodeDrawer.tsx:56-59).
- `GET /products/stream/groups/default/configVersion` and `GET /master/groups/default/configVersion` both → `{"items":["bbef631"],"count":1}` (MEASURED). That equals `git.commit`, the latest commit touching the group, even though the group record has no deployed `configVersion`. SPEC `CountedString` example: `{"count":1,"items":["abc1234"]}`.

---

## 7. `policies.yml` object spellings

AGENTS.md format (AGENTS.md:215-222, 233-246): top-level `policies:` list of `{ object: '<path without /api/v1>', actions: [...] }`. `:name` segments and `*` both appear in its examples.

| App | Object | Actions | Citation |
|---|---|---|---|
| lookup-sync | `/master/groups` | GET | config/policies.yml:6-7 |
| lookup-sync | `/master/groups/:id/configVersion` | GET | :9-10 |
| lookup-sync | `/master/groups/:id/deploy` | PATCH | :12-13 |
| lookup-sync | `/m/:gid/version/status` | GET | :24-25 |
| lookup-sync | `/m/:gid/version/commit` | POST | :27-28 |
| power-tools | `/master/groups` | GET | config/policies.yml:42-43 |
| power-tools | `/master/groups/*` | GET, PATCH ("Required for the matching :id/deploy child path") | :44-45 |
| power-tools | `/m/:gid/version/commit` | POST | :51-52 |
| edge-tag | `/master/groups/*` | GET, PATCH ("includes PATCH /master/groups/:fleet/deploy") | config/policies.yml:16-17 |
| edge-tag | `/m/:gid/version/commit` **and** `/version/commit` | POST | :76-79 (declares both "so authorization matches whichever path the platform checks against", :5-8) |
| edge-tag | `/m/:gid/pipelines/*`, `/pipelines/*` | GET, PATCH | :60-65 |
| gigamon | `/master/groups` | GET | config/policies.yml:255-256 |
| gigamon | `/products/stream/groups/:gid`, `/master/groups/:gid` | GET | :259-262 |
| gigamon | `/products/stream/groups/:gid/deploy`, `/master/groups/:gid/deploy` | PATCH | :271-274 |
| gigamon | `/version`, `/version/status`, `/version/files` | GET | :532-537 |
| gigamon | `/version/commit` | POST | :538-539 |
| criblvision | `/version`, `/version/show` | GET | config/policies.yml:51-54 |

- gigamon avoids `*` entirely, because the platform does not document whether it matches one segment or many (config/policies.yml:19-24).
- gigamon's coverage test compares only the path before `?`, so a query string is not part of the grant (provision.ts:961-963). INFERRED for the platform matcher.

**The Leader's own RBAC map** (UI-BUNDLE, in the same `object` / `actions` vocabulary):
- Leader Git: `Commit /version/commit POST`, `Undo /version/undo POST`, `Info /version/info GET`, `List /version GET`, `Count /version/count GET`.
- Group Git: `Commit :group/version/commit POST`, `Undo :group/version/undo POST`, `List :group/version GET`, `Count :group/version/count GET`, `Deploy /products/:pid/groups/:id/deploy PATCH` + `/master/groups/:id/deploy PATCH`. `CommitAndDeploy` is the commit object plus both deploy objects.
- Group-level config: `Read :group/* GET`, `Update :group/* PATCH`.
- The matcher does `object.replace(":group", "/m/<gid>" | "/w/<wid>").replace(":id", …).replace(":pid", …)`. So the group-context commit object is `/m/:gid/version/commit`. INFERRED: the App platform uses the same vocabulary. AGENTS.md's example `/m/:gid/system/projects/*` is consistent with this.

**Suggested Meter Reader objects** (INFERRED from the above; the spike should confirm them):

```yaml
policies:
  # release, read-only: per-group history and changed files
  - object: '/m/:gid/version'
    actions: ['GET']
  - object: '/m/:gid/version/files'
    actions: ['GET']
  - object: '/master/groups'          # list groups (+ ?fields=git.commit,git.log if used)
    actions: ['GET']
  # demo build only: the lever write path
  - object: '/m/:gid/pipelines/:id'   # or literal ids, gigamon-style
    actions: ['GET', 'PATCH']
  - object: '/m/:gid/version/status'
    actions: ['GET']
  - object: '/m/:gid/version/commit'
    actions: ['POST']
  - object: '/products/stream/groups/:gid/deploy'
    actions: ['PATCH']
  - object: '/master/groups/:gid/deploy'   # only if keeping the 404 fallback
    actions: ['PATCH']
```

---

## 8. Cribl.Cloud specifics

- Groups on this org (MEASURED, `GET /master/groups`):
  - `default`: `type: stream`, `onPrem: false`, `provisioned: true`. This is the Cloud-managed Stream worker group and has 1 worker.
  - `default_fleet`: `edge`, `isFleet: true`.
  - `default_search`: `search`, `isSearch: true`.
  - `default_outpost`: `outpost`.
  - `GET /products/stream/groups` returns only `default`.
- The config repo is on the **Leader** and is shared by every group. `/version*` without a prefix is Leader-wide and also includes the Leader's own `local/cribl/...` files (MEASURED). Worker groups do not hold commits. A deploy only points a group at a Leader commit.
- The branch is `master` (MEASURED). There is no git remote (`remote: ""`).
- `default_search` has 386 uncommitted files on a fresh org (MEASURED). Never commit without `files` at Leader level.
- Commits on a fresh org are authored `Cribl System`.

---

## 9. Discrepancies and open questions

1. **METER_READER_SPEC.md:98-121 uses the wrong policies format.** It writes `paths: - path: /api/v1/...; methods: [...]`, but AGENTS.md specifies `policies: - object: '/...'` with `actions:`. The spec's `/api/v1/version/*` would not cover the bare collection `/version` (AGENTS.md:248) or the group-scoped `/m/:gid/version` (a separate object, AGENTS.md:228). Its demo `/api/v1/version/commit` is the Leader-level object, not the group-context one.
2. **Per-group history exists natively**, although METER_READER_SPEC.md:342 says "the spike confirms the group-scoped path". The path is `GET /m/<gid>/version?offset=0&limit=50` (MEASURED group-scoped), plus `GET /m/<gid>/version/files?commit=<hash>` for each commit's files. That is 1 + N calls per group per refresh. Alternative: `GET /master/groups?fields=git.log` (one call, all groups; row cap UNVERIFIED).
3. **`/version/files` means one commit, not "since"** (SPEC is wrong; MEASURED). It returns 500 on the root commit.
4. **`date` is not ISO 8601** (MEASURED `"YYYY-MM-DD HH:MM:SS +0000"`).
5. **`git.log` rows have no `short` field**, although the SPEC `Commit` schema requires it (MEASURED).
6. **`/version/show` `commitMessage` is URL-encoded and includes the `git show` header** (MEASURED).
7. **lookup-sync deploys `GET …/configVersion`, not the commit hash** (src/api.ts:176-185). The SPEC calls the record field the *deployed* hash. MEASURED: the `/configVersion` endpoint returned the group's latest commit on a never-deployed group. What it returns when deployed and latest-committed differ is **UNVERIFIED**. Recommendation: deploy `items[0].commit` from the commit response, as power-tools, edge-tag, gigamon, the SDK examples and the UI do.
8. **Group-context commit without `files`**: is it limited to that group's pending files? **UNVERIFIED**; testing it would require a write. Status in group context is group-scoped (MEASURED), which suggests so but does not prove it. Pass `files` regardless.
9. **What `effective: true` does** is **UNVERIFIED**. The UI sends it on every group commit (UI-BUNDLE), and the SDK examples send it with `files: ["."]` (examples/example-stream.ts:143).
10. **SDK README is stale.** README.md:160-167 shows `versions.commits.create({ groupId, gitCommitParams: {...} })`. At `0234e9d` the function takes a bare `GitCommitBody` (src/funcs/versionsCommitsCreate.ts:62-64, 94), and the group goes in `serverURL` (examples/example-stream.ts:142-144).
11. **Author of app- or backend-initiated commits** is **UNVERIFIED**: the interactive user through the UI proxy, and unknown identity for scheduled backend endpoints.
12. **Rate budget:** one lever is GET + PATCH + status + commit + deploy, which is 5 Leader calls before the KV writes. METER_READER_SPEC.md:261 estimates "about 7".
