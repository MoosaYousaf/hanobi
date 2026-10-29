import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PanelLeftOpen, GitCompare, Sparkles, Trash2, Pencil, FolderOpen } from 'lucide-react';
import { useStore, setUi, loadThread, openThread, newThread, call, guard, toast, askText } from '../store.js';
import { modelLabel } from '../labels.js';
import { Message, LiveMessage } from './Message.jsx';
import { Composer, setDraft } from './Composer.jsx';
import { Spark } from './Spark.jsx';

const PAGE = 80;

function Header({ thread, workspace }) {
  const sidebar = useStore(s => s.ui.sidebar);
  const panel = useStore(s => s.ui.panel);
  const running = useStore(s => !!s.live[thread.id]);
  const rename = guard(async () => { const title = await askText('Conversation name', thread.title); if (title !== null) await call('thread:rename', thread.id, title); });
  const remove = guard(async () => { if (confirm(`Delete “${thread.title}”?`)) { await call('thread:delete', thread.id); setUi({ threadId: null }); } });
  const toggle = name => setUi({ panel: panel === name ? null : name });
  return (
    <header className="topbar drag">
      {!sidebar ? <button className="icon-btn no-drag" title="Show sidebar (⌘\)" onClick={() => setUi({ sidebar: true })}><PanelLeftOpen size={16} /></button> : null}
      <div className="crumbs no-drag">
        <span className="crumb-ws">{workspace.name}</span>
        <span className="crumb-sep">/</span>
        <button className="crumb-title" onClick={rename} title="Rename">{thread.title}</button>
      </div>
      <div className="top-actions no-drag">
        <button className="icon-btn" title="Rename" onClick={rename}><Pencil size={15} /></button>
        <button className="icon-btn" title="Delete conversation" disabled={running} onClick={remove}><Trash2 size={15} /></button>
        <button className="icon-btn" title="Show folder in Finder" onClick={guard(() => call('workspace:open', workspace.id))}><FolderOpen size={15} /></button>
        <span className="divider" />
        <button className={`icon-btn ${panel === 'skills' ? 'on' : ''}`} title="Skills" onClick={() => toggle('skills')}><Sparkles size={15} /></button>
        <button className={`icon-btn ${panel === 'git' ? 'on' : ''}`} title="Changes" onClick={() => toggle('git')}><GitCompare size={15} /></button>
      </div>
    </header>
  );
}

// Replies the user could send next, under the latest reply. A click puts the text in the composer to edit or send.
function Suggestions({ thread }) {
  const last = thread.messages.at(-1);
  if (last?.role !== 'assistant' || !last.suggestions?.length) return null;
  return (
    <div className="suggestions" aria-label="Suggested replies">
      {last.suggestions.map(text => <button key={text} className="suggestion" onClick={() => setDraft(thread.id, text)}>{text}</button>)}
    </div>
  );
}

export function ThreadView({ threadId }) {
  const app = useStore(s => s.app);
  const thread = useStore(s => s.threads[threadId]);
  const running = useStore(s => !!s.live[threadId]);
  const [count, setCount] = useState(PAGE);
  const scroller = useRef(null);
  const pinned = useRef(true);
  useEffect(() => { if (!thread) loadThread(threadId); }, [threadId, thread]);
  // Follow new output only while the user is at the bottom.
  useLayoutEffect(() => { const el = scroller.current; if (el && pinned.current) el.scrollTop = el.scrollHeight; });
  if (!thread) return <div className="thread-loading" />;
  const workspace = app.workspaces.find(w => w.id === thread.workspaceId) || { name: 'Workspace', path: '' };
  const currentLabel = modelLabel(app, thread.connectionId, thread.model);
  const branch = guard(async message => {
    const id = await call('thread:fork', thread.id, message.id);
    setDraft(id, message.parts.filter(p => p.type === 'text').map(p => p.text).join('\n\n'));
    await openThread(id);
  });
  const rewind = guard(async (message, options) => {
    if (options.code && !confirm('Return the workspace files to how they were before this message? Changes made after it, including your own, are lost. Ignored files stay.')) return;
    const { text, files } = await call('thread:rewind', thread.id, message.id, options);
    if (options.conversation) setDraft(thread.id, text);
    if (files) toast(`Restored ${files.restored.length} and removed ${files.removed.length} files.`);
  });
  const messages = thread.messages.slice(-count);
  return (
    <div className="thread">
      <Header thread={thread} workspace={workspace} />
      <div className="scroller" ref={scroller} onScroll={e => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        <div className="column">
          {thread.messages.length > count ? <button className="load-more" onClick={() => setCount(count + PAGE)}>Show earlier messages</button> : null}
          {!thread.messages.length && !running ? (
            <div className="empty">
              <Spark size={34} className="empty-spark" />
              <h1>What are we working on?</h1>
              <p>{currentLabel} in <strong>{workspace.name}</strong>. Switch models below at any time, even mid-conversation.</p>
            </div>
          ) : null}
          {messages.map(m => <Message key={m.id} message={m} modelLabel={m.role === 'assistant' ? modelLabel(app, m.connectionId || thread.connectionId, m.model ?? thread.model) : ''} onBranch={branch} onRewind={rewind} />)}
          {running ? <LiveMessage threadId={threadId} modelLabel={currentLabel} /> : <Suggestions thread={thread} />}
        </div>
      </div>
      <Composer key={thread.id} thread={thread} workspace={workspace} modelLabel={currentLabel} />
    </div>
  );
}

export function Home() {
  const sidebar = useStore(s => s.ui.sidebar);
  const ready = useStore(s => s.app.connections.some(c => c.ready));
  return (
    <div className="thread">
      <header className="topbar drag">{!sidebar ? <button className="icon-btn no-drag" onClick={() => setUi({ sidebar: true })}><PanelLeftOpen size={16} /></button> : null}</header>
      <div className="home">
        <Spark size={44} className="empty-spark" />
        <h1>Hanobi</h1>
        <p>One window for every model you use: your Claude and ChatGPT subscriptions through their CLIs, API keys, and local models, with MCP connectors.</p>
        {ready
          ? <button className="btn primary lg" onClick={guard(() => newThread())}>New conversation</button>
          : <button className="btn primary lg" onClick={() => setUi({ settings: 'models' })}>Connect a model</button>}
      </div>
    </div>
  );
}
