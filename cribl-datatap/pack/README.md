# DataTap — On-Demand Streaming Data

Production-realistic streaming data for 110+ sourcetypes. Install the pack, enable a source, data flows.

## Quick Start

1. Install this pack via **Packs > Add Pack**
2. Go to **Data > Sources > Datagen**
3. **datatap-top10** is already enabled and streaming
4. Enable any other category you need
5. Data routes to your configured destinations automatically

## Sources

| Source | Sourcetypes | Default EPS | Use Case |
|--------|-------------|-------------|----------|
| **datatap-top10** | PAN, syslog, WinEventLog, CrowdStrike, Okta, ASA, CloudTrail, FortiGate, DNS, K8s | 10 | General demo |
| **datatap-security** | 12 security sources | 10 | SIEM/SOC testing |
| **datatap-prometheus** | Prometheus only (high-cardinality scrape-like output) | 100 | Cardinality reduction |
| **datatap-metrics** | Prometheus, StatsD, Graphite, InfluxDB, CloudWatch, OTel | 100 | Mixed metric formats |
| **datatap-network** | PAN, ASA, FortiGate, Check Point, pfSense, NetFlow, Zeek, Suricata | 10 | Firewall/IDS |
| **datatap-endpoint** | CrowdStrike, SentinelOne, Carbon Black, Defender, Cortex XDR, Wazuh, Elastic | 10 | EDR pipelines |
| **datatap-identity** | Okta, Duo, Azure AD, Auth0, CyberArk, BeyondTrust | 10 | IAM/auth |
| **datatap-cloud-aws** | CloudTrail, GuardDuty, VPC Flow, Lambda, WAF, Config, SecurityHub, Route53 | 10 | AWS security |
| **datatap-cloud-azure** | AAD Sign-in, Activity, NSG Flow, Firewall, Key Vault, O365 | 10 | Azure security |
| **datatap-cloud-gcp** | Audit, Firewall, Logging | 10 | GCP |
| **datatap-o11y** | Prometheus, OTel, Jaeger, Log4j, Pino, K8s, Docker, Sentry, healthcheck | 10 | APM/monitoring |
| **datatap-devops** | K8s audit/events, Jenkins, GitLab, ArgoCD, Terraform, Docker | 10 | CI/CD |
| **datatap-applog** | Java Log4j, Python, Node Pino, Go slog, .NET, Apache, Nginx | 10 | App log testing |
| **datatap-scenario-bruteforce** | PAN, Okta, WinEventLog, CrowdStrike, syslog | 10 | Attack simulation |
| **datatap-scenario-normalday** | Mixed enterprise traffic | 10 | Baseline activity |

## Volume Control

Change `eventsPerSec` in any source's settings. Suggested profiles:
- **Demo**: 10 EPS
- **Testing**: 100 EPS
- **Load test**: 1000 EPS

## Data Quality

- **Cross-event correlation**: Same users/IPs across sourcetypes within 5-minute windows
- **Semantic accuracy**: CloudTrail source-action mapping, Okta event-outcome coherence
- **Vendor-accurate formats**: PAN CSV (77 fields), WinEventLog XML, proper JSON schemas
- **High-cardinality metrics**: Unique pod/instance labels per Prometheus event
- **110+ sourcetypes** in a 58KB engine

## Using with Other Packs

Install DataTap alongside your pack. Enable the matching category source. Route DataTap output through your pipeline. Realistic data flows immediately.

## Custom Sourcetypes

Need a single specific sourcetype? Create a Datagen source with pipeline `cribl-datatap:datatap_generate` and any sample (e.g., `datatap_pan_traffic`).

## Requirements

Cribl Stream 4.0.0+. No external dependencies.

(c) DataDay Technology Solutions
