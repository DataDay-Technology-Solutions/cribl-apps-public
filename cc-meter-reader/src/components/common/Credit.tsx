// src/components/common/Credit.tsx — the builder's signature ("Meter Reader · built by Steve Koelpin"), with the
// name set a touch stronger than the words around it, as a builder signs his work. The words are the copy key's
// (src/copy/en.ts `credit.*`); `{name}` is core's one builder name (core/strings.ts CREDIT_STRINGS.builder), the same
// name the receipts, the alert messages and the report card sign with. The text reads as one run for a screen reader.

import { CREDIT_STRINGS, t, type CopyKey, type CopyVars } from '../../copy/en.ts';

/** A placeholder no copy string holds, so the filled words split exactly around the name. */
const NAME_SLOT = '\u0000';

export interface CreditProps {
  copyKey: CopyKey;
  /** Other placeholders the key carries ({version} on the About line). */
  vars?: CopyVars;
  className?: string;
  testId?: string;
}

export function Credit({ copyKey, vars, className, testId }: CreditProps) {
  const [before, after = ''] = t(copyKey, { ...vars, name: NAME_SLOT }).split(NAME_SLOT);
  return (
    <span className={['mr-credit', className].filter(Boolean).join(' ')} data-testid={testId}>
      {before}
      <span className="mr-credit-name">{CREDIT_STRINGS.builder}</span>
      {after}
    </span>
  );
}
