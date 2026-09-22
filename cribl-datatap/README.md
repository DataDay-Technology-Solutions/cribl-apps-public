# DataTap — Streaming Sample Data for Cribl Stream

110+ sourcetypes. 13 scenarios. One copy-paste install.

## Install

Copy and paste this into your terminal. Replace `$CRIBL_HOME` with your Cribl install path (default: `/opt/cribl`).

```bash
cd $CRIBL_HOME && \
git clone --depth 1 https://github.com/DataDay-Technology-Solutions/cribl-apps-public.git /tmp/datatap-install && \
cp /tmp/datatap-install/cribl-datatap/pack/default/data/samples/datatap_*.json data/samples/ && \
mkdir -p local/cribl/pipelines/datatap_generate && \
cp /tmp/datatap-install/cribl-datatap/pack/default/cribl/pipelines/datatap_generate/conf.yml local/cribl/pipelines/datatap_generate/ && \
cp /tmp/datatap-install/cribl-datatap/pack/default/cribl/samples.yml local/cribl/samples.yml && \
cp /tmp/datatap-install/cribl-datatap/pack/default/cribl/inputs_standalone.yml local/cribl/inputs.yml && \
rm -rf /tmp/datatap-install && \
echo "DataTap installed. Restart Cribl or commit to git."
```

Then either:
- **Git-managed Cribl:** `git add -A && git commit -m "Add DataTap" && git push` — Cribl syncs automatically
- **Standalone Cribl:** Restart Cribl: `$CRIBL_HOME/bin/cribl restart`
- **Docker:** `bash scripts/install.sh` auto-detects your container and handles everything

Open Cribl UI → **Data > Sources > Datagen** → `datatap-top10` is streaming.

## Sources

Enable any source in **Data > Sources > Datagen**. Click it, toggle Enabled, save.

| Source | What it streams | EPS |
|--------|----------------|-----|
| **datatap-top10** (on by default) | PAN, syslog, WinEventLog, CrowdStrike, Okta, ASA, CloudTrail, FortiGate, DNS, K8s | 10 |
| **datatap-prometheus** | High-cardinality Prometheus metrics (unique pod/instance per event) | 100 |
| **datatap-metrics** | Prometheus + StatsD + Graphite + InfluxDB + CloudWatch + OTel | 100 |
| **datatap-security** | 12 security sources | 10 |
| **datatap-network** | PAN, ASA, FortiGate, Check Point, pfSense, NetFlow, Zeek, Suricata | 10 |
| **datatap-endpoint** | CrowdStrike, SentinelOne, Carbon Black, Defender, Cortex XDR, Wazuh, Elastic | 10 |
| **datatap-identity** | Okta, Duo, Azure AD, Auth0, CyberArk, BeyondTrust | 10 |
| **datatap-cloud-aws** | CloudTrail, GuardDuty, VPC Flow, Lambda, WAF, Config, SecurityHub, Route53 | 10 |
| **datatap-cloud-azure** | AAD Sign-in, Activity, NSG Flow, Firewall, Key Vault, O365 | 10 |
| **datatap-cloud-gcp** | Audit, Firewall, Logging | 10 |
| **datatap-o11y** | Prometheus, OTel, Jaeger, Log4j, Pino, K8s, Docker, Sentry | 10 |
| **datatap-devops** | K8s audit/events, Jenkins, GitLab, ArgoCD, Terraform, Docker | 10 |
| **datatap-applog** | Java Log4j, Python, Node Pino, Go slog, .NET, Apache, Nginx | 10 |

## Scenarios

Attack and ops scenarios with phased timelines and correlated data across sourcetypes. Same attacker IP appears in every event.

| Scenario | Story |
|----------|-------|
| **datatap-scenario-bruteforce** | Credential stuffing → account lockout → success → CrowdStrike detection |
| **datatap-scenario-exfiltration** | S3 bulk reads → DNS tunneling → large transfers → detection |
| **datatap-scenario-lateral** | Scanning → RDP/PsExec to servers → privilege escalation → DC access |
| **datatap-scenario-ransomware** | Malware exec → shadow delete → file encryption → CrowdStrike critical alert |
| **datatap-scenario-insider** | After-hours access → bulk download → cloud upload (mega.nz, wetransfer) |
| **datatap-scenario-cloud** | Stolen creds → IAM key creation → S3 exfil → CloudTrail disabled |
| **datatap-scenario-phishing** | Email delivered → cred harvested → mailbox rules → OAuth consent |
| **datatap-scenario-cryptomining** | Mining pool DNS → EC2 launches → high CPU → pool connections |
| **datatap-scenario-mfa-fatigue** | Rapid MFA push rejections → user accepts → attacker gains access |
| **datatap-scenario-supply-chain** | Bad package → unusual child process → C2 beacon → credential access |
| **datatap-scenario-outage** | Health checks fail → pod restarts → cascade → recovery |
| **datatap-scenario-deploy-fail** | Jenkins build → K8s update → crash loop → rollback |
| **datatap-scenario-normalday** | Baseline enterprise traffic |

## Stream Your Own Data

Paste a few events from your app. DataTap auto-randomizes IPs, timestamps, and UUIDs while keeping your structure intact.

1. **Knowledge > Samples > Add Sample** — paste your events
2. **Data > Sources > Datagen > Add Source** — set pipeline to `datatap_generate`, pick your sample
3. Enable → data streams with variance

## Requirements

Cribl Stream 4.0.0+. No other dependencies.

## License

(c) DataDay Technology Solutions
