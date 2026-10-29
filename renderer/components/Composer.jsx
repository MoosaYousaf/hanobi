import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square, Paperclip, X, Folder } from 'lucide-react';
import { useStore, call, guard, toast } from '../store.js';
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
  const onAccess = id => {
    if (id === 'full' && !confirm(isCli ? 'Full access lets the agent run any tool without approval, including outside this folder. Turn it on for this conversation?' : 'Connected tools will run without asking. Turn this on for this conversation?')) return;
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
        <div className="composer-row">
          <label className="icon-btn" title={isCli ? 'Images need an API or local model' : 'Attach images'}>
            <Paperclip size={15} />
            <input type="file" accept="image/*" multiple hidden onChange={e => { attach(e.target.files); e.target.value = ''; }} />
          </label>
          <ModelPicker thread={thread} label={modelLabel} disabled={running} />
          {preset?.efforts?.length > 1 ? (
            <select className="mini-select" value={thread.effort} disabled={running} onChange={e => setting({ effort: e.target.value })} title="Effort">
              {preset.efforts.map(e => <option key={e} value={e}>{e ? `Effort: ${e}` : 'Effort: default'}</option>)}
            </select>
          ) : null}
          <select className={`mini-select ${mode.danger ? 'danger' : ''}`} value={mode.id} disabled={running} onChange={e => onAccess(e.target.value)} title={mode.detail}>
            {modes.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <span className="grow" />
          {running
            ? <button className="send stop" title="Stop" onClick={guard(() => call('run:stop', thread.id))}><Square size={12} fill="currentColor" /></button>
            : <button className="send" title="Send (Enter)" disabled={!text.trim() && !images.length} onClick={send}><ArrowUp size={16} strokeWidth={2.4} /></button>}
        </div>
      </div>
      <div className="composer-note">
        <Folder size={12} /> <span title={workspace.path}>{workspace.name}</span>
        <span className="sep">·</span>
        <span className={mode.danger ? 'danger-text' : ''}>{mode.detail}</span>
      </div>
    </div>
  );
}
