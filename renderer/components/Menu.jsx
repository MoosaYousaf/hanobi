import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// A popover menu at a fixed position next to its anchor, so scrolling lists cannot clip it.
// It closes on a click outside, Escape, or a scroll of the page. A press on `trigger` (the button that opens it) is not
// outside, so that button can close the menu with its own click instead of closing and opening it again.
// It renders in document.body: inside a pressed row, the row's :active transform moved the fixed menu under the
// pointer, so the click missed its item.
export function Menu({ anchor, trigger, onClose, children, label }) {
  const ref = useRef(null);
  const [position, setPosition] = useState({ top: anchor.bottom + 4, left: anchor.left });
  useLayoutEffect(() => {
    const { width, height } = ref.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
    const top = anchor.bottom + 4 + height > window.innerHeight - 8 ? Math.max(8, anchor.top - height - 4) : anchor.bottom + 4;
    setPosition({ top, left });
  }, [anchor]);
  useEffect(() => {
    const outside = e => { if (!ref.current?.contains(e.target) && !trigger?.contains(e.target)) onClose(); };
    const key = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', key);
    window.addEventListener('blur', onClose);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', key); window.removeEventListener('blur', onClose); };
  }, [onClose, trigger]);
  useEffect(() => { ref.current?.querySelector('button')?.focus(); }, []);
  return createPortal(<div ref={ref} className="menu" role="menu" aria-label={label} style={position} onScroll={e => e.stopPropagation()}>{children}</div>, document.body);
}

export function MenuItem({ icon: Icon, children, onClick, danger, disabled }) {
  return (
    <button role="menuitem" className={`menu-item ${danger ? 'danger' : ''}`} disabled={disabled} onClick={onClick}>
      {Icon ? <Icon size={14} /> : null}<span>{children}</span>
    </button>
  );
}

export const MenuSeparator = () => <div className="menu-sep" role="separator" />;
