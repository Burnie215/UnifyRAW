import { useEffect, useRef, type ReactNode } from 'react';
import './ContextMenu.css';

/**
 * Either a plain command row, or a custom row that brings its own controls
 * (a rating strip, a flag row). The custom row gets the menu's own closer so
 * a click inside it dismisses the menu like a command does.
 */
export type ContextMenuItem =
  | {
      label: string;
      onClick: () => void;
      destructive?: boolean;
      disabled?: boolean;
      render?: never;
    }
  | {
      render: (close: () => void) => ReactNode;
      label?: never;
      onClick?: never;
      destructive?: never;
      disabled?: never;
    };

interface Props {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Clamp to viewport so the menu never overflows.
  const style: React.CSSProperties = { left: x, top: y };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const dx = Math.max(0, rect.right - window.innerWidth + 4);
    const dy = Math.max(0, rect.bottom - window.innerHeight + 4);
    if (dx || dy) {
      el.style.left = `${x - dx}px`;
      el.style.top = `${y - dy}px`;
    }
  }, [x, y]);

  return (
    <div ref={ref} className="context-menu" style={style} role="menu">
      {items.map((item, i) => (item.render ? (
        <div key={i} className="context-menu-row" role="none">
          {item.render(onClose)}
        </div>
      ) : (
        <button
          key={i}
          role="menuitem"
          className={`context-menu-item ${item.destructive ? 'destructive' : ''}`}
          disabled={item.disabled}
          onClick={() => {
            if (!item.disabled) {
              item.onClick();
              onClose();
            }
          }}
        >
          {item.label}
        </button>
      )))}
    </div>
  );
}
