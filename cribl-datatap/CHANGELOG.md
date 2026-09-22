# Changelog

All notable changes to Cribl DataTap will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v3.0.0] - 2026-04-10

### Changed
- **BREAKING**: Replaced 115 flat datagen sources with 15 organized category sources
- Rewrote README with quick start guide, source table, volume profiles
- Bumped package version to 3.0.0

### Added
- 9 new category sources: metrics, network, endpoint, identity, cloud-aws, cloud-azure, cloud-gcp, devops, applog
- Dedicated `datatap-prometheus` source at 100 EPS for cardinality reduction testing
- Hand-coded Prometheus generator: scrape-like output, histogram families, high-cardinality pod/instance labels
- Cross-event correlation via time-windowed 6-user session pool (same user+IP across PAN/Okta/WinEvent/CrowdStrike/Zscaler)
- CloudTrail eventSource-to-eventName mapping table (ec2->RunInstances, s3->PutObject, etc.)
- CloudTrail requestParameters populated per service (instanceId, bucketName, userName)
- Okta eventType-to-severity-to-outcome coherence map (7 event types with valid combinations)
- Okta actor.displayName derived from actor.alternateId (no more identity mismatch)
- PAN subtype derived from action (no more subtype=deny+action=allow)
- host field set on every output event for Splunk routing
- Descriptions on every datagen source listing component sourcetypes

### Fixed
- User diversity: 6-user session pool replaces fixed ali.bailey
- PAN action ratios: ~78% allow (was 52%)
- PAN protocol ratios: ~78% TCP, ~19% UDP, ~3% ICMP
- PAN field count: 77 CSV fields (was 64)
- CloudTrail Root identity no longer gets role ARN
- Okta geographicalContext consistent per session user
- Zeek DNS: tab-separated (was space-separated)
- Apache/Nginx: zero-padded timestamps, proper quoted request line
- Nginx: removed unexpanded {U} token
- InfluxDB: fixed {H} token inside {S:} nesting
- Removed 15 orphaned 1-event sample stubs

### Improved
- Template depth: GuardDuty 5->16 fields, SentinelOne 7->16, CarbonBlack 7->16, ElasticSecurity 8->19, CortexXDR 8->15
- Deepened Duo, Azure AD, Suricata, Darktrace, Vectra, Proofpoint, O365 templates
- Engine size: 58.2KB (under 58.5KB Cribl limit)

## [v2.0.1] - 2026-04-04

### Added
- 110 sourcetypes (10 hand-coded + 100 template-based)
- Micro-template engine with 58KB inline Code function
- Deterministic seeded PRNG for correlation
- Time-aware generation (business hours, rush hour, night)
- Brute-force attack scenario with phase progression
- 115 datagen sources via install script

## [v0.1.0] - 2026-03-30

### Added
- Initial project scaffolding and architecture
- CLI interface with zero external dependencies (`generate`, `stream`, `scenario`, `list`, `info` commands)
- Main library entry point with `DataTap` class exposing `generate()`, `stream()`, `runScenario()`, and `stop()`
- 5 sourcetype definitions: `pan:traffic`, `okta:system`, `WinEventLog:Security`, `syslog`, `crowdstrike:falcon:event`
- 4 scenario definitions: `brute-force`, `normal-day`, `data-exfil`, `insider-threat`
- Sourcetype definition loader with alias resolution and caching
- Scenario registry with lookup and listing APIs
- Field randomizer modules: network, identity, temporal, security, geo
- Multiple output formats: raw, JSON, NDJSON, CSV
- ANSI-colored CLI output with live streaming stats on stderr
- Pipe-friendly design (event data on stdout, status on stderr)
- Graceful shutdown handling (SIGINT/SIGTERM)
