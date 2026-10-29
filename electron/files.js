const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { cachedText } = require('./extract');

// Files that go in and out of conversations. Each thread has a folder under <userData>/Files/<thread id>/:
// in/ holds attachments (copies, so a moved original does not break the chat) and out/ holds files the model made.
// Word, RTF, and OpenDocument files are made from HTML with textutil; PDF through printPdf (Electron's printer).
const MAX_FILE = 50 * 1024 * 1024;
const PROMPT_BUDGET = 200000; // characters of attachment text per message
const TEXT_OUT = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|xml|svg|css|js|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|sql|ini|cfg|log|tex|rst|org)$/i;
const RICH_OUT = /\.(docx|rtf|odt|pdf|html?)$/i;
const MEDIA = {
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv', tsv: 'text/tab-separated-values', md: 'text/markdown', txt: 'text/plain', json: 'application/json', html: 'text/html', htm: 'text/html',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', rtf: 'application/rtf', odt: 'application/vnd.oasis.opendocument.text'
};
const IMAGE = /^image\/(png|jpeg|gif|webp)$/;
const mediaType = name => MEDIA[path.extname(name).slice(1).toLowerCase()] || 'application/octet-stream';

// A plain file name: no folders, no control characters, no leading dot.
function safeName(name) {
  const base = path.basename(String(name || '')).replace(/[\u0000-\u001f/\\:]/g, '').replace(/^\.+/, '').trim().slice(0, 120);
  if (!base) throw new Error('Give the file a name.');
  return base;
}

async function unique(dir, name) {
  const { name: stem, ext } = path.parse(name);
  let target = name;
  for (let n = 2; await fs.access(path.join(dir, target)).then(() => true, () => false); n++) target = `${stem} ${n}${ext}`;
  return path.join(dir, target);
}

const escape = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Models are told to give HTML for rich files. Plain text or simple Markdown still becomes readable HTML.
function toHtml(content) {
  if (/<\/?(p|h[1-6]|ul|ol|table|div|br|pre|strong|em|body|html)\b/i.test(content)) return content;
  const inline = s => escape(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>').replace(/`([^`]+)`/g, '<code>$1</code>');
  return content.split(/\n{2,}/).map(block => {
    const heading = block.match(/^(#{1,6})\s+(.*)$/);
    if (heading) return `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`;
    if (block.split('\n').every(l => /^\s*[-*]\s+/.test(l))) return `<ul>${block.split('\n').map(l => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
    if (/^```/.test(block)) return `<pre>${escape(block.replace(/^```.*\n?|```$/g, ''))}</pre>`;
    return `<p>${block.split('\n').map(inline).join('<br>')}</p>`;
  }).join('\n');
}

const STYLE = `body { font: 11pt/1.5 -apple-system, "Helvetica Neue", Helvetica, sans-serif; color: #1a1a1a; margin: 0; }
h1, h2, h3 { line-height: 1.25; } pre, code { font-family: Menlo, monospace; font-size: 9.5pt; }
pre { white-space: pre-wrap; background: #f4f4f4; padding: 8px 10px; border-radius: 4px; }
table { border-collapse: collapse; } th, td { border: 1px solid #c8c8c8; padding: 4px 8px; text-align: left; } th { background: #f4f4f4; }
img { max-width: 100%; }`;
function htmlDocument(content, title = '') {
  const html = toHtml(String(content));
  if (/<html[\s>]/i.test(html)) return html;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title><style>${STYLE}</style></head><body>${html}</body></html>`;
}

function textutil(html, target) {
  const format = path.extname(target).slice(1).toLowerCase();
  return new Promise((resolve, reject) => {
    const child = execFile('textutil', ['-stdin', '-format', 'html', '-convert', format, '-output', target], { timeout: 60000 }, error => error ? reject(new Error(error.message)) : resolve());
    child.stdin.end(html);
  });
}

class Files {
  constructor(root, { printPdf } = {}) { this.root = root; this.printPdf = printPdf; }

  dir(threadId, kind) {
    if (!/^[\w-]+$/.test(String(threadId))) throw new Error('Invalid conversation.');
    return path.join(this.root, threadId, kind);
  }

  async part(file) {
    const { size } = await fs.stat(file);
    return { type: 'file', name: path.basename(file), path: file, size, mediaType: mediaType(file) };
  }

  // Copies files the user picked or dropped. Each attachment gets its own folder, so names never collide with old ones.
  async attach(threadId, sources) {
    const parts = [];
    for (const source of sources) {
      const stat = await fs.stat(source);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE) throw new Error(`${path.basename(source)} is larger than 50 MB.`);
      const dir = path.join(this.dir(threadId, 'in'), crypto.randomUUID());
      await fs.mkdir(dir, { recursive: true });
      const target = path.join(dir, safeName(path.basename(source)));
      await fs.copyFile(source, target);
      parts.push(await this.part(target));
    }
    return parts;
  }

  // A pasted file has no path, only its bytes.
  async attachData(threadId, { name, data }) {
    const bytes = Buffer.from(String(data || ''), 'base64');
    if (bytes.length > MAX_FILE) throw new Error(`${name} is larger than 50 MB.`);
    const dir = path.join(this.dir(threadId, 'in'), crypto.randomUUID());
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, safeName(name));
    await fs.writeFile(target, bytes);
    return this.part(target);
  }

  // Writes a file in the format its extension names. Rich formats take HTML (or simple Markdown).
  async render(target, content) {
    const name = path.basename(target);
    if (TEXT_OUT.test(name)) return fs.writeFile(target, String(content));
    if (/\.html?$/i.test(name)) return fs.writeFile(target, htmlDocument(content, name));
    if (/\.pdf$/i.test(name)) {
      if (!this.printPdf) throw new Error('PDF output is not available.');
      return fs.writeFile(target, await this.printPdf(htmlDocument(content, name)));
    }
    if (RICH_OUT.test(name)) return textutil(htmlDocument(content, name), target);
    throw new Error(`Hanobi cannot make ${path.extname(name) || 'files without an extension'}. Use a text format, .html, .docx, .rtf, .odt, or .pdf.`);
  }

  async write(threadId, name, content) {
    name = safeName(name);
    if (String(content ?? '').length > MAX_FILE) throw new Error('The file is too large.');
    const dir = this.dir(threadId, 'out');
    await fs.mkdir(dir, { recursive: true });
    const target = await unique(dir, name);
    await this.render(target, content ?? '');
    return this.part(target);
  }

  // A path the renderer may act on: inside this thread's folder or inside its workspace. Relative paths are workspace paths.
  async resolve(threadId, workspacePath, file) {
    if (typeof file !== 'string' || !file) throw new Error('File required.');
    const full = await fs.realpath(path.resolve(workspacePath, file)).catch(() => { throw new Error(`${path.basename(file)} no longer exists.`); });
    const roots = await Promise.all([this.dir(threadId, ''), workspacePath].map(r => fs.realpath(r).catch(() => null)));
    if (!roots.some(r => r && (full === r || full.startsWith(r + path.sep)))) throw new Error('Hanobi only opens files from this conversation and its workspace.');
    const stat = await fs.stat(full);
    if (!stat.isFile()) throw new Error('Not a file.');
    return full;
  }

  // Text of the attachments in a list of messages, keyed by path. Images are left out: they go to the model as images.
  async promptTexts(messages) {
    const texts = new Map();
    for (const part of messages.flatMap(m => m.parts || [])) {
      if (part.type !== 'file' || texts.has(part.path) || /^image\//.test(part.mediaType)) continue;
      texts.set(part.path, await cachedText(path.dirname(part.path), part.name).catch(() => null));
    }
    return texts;
  }

  async remove(threadId) { await fs.rm(this.dir(threadId, ''), { recursive: true, force: true }); }
}

// The attachment block of one user message, for prompts. Text that does not fit is cut; files without text are listed.
function attachmentBlock(parts, texts, { paths = false } = {}) {
  let budget = PROMPT_BUDGET;
  const blocks = [];
  // API models get images as image blocks, so only CLI prompts (paths) list them here.
  for (const part of parts.filter(p => p.type === 'file' && (paths || !IMAGE.test(p.mediaType)))) {
    const text = texts.get(part.path);
    const where = paths ? ` path="${part.path}"` : '';
    if (text?.trim() && budget > 0) {
      const clipped = text.slice(0, budget);
      budget -= clipped.length;
      blocks.push(`<attachment name="${part.name}"${where}>\n${clipped}${clipped.length < text.length ? '\n[…cut]' : ''}\n</attachment>`);
    } else blocks.push(`<attachment name="${part.name}"${where} type="${part.mediaType}">${/^image\//.test(part.mediaType) && paths ? 'An image. Open it from its path.' : 'No text could be read from this file.'}</attachment>`);
  }
  return blocks.join('\n\n');
}

module.exports = { IMAGE, Files, attachmentBlock, htmlDocument, toHtml, safeName, mediaType };
