// tests/unit/r2-core-delivery-backoff.test.ts — founder-build r2 core-1 (FINDINGS_R2 #1, a regression from r1 core-9).
//
// r1's per-endpoint retry (M8) re-posted a failing endpoint every 2 minutes whatever it answered: a final 4xx
// (SPEC 12.3: 403, 404, 429 are not retried) went out 31 times an hour on one open incident, and the failed refs
// pushed the bell's 2xx out of the 20-entry `incident.deliveries`, so at 45 minutes the card read only
// "Delivery failed (429)". Now: a final failure waits for the reminder cadence (the cooldown) or a severity rise; a
// retryable one backs off 2 → 4 → 8 minutes (then, once another endpoint delivered, the reminder cadence; otherwise
// doubling up to the cooldown); an endpoint keeps one failed ref (replaced, never appended) and its last ok is never
// evicted. Probes: AA/r2/3 zz-r23-alerts.test.ts (B, C), zz-r23-alerts403.test.ts, AA/r2/4 zz-f4-final-4xx-retry.test.ts.

import { describe, expect, it } from "vitest";
import type { DeliveryRef, Incident, WebhookSender } from "../../core/types.ts";
import { breakTrim } from "../../core/demo/levers.ts";
import {
  endpointRetryWaitMs,
  recordDeliveryRef,
  shouldNotify,
} from "../../core/incidents.ts";
import { deliveryLines } from "../../src/components/IncidentCard/model.ts";
import { SINK_ENDPOINT, createWorld } from "../integration/harness.ts";

const MIN = 60_000;

/** A world whose direct webhook answers `status` to every incident post once armed; the bell (Cribl API) works. */
async function world(
  status: (event: string, n: number) => number | undefined,
  withBell = true,
) {
  const w = await createWorld({
    options: { notificationApis: true },
    settings: (s) => {
      if (!withBell)
        s.notifications.push({
          id: "cribl-bell",
          name: "bell",
          channel: "cribl-bell",
          enabled: false,
          minSeverity: "medium",
        } as never);
    },
  });
  const real = w.deps.webhook;
  const posts: { t: number; status: number; event: string; inc?: string }[] =
    [];
  let n = 0;
  let armed = false;
  const sender: WebhookSender = {
    post: async (url, body, to) => {
      const j = JSON.parse(body) as {
        event: string;
        incident?: { id: string };
      };
      if (url === SINK_ENDPOINT.url && armed && j.incident?.id) {
        const st = status(j.event, n++);
        if (st !== undefined) {
          posts.push({
            t: w.now(),
            status: st,
            event: j.event,
            inc: j.incident.id,
          });
          return { status: st };
        }
      }
      const r = await real.post(url, body, to);
      if (url === SINK_ENDPOINT.url && j.incident?.id)
        posts.push({
          t: w.now(),
          status: r.status,
          event: j.event,
          inc: j.incident.id,
        });
      return r;
    },
  };
  await w.sweep();
  await w.sweepMinutes(3, { webhook: sender });
  armed = true;
  expect((await breakTrim(w.lever, { pipelineId: "mrd_pay_sample" })).ok).toBe(
    true,
  );
  return { w, posts, sender };
}

async function regression(
  w: Awaited<ReturnType<typeof world>>["w"],
): Promise<Incident> {
  const snap = (await w.docs.getSnapshot())!;
  return snap.incidents.find((i) => i.type === "regression")!;
}

describe("r2 core-1 · a final 4xx is not re-posted every 2 minutes (bell on)", () => {
  for (const status of [429, 403, 404]) {
    it(`${status} on every incident post: exactly 1 post in 30 minutes`, async () => {
      const { w, posts, sender } = await world(() => status);
      await w.sweepMinutes(30, { webhook: sender });
      const inc = await regression(w);
      expect(inc.closedAt).toBeUndefined();
      expect(posts.filter((p) => p.inc === inc.id)).toHaveLength(1);
      expect(
        w.em.bell().filter((m) => m.id.startsWith(`meter-reader-${inc.id}`)),
      ).toHaveLength(1);
    }, 180_000);
  }

  for (const status of [429, 403]) {
    it(`${status} on every incident post: at most 3 posts in 63 minutes (the second is the hourly reminder)`, async () => {
      const { w, posts, sender } = await world(() => status);
      await w.sweepMinutes(63, { webhook: sender });
      const inc = await regression(w);
      const hook = posts.filter((p) => p.inc === inc.id);
      expect(hook.length).toBeGreaterThanOrEqual(1);
      expect(hook.length).toBeLessThanOrEqual(3);
      // The reminder waits the whole cooldown after the first attempt.
      for (let k = 1; k < hook.length; k++)
        expect(hook[k].t - hook[k - 1].t).toBeGreaterThanOrEqual(
          60 * MIN - MIN,
        );
    }, 300_000);
  }

  it("429 bell off (the webhook is the only channel): at most 2 posts in 30 minutes", async () => {
    const { w, posts, sender } = await world(() => 429, false);
    await w.sweepMinutes(30, { webhook: sender });
    const inc = await regression(w);
    expect(posts.filter((p) => p.inc === inc.id).length).toBeLessThanOrEqual(2);
  }, 180_000);

  it("404 bell off: at most 2 posts in 30 minutes", async () => {
    const { w, posts, sender } = await world(() => 404, false);
    await w.sweepMinutes(30, { webhook: sender });
    const inc = await regression(w);
    expect(posts.filter((p) => p.inc === inc.id).length).toBeLessThanOrEqual(2);
  }, 180_000);
});

describe("r2 core-1 · the card keeps the bell’s delivery (probe C)", () => {
  it("45 minutes into a 429 webhook, the incident still holds the bell’s ok and one failed ref for the webhook", async () => {
    const { w, sender } = await world(() => 429);
    await w.sweepMinutes(46, { webhook: sender });
    const inc = await regression(w);
    expect(inc.closedAt).toBeUndefined();
    const refs = inc.deliveries ?? [];
    expect(
      refs.filter(
        (d) =>
          d.endpointId === "cribl-bell" && d.status >= 200 && d.status < 300,
      ).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      refs.filter(
        (d) =>
          d.endpointId === SINK_ENDPOINT.id &&
          !(d.status >= 200 && d.status < 300),
      ),
    ).toHaveLength(1);
    const lines = deliveryLines(inc.deliveries, { tz: "UTC" });
    expect(
      lines.some((l) => l.endpointId === "cribl-bell" && l.tone === "ok"),
    ).toBe(true);
  }, 180_000);
});

describe("r2 core-1 · a retryable failure backs off 2 → 4 → 8 minutes", () => {
  it("503 on every incident post with the bell on: tries at +2, +4, +8, then the reminder cadence", async () => {
    const { w, posts, sender } = await world(() => 503);
    await w.sweepMinutes(63, { webhook: sender });
    const inc = await regression(w);
    const t = posts.filter((p) => p.inc === inc.id).map((p) => p.t);
    const gaps = t.slice(1).map((x, k) => Math.round((x - t[k]) / MIN));
    expect(gaps.slice(0, 3)).toEqual([2, 4, 8]);
    // Someone (the bell) was told: after the ladder the webhook waits for the hourly reminder.
    expect(t.length).toBe(4);
  }, 300_000);

  it("503 with the bell off: 2 → 4 → 8 → 16 → 32 (doubling up to the cooldown; nobody was told)", async () => {
    const { w, posts, sender } = await world(() => 503, false);
    await w.sweepMinutes(70, { webhook: sender });
    const inc = await regression(w);
    const t = posts.filter((p) => p.inc === inc.id).map((p) => p.t);
    const gaps = t.slice(1).map((x, k) => Math.round((x - t[k]) / MIN));
    expect(gaps).toEqual([2, 4, 8, 16, 32]);
  }, 300_000);

  it("503 once, bell on: retried at +2 minutes and delivered (r1 M8 unchanged)", async () => {
    const { w, posts, sender } = await world((_e, n) =>
      n === 0 ? 503 : undefined,
    );
    await w.sweepMinutes(10, { webhook: sender });
    const inc = await regression(w);
    const hook = posts.filter((p) => p.inc === inc.id);
    expect(hook.map((h) => h.status)).toEqual([503, 200]);
    expect(Math.round((hook[1].t - hook[0].t) / MIN)).toBe(2);
    expect(inc.notified?.[SINK_ENDPOINT.id]?.fails).toBeUndefined();
  }, 180_000);
});

describe("r2 core-1 · shouldNotify and the wait, directly", () => {
  const now = Date.parse("2026-09-28T16:00:00Z");
  const ep = { id: "ep_x", enabled: true, minSeverity: "medium" as const };
  const base: Incident = {
    id: "inc_000001",
    type: "regression",
    severity: "high",
    objectKey: "route:default:r1",
    label: "x",
    openedAt: new Date(now - 30 * MIN).toISOString(),
    before: 0.75,
    after: 0.25,
    deliveries: [],
  } as unknown as Incident;
  const at = (ago: number) => new Date(now - ago).toISOString();

  it("a final 4xx waits for the cooldown, or goes on a severity rise", () => {
    const inc = {
      ...base,
      notified: { ep_x: { at: at(10 * MIN), status: 404, fails: 1 } },
    };
    expect(shouldNotify(inc, ep, now, 60)).toBe(false);
    expect(shouldNotify(inc, ep, now, 60, "medium")).toBe(true); // medium → high
    expect(
      shouldNotify(
        {
          ...inc,
          notified: { ep_x: { at: at(60 * MIN), status: 404, fails: 1 } },
        },
        ep,
        now,
        60,
      ),
    ).toBe(true);
    // An r1 record (no fails, no final flag) is classified by its status.
    expect(
      shouldNotify(
        { ...inc, notified: { ep_x: { at: at(5 * MIN), status: 429 } } },
        ep,
        now,
        60,
      ),
    ).toBe(false);
    // A refused URL (status 0, marked final) is final too.
    expect(
      shouldNotify(
        {
          ...inc,
          notified: { ep_x: { at: at(5 * MIN), status: 0, final: true } },
        },
        ep,
        now,
        60,
      ),
    ).toBe(false);
  });

  it("a retryable failure waits 2, 4, 8 minutes; then the cooldown once another endpoint delivered, else doubling to the cooldown", () => {
    expect(
      [1, 2, 3, 4, 5, 6, 7].map((f) => endpointRetryWaitMs(f, 60, false) / MIN),
    ).toEqual([2, 4, 8, 16, 32, 60, 60]);
    expect(
      [1, 2, 3, 4, 5].map((f) => endpointRetryWaitMs(f, 60, true) / MIN),
    ).toEqual([2, 4, 8, 60, 60]);
    // Capped at a short cooldown.
    expect(
      [1, 2, 3, 4].map((f) => endpointRetryWaitMs(f, 5, false) / MIN),
    ).toEqual([2, 4, 5, 5]);
    const inc = {
      ...base,
      notified: { ep_x: { at: at(3 * MIN), status: 503, fails: 2 } },
    };
    expect(shouldNotify(inc, ep, now, 60)).toBe(false); // 3 of 4 minutes
    expect(
      shouldNotify(
        {
          ...inc,
          notified: { ep_x: { at: at(4 * MIN), status: 503, fails: 2 } },
        },
        ep,
        now,
        60,
      ),
    ).toBe(true);
  });

  it("a closure the endpoint failed with a final 4xx is not retried; a retryable one is, on the ladder", () => {
    const closed = { ...base, closedAt: at(3 * MIN) };
    expect(
      shouldNotify(
        {
          ...closed,
          notified: { ep_x: { at: at(2 * MIN), status: 404, fails: 1 } },
        },
        ep,
        now,
        60,
      ),
    ).toBe(false);
    expect(
      shouldNotify(
        {
          ...closed,
          notified: { ep_x: { at: at(2 * MIN), status: 503, fails: 1 } },
        },
        ep,
        now,
        60,
      ),
    ).toBe(true);
    expect(
      shouldNotify(
        {
          ...closed,
          notified: { ep_x: { at: at(MIN), status: 503, fails: 1 } },
        },
        ep,
        now,
        60,
      ),
    ).toBe(false);
    // A failure before the close does not hold back the closure (it is a new event).
    expect(
      shouldNotify(
        {
          ...closed,
          notified: { ep_x: { at: at(20 * MIN), status: 404, fails: 1 } },
        },
        ep,
        now,
        60,
      ),
    ).toBe(true);
    // Delivered since the close: never again.
    expect(
      shouldNotify(
        {
          ...closed,
          notified: { ep_x: { at: at(MIN), status: 200, ok: at(MIN) } },
        },
        ep,
        now,
        60,
      ),
    ).toBe(false);
  });
});

describe("r2 core-1 · recordDeliveryRef: one failed ref per endpoint, never evict a last ok", () => {
  const ok = (id: string, m: number): DeliveryRef => ({
    endpointId: id,
    status: 200,
    at: new Date(Date.UTC(2026, 8, 28, 15, m)).toISOString(),
  });
  const bad = (id: string, m: number, status = 429): DeliveryRef => ({
    endpointId: id,
    status,
    at: new Date(Date.UTC(2026, 8, 28, 15, m)).toISOString(),
    error: `http_${status}`,
  });

  it("a new failure replaces the endpoint’s previous failed ref", () => {
    let list: DeliveryRef[] = [];
    list = recordDeliveryRef(list, ok("cribl-bell", 0));
    for (let m = 0; m < 30; m += 2)
      list = recordDeliveryRef(list, bad("ep_sink", m));
    expect(list).toEqual([ok("cribl-bell", 0), bad("ep_sink", 28)]);
  });

  it("an ok after failures keeps the ok; the old failure is the first to go when the cap bites", () => {
    let list: DeliveryRef[] = [bad("ep_sink", 0, 503)];
    list = recordDeliveryRef(list, ok("ep_sink", 2));
    expect(list).toEqual([bad("ep_sink", 0, 503), ok("ep_sink", 2)]);
    // 25 hourly reminders on the bell: the cap is 20; the sink's last ok is never evicted.
    for (let m = 3; m < 28; m++)
      list = recordDeliveryRef(list, ok("cribl-bell", m));
    expect(list).toHaveLength(20);
    expect(
      list.some((d) => d.endpointId === "ep_sink" && d.status === 200),
    ).toBe(true);
    expect(
      list.some((d) => d.endpointId === "ep_sink" && d.status === 503),
    ).toBe(false);
    expect(list.at(-1)).toEqual(ok("cribl-bell", 27));
  });

  it("a synthetic 25-ref sequence over three endpoints keeps each endpoint’s last ok and newest ref", () => {
    let list: DeliveryRef[] = [];
    const ids = ["cribl-bell", "ep_sink", "ep_slack"];
    for (let m = 0; m < 25; m++) {
      const id = ids[m % 3];
      list = recordDeliveryRef(list, m % 4 === 0 ? bad(id, m) : ok(id, m));
    }
    expect(list.length).toBeLessThanOrEqual(20);
    for (const id of ids) {
      const mine = list.filter((d) => d.endpointId === id);
      expect(mine.filter((d) => d.status !== 200).length).toBeLessThanOrEqual(
        1,
      );
      expect(mine.some((d) => d.status === 200)).toBe(true);
    }
    // Chronological order is kept.
    const ts = list.map((d) => Date.parse(d.at));
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });
});
