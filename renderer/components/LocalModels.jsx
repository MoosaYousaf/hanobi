import { useEffect, useRef, useState } from 'react';
import { Search, Download, Trash2, X, HardDrive, Cpu, ChevronRight, Heart, ArrowDownToLine } from 'lucide-react';
import { useStore, call, guard, toast, askConfirm } from '../store.js';

const GB = 1e9;
const size = bytes => (bytes >= GB ? `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);
const count = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K` : String(n));
const ago = iso => {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 864e5);
  return !iso || Number.isNaN(days) ? '' : days < 1 ? 'today' : days < 31 ? `${days}d ago` : days < 365 ? `${Math.floor(days / 30)}mo ago` : `${Math.floor(days / 365)}y ago`;
};
const FIT = { good: ['Runs well', 'ok'], tight: ['Tight: slow, may swap', 'warn'], no: ['Too big for this Mac', 'bad'] };
const SORTS = [['trending', 'Trending'], ['downloads', 'Most downloaded'], ['new', 'Newest'], ['likes', 'Most liked']];

function Bar({ value }) { return <div className="bar" role="progressbar" aria-valuenow={Math.round(value * 100)}><i style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} /></div>; }

function Engine({ engine }) {
  const { installed, install, tools, server, tag } = engine;
  const ready = tools.cmake && tools.compiler;
  return (
    <div className="row local-engine">
      <Cpu size={15} />
      <div className="row-main">
        <strong>Local engine</strong>
        {install && !install.error ? <><span>{install.step}</span><Bar value={install.progress ?? 0} /></>
          : installed ? <span>llama.cpp {tag}{server ? ` · ${server.ready ? 'running' : 'loading'} ${server.model.split('/').pop()}` : ' · stopped'}</span>
          : <span>Runs the models on this Mac. Orin builds it once from source (10 to 40 minutes).</span>}
        {install?.error ? <span className="hint warn">{install.error}</span> : null}
        {!installed && !install && !ready ? <span className="hint warn">Needs {!tools.compiler ? 'the Xcode Command Line Tools (xcode-select --install)' : ''}{!tools.compiler && !tools.cmake ? ' and ' : ''}{!tools.cmake ? 'CMake (brew install cmake)' : ''}.</span> : null}
      </div>
      {install && !install.error ? <button className="btn sm" onClick={guard(() => call('local:cancel-install'))}>Cancel</button>
        : !installed ? <button className="btn sm primary" disabled={!ready} onClick={guard(() => call('local:install-engine'))}>{install?.error ? 'Try again' : 'Install'}</button>
        : server ? <button className="btn sm" title="Free the memory the model uses" onClick={guard(() => call('local:unload'))}>Unload</button> : null}
    </div>
  );
}

function Files({ repo, files, installed, active }) {
  if (!files) return <div className="hint">Loading files…</div>;
  if (!files.length) return <div className="hint">This repository has no model files Orin can run.</div>;
  return (
    <ul className="local-files">
      {files.map(f => {
        const id = `${repo.replace('/', '__')}/${f.name}`;
        const have = installed.has(id), busy = active.has(id), [label, tone] = FIT[f.fit];
        return (
          <li key={f.path}>
            <span className="lf-quant">{f.quant || 'GGUF'}</span>
            <span className="lf-name" title={f.path}>{f.name}</span>
            <span className="lf-size">{size(f.size)}</span>
            <span className={`lf-fit ${tone}`}>{label}</span>
            {f.recommended ? <span className="lf-rec">Recommended</span> : <span />}
            <button className={`btn sm ${f.recommended && !have ? 'primary' : ''}`} disabled={have || busy || f.fit === 'no'} onClick={guard(() => call('local:download', repo, f.path))}>
              {have ? 'Downloaded' : busy ? 'Downloading' : <><Download size={12} /> Download</>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Finder({ installed, active }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('trending');
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);
  const [files, setFiles] = useState({});
  const latest = useRef(0);
  const find = async (q = query, s = sort) => {
    const mine = ++latest.current;
    setBusy(true);
    try { const list = await call('local:search', q, s); if (mine === latest.current) { setResults(list); setOpen(null); } }
    catch (error) { if (mine === latest.current) { setResults([]); toast(error); } }
    finally { if (mine === latest.current) setBusy(false); }
  };
  useEffect(() => { find('', 'trending'); }, []);
  const show = repo => {
    setOpen(open === repo ? null : repo);
    if (!files[repo]) call('local:files', repo).then(list => setFiles(f => ({ ...f, [repo]: list })), error => { toast(error); setOpen(null); });
  };
  return (
    <div className="finder">
      <form className="finder-bar" onSubmit={e => { e.preventDefault(); find(); }}>
        <label className="pick-search"><Search size={14} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search models, for example qwen, llama, gemma" /></label>
        <select className="mini-select" value={sort} onChange={e => { setSort(e.target.value); find(query, e.target.value); }} aria-label="Sort">
          {SORTS.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </form>
      {busy && !results ? <div className="hint">Searching Hugging Face…</div> : null}
      {results && !results.length ? <div className="hint">No models found.</div> : null}
      <ul className="rows finder-results">
        {(results || []).map(m => (
          <li key={m.id} className={`finder-item ${open === m.id ? 'open' : ''}`}>
            <button className="finder-head" onClick={() => show(m.id)} aria-expanded={open === m.id}>
              <ChevronRight size={14} className="chev" />
              <span className="finder-name">{m.id}</span>
              <span className="finder-meta"><ArrowDownToLine size={11} /> {count(m.downloads)}</span>
              <span className="finder-meta"><Heart size={11} /> {count(m.likes)}</span>
              <span className="finder-meta">{ago(m.updated)}</span>
            </button>
            {open === m.id ? <Files repo={m.id} files={files[m.id]} installed={installed} active={active} /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LocalModels() {
  const local = useStore(s => s.app.local);
  const [finding, setFinding] = useState(false);
  const installed = new Set(local.models.map(m => m.id));
  const jobs = local.downloads.filter(j => j.state !== 'done');
  const active = new Set(jobs.filter(j => j.state === 'downloading').map(j => j.id));
  const ram = local.engine.memory;
  return (
    <>
      <h3>On this Mac</h3>
      <p className="hint">Download models from Hugging Face and run them here, with no account and no network use once they are downloaded. This Mac has {Math.round(ram / 2 ** 30)} GB of memory: files up to about {size(ram * 0.45 - 0.6 * GB)} run well. Only one model is in memory at a time, and it unloads after 10 idle minutes.</p>
      <ul className="rows">
        <Engine engine={local.engine} />
        {local.models.map(m => (
          <li key={m.id} className="row">
            <HardDrive size={15} />
            <div className="row-main"><strong>{m.repo.split('/')[1].replace(/-GGUF$/i, '')} · {m.quant || 'GGUF'}</strong><span>{m.repo} · {size(m.size)}{local.engine.server?.model === m.id ? ' · in memory' : ''}</span></div>
            <button className="icon-btn sm" title="Delete from this Mac" onClick={guard(async () => { if (await askConfirm({ title: `Delete ${m.name}?`, message: `The ${size(m.size)} file is removed from this Mac. You can download it again.`, confirmLabel: 'Delete', danger: true })) await call('local:remove', m.id); })}><Trash2 size={13} /></button>
          </li>
        ))}
        {jobs.map(j => (
          <li key={j.id} className="row">
            <Download size={15} />
            <div className="row-main"><strong>{j.name}</strong>{j.state === 'failed' ? <span className="hint warn">{j.error}</span> : <><span>{size(j.done)} of {size(j.size)}</span><Bar value={j.size ? j.done / j.size : 0} /></>}</div>
            <button className="icon-btn sm" title={j.state === 'failed' ? 'Dismiss' : 'Cancel the download'} onClick={guard(() => call('local:cancel', j.id))}><X size={13} /></button>
          </li>
        ))}
      </ul>
      {!local.models.length && !jobs.length ? <p className="muted">No models on this Mac yet.</p> : null}
      {finding ? <><h3>Find models</h3><Finder installed={installed} active={active} /></> : <button className="btn" onClick={() => setFinding(true)}><Search size={14} /> Find models</button>}
    </>
  );
}
