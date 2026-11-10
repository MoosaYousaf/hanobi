const fs = require('node:fs');
const path = require('node:path');
const { cachedText } = require('./extract');

// A project is a chat workspace in an app-owned folder: instructions, a knowledge/ folder of documents, and its own chats.
// CLI agents run in that folder with the thread's access mode (Ask first by default). They read the instructions from CLAUDE.md, AGENTS.md, and GEMINI.md,
// and open the documents themselves. API and local models get the instructions and the document text in the system prompt.
// PDF, Word, RTF, OpenDocument, PowerPoint, and Excel documents are converted to text by extract.js.
const CONTEXT_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'];
const MAX_FILE = 50 * 1024 * 1024;
const PROMPT_BUDGET = 400000; // characters of document text for API models

const knowledge = project => path.join(project.path, 'knowledge');

function contextText(project) {
  return [
    `# Project: ${project.name}`,
    project.instructions?.trim() || '',
    'Reference documents for this project are in the knowledge/ folder. Read the ones that are relevant to the request before you answer.'
  ].filter(Boolean).join('\n\n') + '\n';
}

function writeContext(project) {
  fs.mkdirSync(knowledge(project), { recursive: true });
  for (const name of CONTEXT_FILES) fs.writeFileSync(path.join(project.path, name), contextText(project));
}

function files(project) {
  try {
    return fs.readdirSync(knowledge(project), { withFileTypes: true }).filter(e => e.isFile() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, size: fs.statSync(path.join(knowledge(project), e.name)).size })).sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; }
}

// Copies documents in. A name that exists gets a number, so an upload never replaces a document.
function addFiles(project, sources) {
  fs.mkdirSync(knowledge(project), { recursive: true });
  const added = [];
  for (const source of sources) {
    const stat = fs.statSync(source);
    if (!stat.isFile()) continue;
    if (stat.size > MAX_FILE) throw new Error(`${path.basename(source)} is larger than 50 MB.`);
    const { name, ext } = path.parse(path.basename(source));
    let target = `${name}${ext}`;
    for (let n = 2; fs.existsSync(path.join(knowledge(project), target)); n++) target = `${name} ${n}${ext}`;
    fs.copyFileSync(source, path.join(knowledge(project), target));
    added.push(target);
  }
  return added;
}

function removeFile(project, name) {
  if (typeof name !== 'string' || name !== path.basename(name) || name.startsWith('.')) throw new Error('Invalid file name.');
  fs.rmSync(path.join(knowledge(project), name), { force: true });
  fs.rmSync(path.join(knowledge(project), '.text', `${name}.txt`), { force: true });
}

// Converts new documents in the background, so the first API run does not wait for them.
function warm(project, names) {
  for (const name of names) cachedText(knowledge(project), name).catch(() => {});
}

// The system prompt part for API and local models. Documents without text (images, scans, unknown types) are listed by name only.
async function apiContext(project) {
  const parts = [contextText(project).replace('Read the ones that are relevant to the request before you answer.', 'Their text follows.')];
  let budget = PROMPT_BUDGET;
  const other = [];
  for (const file of files(project)) {
    const text = budget > 0 ? (await cachedText(knowledge(project), file.name).catch(() => null))?.slice(0, budget) : null;
    if (!text?.trim()) { other.push(file.name); continue; }
    budget -= text.length;
    parts.push(`<document name="${file.name}">\n${text}\n</document>`);
  }
  if (other.length) parts.push(`These documents are in the project but not included as text: ${other.join(', ')}. CLI agents can open them.`);
  return parts.join('\n\n');
}

module.exports = { writeContext, files, addFiles, removeFile, warm, apiContext, contextText };
