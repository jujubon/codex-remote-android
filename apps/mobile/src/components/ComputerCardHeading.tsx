import type { ReactNode } from 'react';

export function ComputerCardHeading({ title, icon, children }: { title: string; icon: ReactNode; children?: ReactNode }) {
  return <header className="computer-utility-header">
    <div className="computer-card-title">
      <span className="computer-card-icon" aria-hidden="true">{icon}</span>
      <h2>{title}</h2>
    </div>
    {children}
  </header>;
}
