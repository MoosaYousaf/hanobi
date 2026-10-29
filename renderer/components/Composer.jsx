import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square, Plus, X, Mic } from 'lucide-react';
import { useStore, getState, call, guard, toast, askConfirm } from '../store.js';
import { startVoice, stopVoice, cancelVoice } from '../voice/voice.js';
import { ModelPicker } from './ModelPicker.jsx';
import { formatSize } from './Files.jsx';
import { useLimits, refreshLimits, level, leftText, resetText, WARN } from '../limits.js';

const MAX_IMAGE = 5 * 1024 * 1024; // the API limit for one image
const MAX_FILES = 10;
const readData = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve({ name: file.name || 'Pasted file', data: String(reader.result).split(',')[1] || '' });
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});

const tokens = n => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n));
const cap = text => text.charAt(0).toUpperCase() + text.slice(1);

// The plan's usage windows for CLI subscriptions: the ring shows the session window (the shortest one) and turns
// amber at 80% and red at 95% of any window. The hover card shows every window, what is left, the resets, and the context size.
// API and local models have no plan limits, so their ring shows how full the context was after the last reply.
const ago = ms => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
function UsageRing({ thread, preset }) {
  const cli = preset?.cli || null;
  const limits = useLimits(thread.connectionId, cli);
  const usage = thread.messages.findLast(m => m.role === 'assistant' && m.usage)?.usage;
  const contextShare = usage?.window ? Math.min(1, usage.used / usage.window) : 0;
  const context = !usage ? 'Context: shows after the first reply.'
    : usage.window ? `Context: ${tokens(usage.used)} of ${tokens(usage.window)} tokens (${Math.round(contextShare * 100)}%)`
    : `Context: ${tokens(usage.used)} tokens. This model does not report its context size.`;
  const windows = limits?.windows || [];
  const session = windows[0];
  const share = session ? session.used / 100 : contextShare;
  const tone = level(windows.length ? Math.max(...windows.map(w => w.used)) : contextShare * 100);
  const nearest = windows.filter(w => w.used >= WARN).sort((a, b) => b.used - a.used)[0];
  const label = session ? `${session.label}: ${session.used}% used, ${leftText(session)}` : context;
  const r = 6.5, length = 2 * Math.PI * r;
  return (
    <>
      {nearest ? <span className={`limit-warn ${level(nearest.used)}`}>{nearest.label.replace(/ \(.*\)$/, '')}: {leftText(nearest)}</span> : null}
      <span className={`usage-ring ${tone}`} aria-label={label} role="img" tabIndex={0} onMouseEnter={() => cli && refreshLimits(thread.connectionId, cli)}>
        <svg width="18" height="18" viewBox="0 0 18 18">
          <circle cx="9" cy="9" r={r} className="usage-track" />
          {share ? <circle cx="9" cy="9" r={r} className="usage-fill" strokeDasharray={`${share * length} ${length}`} transform="rotate(-90 9 9)" /> : null}
        </svg>
        <span className="usage-card" role="tooltip">
          {limits?.plan ? <span className="usage-plan">{limits.plan}</span> : cli && !limits ? <span className="usage-misc">Reading plan usage…</span> : null}
          {windows.map(w => (
            <span key={w.id} className="usage-row">
              <span className="usage-head"><span>{w.label}</span><span>{w.used}% used</span></span>
              <span className={`usage-bar ${level(w.used)}`}><i style={{ width: `${w.used}%` }} /></span>
              <span className="usage-foot">{leftText(w)}{w.resetsAt ? ` · ${resetText(w.resetsAt)}` : ''}</span>
            </span>
          ))}
          {limits?.error ? <span className="usage-error">{limits.error}</span> : null}
          <span className="usage-misc">{context}</span>
          {limits?.note ? <span className="usage-misc">{limits.note}</span> : null}
          {limits?.at ? <span className="usage-misc">Updated {ago(limits.at)}</span> : null}
        </span>
      </span>
    </>
  );
}

// Voice input with one button: a click starts and the next click stops; a press longer than HOLD_MS is
// hold-to-talk and stops on release. ⌘⇧D works the same way in the active pane. Escape cancels.
const HOLD_MS = 350;
function useVoiceControl(threadId) {
  const pressedAt = useRef(0);
  const down = () => {
    const voice = getState().voice;
    if (voice.state === 'listening' && voice.threadId === threadId) { pressedAt.current = 0; stopVoice(); return; }
    if (voice.state !== 'idle') return;
    pressedAt.current = Date.now();
    startVoice(threadId);
  };
  const up = () => { if (pressedAt.current && Date.now() - pressedAt.current > HOLD_MS) stopVoice(); pressedAt.current = 0; };
  useEffect(() => {
    const active = () => getState().ui.threadId === threadId;
    const onDown = e => {
      if (e.key === 'Escape' && getState().voice.threadId === threadId && getState().voice.state === 'listening') { e.preventDefault(); cancelVoice(); }
      if (e.code === 'KeyD' && e.metaKey && e.shiftKey && !e.repeat && active()) { e.preventDefault(); down(); }
    };
    const onUp = e => { if ((e.code === 'KeyD' || e.key === 'Meta') && pressedAt.current && active()) up(); };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => { window.removeEventListener('keydown', onDown); window.removeEventListener('keyup', onUp); };
  }, [threadId]);
  return { down, up };
}

function MicButton({ threadId }) {
  const voice = useStore(s => s.voice);
  const { down, up } = useVoiceControl(threadId);
  const mine = voice.threadId === threadId;
  const listening = mine && voice.state === 'listening';
  const busy = mine && (voice.state === 'transcribing' || voice.state === 'starting');
  const label = listening ? 'Stop (click, or release when holding)' : busy ? 'Finishing…' : 'Voice input: click to start, or hold to talk (⌘⇧D)';
  return (
    <button className={`icon-btn mic tip ${listening ? 'live' : ''} ${busy ? 'busy' : ''}`} data-tip={label} aria-label={label} aria-pressed={listening}
      disabled={voice.state !== 'idle' && !mine}
      style={listening ? { '--level': voice.level || 0 } : undefined}
      onPointerDown={e => { if (e.button === 0) { e.preventDefault(); down(); } }} onPointerUp={up} onPointerLeave={() => listening && up()}
      onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); down(); } }} onKeyUp={e => { if (e.key === 'Enter' || e.key === ' ') up(); }}>
      {busy ? <span className="mini-spin" /> : <Mic size={16} />}
    </button>
  );
}

function VoiceStatus({ threadId }) {
  const voice = useStore(s => s.voice);
  if (voice.threadId !== threadId || voice.state === 'idle') return null;
  const text = voice.state === 'listening' ? 'Listening… the words show as you speak. Click the mic or release to finish. Esc cancels.'
    : voice.state === 'starting' ? 'Starting the microphone…' : 'Finishing the text…';
  return <div className="voice-status" role="status">{text}</div>;
}

// Text drafts survive switching between conversations.
const drafts = new Map();
// A mounted composer listens, so a draft set from outside (rewind, a suggestion) shows at once.
export const getDraft = threadId => drafts.get(threadId) ?? '';
export const setDraft = (threadId, text) => { drafts.set(threadId, text); window.dispatchEvent(new CustomEvent('hanobi-draft', { detail: threadId })); };

export function Composer({ thread, workspace, modelLabel }) {
  const running = useStore(s => !!s.live[thread.id]);
  const app = useStore(s => s.app);
  const [text, setText] = useState(() => drafts.get(thread.id) ?? '');
  const [files, setFiles] = useState([]); // file parts already copied into the thread's folder
  const input = useRef(null);
  const connection = app.connections.find(c => c.id === thread.connectionId);
  const preset = connection && app.presets[connection.preset];
  const isCli = preset?.kind === 'cli';
  const modes = app.modes[isCli ? 'cli' : 'api'].filter(m => !m.asks || preset?.asks);
  const mode = modes.find(m => m.id === thread.mode) || modes[0];
  // CLI agents in Chat and projects only read, so their access mode does not apply.
  const chatCli = isCli && workspace.kind && workspace.kind !== 'code';

  const update = value => { setText(value); drafts.set(thread.id, value); };
  useEffect(() => {
    const onDraft = e => { if (e.detail === thread.id) { setText(drafts.get(thread.id) ?? ''); input.current?.focus(); } };
    window.addEventListener('hanobi-draft', onDraft);
    return () => window.removeEventListener('hanobi-draft', onDraft);
  }, [thread.id]);
  // Any file type. Main copies it into the thread's folder; a pasted file without a path is sent as bytes.
  const add = parts => setFiles(list => [...list, ...parts].slice(0, MAX_FILES));
  const attach = guard(async list => {
    for (const file of [...list]) {
      if (!isCli && file.type?.startsWith('image/') && file.size > MAX_IMAGE) throw new Error(`${file.name} is larger than 5 MB, the image limit for API models.`);
      const source = window.hanobi.pathFor?.(file);
      add(source ? await call('files:attach', thread.id, [source]) : [await call('files:attach-data', thread.id, await readData(file))]);
    }
  });
  const pick = guard(async () => add(await call('files:pick', thread.id)));
  const send = guard(async () => {
    if (running || (!text.trim() && !files.length)) return;
    await call('run:send', thread.id, { text, files: files.map(({ path, name }) => ({ path, name })) });
    update(''); setFiles([]);
  });
  const setting = patch => guard(() => call('thread:settings', thread.id, patch))();
  const onAccess = async id => {
    if (id === 'full' && !await askConfirm({ title: isCli ? 'Turn on full access?' : 'Allow tools without asking?', message: isCli ? 'The agent can run any tool without approval in this conversation, including outside this folder.' : 'Connected tools run without asking in this conversation.', confirmLabel: 'Turn on', danger: true })) return;
    setting({ mode: id });
  };

  return (
    <div className="composer-wrap">
      <div className="composer" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); attach(e.dataTransfer.files); }}>
        {files.length ? (
          <div className="attachments">
            {files.map((f, i) => (
              <div key={f.path} className="attach-chip" title={f.name}>
                <span className="attach-name">{f.name}</span><span className="attach-size">{formatSize(f.size)}</span>
                <button className="thumb-x" title="Remove" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}><X size={11} /></button>
              </div>
            ))}
          </div>
        ) : null}
        <textarea
          ref={input} autoFocus rows={1} value={text} placeholder={`Message ${modelLabel.split(' · ')[0]}…`}
          onChange={e => { update(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 260) + 'px'; }}
          onPaste={e => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); attach(files); } }}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
        />
        {running
          ? <button className="send stop" title="Stop" onClick={guard(() => call('run:stop', thread.id))}><Square size={11} fill="currentColor" /></button>
          : <button className="send" title="Send (Enter)" disabled={!text.trim() && !files.length} onClick={send}><ArrowUp size={15} strokeWidth={2.4} /></button>}
      </div>
      <VoiceStatus threadId={thread.id} />
      <div className="composer-row">
        <button className="icon-btn tip" data-tip="Attach files" aria-label="Attach files" onClick={pick}><Plus size={16} /></button>
        <MicButton threadId={thread.id} />
        {!chatCli ? (
          <select className={`mini-select ${mode.danger ? 'danger' : ''}`} value={mode.id} disabled={running} onChange={e => onAccess(e.target.value)} title={mode.detail}>
            {modes.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        ) : null}
        <span className="grow" />
        <ModelPicker thread={thread} label={modelLabel} disabled={running} />
        {preset?.efforts?.length > 1 ? (
          <select className="mini-select" value={thread.effort} disabled={running} onChange={e => setting({ effort: e.target.value })} title="Effort">
            {preset.efforts.map(e => <option key={e} value={e}>{e ? cap(e) : 'Default effort'}</option>)}
          </select>
        ) : null}
        <UsageRing thread={thread} preset={preset} />
      </div>
    </div>
  );
}
