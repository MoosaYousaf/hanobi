import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Square, Plus, X, Mic } from 'lucide-react';
import { useStore, getState, call, guard, toast, askConfirm, askText, setUi, newThread, openThread, focusPane } from '../store.js';
import { CommandMenu, useMenuItems, trigger, builtin } from './CommandMenu.jsx';
import { startVoice, stopVoice, cancelVoice } from '../voice/voice.js';
import { ModelPicker, OptionPicker } from './ModelPicker.jsx';
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

// The rest of the first suggestion, then the newest earlier user message, that starts with the typed text.
const MIN_TYPED = 2;
const userText = m => (m.role === 'user' ? (m.parts || []).filter(p => p.type === 'text').map(p => p.text).join('\n') : '');
export function completion(text, suggestions, messages) {
  if (text.trim().length < MIN_TYPED || text.includes('\n') || /^[/@]/.test(text)) return '';
  const typed = text.toLowerCase();
  const earlier = messages.map(userText).filter(t => t && !t.includes('\n')).reverse();
  const match = [...suggestions, ...earlier].find(c => c.length > text.length && c.toLowerCase().startsWith(typed));
  return match ? match.slice(text.length) : '';
}

// Text drafts survive switching between conversations.
const drafts = new Map();
// A mounted composer listens, so a draft set from outside (rewind, a suggestion) shows at once.
export const getDraft = threadId => drafts.get(threadId) ?? '';
export const setDraft = (threadId, text) => { drafts.set(threadId, text); window.dispatchEvent(new CustomEvent('orin-draft', { detail: threadId })); };

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
  // The / or @ menu follows the caret. A closed menu stays closed until the trigger word changes.
  const [menu, setMenu] = useState(null);
  const [index, setIndex] = useState(0);
  const dismissed = useRef(null); // a ref, so an onSelect in the same event sees the Escape at once
  const items = useMenuItems(menu, workspace.id);
  const follow = (value, caret) => {
    const found = trigger(value, caret);
    const key = found && `${found.kind}:${found.start}`;
    if (!found) dismissed.current = null;
    const next = found && key !== dismissed.current ? found : null;
    setMenu(open => (open?.kind === next?.kind && open?.start === next?.start && open?.query === next?.query ? open : next));
    if (next?.query !== menu?.query || next?.kind !== menu?.kind) setIndex(0);
  };
  // The ghost text: the first suggested reply shows in the empty box, and Tab takes it.
  const last = thread.messages.at(-1);
  const suggestions = !running && last?.role === 'assistant' ? last.suggestions || [] : [];
  const ghost = !text ? suggestions[0] || '' : '';
  // While the user types, the rest of a matching suggestion or earlier message shows after the caret. Tab or → takes it.
  const [atEnd, setAtEnd] = useState(true);
  const rest = !menu && atEnd ? completion(text, suggestions, thread.messages) : '';
  // The box fits its text on every change: typing, a send that clears it, voice input, or a restored draft.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    if (text) el.style.height = Math.min(el.scrollHeight, 260) + 'px';
  }, [text]);
  useEffect(() => {
    const onDraft = e => { if (e.detail === thread.id) { setText(drafts.get(thread.id) ?? ''); input.current?.focus(); } };
    window.addEventListener('orin-draft', onDraft);
    return () => window.removeEventListener('orin-draft', onDraft);
  }, [thread.id]);
  // Any file type. Main copies it into the thread's folder; a pasted file without a path is sent as bytes.
  const add = parts => setFiles(list => [...list, ...parts].slice(0, MAX_FILES));
  const attach = guard(async list => {
    for (const file of [...list]) {
      if (!isCli && file.type?.startsWith('image/') && file.size > MAX_IMAGE) throw new Error(`${file.name} is larger than 5 MB, the image limit for API models.`);
      const source = window.orin.pathFor?.(file);
      add(source ? await call('files:attach', thread.id, [source]) : [await call('files:attach-data', thread.id, await readData(file))]);
    }
  });
  const pick = guard(async () => add(await call('files:pick', thread.id)));
  // Orin's own commands run here, for every model, and never go to the model.
  const signal = name => window.dispatchEvent(new CustomEvent('orin-picker', { detail: `${thread.id}:${name}` }));
  const runBuiltin = guard(async ({ name, args }) => {
    update(''); setMenu(null);
    if (name === 'clear') {
      if (running) throw new Error('Stop the reply first.');
      focusPane(thread.id);
      const fresh = await call('thread:new', workspace.id, { connectionId: thread.connectionId, model: thread.model, effort: thread.effort, mode: thread.mode });
      await openThread(fresh.id);
      toast('New conversation. The old one is in the sidebar.');
    }
    if (name === 'effort' && !(preset?.efforts?.length > 1)) throw new Error('This model has no effort levels.');
    if (name === 'access' && chatCli) throw new Error('Chats and projects are read-only for CLI agents, so they have no access mode.');
    if (name === 'model' || name === 'effort' || name === 'access') signal(name);
    if (name === 'rename') { const title = args || await askText('Conversation name', thread.title); if (title) await call('thread:rename', thread.id, title); }
    if (name === 'attach') await pick();
    if (name === 'split') await newThread(workspace.id, { split: true });
    if (name === 'skills' || name === 'changes') setUi({ panel: name === 'skills' ? 'skills' : 'git' });
    if (name === 'settings') setUi({ settings: 'models' });
  });
  // A picked item: Orin commands without arguments run at once; other commands and files go into the text.
  const choose = item => {
    const el = input.current;
    if (menu.kind === 'slash') {
      if (item.kind === 'builtin' && !item.hint) { runBuiltin({ name: item.name, args: '' }); return; }
      const rest = text.slice(el.selectionStart).replace(/^\S*/, '');
      const value = `/${item.name} ${rest.trimStart()}`;
      update(value); setMenu(null);
      requestAnimationFrame(() => el.setSelectionRange(item.name.length + 2, item.name.length + 2));
      return;
    }
    const caret = el.selectionStart;
    const ref = item.name.replace(/ /g, '\\ ');
    const head = text.slice(0, menu.start) + '@' + ref + (item.kind === 'folder' ? '' : ' ');
    const value = head + text.slice(caret).replace(/^\S*/, '');
    update(value);
    // A folder keeps the menu open, so the search goes on inside it.
    if (item.kind === 'folder') follow(value, head.length); else setMenu(null);
    requestAnimationFrame(() => el.setSelectionRange(head.length, head.length));
  };
  const onKey = e => {
    if (menu && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && items.length) { e.preventDefault(); setIndex(i => (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length); return; }
    if (menu && (e.key === 'Enter' || e.key === 'Tab') && items[index] && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); choose(items[index]); return; }
    if (menu && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismissed.current = `${menu.kind}:${menu.start}`; setMenu(null); return; }
    if (e.key === 'Tab' && !e.shiftKey && ghost) { e.preventDefault(); update(ghost); return; }
    if (((e.key === 'Tab' && !e.shiftKey) || (e.key === 'ArrowRight' && !e.metaKey && !e.altKey)) && rest) { e.preventDefault(); update(text + rest); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
  };
  const send = guard(async () => {
    if (running || (!text.trim() && !files.length)) return;
    const own = !files.length && builtin(text);
    if (own) { runBuiltin(own); return; }
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
      <CommandMenu open={menu} items={items} index={index} onPick={choose} onHover={setIndex} />
      {suggestions.length && !text && !menu ? (
        <div className="suggestions" aria-label="Suggested replies">
          {suggestions.map(s => <button key={s} className="suggestion" onClick={() => { update(s); input.current?.focus(); }}>{s}</button>)}
        </div>
      ) : null}
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
        <div className="input-box">
          {rest ? <div className="ghost-mirror" aria-hidden="true"><span>{text}</span><span className="ghost-rest">{rest}</span></div> : null}
          <textarea
            ref={input} autoFocus rows={1} value={text} className={ghost ? 'ghost' : ''}
            placeholder={ghost || `Message ${modelLabel.split(' · ')[0]}… (/ for commands, @ for files)`}
            aria-autocomplete="list" aria-expanded={!!menu}
            onChange={e => { update(e.target.value); follow(e.target.value, e.target.selectionStart); }}
            onSelect={e => { setAtEnd(e.target.selectionStart === e.target.value.length); if (menu || e.target.value.includes('@') || e.target.value.startsWith('/')) follow(e.target.value, e.target.selectionStart); }}
            onBlur={() => setMenu(null)}
            onPaste={e => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); attach(files); } }}
            onKeyDown={onKey}
          />
        </div>
        {ghost || rest ? <kbd className="ghost-key" title="Press Tab to use the suggestion">Tab</kbd> : null}
        {running
          ? <button className="send stop" title="Stop" onClick={guard(() => call('run:stop', thread.id))}><Square size={11} fill="currentColor" /></button>
          : <button className="send" title="Send (Enter)" disabled={!text.trim() && !files.length} onClick={send}><ArrowUp size={15} strokeWidth={2.4} /></button>}
      </div>
      <VoiceStatus threadId={thread.id} />
      <div className="composer-row">
        <button className="icon-btn tip" data-tip="Attach files" aria-label="Attach files" onClick={pick}><Plus size={16} /></button>
        <MicButton threadId={thread.id} />
        {!chatCli ? (
          <OptionPicker options={modes} value={mode.id} disabled={running} onPick={onAccess} title={mode.detail} danger={mode.danger} label="Access mode" openKey={`${thread.id}:access`} />
        ) : null}
        <span className="grow" />
        <ModelPicker thread={thread} label={modelLabel} disabled={running} openKey={`${thread.id}:model`} />
        {preset?.efforts?.length > 1 ? (
          <OptionPicker options={preset.efforts.map(e => ({ id: e, label: e ? cap(e) : 'Default effort' }))} value={thread.effort} disabled={running} onPick={effort => setting({ effort })} title="Effort" label="Effort" align="end" openKey={`${thread.id}:effort`} />
        ) : null}
        <UsageRing thread={thread} preset={preset} />
      </div>
    </div>
  );
}
