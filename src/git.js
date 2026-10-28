const { spawnSync } = require('node:child_process');
function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 15000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Git command failed.').trim());
  return result.stdout;
}
function status(cwd) {
  try {
    const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
    const branch = git(cwd, ['branch', '--show-current']).trim() || 'detached HEAD';
    const lines = git(cwd, ['status', '--porcelain=v1', '-uall']).split('\n').filter(Boolean);
    let remote = null;
    try { const url = git(cwd, ['remote', 'get-url', 'origin']).trim(); const match = url.match(/(?:github\.com[:/])([^/]+)\/([^/]+?)(?:\.git)?$/); if (match) remote = `https://github.com/${match[1]}/${match[2]}`; } catch {}
    return { root, branch, remote, files: lines.map(line => ({ staged: line[0] !== ' ' && line[0] !== '?', changed: line[1] !== ' ', untracked: line.slice(0, 2) === '??', path: line.slice(3) })) };
  } catch (error) { return { error: error.message, files: [] }; }
}
function diff(cwd, file, staged) {
  if (typeof file !== 'string') throw new Error('File required.');
  const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const full = require('node:path').resolve(root, file);
  if (full !== root && !full.startsWith(root + require('node:path').sep)) throw new Error('Invalid path.');
  if (!staged && status(cwd).files.some(f => f.path === file && f.untracked)) return '+ ' + require('node:fs').readFileSync(full, 'utf8').slice(0, 200000).replace(/\n/g, '\n+ ');
  return git(cwd, ['diff', ...(staged ? ['--cached'] : []), '--', file]).slice(0, 200000);
}
function stage(cwd, file, staged) {
  if (typeof file !== 'string' || !status(cwd).files.some(f => f.path === file)) throw new Error('File not in change list.');
  if (staged) {
    try { git(cwd, ['rev-parse', '--verify', 'HEAD']); git(cwd, ['restore', '--staged', '--', file]); }
    catch { git(cwd, ['rm', '--cached', '--', file]); }
  } else git(cwd, ['add', '--', file]);
}
function commit(cwd, message) {
  message = String(message || '').trim();
  if (!message) throw new Error('Enter a commit message.');
  return git(cwd, ['commit', '-m', message]).trim();
}
module.exports = { status, diff, stage, commit };
