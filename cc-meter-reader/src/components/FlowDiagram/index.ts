// src/components/FlowDiagram — the Flow map (PRD 8.2): layout (pure), the SVG diagram, the receipt card and
// the FlowMap module that combines them.
export { FlowMap, type FlowMapProps } from './FlowMap.tsx';
export { FlowDiagram, type FlowDiagramProps } from './FlowDiagram.tsx';
export { FlowList, type FlowListProps } from './FlowList.tsx';
export { listRows, type FlowListRow } from './listRows.ts';
export { ReceiptCard, type ReceiptCardProps } from './ReceiptCard.tsx';
export { pathFlowKeys, selectionExists, baselineMultiple, flowCount, type FlowSelection } from './selection.ts';
export { layoutText, nodeName, pipelineHref } from './text.ts';
export { SOURCE_HUES, assignSourceHues, hueClass } from './sourceColors.ts';
export {
  computeFlowLayout,
  groupSmallFlows,
  priceWeight,
  OTHER_ID,
  GROUP_BELOW_SHARE,
  PLATE_MIN_RIBBON,
  interpolateLayout,
  isDrawable,
  ribbonId,
  sourceHues,
  sumTotals,
  type FlowLayout,
  type LayoutFlow,
  type LayoutNode,
  type LayoutRibbon,
  type LayoutLabel,
  type NodeTotals,
} from './layout.ts';
