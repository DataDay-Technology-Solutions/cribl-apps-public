# Cribl's guidance for building apps with Claude, plus what shipped apps learned

Research notes for **Meter Reader** (Cribl App Platform, Preview). Compiled 2026-09-25.

**Precedence.** The project's own `AGENTS.md` (the `@cribl/apps:managed` block, scaffold 1.1.0) outranks everything below. Where the Claude plugin or a reference app disagrees with it, this doc says so and AGENTS.md wins.

**Citation convention.** `AGENTS.md:N` = this project's AGENTS.md. `plugin/...` = `claude-cribl-app-plugins/plugins/app-creation/...`. Every other path starts with the reference repo's name, for example `cc-gigamon-ami/README.md:76`. A bare path with no repo prefix (`vite.config.ts:63`, `README.md:5`, `package.json:6`, `config/proxies.yml:14`) is a file in this project. `@cribl/apps/...` = `node_modules/@cribl/apps/...` in this project. Its line ranges are approximate to within a few lines. It is the pinned devDependency that implements `npm run package`, and I read it because it, not the reference repos' hand-rolled `scripts/pkgutil.mjs`, decides what our `.tgz` contains. **INFERRED** marks anything I concluded without seeing it stated in the source.

---

## 0. Most decision-relevant facts

1. **Backend functions and schedules only run in an installed app.** They need Cribl 4.20 or later. In Live Preview they return 502/503/504 until you click **Deploy** (`cc-visicore-spl-to-kql/README.md:207,211`). Deploying from Live Preview installs **both** `__dev__<name>` and the real app id. Calling the `__dev__` endpoints through REST times out, so test against the real id (`cc-visicore-spl-to-kql/AGENTS.md:557-558`).
2. **KV writes must be `text/plain`.** With `application/json` the store answers 200 and saves the literal `[object Object]` (`cc-gigamon-ami/src/cribl/kv.ts:27-29`, `cc-visicore-lake-credit-usage/README.md:92`, `cc-visicore-spl-to-kql/AGENTS.md:559-561`). The plugin says the same thing more loosely: "Don't store JSON objects, they must be serialized / deserialized as strings" (`plugin/skills/app-implement/references/cribl-apps-guidance.md:42`).
3. **KV has three more measured limits.** Values are capped at about 100 KB (HTTP 413). Keys written with `?encrypted=true` return 403 on read and can only be used through `kv.<key>` in proxies.yml (`cc-visicore-spl-to-kql/AGENTS.md:562-564`). A per-user key containing a percent-escape (`auth0%7C…`) returns 404, so sanitize user ids into `[A-Za-z0-9-]` (`cc-gigamon-ami/src/cribl/user.ts:53-73`).
4. **KV does not work on bare `localhost:5173`.** There is no `/a/{appId}/` scope and `__dev__<name>` is not a registered app. KV only works in the in-UI Live Preview or an installed app (`cc-gigamon-ami/CLAUDE.md:132-137`, `cc-gigamon-ami/src/cribl/kv.ts:36-40`).
5. **Every entry in `policies.yml` is a grant.** It is not documentation. A missing entry is a 403 that only non-admins ever see; an extra entry asks for trust the app does not need (`cc-gigamon-ami/README.md:92-96`, `cc-gigamon-ami/CLAUDE.md:373`). Never declare `/kvstore/...` (`AGENTS.md:226`). Whether `*` matches one path segment or many is undefined, so the Cribl-authored gigamon app avoids wildcards completely (`cc-gigamon-ami/README.md:163-168`).
6. **Metrics are queried at the Leader, not per group.** `POST /system/metrics/query` is Leader-level, and `/m/:gid/system/metrics/*` returns 404. You scope to a group with a `__worker_group` dimension inside the query (`cc-di-data-flow-monitor/config/policies.yml:29-32`).
7. **"Import from Git" only works on release tags that carry the built `static/` + `default/` layout.** Importing a source branch installs an app record that then shows "App not found" (`cc-gigamon-ami/README.md:76-79`, `cc-visicore-lookup-sync/README.md:105-106`). The safe install path is the `.tgz`: **Apps → Add App → Import from File / Upload package**.
8. **External hosts can be added after install without repackaging.** An app admin does it under **App Settings → External API Access**. Host keys match exactly, with no wildcards (`cc-cribl-power-tools/README.md:168-217`, `cc-cribl-power-tools/config/proxies.yml:14-18`).
9. **The scaffold `README.md` is a fixed-schema Marketplace template.** Fixed section names plus an "App Metadata" table "parsed into App Gallery components later" (this project's `README.md:5,265-287`). `cc-firewall-monitor` and `cc-visicore-spl-to-kql` follow it. The four repos named in the task use free-form READMEs.
10. **Name mismatch to decide on.** All 14 Cribl-Community app repos have `package.json` `name` equal to the repo name (`cc-…`). Ours is `"meter-reader"` in a folder named `cc-meter-reader`. The plugin's `/app-implement` forces `package.json` `name` to equal the app id (`plugin/skills/app-implement/SKILL.md:70-71,79-80`). **INFERRED:** choose the final id before pairing Live Preview or releasing. The dev id is `__dev__${name}` (`vite.config.ts:63`), and the release workflows key the Dispensary upload on the repo name (`cc-visicore-criblvision/.github/workflows/release.yml:62,71`).

---

## 1. The Claude plugin: `claude-cribl-app-plugins`

### 1.1 What it is

- It is a Claude Code plugin marketplace named `claude-cribl-app-plugins`, owned by Cribl. It contains one plugin, `app-creation`, sourced from `./plugins/app-creation` (`claude-cribl-app-plugins/.claude-plugin/marketplace.json:1-14`).
- The plugin is `app-creation` version `"2.3"`, "Tools for authoring Cribl Apps" (`plugin/.claude-plugin/plugin.json:1-10`).
- Latest commit: `2ccf94e` on 2026-08-30, "Merge pull request #7 from Cribl-Community/feat/app-questions-claude-guidance".
- **Install:** run `/plugin`, go to Marketplaces, choose Add Marketplace, paste `https://github.com/Cribl-Community/claude-cribl-app-plugins`, choose `app-creation`, then run `/reload plugins` (`claude-cribl-app-plugins/README.md:9-17`).
- **Links it gives:** https://docs.cribl.io/apps/, https://docs.cribl.io/apps/builder-guide/, and https://github.com/criblapps and https://github.com/Cribl-Community (`claude-cribl-app-plugins/README.md:31-33`, `plugin/README.md:143-145`).

### 1.2 Required prerequisites before any skill runs

- "**Scaffold an app first.** Create a new app in Cribl (Apps > Create App) and copy the starter code to your local machine." (`plugin/README.md:22`)
- "**Run in the app directory.** … `cd` into your app folder before invoking commands. Run `npm run dev` to launch the app." (`plugin/README.md:23`)
- "**Launch Preview** - Launch the preview in Cribl so you can test out the app after it is built." (`plugin/README.md:24`)
- Every skill runs the same pre-flight check: "verify you are in a scaffolded Cribl app folder. If you are not, stop and tell the user: 'You must run this skill from within a scaffolded Cribl app folder.'" (`plugin/skills/app-questions/SKILL.md:19-21`, `app-brief/SKILL.md:19-21`, `app-validate/SKILL.md:7-9`, `app-implement/SKILL.md:23-25`)
- The recommended setup is two terminals: `npm run dev` in one and Claude in the other (`plugin/README.md:28-31`).

### 1.3 The three-phase workflow

| Phase | Skill | Reads | Writes | Cite |
|---|---|---|---|---|
| 1 Define | `/app-questions` | `APP_DEFINITION.md` (to resume) | `APP_DEFINITION.md`, and `CLAUDE.md` only if it is absent | `plugin/skills/app-questions/SKILL.md` |
| 2 Brief | `/app-brief` | `APP_DEFINITION.md`, plus an existing `APP_BRIEF.md` | `APP_BRIEF.md` | `plugin/skills/app-brief/SKILL.md` |
| 2 Validate | `/app-validate` | both files | a report only | `plugin/skills/app-validate/SKILL.md:19-25` |
| 3 Implement | `/app-implement [--dry-run]` | `APP_BRIEF.md` and the latest `executions/APP_BRIEF_*.md` | code, config, `executions/APP_BRIEF_<ISO>.md` | `plugin/skills/app-implement/SKILL.md` |

Where files land: `APP_DEFINITION.md`, `APP_BRIEF.md`, and `/executions/APP_BRIEF_[timestamp].md` (`plugin/README.md:75-83`). The skills never commit or open PRs: "You manage git" (`plugin/README.md:120-121`).

### 1.4 `/app-questions` (Phase 1)

- **Seven mandatory phases on the first run.** "Do I have to answer all 7 phases on the first run? Yes." (`plugin/README.md:96-97`)
  1. App id, then the problem, the users, and how they solve it today. **The first question is "What is the app id?"** (`app-questions/SKILL.md:85-96`)
  2. Workflows as ordered steps, including what gets created, modified or deleted, what the user sees, and the decision points (`:98-109`)
  3. Data: what is displayed, what gets created or changed, which external services are called (`:111-120`)
  4. Permissions: do different users see different data, and what happens when permission is denied (`:122-129`)
  5. State and secrets: saved state, general settings, per-user settings, secrets (`:131-142`)
  6. Scope: MVP, later, out of scope (`:144-153`)
  7. UI: structure (wizard, dashboard, form, table) and look and feel (`:155-162`)
- **Clarity validation** triggers on answers shorter than two sentences, vague or abstract answers, or answers that miss the question. The rule is "Do NOT proceed … until the current answer is clear and complete" (`:77-83`).
- It is re-entrant and writes each answer incrementally (`:166-174`). The `APP_DEFINITION.md` template is at `:182-249`. Edit mode is a 10-option menu that confirms before destructive deletes (`:255-387`).
- **It generates `CLAUDE.md` only if one does not exist.** The template points at `AGENTS.md` ("How to build the app and navigate the app runtime environment"), `APP_DEFINITION.md` and `APP_BRIEF.md`, then lists workflows, UI structure and MVP scope (`:391-455`). The rule: "Always including reference to `AGENTS.md` (it's in every app scaffold)" (`:454`).

### 1.5 `/app-brief` (Phase 2)

- The brief template's sections are: App ID, Problem & Vision, Target Users, Key Workflows (each with User sees / User does / Result / **Permissions**), Data & Actions (fetch / create-modify-delete / general state / per-user settings / secrets), UI Structure, Permissions & Access, External Integrations, MVP Scope, Edge Cases & Error Handling (lack of permission, data unavailable, action fails) (`app-brief/SKILL.md:51-141`).
- **This section is always included verbatim** (`app-brief/SKILL.md:143-146`):
  ```
  ## Implementation guidance (include this section verbatim)
  - Read AGENTS.md first
  - Then read openapi.json
  - NEVER EVER use local storage
  ```
  The sample brief adds one more line: "The app should be running and has a file-watcher so if you need to, inject code that you can use to test out APIs / functionality via the fetch proxy." (`plugin/samples/APP_BRIEF.md:196`)
- **Update rules:** never delete sections, keep elaborations, prefer the more detailed version, and always keep the Implementation guidance section (`app-brief/SKILL.md:177-181`).
- **Principles:** "APIs handled by Claude: Claude uses `openapi.json` to determine which Cribl APIs to call"; "User-specific storage: Per-user settings automatically prefixed with user ID"; "MVP-first" (`:198-207`).

### 1.6 `/app-validate` (Phase 2)

Read `APP_DEFINITION.md` and `APP_BRIEF.md`, ask "Does this brief accomplish the stated goals?", then report gaps or declare the brief valid. "(do not run in the background)" (`app-validate/SKILL.md:17-25`). This is a requirements-alignment check. It does not run code.

### 1.7 `/app-implement` (Phase 3)

- "**Use Capra UI by default for all components.** Before starting, review `./references/cribl-apps-guidance.md`" (`app-implement/SKILL.md:29`).
- Steps: validate that `APP_BRIEF.md` exists; diff it against the latest `/executions` snapshot (removed sections are never undone); turn the delta into one-line actions; `--dry-run` prints them between `=== DRY RUN: Planned Changes ===` and `=== End Dry Run ===` (`:33-66`).
- **Implementation mode** (`:68-72`):
  - "Read the app id from APP_DEFINITION.md (under '## App ID' section)"
  - "**Update the 'name' field in package.json to match the app id**"
  - "Remove all linter errors, run `npm run lint`"
- It archives to `executions/APP_BRIEF_2026-07-31T14-30-45Z.md` (colons become hyphens), then confirms that `package.json` `name` equals the app id (`:74-80`).

---

## 2. `cribl-apps-guidance.md`: every rule, with status

Source: `plugin/skills/app-implement/references/cribl-apps-guidance.md` (frontmatter `last_updated: 2026-07-31`, line 4).

The **Status** column compares each rule against this project's AGENTS.md and the scaffold:

- **OK**: consistent with AGENTS.md.
- **OK+**: consistent, and a shipped app measured why it matters.
- **OVERRIDDEN**: AGENTS.md or the scaffold says otherwise.
- **N/A**: the rule assumes something this scaffold does not have.

| # | Rule (verbatim or near-verbatim) | Line | Status and notes |
|---|---|---|---|
| G1 | Stay inside the app directory; don't read `../`, sibling apps or shared plugin code | 13-21 | OK (a workflow rule for Claude) |
| P1 | "If the app needs access to user role or team membership, Copy `/references/policies.yml` to the apps `/config`." | 28 | OK. See §3 for the file |
| P2 | "Declare all Cribl endpoints the app uses in `/config/policies.yml`." | 29 | OK (`AGENTS.md:207-250`). Add "and nothing else" (§6) |
| K1 | Use KV for transient data such as selections and filters | 34 | OK |
| K2 | Use KV for large documents the app depends on | 35 | OK, but values are capped at about 100 KB (HTTP 413). spl-to-kql gzips, base64-encodes and chunks (`cc-visicore-spl-to-kql/AGENTS.md:564-566`, `README.md:187`) |
| K3 | "Store user-specific state with the userid in the key." | 36 | OK+. Sanitize the id (`cc-gigamon-ami/src/cribl/user.ts:53-73`) |
| K4 | "Don't EVER use browser local storage." | 39 | OK (`AGENTS.md:99`) |
| K5 | "Don't use KV store as primary data source (it's cache, not database)" | 40 | OK. The platform itself says "persistence" (`AGENTS.md:99`). Treat KV as best-effort |
| K6 | Don't rely on KV for strict consistency or transactions | 41 | OK+. "The KV store has no atomic compare-and-set" (`cc-visicore-spl-to-kql/README.md:187`) |
| K7 | "Don't store JSON objects, they must be serialized / deserialized as strings." | 42 | OK+. PUT `JSON.stringify(x)` with `Content-Type: text/plain` (§5.1) |
| E1-E6 | Return null on transient errors, log with context, validate external responses; never swallow errors, throw generic `Error`, or show stack traces | 48-56 | OK |
| F1-F6 | Cache expensive calls, put timeouts on external calls, test large payloads; no synchronous loops over big data, no regex built in hot paths, no unbounded requests | 62-70 | OK. The proxy timeout is 30 s (`AGENTS.md:76`) and there is a 100 req/min/app limit on external proxy calls (`AGENTS.md:168`) |
| D1 | "Inject console debugging as needed to verify the format of API response payloads." | 77 | OK. Debug in Live Preview |
| T1-T5 | Unit-test parsing and transformation, test edge cases, mock external APIs; don't skip "simple" code or test only the happy path | 84-90 | OK. The scaffold has **no test runner**, so one must be added (vitest in `cc-gigamon-ami/package.json` and `cc-visicore-spl-to-kql/package.json:13`) |
| C1 | "Use `defaults` in manifest for defaults" | 97 | **N/A.** There is no `manifest.json`. The app manifest is `package.json`, validated against the allowlist in `@cribl/apps/lib/package/appPackageJsonSchema.js:17-52` |
| C2 | "Accept secrets via environment variables or instance config" | 98 | **N/A** for the iframe and backend. Secrets go in encrypted KV (C4) |
| C3 | Document required config in the README or manifest comments | 99 | OK. Use the README "Configuration" table (`README.md:72-87`) |
| C4 | "Store secrets in kv with the ?encrypted=true param in the url." | 100 | OK+. Encrypted keys are write-only: GET returns 403, and they are usable only through `kv.<key>` injection in proxies.yml (`cc-visicore-spl-to-kql/AGENTS.md:562-563`, `README.md:181`; `AGENTS.md:162`) |
| C5 | "Create a sentinel key for encrypted values `myapp:has_mysecret` to allow the app to detect if `myapp:mysecret` was set." | 101 | OK+. This is required, because C4 means the app cannot read the secret back |
| C6-C8 | Don't hardcode keys, don't assume config is present, don't store secrets unencrypted | 104-106 | OK |
| A1-A6 | Retry with exponential backoff, honor `X-RateLimit-Reset`, bound timeouts; never retry forever | 112-120 | OK |
| M1-M6 | "Keep `manifest.json` clean…", "Don't forget to update manifest when adding functions" | 126-134 | **N/A as written.** The real manifests are `package.json`, `config/backend.yml` and `config/schedules.yml`. **INFERRED:** the rule carries over as "a new backend function means a `backend.yml` entry and matching `policies.yml` / `proxies.yml` grants" (`AGENTS.md:292`) |
| DEP1-6 | Keep dependencies minimal, pin the lockfile, run `npm audit`; no heavy or unvetted packages | 140-148 | OK. Backend bundles must stay under 5 MB (`AGENTS.md:284`; `@cribl/apps/lib/build/backendManifestSchema.js:81` `MAX_BACKEND_SCRIPT_BYTES = 5 * 1024 * 1024`) |

---

## 3. `references/policies.yml`, quoted exactly

`plugin/skills/app-implement/references/policies.yml:1-22`:

```yaml
# Product API access declaration. Declare Cribl product API paths your app needs to access.
# At install time, admins see exactly which platform resources the app will use.
#
# This app reads the signed-in user's effective roles, authorization policy, and
# team memberships. All paths below are read-only (GET).

policies:
  # Effective roles + authorization policy for the current client (works on cloud and on-prem)
  - object: '/authorize/roles'
    actions: ['GET']
  - object: '/authorize/policy'
    actions: ['GET']

  # Role definitions, used to enrich role IDs with titles, descriptions, and tags
  - object: '/system/roles'
    actions: ['GET']

  # Team definitions and their membership, used to show the teams the user belongs to
  - object: '/system/teams'
    actions: ['GET']
  - object: '/system/teams/*'
    actions: ['GET']
```

Notes:

- The pattern pairs a collection with its child path (`/system/teams` + `/system/teams/*`). That matches AGENTS.md's rule that a collection declaration "covers that exact collection path only" (`AGENTS.md:248`).
- `/authorize/roles` and `/authorize/policy` "works on cloud and on-prem" is Cribl's own claim, and it is the documented way to adapt the UI to the viewer's role. **INFERRED** relevance: Meter Reader can use it to hide admin-only controls such as rate-card editing.

---

## 4. The plugin's samples, and where they contradict AGENTS.md

`plugin/samples/APP_DEFINITION.md` and `plugin/samples/APP_BRIEF.md` describe a "Worker Group Integration Manager": browse groups, list inputs and outputs, view and edit JSON config. They are useful for level of detail. Workflows are explicit about User sees / does / Result / Permissions (`APP_BRIEF.md:12-53`), and edge cases are spelled out (`APP_BRIEF.md:163-176`). APIs named in the sample: `/products/stream/groups`, `/products/stream/workers`, `/m/{groupId}/system/inputs`, `/m/{groupId}/system/outputs`, and `/m/{groupId}/system/inputs/{id}` (`APP_BRIEF.md:57-62`).

**The samples break platform rules. Do not copy them.**

| Sample says | Cite | Platform says | Cite |
|---|---|---|---|
| policies.yml declares "`/kvstore/filter/*`" | `plugin/samples/APP_BRIEF.md:187` | App-scoped `/a/${appId}/kvstore/*` is granted automatically: "do not redeclare them here". gigamon's coverage test fails the build if you do | `AGENTS.md:226`; `cc-gigamon-ami/README.md:156-161,173-174` |
| Dark mode "Detects system preference via `window.matchMedia('(prefers-color-scheme: dark)')` and applies CSS variables" | `plugin/samples/APP_BRIEF.md:188` | The theme comes from the `CRIBL_APP_LAYOUT` postMessage. `prefers-color-scheme` is a first-paint hint only: "Never theme components off it". Build no theme switcher, and style with `token()` rather than raw CSS variables | `AGENTS.md:356,360-363,398,402,418` |
| "Dark/Light mode support (inherit from Cribl system or toggle)" | `plugin/samples/APP_DEFINITION.md:97,130` | "**Do NOT build your own theme switcher**" | `AGENTS.md:356` |
| Saved state "(persisted locally)" | `plugin/samples/APP_DEFINITION.md:71` | No browser storage; use app-scoped KV | `AGENTS.md:99` |
| "User role/permissions: Determined from KV store; defaults to admin for editing"; KV key `user/isAdmin` | `plugin/samples/APP_BRIEF.md:63,76` | **INFERRED:** unsafe. Derive roles from `/authorize/roles` (§3). A KV flag is not an authorization source, and AGENTS.md makes the server-side grant the real control (`AGENTS.md:211`) | — |
| Admins get a JSON editor that PUTs config on Save | `plugin/samples/APP_BRIEF.md:118` | An overwriting PUT needs an explicit confirmation that names the resource | `AGENTS.md:80-89` |

---

## 5. Verified gotchas from shipped apps

### 5.1 KV store

- **Content type.** "PUT with `Content-Type: application/json` answers 200 and stores the literal string `[object Object]`. Only `text/plain` round-trips a JSON document" (`cc-gigamon-ami/src/cribl/kv.ts:27-29`). The same finding appears in `cc-visicore-lake-credit-usage/README.md:92` and `cc-visicore-spl-to-kql/AGENTS.md:559-561`. The same rule applies inside backend endpoints.
- **List keys.** "`POST /kvstore/keys` with a `{"prefix": …}` body answers 200 with a bare JSON array of key names — no `items` envelope — and the endpoint is absent from the 4.19.0 OpenAPI spec" (`cc-gigamon-ami/src/cribl/kv.ts:30-32`). AGENTS.md documents the call as `POST CRIBL_API_URL + '/kvstore/keys'` with body `{ prefix: 'my/key/prefix' }` (`AGENTS.md:108`).
- **Size cap.** Values are capped at about 100 KB and larger ones get HTTP 413 (`cc-visicore-spl-to-kql/AGENTS.md:564`). Its README repeats "about 100 KB" and describes a chunking scheme that swaps generations safely (`cc-visicore-spl-to-kql/README.md:187`).
- **Encrypted keys.** `?encrypted=true` makes a key write-only: reading it returns 403, and it can be used only through `${kv.<key>}` in proxies.yml (`cc-visicore-spl-to-kql/AGENTS.md:562-563`). Store a sentinel key beside it (`cribl-apps-guidance.md:101`).
- **Per-user keys.** Build them with a sanitized id. `auth0|…` percent-encodes to `%7C`, and the PUT returns 404. gigamon's `userKeySegment` maps every character outside `[A-Za-z0-9-]` to `_` plus its hex code (`cc-gigamon-ami/src/cribl/user.ts:53-73`, `CLAUDE.md:371`).
- **Key shapes that shipped:**
  - gigamon: `app/settings/<name>` (install-wide), `<ns>/prefs/<userId>` (per user), `<ns>/log/<epochMs>` (append-only) (`cc-gigamon-ami/src/cribl/kv.ts:19-22`).
  - spl-to-kql: `users/<userId>/prefs`, `knowledge/shared`, and `splunk_token` (encrypted) (`cc-visicore-spl-to-kql/README.md:185-186`).
- **Backend KV.** Inside an endpoint, a relative `fetch('/api/v1/kvstore/<key>')` is already app-scoped (`cc-visicore-spl-to-kql/AGENTS.md:559`).
- **No writes on load.** "A corrupt KV value is read as absent and deliberately *not* repaired, because the repair would be a write on load" (`cc-gigamon-ami/CLAUDE.md:357-358`).

### 5.2 API and policies

- **Leader-level metrics.** `/system/metrics/query` is called at the Leader. "confirmed live that /m/:gid/system/metrics/* 404s, group scoping happens via a __worker_group dimension in the query itself instead" (`cc-di-data-flow-monitor/config/policies.yml:29-32`). CriblVision declares `'/system/metrics/query'` with `['POST']` for throughput, dropped and PQ metrics (`cc-visicore-criblvision/config/policies.yml:19-21`, `README.md:52`).
- **Licenses.** `/system/licenses` and `/system/licenses/usage` are documented as `x-cribl-availability: onprem` with a 403 in SaaS, but "confirmed live to actually return real 200 data against the test Cribl.Cloud org" (`cc-di-data-flow-monitor/config/policies.yml:73-81`).
- **Internal endpoints.** `/system/logs/search` and `/w/:wid/system/metrics` are marked `x-cribl-internal: true` in openapi.json, which is "a real signal Cribl doesn't consider this part of the officially-supported product API for third-party Apps" (`cc-di-data-flow-monitor/config/policies.yml:65-70,83-90`).
- **Worker paths.** A `/w/:wid/...` call must also declare the matching `/m/:gid/...` path (`AGENTS.md:228-231`). CriblVision does exactly that for `/w/:wid/system/metrics` + `/m/:gid/system/metrics` (`cc-visicore-criblvision/config/policies.yml:33-39`).
- **Collection vs child paths.** A collection path does not cover its children, and "group results can be empty" without the child path (`AGENTS.md:248`; `cc-cribl-power-tools/README.md:254-256`).
- **Search group.** Always use `/m/default_search/search/...` (`AGENTS.md:114`). gigamon declares `'/m/default_search/search/jobs'` `['GET','POST']`, then `/:jobId`, `/:jobId/status`, `/:jobId/results` and `/:jobId/cancel` separately (`cc-gigamon-ami/config/policies.yml:135-171`).
- **Group path families.** `/products/stream/groups/...` is current and `/master/groups/...` is deprecated. gigamon declares both and falls back to the old one on a 404 (`cc-gigamon-ami/config/policies.yml:249-274`). Deploy is `PATCH /master/groups/:id/deploy` (`cc-visicore-lookup-sync/config/policies.yml:11-13`).
- **Non-admin 403s.** Admins never hit the permission matcher: "a user who already holds a permission reaches the path without any grant" (`cc-gigamon-ami/README.md:163-166`). Policy gaps therefore only show up for non-admins, so test with a non-admin user who has been shared the app. **INFERRED** test step.
- **Lookups** (from lookup-sync):
  - `/content` answers HTTP 500, not 404, for a missing lookup.
  - Reads need `raw=true`, or the response carries an internal `__id` column.
  - On PATCH, strip `status` and `notifications` first (`cc-visicore-lookup-sync/README.md:167-172`).
- **Commits.** `/version/commit` "commits every pending change in the repository when given none", so always pass an explicit file list (`cc-gigamon-ami/config/policies.yml:524-526`; `cc-visicore-lookup-sync/README.md:42-48`).

### 5.3 UI

- **Border token.** "`border.default` is the *shorthand* `1px solid var(…)`, not a colour". Using it as a colour made the whole app render with no borders (`cc-gigamon-ami/CLAUDE.md:372`).
- **Router basename.** "React Router's basename uses `CRIBL_BASE_PATH` only when the page is actually served under it; in Live Preview the dev server serves at `/` and a mismatched basename renders a blank page" (`cc-visicore-lake-credit-usage/README.md:93`). AGENTS.md tells you to set `basename={window.CRIBL_BASE_PATH}` (`AGENTS.md:326-332`). **INFERRED:** guard that for Live Preview.
- **Outside Cribl.** When `window.CRIBL_API_URL` is absent, show a "must run inside Cribl" notice (`cc-cribl-power-tools/README.md:149-153`) or an offline mode (`cc-visicore-spl-to-kql/README.md:215`). CriblVision instead uses demo fixtures with a **DEMO DATA** badge and localStorage in demo mode only (`cc-visicore-criblvision/README.md:43-44,63-65`). That conflicts with the spirit of `AGENTS.md:99`; di explicitly ships "no demo mode and no synthetic data" (`cc-di-data-flow-monitor/README.md:39`).

---

## 6. Patterns for `policies.yml`, with exact spellings

The schema is `policies: [{ object: '<path>', actions: [...] }]`. Actions are from `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, or `['*']` (`AGENTS.md:215-222`).

| Pattern | Example (exact) | Cite |
|---|---|---|
| Single variable segment | `'/m/:gid/system/inputs'`, `'/w/:wid/system/status/outputs'` | `cc-di-data-flow-monitor/config/policies.yml:20,48` |
| Named ids | `'/m/:gid/system/lookups/:lid/content'`, `'/master/groups/:id/deploy'` | `cc-visicore-lookup-sync/config/policies.yml:12,21` |
| Child wildcard | `'/master/groups/*'`, `'/m/:gid/jobs/*'`, `'/m/:gid/notifications/*'` | `cc-visicore-criblvision/config/policies.yml:10,74,83` |
| Mixed methods per object | `'/m/:gid/notifications'` `['GET', 'POST']`; `…/*` `['GET', 'PATCH', 'DELETE']` | `cc-visicore-criblvision/config/policies.yml:81-84` |
| Literal ids (least privilege) | `'/m/:gid/system/inputs/in_gigamon_http'` | `cc-gigamon-ami/config/policies.yml:26-30,458` |
| Worker path plus group twin | `'/w/:wid/system/metrics'` + `'/m/:gid/system/metrics'` | `cc-visicore-criblvision/config/policies.yml:36-39` |
| Wildcard for all methods (AGENTS example) | `'/m/:gid/system/projects/*'` `['*']` | `AGENTS.md:244-245` |
| Never declare | `/kvstore/...`, `/proxy/...` | `AGENTS.md:226` |

House style from di and gigamon: comment every entry with the calling module and the reason, and "expand this only alongside new calls in code, never speculatively" (`cc-di-data-flow-monitor/config/policies.yml:4-8`). gigamon enforces this with `src/cribl/policyCoverage.test.ts`, which checks both directions and each action (`cc-gigamon-ami/README.md:170-174`, `CLAUDE.md:44`).

---

## 7. Live Preview and Deploy

The task's search terms were **not found in the four named repos** (criblvision, gigamon, lookup-sync, di). They turned up elsewhere:

- **Pairing.** "the app created via **Apps → Add App** (which pairs Live Preview with your local dev server)"; "`npm run dev` … then choose Live Preview in the Cribl app wizard" (`cc-visicore-lake-credit-usage/README.md:61,65`). gigamon pins `port: 5173, strictPort: true` "so the Cribl __dev__ app (which loads this server at localhost:5173) always reaches it" (`cc-gigamon-ami/vite.config.ts:210-214`).
- **Deploy button.** "Deploy with the **Deploy** button in Live Preview, or upload the packaged `.tgz` via the Apps page." (`cc-visicore-lake-credit-usage/README.md:71`)
- **Deploy from Live Preview:** "Deploy from Live Preview installs BOTH `__dev__` and the real app id. Invoking `__dev__` endpoints through the REST API times out (its backend runs in the local ws engine); test against the real app." (`cc-visicore-spl-to-kql/AGENTS.md:557-558`)
- **Backend status and debug endpoints** (from spl-to-kql, `cc-visicore-spl-to-kql/AGENTS.md:554-556`):
  - `GET /api/v1/apps/<appId>/backend/status|endpoints`
  - `GET /api/v1/a/<appId>/backend-schedules`
  - The frontend calls `POST ${CRIBL_API_URL}/endpoints/<name>`. AGENTS.md gives the invoke path as `/api/v1/a/{yourAppId}/endpoints/{name}` (`AGENTS.md:290`).
- **Backend errors:**
  - "Backend engine not initialized" or a timeout means the tenant must run Cribl 4.20 or later and the app must be installed, not only previewed (`cc-visicore-spl-to-kql/README.md:207`).
  - "Bad gateway (HTTP 502/503/504) in Live Preview: the preview's backend functions do not exist until you click **Deploy**." (`cc-visicore-spl-to-kql/README.md:211`)
- **Dev pack.** The dev pack skips `dist/`, prefixes name and displayName with `__dev__`, and omits `default/backend.yml` when no backend build exists: "A dev pack with no backend installs fine; the backend appears as soon as the author has run a build" (`@cribl/apps/lib/package/pkgutil.js:111-118,149-178,197-200`). It is served at `/package.tgz?dev=true` (`vite.config.ts:11-18`).
- **Hot reload.** Editing `package.json`, `config/proxies.yml`, `config/policies.yml`, `config/schedules.yml` or `config/backend.yml` triggers `CRIBL_APP_CONFIG_CHANGED` and a reload (`vite.config.ts:20-32`, `AGENTS.md:252`).
- **Links.** "absolute paths resolve against your dev server, not the Leader UI, so `target="_top"` won't reach Cribl. Test those in installed mode." (`AGENTS.md:352`)
- **KV.** It works in Live Preview but not on the bare localhost page (§0 item 4).
- **`?init=` precedence bug.** Our `vite.config.ts:50` has `initScriptUrl = initScriptUrl || url.searchParams.get('init')`, so the first init wins forever. di changed it to `url.searchParams.get('init') || initScriptUrl` after "testing multiple simulated users against one long-running dev server" (`cc-di-data-flow-monitor/vite.config.ts:60-66`). gigamon hit the same bug when a second workspace's Live Preview loaded the first one's bridge (`cc-gigamon-ami/CLAUDE.md:127`). **INFERRED:** restart `npm run dev` when switching workspaces rather than editing the file, because `vite.config.ts` is a managed surface that `apps upgrade` rewrites (`@cribl/apps/README.md:102`).
- **Dev app id in production builds.** Our `vite.config.ts:61-65` injects `window.CRIBL_APP_ID = '__dev__<name>'` without an `if (ctx.server)` guard, so it also lands in production builds. di gated it and explains why it considered the ungated version harmful (`cc-di-data-flow-monitor/vite.config.ts:77-89`). The Cribl-authored gigamon app does **not** gate it (`cc-gigamon-ami/vite.config.ts:168-172`) and ships fine. **INFERRED:** the harm is unproven. Do not edit this managed file. Just never read `window.CRIBL_APP_ID` for anything important.
- **Read-only fetch.** gigamon measured that "Cribl's Live Preview frame" makes `fetch` read-only (`cc-gigamon-ami/src/cribl/devTrace.ts:86`). This matches `AGENTS.md:58`: "You cannot override or replace `window.fetch` (it is locked)".

---

## 8. Install paths and packaging requirements

### 8.1 UI install paths, as the apps word them

| Wording | Cite |
|---|---|
| "**Manage → App Platform → Add App → Import from File** and upload the `.tgz`"; alternatively "**Import from URL** with the release asset link" | `cc-visicore-criblvision/README.md:10-15` |
| "**Apps → View All**" then "**Add App → Upload package**", then **Install** | `cc-gigamon-ami/README.md:83-85` |
| "In Cribl, go to **Apps** and choose import from file" | `cc-firewall-monitor/README.md:50`; template `README.md:66` |
| "Go to Apps → Add App and upload the `.tgz`" | `cc-visicore-lake-credit-usage/README.md:46` |
| **Import from Git**: repo URL plus ref `latest` or `vX.Y.Z`. "only release tags contain the built app layout (`static/`, `default/`) — importing the `main` branch won't work" | `cc-visicore-lookup-sync/README.md:94-106`; `cc-visicore-lake-credit-usage/README.md:48-55` |
| "Importing a source repo installs the app record but leaves it unable to load ('App not found'). Use the release `.tgz` instead." | `cc-gigamon-ami/README.md:76-79` |
| Template step: "Review the app details and complete installation." | `README.md:55,68`; `cc-firewall-monitor/README.md:46,51` |

Other install facts:

- "Once installed and shared, the app runs on live data automatically" (`cc-visicore-criblvision/README.md:17`).
- "Install that artifact into a Cribl workspace as an admin, then share the app with the users who should have access." (`cc-cribl-power-tools/README.md:165-166`)
- Minimum versions stated: 4.18.0 or later with "**Apps (Preview)** feature available, and Workspace Admin access" (`cc-visicore-lake-credit-usage/README.md:41`); 4.18.0+ (`cc-visicore-lookup-sync/README.md:91`); backend functions need 4.20+ (`cc-visicore-spl-to-kql/README.md:40,152`).
- **"Review App screen":** this phrase appears in **no** reference repo. The nearest wording is the template's "Review the app details and complete installation" and "admins see exactly which platform resources the app will use" (`AGENTS.md:124,209`). What that screen actually shows is **not visible** in the sources.

### 8.2 What `npm run package` produces (`@cribl/apps` 1.1.0)

`apps package` runs `createAppPack` (`@cribl/apps/lib/package/pkgutil.js:119-200`), which assembles:

```
package.json            # allowlisted keys only (see below)
README.md               # copied from root (Marketplace overview; raw HTML ignored — AGENTS.md:408)
static/                 # dist/ (skipped in dev packs)
default/proxies.yml     # from config/
default/policies.yml    # from config/
default/schedules.yml   # from config/
default/backend.yml     # config/backend.yml with script paths rewritten to built .js
default/backend/*.js    # from backend-build/ (no .map, no root package.json marker)
```

- The packed `package.json` keeps only these keys: `['name','version','displayName','description','author','license','minLogStreamVersion','cribl','tags']`. It re-stamps `cribl.createAppScriptVersion` to `SCAFFOLD_SPEC_VERSION` (`'1.1.0'`) and defaults `tags.product` to `[]` (`pkgutil.js:184-195`; `@cribl/apps/lib/scaffoldVersion.js:13`).
- **Install-time schema.** `required: ['name','version']`. `cribl` has `additionalProperties: false`, allowing only `type`, `isPrivate`, `createAppScriptVersion`, `hideAppHeader`, `hidden` and `store`. `tags.product` items must be one of `stream`, `edge`, `search`, `lake`, `insights` (`@cribl/apps/lib/package/appPackageJsonSchema.js:17-52`). A stray key under `cribl` fails at install.
- **Backend requirement.** If `config/backend.yml` exists but `backend-build/` does not, a non-dev pack throws "Run `apps build` first". An install whose `backend.yml` names a missing script is rejected with "declared script ... was not found in archive" (`pkgutil.js:154-178`).
- **Backend limits.** `backend.yml` endpoint `name` must match `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`; `description` is optional and documentation only; `timeout` is 1-120 s (default 30); `memory` is 1-1024 MB (default 256); `runtime` must be `js` (`@cribl/apps/lib/build/backendManifestSchema.js:18-76`). Schedules are limited to 10 per app, five-field UTC cron (`AGENTS.md:308-311`).
- **Metadata drift in reference repos.** Their hand-rolled `scripts/pkgutil.mjs` allowlists omit `minLogStreamVersion` (for example `cc-visicore-criblvision/scripts/pkgutil.mjs:138`) even though lookup-sync sets `"minLogStreamVersion": "4.18.0"` (`cc-visicore-lookup-sync/package.json:46`). Our `@cribl/apps` 1.1.0 packs it, so set it (4.20.x if backend functions are used). **INFERRED.**
- **Versioning.** `npm run package` bumps patch, or use `-- --minor`, `-- --major` or `-- --version X.Y.Z` (`AGENTS.md:4-12`). The release CI pattern tags `v*`, runs `npm ci`, `npm run lint`, then `npm run package -- --version "${GITHUB_REF_NAME#v}"`, attaches `build/*.tgz` to a GitHub Release, and uploads to the Packs Dispensary using `-staging` tags for staging (`cc-visicore-criblvision/.github/workflows/release.yml:1-73`; `cc-gigamon-ami/README.md:202-238`). gigamon: "`package.json` version and the `v*` tag should agree" (`README.md:232`) and "Nothing in `build/` is tracked" (`CLAUDE.md:90`).
- **Version drift.** A stale local `.tgz` once installed 1.0.20 while 1.1.1 had been released (`cc-gigamon-ami/CLAUDE.md:112-113`). Always check the version inside the `.tgz` before uploading. **INFERRED** step.

---

## 9. App Settings → External API Access

- **What it is.** An admin edits the installed app's proxy config inside Cribl, "**without repackaging or reinstalling**" (`cc-cribl-power-tools/README.md:122-124,178-181`).
- **Steps.** "open the installed app and go to **App Settings → External API Access**" (`:184`); edit the hostname only (`:201-206`); "Save the External API Access config, then reload the app" (`:210`).
- **Other wordings.** spl-to-kql calls it "**Settings > External API Access**" and describes it as a "JSON editor" (`cc-visicore-spl-to-kql/README.md:40,170`, `AGENTS.md:573-574`).
- **JSON shape.** The Settings editor uses an `id` key rather than a YAML top-level key (`cc-visicore-spl-to-kql/README.md:172-179`):
  ```json
  {
    "id": "splunk.example.com:8089",
    "headers": { "inject": { "Authorization": "`Bearer ${kv.splunk_token}`" } },
    "timeout": 120000,
    "rejectUnauthorized": true
  }
  ```
- **Exact host matching.** "the app proxy matches domain keys EXACTLY — wildcard/subdomain keys such as `*.cribl.cloud` or `.cribl.cloud` are NOT honored" (`cc-cribl-power-tools/config/proxies.yml:14-18`). An undeclared host gets 403, "Redirects are not followed across hosts", and some hosts fail with "private broker request failed" even when declared (`cc-visicore-spl-to-kql/AGENTS.md:567-570`, `README.md:208-209`).
- **Auth headers are stripped.** The platform strips any `Authorization` header the app sets. Inject it from KV instead: `Authorization: "'Bearer ' + kv.packCopyToken"` (`cc-cribl-power-tools/config/proxies.yml:20-21,39-40`; `AGENTS.md:166`).
- **Open question: two injection syntaxes appear in shipped apps.**
  - JS concatenation `"'Bearer ' + kv.apiKey"` (`AGENTS.md:150,179`; `cc-cribl-power-tools/config/proxies.yml:40`)
  - Template literal `` '`Bearer ${kv.api_key}`' `` (this scaffold's `config/proxies.yml:14`; `cc-visicore-spl-to-kql/README.md:175`)

  The sources do not say which is canonical. **INFERRED:** follow `AGENTS.md:160-163` (concatenation), which is the managed, authoritative text.
- **README section.** The template has an "External API Access" section with "Default Configuration" and "External Endpoints" subsections, and says "If the app makes no external calls, say so clearly." (`README.md:128-141`). Example: "This app makes no external API calls." (`cc-firewall-monitor/README.md:105-107`)

---

## 10. README structure for submissions

- **Scaffold template (use this).** Our `README.md` comes from `@cribl/apps/assets/README.md`: "This README uses fixed section names and a fixed metadata table so it can be rendered as normal Markdown today and parsed into App Gallery components later." (`README.md:5`). AGENTS.md adds: "Root `README.md` is the customer-facing Marketplace overview. Write it in Markdown; raw HTML is ignored. Use `AGENTS.md` for developer guidance that should not appear in the Marketplace." (`AGENTS.md:408-409`). The packer ships `README.md` inside the `.tgz` (`@cribl/apps/lib/package/pkgutil.js:180-182`).
- **Fixed section order** (`README.md:1-287`): Summary; What This App Does; When To Use This App; Before You Install; Installation (Marketplace or URL / not yet in Marketplace); Configuration (Setting | Required | Description | Example | Scope); How To Use (Typical Workflow, First-Run Checklist); Permissions (Cribl API Endpoints Used: Method | Endpoint | Purpose); External API Access; Data And Storage; Support (pick one of Cribl Built / Partner Built / **Community Built** / Internal Only, with a contact); Known Limitations; Troubleshooting; Development; Project Layout; Versioning And Releases; Contributing; License; **App Metadata**.
- **App Metadata table.** "Keep the left column labels exactly as written" (`README.md:267`). Fields: App Name, App ID, Version, Author, Support Model (`cribl-built|partner-built|community-built|internal-only`), Support Label, Support Contact, License, License File, Product Tags, Category, Audience, Availability (`preview|ga|internal|deprecated`), Requires External Access (`yes|no`), Repository, Documentation, README Schema Version `1.0` (`README.md:269-287`).
- **Filled-in examples:**
  - `cc-visicore-spl-to-kql/README.md:287-307`: Availability `preview`, Support Model `community-built`, Category `Migration`.
  - `cc-firewall-monitor/README.md:154-170`: its App ID row says `firewall-monitor` while `package.json` name is `cc-firewall-monitor`. That is drift to avoid.
- **The four named repos use free-form READMEs.**
  - CriblVision: hero screenshot, Install, a Dashboards table, How it works (lists every API call), Develop, Structure (`cc-visicore-criblvision/README.md`).
  - gigamon: Preview banner, Why, What it does, Features, Installation, a long "What installing this app grants" section, Development, Releasing, Authors (`cc-gigamon-ami/README.md`).
  - lookup-sync: Why, What it does, "App vs. script", Installation with three options plus "What admins see, and what the app can touch" (`cc-visicore-lookup-sync/README.md`).
  - di: short marketing prose with screenshots only (`cc-di-data-flow-monitor/README.md`).
- **Patterns worth copying (INFERRED as good practice):**
  - A screenshot at the top, stored under `docs/` or `images/` (`cc-visicore-criblvision/README.md:5`, `cc-visicore-lookup-sync/README.md:14`).
  - A plain-language "what installing grants" section listing every write and every non-obvious read (`cc-gigamon-ami/README.md:90-174`).
  - A "Nothing writes on load, on render, or on a timer" statement (`cc-gigamon-ami/README.md:47-48`).
  - A disclaimer when dollar or credit figures are estimates, as in "Credit figures are estimates… For billing decisions, use the FinOps Center in Cribl.Cloud." (`cc-visicore-lake-credit-usage/README.md:96-98`). This applies directly to Meter Reader's dollar figures.
- **"Hackathon":** there are no hits in any reference repo, so no submission format beyond the template above is visible.

---

## 11. Testing approaches

- **Plugin:**
  - Unit-test parsing and transformation, cover edge cases, mock external APIs (`cribl-apps-guidance.md:84-90`).
  - Validate the brief against the definition with `/app-validate`.
  - Make lint clean with `npm run lint` (`app-implement/SKILL.md:72`).
  - Debug payload shapes with injected console logging inside the running app (`cribl-apps-guidance.md:77`; `samples/APP_BRIEF.md:196`).
- **Scaffold:** only `lint` (oxlint), and `build` (`tsc -b && vite build && apps build`) as the type gate (`package.json:6-11`).
- **gigamon** (the most rigorous; all in `cc-gigamon-ami/CLAUDE.md`):
  - vitest suites (`:16`).
  - A policy-coverage test that checks both directions and each action (`:44`).
  - A test that every gated write sits behind a confirmation control (`:45`).
  - A WCAG contrast test that resolves `token()` chains in both themes (`:46`).
  - A frozen snapshot of customer-visible queries (`:43`).
  - An asset budget (`:50`).
  - Warnings that "A green run is not an accessibility result" and "A green run with an error on stderr is not a green run either" (`:62-77`).
  - `npm run package` runs the tests before bumping the version (`:36-37`).
- **Dry-run switch.** It runs the full preview, confirm and progress flow with zero write calls (`cc-cribl-power-tools/README.md:128-134`).
- **Where to verify** (from §7):
  - Anything persistent: Live Preview or installed.
  - Backend functions and schedules: installed, under the real app id.
  - `target="_top"` links: installed.
  - Both themes: toggle in the Cribl account menu (`AGENTS.md:404`).
  - Non-admin grants: a shared non-admin user (**INFERRED**).

---

## 12. UI rules (AGENTS.md is authoritative; the plugin agrees)

- Use Capra by default, documented at https://capra.cribl.io/llms.txt (`AGENTS.md:414`; `plugin/skills/app-implement/SKILL.md:29`).
- Reference tokens with `token()` and never use CSS variables directly. Rarely put classes on Capra components; do spacing with wrappers; never depend on Capra internals (`AGENTS.md:416-420`).
- Theme via the `installThemeBridge` pattern:
  - Call it in `src/main.tsx` before render.
  - Use `document.body.classList.toggle('dark', …)`.
  - Check `event.source === window.parent` and `type === 'CRIBL_APP_LAYOUT'`.
  - For charts, pass the theme through `onTheme` state.
  - Add `:root { color-scheme: light dark; }`.
  - Build no theme switcher (`AGENTS.md:354-404`).
- Every destructive or overwriting call needs a deliberate click, a confirmation naming exactly what is affected (with an irreversibility warning where it applies), and an outcome report. Never trigger one on load, render or a timer (`AGENTS.md:78-91`).
- Navigation: use a router `<Link>` with `basename={window.CRIBL_BASE_PATH}`. Links that leave the app need `target="_top"` or `_blank` (`AGENTS.md:326-352`).
- User identity comes from `await window.getCriblUser()`. It returns `{ id, username, email?, firstName?, lastName?, initials? }` and is memoized (`AGENTS.md:24-44`).

---

## 13. Gaps: searched for and not found

- **"Review App screen":** no mention in any reference repo or the plugin. Its contents are unknown.
- **"Deploy from Live Preview":** only in `cc-visicore-spl-to-kql/AGENTS.md:557` and `cc-visicore-lake-credit-usage/README.md:71`, not in the four named repos.
- **"App Settings → External API Access":** only in `cc-cribl-power-tools` and `cc-visicore-spl-to-kql`, not in the four named repos. Their `config/proxies.yml` files are the scaffold's commented placeholder: criblvision and lookup-sync are byte-identical, and di is the same size.
- **Hackathon submission rules:** none visible.
- **The plugin has no packaging, install, Live Preview-debugging or backend guidance at all.** Its references predate `backend.yml` and `schedules.yml`, and it still speaks of `manifest.json`.
