import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square, Plus, X } from 'lucide-react';
import { useStore, call, guard, toast, askConfirm } from '../store.js';
import { ModelPicker } from './ModelPicker.jsx';

const MAX_IMAGE = 5 * 1024 * 1024;
const readImage = file => new Promise((resolve, reject) => {
  if (!file.type.startsWith('image/')) return reject(new Error(`${file.name} is not an image.`));
  if (file.size > MAX_IMAGE) return reject(new Error(`${file.name} is larger than 5 MB.`));
  const reader = new FileReader();
  reader.onload = () => resolve({ name: file.name, mediaType: file.type, data: String(reader.result).split(',')[1] });
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});

const tokens = n => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n));
const cap = text => text.charAt(0).toUpperCase() + text.slice(1);

// How full the model's context was after the last reply. Providers report the tokens; the size comes from the provider or a table.
function UsageRing({ thread }) {
  const usage = thread.messages.findLast(m => m.role === 'assistant' && m.usage)?.usage;
  const share = usage?.window ? Math.min(1, usage.used / usage.window) : 0;
  const tip = !usage ? 'Context usage shows after the first reply.'
    : usage.window ? `Context: ${tokens(usage.used)} of ${tokens(usage.window)} tokens (${Math.round(share * 100)}%)`
    : `Context: ${tokens(usage.used)} tokens. This model does not report its context size.`;
  const r = 6.5, length = 2 * Math.PI * r;
  return (
    <span className={`usage-ring tip tip-end ${share >= 0.95 ? 'full' : share >= 0.8 ? 'high' : ''}`} data-tip={tip} aria-label={tip} role="img" tabIndex={0}>
      <svg width="18" height="18" viewBox="0 0 18 18">
        <circle cx="9" cy="9" r={r} className="usage-track" />
        {share ? <circle cx="9" cy="9" r={r} className="usage-fill" strokeDasharray={`${share * length} ${length}`} transform="rotate(-90 9 9)" /> : null}
      </svg>
    </span>
  );
}

// Text drafts survive switching between conversations.
const drafts = new Map();
// A mounted composer listens, so a draft set from outside (rewind, a suggestion) shows at once.
export const setDraft = (threadId, text) => { drafts.set(threadId, text); window.dispatchEvent(new CustomEvent('hanobi-draft', { detail: threadId })); };

export function Composer({ thread, workspace, modelLabel }) {
  const running = useStore(s => !!s.live[thread.id]);
  const app = useStore(s => s.app);
  const [text, setText] = useState(() => drafts.get(thread.id) ?? '');
  const [images, setImages] = useState([]);
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
  const attach = guard(async files => {
    if (isCli) throw new Error('Images work with API and local models. CLI agents read files from the workspace instead.');
    const added = await Promise.all([...files].map(readImage));
    setImages(list => [...list, ...added].slice(0, 8));
  });
  const send = guard(async () => {
    if (running || (!text.trim() && !images.length)) return;
    await call('run:send', thread.id, { text, images });
    update(''); setImages([]);
  });
  const setting = patch => guard(() => call('thread:settings', thread.id, patch))();
  const onAccess = async id => {
    if (id === 'full' && !await askConfirm({ title: isCli ? 'Turn on full access?' : 'Allow tools without asking?', message: isCli ? 'The agent can run any tool without approval in this conversation, including outside this folder.' : 'Connected tools run without asking in this conversation.', confirmLabel: 'Turn on', danger: true })) return;
    setting({ mode: id });
  };

  return (
    <div className="composer-wrap">
      <div className="composer" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); attach(e.dataTransfer.files); }}>
        {images.length ? (
          <div className="attachments">
            {images.map((img, i) => (
              <div key={i} className="thumb"><img src={`data:${img.mediaType};base64,${img.data}`} alt={img.name} /><button className="thumb-x" title="Remove" onClick={() => setImages(images.filter((_, j) => j !== i))}><X size={11} /></button></div>
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
          : <button className="send" title="Send (Enter)" disabled={!text.trim() && !images.length} onClick={send}><ArrowUp size={15} strokeWidth={2.4} /></button>}
      </div>
      <div className="composer-row">
        <label className="icon-btn" title={isCli ? 'Images need an API or local model' : 'Attach images'}>
          <Plus size={16} />
          <input type="file" accept="image/*" multiple hidden onChange={e => { attach(e.target.files); e.target.value = ''; }} />
        </label>
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
        <UsageRing thread={thread} />
      </div>
    </div>
  );
}
