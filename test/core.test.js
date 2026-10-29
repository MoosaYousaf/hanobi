const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { Store, migrate } = require('../electron/store');
const { Draft } = require('../electron/draft');
const acp = require('../electron/providers/copilot-acp');
const cli = require('../electron/providers/cli');
const { command, apply } = cli;
const { toProvider, replayPrompt } = require('../electron/providers/transcript');
const { presets, validateSettings } = require('../electron/providers/catalog');
const git = require('../electron/git');
const { Runner, ASK_TOOL, validAnswers } = require('../electron/runner');

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
  assert.ok(args.includes('--deny-tool=write') && !args.includes('--reasoning-effort'));
  assert.ok(command('copilot', { sessionId: 'abc', model: 'gpt-5.5', effort: 'low' }).includes('--reasoning-effort'));
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
  apply('claude', { type: 'prompt_suggestion', suggestion: 'Run the tests ', session_id: 'abc' }, draft);
  assert.deepEqual(draft.suggestions, ['Run the tests']);
  assert.ok(command('claude', { mode: 'auto' }).includes('--prompt-suggestions'));
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
    const base = { preset: presets['claude-code'], history: [], cwd: home, mcpServers: [], signal: new AbortController().signal, onSession() {} };
    // AskUserQuestion answers go back in updatedInput.answers, keyed by question text, in every access mode.
    let draft = new Draft();
    await cli.run({ ...base, thread: { mode: 'auto', model: '', effort: '' }, prompt: 'ask', draft,
      approve: () => assert.fail('a question is not an approval'),
      question: ({ questions }) => { assert.equal(questions[0].question, 'Which database?'); return { decision: Promise.resolve({ 0: ['SQLite'] }), cancel() {} }; } });
    assert.equal(draft.parts.at(-1).text, '{"Which database?":"SQLite"}');
    // Outside Ask first, a permission prompt is denied without asking the user.
    draft = new Draft();
    await cli.run({ ...base, thread: { mode: 'auto', model: '', effort: '' }, prompt: 'ls', draft, approve: () => assert.fail('not in ask mode'), question() {} });
    assert.equal(draft.parts[0].status, 'denied');
    assert.equal(draft.parts.at(-1).text, 'deny');
    // The turn ends when the CLI is done, even when a background job keeps the output pipe open or the CLI stays open.
    for (const prompt of ['background', 'linger']) {
      draft = new Draft();
      const started = Date.now();
      await cli.run({ ...base, thread: { mode: 'auto', model: '', effort: '' }, prompt, draft, question() {} });
      assert.equal(draft.parts.at(-1).text, 'Done.');
      assert.ok(Date.now() - started < 5000, `${prompt} turn ended in ${Date.now() - started} ms`);
    }
    // A suggestion that comes after the turn ended still reaches the caller.
    draft = new Draft();
    let late;
    const suggested = new Promise(resolve => { late = resolve; });
    const started = Date.now();
    await cli.run({ ...base, thread: { mode: 'auto', model: '', effort: '' }, prompt: 'suggest', draft, question() {}, onSuggestion: late });
    assert.ok(Date.now() - started < 3500, 'the turn ends before the suggestion');
    assert.deepEqual(draft.suggestions, []);
    assert.equal(await suggested, 'Run the tests');
  } finally { process.env.HOME = savedHome; cli.cliPath('claude', true); }
});

test('Copilot ask mode: ACP permission requests become approvals; a load does not repeat old turns', async () => {
  assert.doesNotThrow(() => validateSettings({ preset: 'copilot' }, { model: '', mode: 'ask' }));
  const home = tmp('hanobi-home-'), bin = path.join(home, '.local/bin'), savedHome = process.env.HOME;
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures/fake-copilot.cjs'), path.join(bin, 'copilot'));
  fs.chmodSync(path.join(bin, 'copilot'), 0o755);
  process.env.HOME = home;
  const turn = async (answer, sessionId) => {
    const draft = new Draft(), asked = [], sessions = [];
    await cli.run({ preset: presets.copilot, thread: { mode: 'ask', model: '', effort: '', sessionId }, history: [], prompt: 'write', cwd: home, mcpServers: [], draft,
      signal: new AbortController().signal, onSession: id => sessions.push(id),
      approve: request => { asked.push(request); assert.equal(draft.parts.find(p => p.type === 'tool').status, 'pending'); return { decision: Promise.resolve(answer), cancel() {} }; } });
    return { draft, asked, sessions };
  };
  try {
    assert.equal(cli.cliPath('copilot', true), path.join(bin, 'copilot'));
    let { draft, asked, sessions } = await turn('allow');
    assert.deepEqual(sessions, ['s-new']);
    assert.deepEqual(asked.map(r => [r.callId, r.name, r.description]), [['t1', 'Edit', 'Create a.txt']]);
    assert.deepEqual(draft.parts.map(p => [p.type, p.status ?? p.text]), [['thinking', 'plan'], ['tool', 'done'], ['text', 's-new:yes']]);
    ({ draft, sessions } = await turn('always', 's-old'));
    assert.deepEqual(sessions, ['s-old']);
    assert.equal(draft.parts.at(-1).text, 's-old:yes');
    assert.ok(!draft.parts.some(p => p.text === 'OLD'));
    const notes = new Draft(), state = {};
    for (const text of ['Info: a.txt', 'Done', '.']) acp.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }, notes, state);
    assert.equal(notes.parts[0].text, 'Info: a.txt\n\nDone.');
    ({ draft } = await turn('deny'));
    assert.equal(draft.parts.find(p => p.type === 'tool').status, 'denied');
    assert.equal(draft.parts.at(-1).text, 's-new:no');
    process.env.FAKE_ALLOW_ALL = 'on';
    ({ draft } = await turn('allow'));
    assert.equal(draft.parts.at(-1).text, 's-new:yes');
  } finally { delete process.env.FAKE_ALLOW_ALL; process.env.HOME = savedHome; cli.cliPath('copilot', true); }
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
    const draft = new Draft();
    await cli.run({ preset: presets.codex, thread: { mode: 'ask', model: '', effort: '' }, history: [], prompt: 'ask', cwd: home, mcpServers: [], draft,
      signal: new AbortController().signal, onSession() {}, approve: () => assert.fail('not an approval'),
      question: ({ questions }) => { assert.equal(questions[0].id, 'db'); return { decision: Promise.resolve({ db: ['Postgres'] }), cancel() {} }; } });
    assert.equal(draft.parts.find(p => p.type === 'tool').status, 'done');
    assert.equal(draft.parts.at(-1).text, '{"db":{"answers":["Postgres"]}}');
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

test('API models ask questions through the ask_user tool; answers must cover every question', async () => {
  const store = new Store(path.join(tmp('hanobi-q-'), 'data.json'));
  const thread = store.addThread(store.addWorkspace(tmp('hanobi-qw-')).id, { connectionId: 'x', model: 'm', effort: '', mode: 'ask' });
  const sent = [];
  const runner = new Runner({ store, secrets: {}, mcp: {}, send: (channel, value) => {
    sent.push(channel);
    if (channel === 'question') setImmediate(() => runner.answer(value.id, { 0: ['Blue', 'ignored for single select'], 1: ['a', 'b'] }));
  } });
  const draft = new Draft();
  draft.tool({ id: 'c1', name: ASK_TOOL.qualified, input: {} });
  const call = runner.toolCaller(thread.id, [ASK_TOOL], draft);
  const result = await call('c1', ASK_TOOL.qualified, { questions: [
    { question: 'Color?', options: [{ label: 'Blue' }, { label: 'Red' }] },
    { question: 'Extras?', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }] }
  ] });
  assert.deepEqual(JSON.parse(result.output), { 'Color?': 'Blue', 'Extras?': 'a, b' });
  assert.ok(sent.includes('question') && sent.includes('approval-done'));
  assert.equal(validAnswers([{ id: '0', multiSelect: false }, { id: '1' }], { 0: ['x'] }), null);
  assert.match((await call('c2', ASK_TOOL.qualified, { questions: [] })).output, /1 to 4 questions/);
});

test('projects: instructions files for CLIs, documents, and the API context', async () => {
  const projects = require('../electron/projects');
  const project = { id: 'p', kind: 'project', name: 'Contracts', path: tmp('hanobi-project-'), instructions: 'Answer in plain language.' };
  projects.writeContext(project);
  for (const name of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) assert.match(fs.readFileSync(path.join(project.path, name), 'utf8'), /Answer in plain language\.[\s\S]*knowledge\//);
  const src = tmp('hanobi-src-');
  fs.writeFileSync(path.join(src, 'terms.md'), 'Net 30 payment.');
  fs.writeFileSync(path.join(src, 'scan.pdf'), '%PDF-1.7');
  assert.deepEqual(projects.addFiles(project, [path.join(src, 'terms.md'), path.join(src, 'scan.pdf'), path.join(src, 'terms.md')]), ['terms.md', 'scan.pdf', 'terms 2.md']);
  assert.deepEqual(projects.files(project).map(f => f.name), ['scan.pdf', 'terms 2.md', 'terms.md']);
  const context = await projects.apiContext(project);
  assert.match(context, /<document name="terms.md">\nNet 30 payment\.\n<\/document>/);
  assert.match(context, /not included as text: scan\.pdf/);
  assert.throws(() => projects.removeFile(project, '../CLAUDE.md'), /Invalid/);
  projects.removeFile(project, 'terms 2.md');
  assert.equal(projects.files(project).length, 2);
  // PDF, Word, PowerPoint, and Excel text goes into the API context; the cache goes with the document.
  if (process.platform === 'darwin') {
    officeFixtures(src);
    projects.addFiles(project, ['quote.pdf', 'memo.docx', 'deck.pptx', 'rates.xlsx'].map(n => path.join(src, n)));
    const office = await projects.apiContext(project);
    assert.match(office, /<document name="quote.pdf">\n\[Page 1\]\nTotal due 4200\n<\/document>/);
    assert.match(office, /<document name="memo.docx">\nShip on Friday\.\n<\/document>/);
    assert.match(office, /\[Slide 1\]\nQ3 plan\nHire two & ship[\s\S]*\[Slide 2\]\nRisks/);
    assert.match(office, /\[Sheet: Rates\]\nRegion\tRate\nNorth\t12\.5/);
    assert.ok(fs.existsSync(path.join(project.path, 'knowledge', '.text', 'quote.pdf.txt')));
    assert.ok(!projects.files(project).some(f => f.name.startsWith('.')));
    projects.removeFile(project, 'quote.pdf');
    assert.ok(!fs.existsSync(path.join(project.path, 'knowledge', '.text', 'quote.pdf.txt')));
  }
  // CLI chats read and change nothing; old workspaces become code folders.
  assert.deepEqual(command('claude', { mode: 'full', chat: true }).filter(a => a === '--tools' || a === 'Read,Glob,Grep' || a === 'bypassPermissions'), ['--tools', 'Read,Glob,Grep']);
  assert.ok(command('codex', { mode: 'full', chat: true }).includes('read-only'));
  assert.equal(migrate({ version: 2, workspaces: [{ id: 'w', name: 'x', path: '/x' }] }).workspaces[0].kind, 'code');
});

// Small real documents, made with macOS tools: textutil for Word, zip for PowerPoint and Excel XML.
function officeFixtures(dir) {
  const stream = 'BT /F1 24 Tf 72 700 Td (Total due 4200) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => { const at = pdf.length; pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(path.join(dir, 'quote.pdf'), pdf);
  fs.writeFileSync(path.join(dir, 'memo.txt'), 'Ship on Friday.');
  execFileSync('textutil', ['-convert', 'docx', path.join(dir, 'memo.txt'), '-output', path.join(dir, 'memo.docx')]);
  const zip = (name, entries) => {
    const root = fs.mkdtempSync(path.join(dir, 'zip-'));
    for (const [file, body] of Object.entries(entries)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), body); }
    execFileSync('zip', ['-qr', path.join(dir, name), '.'], { cwd: root });
  };
  const slide = paragraphs => `<p:sld xmlns:a="a" xmlns:p="p"><p:txBody>${paragraphs.map(p => `<a:p>${p.map(r => `<a:r><a:t>${r}</a:t></a:r>`).join('')}</a:p>`).join('')}</p:txBody></p:sld>`;
  zip('deck.pptx', { 'ppt/slides/slide10.xml': slide([['Late']]), 'ppt/slides/slide1.xml': slide([['Q3 plan'], ['Hire two ', '&amp; ship']]), 'ppt/slides/slide2.xml': slide([['Risks']]) });
  zip('rates.xlsx', {
    'xl/workbook.xml': '<workbook><sheets><sheet name="Rates" sheetId="1"/></sheets></workbook>',
    'xl/sharedStrings.xml': '<sst><si><t>Region</t></si><si><t>Rate</t></si><si><r><t>Nor</t></r><r><t>th</t></r></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><f>25/2</f><v>12.5</v></c></row></sheetData></worksheet>'
  });
}

test('context usage: Claude Code stream, Codex rollout file, Copilot session log', () => {
  const usage = require('../electron/providers/usage');
  const draft = new Draft();
  apply('claude', { type: 'assistant', message: { content: [], usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 80, output_tokens: 10 } } }, draft);
  apply('claude', { type: 'assistant', parent_tool_use_id: 'sub', message: { content: [], usage: { input_tokens: 99999 } } }, draft);
  apply('claude', { type: 'result', session_id: 's', modelUsage: { 'claude-opus-5-5': { contextWindow: 1000000 } } }, draft);
  assert.deepEqual(draft.usage, { used: 1000, window: 1000000 });

  const home = tmp('hanobi-usage-');
  const day = path.join(home, 'codex/sessions/2026/10/28');
  fs.mkdirSync(day, { recursive: true });
  const token = (input, output) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: input, output_tokens: output }, model_context_window: 475000 } } });
  fs.writeFileSync(path.join(day, 'rollout-2026-10-28T10-00-00-th9.jsonl'), [token(100, 5), '{"type":"response_item"}', token(300, 20), ''].join('\n'));
  assert.deepEqual(usage.codex('th9', path.join(home, 'codex')), { used: 320, window: 475000 });
  assert.equal(usage.codex('missing', path.join(home, 'codex')), null);

  fs.mkdirSync(path.join(home, 'copilot/session-state/s1'), { recursive: true });
  fs.writeFileSync(path.join(home, 'copilot/session-state/s1/events.jsonl'), JSON.stringify({ type: 'session.usage_record', data: { usage: { inputTokens: 12929, outputTokens: 141, maxPromptTokens: 272000 } } }) + '\n');
  assert.deepEqual(usage.copilot('s1', path.join(home, 'copilot')), { used: 13070, window: 272000 });
  assert.equal(usage.contextWindow('claude-haiku-4-5'), 200000);
  assert.equal(usage.contextWindow('claude-sonnet-5-5'), 1000000);
  assert.equal(usage.contextWindow('gpt-6-luna'), null);
});
