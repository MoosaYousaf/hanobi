import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Folder, FileText, Sparkles, SquareSlash, TerminalSquare } from 'lucide-react';
import { call } from '../store.js';

// The / and @ menus of the composer. "/" at the start of the message lists Hanobi's own commands, then the
// custom commands and skills found on disk (see electron/commands.js). "@" before a word searches the workspace files.
// Hanobi's commands run in the app for every model; file commands go to the model (Claude Code runs its own).
export const BUILTINS = [
  { name: 'clear', description: 'Start a new conversation with the same model. This one stays in the sidebar.' },
  { name: 'model', description: 'Choose the model.' },
  { name: 'effort', description: 'Choose the effort level.' },
  { name: 'access', description: 'Choose the access mode.' },
  { name: 'rename', description: 'Rename this conversation.', hint: '[name]' },
  { name: 'attach', description: 'Attach files.' },
  { name: 'split', description: 'Open a new conversation in a split pane.' },
  { name: 'skills', description: 'Show the skills panel.' },
  { name: 'changes', description: 'Show the changes panel.' },
  { name: 'settings', description: 'Open settings.' }
];
export const builtin = text => {
  const match = text.trim().match(/^\/(\w+)(?:\s+([\s\S]*))?$/);
  const command = match && BUILTINS.find(c => c.name === match[1]);
  return command ? { name: command.name, args: (match[2] || '').trim() } : null;
};

// The token at the caret that opens a menu: "/name" as the first word, or "@path" after a space or at the start.
export function trigger(text, caret) {
  const before = text.slice(0, caret);
  const slash = before.match(/^\/([\w.:-]*)$/);
  if (slash) return { kind: 'slash', query: slash[1], start: 0 };
  const at = before.match(/(?:^|\s)@((?:[^\s\\]|\\ )*)$/);
  if (at) return { kind: 'mention', query: at[1].replace(/\\ /g, ' '), start: caret - at[1].length - 1 };
  return null;
}

const rank = (list, q) => {
  q = q.toLowerCase();
  return list.filter(c => !q || c.name.toLowerCase().includes(q)).sort((a, b) => (b.name.toLowerCase().startsWith(q) ? 1 : 0) - (a.name.toLowerCase().startsWith(q) ? 1 : 0));
};

// Items for the open trigger. File commands load once per workspace; file searches run as the query changes.
export function useMenuItems(open, workspaceId) {
  const [commands, setCommands] = useState(null);
  const [files, setFiles] = useState([]);
  const kind = open?.kind, query = open?.query ?? '';
  useEffect(() => { setCommands(null); }, [workspaceId]);
  useEffect(() => {
    if (kind === 'slash' && !commands) call('commands:list', workspaceId).then(setCommands, () => setCommands([]));
  }, [kind, commands, workspaceId]);
  useEffect(() => {
    if (kind !== 'mention' || !workspaceId) return;
    let live = true;
    const timer = setTimeout(() => call('files:search', workspaceId, query).then(list => { if (live) setFiles(list); }, () => {}), 60);
    return () => { live = false; clearTimeout(timer); };
  }, [kind, query, workspaceId]);
  if (kind === 'slash') return [...rank(BUILTINS.map(c => ({ ...c, kind: 'builtin' })), query), ...rank(commands || [], query)].slice(0, 60);
  if (kind === 'mention') return files.map(p => ({ kind: p.endsWith('/') ? 'folder' : 'file', name: p }));
  return [];
}

const ICONS = { builtin: SquareSlash, command: TerminalSquare, skill: Sparkles, file: FileText, folder: Folder };
const SOURCE = { builtin: 'Hanobi', command: 'Command', skill: 'Skill' };

export function CommandMenu({ open, items, index, onPick, onHover }) {
  const list = useRef(null);
  useLayoutEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [index]);
  if (!open) return null;
  const empty = open.kind === 'mention' ? 'No matching files in this workspace.' : 'No matching commands.';
  return (
    <div className="popover cmd-menu" role="listbox" aria-label={open.kind === 'mention' ? 'Files' : 'Commands'} ref={list} onMouseDown={e => e.preventDefault()}>
      {!items.length ? <div className="cmd-empty">{empty}</div> : null}
      {items.map((item, i) => {
        const Icon = ICONS[item.kind];
        const path = item.kind === 'file' || item.kind === 'folder';
        const slash = path ? '' : '/';
        const cut = path ? item.name.replace(/\/$/, '').lastIndexOf('/') + 1 : 0;
        return (
          <button key={`${item.kind}:${item.name}:${item.source || ''}`} role="option" aria-selected={i === index} className={`cmd-item ${i === index ? 'active' : ''}`}
            onMouseEnter={() => onHover(i)} onClick={() => onPick(item)}>
            <Icon size={14} className="cmd-icon" />
            {path
              ? <span className="cmd-name"><span className="cmd-dir">{item.name.slice(0, cut)}</span>{item.name.slice(cut)}</span>
              : <span className="cmd-name">{slash}{item.name}{item.hint ? <span className="cmd-hint"> {item.hint}</span> : null}</span>}
            {item.description ? <span className="cmd-desc">{item.description}</span> : null}
            {!path ? <span className="cmd-source">{item.kind === 'builtin' ? SOURCE.builtin : `${SOURCE[item.kind]} · ${item.source}`}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
