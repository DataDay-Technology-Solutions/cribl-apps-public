// src/views/Presenter/leaderReach.ts — a wrapped saver name's dot leader starts where its last line ends (W3-STAGE-2).
//
// A saver name too long for its line wraps to a second one, and a wrapped box is as wide as the room it was given,
// not as its last line: the leader (the next flex item) would start past a stretch of empty box. So each row's
// leader is told how far its last line stops short of the box's right edge (`--mr-lead-reach`), and its dots are
// drawn from there (a pseudo-element that reaches left, out of flow, so the measurement never feeds back into the
// line breaks it measured). An unwrapped name reaches nothing: its box ends with its text.

import { useLayoutEffect, type RefObject } from 'react';

/** How far the last line of `label` stops short of its box's right edge, in px (0 when it does not). */
export function lastLineGap(label: Element): number {
  const range = label.ownerDocument.createRange();
  range.selectNodeContents(label);
  const lines = [...range.getClientRects()].filter((r) => r.width > 0);
  if (lines.length === 0) return 0;
  const bottom = Math.max(...lines.map((r) => r.bottom));
  // The last line's words (several rects when the text has several nodes): the right-most of those on the last line.
  const right = Math.max(...lines.filter((r) => r.bottom >= bottom - 1).map((r) => r.right));
  const box = label.getBoundingClientRect();
  return Math.max(0, Math.floor(box.right - right));
}

function measureReach(list: HTMLElement, labelSelector: string, leaderSelector: string): void {
  for (const row of list.children) {
    const label = row.querySelector(labelSelector);
    const leader = row.querySelector<HTMLElement>(leaderSelector);
    if (!label || !leader) continue;
    const reach = `${lastLineGap(label)}px`;
    if (leader.style.getPropertyValue('--mr-lead-reach') !== reach) leader.style.setProperty('--mr-lead-reach', reach);
  }
}

/** Keeps every row's `--mr-lead-reach` in step with its name's last line: after every render and on every resize. */
export function useLeaderReach(listRef: RefObject<HTMLElement | null>, labelSelector: string, leaderSelector: string): void {
  useLayoutEffect(() => {
    if (listRef.current) measureReach(listRef.current, labelSelector, leaderSelector);
  });
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measureReach(list, labelSelector, leaderSelector));
    ro.observe(list);
    return () => ro.disconnect();
  }, [listRef, labelSelector, leaderSelector]);
}
