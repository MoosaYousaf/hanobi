import { memo, useState } from 'react';
import { Plus, FolderPlus, Settings as SettingsIcon, PanelLeftClose, FolderOpen, X } from 'lucide-react';
import { useStore, setUi, openThread, newThread, call, guard } from '../store.js';
import { Spark } from './Spark.jsx';

const LIMIT = 8;
const ago = at => {
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
};

const ThreadRow = memo(function ThreadRow({ thread, active, running }) {
  return (
    <button className={`thread-row ${active ? 'active' : ''}`} onClick={guard(() => openThread(thread.id))} title={thread.title}>
      <span className="thread-title">{thread.title}</span>
      {running ? <span className="dot-live" aria-label="Running" /> : <span className="thread-time">{ago(thread.updatedAt)}</span>}
    </button>
  );
});

function Workspace({ workspace, threads }) {
  const [all, setAll] = useState(false);
  const activeId = useStore(s => s.ui.threadId);
  const running = useStore(s => s.app.running);
  const shown = all ? threads : threads.slice(0, LIMIT);
  const remove = guard(async () => { if (confirm(`Remove “${workspace.name}” and its ${threads.length} conversations from Hanobi? Files on disk stay.`)) await call('workspace:remove', workspace.id); });
  return (
    <section className="ws">
      <div className="ws-head">
        <span className="ws-name" title={workspace.path}>{workspace.name}</span>
        <span className="ws-actions">
          <button className="icon-btn sm" title="Show in Finder" onClick={guard(() => call('workspace:open', workspace.id))}><FolderOpen size={13} /></button>
          {workspace.name !== 'Chats' ? <button className="icon-btn sm" title="Remove workspace" onClick={remove}><X size={13} /></button> : null}
          <button className="icon-btn sm" title="New conversation here" onClick={guard(() => newThread(workspace.id))}><Plus size={14} /></button>
        </span>
      </div>
      {shown.map(t => <ThreadRow key={t.id} thread={t} active={t.id === activeId} running={running.includes(t.id)} />)}
      {threads.length > LIMIT ? <button className="ws-more" onClick={() => setAll(!all)}>{all ? 'Show less' : `Show ${threads.length - LIMIT} more`}</button> : null}
      {!threads.length ? <div className="ws-empty">No conversations yet</div> : null}
    </section>
  );
}

export function Sidebar() {
  const workspaces = useStore(s => s.app.workspaces);
  const threads = useStore(s => s.app.threads);
  const connections = useStore(s => s.app.connections);
  const ready = connections.filter(c => c.ready).length;
  const sorted = threads.toSorted((a, b) => b.updatedAt - a.updatedAt);
  return (
    <aside className="sidebar">
      <div className="sidebar-top drag">
        <button className="icon-btn no-drag" title="Hide sidebar (⌘\)" onClick={() => setUi({ sidebar: false })}><PanelLeftClose size={16} /></button>
      </div>
      <div className="brand"><Spark size={18} /><span>Hanobi</span></div>
      <button className="new-chat" onClick={guard(() => newThread())}><Plus size={15} /> New conversation <kbd>⌘N</kbd></button>
      <nav className="ws-list">
        {workspaces.map(w => <Workspace key={w.id} workspace={w} threads={sorted.filter(t => t.workspaceId === w.id)} />)}
      </nav>
      <div className="sidebar-foot">
        <button className="foot-btn" onClick={guard(async () => { const w = await call('workspace:choose'); if (w) setUi({ workspaceId: w.id }); })}><FolderPlus size={15} /> Add project folder</button>
        <button className="foot-btn" onClick={() => setUi({ settings: 'models' })}>
          <SettingsIcon size={15} /> Settings
          <span className="foot-meta">{ready} model {ready === 1 ? 'source' : 'sources'}</span>
        </button>
      </div>
    </aside>
  );
}
