import { memo, useState } from 'react';
import { Menu, MenuItem, MenuSeparator } from './Menu.jsx';
import { Plus, Settings as SettingsIcon, PanelLeftClose, FolderOpen, X, MessageSquare, Code2, MoreHorizontal, Pencil, Columns2, Pin, PinOff, FolderInput, Trash2, ChevronLeft, Check } from 'lucide-react';
import { useStore, setUi, openThread, openInSplit, newThread, deleteThread, call, guard, askText, askConfirm } from '../store.js';

const LIMIT = 8;
const ago = at => {
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
};

// Rename, open in a split pane, pin, move to another chat list, project, or folder, and delete.
function ThreadMenu({ thread, anchor, onClose }) {
  const [moving, setMoving] = useState(false);
  const workspaces = useStore(s => s.app.workspaces);
  const code = workspaces.find(w => w.id === thread.workspaceId)?.kind === 'code';
  const targets = workspaces.filter(w => (w.kind === 'code') === code);
  const act = fn => guard(async () => { onClose(); await fn(); });
  return (
    <Menu anchor={anchor} onClose={onClose} label={`Options for ${thread.title}`}>
      {moving ? <>
        <MenuItem icon={ChevronLeft} onClick={() => setMoving(false)}>Back</MenuItem>
        <MenuSeparator />
        {targets.map(w => (
          <MenuItem key={w.id} icon={w.id === thread.workspaceId ? Check : null} disabled={w.id === thread.workspaceId}
            onClick={act(() => call('thread:move', thread.id, w.id))}>{w.name}</MenuItem>
        ))}
      </> : <>
        <MenuItem icon={Pencil} onClick={act(async () => { const title = await askText('Conversation name', thread.title); if (title !== null) await call('thread:rename', thread.id, title); })}>Rename</MenuItem>
        <MenuItem icon={Columns2} onClick={act(() => openInSplit(thread.id))}>Open in split pane</MenuItem>
        <MenuItem icon={thread.pinned ? PinOff : Pin} onClick={act(() => call('thread:pin', thread.id, !thread.pinned))}>{thread.pinned ? 'Unpin' : 'Pin to top'}</MenuItem>
        <MenuItem icon={FolderInput} disabled={targets.length < 2} onClick={() => setMoving(true)}>{code ? 'Move to workspace' : 'Move to project'}</MenuItem>
        <MenuSeparator />
        <MenuItem icon={Trash2} danger onClick={act(() => deleteThread(thread))}>Delete</MenuItem>
      </>}
    </Menu>
  );
}

const ThreadRow = memo(function ThreadRow({ thread, active, running }) {
  const [anchor, setAnchor] = useState(null);
  const open = guard(() => openThread(thread.id));
  return (
    <div className={`thread-row ${active ? 'active' : ''} ${anchor ? 'menu-open' : ''}`} role="button" tabIndex={0} title={thread.title}
      onClick={open} onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) open(); }}>
      {thread.pinned ? <Pin size={11} className="thread-pin" /> : null}
      <span className="thread-title">{thread.title}</span>
      {running ? <span className="dot-live" aria-label="Running" /> : <span className="thread-time">{ago(thread.updatedAt)}</span>}
      <button className="thread-more" aria-label={`Options for ${thread.title}`} onClick={e => {
        e.stopPropagation();
        // A hidden button (opened from the keyboard or a script) has no size, so the row gives the position.
        const rect = e.currentTarget.getBoundingClientRect();
        setAnchor(anchor ? null : rect.width ? rect : e.currentTarget.closest('.thread-row').getBoundingClientRect());
      }}><MoreHorizontal size={15} /></button>
      {anchor ? <span onClick={e => e.stopPropagation()}><ThreadMenu thread={thread} anchor={anchor} onClose={() => setAnchor(null)} /></span> : null}
    </div>
  );
});

function Workspace({ workspace, threads }) {
  const project = workspace.kind === 'project';
  const [all, setAll] = useState(false);
  const activeId = useStore(s => s.ui.threadId);
  const panes = useStore(s => s.ui.panes);
  const running = useStore(s => s.app.running);
  const shown = all ? threads : threads.slice(0, LIMIT);
  const remove = guard(async () => { if (await askConfirm({ title: `Remove “${workspace.name}”?`, message: `Its ${threads.length} conversations are removed from Hanobi. The files on disk stay.`, confirmLabel: 'Remove', danger: true })) await call('workspace:remove', workspace.id); });
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
      {shown.map(t => <ThreadRow key={t.id} thread={t} active={t.id === activeId || panes.includes(t.id)} running={running.includes(t.id)} />)}
      {threads.length > LIMIT ? <button className="ws-more" onClick={() => setAll(!all)}>{all ? 'Show less' : `Show ${threads.length - LIMIT} more`}</button> : null}
      {!threads.length ? <div className="ws-empty">No conversations yet</div> : null}
    </section>
  );
}

function Pinned({ threads }) {
  const activeId = useStore(s => s.ui.threadId);
  const panes = useStore(s => s.ui.panes);
  const running = useStore(s => s.app.running);
  return (
    <section className="ws">
      <div className="ws-head"><span className="ws-name">Pinned</span></div>
      {threads.map(t => <ThreadRow key={t.id} thread={t} active={t.id === activeId || panes.includes(t.id)} running={running.includes(t.id)} />)}
    </section>
  );
}

// Chat holds the general Chats list and projects; Code holds the folders the user added.
const inView = (workspace, view) => (view === 'chat') === (workspace.kind !== 'code');

export function Sidebar() {
  const workspaces = useStore(s => s.app.workspaces);
  const threads = useStore(s => s.app.threads);
  const view = useStore(s => s.ui.view);
  const sorted = threads.toSorted((a, b) => b.updatedAt - a.updatedAt);
  const shown = workspaces.filter(w => inView(w, view)).toSorted((a, b) => (a.kind === 'chats') - (b.kind === 'chats'));
  const chats = workspaces.find(w => w.kind === 'chats');
  const pinned = sorted.filter(t => t.pinned && shown.some(w => w.id === t.workspaceId));
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
        {pinned.length ? <Pinned threads={pinned} /> : null}
        {shown.map(w => <Workspace key={w.id} workspace={w} threads={sorted.filter(t => t.workspaceId === w.id && !t.pinned)} />)}
        {view === 'code' && !shown.length ? <div className="ws-empty">Add a folder with New Workspace.</div> : null}
      </nav>
      <div className="sidebar-foot">
        <button className="foot-btn" onClick={() => setUi({ settings: 'models' })}>
          <SettingsIcon size={15} /> Settings
        </button>
      </div>
    </aside>
  );
}
