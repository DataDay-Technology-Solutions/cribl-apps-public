// tests/unit/r1-core-lever-shared-file.test.ts — founder-build r1 core-5 (FINDINGS_R1 m25, #56). A demo lever commits
// the group's shared configuration file whole: Apply/Revert the pack rewrite `pipelines/route.yml` (every route of
// the group), Spike/Calm rewrite `inputs.yml` (every Source). When that file already had someone else's uncommitted
// edit — to a route or Source that is not the rig's — the lever's commit shipped it (skeptic 2 shipped `default` with
// a changed description this way; AA/r1/skeptic2-f56/sk56.probe.test.ts). Now a lever that would commit a shared file
// refuses when the file was already pending before it touched anything, the same guard scripts/rig/apply.mjs keeps
// (RIG.md "Commit safety"). Nothing is written, nothing committed.

import { describe, expect, it } from 'vitest';
import { applyPack, revertPack, setRate } from '../../core/demo/levers.ts';
import { createWorld, type World } from '../integration/harness.ts';

type Obj = Record<string, unknown>;

async function call(w: World, method: string, path: string, body?: unknown): Promise<{ status: number; json: { items?: Obj[] } }> {
  const res = await w.em.handle({ method, url: `/api/v1${path}`, headers: { 'content-type': 'application/json' }, body: body === undefined ? null : JSON.stringify(body) });
  return { status: res.status, json: JSON.parse(res.body ?? '{}') as { items?: Obj[] } };
}
const state = (w: World) => w.em.state() as { pending?: string[]; commits?: { message: string; files: string[] }[] };

/** Someone edits the (untagged) `default` route in Cribl and does not commit: route.yml is now pending. */
async function dirtyRouteTable(w: World, description: string): Promise<void> {
  const table = (await call(w, 'GET', '/m/default/routes')).json.items![0];
  const routes = (table.routes as Obj[]).map((r) => (r.id === 'default' ? { ...r, description } : r));
  expect((await call(w, 'PATCH', `/m/default/routes/${String(table.id)}`, { ...table, routes })).status).toBe(200);
}
async function defaultRoute(w: World): Promise<Obj> {
  const t = (await call(w, 'GET', '/m/default/routes')).json.items![0];
  return (t.routes as Obj[]).find((x) => x.id === 'default')!;
}

describe('core-5 · m25: a lever never commits a shared file someone else left pending', () => {
  it('control: a clean route table → Apply the pack commits route.yml alone', async () => {
    const w = await createWorld();
    const r = await applyPack(w.lever, { routeId: 'mrd_windows_workstations' });
    expect(r.ok).toBe(true);
    expect((r as { files?: string[] }).files).toEqual(['groups/default/local/cribl/pipelines/route.yml']);
  });

  it('a pending route.yml (an edit to the untagged default route) → Apply and Revert refuse; nothing is written or committed', async () => {
    const w = await createWorld();
    const applied = await applyPack(w.lever, { routeId: 'mrd_windows_workstations' });
    expect(applied.ok).toBe(true);
    const commitsBefore = state(w).commits?.length ?? 0;
    await dirtyRouteTable(w, 'an unreviewed ops edit');
    const pendingBefore = [...(state(w).pending ?? [])];
    const before = await call(w, 'GET', '/m/default/routes');

    const revert = await revertPack(w.lever, { routeId: 'mrd_windows_workstations' });
    expect(revert).toMatchObject({ ok: false, error: 'shared_file_dirty', status: 409 });
    expect((revert as { message: string }).message).toMatch(/route\.yml/);
    expect(state(w).commits?.length ?? 0).toBe(commitsBefore);
    expect(state(w).pending).toEqual(pendingBefore);
    // The route table is byte for byte what the member left: the lever PATCHed nothing.
    expect((await call(w, 'GET', '/m/default/routes')).json).toEqual(before.json);
    expect((await defaultRoute(w)).description).toBe('an unreviewed ops edit');

    const w2 = await createWorld();
    await dirtyRouteTable(w2, 'another unreviewed edit');
    const apply = await applyPack(w2.lever, { routeId: 'mrd_pan_firewall' });
    expect(apply).toMatchObject({ ok: false, error: 'shared_file_dirty' });
    expect(state(w2).commits?.some((c) => c.message.startsWith('demo:'))).toBeFalsy();
  });

  it('a pending inputs.yml (an edit to an untagged Source) → Spike refuses and commits nothing', async () => {
    const w = await createWorld();
    const inputs = (await call(w, 'GET', '/m/default/system/inputs')).json.items!;
    const other = inputs.find((i) => !String(i.id).startsWith('mrd_') && !String(i.description ?? '').includes('[meter-reader-demo]'))!;
    expect((await call(w, 'PATCH', `/m/default/system/inputs/${encodeURIComponent(String(other.id))}`, { ...other, description: 'unreviewed' })).status).toBe(200);
    const commitsBefore = state(w).commits?.length ?? 0;
    const r = await setRate(w.lever, { inputId: 'mrd_payments_api', multiplier: 5 });
    expect(r).toMatchObject({ ok: false, error: 'shared_file_dirty', status: 409 });
    expect((r as { message: string }).message).toMatch(/inputs\.yml/);
    expect(state(w).commits?.length ?? 0).toBe(commitsBefore);
  });

  it('a pipeline lever (Break / Restore the trim) commits only its own conf.yml, so a pending route.yml does not stop it', async () => {
    const { breakTrim } = await import('../../core/demo/levers.ts');
    const w = await createWorld();
    await dirtyRouteTable(w, 'an unreviewed ops edit');
    const r = await breakTrim(w.lever, { pipelineId: 'mrd_pay_sample' });
    expect(r.ok).toBe(true);
    expect((r as { files?: string[] }).files).toEqual(['groups/default/local/cribl/pipelines/mrd_pay_sample/conf.yml']);
    expect(state(w).pending).toContain('groups/default/local/cribl/pipelines/route.yml'); // left for its owner
  });
});
