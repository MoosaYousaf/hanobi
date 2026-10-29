const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Store, migrate } = require('../electron/store');
const { Draft } = require('../electron/draft');
const { command, apply } = require('../electron/providers/cli');
const { toProvider, replayPrompt } = require('../electron/providers/transcript');
const { validateSettings } = require('../electron/providers/catalog');
const git = require('../electron/git');

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
