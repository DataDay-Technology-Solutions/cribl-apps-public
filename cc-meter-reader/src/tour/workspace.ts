// src/tour/workspace.ts — the sample workspace's headline facts, for the first-run card's caption.
// Kept apart from the fixture so the card paints without loading it (tests/unit/tour-fixture.test.ts
// holds these equal to demo/sample/tour.json's `workspace`).

import type { TourWorkspaceFacts } from './types.ts';

export const SAMPLE_WORKSPACE: TourWorkspaceFacts = { name: 'sample-enterprise', sources: 40, destinations: 8, historyDays: 30 };
