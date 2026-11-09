import { useCallback, useEffect, useState } from 'react';
import { X, ExternalLink, Plus, Minus, GitBranch, GitPullRequest, Check, Circle, ChevronDown, ArrowUp, ArrowDown } from 'lucide-react';
import { useStore, setUi, call, guard, toast, askText } from '../store.js';
import { Menu, MenuItem, MenuSeparator } from './Menu.jsx';

const REVIEW = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review required' };

function BranchMenu({ workspaceId, current, anchor, onClose }) {
  const [branches, setBranches] = useState([]);
  useEffect(() => { call('git:branches', workspaceId).then(setBranches, toast); }, [workspaceId]);
  const go = guard(async (name, create) => { onClose(); await call('git:checkout', workspaceId, name, create); toast(`Switched to ${name}.`); });
  const create = async () => { onClose(); const name = await askText('New branch name'); if (name) await go(name.trim(), true); };
  return (
    <Menu anchor={anchor} onClose={onClose} label="Branches">
      {branches.map(b => <MenuItem key={b} icon={b === current ? Check : null} disabled={b === current} onClick={() => go(b, false)}>{b}</MenuItem>)}
      {branches.length ? <MenuSeparator /> : null}
      <MenuItem icon={Plus} onClick={create}>New branch…</MenuItem>
    </Menu>
  );
}

function Checks({ checks }) {
  if (!checks || !(checks.passed + checks.failed + checks.pending)) return null;
  return (
    <span className="pr-checks tip tip-end" data-tip={`Checks: ${checks.passed} passed, ${checks.failed} failed, ${checks.pending} pending`}>
      {checks.failed ? <span className="bad"><X size={11} />{checks.failed}</span> : null}
      {checks.pending ? <span className="wait"><Circle size={9} />{checks.pending}</span> : null}
      {checks.passed ? <span className="good"><Check size={11} />{checks.passed}</span> : null}
    </span>
  );
}

function CreatePr({ workspaceId, branch, onDone, onCancel }) {
  const [form, setForm] = useState({ title: branch.replace(/[-_/]+/g, ' ').replace(/^\w/, c => c.toUpperCase()), body: '', base: '', draft: false });
  const [busy, setBusy] = useState(false);
  useEffect(() => { call('github:default-branch', workspaceId).then(base => setForm(f => ({ ...f, base: f.base || base })), () => {}); }, [workspaceId]);
  const field = key => ({ value: form[key], onChange: e => setForm({ ...form, [key]: e.target.value }) });
  const submit = async e => {
    e.preventDefault(); setBusy(true);
    try { await call('github:create', workspaceId, form); toast('Pull request created.'); onDone(); } catch (error) { toast(error); } finally { setBusy(false); }
  };
  return (
    <form className="pr-form" onSubmit={submit}>
      <input autoFocus placeholder="Title" {...field('title')} />
      <textarea rows={4} placeholder="Description (Markdown)" {...field('body')} />
      <label className="pr-base">Into <input placeholder="main" {...field('base')} /></label>
      <label className="check"><input type="checkbox" checked={form.draft} onChange={e => setForm({ ...form, draft: e.target.checked })} /> Draft</label>
      <div className="pr-actions">
        <button type="button" className="btn sm" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn sm primary" disabled={busy || !form.title.trim()}>{busy ? 'Creating…' : 'Create pull request'}</button>
      </div>
    </form>
  );
}

// The pull request of the current branch, and the open ones in the repository.
function PullRequests({ workspaceId, status }) {
  const [state, setState] = useState(null); // { current, list } or { error }
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState(null); // { pr, anchor }
  const load = useCallback(() => Promise.all([call('github:current', workspaceId), call('github:list', workspaceId)])
    .then(([current, list]) => setState({ current, list }), error => setState({ error: String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })), [workspaceId]);
  useEffect(() => { load(); }, [load, status.branch, status.upstream, status.ahead]);
  if (!state) return <p className="muted pad">Loading pull requests…</p>;
  if (state.error) return <p className="muted pad pr-error">{state.error}</p>;
  const { current, list } = state;
  const others = list.filter(pr => pr.number !== current?.number);
  const open = url => call('github:open', url).catch(toast);
  return (
    <div className="prs">
      {current ? (
        <div className="pr-card">
          <button className="pr-title" onClick={() => open(current.url)} title="Open on GitHub"><GitPullRequest size={14} /> <span>{current.title}</span> <span className="muted">#{current.number}</span></button>
          <div className="pr-meta">
            <span className={`pr-state ${current.draft ? 'draft' : current.state.toLowerCase()}`}>{current.draft ? 'Draft' : cap(current.state)}</span>
            {current.review ? <span>{REVIEW[current.review] || current.review}</span> : null}
            <span className="muted">into {current.base}</span>
            <Checks checks={current.checks} />
          </div>
        </div>
      ) : creating ? <CreatePr workspaceId={workspaceId} branch={status.branch} onCancel={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} />
        : status.detached ? null : (
          <div className="pr-none">
            <span className="muted">{!status.upstream || status.ahead ? 'Push this branch to open a pull request.' : 'No pull request for this branch.'}</span>
            <button className="btn sm" disabled={!status.upstream || !!status.ahead} onClick={() => setCreating(true)}><GitPullRequest size={13} /> Create</button>
          </div>
        )}
      {others.length ? <>
        <div className="panel-sub">Open pull requests</div>
        <ul className="pr-list">
          {others.map(pr => (
            <li key={pr.number}><button className="pr-row" onClick={e => setMenu({ pr, anchor: e.currentTarget.getBoundingClientRect() })}>
              <span className="pr-num">#{pr.number}</span><span className="pr-row-title">{pr.title}</span>{pr.draft ? <span className="badge">Draft</span> : null}
            </button></li>
          ))}
        </ul>
      </> : null}
      {menu ? <Menu anchor={menu.anchor} onClose={() => setMenu(null)} label={`Pull request ${menu.pr.number}`}>
        <MenuItem icon={ExternalLink} onClick={() => { setMenu(null); open(menu.pr.url); }}>Open on GitHub</MenuItem>
        <MenuItem icon={GitBranch} onClick={guard(async () => { setMenu(null); await call('github:checkout', workspaceId, menu.pr.number); toast(`Checked out #${menu.pr.number}.`); })}>Check out {menu.pr.head}</MenuItem>
      </Menu> : null}
    </div>
  );
}

const cap = s => s.charAt(0) + s.slice(1).toLowerCase();

function GitPanel({ workspaceId }) {
  const [status, setStatus] = useState(null);
  const [open, setOpen] = useState(null); // { path, text }
  const [message, setMessage] = useState('');
  const [branchMenu, setBranchMenu] = useState(null);
  const [syncing, setSyncing] = useState(null); // 'push' | 'pull'
  const load = useCallback(() => call('git:status', workspaceId).then(setStatus, toast), [workspaceId]);
  useEffect(() => { load(); return window.orin.on('git-changed', id => { if (id === workspaceId) load(); }); }, [load, workspaceId]);
  // An agent run usually changes files, so refresh when one finishes.
  const running = useStore(s => Object.keys(s.live).length);
  useEffect(() => { if (!running) load(); }, [running, load]);
  if (!status) return <p className="muted pad">Loading changes…</p>;
  if (status.error) return <p className="muted pad">This folder is not a Git repository.</p>;
  const showDiff = guard(async file => {
    if (open?.path === file.path) { setOpen(null); return; }
    setOpen({ path: file.path, text: await call('git:diff', workspaceId, file.path, { staged: file.staged, untracked: file.untracked }) });
  });
  const commit = guard(async () => { await call('git:commit', workspaceId, message); setMessage(''); toast('Commit created.'); });
  const sync = kind => async () => {
    setSyncing(kind);
    try { await call(`git:${kind}`, workspaceId); toast(kind === 'push' ? 'Pushed.' : 'Pulled.'); } catch (error) { toast(error); } finally { setSyncing(null); }
  };
  const staged = status.files.filter(f => f.staged).length;
  return (
    <div className="git">
      <div className="git-branch">
        <button className="branch-btn" title="Switch branch" disabled={!!syncing} onClick={e => setBranchMenu(e.currentTarget.getBoundingClientRect())}><GitBranch size={14} /><span>{status.branch}</span><ChevronDown size={12} /></button>
        {status.upstream ? <span className="git-ab tip" data-tip={`${status.ahead} to push, ${status.behind} to pull`}>{status.ahead ? `↑${status.ahead}` : ''}{status.behind ? ` ↓${status.behind}` : ''}</span> : null}
        <span className="git-sync">
          {status.upstream ? <button className="icon-btn sm tip tip-end" data-tip="Pull" disabled={!!syncing} onClick={sync('pull')}><ArrowDown size={13} /></button> : null}
          {status.remote && !status.detached ? <button className="icon-btn sm tip tip-end" data-tip={status.upstream ? 'Push' : 'Publish branch'} disabled={!!syncing || (status.upstream && !status.ahead)} onClick={sync('push')}><ArrowUp size={13} /></button> : null}
          {status.remote ? <button className="icon-btn sm tip tip-end" data-tip="Open on GitHub" onClick={guard(() => call('git:remote', workspaceId))}><ExternalLink size={13} /></button> : null}
        </span>
      </div>
      {branchMenu ? <BranchMenu workspaceId={workspaceId} current={status.branch} anchor={branchMenu} onClose={() => setBranchMenu(null)} /> : null}
      {status.remote ? <PullRequests workspaceId={workspaceId} status={status} /> : null}
      <div className="panel-sub">Changes</div>
      {!status.files.length ? <p className="muted pad">No changes.</p> : null}
      <ul className="git-files">
        {status.files.map(f => (
          <li key={f.path}>
            <div className="git-file">
              <span className={`git-mark ${f.untracked ? 'new' : f.staged ? 'staged' : 'mod'}`}>{f.untracked ? 'U' : f.staged ? 'S' : 'M'}</span>
              <button className="git-path" onClick={() => showDiff(f)} title={f.path}>{f.path}</button>
              <button className="icon-btn sm" title={f.staged ? 'Unstage' : 'Stage'} onClick={guard(() => call('git:stage', workspaceId, f.path, f.staged))}>{f.staged ? <Minus size={13} /> : <Plus size={13} />}</button>
            </div>
            {open?.path === f.path ? <pre className="diff">{open.text.split('\n').map((line, i) => <span key={i} className={line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : ''}>{line}{'\n'}</span>)}</pre> : null}
          </li>
        ))}
      </ul>
      <div className="commit">
        <textarea rows={2} value={message} onChange={e => setMessage(e.target.value)} placeholder="Commit message" />
        <button className="btn primary full" disabled={!staged || !message.trim()} onClick={commit}>Commit {staged ? `${staged} staged` : ''}</button>
      </div>
    </div>
  );
}

function SkillsPanel({ workspaceId }) {
  const [skills, setSkills] = useState(null);
  useEffect(() => { call('skills', workspaceId).then(setSkills, toast); }, [workspaceId]);
  if (!skills) return <p className="muted pad">Loading skills…</p>;
  if (!skills.length) return <p className="muted pad">No skills found. Skills installed for Claude Code, Codex, or Gemini CLI appear here, and those agents load them on their own.</p>;
  return (
    <ul className="skills">
      {skills.map(s => <li key={s.path}><div className="skill-name">{s.name}<span className="badge">{s.source}</span></div>{s.description ? <div className="skill-desc">{s.description}</div> : null}</li>)}
    </ul>
  );
}

export function SidePanel() {
  const panel = useStore(s => s.ui.panel);
  const workspaceId = useStore(s => s.ui.workspaceId);
  return (
    <aside className="panel">
      <div className="panel-head drag">
        <h2>{panel === 'git' ? 'Changes' : 'Skills'}</h2>
        <button className="icon-btn no-drag" title="Close" onClick={() => setUi({ panel: null })}><X size={15} /></button>
      </div>
      <div className="panel-body">{workspaceId ? (panel === 'git' ? <GitPanel key={workspaceId} workspaceId={workspaceId} /> : <SkillsPanel key={workspaceId} workspaceId={workspaceId} />) : null}</div>
    </aside>
  );
}
