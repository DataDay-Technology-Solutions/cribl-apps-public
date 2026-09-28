// src/components/HowItWorks/steps.ts — the four steps (SPEC 17 wording lives in en.ts) and their icons.
// One icon family at one weight (BEAUTY F20): Capra's outlined set only — no filled product glyphs mixed in.

import type { ComponentType } from 'react';
import { BellOutlined, BranchesOutlined, DashboardOutlined, DatabaseOutlined } from '@capra/icons';
import type { CopyKey } from '../../copy/en.ts';

export interface Step {
  key: CopyKey;
  Icon: ComponentType<{ size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'; 'aria-hidden'?: boolean }>;
}

export const HOW_IT_WORKS_STEPS: readonly Step[] = [
  { key: 'howItWorks.step1', Icon: BranchesOutlined },
  { key: 'howItWorks.step2', Icon: DatabaseOutlined },
  { key: 'howItWorks.step3', Icon: DashboardOutlined },
  { key: 'howItWorks.step4', Icon: BellOutlined },
];
