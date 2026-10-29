import { memo, useState } from 'react';
import { Plus, Settings as SettingsIcon, PanelLeftClose, FolderOpen, X, MessageSquare, Code2 } from 'lucide-react';
import { useStore, setUi, openThread, newThread, call, guard, askText } from '../store.js';
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
  const project = workspace.kind === 'project';
  const [all, setAll] = useState(false);
  const activeId = useStore(s => s.ui.threadId);
  const running = useStore(s => s.app.running);
  const shown = all ? threads : threads.slice(0, LIMIT);
  const remove = guard(async () => { if (confirm(`Remove “${workspace.name}” and its ${threads.length} conversations from Hanobi? Files on disk stay.`)) await call('workspace:remove', workspace.id); });
  return (
    <section className="ws">
      <div className="ws-head">
        {project
          ? <button className="ws-name link" title="Open project" onClick={() => setUi({ projectId: workspace.id, threadId: null, workspaceId: workspace.id })}>{workspace.name}</button>
          : <span className="ws-name" title={workspace.path}>{workspace.name}</span>}
        <span className="ws-actions">
          {workspace.kind === 'code' ? <button className="icon-btn sm" title="Show in Finder" onClick={guard(() => call('workspace:open', workspace.id))}><FolderOpen size={13} /></button> : null}
          {workspace.kind === 'code' ? <button className="icon-btn sm" title="Remove workspace" onClick={remove}><X size={13} /></button> : null}
          <button className="icon-btn sm" title={workspace.kind === 'code' ? 'New conversation here' : 'New chat here'} onClick={guard(() => newThread(workspace.id))}><Plus size={14} /></button>
        </span>
      </div>
      {shown.map(t => <ThreadRow key={t.id} thread={t} active={t.id === activeId} running={running.includes(t.id)} />)}
      {threads.length > LIMIT ? <button className="ws-more" onClick={() => setAll(!all)}>{all ? 'Show less' : `Show ${threads.length - LIMIT} more`}</button> : null}
      {!threads.length ? <div className="ws-empty">No conversations yet</div> : null}
    </section>
  );
}

// Chat holds the general Chats list and projects; Code holds the folders the user added.
const inView = (workspace, view) => (view === 'chat') === (workspace.kind !== 'code');

export function Sidebar() {
  const workspaces = useStore(s => s.app.workspaces);
  const threads = useStore(s => s.app.threads);
  const connections = useStore(s => s.app.connections);
  const view = useStore(s => s.ui.view);
  const ready = connections.filter(c => c.ready).length;
  const sorted = threads.toSorted((a, b) => b.updatedAt - a.updatedAt);
  const shown = workspaces.filter(w => inView(w, view)).toSorted((a, b) => (a.kind === 'chats') - (b.kind === 'chats'));
  const chats = workspaces.find(w => w.kind === 'chats');
  const switchView = next => {
    if (next === view) return;
    const first = workspaces.find(w => inView(w, next));
    setUi({ view: next, threadId: null, projectId: null, workspaceId: next === 'chat' ? chats?.id : first?.id || null });
  };
  const newProject = guard(async () => { const name = await askText('Project name'); if (name === null) return; const p = await call('project:create', name); setUi({ projectId: p.id, threadId: null, workspaceId: p.id }); });
  const newWorkspace = guard(async () => { const w = await call('workspace:choose'); if (w) setUi({ workspaceId: w.id }); });
  return (
    <aside className="sidebar">
      <div className="sidebar-top drag">
        <button className="icon-btn no-drag" title="Hide sidebar (⌘\)" onClick={() => setUi({ sidebar: false })}><PanelLeftClose size={16} /></button>
      </div>
      <div className="brand"><Spark size={18} /><span>Hanobi</span></div>
      <div className="segmented view-switch" role="tablist">
        <button role="tab" aria-selected={view === 'chat'} className={view === 'chat' ? 'on' : ''} onClick={() => switchView('chat')}><MessageSquare size={14} /> Chat</button>
        <button role="tab" aria-selected={view === 'code'} className={view === 'code' ? 'on' : ''} onClick={() => switchView('code')}><Code2 size={14} /> Code</button>
      </div>
      {view === 'chat' ? <>
        <button className="new-chat" onClick={guard(() => newThread(chats?.id))}><Plus size={15} /> New chat <kbd>⌘N</kbd></button>
        <button className="side-action" onClick={newProject}><Plus size={15} /> New Project</button>
      </> : <>
        <button className="new-chat" onClick={guard(() => newThread())}><Plus size={15} /> New conversation <kbd>⌘N</kbd></button>
        <button className="side-action" onClick={newWorkspace}><Plus size={15} /> New Workspace</button>
      </>}
      <nav className="ws-list">
        {shown.map(w => <Workspace key={w.id} workspace={w} threads={sorted.filter(t => t.workspaceId === w.id)} />)}
        {view === 'code' && !shown.length ? <div className="ws-empty">Add a folder with New Workspace.</div> : null}
      </nav>
      <div className="sidebar-foot">
        <button className="foot-btn" onClick={() => setUi({ settings: 'models' })}>
          <SettingsIcon size={15} /> Settings
          <span className="foot-meta">{ready} model {ready === 1 ? 'source' : 'sources'}</span>
        </button>
      </div>
    </aside>
  );
}
