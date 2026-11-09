import { createContext, useContext, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Eye, Copy, Check, Download, MoreHorizontal, ExternalLink, FolderOpen, Play, File, FileText, FileSpreadsheet, FileImage, FileCode, FileType } from 'lucide-react';
import { Menu, MenuItem } from './Menu.jsx';
import { call, toast } from '../store.js';

// The thread that file actions belong to. Main checks every path against this thread's folder and workspace.
export const ThreadContext = createContext(null);

const plugins = [remarkGfm];
// Markdown as HTML for Word and PDF files: rendered once into a detached element.
export function markdownHtml(text) {
  const element = document.createElement('div');
  const root = createRoot(element);
  flushSync(() => root.render(<Markdown remarkPlugins={plugins}>{text}</Markdown>));
  const html = element.innerHTML;
  root.unmount();
  return html;
}

const ext = name => (String(name).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
const KIND = { pdf: 'PDF', docx: 'Word', doc: 'Word', rtf: 'RTF', odt: 'OpenDocument', xlsx: 'Excel', csv: 'CSV', tsv: 'TSV', pptx: 'PowerPoint', md: 'Markdown', txt: 'Text', json: 'JSON', html: 'HTML', svg: 'SVG', png: 'PNG', jpg: 'JPEG', jpeg: 'JPEG', gif: 'GIF', webp: 'WebP' };
function fileIcon(name) {
  const e = ext(name);
  if (['xlsx', 'csv', 'tsv'].includes(e)) return FileSpreadsheet;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic'].includes(e)) return FileImage;
  if (['pdf', 'docx', 'doc', 'rtf', 'odt', 'pptx'].includes(e)) return FileType;
  if (['md', 'txt'].includes(e)) return FileText;
  return e && !KIND[e] ? FileCode : File;
}
export const formatSize = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function IconAction({ label, onClick, children }) {
  return <button className="icon-btn sm tip" data-tip={label} aria-label={label} onClick={e => { e.stopPropagation(); onClick(e); }}>{children}</button>;
}

// One file in a conversation: an attachment, a file the model made, or a file an agent wrote in the workspace.
export function FileCard({ file }) {
  const threadId = useContext(ThreadContext);
  const [copied, setCopied] = useState(false);
  const [menu, setMenu] = useState(null);
  const act = (channel, done) => () => call(channel, threadId, file.path).then(done, toast);
  const Icon = fileIcon(file.name);
  return (
    <div className="file-card" role="group" aria-label={file.name}>
      <button className="file-main" onClick={act('files:preview')} title="Preview">
        <span className="file-icon"><Icon size={18} /></span>
        <span className="file-text"><span className="file-name">{file.name}</span><span className="file-meta">{[KIND[ext(file.name)] || ext(file.name).toUpperCase() || 'File', file.size != null ? formatSize(file.size) : ''].filter(Boolean).join(' · ')}</span></span>
      </button>
      <span className="file-actions">
        <IconAction label="Preview" onClick={act('files:preview')}><Eye size={14} /></IconAction>
        <IconAction label={copied ? 'Copied' : 'Copy'} onClick={act('files:copy', () => { toast(`${file.name} copied to the clipboard`); setCopied(true); setTimeout(() => setCopied(false), 1400); })}>{copied ? <Check size={14} /> : <Copy size={14} />}</IconAction>
        <IconAction label="Download" onClick={act('files:save-copy', saved => saved && toast(`Saved to ${saved}`))}><Download size={14} /></IconAction>
        <IconAction label="More" onClick={e => setMenu(e.currentTarget.getBoundingClientRect())}><MoreHorizontal size={14} /></IconAction>
      </span>
      {menu ? (
        <Menu anchor={menu} onClose={() => setMenu(null)} label={`Options for ${file.name}`}>
          {/^html?$/.test(ext(file.name)) ? <MenuItem icon={Play} onClick={() => { setMenu(null); act('files:run')(); }}>Run in a window</MenuItem> : null}
          <MenuItem icon={ExternalLink} onClick={() => { setMenu(null); act('files:open')(); }}>Open with default app</MenuItem>
          <MenuItem icon={FolderOpen} onClick={() => { setMenu(null); act('files:reveal')(); }}>Show in Finder</MenuItem>
        </Menu>
      ) : null}
    </div>
  );
}

// Paths that a CLI tool call wrote: Claude Code Write/Edit, Codex file changes, Copilot create/edit.
export function writtenPaths(part) {
  if (part.type !== 'tool' || part.status !== 'done' || !part.input) return [];
  const input = part.input;
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(part.name)) return [input.file_path || input.notebook_path].filter(Boolean);
  if (part.name === 'File change' && Array.isArray(input)) return input.filter(c => c?.kind !== 'delete').map(c => c?.path).filter(Boolean);
  if (/^(create|edit|write|write_file|str_replace_editor)$/i.test(part.name) && typeof input.path === 'string') return [input.path];
  return [];
}

// Cards for the files that a finished tool call wrote, when they still exist.
export function ToolFiles({ part }) {
  const threadId = useContext(ThreadContext);
  const paths = writtenPaths(part);
  const key = paths.join('\n');
  const [cards, setCards] = useState([]);
  useEffect(() => {
    if (!key || !threadId) return;
    let live = true;
    call('files:info', threadId, key.split('\n')).then(list => { if (live) setCards(list.filter(Boolean)); }, () => {});
    return () => { live = false; };
  }, [key, threadId]);
  return cards.length ? <div className="file-list">{cards.map(f => <FileCard key={f.path} file={f} />)}</div> : null;
}

// Saves text as a file through a save dialog. Rich formats get HTML.
export async function exportText({ name, text, html }) {
  try { const saved = await call('files:export', { name, text, html }); if (saved) toast(`Saved to ${saved}`); } catch (error) { toast(error); }
}

// The download menu of a whole reply: Markdown, Word, or PDF.
export function ExportMenu({ text, anchor, onClose }) {
  const base = (text.match(/^#+\s+(.+)$/m)?.[1] || 'Reply').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'Reply';
  const save = extension => () => { onClose(); exportText({ name: `${base}.${extension}`, text, html: extension === 'md' ? '' : markdownHtml(text) }); };
  return (
    <Menu anchor={anchor} onClose={onClose} label="Download reply">
      <MenuItem icon={FileText} onClick={save('md')}>Markdown (.md)</MenuItem>
      <MenuItem icon={FileType} onClick={save('docx')}>Word (.docx)</MenuItem>
      <MenuItem icon={FileType} onClick={save('pdf')}>PDF (.pdf)</MenuItem>
    </Menu>
  );
}

// Code fence languages to file extensions, for snippet downloads.
const EXTENSIONS = {
  javascript: 'js', js: 'js', jsx: 'jsx', typescript: 'ts', ts: 'ts', tsx: 'tsx', python: 'py', py: 'py', bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh', console: 'sh',
  json: 'json', jsonl: 'jsonl', html: 'html', css: 'css', scss: 'scss', csv: 'csv', tsv: 'tsv', markdown: 'md', md: 'md', yaml: 'yaml', yml: 'yml', toml: 'toml',
  sql: 'sql', go: 'go', rust: 'rs', rs: 'rs', java: 'java', kotlin: 'kt', swift: 'swift', c: 'c', cpp: 'cpp', 'c++': 'cpp', csharp: 'cs', cs: 'cs', ruby: 'rb', rb: 'rb',
  php: 'php', xml: 'xml', svg: 'svg', mermaid: 'mermaid', mmd: 'mermaid', text: 'txt', txt: 'txt', plaintext: 'txt', diff: 'diff', dockerfile: 'Dockerfile', makefile: 'Makefile', lua: 'lua', r: 'r', dart: 'dart'
};
export const LABELS = { html: 'HTML', css: 'CSS', json: 'JSON', csv: 'CSV', tsv: 'TSV', sql: 'SQL', svg: 'SVG', xml: 'XML', go: 'Go', js: 'JavaScript', jsx: 'JSX', ts: 'TypeScript', tsx: 'TSX', py: 'Python', sh: 'Shell', md: 'Markdown', rs: 'Rust', rb: 'Ruby', cs: 'C#', cpp: 'C++', kt: 'Kotlin', yml: 'YAML', yaml: 'YAML', txt: 'Text', mermaid: 'Mermaid' };

// The file name for a snippet: a name in the fence info (```python app.py or title="app.py"), else snippet.<ext>.
export function snippetName(language, meta = '') {
  const named = meta.match(/(?:title|file(?:name)?)=["']?([^"'\s]+)/)?.[1] || meta.split(/\s+/).find(t => /^[\w.\-/]+\.[a-z0-9]+$/i.test(t));
  if (named) return named.split('/').pop();
  const extension = EXTENSIONS[language?.toLowerCase()] || (language && /^[a-z0-9]{1,8}$/i.test(language) ? language.toLowerCase() : 'txt');
  return /^[A-Z]/.test(extension) ? extension : `snippet.${extension}`;
}

// A small CSV/TSV parser for previews: quotes, escaped quotes, and new lines in quotes.
export function parseTable(text, separator = ',') {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c; }
    else if (c === '"' && !cell) quoted = true;
    else if (c === separator) { row.push(cell); cell = ''; }
    else if (c === '\n' || (c === '\r' && text[i + 1] !== '\n')) { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function SnippetPreview({ kind, text }) {
  // Scripts stay off here, inside Orin's window. Run opens the page with scripts in its own window.
  if (kind === 'html') return <iframe className="snippet-frame" sandbox="" srcDoc={text} title="HTML preview" />;
  if (kind === 'svg') return <div className="snippet-image"><img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`} alt="SVG preview" /></div>;
  if (kind === 'mermaid') return <MermaidPreview text={text} />;
  if (kind === 'md') return <div className="prose snippet-prose"><Markdown remarkPlugins={plugins}>{text}</Markdown></div>;
  const rows = parseTable(text.trim(), kind === 'tsv' ? '\t' : ',').slice(0, 201);
  const [head, ...body] = rows;
  return (
    <div className="snippet-table"><table>
      <thead><tr>{(head || []).map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
      <tbody>{body.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
    </table>{rows.length > 200 ? <div className="muted pad">First 200 rows.</div> : null}</div>
  );
}

// Mermaid diagrams render in Orin's own page with mermaid's strict mode (no scripts, no click handlers, sanitized
// labels). The library loads on the first diagram, so it does not weigh on startup. While a reply streams, the last
// diagram that parsed stays on screen.
const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');
let mermaidLoad = null, mermaidCount = 0;
function MermaidPreview({ text }) {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const [dark, setDark] = useState(darkScheme.matches);
  useEffect(() => { const on = e => setDark(e.matches); darkScheme.addEventListener('change', on); return () => darkScheme.removeEventListener('change', on); }, []);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const mermaid = (await (mermaidLoad ||= import('mermaid'))).default;
        // Colors come from the app theme, so diagrams match every palette in light and dark.
        const css = getComputedStyle(document.documentElement), v = name => css.getPropertyValue(name).trim();
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', darkMode: dark, fontFamily: getComputedStyle(document.body).fontFamily,
          themeVariables: { background: v('--surface'), primaryColor: v('--raised'), primaryTextColor: v('--text'), primaryBorderColor: v('--border-strong'), secondaryColor: v('--user'), tertiaryColor: v('--surface'), lineColor: v('--text-3'), textColor: v('--text'), mainBkg: v('--raised'), nodeBorder: v('--border-strong'), clusterBkg: v('--surface'), edgeLabelBackground: v('--surface') } });
        const { svg } = await mermaid.render(`orin-mermaid-${++mermaidCount}`, text);
        if (live) { setSvg(svg); setError(''); }
      } catch (e) { if (live) setError(String(e?.message || e).split('\n')[0]); }
    }, 200);
    return () => { live = false; clearTimeout(timer); };
  }, [text, dark]);
  return (
    <div className="snippet-image mermaid-preview">
      {svg ? <div className="mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} /> : null}
      {error && !svg ? <div className="muted pad">This diagram does not parse: {error}</div> : !svg ? <div className="muted pad">Drawing the diagram…</div> : null}
    </div>
  );
}

export const previewKind = name => ({ html: 'html', htm: 'html', svg: 'svg', md: 'md', csv: 'csv', tsv: 'tsv', mermaid: 'mermaid', mmd: 'mermaid' })[ext(name)] || null;
