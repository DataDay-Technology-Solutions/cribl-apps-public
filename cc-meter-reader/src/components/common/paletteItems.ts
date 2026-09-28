// src/components/common/paletteItems.ts — what the ⌘K palette can find and run (EPIC_AUDIT P2-W22), pure so it
// can be tested: the tabs and Settings pages, every source, pipeline and destination on screen (by the names
// the app shows, humanized), and the actions with the key caps they answer to. Matching is forgiving but
// ordered: a label that starts with the query, then a word that does, then a label that contains it, then
// the letters in order.

import type { Snapshot } from '../../../core/types.ts';
import { humanize } from '../../../core/humanize.ts';
import { objectKey } from '../../../core/flows.ts';
import { t } from '../../copy/en.ts';
import { hrefWithStickyParams } from '../../lib/params.ts';

export type PaletteGroup = 'actions' | 'goto' | 'sources' | 'pipelines' | 'destinations' | 'levers';

export type PaletteRun =
  /** Navigate to an in-app href (sticky params added by the caller). */
  | { kind: 'navigate'; to: string; focusSearch?: boolean }
  /** Run the handler registered for a key in the keyboard map (P, Y, Shift+D, a lever). */
  | { kind: 'shortcut'; key: string }
  | { kind: 'sweep' };

export interface PaletteItem {
  id: string;
  group: PaletteGroup;
  label: string;
  /** a second line: where it goes, or what it does */
  hint?: string;
  /** the key cap it answers to outside the palette */
  keyCap?: string;
  /** more words to match ('math', 'present') */
  keywords?: string[];
  run: PaletteRun;
}

export const GROUP_ORDER: readonly PaletteGroup[] = ['actions', 'goto', 'sources', 'pipelines', 'destinations', 'levers'];

export interface PaletteContext {
  snapshot: Snapshot | null;
  labels?: Record<string, string>;
  /** demo build with demo mode on: the lever keys are listed */
  levers?: readonly { key: string; label: string }[];
  demoTab?: boolean;
  /** live and hydrated: Sweep now can run */
  canSweep?: boolean;
}

/** Every item the palette offers, in group order (sources, pipelines and destinations de-duplicated). */
export function paletteItems(ctx: PaletteContext): PaletteItem[] {
  const items: PaletteItem[] = [
    { id: 'act:presenter', group: 'actions', label: t('shortcuts.presenter'), keyCap: 'P', keywords: ['present', 'stage', 'projector'], run: { kind: 'shortcut', key: 'P' } },
    { id: 'act:story', group: 'actions', label: t('shortcuts.story'), keyCap: 'Y', keywords: ['video', 'tour', 'play'], run: { kind: 'shortcut', key: 'Y' } },
    {
      id: 'act:booth',
      group: 'actions',
      label: t('palette.booth'),
      hint: t('palette.boothHint'),
      keywords: ['story', 'fullscreen', 'loop', 'kiosk'],
      run: { kind: 'navigate', to: '/?story=1&stage=1' },
    },
    { id: 'act:search', group: 'actions', label: t('palette.search'), keyCap: '/', keywords: ['find', 'filter'], run: { kind: 'navigate', to: '/ledger', focusSearch: true } },
    { id: 'act:report', group: 'actions', label: t('palette.report'), keywords: ['pdf', 'cfo', 'leadership', 'download'], run: { kind: 'navigate', to: '/report' } },
    { id: 'act:diag', group: 'actions', label: t('palette.diagnostics'), keyCap: 'Shift+D', keywords: ['debug', 'support'], run: { kind: 'shortcut', key: 'Shift+D' } },
  ];
  if (ctx.canSweep) items.push({ id: 'act:sweep', group: 'actions', label: t('palette.sweepNow'), keywords: ['meter', 'refresh'], run: { kind: 'sweep' } });

  const tabs: [string, string, string[]][] = [
    ['/', t('nav.receipt'), ['saved', 'home', 'money']],
    ['/flow', t('nav.flow'), ['map', 'sankey']],
    ['/whatif', t('nav.whatif'), ['dry run', 'pack', 'projection']],
    ['/ledger', t('nav.ledger'), ['table', 'timeline', 'alerts']],
    ['/settings/prices', `${t('nav.settings')} · ${t('settings.groups.prices')}`, ['price', 'cost']],
    ['/settings', `${t('nav.settings')} · ${t('settings.groups.alerts')}`, ['budgets', 'thresholds']],
    ['/settings/notifications', `${t('nav.settings')} · ${t('settings.groups.notifications')}`, ['slack', 'bell', 'webhook', 'notify']],
  ];
  // Demo build only, tested inline so the release bundle carries no '/demo' (compliance: no Demo Console).
  if (import.meta.env.VITE_MR_BUILD === 'demo' && ctx.demoTab) tabs.push(['/demo', t('nav.demo'), ['levers', 'console']]);
  for (const [to, label, keywords] of tabs) items.push({ id: `go:${to}`, group: 'goto', label, keywords, run: { kind: 'navigate', to } });

  const labels = ctx.labels ?? {};
  const seen = new Set<string>();
  for (const f of ctx.snapshot?.flows ?? []) {
    const add = (group: PaletteGroup, kind: 'in' | 'pipe' | 'out', id: string, hint: string, to: string) => {
      if (!id || id === '-') return;
      const key = objectKey(kind, f.groupId, id);
      if (seen.has(key)) return;
      seen.add(key);
      items.push({ id: key, group, label: humanize(id, labels), hint, keywords: [id], run: { kind: 'navigate', to } });
    };
    add('sources', 'in', f.inputId, t('palette.inLedger'), `/ledger?object=${encodeURIComponent(objectKey('in', f.groupId, f.inputId))}`);
    add('pipelines', 'pipe', f.pipelineId, t('palette.inLedger'), `/ledger?object=${encodeURIComponent(objectKey('pipe', f.groupId, f.pipelineId))}`);
    add('destinations', 'out', f.outputId, t('palette.price'), '/settings/prices');
  }
  for (const lever of ctx.levers ?? []) {
    items.push({ id: `lever:${lever.key}:${lever.label}`, group: 'levers', label: lever.label, keyCap: lever.key, run: { kind: 'shortcut', key: lever.key } });
  }
  return items;
}

/** How well `query` matches `text` (0 = not at all). */
export function matchScore(text: string, query: string): number {
  const hay = text.toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  if (hay.startsWith(q)) return 100;
  if (hay.split(/[^a-z0-9]+/).some((word) => word.startsWith(q))) return 80;
  if (hay.includes(q)) return 60;
  if (q.length < 2) return 0;
  let at = 0;
  for (const ch of q) {
    at = hay.indexOf(ch, at);
    if (at < 0) return 0;
    at += 1;
  }
  return 20;
}

/**
 * The items that match, best first (a label beats a keyword beats a hint; ties keep group order), at most
 * `limit`. An empty query returns everything in group order.
 */
export function filterItems(items: readonly PaletteItem[], query: string, limit = 50): PaletteItem[] {
  if (!query.trim()) return items.slice(0, limit);
  const scored = items
    .map((item, index) => {
      const label = matchScore(item.label, query);
      const keyword = Math.max(0, ...(item.keywords ?? []).map((k) => matchScore(k, query) - 5));
      const hint = item.hint ? matchScore(item.hint, query) - 30 : 0;
      return { item, index, score: Math.max(label, keyword, hint) };
    })
    .filter((s) => s.score > 0);
  scored.sort((a, b) => b.score - a.score || GROUP_ORDER.indexOf(a.item.group) - GROUP_ORDER.indexOf(b.item.group) || a.index - b.index);
  return scored.slice(0, limit).map((s) => s.item);
}

/** `to` (which may carry its own query) with the current URL's sticky params (?group, ?period, ?range). */
export function withStickyParams(to: string, current: URLSearchParams): string {
  const [path, query = ''] = to.split('?');
  const base = hrefWithStickyParams(path, current);
  if (!query) return base;
  return `${base}${base.includes('?') ? '&' : '?'}${query}`;
}
