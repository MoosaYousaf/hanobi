import { useState } from 'react';
import { useStore, closeTextDialog } from '../store.js';

export function TextDialog() {
  const dialog = useStore(s => s.textDialog);
  if (!dialog) return null;
  return <TextDialogBody key={dialog.title} dialog={dialog} />;
}

function TextDialogBody({ dialog }) {
  const [value, setValue] = useState(dialog.value);
  const submit = e => { e.preventDefault(); closeTextDialog(value); };
  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) closeTextDialog(null); }} onKeyDown={e => { if (e.key === 'Escape') closeTextDialog(null); }}>
      <form className="text-dialog" role="dialog" aria-label={dialog.title} onSubmit={submit}>
        <label>{dialog.title}<input autoFocus value={value} onChange={e => setValue(e.target.value)} onFocus={e => e.target.select()} /></label>
        <div className="approval-actions">
          <button type="button" className="btn" onClick={() => closeTextDialog(null)}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!value.trim()}>OK</button>
        </div>
      </form>
    </div>
  );
}
