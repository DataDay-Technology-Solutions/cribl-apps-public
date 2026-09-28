// src/components/WhatIf/Fig.tsx — a What-if figure on screen (figures.ts): its pieces in tabular figures, and a
// line may break only between them (after a range's dash), never inside "24.0 GB".

import { Fragment, type ReactNode } from 'react';
import type { Figure } from './figures.ts';

export function Fig({ f, className, callout, testId }: { f: Figure; className?: string; callout?: string; testId?: string }) {
  return (
    <span className={className} data-callout={callout} data-testid={testId}>
      {f.parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 ? <wbr /> : null}
          <span className="mr-num">{p}</span>
        </Fragment>
      ))}
    </span>
  );
}

/**
 * A sentence from src/copy/en.ts with React nodes in its {placeholders} ("Projected {projected}, measured
 * {measured}…"), so the copy stays whole while its figures are styled; the rest stays plain text. Each figure
 * keeps the word before it on its line ("measured 34%" never splits), so a narrow line breaks between phrases.
 */
export function Rich({ template, parts }: { template: string; parts: Readonly<Record<string, ReactNode>> }) {
  const chunks = template.split(/(\{\w+\})/);
  const out: ReactNode[] = [];
  chunks.forEach((chunk, i) => {
    const name = /^\{(\w+)\}$/.exec(chunk)?.[1];
    if (name === undefined || !(name in parts)) {
      // A text chunk: its last word goes with the figure that follows it.
      const next = /^\{(\w+)\}$/.exec(chunks[i + 1] ?? '')?.[1];
      const lead = next !== undefined && next in parts ? /\S+ $/.exec(chunk)?.[0] : undefined;
      out.push(<Fragment key={i}>{lead ? chunk.slice(0, -lead.length) : chunk}</Fragment>);
      return;
    }
    const prev = chunks[i - 1] ?? '';
    const lead = /\S+ $/.exec(prev)?.[0];
    out.push(
      <span key={i} className="mr-whatif-keep">
        {lead}
        {parts[name]}
      </span>,
    );
  });
  return <>{out}</>;
}
