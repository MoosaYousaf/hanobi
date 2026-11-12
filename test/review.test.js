const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Store } = require('../electron/store');
const { Secrets } = require('../electron/secrets');
const { Runner, mapMode, ASK_TOOL } = require('../electron/runner');
const { Draft } = require('../electron/draft');
const { presets } = require('../electron/providers/catalog');
const cli = require('../electron/providers/cli');
const git = require('../electron/git');
const hf = require('../electron/hf');
const { Engine } = require('../electron/llama');
const { extractText } = require('../electron/extract');
const { shorten } = require('../electron/models-catalog');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orin-review-'));
function setup() {
  const root = tmp(), store = new Store(path.join(root, 'data.json'));
  const workspace = store.addWorkspace(root);
  store.data.connections.push({ id: 'api', preset: 'custom', name: 'Fake', baseURL: 'http://127.0.0.1:1/v1' });
  const thread = store.addThread(workspace.id, { connectionId: 'api', model: 'test', mode: 'ask', effort: '' });
  const runner = new Runner({ store, secrets: { get() {}, has() { return false; } }, mcp: {}, send() {} });
  return { root, store, thread, runner };
}

test('review: provider switches never promote API tool access to unrestricted CLI access', () => {
  for (const preset of [presets['claude-code'], presets.codex, presets.copilot, presets.gemini]) {
    assert.notEqual(mapMode('full', preset, presets.anthropic), 'full');
    assert.equal(mapMode('full', preset, presets.codex), 'full');
  }
  const args = cli.command('claude', { mode: 'ask' });
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'default');
  assert.ok(!cli.completeArgs('gemini', 'test').includes('--resume'));
});

test('review: Stop resolves approvals and questions without running the tool', async () => {
  const { root, store, thread, runner } = setup();
  let calls = 0;
  runner.mcp.call = async () => { calls++; return { output: 'should not run' }; };
  try {
    for (const tool of [{ qualified: 'tool', name: 'run', server: 'Fake' }, ASK_TOOL]) {
      runner.runs.set(thread.id, { controller: new AbortController() });
      const draft = new Draft(); draft.tool({ id: 'call', name: tool.qualified });
      const pending = runner.toolCaller(thread.id, [tool], draft)('call', tool.qualified, { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }] });
      assert.equal(runner.approvals.size, 1);
      runner.stop(thread.id);
      await pending;
      assert.equal(runner.approvals.size, 0);
    }
    assert.equal(calls, 0);
    const allowed = runner.ask(thread.id, { name: 'Command', server: 'Fake' });
    assert.equal(await allowed.decision, 'deny', 'aborted runs cannot ask again');
  } finally { store.flush(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('review: edit validation preserves history and suggestions never exceed three', () => {
  const { root, store, thread, runner } = setup();
  try {
    const message = store.append(thread.id, { role: 'user', parts: [{ type: 'text', text: 'original' }] });
    const reply = store.append(thread.id, { role: 'assistant', parts: [], suggestions: ['one', 'two', 'three'] });
    runner.addSuggestions(thread.id, reply.id, ['four'], true);
    assert.deepEqual(reply.suggestions, ['four', 'one', 'two']);
    store.update(thread.id, { model: '' });
    assert.throws(() => runner.start(thread.id, { text: 'edited', editMessageId: message.id }), /Choose a model/);
    assert.equal(thread.messages.length, 2);
    assert.equal(thread.messages[0].parts[0].text, 'original');
  } finally { store.flush(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('review: secrets recover damaged files and write private atomic replacements', () => {
  const root = tmp(), file = path.join(root, 'secrets.json');
  const safe = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
  try {
    fs.writeFileSync(file, '{broken');
    const secrets = new Secrets(file, safe);
    assert.match(secrets.warning, /recovery copy/);
    assert.equal(fs.readFileSync(path.join(root, fs.readdirSync(root)[0]), 'utf8'), '{broken');
    secrets.set('key', 'value');
    assert.equal(new Secrets(file, safe).get('key'), 'value');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(!fs.readdirSync(root).some(f => f.endsWith('.tmp')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('review: automatic Git checkpoints do not execute clean or smudge filters', async () => {
  const root = tmp(), marker = path.join(root, 'executed');
  try {
    const run = args => execFileSync('git', args, { cwd: root });
    run(['init', '-q']);
    run(['config', 'filter.evil.clean', `touch '${marker}'; cat`]);
    run(['config', 'filter.evil.smudge', `touch '${marker}'; cat`]);
    run(['config', 'filter.evil.required', 'true']);
    fs.writeFileSync(path.join(root, '.gitattributes'), '*.txt filter=evil\n');
    fs.writeFileSync(path.join(root, 'test.txt'), 'before');
    const checkpoint = await git.snapshot(root);
    fs.writeFileSync(path.join(root, 'test.txt'), 'after');
    await git.restore(root, checkpoint);
    assert.equal(fs.readFileSync(path.join(root, 'test.txt'), 'utf8'), 'before');
    assert.equal(fs.existsSync(marker), false);
    fs.truncateSync(path.join(root, 'test.txt'), 26 * 1024 * 1024);
    await assert.rejects(git.snapshot(root), /too large/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('review: downloads reject oversized bodies and invalid ranges and remove split models', async () => {
  const root = tmp(), library = new hf.Library({ root });
  try {
    const dir = library.dirOf('acme/model'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'tiny.gguf.part');
    const part = { path: 'tiny.gguf', size: 4 };
    const job = { repo: 'acme/model', controller: new AbortController() };
    const downloads = new hf.Downloads({ library, fetch: async () => new Response('too many bytes') });
    await assert.rejects(downloads.fetchPart(job, part, file, 0), /exceeded/);
    assert.ok(!fs.existsSync(file) || fs.statSync(file).size <= 4);
    fs.writeFileSync(file, 'a');
    downloads.fetch = async () => new Response('bcd', { status: 206, headers: { 'Content-Range': 'bytes 0-2/4' } });
    await assert.rejects(downloads.fetchPart(job, part, file, 0), /invalid download range/);
    downloads.fetch = async () => new Response('abcd');
    fs.writeFileSync(file, 'too large');
    await downloads.fetchPart(job, part, file, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), 'abcd');
    const first = 'big-00001-of-00002.gguf', second = 'big-00002-of-00002.gguf';
    for (const name of [first, second, second + '.part']) fs.writeFileSync(path.join(dir, name), 'x');
    fs.writeFileSync(path.join(dir, first + '.json'), JSON.stringify({ parts: [first, second] }));
    library.remove('acme__model/' + first);
    assert.ok(!fs.readdirSync(dir).some(f => f.startsWith('big-')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('review: engine source checksum is enforced before any build command runs', async () => {
  const root = tmp();
  const engine = new Engine({ dir: root, library: {}, which: () => '/usr/bin/false', fetch: async () => new Response('untrusted archive') });
  try {
    await assert.rejects(engine.installEngine(), /SHA-256/);
    assert.equal(engine.installed(), false);
  } finally { engine.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('review: text extraction is bounded and malformed catalog values are ignored', async () => {
  const root = tmp();
  try {
    const file = path.join(root, 'large.log'); fs.writeFileSync(file, 'a'); fs.truncateSync(file, 20 * 1024 * 1024);
    assert.equal((await extractText(file)).length, 400000);
    const result = shorten({ anthropic: { models: { bad: null, alsoBad: { id: 42 }, good: { id: 'claude-test', name: {}, release_date: [], cost: { output: 'expensive' } } } } });
    assert.deepEqual(result.anthropic, [{ id: 'claude-test', name: 'claude-test', release: '', input: null, output: null, context: null }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('review: access permissions retain their original provider group across repeated switches', () => {
  const { root, store, thread, runner } = setup();
  runner.connections = () => [{ id: 'api', preset: 'custom', ready: true }, { id: 'claude-code', preset: 'claude-code', ready: true }, { id: 'codex', preset: 'codex', ready: true }];
  try {
    store.update(thread.id, { mode: 'full' });
    runner.setThreadSettings(thread.id, { connectionId: 'claude-code', model: '' });
    assert.equal(thread.mode, 'ask');
    runner.setThreadSettings(thread.id, { connectionId: 'codex', model: '' });
    assert.equal(thread.mode, 'ask');
    runner.setThreadSettings(thread.id, { connectionId: 'api', model: 'test' });
    assert.equal(thread.mode, 'full');
    runner.setThreadSettings(thread.id, { connectionId: 'claude-code', model: '' });
    assert.equal(thread.mode, 'ask');
    runner.setThreadSettings(thread.id, { mode: 'full' });
    runner.setThreadSettings(thread.id, { connectionId: 'codex', model: '' });
    assert.equal(thread.mode, 'full', 'explicit full CLI access stays full');
  } finally { store.flush(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('review: cancelling an engine source download aborts the network request', { timeout: 3000 }, async () => {
  const root = tmp(); let ready;
  const waiting = new Promise(resolve => { ready = resolve; });
  const engine = new Engine({ dir: root, library: {}, which: () => '/usr/bin/false', fetch: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }); ready();
  }) });
  try {
    const installing = engine.installEngine();
    const rejected = assert.rejects(installing, /abort/i);
    await waiting;
    engine.cancelInstall();
    await rejected;
    assert.equal(engine.installed(), false);
  } finally { engine.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('review: live CLI argv contains only a private MCP config path that is removed after the turn', async () => {
  const root = tmp(), home = process.env.HOME;
  const bin = path.join(root, '.local', 'bin'); fs.mkdirSync(bin, { recursive: true });
  const executable = path.join(bin, 'claude');
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const configPath = process.argv[process.argv.indexOf('--mcp-config') + 1];
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const reply = JSON.stringify({ configPath, mode: fs.statSync(configPath).mode & 511, secret: config.mcpServers.private.env.TOKEN, argv: process.argv });
require('node:readline').createInterface({ input: process.stdin }).on('line', () => {
 process.stdout.write(JSON.stringify({ type: 'result', result: reply }) + '\\n');
 process.exit(0);
});
`);
  fs.chmodSync(executable, 0o755);
  process.env.HOME = root; cli.cliPath('claude', true);
  try {
    const draft = new Draft();
    await cli.run({ preset: presets['claude-code'], thread: { mode: 'ask', model: '', effort: '' }, history: [], prompt: 'test', cwd: root,
      mcpServers: [{ name: 'private', transport: 'stdio', command: 'node', env: { TOKEN: 'orin-test-secret' } }],
      draft, signal: new AbortController().signal, onSession() {} });
    const reply = JSON.parse(draft.parts.find(p => p.type === 'text').text);
    assert.equal(reply.mode, 0o600);
    assert.equal(reply.secret, 'orin-test-secret');
    assert.ok(!JSON.stringify(reply.argv).includes('orin-test-secret'));
    assert.equal(fs.existsSync(reply.configPath), false);
  } finally { process.env.HOME = home; cli.cliPath('claude', true); fs.rmSync(root, { recursive: true, force: true }); }
});
