import { useEffect, useState } from 'react';
import { PanelLeftOpen, Plus, FileText, X, Trash2, Pencil, Upload } from 'lucide-react';
import { useStore, setUi, openThread, newThread, call, guard, askText, askConfirm } from '../store.js';

const size = bytes => (bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);

// A project: its instructions, its documents, and its chats. Every chat in it gets both as context.
export function ProjectView({ projectId }) {
  const sidebar = useStore(s => s.ui.sidebar);
  const project = useStore(s => s.app.workspaces.find(w => w.id === projectId));
  const threads = useStore(s => s.app.threads);
  const [instructions, setInstructions] = useState(project?.instructions || '');
  const [files, setFiles] = useState([]);
  const loadFiles = guard(async () => setFiles(await call('project:files', projectId)));
  useEffect(() => { setInstructions(project?.instructions || ''); loadFiles(); }, [projectId]);
  if (!project) return null;
  const chats = threads.filter(t => t.workspaceId === projectId).toSorted((a, b) => b.updatedAt - a.updatedAt);
  const save = guard(() => instructions !== project.instructions && call('project:update', projectId, { instructions }));
  const rename = guard(async () => { const name = await askText('Project name', project.name); if (name !== null) await call('project:update', projectId, { name }); });
  const remove = guard(async () => {
    if (!await askConfirm({ title: `Delete “${project.name}”?`, message: `Its ${chats.length} chats and ${files.length} documents are deleted. You cannot undo this.`, confirmLabel: 'Delete project', danger: true })) return;
    await call('workspace:remove', projectId);
    setUi({ projectId: null });
  });
  const add = guard(async () => { await call('project:add-files', projectId); loadFiles(); });
  const removeFile = name => guard(async () => { await call('project:remove-file', projectId, name); loadFiles(); });
  return (
    <div className="thread">
      <header className="topbar drag">
        {!sidebar ? <button className="icon-btn no-drag" title="Show sidebar (⌘\)" onClick={() => setUi({ sidebar: true })}><PanelLeftOpen size={16} /></button> : null}
        <div className="crumbs no-drag"><span className="crumb-ws">Projects</span><span className="crumb-sep">/</span><button className="crumb-title" onClick={rename} title="Rename">{project.name}</button></div>
        <div className="top-actions no-drag">
          <button className="icon-btn" title="Rename" onClick={rename}><Pencil size={15} /></button>
          <button className="icon-btn" title="Delete project" onClick={remove}><Trash2 size={15} /></button>
        </div>
      </header>
      <div className="scroller">
        <div className="column project">
          <div className="project-head">
            <h1>{project.name}</h1>
            <button className="btn primary" onClick={guard(() => newThread(projectId))}><Plus size={14} /> New chat</button>
          </div>
          <section className="project-section">
            <h3>Instructions</h3>
            <textarea className="system-prompt" rows={5} value={instructions} onChange={e => setInstructions(e.target.value)} onBlur={save}
              placeholder="What every chat in this project should know. For example: You review contracts for a small design studio. Answer in plain language." />
          </section>
          <section className="project-section">
            <div className="project-files-head"><h3>Documents</h3><button className="btn" onClick={add}><Upload size={14} /> Add files</button></div>
            {files.length ? (
              <ul className="project-files">
                {files.map(f => (
                  <li key={f.name}><FileText size={14} /><span className="project-file-name">{f.name}</span><span className="muted">{size(f.size)}</span>
                    <button className="icon-btn sm" title={`Remove ${f.name}`} onClick={removeFile(f.name)}><X size={13} /></button></li>
                ))}
              </ul>
            ) : <p className="hint">No documents yet. API and local models get the text of text documents. CLI agents open any document, including PDFs, from the project folder.</p>}
          </section>
          <section className="project-section">
            <h3>Chats</h3>
            {chats.length ? chats.map(t => <button key={t.id} className="thread-row" onClick={guard(() => openThread(t.id))}><span className="thread-title">{t.title}</span></button>) : <p className="hint">No chats yet.</p>}
          </section>
        </div>
      </div>
    </div>
  );
}
