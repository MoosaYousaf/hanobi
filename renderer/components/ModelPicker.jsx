import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Search, RefreshCw, Check, Terminal, KeyRound, HardDrive } from 'lucide-react';
import { useStore, call, guard, setUi, toast } from '../store.js';
import { routeLabel } from '../labels.js';

export const routeIcon = { subscription: Terminal, key: KeyRound, local: HardDrive };
const ORDER = ['subscription', 'key', 'local'];

// Closes a popover on Escape or a click outside it.
function useDismiss(open, close) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDown = e => { if (ref.current && !ref.current.contains(e.target)) close(); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, close]);
  return ref;
}

function ConnectionGroup({ connection, query, current, onPick }) {
  const preset = useStore(s => s.app.presets[connection.preset]);
  const [models, setModels] = useState(preset.models || null);
  const [loading, setLoading] = useState(false);
  useEffect(() => { if (!preset.models && connection.ready) call('models:list', connection.id).then(setModels, toast); }, [connection.id, connection.ready, preset.models]);
  const load = guard(async () => { setLoading(true); try { setModels(await call('models:refresh', connection.id)); } finally { setLoading(false); } });
  const q = query.trim().toLowerCase();
  const visible = (models || []).filter(m => !q || m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q) || connection.name.toLowerCase().includes(q));
  const custom = q && (preset.kind !== 'cli' || preset.customModels) && connection.ready && !visible.some(m => m.id.toLowerCase() === q);
  if (q && !visible.length && !custom) return null;
  return (
    <div className="pick-group">
      <div className="pick-group-head">
        <span>{connection.name}</span>
        {preset.kind !== 'cli' && connection.ready ? <button className="icon-btn sm" title="Reload models" onClick={load}><RefreshCw size={12} className={loading ? 'spinning' : ''} /></button> : null}
      </div>
      {!connection.ready ? <div className="pick-note">{connection.detail}</div> : null}
      {connection.ready && models && !models.length && !q ? <button className="pick-item muted" onClick={load}>Load available models</button> : null}
      {visible.map(m => {
        const selected = current.connectionId === connection.id && current.model === m.id;
        return (
          <button key={m.id || 'default'} className={`pick-item ${selected ? 'selected' : ''}`} disabled={!connection.ready} onClick={() => onPick(connection.id, m.id)}>
            <span className="pick-label">{m.label}</span>
            {m.label !== m.id && m.id ? <span className="pick-id">{m.id}</span> : null}
            {selected ? <Check size={14} className="pick-check" /> : null}
          </button>
        );
      })}
      {custom ? <button className="pick-item" onClick={() => onPick(connection.id, query.trim())}>Use model <code>{query.trim()}</code></button> : null}
    </div>
  );
}

export function ModelPicker({ thread, label, disabled }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const connections = useStore(s => s.app.connections);
  const close = useCallback(() => { setOpen(false); setQuery(''); }, []);
  const ref = useDismiss(open, close);
  const connection = connections.find(c => c.id === thread.connectionId);
  const Icon = routeIcon[connection?.route] || Terminal;
  const pick = guard(async (connectionId, model) => { close(); await call('thread:settings', thread.id, { connectionId, model }); });
  return (
    <div className="picker" ref={ref}>
      <button className="chip" disabled={disabled} onClick={() => setOpen(!open)} title={disabled ? 'Wait for the reply to finish' : 'Choose a model'}>
        <Icon size={13} /> <span className="chip-label">{label}</span> <ChevronDown size={13} />
      </button>
      {open ? (
        <div className="popover picker-pop">
          <label className="pick-search"><Search size={14} /><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Search models or type a model id" /></label>
          <div className="pick-scroll">
            {ORDER.map(route => {
              const list = connections.filter(c => c.route === route);
              if (!list.length) return null;
              return (
                <div key={route} className="pick-route">
                  <div className="pick-route-label">{routeLabel[route]}</div>
                  {list.map(c => <ConnectionGroup key={c.id} connection={c} query={query} current={thread} onPick={pick} />)}
                </div>
              );
            })}
          </div>
          <button className="pick-foot" onClick={() => { close(); setUi({ settings: 'models' }); }}>Add API keys or local models…</button>
        </div>
      ) : null}
    </div>
  );
}
