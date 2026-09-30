// tests/unit/r2-core-closure-retry.test.ts — founder-build r2 core-2 (FINDINGS_R2 #5; M8 half-fixed in r1).
//
// A closure the bell delivered was never retried to a webhook that failed it: `undeliveredClosure` gated on the
// incident-wide `lastNotifiedAt`, which the bell's 2xx had moved past the close, so the closed incident was skipped
// and the webhook's `notified` stayed at 503. Now the pick-up is per endpoint: an endpoint told of the opening that has
// not delivered since the close, and whose last attempt is retryable, keeps the closure pending for
// UNDELIVERED_CLOSURE_MS, retried on core-1's back-off; a final 4xx is not retried; the bell hears it once.
// Probes: AA/r2/4 zz-f4-closure-retry.test.ts, AA/r2/3 zz-r23-alerts.test.ts (A).

import { describe, expect, it } from "vitest";
import type { Incident, WebhookSender } from "../../core/types.ts";
import { breakTrim, restoreTrim } from "../../core/demo/levers.ts";
import {
  UNDELIVERED_CLOSURE_MS,
  undeliveredClosure,
} from "../../core/sweep.ts";
import { SINK_ENDPOINT, createWorld } from "../integration/harness.ts";

const MIN = 60_000;

async function run(
  closedStatus: number,
  withBell: boolean,
  opts: {
    failures?: number;
    breakMinutes?: number;
    afterMinutes?: number;
  } = {},
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
  let failClosed = 0;
  const sink: { t: number; status: number; event: string; inc?: string }[] = [];
  const sender: WebhookSender = {
    post: async (url, body, to) => {
      const j = JSON.parse(body) as {
        event: string;
        incident?: { id: string };
      };
      if (
        url === SINK_ENDPOINT.url &&
        failClosed > 0 &&
        j.event === "incident.closed"
      ) {
        failClosed--;
        sink.push({
          t: w.now(),
          status: closedStatus,
          event: j.event,
          inc: j.incident?.id,
        });
        return { status: closedStatus };
      }
      const r = await real.post(url, body, to);
      if (url === SINK_ENDPOINT.url)
        sink.push({
          t: w.now(),
          status: r.status,
          event: j.event,
          inc: j.incident?.id,
        });
      return r;
    },
  };
  await w.sweep();
  await w.sweepMinutes(3, { webhook: sender });
  expect((await breakTrim(w.lever, { pipelineId: "mrd_pay_sample" })).ok).toBe(
    true,
  );
  await w.sweepMinutes(opts.breakMinutes ?? 5, { webhook: sender });
  failClosed = opts.failures ?? 1;
  expect(
    (await restoreTrim(w.lever, { pipelineId: "mrd_pay_sample" })).ok,
  ).toBe(true);
  const res = await w.sweepMinutes(opts.afterMinutes ?? 20, {
    webhook: sender,
  });
  const inc = res
    .flatMap((r) => r.snapshot?.incidents ?? [])
    .find((i) => i.type === "regression" && i.closedAt)!;
  expect(inc).toBeDefined();
  const hook = sink.filter((s) => s.inc === inc.id);
  const log = (await w.docs.getNotifyLog())!.items.filter(
    (l) => l.incidentId === inc.id,
  );
  const final = (await w.docs.getSnapshot())!.incidents.find(
    (i) => i.id === inc.id,
  )!;
  return { w, inc: final, hook, log };
}

describe("r2 core-2 · a closure the bell delivered is retried to a webhook that failed it", () => {
  it("bell on, webhook 503 once on the closure: incident.closed 200 within 5 minutes; the bell hears it once", async () => {
    const { hook, log, inc } = await run(503, true);
    const failed = hook.find(
      (h) => h.event === "incident.closed" && h.status === 503,
    )!;
    const ok = hook.find(
      (h) => h.event === "incident.closed" && h.status === 200,
    );
    expect(failed).toBeDefined();
    expect(ok).toBeDefined();
    expect(ok!.t - failed.t).toBeLessThanOrEqual(5 * MIN);
    expect(
      log.filter(
        (l) => l.endpointId === "cribl-bell" && l.event === "incident.closed",
      ),
    ).toHaveLength(1);
    expect(inc.notified?.[SINK_ENDPOINT.id]?.status).toBe(200);
    // Delivered once: nothing after the 200.
    expect(
      hook.filter((h) => h.event === "incident.closed" && h.status === 200),
    ).toHaveLength(1);
  }, 180_000);

  it("bell on, webhook 503 twice on the closure: retried at +2 and +4 minutes, delivered inside the 10-minute window", async () => {
    const { hook } = await run(503, true, { failures: 2 });
    const closedPosts = hook.filter((h) => h.event === "incident.closed");
    expect(closedPosts.map((h) => h.status)).toEqual([503, 503, 200]);
    expect(Math.round((closedPosts[1].t - closedPosts[0].t) / MIN)).toBe(2);
    expect(Math.round((closedPosts[2].t - closedPosts[1].t) / MIN)).toBe(4);
  }, 180_000);

  it("bell on, webhook 404 on the closure: a final 4xx is not retried", async () => {
    const { hook, log } = await run(404, true, { failures: 5 });
    expect(hook.filter((h) => h.event === "incident.closed")).toHaveLength(1);
    expect(
      log.filter(
        (l) => l.endpointId === "cribl-bell" && l.event === "incident.closed",
      ),
    ).toHaveLength(1);
  }, 180_000);

  it("probe A: break 6 min, restore, 30 min; the closure 503 once still reaches the webhook", async () => {
    const { hook, inc } = await run(503, true, {
      breakMinutes: 6,
      afterMinutes: 30,
    });
    expect(inc.closedAt).toBeDefined();
    expect(
      hook.some((h) => h.event === "incident.closed" && h.status === 200),
    ).toBe(true);
  }, 180_000);

  it("control: bell off, webhook 503 once on the closure: retried and delivered (unchanged)", async () => {
    const { hook } = await run(503, false);
    const closedPosts = hook.filter((h) => h.event === "incident.closed");
    expect(closedPosts.map((h) => h.status)).toEqual([503, 200]);
    expect(closedPosts[1].t - closedPosts[0].t).toBeLessThanOrEqual(5 * MIN);
  }, 180_000);
});

describe("r2 core-2 · undeliveredClosure is per endpoint", () => {
  const now = Date.parse("2026-09-28T16:00:00Z");
  const at = (ago: number) => new Date(now - ago).toISOString();
  const base = {
    id: "inc_000002",
    type: "regression",
    severity: "high",
    objectKey: "route:default:r1",
    label: "x",
    openedAt: at(30 * MIN),
    closedAt: at(3 * MIN),
    lastNotifiedAt: at(2 * MIN), // the bell delivered the closure
    before: 0.75,
    after: 0.25,
    deliveries: [],
  } as unknown as Incident;
  const bellOk = { at: at(2 * MIN), status: 200, ok: at(2 * MIN) };

  it("pending while an endpoint told of the opening has a retryable failure since the close", () => {
    const inc = {
      ...base,
      notified: {
        "cribl-bell": bellOk,
        ep_sink: { at: at(2 * MIN), status: 503, ok: at(25 * MIN), fails: 1 },
      },
    };
    expect(undeliveredClosure(inc, now)).toBe(true);
    // Only the endpoints still delivering count, when the caller names them.
    expect(undeliveredClosure(inc, now, new Set(["cribl-bell"]))).toBe(false);
    expect(
      undeliveredClosure(inc, now, new Set(["cribl-bell", "ep_sink"])),
    ).toBe(true);
  });

  it("not pending for a final failure, a delivered closure, an endpoint never told, or past the window", () => {
    const final = {
      ...base,
      notified: {
        "cribl-bell": bellOk,
        ep_sink: {
          at: at(2 * MIN),
          status: 404,
          ok: at(25 * MIN),
          fails: 1,
          final: true as const,
        },
      },
    };
    expect(undeliveredClosure(final, now)).toBe(false);
    const delivered = {
      ...base,
      notified: {
        "cribl-bell": bellOk,
        ep_sink: { at: at(MIN), status: 200, ok: at(MIN) },
      },
    };
    expect(undeliveredClosure(delivered, now)).toBe(false);
    const neverTold = {
      ...base,
      notified: {
        "cribl-bell": bellOk,
        ep_sink: { at: at(2 * MIN), status: 503, fails: 4 },
      },
    };
    expect(undeliveredClosure(neverTold, now)).toBe(false);
    const late = {
      ...base,
      closedAt: at(UNDELIVERED_CLOSURE_MS + MIN),
      notified: {
        "cribl-bell": bellOk,
        ep_sink: { at: at(2 * MIN), status: 503, ok: at(25 * MIN), fails: 1 },
      },
    };
    expect(undeliveredClosure(late, now)).toBe(false);
  });

  it("pending when an endpoint told of the opening has not been tried since the close (a tab deferred)", () => {
    const inc = {
      ...base,
      lastNotifiedAt: at(25 * MIN),
      notified: {
        ep_sink: { at: at(25 * MIN), status: 200, ok: at(25 * MIN) },
      },
    };
    expect(undeliveredClosure(inc, now)).toBe(true);
  });

  it("an incident without per-endpoint records keeps the incident-wide rule", () => {
    expect(
      undeliveredClosure({ ...base, lastNotifiedAt: at(10 * MIN) }, now),
    ).toBe(true);
    expect(undeliveredClosure({ ...base, lastNotifiedAt: at(MIN) }, now)).toBe(
      false,
    );
    expect(
      undeliveredClosure({ ...base, lastNotifiedAt: undefined }, now),
    ).toBe(false);
    expect(
      undeliveredClosure(
        { ...base, type: "goodnews", lastNotifiedAt: undefined },
        now,
      ),
    ).toBe(true);
  });
});
