import { useState } from 'react';
import { X, Plus, RefreshCw, Trash2, ExternalLink, Plug, Cpu, SlidersHorizontal, Pencil } from 'lucide-react';
import { useStore, setUi, call, guard, toast } from '../store.js';
import { routeIcon } from './ModelPicker.jsx';
import { routeLabel } from '../labels.js';

const sections = [
  { id: 'models', label: 'Models', icon: Cpu },
  { id: 'connectors', label: 'Connectors', icon: Plug },
  { id: 'general', label: 'General', icon: SlidersHorizontal }
];
const ADDABLE = ['anthropic', 'openai', 'google', 'openrouter', 'deepseek', 'mistral', 'groq', 'xai', 'github-models', 'ollama', 'lmstudio', 'custom'];

function Status({ ok, children }) { return <span className={`status ${ok ? 'ok' : 'off'}`}><i />{children}</span>; }

function ConnectionForm({ initial, onDone }) {
  const presets = useStore(s => s.app.presets);
  const [form, setForm] = useState(initial || { preset: 'anthropic', name: '', baseURL: '', apiKey: '' });
  const preset = presets[form.preset];
  const field = key => e => setForm({ ...form, [key]: e.target.value });
  const save = guard(async () => {
    const id = await call('connection:save', { ...form, name: form.name || preset.name });
    try { const models = await call('models:refresh', id); toast(`${form.name || preset.name}: ${models.length} models available.`); }
    catch (error) { toast(`Saved, but the model list did not load: ${String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`); }
    onDone();
  });
  return (
    <div className="form">
      {!initial ? (
        <div className="preset-grid">
          {ADDABLE.map(id => (
            <button key={id} className={`preset ${form.preset === id ? 'selected' : ''}`} onClick={() => setForm({ ...form, preset: id, baseURL: presets[id].baseURL })}>
              <strong>{presets[id].name}</strong><span>{routeLabel[presets[id].route]}</span>
            </button>
          ))}
        </div>
      ) : null}
      <label className="field"><span>Name</span><input value={form.name} onChange={field('name')} placeholder={preset.name} /></label>
      {preset.kind === 'openai' ? <label className="field"><span>Base URL</span><input value={form.baseURL || ''} onChange={field('baseURL')} placeholder="https://…/v1" /></label> : null}
      {preset.needsKey || form.preset === 'custom' ? (
        <label className="field">
          <span>API key {initial?.hasKey ? '(saved, enter a new one to replace it)' : ''} {preset.keyUrl ? <button className="link" onClick={() => call('open:external', preset.keyUrl)}>Get a key <ExternalLink size={11} /></button> : null}</span>
          <input type="password" value={form.apiKey || ''} onChange={field('apiKey')} placeholder={initial?.hasKey ? '••••••••' : 'Paste your key'} autoComplete="off" />
        </label>
      ) : null}
      {preset.route === 'local' ? <p className="hint">Start {preset.name} first. Hanobi lists the models it has downloaded.</p> : null}
      <p className="hint">Keys are encrypted with your macOS Keychain and stay on this Mac.</p>
      <div className="form-actions"><button className="btn" onClick={onDone}>Cancel</button><button className="btn primary" onClick={save}>Save and test</button></div>
    </div>
  );
}

function ModelsPane() {
  const connections = useStore(s => s.app.connections);
  const presets = useStore(s => s.app.presets);
  const [editing, setEditing] = useState(null); // 'new' | connection
  const clis = connections.filter(c => c.kind === 'cli');
  const apis = connections.filter(c => c.kind !== 'cli');
  return (
    <>
      <h2>Models</h2>
      <p className="lede">Use subscriptions through their official CLIs, add API keys, or point Hanobi at a local model server.</p>
      <h3>Subscriptions <button className="icon-btn sm" title="Look for installed CLIs again" onClick={guard(() => call('clis:rescan'))}><RefreshCw size={12} /></button></h3>
      <ul className="rows">
        {clis.map(c => (
          <li key={c.id} className="row">
            <routeIcon.subscription size={15} />
            <div className="row-main"><strong>{c.name}</strong><span title={presets[c.preset].note}>{presets[c.preset].note || (c.ready ? 'Signs in with your existing CLI account. Includes its tools and file access.' : 'Install the CLI and sign in from Terminal, then rescan.')}</span></div>
            <Status ok={c.ready}>{c.ready ? 'Installed' : 'Not found'}</Status>
          </li>
        ))}
      </ul>
      <h3>API keys and local models</h3>
      {editing ? <ConnectionForm initial={editing === 'new' ? null : editing} onDone={() => setEditing(null)} /> : null}
      <ul className="rows">
        {apis.map(c => {
          const Icon = routeIcon[c.route];
          return (
            <li key={c.id} className="row">
              <Icon size={15} />
              <div className="row-main"><strong>{c.name}</strong><span>{c.detail}</span></div>
              <Status ok={c.ready}>{c.ready ? routeLabel[c.route] : 'Needs key'}</Status>
              <button className="icon-btn sm" title="Reload models" onClick={guard(async () => { const m = await call('models:refresh', c.id); toast(`${c.name}: ${m.length} models.`); })}><RefreshCw size={13} /></button>
              <button className="icon-btn sm" title="Edit" onClick={() => setEditing({ ...c, apiKey: '' })}><Pencil size={13} /></button>
              <button className="icon-btn sm" title="Remove" onClick={guard(async () => { if (confirm(`Remove ${c.name} and its saved key?`)) await call('connection:remove', c.id); })}><Trash2 size={13} /></button>
            </li>
          );
        })}
      </ul>
      {!editing ? <button className="btn" onClick={() => setEditing('new')}><Plus size={14} /> Add a provider</button> : null}
    </>
  );
}

const CONNECTOR_PRESETS = [
  { label: 'Notion', note: 'Sign in with your Notion account.', value: { name: 'Notion', transport: 'http', url: 'https://mcp.notion.com/mcp', oauth: true } },
  { label: 'GitHub', note: 'Needs a personal access token.', value: { name: 'GitHub', transport: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: [['Authorization', 'Bearer ']] } },
  { label: 'Files', note: 'Read and write one folder on this Mac.', value: { name: 'Files', transport: 'stdio', command: 'npx', args: '-y @modelcontextprotocol/server-filesystem ~/Documents' } },
  { label: 'Local command', note: 'Any stdio MCP server.', value: { name: '', transport: 'stdio', command: '', args: '' } },
  { label: 'Remote URL', note: 'Any Streamable HTTP MCP server.', value: { name: '', transport: 'http', url: '', oauth: false } }
];

function Pairs({ label, pairs, onChange, savedKeys }) {
  return (
    <div className="field">
      <span>{label}</span>
      {pairs.map(([k, v], i) => (
        <div key={i} className="pair">
          <input value={k} placeholder="NAME" onChange={e => onChange(pairs.map((p, j) => (j === i ? [e.target.value, p[1]] : p)))} />
          <input type="password" value={v} placeholder={savedKeys.includes(k) ? '•••• saved' : 'value'} onChange={e => onChange(pairs.map((p, j) => (j === i ? [p[0], e.target.value] : p)))} />
          <button className="icon-btn sm" onClick={() => onChange(pairs.filter((_, j) => j !== i))}><X size={12} /></button>
        </div>
      ))}
      <button className="link" onClick={() => onChange([...pairs, ['', '']])}><Plus size={11} /> Add</button>
    </div>
  );
}

function ConnectorForm({ initial, onDone }) {
  const [form, setForm] = useState(() => initial
    ? { ...initial, args: (initial.args || []).join(' '), env: initial.envKeys.map(k => [k, '']), headers: initial.headerKeys.map(k => [k, '']) }
    : { ...CONNECTOR_PRESETS[0].value, env: [], headers: [] });
  const field = key => e => setForm({ ...form, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const save = guard(async () => {
    const id = await call('mcp:save', { ...form, args: (form.args || '').split(/\s+/).filter(Boolean), env: Object.fromEntries(form.env), headers: Object.fromEntries(form.headers) });
    onDone();
    if (form.oauth) toast(`${form.name} saved. Click Connect to approve access in your browser.`);
    else await call('mcp:connect', id).catch(toast);
  });
  return (
    <div className="form">
      {!initial ? (
        <div className="preset-grid">
          {CONNECTOR_PRESETS.map(p => (
            <button key={p.label} className={`preset ${form.name === p.value.name && form.transport === p.value.transport && form.url === p.value.url ? 'selected' : ''}`} onClick={() => setForm({ env: [], headers: [], ...p.value })}>
              <strong>{p.label}</strong><span>{p.note}</span>
            </button>
          ))}
        </div>
      ) : null}
      <label className="field"><span>Name</span><input value={form.name} onChange={field('name')} /></label>
      {form.transport === 'stdio' ? (
        <>
          <label className="field"><span>Command</span><input value={form.command} onChange={field('command')} placeholder="npx" /></label>
          <label className="field"><span>Arguments</span><input value={form.args} onChange={field('args')} placeholder="-y @scope/server" /></label>
          <Pairs label="Environment variables" pairs={form.env} savedKeys={initial?.envKeys || []} onChange={env => setForm({ ...form, env })} />
        </>
      ) : (
        <>
          <label className="field"><span>Server URL</span><input value={form.url} onChange={field('url')} placeholder="https://…/mcp" /></label>
          <label className="check"><input type="checkbox" checked={!!form.oauth} onChange={field('oauth')} /> Sign in with OAuth</label>
          {!form.oauth ? <Pairs label="Headers" pairs={form.headers} savedKeys={initial?.headerKeys || []} onChange={headers => setForm({ ...form, headers })} /> : null}
        </>
      )}
      <p className="hint">Secrets are encrypted with your macOS Keychain.</p>
      <div className="form-actions"><button className="btn" onClick={onDone}>Cancel</button><button className="btn primary" onClick={save}>Save</button></div>
    </div>
  );
}

const stateText = { connected: 'Connected', connecting: 'Connecting…', authorizing: 'Finish in your browser…', 'needs-auth': 'Not connected', error: 'Error', disconnected: 'Not connected' };

function ConnectorsPane() {
  const servers = useStore(s => s.app.mcpServers);
  const status = useStore(s => s.app.mcpStatus);
  const [editing, setEditing] = useState(null);
  return (
    <>
      <h2>Connectors</h2>
      <p className="lede">MCP servers give models tools and data, such as Notion pages, GitHub, or local files. API and local models ask before each tool call. Claude Code also gets connectors that do not use OAuth.</p>
      {editing ? <ConnectorForm initial={editing === 'new' ? null : editing} onDone={() => setEditing(null)} /> : null}
      <ul className="rows">
        {servers.map(s => {
          const st = status[s.id] || {};
          const connected = s.enabled && st.state === 'connected';
          const busy = st.state === 'connecting' || st.state === 'authorizing';
          const detail = st.error || (connected ? `${st.toolCount} ${st.toolCount === 1 ? 'tool' : 'tools'}` : s.transport === 'stdio' ? `${s.command} ${(s.args || []).join(' ')}` : s.url);
          return (
            <li key={s.id} className="row">
              <Plug size={15} />
              <div className="row-main"><strong>{s.name}</strong><span title={detail}>{detail}</span></div>
              <Status ok={connected}>{s.enabled ? stateText[st.state] || 'Not connected' : 'Off'}</Status>
              {connected ? (
                <>
                  <button className="btn sm" onClick={guard(() => call('mcp:connect', s.id))}>Reconnect</button>
                  <button className="btn sm" onClick={guard(() => call('mcp:disconnect', s.id))} title={s.oauth ? 'Turn off and delete the saved sign-in' : 'Turn off'}>Disconnect</button>
                </>
              ) : (
                <button className="btn sm primary" disabled={busy} onClick={guard(() => call('mcp:connect', s.id))} title={s.oauth ? 'Opens the provider’s page in your browser to approve access' : 'Start the connector and load its tools'}>Connect</button>
              )}
              <button className="icon-btn sm" title="Edit" onClick={() => setEditing(s)}><Pencil size={13} /></button>
              <button className="icon-btn sm" title="Remove" onClick={guard(async () => { if (confirm(`Remove ${s.name}?`)) await call('mcp:remove', s.id); })}><Trash2 size={13} /></button>
            </li>
          );
        })}
      </ul>
      {!servers.length && !editing ? <p className="muted">No connectors yet.</p> : null}
      {!editing ? <button className="btn" onClick={() => setEditing('new')}><Plus size={14} /> Add a connector</button> : null}
    </>
  );
}

function GeneralPane() {
  const prefs = useStore(s => s.app.preferences);
  const [system, setSystem] = useState(prefs.systemPrompt);
  const setPref = patch => guard(() => call('prefs:set', patch))();
  return (
    <>
      <h2>General</h2>
      <h3>Appearance</h3>
      <div className="segmented">
        {['system', 'light', 'dark'].map(t => <button key={t} className={prefs.theme === t ? 'on' : ''} onClick={() => setPref({ theme: t })}>{t[0].toUpperCase() + t.slice(1)}</button>)}
      </div>
      <h3>Instructions for API and local models</h3>
      <textarea className="system-prompt" rows={6} value={system} onChange={e => setSystem(e.target.value)} onBlur={() => system !== prefs.systemPrompt && setPref({ systemPrompt: system })} placeholder="For example: Answer briefly. Use metric units." />
      <p className="hint">CLI agents use their own instructions, such as CLAUDE.md or AGENTS.md.</p>
      <h3>Privacy</h3>
      <p className="hint">Conversations stay in this Mac’s Application Support folder. Prompts go only to the model you choose.</p>
    </>
  );
}

export default function Settings() {
  const section = useStore(s => s.ui.settings);
  const close = () => setUi({ settings: null });
  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) close(); }} onKeyDown={e => { if (e.key === 'Escape') close(); }}>
      <div className="settings" role="dialog" aria-label="Settings">
        <nav className="settings-nav">
          {sections.map(s => <button key={s.id} className={section === s.id ? 'on' : ''} onClick={() => setUi({ settings: s.id })}><s.icon size={15} /> {s.label}</button>)}
        </nav>
        <div className="settings-body">
          <button className="icon-btn settings-close" title="Close (Esc)" onClick={close}><X size={16} /></button>
          {section === 'connectors' ? <ConnectorsPane /> : section === 'general' ? <GeneralPane /> : <ModelsPane />}
        </div>
      </div>
    </div>
  );
}
