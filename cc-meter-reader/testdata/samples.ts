/**
 * Synthetic, seeded Datagen samples for the Meter Reader demo rig (SPEC 14.2, PRD 9).
 *
 *   npx tsx testdata/samples.ts            # writes demo/rig/samples/*.{log,json} + manifest.json
 *   npx tsx testdata/samples.ts --check    # regenerates in memory and fails if the files on disk differ
 *
 * Every value is fabricated. Hostnames live under example.com, addresses come only from 10.0.0.0/8 and
 * the documentation ranges 192.0.2.0/24, 198.51.100.0/24 and 203.0.113.0/24, account numbers are the
 * AWS documentation placeholders, and users are role accounts (svc_*, user0NNN). Same seed, same bytes.
 *
 * File format. Each file is ONE JSON array of `{ _raw, _time }` events: the exact shape the sample
 * library stores (`POST /m/<gid>/system/samples` takes `context.events`), and the shape a Datagen
 * needs (an NDJSON sample installs but every read of it fails; docs/platform/config-apis.md §4).
 * The SPEC file names are kept so the rig definition and the docs agree.
 *
 * Composition matters because the rig's measured savings ratios come from these bytes:
 *   - api-access: `headers` + `user_agent` + `request_body` are ≈ 52% of every event, so the
 *     `[mr-trim]` Eval in mrd_pay_sample is worth ≥ 25 ratio points after 1:2 sampling (0.50 → ≈ 0.76).
 *   - k8s-container: ≈ 40% of the bytes are `level: debug` (dropped) and `labels` is ≈ 50% of every
 *     remaining event (trimmed), so mrd_k8s_noise lands at ≈ 0.70.
 *   - vpc-flow-v2: a small set of repeating (srcaddr, dstaddr, dstport, action) tuples, so a one-minute
 *     aggregation has something to collapse.
 * `main()` asserts each of these and exits non-zero if a change to a generator breaks one.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Public shapes ──────────────────────────────────────────────────────────────

/** One event exactly as the sample library stores it. */
export interface SampleEvent {
  _raw: string;
  _time: number; // epoch seconds
}

/** Byte-composition facts a sample must satisfy for the rig's target ratios. */
export interface Composition {
  /** fraction of total `_raw` bytes that the `[mr-trim]` function removes (api-access, k8s) */
  trimFraction?: number;
  /** fraction of total `_raw` bytes carried by events the pipeline drops (k8s debug) */
  dropFraction?: number;
  /** fraction of events the pipeline drops (k8s debug) */
  dropEventFraction?: number;
  /** distinct aggregation keys (vpc: srcaddr|dstaddr|dstport|action) */
  distinctKeys?: number;
  /** event count per Windows EventID */
  eventIds?: Record<string, number>;
}

export interface GeneratedSample {
  /** stable key used by the rig definition (demo/rig/sources.json) */
  key:
    | "windows_security_xml"
    | "pan_traffic"
    | "vpc_flow_v2"
    | "api_access"
    | "k8s_container";
  /** file under demo/rig/samples/ (SPEC 1 / 14.2 names) */
  file: string;
  /**
   * Sample-library id and name used for the upload (demo-tagged, `mrd_` prefix). They are identical on
   * purpose: a Datagen Source's `samples[].sample` ("Data Generator File Name") then resolves whether
   * the Leader matches it against the record's id or its sampleName.
   */
  sampleId: string;
  sampleName: string;
  description: string;
  events: SampleEvent[];
  composition: Composition;
}

export interface SampleStats {
  events: number;
  totalBytes: number;
  avgEventBytes: number;
  minEventBytes: number;
  maxEventBytes: number;
  /** size of the `POST /system/samples` body for this sample (must stay under ~90 KB) */
  uploadBodyBytes: number;
}

export const DEMO_TOKEN = "[meter-reader-demo]";
export const DEFAULT_SEED = 20260926;
/** Leader request-body ceiling observed in the spike is ~100 KB; stay well under it. */
export const MAX_UPLOAD_BODY_BYTES = 90_000;
/** 2026-09-26T00:00:00Z — samples carry fixed times; Datagen stamps events as it emits them. */
const BASE_EPOCH = Date.UTC(2026, 8, 26, 0, 0, 0) / 1000;

// ─── Seeded randomness ──────────────────────────────────────────────────────────

/** mulberry32: tiny, fast, good enough for fabricating log lines deterministically. */
export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)] as T;
  }
  /** Weighted choice over `[value, weight]` pairs. */
  weighted<T>(pairs: readonly (readonly [T, number])[]): T {
    const total = pairs.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [v, w] of pairs) {
      r -= w;
      if (r < 0) return v;
    }
    return (pairs[pairs.length - 1] as readonly [T, number])[0];
  }
  hex(len: number): string {
    let s = "";
    for (let i = 0; i < len; i++) s += "0123456789abcdef"[this.int(0, 15)];
    return s;
  }
  guid(): string {
    return `${this.hex(8)}-${this.hex(4)}-${this.hex(4)}-${this.hex(4)}-${this.hex(12)}`;
  }
  alnum(len: number): string {
    const a = "abcdefghijklmnopqrstuvwxyz0123456789";
    let s = "";
    for (let i = 0; i < len; i++) s += a[this.int(0, a.length - 1)];
    return s;
  }
}

// ─── Address and name pools (documentation / private ranges only) ───────────────

const ip10 = (r: Rng, second: number): string =>
  `10.${second}.${r.int(0, 15)}.${r.int(2, 254)}`;
const ipDoc = (r: Rng): string =>
  `${r.pick(["192.0.2", "198.51.100", "203.0.113"])}.${r.int(1, 254)}`;
const ROLE_USERS = [
  "svc_backup",
  "svc_sql",
  "svc_deploy",
  "svc_monitor",
  "admin.ops01",
  "admin.ops02",
] as const;
const userN = (r: Rng): string =>
  `user${String(r.int(100, 1999)).padStart(4, "0")}`;
const pad2 = (n: number): string => String(n).padStart(2, "0");
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function isoAt(epochSec: number, fracDigits: number, r: Rng): string {
  const d = new Date(epochSec * 1000);
  const frac =
    fracDigits > 0
      ? "." + String(r.int(0, 10 ** fracDigits - 1)).padStart(fracDigits, "0")
      : "";
  return d.toISOString().slice(0, 19) + frac + "Z";
}
/** `2026/09/26 00:00:07` (PAN-OS time format). */
function panTime(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  return `${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}
/** `Sep 26 00:00:07` (RFC 3164 syslog header time). */
function syslogTime(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const day = String(d.getUTCDate()).padStart(2, " ");
  return `${MONTHS[d.getUTCMonth()]} ${day} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}
const bytesOf = (s: string): number => Buffer.byteLength(s, "utf8");

// ─── 1. Windows Security events, Splunk forwarder XML (4624 / 4688 / 4663) ─────

const WIN_NS = "http://schemas.microsoft.com/win/2004/08/events/event";
const WIN_PROVIDER =
  "<Provider Name='Microsoft-Windows-Security-Auditing' Guid='{54849625-5478-4994-a5ba-3e3b0328c30d}'/>";
const DOMAIN = "CORP";
const DC_HOSTS = ["DC01", "DC02", "DC03"] as const;
const WS_HOSTS = Array.from(
  { length: 12 },
  (_, i) => `WS-${String(1040 + i * 7)}`,
);

interface WinCtx {
  r: Rng;
  time: number;
  computer: string; // short name
  recordId: number;
}

const sid = (r: Rng): string =>
  `S-1-5-21-3623811015-3361044348-30300820-${r.int(1100, 9800)}`;
const logonId = (r: Rng): string => `0x${r.hex(r.int(5, 7))}`;

function winSystem(
  c: WinCtx,
  eventId: number,
  task: number,
  version: number,
  keywords: string,
): string {
  const { r } = c;
  return (
    `<System>${WIN_PROVIDER}<EventID>${eventId}</EventID><Version>${version}</Version><Level>0</Level>` +
    `<Task>${task}</Task><Opcode>0</Opcode><Keywords>${keywords}</Keywords>` +
    `<TimeCreated SystemTime='${isoAt(c.time, 7, r)}'/><EventRecordID>${c.recordId}</EventRecordID>` +
    `<Correlation ActivityID='{${r.guid().toUpperCase()}}'/><Execution ProcessID='${r.pick([636, 644, 704])}' ThreadID='${r.int(700, 9000)}'/>` +
    `<Channel>Security</Channel><Computer>${c.computer}.corp.example.com</Computer><Security/></System>`
  );
}

/** Splunk renders EventData as one `<Data Name='…'>` element per field. */
function winData(fields: readonly (readonly [string, string])[]): string {
  return (
    "<EventData>" +
    fields
      .map(([k, v]) =>
        v === "" ? `<Data Name='${k}'/>` : `<Data Name='${k}'>${v}</Data>`,
      )
      .join("") +
    "</EventData>"
  );
}

/**
 * RenderingInfo as the Splunk forwarder emits it with renderXml = true: the localized Message
 * (multi-line, tab-indented, which the Windows XML pack's first Eval normalizes) plus the rendered
 * Level/Task/Opcode/Channel/Provider/Keywords.
 */
function winRendering(message: string, task: string, keyword: string): string {
  return (
    `<RenderingInfo Culture='en-US'><Message>${message}</Message><Level>Information</Level><Task>${task}</Task>` +
    `<Opcode>Info</Opcode><Channel>Security</Channel><Provider>Microsoft Windows security auditing.</Provider>` +
    `<Keywords><Keyword>${keyword}</Keyword></Keywords></RenderingInfo>`
  );
}

function win4624(c: WinCtx): string {
  const { r } = c;
  const target = r.weighted([
    [r.pick(ROLE_USERS), 3],
    [userN(r), 5],
    [`${c.computer}$`, 2],
  ] as const);
  const logonType = r.weighted([
    ["3", 6],
    ["2", 1],
    ["10", 1],
    ["5", 2],
  ] as const);
  const ip =
    logonType === "5" ? "-" : r.next() < 0.7 ? ip10(r, r.int(1, 40)) : ipDoc(r);
  const port = ip === "-" ? "-" : String(r.int(49152, 65535));
  const auth = logonType === "3" ? r.pick(["Kerberos", "NTLM"]) : "Negotiate";
  const lsid = sid(r);
  const lid = logonId(r);
  const guid = `{${r.guid().toUpperCase()}}`;
  const proc =
    logonType === "5"
      ? "C:\\Windows\\System32\\services.exe"
      : logonType === "3"
        ? "-"
        : "C:\\Windows\\System32\\svchost.exe";
  const fields: [string, string][] = [
    ["SubjectUserSid", "S-1-5-18"],
    ["SubjectUserName", `${c.computer}$`],
    ["SubjectDomainName", DOMAIN],
    ["SubjectLogonId", "0x3e7"],
    ["TargetUserSid", lsid],
    ["TargetUserName", target],
    ["TargetDomainName", DOMAIN],
    ["TargetLogonId", lid],
    ["LogonType", logonType],
    ["LogonProcessName", auth === "Kerberos" ? "Kerberos" : "NtLmSsp "],
    ["AuthenticationPackageName", auth],
    ["WorkstationName", logonType === "3" ? r.pick(WS_HOSTS) : "-"],
    ["LogonGuid", guid],
    ["TransmittedServices", "-"],
    ["LmPackageName", auth === "NTLM" ? "NTLM V2" : "-"],
    ["KeyLength", auth === "NTLM" ? "128" : "0"],
    ["ProcessId", proc === "-" ? "0x0" : `0x${r.hex(3)}`],
    ["ProcessName", proc],
    ["IpAddress", ip],
    ["IpPort", port],
    ["ImpersonationLevel", "%%1833"],
    ["RestrictedAdminMode", "-"],
    ["TargetOutboundUserName", "-"],
    ["TargetOutboundDomainName", "-"],
    ["VirtualAccount", "%%1843"],
    ["TargetLinkedLogonId", "0x0"],
    ["ElevatedToken", r.pick(["%%1842", "%%1843"])],
  ];
  const msg =
    `An account was successfully logged on.\r\n\r\nSubject:\r\n\tSecurity ID:\t\tS-1-5-18\r\n\tAccount Name:\t\t${c.computer}$\r\n` +
    `\tAccount Domain:\t\t${DOMAIN}\r\n\tLogon ID:\t\t0x3E7\r\n\r\nLogon Information:\r\n\tLogon Type:\t\t${logonType}\r\n` +
    `\tRestricted Admin Mode:\t-\r\n\tVirtual Account:\t\tNo\r\n\tElevated Token:\t\tYes\r\n\r\nImpersonation Level:\t\tImpersonation\r\n\r\n` +
    `New Logon:\r\n\tSecurity ID:\t\t${lsid}\r\n\tAccount Name:\t\t${target}\r\n\tAccount Domain:\t\t${DOMAIN}\r\n\tLogon ID:\t\t${lid.toUpperCase()}\r\n` +
    `\tLinked Logon ID:\t\t0x0\r\n\tNetwork Account Name:\t-\r\n\tNetwork Account Domain:\t-\r\n\tLogon GUID:\t\t${guid}\r\n\r\n` +
    `Process Information:\r\n\tProcess ID:\t\t${proc === "-" ? "0x0" : "0x2a8"}\r\n\tProcess Name:\t\t${proc}\r\n\r\n` +
    `Network Information:\r\n\tWorkstation Name:\t-\r\n\tSource Network Address:\t${ip}\r\n\tSource Port:\t\t${port}\r\n\r\n` +
    `Detailed Authentication Information:\r\n\tLogon Process:\t\t${auth}\r\n\tAuthentication Package:\t${auth}\r\n\tTransited Services:\t-\r\n` +
    `\tPackage Name (NTLM only):\t-\r\n\tKey Length:\t\t0`;
  return `<Event xmlns='${WIN_NS}'>${winSystem(c, 4624, 12544, 2, "0x8020000000000000")}${winData(fields)}${winRendering(msg, "Logon", "Audit Success")}</Event>`;
}

const PROCS = [
  [
    "C:\\Windows\\System32\\svchost.exe",
    "C:\\Windows\\system32\\svchost.exe -k netsvcs -p -s Schedule",
  ],
  [
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\ops\\scripts\\inventory.ps1",
  ],
  [
    "C:\\Windows\\System32\\cmd.exe",
    'cmd.exe /c "C:\\ops\\scripts\\rotate-logs.cmd"',
  ],
  [
    "C:\\Program Files\\Example Agent\\agent.exe",
    '"C:\\Program Files\\Example Agent\\agent.exe" --heartbeat --interval 60',
  ],
  [
    "C:\\Windows\\System32\\wbem\\WmiPrvSE.exe",
    "C:\\Windows\\system32\\wbem\\wmiprvse.exe -secured -Embedding",
  ],
  [
    "C:\\Windows\\System32\\conhost.exe",
    "\\??\\C:\\Windows\\system32\\conhost.exe 0xffffffff -ForceV1",
  ],
] as const;

function win4688(c: WinCtx): string {
  const { r } = c;
  const [procName, cmd] = r.pick(PROCS);
  const user = r.next() < 0.5 ? `${c.computer}$` : r.pick(ROLE_USERS);
  const pid = `0x${r.hex(4)}`;
  const ppid = `0x${r.hex(3)}`;
  const parent = r.pick([
    "C:\\Windows\\System32\\services.exe",
    "C:\\Windows\\explorer.exe",
    "C:\\Windows\\System32\\svchost.exe",
  ]);
  const fields: [string, string][] = [
    ["SubjectUserSid", user.endsWith("$") ? "S-1-5-18" : sid(r)],
    ["SubjectUserName", user],
    ["SubjectDomainName", DOMAIN],
    ["SubjectLogonId", user.endsWith("$") ? "0x3e7" : logonId(r)],
    ["NewProcessId", pid],
    ["NewProcessName", procName],
    ["TokenElevationType", r.pick(["%%1936", "%%1937", "%%1938"])],
    ["ProcessId", ppid],
    ["CommandLine", cmd],
    ["TargetUserSid", "S-1-0-0"],
    ["TargetUserName", "-"],
    ["TargetDomainName", "-"],
    ["TargetLogonId", "0x0"],
    ["ParentProcessName", parent],
    ["MandatoryLabel", r.pick(["S-1-16-16384", "S-1-16-12288", "S-1-16-8192"])],
  ];
  const msg =
    `A new process has been created.\r\n\r\nCreator Subject:\r\n\tSecurity ID:\t\tS-1-5-18\r\n\tAccount Name:\t\t${user}\r\n` +
    `\tAccount Domain:\t\t${DOMAIN}\r\n\tLogon ID:\t\t0x3E7\r\n\r\nTarget Subject:\r\n\tSecurity ID:\t\tNULL SID\r\n\tAccount Name:\t\t-\r\n` +
    `\tAccount Domain:\t\t-\r\n\tLogon ID:\t\t0x0\r\n\r\nProcess Information:\r\n\tNew Process ID:\t\t${pid}\r\n\tNew Process Name:\t${procName}\r\n` +
    `\tToken Elevation Type:\t%%1936\r\n\tMandatory Label:\t\tMandatory Label\\System Mandatory Level\r\n\tCreator Process ID:\t${ppid}\r\n` +
    `\tCreator Process Name:\t${parent}\r\n\tProcess Command Line:\t${cmd}`;
  return `<Event xmlns='${WIN_NS}'>${winSystem(c, 4688, 13312, 2, "0x8020000000000000")}${winData(fields)}${winRendering(msg, "Process Creation", "Audit Success")}</Event>`;
}

const OBJECTS = [
  "C:\\Shares\\Finance\\Reports\\q3-close-summary.xlsx",
  "C:\\Shares\\HR\\policies\\handbook-2026.pdf",
  "C:\\Windows\\System32\\config\\SAM",
  "C:\\ProgramData\\Example Agent\\state\\queue.db",
  "C:\\Shares\\Engineering\\builds\\release-5.12.3.zip",
] as const;

function win4663(c: WinCtx): string {
  const { r } = c;
  const user = r.pick([...ROLE_USERS, userN(r)]);
  const obj = r.pick(OBJECTS);
  const mask = r.pick(["0x1", "0x2", "0x10000", "0x20000"]);
  const fields: [string, string][] = [
    ["SubjectUserSid", sid(r)],
    ["SubjectUserName", user],
    ["SubjectDomainName", DOMAIN],
    ["SubjectLogonId", logonId(r)],
    ["ObjectServer", "Security"],
    ["ObjectType", "File"],
    ["ObjectName", obj],
    ["HandleId", `0x${r.hex(3)}`],
    ["AccessList", r.pick(["%%4416", "%%4417", "%%1537"])],
    ["AccessMask", mask],
    ["ProcessId", `0x${r.hex(4)}`],
    [
      "ProcessName",
      r.pick([
        "C:\\Windows\\explorer.exe",
        "C:\\Windows\\System32\\svchost.exe",
        "C:\\Program Files\\Example Agent\\agent.exe",
      ]),
    ],
    ["ResourceAttributes", r.next() < 0.3 ? "S:AI" : ""],
  ];
  const msg =
    `An attempt was made to access an object.\r\n\r\nSubject:\r\n\tSecurity ID:\t\t${DOMAIN}\\${user}\r\n\tAccount Name:\t\t${user}\r\n` +
    `\tAccount Domain:\t\t${DOMAIN}\r\n\tLogon ID:\t\t0x1C2D3E4\r\n\r\nObject:\r\n\tObject Server:\t\tSecurity\r\n\tObject Type:\t\tFile\r\n` +
    `\tObject Name:\t\t${obj}\r\n\tHandle ID:\t\t0x1a4\r\n\tResource Attributes:\t-\r\n\r\nProcess Information:\r\n\tProcess ID:\t\t0x1f3c\r\n` +
    `\tProcess Name:\t\tC:\\Windows\\explorer.exe\r\n\r\nAccess Request Information:\r\n\tAccesses:\t\tReadData (or ListDirectory)\r\n\t\t\t\t\r\n` +
    `\tAccess Mask:\t\t${mask}`;
  return `<Event xmlns='${WIN_NS}'>${winSystem(c, 4663, 12800, 1, "0x8020000000000000")}${winData(fields)}${winRendering(msg, "File System", "Audit Success")}</Event>`;
}

export function windowsSecurityXml(seed: number, count = 33): GeneratedSample {
  const r = new Rng(seed ^ 0x57494e);
  const events: SampleEvent[] = [];
  const ids: Record<string, number> = { "4624": 0, "4688": 0, "4663": 0 };
  let recordId = 18_204_551;
  for (let i = 0; i < count; i++) {
    const time = BASE_EPOCH + i * 2 + r.int(0, 1);
    const computer = r.next() < 0.5 ? r.pick(DC_HOSTS) : r.pick(WS_HOSTS);
    const c: WinCtx = { r, time, computer, recordId: recordId++ };
    const kind = r.weighted([
      ["4624", 45],
      ["4688", 30],
      ["4663", 25],
    ] as const);
    ids[kind] = (ids[kind] ?? 0) + 1;
    const xml =
      kind === "4624" ? win4624(c) : kind === "4688" ? win4688(c) : win4663(c);
    events.push({ _raw: xml, _time: time });
  }
  return {
    key: "windows_security_xml",
    file: "windows-security-xml.log",
    sampleId: "mrd_windows_security_xml",
    sampleName: "mrd_windows_security_xml",
    description: `${DEMO_TOKEN} Synthetic Windows Security events (4624/4688/4663), Splunk forwarder XML with RenderingInfo`,
    events,
    composition: { eventIds: ids },
  };
}

// ─── 2. Palo Alto PAN-OS TRAFFIC over syslog ────────────────────────────────────

/**
 * Field order of a PAN-OS 11.x TRAFFIC log after the leading FUTURE_USE, matching the field list the
 * Palo Alto Networks pack (cribl-palo-alto-networks 1.1.8, pan_traffic) extracts. The syslog header
 * precedes the CSV body.
 */
export const PAN_TRAFFIC_FIELDS = [
  "future_use1",
  "receive_time",
  "serial_number",
  "type",
  "log_subtype",
  "version",
  "generated_time",
  "src_ip",
  "dest_ip",
  "src_translated_ip",
  "dest_translated_ip",
  "rule",
  "src_user",
  "dest_user",
  "app",
  "vsys",
  "src_zone",
  "dest_zone",
  "src_interface",
  "dest_interface",
  "log_forwarding_profile",
  "future_use3",
  "session_id",
  "repeat_count",
  "src_port",
  "dest_port",
  "src_translated_port",
  "dest_translated_port",
  "session_flags",
  "ip_protocol",
  "action",
  "bytes",
  "bytes_out",
  "bytes_in",
  "packets",
  "start_time",
  "duration",
  "http_category",
  "future_use4",
  "sequence_number",
  "action_flags",
  "src_location",
  "dest_location",
  "future_use5",
  "packets_out",
  "packets_in",
  "session_end_reason",
  "devicegroup_level1",
  "devicegroup_level2",
  "devicegroup_level3",
  "devicegroup_level4",
  "vsys_name",
  "dvc_name",
  "action_source",
  "src_vm",
  "dest_vm",
  "tunnel_id",
  "tunnel_monitor_tag",
  "tunnel_session_id",
  "tunnel_start_time",
  "tunnel_type",
  "sctp_assoc_id",
  "sctp_chunks",
  "sctp_chunks_sent",
  "sctp_chunks_received",
  "rule_uuid",
  "http2_connection",
  "link_change_count",
  "policy_id",
  "link_switches",
  "sdwan_cluster",
  "sdwan_device_type",
  "sdwan_cluster_type",
  "sdwan_site",
  "dynusergroup_name",
  "xff_ip",
  "src_dvc_category",
  "src_dvc_profile",
  "src_dvc_model",
  "src_dvc_vendor",
  "src_dvc_os_family",
  "src_dvc_os_version",
  "src_dvc_host",
  "src_dvc_mac",
  "dest_dvc_category",
  "dest_dvc_profile",
  "dest_dvc_model",
  "dest_dvc_vendor",
  "dest_dvc_os_family",
  "dest_dvc_os_version",
  "dest_dvc_host",
  "dest_dvc_mac",
  "container_id",
  "pod_namespace",
  "pod_name",
  "src_edl",
  "dest_edl",
  "host_id",
  "dvc_serial_number",
  "src_dag",
  "dest_dag",
  "session_owner",
  "high_res_timestamp",
  "nsdsai_sst",
  "nsdsai_sd",
  "app_subcategory",
  "app_category",
  "app_technology",
  "app_risk",
  "app_characteristic",
  "app_container",
  "app_tunneled",
  "app_saas",
  "app_sanction",
  "offloaded",
  "flow_type",
  "cluster_name",
  "ai_traffic",
  "ai_fwd_error",
  "k8s_cluster_id",
  "tcp_rtt_c2s",
  "tcp_rtt_s2c",
  "total_n_ooseq_c2s",
  "total_n_ooseq_s2c",
  "tcp_retransit_cnt_c2s",
  "tcp_retransit_cnt_s2c",
  "tcp_zero_window_cnt_c2s",
  "tcp_zero_window_cnt_s2c",
  "src_adv_dev_id",
  "dst_adv_dev_id",
] as const;

const PAN_APPS = [
  [
    "ssl",
    "networking",
    "encrypted-tunnel",
    "browser-based",
    "4",
    "used-by-malware,able-to-transfer-file,has-known-vulnerability,tunnel-other-application,pervasive-use",
    443,
    "tcp",
    "computer-and-internet-info",
  ],
  [
    "web-browsing",
    "general-internet",
    "internet-utility",
    "browser-based",
    "4",
    "used-by-malware,able-to-transfer-file,has-known-vulnerability,tunnel-other-application,pervasive-use",
    80,
    "tcp",
    "business-and-economy",
  ],
  [
    "dns-base",
    "networking",
    "infrastructure",
    "network-protocol",
    "3",
    "able-to-transfer-file,tunnel-other-application,pervasive-use",
    53,
    "udp",
    "any",
  ],
  [
    "ms-office365-base",
    "business-systems",
    "office-programs",
    "browser-based",
    "1",
    "pervasive-use,is-saas",
    443,
    "tcp",
    "computer-and-internet-info",
  ],
  [
    "ntp-base",
    "networking",
    "infrastructure",
    "network-protocol",
    "2",
    "",
    123,
    "udp",
    "any",
  ],
  [
    "ldap",
    "business-systems",
    "auth-service",
    "client-server",
    "2",
    "able-to-transfer-file,pervasive-use",
    389,
    "tcp",
    "any",
  ],
] as const;

const csvCell = (v: string | number): string => {
  const s = String(v);
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function panTraffic(seed: number, count = 64): GeneratedSample {
  const r = new Rng(seed ^ 0x50414e);
  const events: SampleEvent[] = [];
  const firewalls = ["fw-edge-01", "fw-edge-02", "fw-dc-01"] as const;
  for (let i = 0; i < count; i++) {
    const time = BASE_EPOCH + i + r.int(0, 1);
    const fw = r.pick(firewalls);
    const serial =
      fw === "fw-edge-01"
        ? "013201009876"
        : fw === "fw-edge-02"
          ? "013201009877"
          : "013201011234";
    const [app, cat, subcat, tech, risk, chars, dport, proto, urlcat] =
      r.pick(PAN_APPS);
    const outbound = r.next() < 0.75;
    const src = outbound ? ip10(r, r.int(1, 30)) : ipDoc(r);
    const dst = outbound ? ipDoc(r) : ip10(r, r.int(100, 110));
    const natSrc = outbound ? `203.0.113.${r.int(10, 20)}` : "0.0.0.0";
    const action =
      r.next() < 0.88 ? "allow" : r.pick(["deny", "drop", "reset-both"]);
    const subtype =
      action === "allow"
        ? r.weighted([
            ["end", 8],
            ["start", 2],
          ] as const)
        : "deny";
    const bytesOut = action === "allow" ? r.int(60, 40_000) : r.int(60, 400);
    const bytesIn = action === "allow" ? r.int(0, 900_000) : 0;
    const pktsOut = Math.max(1, Math.round(bytesOut / 700));
    const pktsIn = Math.round(bytesIn / 1200);
    const sport = r.int(1024, 65535);
    const user = outbound && r.next() < 0.6 ? `corp\\${userN(r)}` : "";
    const genTime = panTime(time);
    const startTime = panTime(time - r.int(0, 30));
    const rec: Record<(typeof PAN_TRAFFIC_FIELDS)[number], string | number> =
      Object.fromEntries(PAN_TRAFFIC_FIELDS.map((f) => [f, ""])) as Record<
        (typeof PAN_TRAFFIC_FIELDS)[number],
        string | number
      >;
    Object.assign(rec, {
      future_use1: 1,
      receive_time: genTime,
      serial_number: serial,
      type: "TRAFFIC",
      log_subtype: subtype,
      version: 2817,
      generated_time: genTime,
      src_ip: src,
      dest_ip: dst,
      src_translated_ip: natSrc,
      dest_translated_ip: outbound ? dst : "0.0.0.0",
      rule: outbound ? "allow-outbound-web" : "allow-inbound-dmz",
      src_user: user,
      dest_user: "",
      app,
      vsys: "vsys1",
      src_zone: outbound ? "trust" : "untrust",
      dest_zone: outbound ? "untrust" : "dmz",
      src_interface: outbound ? "ethernet1/2" : "ethernet1/1",
      dest_interface: outbound ? "ethernet1/1" : "ethernet1/3",
      log_forwarding_profile: "default-log-forwarding",
      future_use3: genTime,
      session_id: r.int(10_000, 999_999),
      repeat_count: 1,
      src_port: sport,
      dest_port: dport,
      src_translated_port: outbound ? r.int(1024, 65535) : 0,
      dest_translated_port: outbound ? dport : 0,
      session_flags: "0x400053",
      ip_protocol: proto,
      action,
      bytes: bytesOut + bytesIn,
      bytes_out: bytesOut,
      bytes_in: bytesIn,
      packets: pktsOut + pktsIn,
      start_time: startTime,
      duration: r.int(0, 120),
      http_category: urlcat,
      future_use4: 0,
      sequence_number: 7_300_000_000_000 + r.int(0, 999_999),
      action_flags: "0x8000000000000000",
      src_location: outbound ? "10.0.0.0-10.255.255.255" : "United States",
      dest_location: outbound ? "United States" : "10.0.0.0-10.255.255.255",
      future_use5: 0,
      packets_out: pktsOut,
      packets_in: pktsIn,
      session_end_reason:
        action === "allow"
          ? r.pick(["tcp-fin", "aged-out", "tcp-rst-from-client"])
          : "policy-deny",
      devicegroup_level1: 12,
      devicegroup_level2: 0,
      devicegroup_level3: 0,
      devicegroup_level4: 0,
      vsys_name: "",
      dvc_name: fw,
      action_source: "from-policy",
      src_vm: "",
      dest_vm: "",
      tunnel_id: 0,
      tunnel_monitor_tag: "",
      tunnel_session_id: 0,
      tunnel_start_time: 0,
      tunnel_type: "N/A",
      sctp_assoc_id: 0,
      sctp_chunks: 0,
      sctp_chunks_sent: 0,
      sctp_chunks_received: 0,
      rule_uuid: r.guid(),
      http2_connection: 0,
      link_change_count: 0,
      policy_id: 0,
      link_switches: "",
      sdwan_cluster: "",
      sdwan_device_type: "",
      sdwan_cluster_type: "",
      sdwan_site: "",
      dynusergroup_name: "",
      xff_ip: "",
      src_dvc_category: "",
      src_dvc_profile: "",
      src_dvc_model: "",
      src_dvc_vendor: "",
      src_dvc_os_family: "",
      src_dvc_os_version: "",
      src_dvc_host: "",
      src_dvc_mac: "",
      dest_dvc_category: "",
      dest_dvc_profile: "",
      dest_dvc_model: "",
      dest_dvc_vendor: "",
      dest_dvc_os_family: "",
      dest_dvc_os_version: "",
      dest_dvc_host: "",
      dest_dvc_mac: "",
      container_id: "",
      pod_namespace: "",
      pod_name: "",
      src_edl: "",
      dest_edl: "",
      host_id: "",
      dvc_serial_number: "",
      src_dag: "",
      dest_dag: "",
      session_owner: fw,
      high_res_timestamp: isoAt(time, 3, r).replace("Z", "-00:00"),
      nsdsai_sst: "",
      nsdsai_sd: "",
      app_subcategory: subcat,
      app_category: cat,
      app_technology: tech,
      app_risk: risk,
      app_characteristic: chars,
      app_container: app,
      app_tunneled: "untunneled",
      app_saas: chars.includes("is-saas") ? "yes" : "no",
      app_sanction: "no",
      offloaded: 0,
      flow_type: "NonProxyTraffic",
      cluster_name: "",
      ai_traffic: "",
      ai_fwd_error: "",
      k8s_cluster_id: "",
      tcp_rtt_c2s: proto === "tcp" ? r.int(1, 90) : "",
      tcp_rtt_s2c: proto === "tcp" ? r.int(1, 90) : "",
      total_n_ooseq_c2s: 0,
      total_n_ooseq_s2c: 0,
      tcp_retransit_cnt_c2s: 0,
      tcp_retransit_cnt_s2c: 0,
      tcp_zero_window_cnt_c2s: 0,
      tcp_zero_window_cnt_s2c: 0,
      src_adv_dev_id: "",
      dst_adv_dev_id: "",
    });
    const body = PAN_TRAFFIC_FIELDS.map((f) => csvCell(rec[f])).join(",");
    events.push({
      _raw: `<14>${syslogTime(time)} ${fw}.example.com ${body}`,
      _time: time,
    });
  }
  return {
    key: "pan_traffic",
    file: "pan-traffic.log",
    sampleId: "mrd_pan_traffic",
    sampleName: "mrd_pan_traffic",
    description: `${DEMO_TOKEN} Synthetic Palo Alto PAN-OS 11 TRAFFIC logs over RFC 3164 syslog`,
    events,
    composition: {},
  };
}

// ─── 3. AWS VPC Flow Logs, version 2 (default format) ───────────────────────────

export function vpcFlowV2(seed: number, count = 420): GeneratedSample {
  const r = new Rng(seed ^ 0x565043);
  const account = "111122223333"; // AWS documentation placeholder account
  const enis = Array.from({ length: 6 }, () => `eni-0${r.hex(16)}`);
  // A small, realistic set of conversations that repeat (so a 1-minute aggregation collapses them).
  const tuples = Array.from({ length: 28 }, () => {
    const kind = r.weighted([
      ["egress-web", 10],
      ["east-west", 8],
      ["ingress-scan", 4],
      ["dns", 6],
    ] as const);
    if (kind === "egress-web")
      return {
        src: ip10(r, r.int(0, 3)),
        dst: ipDoc(r),
        dport: r.pick([443, 443, 80]),
        proto: 6,
        action: "ACCEPT" as const,
      };
    if (kind === "east-west")
      return {
        src: ip10(r, r.int(0, 3)),
        dst: ip10(r, r.int(0, 3)),
        dport: r.pick([5432, 6379, 8080, 9092]),
        proto: 6,
        action: "ACCEPT" as const,
      };
    if (kind === "dns")
      return {
        src: ip10(r, r.int(0, 3)),
        dst: "10.0.0.2",
        dport: 53,
        proto: 17,
        action: "ACCEPT" as const,
      };
    return {
      src: ipDoc(r),
      dst: ip10(r, r.int(0, 3)),
      dport: r.pick([22, 3389, 23, 445]),
      proto: 6,
      action: "REJECT" as const,
    };
  });
  const events: SampleEvent[] = [];
  for (let i = 0; i < count; i++) {
    const t = r.pick(tuples);
    const start = BASE_EPOCH + Math.floor(i / 7);
    const end = start + r.int(5, 60);
    const packets = t.action === "REJECT" ? r.int(1, 3) : r.int(2, 240);
    const bytes =
      t.action === "REJECT"
        ? packets * r.int(40, 60)
        : packets * r.int(60, 1400);
    const sport =
      t.action === "REJECT" ? r.int(1024, 65535) : r.int(32768, 60999);
    const line = `2 ${account} ${r.pick(enis)} ${t.src} ${t.dst} ${sport} ${t.dport} ${t.proto} ${packets} ${bytes} ${start} ${end} ${t.action} OK`;
    events.push({ _raw: line, _time: start });
  }
  const keys = new Set(
    events.map((e) => {
      const f = e._raw.split(" ");
      return `${f[3]}|${f[4]}|${f[6]}|${f[12]}`;
    }),
  );
  return {
    key: "vpc_flow_v2",
    file: "vpc-flow-v2.log",
    sampleId: "mrd_vpc_flow_v2",
    sampleName: "mrd_vpc_flow_v2",
    description: `${DEMO_TOKEN} Synthetic AWS VPC Flow Logs v2 (default format) with repeating conversations`,
    events,
    composition: { distinctKeys: keys.size },
  };
}

// ─── 4. Payments API access logs (JSON; fat headers/user_agent/request_body) ────

export const PAY_TRIM_FIELDS = [
  "headers",
  "user_agent",
  "request_body",
] as const;

const USER_AGENTS = [
  "ExampleShop/5.12.3 (iPhone; iOS 19.1; Scale/3.00) CFNetwork/3860.100.1 Darwin/25.1.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0",
  "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36 ExampleShop/5.12.1",
  "example-checkout-sdk/3.4.0 (node 22.22.2; linux x64) axios/1.12.2 retry/4.1.0",
] as const;

export function apiAccess(seed: number, count = 56): GeneratedSample {
  const r = new Rng(seed ^ 0x504159);
  const events: SampleEvent[] = [];
  const routes = [
    ["POST", "/v2/payments", 201],
    ["POST", "/v2/payments/confirm", 200],
    ["GET", "/v2/payments/{id}", 200],
    ["POST", "/v2/refunds", 201],
    ["GET", "/v2/customers/{id}/methods", 200],
  ] as const;
  for (let i = 0; i < count; i++) {
    const time = BASE_EPOCH + i + r.int(0, 1);
    const [method, pathT, okStatus] = r.pick(routes);
    const id = `pay_${r.alnum(20)}`;
    const path = pathT.replace(
      "{id}",
      pathT.includes("customers") ? `cus_${r.alnum(14)}` : id,
    );
    const status =
      r.next() < 0.93 ? okStatus : r.pick([400, 402, 409, 429, 502]);
    const clientIp = ipDoc(r);
    const reqId = `req_${r.alnum(24)}`;
    const trace = r.hex(32);
    const amount = r.int(199, 49_999);
    const ua = r.pick(USER_AGENTS);
    const body =
      method === "GET"
        ? ""
        : JSON.stringify({
            amount,
            currency: "USD",
            payment_method: `pm_${r.alnum(24)}`,
            capture_method: "automatic",
            description: `Order ${r.int(100000, 999999)} for merchant m_${r.int(1000, 9999)}`,
            metadata: {
              cart_id: `cart_${r.alnum(16)}`,
              channel: r.pick(["ios", "android", "web"]),
            },
          });
    const headers: Record<string, string> = {
      host: "api.payments.example.com",
      accept: "application/json",
      "content-type": "application/json; charset=utf-8",
      "content-length": String(bytesOf(body)),
      "x-request-id": reqId,
      "x-forwarded-for": `${clientIp}, 10.20.${r.int(0, 3)}.${r.int(2, 254)}`,
      traceparent: `00-${trace}-${r.hex(16)}-01`,
      "idempotency-key": r.guid(),
    };
    if (method === "GET") {
      delete headers["content-type"];
      delete headers["content-length"];
    }
    const evt = {
      ts: isoAt(time, 3, r),
      request_id: reqId,
      service: "payments-api",
      env: "prod",
      region: "us-east-1",
      method,
      path,
      status,
      latency_ms: r.int(18, status >= 500 ? 2900 : 420),
      bytes_out: r.int(180, 2400),
      client_ip: clientIp,
      api_version: "2026-09-01",
      merchant_id: `m_${r.int(1000, 9999)}`,
      customer_id: `cus_${r.alnum(14)}`,
      amount_cents: method === "GET" ? null : amount,
      currency: "USD",
      outcome:
        status < 300 ? "approved" : status === 402 ? "declined" : "error",
      risk_score: r.int(1, 99),
      auth_client_id: `ck_live_${r.alnum(12)}`,
      trace_id: trace,
      headers,
      user_agent: ua,
      request_body: body,
    };
    events.push({ _raw: JSON.stringify(evt), _time: time });
  }
  return {
    key: "api_access",
    file: "api-access.json",
    sampleId: "mrd_api_access",
    sampleName: "mrd_api_access",
    description: `${DEMO_TOKEN} Synthetic payments API access logs (JSON) with fat headers, user_agent and request_body`,
    events,
    composition: { trimFraction: trimmedFraction(events, PAY_TRIM_FIELDS) },
  };
}

// ─── 5. Kubernetes container logs (JSON; ~40% debug; fat labels) ────────────────

export const K8S_TRIM_FIELDS = ["labels"] as const;

const K8S_SERVICES = [
  ["checkout", "storefront", "payments-platform"],
  ["cart", "storefront", "storefront-core"],
  ["inventory", "supply", "supply-chain"],
  ["search", "storefront", "discovery"],
] as const;

const K8S_MESSAGES = {
  debug: [
    "cache lookup key=cart:{id} hit=false ttl_ms=30000 backend=redis-primary",
    "outbound call peer=inventory-svc method=GET path=/v1/stock/{id} attempt=1 pool_idle=12",
    "feature flag evaluated flag=checkout.v3 variant=control reason=RULE_MATCH rule=pct-rollout-25",
    "db query stmt=select_cart_items rows=7 duration_ms=4 conn=pg-rw-2",
  ],
  info: [
    "request completed method=POST path=/api/cart/{id}/items status=200 duration_ms=41",
    "order placed order_id={id} items=3 total_cents=12999 currency=USD",
    "consumer committed topic=orders partition=4 offset=88213 lag=0",
  ],
  warn: [
    "slow request method=GET path=/api/search status=200 duration_ms=1840 threshold_ms=1000",
    "retrying outbound call peer=payments-api attempt=2 backoff_ms=200",
  ],
  error: [
    'upstream failed peer=payments-api status=502 error="bad gateway" request_id={id}',
  ],
} as const;

export function k8sContainer(seed: number, count = 84): GeneratedSample {
  const r = new Rng(seed ^ 0x4b3853);
  const events: SampleEvent[] = [];
  // Exact level mix (40% debug, 48% info, 9% warn, rest error), shuffled: the debug share is a
  // property the rig's 0.70 target depends on, so it is constructed rather than left to chance.
  const nDebug = Math.round(count * 0.4);
  const nWarn = Math.round(count * 0.09);
  const nError = Math.max(1, Math.round(count * 0.03));
  const levels: ("debug" | "info" | "warn" | "error")[] = [
    ...Array<"debug">(nDebug).fill("debug"),
    ...Array<"warn">(nWarn).fill("warn"),
    ...Array<"error">(nError).fill("error"),
    ...Array<"info">(count - nDebug - nWarn - nError).fill("info"),
  ];
  for (let i = levels.length - 1; i > 0; i--) {
    const j = r.int(0, i);
    [levels[i], levels[j]] = [
      levels[j] as (typeof levels)[number],
      levels[i] as (typeof levels)[number],
    ];
  }
  for (let i = 0; i < count; i++) {
    const time = BASE_EPOCH + i + r.int(0, 1);
    const [svc, partOf, team] = r.pick(K8S_SERVICES);
    const level = levels[i] as (typeof levels)[number];
    const hash = r.alnum(10);
    const pod = `${svc}-${hash}-${r.alnum(5)}`;
    const msg = r.pick(K8S_MESSAGES[level]).replace("{id}", r.alnum(12));
    const evt = {
      time: isoAt(time, 9, r),
      stream: level === "error" || level === "warn" ? "stderr" : "stdout",
      level,
      logger: `${svc}.${r.pick(["handler", "client", "worker", "repo"])}`,
      msg,
      trace_id: r.hex(32),
      kubernetes: {
        namespace: "shop-prod",
        pod,
        container: svc,
        node: `node-pool-a-${r.int(1, 9)}.k8s.example.com`,
      },
      labels: {
        "app.kubernetes.io/name": svc,
        "app.kubernetes.io/instance": `${svc}-prod`,
        "app.kubernetes.io/version": "5.12.3",
        "app.kubernetes.io/component": "api",
        "app.kubernetes.io/part-of": partOf,
        "app.kubernetes.io/managed-by": "Helm",
        "helm.sh/chart": `${svc}-5.12.3`,
        "pod-template-hash": hash,
        "service.istio.io/canonical-name": svc,
        team,
        "cost-center": `cc-${r.int(4000, 4999)}`,
        tier: "backend",
      },
    };
    events.push({ _raw: JSON.stringify(evt), _time: time });
  }
  const total = events.reduce((s, e) => s + bytesOf(e._raw), 0);
  const debug = events.filter(
    (e) => (JSON.parse(e._raw) as { level: string }).level === "debug",
  );
  const kept = events.filter(
    (e) => (JSON.parse(e._raw) as { level: string }).level !== "debug",
  );
  return {
    key: "k8s_container",
    file: "k8s-container.log",
    sampleId: "mrd_k8s_container",
    sampleName: "mrd_k8s_container",
    description: `${DEMO_TOKEN} Synthetic Kubernetes container logs (JSON), ~40% debug, with pod labels`,
    events,
    composition: {
      dropFraction: debug.reduce((s, e) => s + bytesOf(e._raw), 0) / total,
      dropEventFraction: debug.length / events.length,
      // fraction of the NON-dropped bytes that the label trim removes
      trimFraction: trimmedFraction(kept, K8S_TRIM_FIELDS),
    },
  };
}

// ─── Composition helpers ────────────────────────────────────────────────────────

/** Fraction of JSON `_raw` bytes removed when `fields` are deleted and the object is re-serialized. */
export function trimmedFraction(
  events: readonly SampleEvent[],
  fields: readonly string[],
): number {
  let before = 0;
  let after = 0;
  for (const e of events) {
    const obj = JSON.parse(e._raw) as Record<string, unknown>;
    before += bytesOf(e._raw);
    for (const f of fields) delete obj[f];
    after += bytesOf(JSON.stringify(obj));
  }
  return before === 0 ? 0 : 1 - after / before;
}

export function statsOf(s: GeneratedSample): SampleStats {
  const sizes = s.events.map((e) => bytesOf(e._raw));
  const total = sizes.reduce((a, b) => a + b, 0);
  return {
    events: sizes.length,
    totalBytes: total,
    avgEventBytes: Math.round(total / Math.max(1, sizes.length)),
    minEventBytes: Math.min(...sizes),
    maxEventBytes: Math.max(...sizes),
    uploadBodyBytes: bytesOf(JSON.stringify(uploadBody(s))),
  };
}

/**
 * The `POST /m/<gid>/system/samples` body for a sample. `isTemplate: true` makes it a *Datagen file*:
 * the Datagen Source only offers sample-library entries flagged as templates (every built-in Datagen
 * file — weblog, syslog, palo_alto_traffic… — carries it; plain samples feed pipeline previews only).
 */
export function uploadBody(s: GeneratedSample): {
  id: string;
  sampleName: string;
  description: string;
  isTemplate: true;
  context: { events: SampleEvent[] };
} {
  return {
    id: s.sampleId,
    sampleName: s.sampleName,
    description: s.description,
    isTemplate: true,
    context: { events: s.events },
  };
}

export function generateSamples(seed = DEFAULT_SEED): GeneratedSample[] {
  return [
    windowsSecurityXml(seed),
    panTraffic(seed),
    vpcFlowV2(seed),
    apiAccess(seed),
    k8sContainer(seed),
  ];
}

/**
 * Checks every rig-relevant composition fact. Returns human-readable failures (empty = all good).
 * Bounds are the ones the target ratios need (SPEC 14.2 / PRD 9): trim ≥ 0.50 of the api event so the
 * `[mr-trim]` function is worth ≥ 25 points after 1:2 sampling; k8s debug ≈ 40% of bytes and labels
 * ≈ 50% of what remains (0.40 + 0.60 × 0.50 = 0.70).
 */
export function checkComposition(
  samples: readonly GeneratedSample[],
): string[] {
  const fail: string[] = [];
  for (const s of samples) {
    const st = statsOf(s);
    if (st.uploadBodyBytes > MAX_UPLOAD_BODY_BYTES)
      fail.push(
        `${s.key}: upload body ${st.uploadBodyBytes} B > ${MAX_UPLOAD_BODY_BYTES} B`,
      );
    if (!s.description.includes(DEMO_TOKEN))
      fail.push(`${s.key}: description lacks ${DEMO_TOKEN}`);
    if (!s.sampleId.startsWith("mrd_"))
      fail.push(`${s.key}: sample id must start with mrd_`);
    const inRange = (lo: number, hi: number, what: string, v: number): void => {
      if (!(v >= lo && v <= hi))
        fail.push(`${s.key}: ${what} ${v.toFixed(3)} outside [${lo}, ${hi}]`);
    };
    switch (s.key) {
      case "windows_security_xml":
        inRange(1500, 3200, "avg event bytes", st.avgEventBytes);
        break;
      case "pan_traffic":
      case "k8s_container":
        inRange(300, 1200, "avg event bytes", st.avgEventBytes);
        break;
      case "vpc_flow_v2":
        inRange(90, 160, "avg event bytes", st.avgEventBytes);
        inRange(
          10,
          40,
          "distinct aggregation keys",
          s.composition.distinctKeys ?? 0,
        );
        break;
      case "api_access":
        inRange(300, 1200, "avg event bytes", st.avgEventBytes);
        inRange(0.5, 0.6, "trim fraction", s.composition.trimFraction ?? 0);
        break;
    }
    if (s.key === "k8s_container") {
      inRange(
        0.37,
        0.43,
        "debug byte fraction",
        s.composition.dropFraction ?? 0,
      );
      inRange(
        0.47,
        0.55,
        "label trim fraction (non-debug)",
        s.composition.trimFraction ?? 0,
      );
    }
  }
  return fail;
}

/** Expected steady-state byte ratios (1 − out/in) implied by the composition, before live measurement. */
export function expectedRatios(
  samples: readonly GeneratedSample[],
): Record<string, number> {
  const by = Object.fromEntries(samples.map((s) => [s.key, s]));
  const pay = by["api_access"]?.composition.trimFraction ?? 0;
  const k8s = by["k8s_container"]?.composition;
  return {
    payments_api: 0.5 + 0.5 * pay,
    payments_api_trim_broken: 0.5,
    k8s_prod:
      (k8s?.dropFraction ?? 0) +
      (1 - (k8s?.dropFraction ?? 0)) * (k8s?.trimFraction ?? 0),
  };
}

// ─── CLI ────────────────────────────────────────────────────────────────────────

const OUT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "demo",
  "rig",
  "samples",
);

function serialize(s: GeneratedSample): string {
  // One JSON array, one event per line: diff-friendly and still a single JSON document.
  return "[\n" + s.events.map((e) => JSON.stringify(e)).join(",\n") + "\n]\n";
}

function manifest(samples: readonly GeneratedSample[], seed: number): string {
  return (
    JSON.stringify(
      {
        schemaVersion: 1,
        generator: "testdata/samples.ts",
        seed,
        note: "Synthetic data only. Each file is one JSON array of {_raw,_time} events (sample-library format).",
        expectedRatios: expectedRatios(samples),
        samples: samples.map((s) => ({
          key: s.key,
          file: s.file,
          sampleId: s.sampleId,
          sampleName: s.sampleName,
          description: s.description,
          ...statsOf(s),
          composition: s.composition,
        })),
      },
      null,
      2,
    ) + "\n"
  );
}

function main(argv: readonly string[]): number {
  const seedArg = argv.find((a) => a.startsWith("--seed="));
  const seed = seedArg ? Number(seedArg.slice("--seed=".length)) : DEFAULT_SEED;
  const check = argv.includes("--check");
  const samples = generateSamples(seed);
  const failures = checkComposition(samples);
  for (const s of samples) {
    const st = statsOf(s);
    console.log(
      `${s.file.padEnd(26)} ${String(st.events).padStart(4)} events  avg ${String(st.avgEventBytes).padStart(5)} B  ` +
        `[${st.minEventBytes}–${st.maxEventBytes}]  upload ${(st.uploadBodyBytes / 1000).toFixed(1)} KB  ${JSON.stringify(s.composition)}`,
    );
  }
  console.log("expected ratios", JSON.stringify(expectedRatios(samples)));
  if (failures.length) {
    for (const f of failures) console.error("COMPOSITION FAIL:", f);
    return 1;
  }
  const files: [string, string][] = [
    ...samples.map((s): [string, string] => [s.file, serialize(s)]),
    ["manifest.json", manifest(samples, seed)],
  ];
  if (check) {
    const stale = files.filter(([f, body]) => {
      try {
        return readFileSync(join(OUT_DIR, f), "utf8") !== body;
      } catch {
        return true;
      }
    });
    for (const [f] of stale) console.error("STALE:", f);
    return stale.length ? 1 : 0;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [f, body] of files) writeFileSync(join(OUT_DIR, f), body);
  console.log(`wrote ${files.length} files to ${OUT_DIR}`);
  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
