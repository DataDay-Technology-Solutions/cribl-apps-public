// src/views/Flow/index.tsx — /flow (PRD 8.2): the granular "streams of money" screen, with the What-if
// toggle (?whatif=1, DESIGN_BRIEF 5.9). The screen itself lives in FlowScreen.tsx (shared with /whatif).

import { FlowScreen } from './FlowScreen.tsx';

export default function FlowView() {
  return <FlowScreen mode="flow" />;
}
