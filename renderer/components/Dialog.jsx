import { useState } from 'react';
import { useStore, closeDialog } from '../store.js';

export function Dialog() {
  const dialog = useStore(s => s.dialog);
  if (!dialog) return null;
  const cancel = dialog.kind === 'text' ? null : false;
  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) closeDialog(cancel); }} onKeyDown={e => { if (e.key === 'Escape') closeDialog(cancel); }}>
      {dialog.kind === 'text' ? <TextBody key={dialog.title} dialog={dialog} /> : <ConfirmBody dialog={dialog} />}
    </div>
  );
}

function TextBody({ dialog }) {
  const [value, setValue] = useState(dialog.value);
  return (
    <form className="dialog" role="dialog" aria-label={dialog.title} onSubmit={e => { e.preventDefault(); closeDialog(value); }}>
      <label className="dialog-title">{dialog.title}<input autoFocus value={value} onChange={e => setValue(e.target.value)} onFocus={e => e.target.select()} /></label>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={() => closeDialog(null)}>Cancel</button>
        <button type="submit" className="btn primary" disabled={!value.trim()}>OK</button>
      </div>
    </form>
  );
}

function ConfirmBody({ dialog }) {
  return (
    <div className="dialog" role="alertdialog" aria-label={dialog.title}>
      <div className="dialog-title">{dialog.title}</div>
      {dialog.message ? <p className="dialog-message">{dialog.message}</p> : null}
      <div className="dialog-actions">
        <button className="btn" onClick={() => closeDialog(false)}>Cancel</button>
        <button className={`btn ${dialog.danger ? 'danger' : 'primary'}`} autoFocus onClick={() => closeDialog(true)}>{dialog.confirmLabel}</button>
      </div>
    </div>
  );
}
