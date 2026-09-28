// src/components/Shell/BootError.tsx — shown when the app can't start at all (e.g. opened outside Cribl
// in a release build, so there is no CRIBL_API_URL). Rendered without the store or router.

import { Alert } from '@capra/core';
import { t } from '../../copy/en.ts';
import './Shell.css';

export function BootError({ error }: { error: unknown }) {
  const detail = error instanceof Error ? error.message : String(error);
  return (
    <div className="mr-boot-error">
      <Alert
        appearance="danger"
        title={t('errors.bootTitle')}
        action={{ label: t('errors.reload'), onClick: () => window.location.reload() }}
      >
        <span>
          {t('errors.bootBody')} <code className="mr-boot-error-detail">{detail}</code>
        </span>
      </Alert>
    </div>
  );
}
