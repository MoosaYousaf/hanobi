const { execFile } = require('node:child_process');
const { cliPath } = require('./providers/cli');
const { root, status } = require('./git');

// Pull requests through the GitHub CLI (gh). gh keeps the sign-in, so Hanobi stores no GitHub token.
const FIELDS = 'number,title,url,state,isDraft,reviewDecision,headRefName,baseRefName,author,updatedAt';

function gh(cwd, args, { input, timeout = 60000 } = {}) {
  const executable = cliPath('gh');
  if (!executable) return Promise.reject(Object.assign(new Error('Install the GitHub CLI (gh) and run "gh auth login" to use pull requests.'), { code: 'NO_GH' }));
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' } }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || stdout || error.message).trim()));
      else resolve(stdout);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

// statusCheckRollup mixes check runs (status + conclusion) and commit statuses (state).
function checks(rollup = []) {
  const count = { passed: 0, failed: 0, pending: 0 };
  for (const c of rollup) {
    const result = c.__typename === 'StatusContext' ? c.state : c.status === 'COMPLETED' ? c.conclusion : 'PENDING';
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(result)) count.passed++;
    else if (['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED'].includes(result)) count.pending++;
    else count.failed++;
  }
  return count;
}

const shape = pr => ({ number: pr.number, title: pr.title, url: pr.url, state: pr.state, draft: !!pr.isDraft, review: pr.reviewDecision || null,
  head: pr.headRefName, base: pr.baseRefName, author: pr.author?.login || null, updatedAt: pr.updatedAt, ...(pr.statusCheckRollup ? { checks: checks(pr.statusCheckRollup) } : {}) });

// The pull request of the current branch, or null. gh fails with "no pull requests found" when there is none.
async function current(cwd) {
  const top = await root(cwd);
  try { return shape(JSON.parse(await gh(top, ['pr', 'view', '--json', `${FIELDS},statusCheckRollup`]))); } catch (error) {
    if (/no (open )?pull requests? found/i.test(error.message)) return null;
    throw error;
  }
}

async function list(cwd) {
  return JSON.parse(await gh(await root(cwd), ['pr', 'list', '--state', 'open', '--limit', '30', '--json', FIELDS])).map(shape);
}

async function defaultBranch(cwd) {
  return JSON.parse(await gh(await root(cwd), ['repo', 'view', '--json', 'defaultBranchRef'])).defaultBranchRef?.name || 'main';
}

// The body goes through stdin, like CLI prompts, so its text is never parsed as an option.
async function create(cwd, { title, body = '', base, draft = false }) {
  title = String(title || '').trim();
  if (!title) throw new Error('Enter a title for the pull request.');
  const top = await root(cwd);
  const { branch, detached, upstream, ahead } = await status(top);
  if (detached) throw new Error('Check out a branch before you open a pull request.');
  if (!upstream || ahead) throw new Error('Push the branch before you open a pull request.');
  const args = ['pr', 'create', '--title', title, '--body-file', '-', '--head', branch, ...(base ? ['--base', base] : []), ...(draft ? ['--draft'] : [])];
  const out = await gh(top, args, { input: String(body), timeout: 120000 });
  return out.trim().split('\n').pop();
}

async function checkout(cwd, number) {
  if (!Number.isInteger(number) || number < 1) throw new Error('Invalid pull request number.');
  return gh(await root(cwd), ['pr', 'checkout', String(number)], { timeout: 120000 });
}

module.exports = { gh, checks, shape, current, list, defaultBranch, create, checkout };
