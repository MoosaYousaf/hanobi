const test = require('node:test');
const assert = require('node:assert/strict');
const overseer = require('../electron/overseer');
const { presets } = require('../electron/providers/catalog');
const { mapMode } = require('../electron/runner');

const connections = [
  { id: 'claude-code', preset: 'claude-code', name: 'Claude Code', route: 'subscription', ready: true },
  { id: 'codex', preset: 'codex', name: 'Codex', route: 'subscription', ready: true },
  { id: 'gemini', preset: 'gemini', name: 'Gemini CLI', route: 'subscription', ready: false },
  { id: 'k1', preset: 'openai', name: 'OpenAI', route: 'key', ready: true }
];
const modelsOf = id => (presets[id]?.models || [{ id: 'gpt-x-mini', label: 'mini' }]);
const used = new Set(['claude-code', 'codex']);
const list = overseer.candidates({ connections, modelsOf, presets, used });
const limits = readings => async cli => readings[cli] || null;
const decide = (text, extra = {}) => overseer.decide({ text, workspaceKind: 'code', list, readLimits: limits({}), prefs: { router: 'rules' }, ...extra });

test('overseer: candidates skip CLI defaults, missing or unused CLIs, paid keys (unless allowed), and excluded models', () => {
  assert.ok(list.every(c => c.model && c.on && c.connectionId !== 'gemini' && c.connectionId !== 'k1'));
  assert.equal(list.length, 8);
  assert.ok(overseer.candidates({ connections, modelsOf, presets, used, prefs: { allowPaid: true } }).some(c => c.connectionId === 'k1'));
  assert.ok(!overseer.candidates({ connections, modelsOf, presets, used, prefs: { exclude: ['codex::gpt-6-luna'] } }).some(c => c.id === 'codex::gpt-6-luna'));
  // A CLI with no reply yet is off unless the user included its model; the settings list shows it as off.
  assert.deepEqual(overseer.candidates({ connections, modelsOf, presets, used: new Set(['codex']), prefs: { include: ['claude-code::claude-haiku-5-5'] } }).filter(c => c.connectionId === 'claude-code').map(c => c.model), ['claude-haiku-5-5']);
  const all = overseer.candidates({ connections, modelsOf, presets, used: new Set(), all: true });
  assert.ok(all.length === 8 && all.every(c => !c.on));
  assert.equal(overseer.tierOf('llama-3.1-8b', 'key'), 'fast');
  assert.equal(overseer.tierOf('anything', 'local'), 'fast');
  assert.equal(overseer.tierOf('gemini-3-flash-preview', 'key'), 'fast');
  assert.equal(overseer.tierOf('gemini-3.1-pro-preview', 'key'), 'top');
  assert.equal(overseer.tierOf('gpt-4o-mini', 'key'), 'fast');
});

test('overseer: tasks are quick, normal, or hard', () => {
  assert.equal(overseer.classify('what is a monad?', { workspaceKind: 'chats' }), 'quick');
  assert.equal(overseer.classify('add a --verbose flag to the cli', { workspaceKind: 'code' }), 'normal');
  assert.equal(overseer.classify('debug why the tests hang on CI', { workspaceKind: 'code' }), 'hard');
  assert.equal(overseer.classify('x'.repeat(2000)), 'hard');
});

test('overseer: rules pick the tier and effort, and plan limits move work to another plan', async () => {
  const hard = await decide('design the plugin architecture');
  assert.deepEqual([hard.connectionId, hard.model, hard.effort, hard.by], ['claude-code', 'claude-opus-5-5', 'high', 'rules']);
  const normal = await decide('rename the helper to parseArgs');
  assert.equal(normal.model, 'claude-sonnet-5-5');
  // Claude at 85%: soft limit, so Codex takes the work. At 95% Claude is out even when Codex is busy too.
  const busy = await decide('design the plugin architecture', { readLimits: limits({ claude: { windows: [{ id: 'five_hour', used: 85 }] } }) });
  assert.equal(busy.connectionId, 'codex');
  const full = await decide('design it', { readLimits: limits({ claude: { windows: [{ id: 'five_hour', used: 95 }] }, codex: { windows: [{ id: 'primary', used: 85 }] } }) });
  assert.equal(full.connectionId, 'codex');
  assert.equal(await decide('hi', { readLimits: limits({ claude: { windows: [{ id: 'w', used: 99 }] }, codex: { windows: [{ id: 'w', used: 99 }] } }) }), null);
  // A model-family window only counts for that family.
  assert.equal(overseer.planUse({ windows: [{ id: 'five_hour', used: 10 }, { id: 'seven_day_opus', used: 92 }] }, 'claude-sonnet-5-5'), 10);
});

test('overseer: the same kind of task stays on the model without a router call; a new task asks the router', async () => {
  let calls = 0;
  const complete = async prompt => { calls++; assert.match(prompt, /codex::gpt-6.1-terra/); return 'Sure: {"id": "codex::gpt-6.1-terra", "effort": "medium", "reason": "Routine edit"}'; };
  const previous = { connectionId: 'claude-code', model: 'claude-sonnet-5-5', effort: 'medium', kind: 'normal' };
  const same = await decide('rename the helper to parseArgs', { previous, complete, prefs: {} });
  assert.deepEqual([same.model, same.by, calls], ['claude-sonnet-5-5', 'same', 0]);
  const routed = await decide('debug the flaky test', { previous, complete, prefs: {} });
  assert.deepEqual([routed.connectionId, routed.model, routed.effort, routed.by, routed.reason, calls], ['codex', 'gpt-6.1-terra', 'medium', 'router', 'Routine edit', 1]);
});

test('overseer: a wrong, failed, or slow router falls back to the rules', async () => {
  for (const complete of [async () => '{"id": "nope::model"}', async () => 'no json', async () => { throw new Error('CLI failed'); }]) {
    const route = await decide('debug the flaky test', { complete, prefs: {} });
    assert.equal(route.by, 'rules');
    assert.equal(route.model, 'claude-opus-5-5');
  }
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(decide('debug it', { prefs: {}, signal: stopped.signal, complete: async (p, signal) => { signal.throwIfAborted(); } }));
});

test('overseer: access modes map to the closest mode of each provider', () => {
  assert.equal(mapMode('auto', presets['claude-code']), 'auto');
  assert.equal(mapMode('auto', presets.anthropic), 'ask');
  assert.equal(mapMode('full', presets.anthropic), 'full');
  assert.equal(mapMode('ask', presets.gemini), 'default');
});

test('overseer: a turn routes through the router model, runs on the chosen model, and the next same task skips the router', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { Store } = require('../electron/store');
  const { Runner } = require('../electron/runner');
  const cli = require('../electron/providers/cli');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orin-overseer-')), bin = path.join(home, '.local/bin'), saved = { HOME: process.env.HOME, ROUTER_LOG: process.env.ROUTER_LOG };
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures/fake-router-claude.cjs'), path.join(bin, 'claude'));
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  Object.assign(process.env, { HOME: home, ROUTER_LOG: path.join(home, 'router.log') });
  try {
    cli.cliPath('claude', true); cli.cliPath('codex', true);
    const store = new Store(path.join(home, 'data.json'));
    const workspace = store.addWorkspace(fs.mkdtempSync(path.join(os.tmpdir(), 'orin-overseer-ws-')));
    const thread = store.addThread(workspace.id, { connectionId: 'claude-code', model: 'claude-opus-5-5', effort: '', mode: 'auto' });
    let done;
    const runner = new Runner({ store, secrets: { get: () => null, has: () => false }, mcp: { enabledConfigs: () => [] }, send: (c, v) => { if (c === 'run-state' && !v.running) done(v); } });
    store.data.preferences.overseer = { include: ['claude-code::claude-opus-5-5', 'claude-code::claude-sonnet-5-5', 'claude-code::claude-haiku-5-5'] };
    runner.setThreadSettings(thread.id, { overseer: true });
    assert.equal(store.thread(thread.id).overseer, true);
    const turn = async text => { const end = new Promise(r => { done = r; }); runner.start(thread.id, { text }); assert.equal((await end).error, undefined); return store.thread(thread.id).messages.at(-1); };
    const first = await turn('add a --verbose flag to the cli');
    assert.equal(first.model, 'claude-sonnet-5-5');
    assert.deepEqual(first.route, { reason: 'Fake router', by: 'router', effort: 'low' });
    assert.match(first.parts.at(-1).text, /--model claude-sonnet-5-5/);
    const second = await turn('also add a --quiet flag to the cli');
    assert.equal(second.route.by, 'same');
    assert.equal(fs.readFileSync(process.env.ROUTER_LOG, 'utf8'), 'route\n');
    // Choosing a model by hand turns the Overseer off.
    runner.setThreadSettings(thread.id, { connectionId: 'claude-code', model: 'claude-opus-5-5' });
    assert.equal(store.thread(thread.id).overseer, false);
  } finally {
    Object.assign(process.env, saved); if (!saved.ROUTER_LOG) delete process.env.ROUTER_LOG;
    cli.cliPath('claude', true); cli.cliPath('codex', true);
  }
});
