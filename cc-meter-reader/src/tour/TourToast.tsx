// src/tour/TourToast.tsx — the body of a tour toast: a title line and one supporting line.

import './tour.css';

export interface TourToastBodyProps {
  title: string;
  body?: string;
}

export function TourToastBody({ title, body }: TourToastBodyProps) {
  return (
    <span className="mr-tour-toast">
      <span className="mr-tour-toast-title">{title}</span>
      {body ? <span className="mr-tour-toast-body mr-num">{body}</span> : null}
    </span>
  );
}
