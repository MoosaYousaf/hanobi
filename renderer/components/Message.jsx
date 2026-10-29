import { memo, useState, useRef } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronRight, Check, Copy, Wrench, CircleAlert, Ban, Clock, GitBranch } from 'lucide-react';
import { Working } from './Spark.jsx';
import { useStore, answerApproval, guard } from '../store.js';

const plugins = [remarkGfm];

function CodeBlock({ children, ...props }) {
  const ref = useRef(null);
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard.writeText(ref.current?.innerText || ''); setCopied(true); setTimeout(() => setCopied(false), 1400); };
  return (
    <div className="code-block">
      <button className="code-copy" onClick={copy} title="Copy code">{copied ? <Check size={13} /> : <Copy size={13} />}</button>
      <pre ref={ref} {...props}>{children}</pre>
    </div>
  );
}
const markdownComponents = { pre: CodeBlock, a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> };

export const Prose = memo(function Prose({ text }) {
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

function ToolCall({ part }) {
  const [open, setOpen] = useState(false);
  const input = part.input && Object.keys(part.input).length !== 0 ? show(part.input) : '';
  const preview = typeof part.input === 'string' ? part.input : part.input?.command || part.input?.query || part.input?.path || part.input?.file_path || '';
  return (
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
  );
}

function Approval({ request }) {
  const act = decision => guard(() => answerApproval(request.id, decision));
  return (
    <div className="approval" role="alertdialog" aria-label="Tool approval">
      <div className="approval-title">Allow <strong>{request.server}</strong> to run <code>{request.tool}</code>?</div>
      <pre className="approval-input">{show(request.input)}</pre>
      <div className="approval-actions">
        <button className="btn" onClick={act('deny')}>Deny</button>
        <button className="btn" onClick={act('always')}>Always allow in this chat</button>
        <button className="btn primary" onClick={act('allow')} autoFocus>Allow once</button>
      </div>
    </div>
  );
}

function Parts({ parts, live }) {
  return parts.map((part, i) => {
    if (part.type === 'text') return part.text ? <Prose key={i} text={part.text} /> : null;
    if (part.type === 'thinking') return <Thinking key={i} text={part.text} live={live && i === parts.length - 1} />;
    if (part.type === 'tool') return <ToolCall key={part.id || i} part={part} />;
    if (part.type === 'image') return <img key={i} className="msg-image" src={`data:${part.mediaType};base64,${part.data}`} alt={part.name || 'Attached image'} />;
    return null;
  });
}

export const Message = memo(function Message({ message, modelLabel, onBranch }) {
  if (message.role === 'user') {
    return (
      <article className="msg user">
        <div className="user-bubble"><Parts parts={message.parts} /></div>
        <button className="msg-action" title="Edit from here in a new branch" onClick={() => onBranch(message)}><GitBranch size={13} /> Branch</button>
      </article>
    );
  }
  return (
    <article className="msg assistant">
      <div className="msg-meta">{modelLabel}{message.stopped ? ' · stopped' : ''}</div>
      <Parts parts={message.parts} />
      {message.error ? <div className="msg-error"><CircleAlert size={14} /> {message.error}</div> : null}
      {!message.parts.length && !message.error ? <div className="muted">No response.</div> : null}
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
      {mine.map(a => <Approval key={a.id} request={a} />)}
      {!mine.length ? <Working label={parts.length ? 'Working' : 'Thinking'} /> : null}
    </article>
  );
}
