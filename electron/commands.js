const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { skills } = require('./skills');
const { mediaType } = require('./files');

// Slash commands that come from files: custom commands (Markdown prompt templates) and skills.
// Claude Code runs its own commands and skills when the prompt starts with /name. Every other model gets the
// command text expanded into the prompt, so the same /name works with every provider.
const NAME = /^[\w][\w.:-]{0,80}$/;
const frontmatter = text => {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const field = key => match?.[1].match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.replace(/^["']|["']$/g, '').trim() || '';
  return { description: field('description'), hint: field('argument-hint'), body: match ? text.slice(match[0].length) : text };
};

async function customCommands(cwd) {
  const home = process.env.HOME || '';
  const locations = [
    ['Claude', path.join(home, '.claude/commands'), true], ['Codex', path.join(home, '.codex/prompts'), false],
    ...(cwd ? [['Workspace', path.join(cwd, '.claude/commands'), true]] : [])
  ];
  const found = await Promise.all(locations.map(async ([source, folder, claude]) => {
    const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
    return Promise.all(entries.filter(e => e.isFile() && e.name.endsWith('.md')).map(async e => {
      const file = path.join(folder, e.name);
      const { description, hint } = frontmatter(await fs.readFile(file, 'utf8').catch(() => ''));
      return { kind: 'command', name: e.name.slice(0, -3), description, hint, source, claude, path: file };
    }));
  }));
  return found.flat().filter(c => NAME.test(c.name));
}

// Every file command for a workspace. Skills in Claude locations are native to Claude Code.
async function list(cwd) {
  const [commands, found] = await Promise.all([customCommands(cwd), skills(cwd)]);
  const skillList = found.filter(s => NAME.test(s.name)).map(s => ({ kind: 'skill', name: s.name, description: s.description, hint: '', source: s.source, claude: s.path.includes(`${path.sep}.claude${path.sep}`), path: s.path }));
  // The first of two commands with one name wins: workspace files over home files, as in Claude Code.
  const seen = new Set();
  return [...commands.filter(c => c.source === 'Workspace'), ...commands.filter(c => c.source !== 'Workspace'), ...skillList]
    .filter(c => !seen.has(c.name) && seen.add(c.name));
}

// The prompt that a /name message sends. Returns null when the text is not a file command, or when the CLI
// runs that command itself (Claude Code with a Claude command or skill).
async function expand(text, cwd, cli) {
  const match = String(text).match(/^\/([\w][\w.:-]{0,80})(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const command = (await list(cwd)).find(c => c.name === match[1]);
  if (!command || (cli === 'claude' && command.claude)) return null;
  const args = (match[2] || '').trim();
  if (command.kind === 'skill') {
    const { body } = frontmatter(await fs.readFile(path.join(command.path, 'SKILL.md'), 'utf8'));
    return `Use the "${command.name}" skill for this request. Its instructions follow; files it names are in ${command.path}.\n\n<skill name="${command.name}">\n${body.trim()}\n</skill>${args ? `\n\n${args}` : ''}`;
  }
  const { body } = frontmatter(await fs.readFile(command.path, 'utf8'));
  const words = args.split(/\s+/).filter(Boolean);
  const filled = body.replace(/\$ARGUMENTS/g, args).replace(/\$(\d)/g, (_, n) => words[n - 1] ?? '').trim();
  return /\$(ARGUMENTS|\d)/.test(body) || !args ? filled : `${filled}\n\n${args}`;
}

// Workspace files for @ mentions. Git repositories list tracked and untracked files that are not ignored;
// other folders are walked without dependency and build folders. Lists are cached for a few seconds.
const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', '.text', '.DS_Store']);
const MAX_LIST = 20000;
const cache = new Map(); // cwd -> { at, files }
function gitFiles(cwd) {
  return new Promise(resolve => execFile('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 10000 },
    (error, out) => resolve(error ? null : out.split('\0').filter(Boolean).slice(0, MAX_LIST))));
}
async function walk(root) {
  const files = [];
  const queue = [''];
  while (queue.length && files.length < MAX_LIST) {
    const dir = queue.shift();
    const entries = await fs.readdir(path.join(root, dir), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) queue.push(rel); else if (e.isFile()) files.push(rel);
    }
  }
  return files;
}
async function workspaceFiles(cwd) {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < 5000) return hit.files;
  const files = (await gitFiles(cwd)) || await walk(cwd);
  cache.set(cwd, { at: Date.now(), files });
  return files;
}
// Folders are listed too, so @src/ works. Name matches rank first, then path matches, then shorter paths.
async function searchFiles(cwd, query, limit = 40) {
  const files = await workspaceFiles(cwd);
  const folders = [...new Set(files.flatMap(f => f.split('/').slice(0, -1).map((_, i, all) => all.slice(0, i + 1).join('/') + '/')))];
  const q = String(query || '').toLowerCase();
  const score = p => {
    const lower = p.toLowerCase(), name = path.posix.basename(p.replace(/\/$/, '')).toLowerCase();
    if (!q) return p.split('/').length * 100 + p.length;
    if (name.startsWith(q)) return p.length;
    if (name.includes(q)) return 1000 + p.length;
    if (lower.includes(q)) return 2000 + p.length;
    return -1;
  };
  return [...folders, ...files].map(p => [p, score(p)]).filter(([, s]) => s >= 0).sort((a, b) => a[1] - b[1]).slice(0, limit).map(([p]) => p);
}

// @path mentions in a message: real files inside the workspace become file parts (mention: true), so their text
// goes to the model with the message. Folders and missing paths stay plain text for the agent.
const MAX_MENTIONS = 10;
function mentions(text, cwd) {
  const root = (() => { try { return fsSync.realpathSync(cwd); } catch { return null; } })();
  if (!root) return [];
  const parts = [];
  for (const [, ref] of String(text).matchAll(/(?:^|\s)@((?:[^\s\\]|\\ )+)/g)) {
    const rel = ref.replace(/\\ /g, ' ').replace(/[.,;:!?)]+$/, '');
    try {
      const full = fsSync.realpathSync(path.resolve(root, rel));
      if (!full.startsWith(root + path.sep) || parts.some(p => p.path === full)) continue;
      const stat = fsSync.statSync(full);
      if (stat.isFile()) parts.push({ type: 'file', name: path.basename(full), path: full, size: stat.size, mediaType: mediaType(full), mention: true });
    } catch {}
    if (parts.length >= MAX_MENTIONS) break;
  }
  return parts;
}

module.exports = { list, expand, searchFiles, mentions };
