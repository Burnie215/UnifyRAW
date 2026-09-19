import type { ReactNode } from 'react';

export function StyleOption({ name, description, active, onClick, children }: {
  name: string;
  description: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button className={`settings-style-option ${active ? 'active' : ''}`} onClick={onClick}>
      <div className="settings-style-preview">{children}</div>
      <div className="settings-style-label">{name}</div>
      <div className="settings-style-desc">{description}</div>
    </button>
  );
}
