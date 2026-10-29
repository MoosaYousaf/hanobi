import { useCallback, useEffect, useState } from 'react';
import { X, ExternalLink, Plus, Minus, GitBranch } from 'lucide-react';
import { useStore, setUi, call, guard, toast } from '../store.js';

function GitPanel({ workspaceId }) {
  const [status, setStatus] = useState(null);
  const [open, setOpen] = useState(null); // { path, text }
  const [message, setMessage] = useState('');
  const load = useCallback(() => call('git:status', workspaceId).then(setStatus, toast), [workspaceId]);
  useEffect(() => { load(); return window.hanobi.on('git-changed', id => { if (id === workspaceId) load(); }); }, [load, workspaceId]);
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
  const staged = status.files.filter(f => f.staged).length;
  return (
    <div className="git">
      <div className="git-branch"><GitBranch size={14} /> {status.branch}
        {status.remote ? <button className="icon-btn sm" title="Open on GitHub" onClick={guard(() => call('git:remote', workspaceId))}><ExternalLink size={13} /></button> : null}
      </div>
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
