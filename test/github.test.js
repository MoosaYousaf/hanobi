const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const git = require('../electron/git');
const github = require('../electron/github');
const { cliPath } = require('../electron/providers/cli');

const tmp = prefix => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const run = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };

test('branches: switch, create, publish, push, and pull with ahead and behind counts', async () => {
  const remote = tmp('hanobi-remote-'), a = tmp('hanobi-a-'), b = tmp('hanobi-b-');
  try {
    run(remote, 'init', '-q', '--bare', '-b', 'main');
    for (const dir of [a]) { run(dir, 'init', '-q', '-b', 'main'); run(dir, 'config', 'user.email', 't@example.com'); run(dir, 'config', 'user.name', 'T'); run(dir, 'remote', 'add', 'origin', remote); }
    fs.writeFileSync(path.join(a, 'one.txt'), '1\n'); run(a, 'add', '.'); run(a, 'commit', '-qm', 'one');
    let status = await git.status(a);
    assert.deepEqual([status.branch, status.upstream, status.ahead], ['main', null, 0]);
    await git.push(a); // publishes and sets the upstream
    status = await git.status(a);
    assert.deepEqual([status.upstream, status.ahead, status.behind], ['origin/main', 0, 0]);
    fs.writeFileSync(path.join(a, 'two.txt'), '2\n'); run(a, 'add', '.'); run(a, 'commit', '-qm', 'two');
    assert.equal((await git.status(a)).ahead, 1);
    await git.push(a);
    assert.equal((await git.status(a)).ahead, 0);
    // A second clone pushes; the first one is then behind and pulls.
    fs.rmSync(b, { recursive: true }); spawnSync('git', ['clone', '-q', remote, b]);
    run(b, 'config', 'user.email', 't@example.com'); run(b, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(b, 'three.txt'), '3\n'); run(b, 'add', '.'); run(b, 'commit', '-qm', 'three'); run(b, 'push', '-q');
    run(a, 'fetch', '-q');
    assert.equal((await git.status(a)).behind, 1);
    await git.pull(a);
    assert.ok(fs.existsSync(path.join(a, 'three.txt')));
    await git.checkout(a, 'feature/x', true);
    assert.equal((await git.status(a)).branch, 'feature/x');
    assert.deepEqual((await git.branches(a)).sort(), ['feature/x', 'main']);
    await git.checkout(a, 'main');
    assert.equal((await git.status(a)).branch, 'main');
    await assert.rejects(git.checkout(a, 'bad..name', true), /not a valid branch name/);
    await assert.rejects(git.checkout(a, '--force', true), /not a valid branch name/);
    run(a, 'checkout', '-q', '--detach');
    await assert.rejects(git.push(a), /Check out a branch/);
  } finally { for (const d of [remote, a, b]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('pull requests through gh: none, create with the body on stdin, current with checks, list, checkout', async () => {
  const home = tmp('hanobi-gh-'), bin = path.join(home, '.local/bin'), repo = tmp('hanobi-repo-'), remote = tmp('hanobi-remote-');
  const saved = { HOME: process.env.HOME, FAKE_GH_LOG: process.env.FAKE_GH_LOG, FAKE_GH_STATE: process.env.FAKE_GH_STATE };
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures/fake-gh.cjs'), path.join(bin, 'gh'));
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  Object.assign(process.env, { HOME: home, FAKE_GH_LOG: path.join(home, 'log'), FAKE_GH_STATE: path.join(home, 'state.json') });
  const calls = () => fs.readFileSync(process.env.FAKE_GH_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  try {
    assert.equal(cliPath('gh', true), path.join(bin, 'gh'));
    run(remote, 'init', '-q', '--bare', '-b', 'main');
    run(repo, 'init', '-q', '-b', 'feature'); run(repo, 'config', 'user.email', 't@example.com'); run(repo, 'config', 'user.name', 'T'); run(repo, 'remote', 'add', 'origin', remote);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); run(repo, 'add', '.'); run(repo, 'commit', '-qm', 'a');
    assert.equal(await github.current(repo), null);
    assert.equal(await github.defaultBranch(repo), 'trunk');
    await assert.rejects(github.create(repo, { title: 'Add a' }), /Push the branch/);
    await assert.rejects(github.create(repo, { title: ' ' }), /Enter a title/);
    await git.push(repo);
    const body = '--draft\n## Why\nIt is needed.';
    assert.equal(await github.create(repo, { title: 'Add a', body, base: 'trunk', draft: true }), 'https://github.com/o/r/pull/12');
    const created = calls().find(c => c.args[1] === 'create');
    assert.equal(created.stdin, body);
    assert.deepEqual(created.args.slice(2), ['--title', 'Add a', '--body-file', '-', '--head', 'feature', '--base', 'trunk', '--draft']);
    assert.ok(calls().every(c => c.prompt === '1'));
    const pr = await github.current(repo);
    assert.deepEqual({ ...pr, updatedAt: undefined }, { number: 12, title: 'Add a', url: 'https://github.com/o/r/pull/12', state: 'OPEN', draft: true, review: 'REVIEW_REQUIRED',
      head: 'feature', base: 'trunk', author: 'me', updatedAt: undefined, checks: { passed: 2, failed: 1, pending: 1 } });
    assert.deepEqual((await github.list(repo)).map(p => [p.number, p.draft, p.review, p.author]), [[12, true, 'REVIEW_REQUIRED', 'me'], [7, true, null, 'sam']]);
    await github.checkout(repo, 7);
    assert.deepEqual(calls().at(-1).args, ['pr', 'checkout', '7']);
    await assert.rejects(github.checkout(repo, '7; rm -rf /'), /Invalid pull request number/);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    cliPath('gh', true);
    for (const d of [home, repo, remote]) fs.rmSync(d, { recursive: true, force: true });
  }
});
