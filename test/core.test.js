const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Store, migrate } = require('../electron/store');
const { Draft } = require('../electron/draft');
const cli = require('../electron/providers/cli');
const { command, apply } = cli;
const { toProvider, replayPrompt } = require('../electron/providers/transcript');
const { presets, validateSettings } = require('../electron/providers/catalog');
const git = require('../electron/git');
const { Runner } = require('../electron/runner');

const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('store persists threads, and a branch ends before the chosen user message', () => {
  const root = tmp('hanobi-store-');
  try {
    const file = path.join(root, 'data.json');
    const store = new Store(file);
    const workspace = store.addWorkspace(root);
    const thread = store.addThread(workspace.id, { connectionId: 'claude-code', model: '', effort: '', mode: 'auto' });
    store.append(thread.id, { role: 'user', parts: [{ type: 'text', text: 'First task' }] });
    store.append(thread.id, { role: 'assistant', parts: [{ type: 'text', text: 'Done' }] });
    store.append(thread.id, { role: 'user', parts: [{ type: 'text', text: 'Second task' }] });
    const branch = store.fork(thread.id, store.thread(thread.id).messages[2].id);
    assert.equal(branch.messages.length, 2);
    assert.equal(branch.replay, true);
    store.flush();
    assert.equal(new Store(file).thread(branch.id).messages[0].parts[0].text, 'First task');
    assert.equal(new Store(file).thread(thread.id).title, 'First task');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a corrupt data file is kept aside and the app starts empty', () => {
  const root = tmp('hanobi-corrupt-');
  try {
    const file = path.join(root, 'data.json');
    fs.writeFileSync(file, '{"version": 2, "threads": [');
    const store = new Store(file);
    assert.equal(store.data.threads.length, 0);
    assert.match(store.warning, /could not be read/);
    assert.ok(fs.readdirSync(root).some(f => f.startsWith('data.json.corrupt-')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Orbit Code v1 data migrates to connections and parts', () => {
  const data = migrate({ version: 1, workspaces: [{ id: 'w', name: 'W', path: '/tmp' }], providerSettings: { claude: { model: 'claude-opus-5-5', effort: 'high', mode: 'read' } },
    threads: [{ id: 't', workspaceId: 'w', provider: 'claude', title: 'T', messages: [{ id: 'm', role: 'assistant', text: 'Hi', tools: [{ name: 'Bash', detail: 'ls' }] }] }] });
  assert.equal(data.threads[0].connectionId, 'claude-code');
  assert.equal(data.threads[0].model, 'claude-opus-5-5');
  assert.deepEqual(data.threads[0].messages[0].parts.map(p => p.type), ['text', 'tool']);
});

test('CLI prompts never enter argv, so a prompt cannot act as an option', () => {
  for (const cli of ['claude', 'codex', 'gemini']) {
    const args = command(cli, { model: '', effort: '', mode: 'auto', sessionId: 's1' });
    assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'), cli);
  }
  assert.deepEqual(command('codex', { sessionId: 's', model: 'gpt-6.1-sol', effort: 'high', mode: 'auto' }),
    ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '--model', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="high"', 'resume', 's', '-']);
  assert.ok(command('claude', { mode: 'full' }).includes('bypassPermissions'));
  const mcp = command('claude', { mode: 'auto', mcpServers: [{ name: 'fs', transport: 'stdio', command: 'npx', args: ['x'] }, { name: 'notion', transport: 'http', url: 'https://x', oauth: true }] });
  assert.deepEqual(Object.keys(JSON.parse(mcp[mcp.indexOf('--mcp-config') + 1]).mcpServers), ['fs']);
});

test('GitHub Copilot: chosen session id, streamed text, reasoning, and tool results', () => {
  const args = command('copilot', { sessionId: 'abc', model: 'auto', effort: 'low', mode: 'read' });
  assert.deepEqual(args.slice(-2), ['--session-id', 'abc']);
  assert.ok(args.includes('--deny-tool=write') && args.includes('--reasoning-effort'));
  const draft = new Draft();
  const events = [
    { type: 'assistant.reasoning_delta', data: { deltaContent: 'Count files.' }, ephemeral: true },
    { type: 'assistant.message', data: { messageId: 'm1', content: '', toolRequests: [{ toolCallId: 'c1', name: 'bash', arguments: { command: 'ls' } }] } },
    { type: 'tool.execution_start', data: { toolCallId: 'c1', toolName: 'bash', arguments: { command: 'ls' } } },
    { type: 'tool.execution_complete', data: { toolCallId: 'c1', success: true, result: { content: 'a.txt' } } },
    { type: 'assistant.message_start', data: { messageId: 'm2' }, ephemeral: true },
    { type: 'assistant.message_delta', data: { messageId: 'm2', deltaContent: 'There is ' }, ephemeral: true },
    { type: 'assistant.message_delta', data: { messageId: 'm2', deltaContent: '1 file.' }, ephemeral: true },
    { type: 'assistant.message', data: { messageId: 'm2', content: 'There is 1 file.', toolRequests: [] } },
    { type: 'result', data: {} }
  ];
  for (const event of events) apply('copilot', event, draft);
  assert.deepEqual(draft.final().map(p => [p.type, p.text ?? p.output]), [['thinking', 'Count files.'], ['tool', 'a.txt'], ['text', 'There is 1 file.']]);
  assert.throws(() => apply('copilot', { type: 'session.error', data: { message: 'Quota exceeded' } }, new Draft()), /Quota/);
});

test('Gemini delta chunks join into one text block', () => {
  const draft = new Draft();
  for (const content of ['Hel', 'lo wor', 'ld']) apply('gemini', { type: 'message', role: 'assistant', content, delta: true }, draft);
  apply('gemini', { type: 'result', status: 'success' }, draft);
  assert.deepEqual(draft.final(), [{ type: 'text', text: 'Hello world' }]);
});

test('Claude Code stream: deltas, tool calls, and tool results', () => {
  const draft = new Draft();
  assert.equal(apply('claude', { type: 'system', subtype: 'init', session_id: 'abc' }, draft), 'abc');
  apply('claude', { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Looking' } } }, draft);
  apply('claude', { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }, draft);
  apply('claude', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt' }] } }, draft);
  apply('claude', { type: 'result', result: 'Looking', session_id: 'abc' }, draft);
  assert.deepEqual(draft.final(), [{ type: 'text', text: 'Looking' }, { type: 'tool', id: 't1', name: 'Bash', server: undefined, input: { command: 'ls' }, output: 'a.txt', status: 'done' }]);
  assert.throws(() => apply('claude', { type: 'result', is_error: true, result: 'Credit balance too low' }, new Draft()), /Credit balance/);
});

test('Claude Code ask mode: the prompt is a stdin message, and approval prompts come back as control requests', async () => {
  const args = command('claude', { mode: 'ask' });
  assert.deepEqual(args.slice(args.indexOf('--input-format'), args.indexOf('--input-format') + 4), ['--input-format', 'stream-json', '--permission-prompt-tool', 'stdio']);
  assert.throws(() => validateSettings({ preset: 'gemini' }, { model: '', mode: 'ask' }), /access mode/);
  // The fake CLI goes in $HOME/.local/bin, which comes first on the search path.
  const home = tmp('hanobi-home-'), bin = path.join(home, '.local/bin'), savedHome = process.env.HOME;
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures/fake-claude.cjs'), path.join(bin, 'claude'));
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  process.env.HOME = home;
  try {
    assert.equal(cli.cliPath('claude', true), path.join(bin, 'claude'));
    for (const answer of ['allow', 'deny']) {
      const draft = new Draft(), asked = [];
      await cli.run({ preset: presets['claude-code'], thread: { mode: 'ask', model: '', effort: '' }, history: [], prompt: 'ls', cwd: home, mcpServers: [], draft,
        signal: new AbortController().signal, onSession() {},
        approve: request => { asked.push(request); assert.equal(draft.parts[0].status, 'pending'); return { decision: Promise.resolve(answer), cancel() {} }; } });
      assert.deepEqual(asked.map(r => [r.callId, r.name, r.description]), [['t1', 'Bash', 'Run a command']]);
      assert.equal(draft.parts[0].status, answer === 'allow' ? 'done' : 'denied');
      assert.equal(draft.parts.at(-1).text, answer);
    }
  } finally { process.env.HOME = savedHome; cli.cliPath('claude', true); }
});

test('Codex ask mode: app-server approval requests become approvals, and a decline stays declined', async () => {
  assert.doesNotThrow(() => validateSettings({ preset: 'codex' }, { model: '', mode: 'ask' }));
  const home = tmp('hanobi-home-'), bin = path.join(home, '.local/bin'), savedHome = process.env.HOME;
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures/fake-codex.cjs'), path.join(bin, 'codex'));
  fs.chmodSync(path.join(bin, 'codex'), 0o755);
  process.env.HOME = home;
  try {
    assert.equal(cli.cliPath('codex', true), path.join(bin, 'codex'));
    for (const answer of ['allow', 'deny']) {
      const draft = new Draft(), asked = [], sessions = [];
      await cli.run({ preset: presets.codex, thread: { mode: 'ask', model: '', effort: '' }, history: [], prompt: 'ls', cwd: home, mcpServers: [], draft,
        signal: new AbortController().signal, onSession: id => sessions.push(id),
        approve: request => { asked.push(request); assert.equal(draft.parts[0].status, 'pending'); return { decision: Promise.resolve(answer), cancel() {} }; } });
      assert.deepEqual(sessions, ['th1']);
      assert.deepEqual(asked.map(r => [r.callId, r.name, r.input, r.description]), [['c1', 'Command', 'ls', 'Needs approval']]);
      assert.equal(draft.parts[0].status, answer === 'allow' ? 'done' : 'denied');
      assert.equal(draft.parts.at(-1).text, answer === 'allow' ? 'accept' : 'decline');
    }
  } finally { process.env.HOME = savedHome; cli.cliPath('codex', true); }
});

test('history replays natively on the same provider and as text elsewhere', () => {
  const native = [{ role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'Hi' }] }];
  const history = [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }, { role: 'assistant', parts: [{ type: 'text', text: 'Hi' }, { type: 'tool', name: 'search', input: { q: 'x' }, output: 'y' }], native: { format: 'anthropic', messages: native } }];
  assert.deepEqual(toProvider(history, 'anthropic')[1], native[0]);
  assert.match(toProvider(history, 'openai')[1].content, /\[Tool search: \{"q":"x"\} → y\]/);
  assert.match(replayPrompt(history, 'Next'), /User: Hello[\s\S]*User: Next$/);
});

test('settings validation accepts listed CLI models and any API model id', () => {
  assert.throws(() => validateSettings({ preset: 'gemini' }, { model: '', effort: 'high', mode: 'auto' }));
  assert.throws(() => validateSettings({ preset: 'claude-code' }, { model: 'made-up', effort: '', mode: 'auto' }));
  assert.equal(validateSettings({ preset: 'copilot' }, { model: 'gpt-6-luna', effort: '', mode: 'auto' }).model, 'gpt-6-luna');
  assert.deepEqual(validateSettings({ preset: 'ollama' }, { model: 'qwen3:8b', effort: '', mode: 'ask' }), { model: 'qwen3:8b', effort: '', mode: 'ask' });
});

test('git works from a repo subfolder with renames and spaces in names', async () => {
  const root = tmp('hanobi-git-');
  const run = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  try {
    run('init', '-q'); run('config', 'user.email', 't@example.com'); run('config', 'user.name', 'T');
    run('remote', 'add', 'origin', 'git@github.com:example/project.git');
    fs.mkdirSync(path.join(root, 'app'));
    fs.writeFileSync(path.join(root, 'app/old name.txt'), 'hello\n');
    run('add', '.'); run('commit', '-qm', 'init');
    run('mv', 'app/old name.txt', 'app/new name.txt');
    fs.writeFileSync(path.join(root, 'app/café.txt'), 'new\n');
    const sub = path.join(root, 'app');
    const status = await git.status(sub);
    assert.equal(status.remote, 'https://github.com/example/project');
    assert.deepEqual(status.files.map(f => f.path).sort(), ['app/café.txt', 'app/new name.txt']);
    await git.stage(sub, 'app/café.txt', false);
    assert.equal((await git.status(sub)).files.find(f => f.path === 'app/café.txt').staged, true);
    assert.match(await git.diff(sub, 'app/café.txt', { staged: true }), /\+new/);
    await git.stage(sub, 'app/new name.txt', true);
    await assert.rejects(git.diff(sub, '../../etc/passwd', {}), /Invalid path/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rewind restores workspace files from a checkpoint and leaves the real index and other folders alone', async () => {
  const root = tmp('hanobi-rewind-');
  const run = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  try {
    run('init', '-q'); run('config', 'user.email', 't@example.com'); run('config', 'user.name', 'T');
    write('.gitignore', 'build/\n'); write('app/a.txt', 'one\n'); write('other.txt', 'x\n');
    run('add', '.'); run('commit', '-qm', 'init');
    write('app/draft.txt', 'untracked before\n'); write('app/staged.txt', 'staged\n'); run('add', 'app/staged.txt');
    const index = run('ls-files', '--stage');
    const sub = path.join(root, 'app');
    const checkpoint = await git.snapshot(sub);
    assert.equal(checkpoint.scope, 'app');
    // The model edits, creates, and deletes files; the user edits a file outside the workspace.
    write('app/a.txt', 'two\n'); write('app/new.txt', 'new\n'); fs.rmSync(path.join(root, 'app/draft.txt')); write('build/out.js', 'ignored\n'); write('other.txt', 'y\n');
    const files = await git.restore(sub, checkpoint);
    assert.deepEqual([files.restored.sort(), files.removed], [['app/a.txt', 'app/draft.txt'], ['app/new.txt']]);
    assert.equal(read('app/a.txt'), 'one\n');
    assert.equal(read('app/draft.txt'), 'untracked before\n');
    assert.ok(!fs.existsSync(path.join(root, 'app/new.txt')));
    assert.equal(read('build/out.js'), 'ignored\n');
    assert.equal(read('other.txt'), 'y\n');
    assert.equal(run('ls-files', '--stage'), index);

    // The runner rewinds the conversation to just before a user message and drops the CLI session.
    const store = new Store(path.join(tmp('hanobi-data-'), 'data.json'));
    const workspace = store.addWorkspace(sub);
    const thread = store.addThread(workspace.id, { connectionId: 'claude-code', model: '', effort: '', mode: 'auto', sessionId: 's1' });
    store.append(thread.id, { role: 'user', parts: [{ type: 'text', text: 'first' }] });
    store.append(thread.id, { role: 'assistant', parts: [{ type: 'text', text: 'ok' }] });
    const second = store.append(thread.id, { role: 'user', parts: [{ type: 'text', text: 'second' }], checkpoint });
    store.append(thread.id, { role: 'assistant', parts: [{ type: 'text', text: 'done' }] });
    write('app/a.txt', 'three\n');
    const runner = new Runner({ store, secrets: {}, mcp: {}, send() {} });
    const result = await runner.rewind(thread.id, second.id, { conversation: true, code: true });
    assert.equal(result.text, 'second');
    assert.equal(read('app/a.txt'), 'one\n');
    assert.deepEqual(store.thread(thread.id).messages.map(m => m.parts[0].text), ['first', 'ok']);
    assert.equal(store.thread(thread.id).sessionId, null);
    assert.equal(store.thread(thread.id).replay, true);
    await assert.rejects(runner.rewind(thread.id, store.thread(thread.id).messages[0].id, { code: true }), /no file checkpoint/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
