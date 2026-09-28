// src/components/Shell/Page.tsx — THE page frame every tab screen renders in (BEAUTY-3a F7; DESIGN_BRIEF §3, §5).
//
// One container, so the left edge and the title never move when you switch tabs:
//   • width      max-width 1280 px, centred (`width: 100%; margin-inline: auto`). `narrow` = 720 px (a lone
//                centred card, e.g. First run).
//   • gutter     the horizontal padding is the Shell's (`.mr-shell-main`: spacing.xl, spacing.lg ≤ 640 px) —
//                Page adds none, so every screen shares exactly one gutter.
//   • title      one `<h1>` in typography.heading.lg, subtitle in body.md subtle (≤ 96ch), optional actions
//                right-aligned on the same row (wrapping under the title on phones).
//   • rhythm     children stack with spacing.xl between them (spacing.lg ≤ 640 px).
//
//   <Page title={t('ledger.title')} subtitle={t('ledger.subtitle')} actions={<Toolbar />} data-testid="ledger-view">
//     …sections…
//   </Page>
//
// A view that adopts Page drops its own root `max-width` / `margin: 0 auto` / outer `gap`. `title` may be
// omitted only by a view whose content already carries the page's h1 (the Receipt's hero label); then no
// header is rendered. Extra props (`data-*`, `aria-*`, `id`, `className`) land on the root element.

import { useId, type HTMLAttributes, type ReactNode } from 'react';
import './Page.css';

export interface PageProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** The page title: one h1 per page (heading.lg). Omit only when the content carries the h1 itself. */
  title?: ReactNode;
  /** One line under the title (body.md, subtle). */
  subtitle?: ReactNode;
  /** Right side of the title row: a group picker, a period toggle, a primary action. */
  actions?: ReactNode;
  /** id of the h1 (default: generated) — pass it when something else is `aria-labelledby` the title. */
  titleId?: string;
  /** 'default' 1280 px (every tab); 'narrow' 720 px (a lone centred card). */
  width?: 'default' | 'narrow';
  children?: ReactNode;
}

export function Page({ title, subtitle, actions, titleId, width = 'default', className, children, ...rest }: PageProps) {
  const generated = useId();
  const headingId = titleId ?? `mr-page-title-${generated}`;
  const hasHeader = title !== undefined && title !== null && title !== false;
  return (
    <div
      {...rest}
      className={className ? `mr-page ${className}` : 'mr-page'}
      data-width={width}
    >
      {hasHeader ? (
        <header className="mr-page-head">
          <div className="mr-page-titles">
            <h1 id={headingId} className="mr-page-title">
              {title}
            </h1>
            {subtitle ? <p className="mr-page-subtitle">{subtitle}</p> : null}
          </div>
          {actions ? <div className="mr-page-actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </div>
  );
}
