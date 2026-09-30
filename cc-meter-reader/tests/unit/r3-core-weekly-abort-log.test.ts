// tests/unit/r3-core-weekly-abort-log.test.ts — founder-build r3 core-3 (FINDINGS_EXTRA FT-R111-4, the app half).
//
// keyboard.spec.ts:590 (webkit, firefox) saw "[meter-reader] weekly receipt failed …" in the console: a navigation
// cancelled the tab's in-flight weekly send (HTTP 0 "network_error: Load failed", "… due to access control checks",
// Firefox's "NetworkError when attempting to fetch resource"), and core/weekly.ts logged every failure with
// logger.error. R2 core-11 (a) already turned an automatic send's KvHttpError status 0 / 5xx into a warning and a later
// tick's retry. What was left: a status-0 failure of a manual send, and an aborted request that surfaces as the
// browser's own error (a TypeError / AbortError rather than a KvHttpError). Both are the request not completing, not
// the job failing: they log at warn. A real failure (a 500 on a manual send, a 400 anywhere) still logs at error, and
// an automatic send is still retried by a later tick (r2 H8: meterLoop retries on 'unavailable').

import { describe, expect, it } from "vitest";
import { KvHttpError } from "../../core/kv.ts";
import { runWeeklyReceipt } from "../../core/weekly.ts";
import type { KvStore } from "../../core/types.ts";
import { DAY, T0, createWorld, meteringSince } from "../integration/harness.ts";

function recordingLogger() {
  const logs: { level: string; msg: string }[] = [];
  return {
    logs,
    errors: () => logs.filter((l) => l.level === "error"),
    warns: () => logs.filter((l) => l.level === "warn"),
    logger: {
      info: (msg: string) => void logs.push({ level: "info", msg }),
      warn: (msg: string) => void logs.push({ level: "warn", msg }),
      error: (msg: string) => void logs.push({ level: "error", msg }),
    },
  };
}

/** A KV whose next GET of the settings throws `error`. */
function throwingOnce(kv: KvStore, error: unknown): KvStore {
  let left = 1;
  return {
    ...kv,
    get: async (key) => {
      if (left > 0 && key === "settings") {
        left--;
        throw error;
      }
      return kv.get(key);
    },
  };
}

async function world() {
  const w = await createWorld({ options: { notificationApis: true } });
  await w.sweep();
  await meteringSince(w, T0 - 8 * DAY);
  return w;
}

const aborted = (): Error => Object.assign(new Error("Load failed"), { name: "TypeError" });
const firefoxAborted = (): Error => Object.assign(new Error("NetworkError when attempting to fetch resource."), { name: "TypeError" });
const webkitAccess = (): Error => Object.assign(new Error("Fetch API cannot load https://x/api/v1/kvstore/settings due to access control checks."), { name: "TypeError" });
const abortError = (): Error => Object.assign(new Error("The operation was aborted."), { name: "AbortError" });

describe("r3 core-3 · an aborted weekly send is a warning, not an error", () => {
  it("a manual send whose KV read answers status 0 (navigation cancelled it): one warning, no error call; the member still sees the error", async () => {
    const w = await world();
    const log = recordingLogger();
    const kv = throwingOnce(w.deps.kv, new KvHttpError("GET", "settings", 0, "network_error: Load failed"));
    const r = await runWeeklyReceipt({ ...w.deps, kv, logger: log.logger }, { mode: "manual" });
    expect(r.error).toMatch(/HTTP 0/);
    expect(log.errors()).toEqual([]);
    expect(log.warns()).toHaveLength(1);
    expect(log.warns()[0].msg).toMatch(/weekly receipt/);
  }, 60_000);

  for (const [name, make] of [
    ["WebKit's 'Load failed'", aborted],
    ["Firefox's 'NetworkError when attempting to fetch resource.'", firefoxAborted],
    ["WebKit's 'access control checks'", webkitAccess],
    ["an AbortError", abortError],
  ] as const) {
    it(`an automatic send cut short by ${name}: skipped 'unavailable' (a later tick sends it), one warning, no error call`, async () => {
      const w = await world();
      const log = recordingLogger();
      const r = await runWeeklyReceipt({ ...w.deps, kv: throwingOnce(w.deps.kv, make()), logger: log.logger }, { mode: "ui" });
      expect(r.skipped).toBe("unavailable");
      expect(log.errors()).toEqual([]);
      expect(log.warns()).toHaveLength(1);
      w.advance(30_000);
      const again = await runWeeklyReceipt(w.deps, { mode: "ui" });
      expect(again.skipped).toBeUndefined();
      expect(again.sent).toBeGreaterThan(0);
    }, 60_000);
    it(`a manual send cut short by ${name}: one warning, no error call`, async () => {
      const w = await world();
      const log = recordingLogger();
      const r = await runWeeklyReceipt({ ...w.deps, kv: throwingOnce(w.deps.kv, make()), logger: log.logger }, { mode: "manual" });
      expect(r.error).toBeDefined();
      expect(log.errors()).toEqual([]);
      expect(log.warns()).toHaveLength(1);
    }, 60_000);
  }

  it("a real failure still logs at error: a manual send that meets a 500", async () => {
    const w = await world();
    const log = recordingLogger();
    const r = await runWeeklyReceipt({ ...w.deps, kv: throwingOnce(w.deps.kv, new KvHttpError("GET", "settings", 500, "Internal Server Error")), logger: log.logger }, { mode: "manual" });
    expect(r.error).toMatch(/HTTP 500/);
    expect(log.errors()).toHaveLength(1);
  }, 60_000);

  it("a real failure still logs at error: an automatic send that meets a 400 (not retried)", async () => {
    const w = await world();
    const log = recordingLogger();
    const r = await runWeeklyReceipt({ ...w.deps, kv: throwingOnce(w.deps.kv, new KvHttpError("GET", "settings", 400, "Bad Request")), logger: log.logger }, { mode: "ui" });
    expect(r.skipped).toBeUndefined();
    expect(r.error).toMatch(/HTTP 400/);
    expect(log.errors()).toHaveLength(1);
  }, 60_000);

  it("a plain TypeError that is not a cancelled request is still an error (a bug, not the network)", async () => {
    const w = await world();
    const log = recordingLogger();
    const bug = Object.assign(new Error("Cannot read properties of undefined (reading 'x')"), { name: "TypeError" });
    const r = await runWeeklyReceipt({ ...w.deps, kv: throwingOnce(w.deps.kv, bug), logger: log.logger }, { mode: "ui" });
    expect(r.skipped).toBeUndefined();
    expect(log.errors()).toHaveLength(1);
  }, 60_000);

  it("r2 control: an automatic send whose KV read answers status 0 stays a warning and 'unavailable'", async () => {
    const w = await world();
    const log = recordingLogger();
    const r = await runWeeklyReceipt({ ...w.deps, kv: throwingOnce(w.deps.kv, new KvHttpError("GET", "settings", 0, "network_error: Load failed")), logger: log.logger }, { mode: "ui" });
    expect(r.skipped).toBe("unavailable");
    expect(log.errors()).toEqual([]);
    expect(log.warns()).toHaveLength(1);
  }, 60_000);
});
