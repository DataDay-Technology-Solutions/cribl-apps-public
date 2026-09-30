// tests/integration/r3-core-weekly-dup.test.ts — founder-build r3 core-1 (FINDINGS_R3 #7, major; AA/r3/4
// zz-r3f4-weekly-dup.test.ts).
//
// The weekly receipt recorded `meta.lastWeeklySentAt` after the delivery loop, inside the same try as the send. When
// that one PUT failed (a 503, a dropped connection), r2 core-11 (a) read it as a transient Leader failure, returned
// skipped 'unavailable', and the next tick sent the receipt AGAIN: every webhook got it twice, and the first result
// reported sent 0 / endpoints 0 although two endpoints had it. Now the record is written in its own step after the
// delivery, retried within the call, and never re-enters the send path; once an endpoint was attempted the result
// reports the real sent / endpoints.

import { describe, expect, it } from "vitest";
import { KvHttpError } from "../../core/kv.ts";
import { runWeeklyReceipt } from "../../core/weekly.ts";
import type { KvStore, WebhookSender } from "../../core/types.ts";
import { DAY, T0, createWorld, meteringSince } from "./harness.ts";

function recordingLogger() {
  const logs: { level: string; msg: string }[] = [];
  return {
    logs,
    logger: {
      info: (msg: string) => void logs.push({ level: "info", msg }),
      warn: (msg: string) => void logs.push({ level: "warn", msg }),
      error: (msg: string) => void logs.push({ level: "error", msg }),
    },
  };
}

/** A KV whose next `times` PUTs of `meta` fail with `status` (0 = a timeout / dropped connection). */
function failingMetaPut(status: number) {
  let left = 0;
  let failed = 0;
  return {
    arm: (times = 1) => void (left = times),
    failed: () => failed,
    wrap: (kv: KvStore): KvStore => ({
      ...kv,
      put: async (key, value) => {
        if (left > 0 && key === "meta") {
          left--;
          failed++;
          throw new KvHttpError("PUT", key, status, status === 0 ? "timeout: no response from PUT within 25000 ms" : "Service Unavailable");
        }
        return kv.put(key, value);
      },
    }),
  };
}

async function worldWithCountingWebhook(status: number) {
  const flaky = failingMetaPut(status);
  const w = await createWorld({ options: { notificationApis: true }, wrapKv: flaky.wrap });
  await w.sweep();
  await w.sweepMinutes(2);
  await meteringSince(w, T0 - 8 * DAY); // a workspace that metered last week (r3 core-2)
  const posts: string[] = [];
  const real = w.deps.webhook;
  const webhook: WebhookSender = {
    post: async (url, body, to) => {
      const j = JSON.parse(body) as { event?: string };
      if (j.event === "receipt.weekly") posts.push(url);
      return real.post(url, body, to);
    },
  };
  return { w, flaky, posts, webhook };
}

describe("r3 core-1 · a failed record after delivery never sends the weekly receipt twice", () => {
  for (const status of [503, 0]) {
    it(`meta PUT ${status} after delivery: one post per endpoint over two ticks, and the first result reports what it sent`, async () => {
      const { w, flaky, posts, webhook } = await worldWithCountingWebhook(status);
      const bellBefore = w.em.bell().length;
      flaky.arm(1);
      const first = recordingLogger();
      const r1 = await runWeeklyReceipt({ ...w.deps, webhook, logger: first.logger }, { mode: "ui" });
      expect(flaky.failed()).toBe(1);
      expect(r1.skipped).toBeUndefined();
      expect(r1.error).toBeUndefined();
      expect(r1.sent).toBe(2);
      expect(r1.endpoints).toBe(2);
      expect(posts).toHaveLength(1);
      expect(w.em.bell().length - bellBefore).toBe(1);
      expect(first.logs.filter((l) => l.level === "error")).toEqual([]);
      // The week is recorded (the retry within the call landed): the next tick has nothing to send.
      expect((await w.docs.getMeta())?.lastWeeklySentAt).toBeDefined();
      w.advance(60_000);
      const r2 = await runWeeklyReceipt({ ...w.deps, webhook }, { mode: "ui" });
      expect(r2.skipped).toBe("already_sent");
      expect(posts).toHaveLength(1);
      expect(w.em.bell().length - bellBefore).toBe(1);
    }, 60_000);
  }

  it("a record that keeps failing still reports what was sent (no 'unavailable', so the tab settles the week) and warns", async () => {
    const { w, flaky, posts, webhook } = await worldWithCountingWebhook(503);
    flaky.arm(10);
    const { logs, logger } = recordingLogger();
    const r = await runWeeklyReceipt({ ...w.deps, webhook, logger }, { mode: "ui" });
    expect(r.skipped).toBeUndefined();
    expect(r.sent).toBe(2);
    expect(r.endpoints).toBe(2);
    expect(posts).toHaveLength(1);
    expect(flaky.failed()).toBeGreaterThan(1); // retried within the call
    expect(flaky.failed()).toBeLessThan(10); // bounded
    expect(logs.filter((l) => l.level === "error")).toEqual([]);
    expect(logs.some((l) => l.level === "warn" && /weekly receipt/.test(l.msg) && /lastWeeklySentAt/.test(l.msg))).toBe(true);
  }, 60_000);

  it("the r2 core-11 (a) retry still holds: a KV read failing BEFORE delivery is retried by a later tick, which sends once", async () => {
    const w = await createWorld({ options: { notificationApis: true } });
    await w.sweep();
    await w.sweepMinutes(2);
    await meteringSince(w, T0 - 8 * DAY);
    const posts: string[] = [];
    const real = w.deps.webhook;
    const webhook: WebhookSender = {
      post: async (url, body, to) => {
        if ((JSON.parse(body) as { event?: string }).event === "receipt.weekly") posts.push(url);
        return real.post(url, body, to);
      },
    };
    const flakyKv = w.deps.kv;
    let fail = true;
    const kv: KvStore = {
      ...flakyKv,
      get: async (key) => {
        if (fail && key === "totals") {
          fail = false;
          throw new KvHttpError("GET", key, 503, "Service Unavailable");
        }
        return flakyKv.get(key);
      },
    };
    const r1 = await runWeeklyReceipt({ ...w.deps, kv, webhook }, { mode: "ui" });
    expect(r1.skipped).toBe("unavailable");
    expect(posts).toHaveLength(0);
    w.advance(30_000);
    const r2 = await runWeeklyReceipt({ ...w.deps, kv, webhook }, { mode: "ui" });
    expect(r2.skipped).toBeUndefined();
    expect(r2.sent).toBe(2);
    expect(posts).toHaveLength(1);
    const r3 = await runWeeklyReceipt({ ...w.deps, kv, webhook }, { mode: "ui" });
    expect(r3.skipped).toBe("already_sent");
    expect(posts).toHaveLength(1);
  }, 60_000);
});
