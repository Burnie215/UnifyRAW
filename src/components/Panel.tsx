import { useState, type ReactNode } from 'react';
import './Panel.css';

interface PanelProps {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}

export function Panel({ title, children, defaultOpen = false }: PanelProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={`panel ${open ? 'open' : ''}`}>
      <button className="panel-header" onClick={() => setOpen(!open)}>
        <svg
          className="panel-chevron"
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M3 2l4 3-4 3" />
        </svg>
        <span>{title}</span>
      </button>
      {open && <div className="panel-body">{children}</div>}
    </div>
  );
}
