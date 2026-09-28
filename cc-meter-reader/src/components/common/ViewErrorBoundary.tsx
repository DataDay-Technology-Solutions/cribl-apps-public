// src/components/common/ViewErrorBoundary.tsx — a crashed or unloadable view (e.g. a lazy chunk that
// failed to fetch after a redeploy) must not blank the whole app: the shell, nav and footer stay up.

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Alert } from '@capra/core';
import { t } from '../../copy/en.ts';
import { retryFailedViews } from '../../lib/preload.ts';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export class ViewErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[meter-reader] view crashed', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mr-view-error">
        <Alert
          appearance="danger"
          title={t('errors.viewCrashedTitle')}
          // Try again renders the view anew (its chunk is fetched again, src/lib/preload.ts): a reload would end a
          // tour, which lives in memory (OQ-12).
          action={{
            label: t('errors.tryAgain'),
            onClick: () => {
              retryFailedViews();
              this.setState({ error: null });
            },
          }}
        >
          {t('errors.viewCrashedBody')}
        </Alert>
      </div>
    );
  }
}
