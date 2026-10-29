const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 15000 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || stdout || error.message).trim()));
      else resolve(stdout);
    });
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

module.exports = { status, diff, stage, commit, parseStatus, githubUrl };
