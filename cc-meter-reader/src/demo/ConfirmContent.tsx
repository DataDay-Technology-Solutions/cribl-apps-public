// src/demo/ConfirmContent.tsx — what a Demo Console confirmation says (src/demo/actions.tsx opens it through Capra's
// Modal.confirm). DEMO BUILD ONLY. Its own module so actions.tsx exports no component (React Fast Refresh; oxlint
// react/only-export-components).

import { t } from '../copy/en.ts';
import type { ConfirmSpec } from './confirm.ts';

/** Splits "Commits and deploys to worker group {group}." around the group, so the id renders as code. */
function deployLine(group: string) {
  const marker = '\u0000';
  const [before, after = ''] = t('demo.confirm.deploys', { group: marker }).split(marker);
  return (
    <span className="mr-demo-confirm-deploy" data-testid="demo-confirm-deploy">
      {before}
      <code className="mr-demo-confirm-id">{group}</code>
      {after}
    </span>
  );
}

/** The confirmation's content. Capra renders it inside a <p>: phrasing elements only (spans laid out in CSS). */
export function ConfirmContent({ spec, id }: { spec: ConfirmSpec; id: string }) {
  return (
    <span className="mr-demo-confirm" data-testid="demo-confirm" data-tone={spec.tone} data-confirm-id={id}>
      <span className="mr-demo-confirm-body">{spec.body}</span>
      <span className="mr-demo-confirm-caption">{t('confirm.affects')}</span>
      <span className="mr-demo-confirm-list" role="list">
        {spec.items.map((a, i) => (
          <span className="mr-demo-confirm-item" role="listitem" key={`${a.id ?? a.label}-${i}`}>
            <span className="mr-demo-confirm-label">{a.label}</span>
            {a.id ? (
              <>
                {' '}
                <code className="mr-demo-confirm-id">{a.id}</code>
              </>
            ) : null}
            <span className="mr-demo-confirm-action">{a.action}</span>
          </span>
        ))}
      </span>
      {spec.deployGroup ? (
        deployLine(spec.deployGroup)
      ) : (
        <span className="mr-demo-confirm-deploy" data-testid="demo-confirm-deploy">
          {t('demo.confirm.noDeploy')}
        </span>
      )}
      {spec.note ? <span className="mr-demo-confirm-note">{spec.note}</span> : null}
    </span>
  );
}
