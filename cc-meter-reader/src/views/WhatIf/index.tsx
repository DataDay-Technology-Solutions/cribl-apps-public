// src/views/WhatIf/index.tsx — /whatif (DESIGN_BRIEF 5.9, DECISIONS D16): the What-if calculator over the
// Flow map in projection mode. Same screen as /flow with the calculator always open.

import { FlowScreen } from '../Flow/FlowScreen.tsx';

export default function WhatIfView() {
  return <FlowScreen mode="whatif" />;
}
