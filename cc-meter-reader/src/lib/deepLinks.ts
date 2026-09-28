// src/lib/deepLinks.ts — whether a pipeline name may deep-link into Cribl (target _top, SPEC 13).
//
// Off on sample data (OQ-01): the tour's worker groups and pipelines exist only in demo/sample/tour.json, so a link
// would take the whole Cribl page to a pipeline the judge's workspace does not have, and the in-memory tour with it.
// The shell provides the value; outside it (unit tests, a view rendered alone) links stay on.

import { createContext, useContext } from 'react';

export const DeepLinksContext = createContext(true);

export function useDeepLinks(): boolean {
  return useContext(DeepLinksContext);
}
