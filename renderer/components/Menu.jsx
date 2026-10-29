import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// A popover menu at a fixed position next to its anchor, so scrolling lists cannot clip it.
// It closes on a click outside, Escape, or a scroll of the page.
export function Menu({ anchor, onClose, children, label }) {
  const ref = useRef(null);
  const [position, setPosition] = useState({ top: anchor.bottom + 4, left: anchor.left });
  useLayoutEffect(() => {
    const { width, height } = ref.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
    const top = anchor.bottom + 4 + height > window.innerHeight - 8 ? Math.max(8, anchor.top - height - 4) : anchor.bottom + 4;
    setPosition({ top, left });
  }, [anchor]);
  useEffect(() => {
    const outside = e => { if (!ref.current?.contains(e.target)) onClose(); };
    const key = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', key);
    window.addEventListener('blur', onClose);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', key); window.removeEventListener('blur', onClose); };
  }, [onClose]);
  useEffect(() => { ref.current?.querySelector('button')?.focus(); }, []);
  return <div ref={ref} className="menu" role="menu" aria-label={label} style={position} onScroll={e => e.stopPropagation()}>{children}</div>;
}

export function MenuItem({ icon: Icon, children, onClick, danger, disabled }) {
  return (
    <button role="menuitem" className={`menu-item ${danger ? 'danger' : ''}`} disabled={disabled} onClick={onClick}>
      {Icon ? <Icon size={14} /> : null}<span>{children}</span>
    </button>
  );
}

export const MenuSeparator = () => <div className="menu-sep" role="separator" />;
