import { memo, useState, useRef } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronRight, Check, Copy, Wrench, CircleAlert, Ban, Clock, GitBranch, RotateCcw, Pencil, Download, Eye, Code, Play } from 'lucide-react';
import { Working } from './Spark.jsx';
import { FileCard, ToolFiles, ExportMenu, exportText, markdownHtml, snippetName, previewKind, SnippetPreview, LABELS } from './Files.jsx';
import { useStore, answerApproval, answerQuestion, guard, call, toast } from '../store.js';

const plugins = [remarkGfm];

// A fenced code block with its own bar: the language or file name, Preview for HTML, SVG, Markdown, and CSV,
// Download as a file, and Copy. The text comes from the Markdown tree, so it is exact.
const hastText = node => (node?.type === 'text' ? node.value : (node?.children || []).map(hastText).join(''));
function CodeBlock({ node, children, ...props }) {
  const code = node?.children?.find(c => c.tagName === 'code');
  const language = [].concat(code?.properties?.className || []).find(c => String(c).startsWith('language-'))?.slice(9) || '';
  const name = snippetName(language, code?.data?.meta || '');
  const text = hastText(code).replace(/\n$/, '');
  const kind = previewKind(name);
  const [copied, setCopied] = useState(false);
  const [preview, setPreview] = useState(false);
  const copy = () => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1400); };
  const named = !name.startsWith('snippet.');
  const extension = name.split('.').pop();
  const download = () => exportText({ name, text, html: kind === 'md' ? markdownHtml(text) : kind === 'html' ? text : '' });
  return (
    <div className="code-block">
      <div className="code-bar">
        <span className="code-lang">{named ? name : LABELS[extension] || language || 'Text'}</span>
        {kind === 'html' ? <button className="code-btn tip tip-end" onClick={() => call('snippet:run', text, name).catch(toast)} data-tip="Run with JavaScript in its own window"><Play size={13} /> Run</button> : null}
        {kind ? <button className={`code-btn ${preview ? 'on' : ''}`} onClick={() => setPreview(!preview)} aria-pressed={preview}>{preview ? <><Code size={13} /> Code</> : <><Eye size={13} /> Preview</>}</button> : null}
        <button className="code-btn tip tip-end" onClick={download} aria-label={`Download ${name}`} data-tip={`Download ${name}`}><Download size={13} /></button>
        <button className="code-btn tip tip-end" onClick={copy} aria-label="Copy code" data-tip={copied ? 'Copied' : 'Copy code'}>{copied ? <Check size={13} /> : <Copy size={13} />}</button>
      </div>
      {preview ? <SnippetPreview kind={kind} text={text} /> : <pre {...props}>{children}</pre>}
    </div>
  );
}
const markdownComponents = { pre: CodeBlock, a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> };

const Prose = memo(function Prose({ text }) {
  return <div className="prose"><Markdown remarkPlugins={plugins} components={markdownComponents}>{text}</Markdown></div>;
});

function Thinking({ text, live }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`thinking ${open ? 'open' : ''}`}>
      <button className="disclosure" onClick={() => setOpen(!open)}><ChevronRight size={13} />{live ? 'Thinking…' : 'Thought process'}</button>
      {open ? <div className="thinking-body">{text}</div> : null}
    </div>
  );
}

const show = value => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const statusIcon = { running: null, pending: <Clock size={13} />, done: <Check size={13} />, error: <CircleAlert size={13} />, denied: <Ban size={13} /> };
const statusLabel = { running: 'Running', pending: 'Waiting for approval', done: 'Done', error: 'Failed', denied: 'Declined' };

function ToolCall({ part, live }) {
  const [open, setOpen] = useState(false);
  const input = part.input && Object.keys(part.input).length !== 0 ? show(part.input) : '';
  const preview = typeof part.input === 'string' ? part.input : part.input?.command || part.input?.query || part.input?.path || part.input?.file_path || '';
  return <>
    <div className={`tool tool-${part.status}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <ChevronRight size={13} className="chev" />
        <Wrench size={13} />
        <span className="tool-name">{part.server ? `${part.server} · ` : ''}{part.name}</span>
        {preview ? <code className="tool-preview">{String(preview).slice(0, 120)}</code> : null}
        <span className="tool-status" title={statusLabel[part.status]}>{part.status === 'running' ? <span className="mini-spin" /> : statusIcon[part.status]}</span>
      </button>
      {open ? (
        <div className="tool-body">
          {input ? <><div className="tool-label">Input</div><pre>{input}</pre></> : null}
          {part.output !== undefined ? <><div className="tool-label">{part.status === 'error' ? 'Error' : 'Output'}</div><pre>{show(part.output)}</pre></> : null}
        </div>
      ) : null}
    </div>
    {!live ? <ToolFiles part={part} /> : null}
  </>;
}

function Approval({ request }) {
  const act = decision => guard(() => answerApproval(request.id, decision));
  return (
    <div className="approval" role="alertdialog" aria-label="Tool approval">
      <div className="approval-title">Allow <strong>{request.server}</strong> to run <code>{request.tool}</code>?</div>
      {request.description ? <div className="approval-detail">{request.description}</div> : null}
      {request.blockedPath ? <div className="approval-detail">Path: <code>{request.blockedPath}</code></div> : null}
      <pre className="approval-input">{show(request.input)}</pre>
      <div className="approval-actions">
        <button className="btn" onClick={act('deny')}>Deny</button>
        <button className="btn" onClick={act('always')}>Always allow {request.tool} in this chat</button>
        <button className="btn primary" onClick={act('allow')} autoFocus>Allow once</button>
      </div>
    </div>
  );
}

// Questions from the model. Each question takes one option (or several with multiSelect), or the user's own text.
function Question({ request }) {
  const [picked, setPicked] = useState({}); // question id -> labels
  const [other, setOther] = useState({}); // question id -> typed answer
  const toggle = (q, label) => setPicked(p => {
    const now = p[q.id] || [];
    return { ...p, [q.id]: q.multiSelect ? (now.includes(label) ? now.filter(l => l !== label) : [...now, label]) : [label] };
  });
  const answers = Object.fromEntries(request.questions.map(q => [q.id, [...(picked[q.id] || []), ...(other[q.id]?.trim() ? [other[q.id].trim()] : [])].slice(0, q.multiSelect ? 99 : 1)]));
  const ready = request.questions.every(q => answers[q.id].length);
  const send = value => guard(() => answerQuestion(request.id, value))();
  return (
    <div className="question" role="dialog" aria-label="Questions from the model">
      {request.questions.map(q => (
        <fieldset key={q.id} className="question-item">
          <legend>{q.header ? <span className="question-header">{q.header}</span> : null}{q.question}</legend>
          <div className="question-options">
            {q.options.map(o => (
              <button key={o.label} className={`question-option ${(picked[q.id] || []).includes(o.label) ? 'on' : ''}`} aria-pressed={(picked[q.id] || []).includes(o.label)} onClick={() => { toggle(q, o.label); if (!q.multiSelect) setOther(t => ({ ...t, [q.id]: '' })); }}>
                <strong>{o.label}</strong>{o.description ? <span>{o.description}</span> : null}
              </button>
            ))}
          </div>
          <input className="question-other" placeholder={q.multiSelect ? 'Add your own answer' : 'Or type your own answer'} value={other[q.id] || ''}
            onChange={e => { const value = e.target.value; setOther(t => ({ ...t, [q.id]: value })); if (!q.multiSelect && value) setPicked(p => ({ ...p, [q.id]: [] })); }} />
        </fieldset>
      ))}
      <div className="approval-actions">
        <button className="btn" onClick={() => send(null)}>Skip</button>
        <button className="btn primary" disabled={!ready} onClick={() => send(answers)}>Send answers</button>
      </div>
    </div>
  );
}

function Parts({ parts, live }) {
  return parts.map((part, i) => {
    if (part.type === 'text') return part.text ? <Prose key={i} text={part.text} /> : null;
    if (part.type === 'thinking') return <Thinking key={i} text={part.text} live={live && i === parts.length - 1} />;
    if (part.type === 'tool') return <ToolCall key={part.id || i} part={part} live={live} />;
    if (part.type === 'file') return <FileCard key={part.path} file={part} />;
    if (part.type === 'image') return <img key={i} className="msg-image" src={`data:${part.mediaType};base64,${part.data}`} alt={part.name || 'Attached image'} />;
    return null;
  });
}

// Rewind choices follow Claude Code: the conversation, the files, or both. Files need a checkpoint (Git workspaces).
function RewindMenu({ message, onRewind, close }) {
  const pick = options => { close(); onRewind(message, options); };
  return (
    <div className="rewind-menu" role="menu" onMouseLeave={close}>
      <button role="menuitem" onClick={() => pick({ conversation: true })}>Rewind conversation<span>Remove this message and the replies after it.</span></button>
      {message.checkpoint ? <>
        <button role="menuitem" onClick={() => pick({ conversation: true, code: true })}>Rewind conversation and code<span>Also return the workspace files to how they were before this message.</span></button>
        <button role="menuitem" onClick={() => pick({ conversation: false, code: true })}>Restore code only<span>Keep the conversation. Return the files.</span></button>
      </> : <div className="rewind-note">No file checkpoint. Code rewind needs a Git workspace.</div>}
    </div>
  );
}

const textOf = message => message.parts.filter(p => p.type === 'text').map(p => p.text).join('\n\n');

// An icon button whose name shows in a tooltip on hover.
function Action({ label, onClick, children, pressed }) {
  return <button className="msg-action tip" aria-label={label} data-tip={label} aria-pressed={pressed} onClick={onClick}>{children}</button>;
}

function DownloadAction({ message }) {
  const [anchor, setAnchor] = useState(null);
  return <>
    <Action label="Download" pressed={!!anchor} onClick={e => setAnchor(e.currentTarget.getBoundingClientRect())}><Download size={14} /></Action>
    {anchor ? <ExportMenu text={textOf(message)} anchor={anchor} onClose={() => setAnchor(null)} /> : null}
  </>;
}

function CopyAction({ message }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard.writeText(textOf(message)); setCopied(true); setTimeout(() => setCopied(false), 1400); };
  return <Action label={copied ? 'Copied' : 'Copy'} onClick={copy}>{copied ? <Check size={14} /> : <Copy size={14} />}</Action>;
}

// Editing a message replaces it and everything after it, then sends the new text.
function EditBox({ message, onSave, onCancel }) {
  const [text, setText] = useState(textOf(message));
  const save = () => { if (text.trim()) onSave(message, text.trim()); };
  return (
    <div className="edit-box">
      <textarea autoFocus value={text} rows={Math.min(12, text.split('\n').length + 1)} onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } if (e.key === 'Escape') onCancel(); }} />
      <div className="edit-actions">
        <span className="hint">The replies after this message are replaced.</span>
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn primary" disabled={!text.trim()} onClick={save}>Send</button>
      </div>
    </div>
  );
}

export const Message = memo(function Message({ message, modelLabel, onBranch, onRewind, onEdit, busy }) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  if (message.role === 'user') {
    if (editing) return <article className="msg user"><EditBox message={message} onCancel={() => setEditing(false)} onSave={(m, text) => { setEditing(false); onEdit(m, text); }} /></article>;
    return (
      <article className="msg user">
        <div className="user-bubble"><Parts parts={message.parts} /></div>
        <div className="msg-actions">
          <CopyAction message={message} />
          {!busy ? <Action label="Edit" onClick={() => setEditing(true)}><Pencil size={14} /></Action> : null}
          {!busy ? <Action label="Rewind" pressed={menu} onClick={() => setMenu(!menu)}><RotateCcw size={14} /></Action> : null}
          <Action label="Branch" onClick={() => onBranch(message)}><GitBranch size={14} /></Action>
          {menu ? <RewindMenu message={message} onRewind={onRewind} close={() => setMenu(false)} /> : null}
        </div>
      </article>
    );
  }
  return (
    <article className="msg assistant">
      <div className="msg-meta">{modelLabel}{message.stopped ? ' · stopped' : ''}</div>
      <Parts parts={message.parts} />
      {message.error ? <div className="msg-error"><CircleAlert size={14} /> {message.error}</div> : null}
      {!message.parts.length && !message.error ? <div className="muted">No response.</div> : null}
      {textOf(message) ? <div className="msg-actions start"><CopyAction message={message} /><DownloadAction message={message} /></div> : null}
    </article>
  );
});

// Only this component re-renders while tokens stream in.
export function LiveMessage({ threadId, modelLabel }) {
  const parts = useStore(s => s.live[threadId]);
  const approvals = useStore(s => s.approvals);
  if (!parts) return null;
  const mine = approvals.filter(a => a.threadId === threadId);
  return (
    <article className="msg assistant live">
      <div className="msg-meta">{modelLabel}</div>
      <Parts parts={parts} live />
      {mine.map(a => (a.questions ? <Question key={a.id} request={a} /> : <Approval key={a.id} request={a} />))}
      {!mine.length ? <Working label={parts.length ? 'Working' : 'Thinking'} /> : null}
    </article>
  );
}
