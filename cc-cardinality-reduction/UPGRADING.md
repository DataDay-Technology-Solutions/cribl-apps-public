# Upgrading the Cardinality Reduction Pack

This document tracks operator-visible breaking changes and prescribes the upgrade procedure by deployment topology.

---

## v3.x → v4.0.0 (BREAKING)

Do these four things, in order:

1. **Re-enter your configuration in the Variables UI.** v4 ships real pack variables (Cribl UI → Packs → cc-cardinality-reduction → Settings → Variables). The v3 `package.json` "variables" mechanism was never read by Cribl — whatever you "configured" there was not in effect; the engine ran on built-in defaults (audit mode). Verify each of the 12 variables, especially `DRY_RUN`.
2. **Update every saved search, dashboard, and route filter from `__cr_*` to `cr_*`** (`cr_risk`, `cr_route_tier`, `cr_would_modify`, `cr_categories`, `cr_error`, …). The old `__cr_*` names were stripped by Cribl before delivery and never reached your destination. Route filters inside Cribl referencing `__cr_risk`/`__cr_route_tier` must be updated too — those fields no longer exist under the old names.
3. **Stop running `install-samples.sh`** — it's gone. Samples now live at the pack-native `data/samples/` location and appear in the Sample Data picker automatically. No restart needed for sample visibility.
4. **Run `tools/post_install_check.sh` and `tools/upgrade_check.sh`** as before. Note the dev/perf harnesses (`perf_regression.sh`, `eval_harness.js`, …) no longer ship in the pack; they live in the repository's `tests/cc-cardinality-reduction/`.

Behavioral changes to be aware of: syslog-shaped `_raw` lines are no longer misparsed as Prometheus metrics; histogram `le` values are matched numerically (`le="1.0"` is now correctly kept); `DRY_RUN=off`/`0`/`no` now behaves as live in **every** stage, not just the engine; and `sort_key`/`partition_key`/`routing_key`-style fields are no longer redacted.

The v3.x procedure below is retained for upgrades within the v3 line.

---

## Standard upgrade procedure — by topology

The pack supports two deployment topologies. **Pick the right column** before running tools.

| Step | Single-instance / Edge / Dev / Staging | Production-distributed (cluster) |
|---|---|---|
| 1. Snapshot pack vars | Cribl UI → Pack Settings → Export | Cribl UI → Pack Settings → Export |
| 2. Upload tarball | Cribl UI → Packs → Update | Cribl UI on **leader** → Packs → Update |
| 3. Install samples for UI preview | `tools/install-samples.sh` | **SKIP** — see "Why" below |
| 4. Reload | `systemctl restart cribl` (or restart container) | `systemctl restart cribl` on **leader only** |
| 5. Distribute to workers | n/a | Cribl UI → Commit & Deploy (auto-replicates pack files to workers) |
| 6. Verify health | `tools/post_install_check.sh` | `tools/post_install_check.sh` (auto-detects cluster mode) |
| 7. Audit deprecated vars | `tools/upgrade_check.sh` | `tools/upgrade_check.sh` |
| 8. Perf gate (CI) | `tools/perf_regression.sh` | `tools/perf_regression.sh` |

### Why skip `install-samples.sh` on a production cluster

The script writes to **shared global Cribl state** (`$CRIBL_HOME/data/samples/` and `$CRIBL_HOME/default/cribl/samples.yml`). It exists to make the in-UI Sample Data picker show pack-bundled samples — a Cribl 4.17 dev affordance that production operators don't use. Running it on a prod cluster:

- adds operational toil (must be re-run on every leader of every group)
- creates cross-pack pollution risk (other packs that ship installers may collide)
- isn't propagated by Cribl's Commit & Deploy
- doesn't change pipeline behavior in any way

**The pipeline operates correctly without this step.** Use it in dev/staging where evaluators preview samples in the UI; skip it in prod.

In v3.17.2+ the script auto-detects cluster mode and prompts for confirmation. In `--auto` mode (CI) it refuses to run on a cluster. Use `--force` to override if you really need it.

### Cluster-aware health check

`tools/post_install_check.sh` adapts to topology:
- On `single` distMode: missing samples = failure (run `install-samples.sh`)
- On `master`/`cluster` distMode: missing samples = expected (uses `apache_common` for smoke test)
- `--strict` flag treats missing samples as failure regardless of mode (for parity testing)
- `--json` flag outputs machine-readable JSON for CI gating

---

## Per-version migration notes

### v3.17.1 → v3.17.2 (current)
- **No breaking changes.** Tooling polish: `install-samples.sh` and `post_install_check.sh` now auto-detect cluster mode.
- Existing operator workflows continue to work — interactive runs prompt; `--force` reproduces old behavior.

### v3.7.0 → v3.17.1
- **No breaking changes.** Pure additions: 4 new pack vars (`OMIT_NONE_TAGS`, `DEBUG_MODE`, `ENABLE_PII_DETECTION`, `iconUrl`), 8 new tooling scripts, 5 new Cribl metrics, several new `__cr_*` event fields.

### v3.5.7 → v3.6.x
- **No breaking changes.** Pack vars + sample names unchanged. Adds `tools/perf_bench.js` and `tools/perf_regression.sh`.

### v3.5.x internal jumps
- v3.5.0 → v3.5.3: pipeline path moved (`default/cribl/pipelines/...` → `default/pipelines/...`). Reinstall handles automatically.
- v3.5.6 → v3.5.7: bundled samples renamed `.log` → `.json` and global registration required for in-UI sample preview (single-instance only).

### v3.4.x → v3.5.7
- Single-instance: run `tools/install-samples.sh` after install.
- Cluster: skip — pipeline works without it.
- All vars carry through; defaults unchanged.

### v3.3.x → v3.4.x
- `ENABLE_RAW_SCANNING` deprecated (read but ignored). Remove from operator config to silence audit warnings.

### v3.0.0 → v3.3.0
- Pack underwent significant rewrites; clean reinstall recommended.
- `STRIP_CR_METADATA` and `field_group_mapping.csv` / `cardinality_rules.csv` were never wired up — ignore.

---

## Distributed-deploy automation examples

### Single-leader cluster (Ansible)

```yaml
- name: Deploy cc-cardinality-reduction to Cribl cluster
  hosts: cribl_leader      # ONLY leader; workers get config via Commit & Deploy
  become: yes
  become_user: cribl
  tasks:
    - name: Upload tarball
      uri:
        url: "{{ cribl_url }}/api/v1/packs?filename=cc-cardinality-reduction.tgz&id=cc-cardinality-reduction"
        method: PUT
        src: "./cc-cardinality-reduction-{{ pack_version }}.tgz"
        headers: { Authorization: "Bearer {{ cribl_token }}" }
      register: upload

    - name: Activate
      uri:
        url: "{{ cribl_url }}/api/v1/packs"
        method: POST
        body_format: json
        body: { id: cc-cardinality-reduction, source: "{{ upload.json.source }}" }
        headers: { Authorization: "Bearer {{ cribl_token }}" }

    # NOTE: NOT running install-samples.sh here — production cluster

    - name: Health check (auto-detects cluster mode, --json for CI)
      shell: |
        {{ cribl_home }}/default/cc-cardinality-reduction/tools/post_install_check.sh --json
      environment:
        CRIBL_URL: "{{ cribl_url }}"
        CRIBL_USER: "{{ vault_cribl_user }}"
        CRIBL_PASS: "{{ vault_cribl_pass }}"
      register: health
      failed_when: (health.stdout | from_json).ok == false

    - name: Commit & Deploy to workers
      uri:
        url: "{{ cribl_url }}/api/v1/master/groups/{{ worker_group }}/deploy"
        method: POST
        headers: { Authorization: "Bearer {{ cribl_token }}" }
```

### Multi-leader HA / multi-region cluster

```yaml
# inventory.yml
all:
  children:
    cribl_leaders:        # all leader nodes (active-active or HA pairs)
      hosts:
        cribl-leader-us-east-1.internal: { region: us-east-1 }
        cribl-leader-us-west-2.internal: { region: us-west-2 }
        cribl-leader-eu-west-1.internal: { region: eu-west-1 }
    cribl_workers:        # informational; deploy uses Commit & Deploy from leader
      hosts:
        cribl-worker-[01:48].internal:
          region: "{{ inventory_hostname | regex_replace('cribl-worker-([0-9]+).*', 'us-east-1') }}"

# play.yml
- name: Deploy cc-cardinality-reduction to ALL leaders (HA-safe)
  hosts: cribl_leaders
  serial: 1                     # one leader at a time — never deploy to all simultaneously
  max_fail_percentage: 0        # any failure aborts the rollout
  become: yes
  become_user: cribl
  tasks:
    - name: Upload + activate (per-leader)
      include_tasks: cribl-pack-upload.yml
      vars:
        cribl_url: "https://{{ inventory_hostname }}:9000"

    - name: Wait for Cribl to settle (60s)
      pause: { seconds: 60 }

    - name: Verify health (--strict + --json)
      shell: |
        {{ cribl_home }}/default/cc-cardinality-reduction/tools/post_install_check.sh --strict --json
      environment:
        CRIBL_URL: "https://{{ inventory_hostname }}:9000"
        CRIBL_USER: "{{ vault_cribl_user }}"
        CRIBL_PASS: "{{ vault_cribl_pass }}"
      register: h
      failed_when: (h.stdout | from_json).ok == false

    - name: Commit & Deploy to this leader's worker group
      uri:
        url: "https://{{ inventory_hostname }}:9000/api/v1/master/groups/{{ region }}/deploy"
        method: POST
        headers: { Authorization: "Bearer {{ cribl_token_per_leader[inventory_hostname] }}" }
```

The `serial: 1` + `max_fail_percentage: 0` combination ensures a regional outage is contained: if `us-east-1` deploys cleanly but `us-west-2` fails health, the rollout halts and `eu-west-1` keeps running the previous version.

### Terraform + Cribl Cloud (managed leaders)

If you're on Cribl Cloud, the leader is managed; you upload via the API only:

```hcl
resource "null_resource" "deploy_pack" {
  triggers = { pack_sha = filesha256("dist/cc-cardinality-reduction-${var.pack_version}.tgz") }
  provisioner "local-exec" {
    command = <<-EOT
      curl -fsSL -X PUT \
        -H "Authorization: Bearer ${var.cribl_token}" \
        --data-binary "@dist/cc-cardinality-reduction-${var.pack_version}.tgz" \
        "${var.cribl_url}/api/v1/packs?id=cc-cardinality-reduction&filename=cc-cardinality-reduction.tgz" \
      | jq -r '.source' \
      | xargs -I{} curl -fsSL -X POST \
        -H "Authorization: Bearer ${var.cribl_token}" \
        -H "Content-Type: application/json" \
        -d '{"id":"cc-cardinality-reduction","source":"{}"}' \
        "${var.cribl_url}/api/v1/packs"
    EOT
  }
}
```

---

## Rollback
Cribl Stream's pack manager keeps every previous tarball under `state/packs/`. To roll back:
```bash
ls $CRIBL_HOME/state/packs/    # find previous .tgz
# Reinstall from that tarball via UI or API
```
Operator-set pack vars persist across rollback. The pack's `__cr_pack_version` stamp (under `VERBOSE_AUDIT_METADATA=true`) lets dashboards confirm which version is live.

---

## Demo / evaluator path (single-instance, dev only)

For a fast 30-second demo on a fresh Cribl install:
```bash
$CRIBL_HOME/default/cc-cardinality-reduction/tools/quickstart.sh
```
This installs samples + restarts + runs the smoke test. Designed for laptops and demo environments — **do not run on production hosts**.
