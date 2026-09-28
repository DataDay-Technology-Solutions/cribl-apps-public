// tests/unit/design-brief-callouts.test.ts — docs/DESIGN_BRIEF.md §8 lists every Story/video callout id the product
// uses (W3-DOCS-3). The Story's dollar-map beat (P2-W11) added flow-plate and flow-saved to src/story/beats.ts
// CALLOUT_IDS; the brief is the binding spec builders read, so an id the Story points at and the brief does not
// name fails here.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CALLOUT_IDS, VIEW_CALLOUTS } from '../../src/story/beats.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const brief = readFileSync(join(ROOT, 'docs', 'DESIGN_BRIEF.md'), 'utf8');

/** §8, from its heading to the next "## " heading or the end. */
function section8(): string {
  const at = brief.indexOf('## 8. Story/video callout ids');
  expect(at, 'DESIGN_BRIEF keeps §8').toBeGreaterThanOrEqual(0);
  const next = brief.indexOf('\n## ', at + 1);
  return brief.slice(at, next < 0 ? undefined : next);
}

describe('DESIGN_BRIEF §8 names every callout id (W3-DOCS-3)', () => {
  const s8 = section8();

  it.each([...CALLOUT_IDS])('lists `%s`', (id) => {
    expect(s8).toContain(`\`${id}\``);
  });

  it('says what the Story flow ids point at and which view carries them', () => {
    expect(VIEW_CALLOUTS.flow).toEqual(['flow-plate', 'flow-saved']);
    expect(s8).toMatch(/\*\*`flow-plate`\*\*, a ribbon's \$ \/ day plate/);
    expect(s8).toMatch(/\*\*`flow-saved`\*\*, the \$-saved plate on that ribbon's hatched wedge/);
    // The Story's FlowStage sets the ids on the plates FlowDiagram draws (src/views/Story/stages.tsx).
    const stages = readFileSync(join(ROOT, 'src', 'views', 'Story', 'stages.tsx'), 'utf8');
    expect(stages).toMatch(/picked\??\.plate\.setAttribute\('data-callout', 'flow-plate'\)/);
    expect(stages).toMatch(/picked\??\.saved\.setAttribute\('data-callout', 'flow-saved'\)/);
    // W3-STAGE-3: the flow-saved callout's dot is placed on the hatched wedge itself (data-callout-dot).
    expect(stages).toContain("setAttribute('data-callout-dot'");
    expect(s8).toContain('`data-callout-dot=');
  });
});
