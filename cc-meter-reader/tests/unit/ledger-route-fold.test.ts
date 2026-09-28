// The Ledger prints each name once (leftovers: the tour's "DNS to Cribl Lake" read twice, as its route and as its
// pipeline). With the Route column on, a route named like its pipeline is left to the Pipeline cell (it carries the
// link), a route named like its source folds into the Source cell (P1-K01), and a route that says something of its
// own keeps its cell. A Route column appears only where some route says something neither neighbour does.
// (The rendered rows are virtualized, so the cells themselves are checked in a browser: tests/e2e/leftovers.spec.ts.)

import { describe, expect, it } from 'vitest';
import { nameColumnRows, routeAddsInfo, routeFold, type LedgerRow } from '../../src/components/LedgerTable/index.ts';

type Names = Pick<LedgerRow, 'source' | 'route' | 'pipeline'>;

/** The tour's shapes: route = pipeline, route = source, and a route with a name of its own. */
const DNS: Names = { source: 'Infoblox DNS', route: 'DNS to Cribl Lake', pipeline: 'DNS to Cribl Lake' };
const ASA: Names = { source: 'Cisco ASA', route: 'Cisco ASA', pipeline: 'Cisco ASA trimming' };
const WIN: Names = { source: 'Windows domain controllers', route: 'Windows DC security', pipeline: 'Windows event trimming' };

describe('Ledger: a route is printed once', () => {
  it('leaves a route named like its pipeline to the Pipeline cell, and folds one named like its source into Source', () => {
    expect(routeFold(DNS)).toBe('pipeline');
    expect(routeFold(ASA)).toBe('source');
    expect(routeFold(WIN)).toBeNull();
    // All three alike: the Pipeline cell (with the link) takes the route, as when no Route column is drawn.
    expect(routeFold({ source: 'Zscaler', route: 'Zscaler', pipeline: 'Zscaler' })).toBe('pipeline');
    // No route label: nothing to fold (the cell shows its em dash).
    expect(routeFold({ source: 'Zscaler', route: '', pipeline: '' })).toBeNull();
  });

  it('draws a Route column only where some route says something its source and pipeline do not', () => {
    const rows = (list: Names[]) => list as unknown as LedgerRow[];
    expect(routeAddsInfo(rows([DNS, ASA]))).toBe(false);
    expect(routeAddsInfo(rows([DNS, ASA, WIN]))).toBe(true);
    expect(routeAddsInfo(rows([{ source: 'A', route: '', pipeline: 'B' }]))).toBe(false);
  });

  it('sizes Source and Route by the names they print', () => {
    const SAME: Names = { source: 'Zscaler', route: 'Zscaler', pipeline: 'Zscaler' };
    const rows = [DNS, ASA, WIN, SAME];
    const named = nameColumnRows(rows, true);
    // ASA's route folds into its Source cell (it spans both); DNS and the all-alike row leave Route to the
    // pipeline, and their Source cells are their own.
    expect(named.source).toEqual([DNS, WIN, SAME]);
    expect(named.route).toEqual([WIN]);
    // No Route column: every row sizes Source.
    expect(nameColumnRows(rows, false).source).toEqual(rows);
  });
});
