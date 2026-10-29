const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function git(cwd, args, { env, input, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout, env: env && { ...process.env, ...env } }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || stdout || error.message).trim()));
      else resolve(stdout);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}
const root = async cwd => (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();

// Porcelain v2 with -z: one call returns the branch and every entry, with unquoted root-relative paths.
function parseStatus(output) {
  const tokens = output.split('\0');
  let branch = 'detached HEAD';
  const files = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith('# branch.head ')) { const name = token.slice(14); if (name !== '(detached)') branch = name; }
    else if (token.startsWith('? ')) files.push({ path: token.slice(2), staged: false, changed: true, untracked: true });
    else if (token[0] === '1' || token[0] === '2') {
      const fields = token.split(' ');
      const xy = fields[1];
      const file = fields.slice(token[0] === '1' ? 8 : 9).join(' ');
      if (token[0] === '2') i++; // the next token is the original path of the rename
      files.push({ path: file, staged: xy[0] !== '.', changed: xy[1] !== '.', untracked: false });
    } else if (token[0] === 'u') files.push({ path: token.split(' ').slice(10).join(' '), staged: false, changed: true, untracked: false, conflict: true });
  }
  return { branch, files };
}

function githubUrl(url) {
  const match = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return match ? `https://github.com/${match[1]}/${match[2]}` : null;
}

async function status(cwd) {
  try {
    const top = await root(cwd);
    const [porcelain, remote] = await Promise.all([
      git(top, ['status', '--porcelain=v2', '--branch', '-z', '-uall']),
      git(top, ['remote', 'get-url', 'origin']).then(url => githubUrl(url.trim()), () => null)
    ]);
    return { root: top, remote, ...parseStatus(porcelain) };
  } catch (error) { return { error: error.message, files: [] }; }
}

async function inside(cwd, file) {
  if (typeof file !== 'string' || !file) throw new Error('File required.');
  const top = await root(cwd);
  const full = path.resolve(top, file);
  if (!full.startsWith(top + path.sep)) throw new Error('Invalid path.');
  return { top, full };
}

async function diff(cwd, file, { staged, untracked }) {
  const { top, full } = await inside(cwd, file);
  if (untracked) return '+' + (await fs.readFile(full, 'utf8')).slice(0, 200000).replace(/\n/g, '\n+');
  return (await git(top, ['diff', ...(staged ? ['--cached'] : []), '--', file])).slice(0, 200000);
}

async function stage(cwd, file, unstage) {
  const { top } = await inside(cwd, file);
  if (!unstage) return git(top, ['add', '--', file]);
  const hasHead = await git(top, ['rev-parse', '--verify', 'HEAD']).then(() => true, () => false);
  return git(top, hasHead ? ['restore', '--staged', '--', file] : ['rm', '--cached', '--', file]);
}

async function commit(cwd, message) {
  message = String(message || '').trim();
  if (!message) throw new Error('Enter a commit message.');
  return (await git(await root(cwd), ['commit', '-m', message])).trim();
}

// Checkpoints use a private index file, so the user's index, branches, and stash never change.
// A checkpoint is a tree of every tracked and untracked file that .gitignore does not exclude.
// Git keeps unreferenced trees for at least two weeks (gc.pruneExpire), so older checkpoints can be gone.
async function withIndex(top, fn) {
  const index = path.join(os.tmpdir(), `hanobi-index-${crypto.randomUUID()}`);
  try { return await fn({ GIT_INDEX_FILE: index }); } finally { await fs.rm(index, { force: true }); }
}

async function snapshot(cwd) {
  const top = await root(cwd);
  const scope = path.relative(top, await fs.realpath(cwd)) || '.';
  const tree = await withIndex(top, async env => {
    // Starting from a copy of the real index lets git reuse its file stat cache. The copy keeps the index's own
    // modification time: git rechecks files changed in the same second as the index only by comparing it to that time.
    const real = path.resolve(top, (await git(top, ['rev-parse', '--git-path', 'index'])).trim());
    await fs.copyFile(real, env.GIT_INDEX_FILE).then(async () => { const { atime, mtime } = await fs.stat(real); await fs.utimes(env.GIT_INDEX_FILE, atime, mtime); }).catch(() => {});
    await git(top, ['add', '-A'], { env, timeout: 120000 });
    return (await git(top, ['write-tree'], { env })).trim();
  });
  return { root: top, scope, tree };
}

// Makes the workspace folder match a checkpoint: changed files return, files created after it are deleted.
// Only the workspace folder changes, even when the repository is larger. Ignored files stay as they are.
async function restore(cwd, checkpoint) {
  const current = await snapshot(cwd);
  if (current.root !== checkpoint.root) throw new Error('This checkpoint belongs to another repository.');
  const top = current.root;
  await git(top, ['cat-file', '-e', `${checkpoint.tree}^{tree}`]).catch(() => { throw new Error('This checkpoint is no longer in the repository.'); });
  const fields = (await git(top, ['diff-tree', '-r', '-z', '--no-renames', '--name-status', current.tree, checkpoint.tree, '--', checkpoint.scope || '.'])).split('\0').filter(Boolean);
  const removed = [], restored = [];
  for (let i = 0; i < fields.length; i += 2) (fields[i] === 'D' ? removed : restored).push(fields[i + 1]);
  for (const file of removed) await fs.rm(path.join(top, file), { force: true });
  if (restored.length) await withIndex(top, async env => {
    await git(top, ['read-tree', checkpoint.tree], { env });
    await git(top, ['checkout-index', '-f', '-z', '--stdin'], { env, input: restored.join('\0'), timeout: 120000 });
  });
  return { restored, removed };
}

module.exports = { status, diff, stage, commit, snapshot, restore, parseStatus, githubUrl };
