const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Engine, contextFor, deploymentTarget, buildProgress } = require('../electron/llama');
const { Library } = require('../electron/hf');

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const fixtures = path.join(__dirname, 'fixtures');
const GB = 1e9;

// A source "tarball" with one file, served by a fake fetch.
function sourceFetch() {
  const dir = tmp('orin-src-'), pack = tmp('orin-pack-');
  fs.mkdirSync(path.join(pack, 'llama.cpp-b1'));
  fs.writeFileSync(path.join(pack, 'llama.cpp-b1', 'CMakeLists.txt'), '# fake');
  execFileSync('tar', ['-czf', path.join(dir, 'src.tgz'), '-C', pack, 'llama.cpp-b1']);
  const bytes = fs.readFileSync(path.join(dir, 'src.tgz'));
  const urls = [];
  const fetch = async (url, options) => {
    if (String(url).includes('/health')) return globalThis.fetch(url, options);
    urls.push(String(url));
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  };
  return { fetch, urls };
}
function setup(extra = {}) {
  const dir = tmp('orin-engine-'), root = tmp('orin-lib-');
  const library = new Library({ root });
  const model = 'acme__tiny/tiny-Q4_K_M.gguf';
  fs.mkdirSync(path.join(root, 'acme__tiny'));
  fs.writeFileSync(path.join(root, model), 'GGUF');
  fs.writeFileSync(`${path.join(root, model)}.json`, JSON.stringify({ repo: 'acme/tiny', quant: 'Q4_K_M', at: 1 }));
  const changes = [];
  const which = name => (name === 'cmake' ? path.join(fixtures, 'fake-cmake.cjs') : name === 'c++' ? '/usr/bin/c++' : null);
  const engine = new Engine({ dir, library, which, onChange: s => changes.push(s), ...sourceFetch(), ...extra });
  return { engine, dir, model, changes, library };
}

test('engine: context by RAM, the macOS target of the build, and ninja or make progress', () => {
  assert.deepEqual([8, 16, 32].map(g => contextFor(g * 1.07 * GB)), [4096, 8192, 16384]);
  assert.deepEqual(['21.6.0', '23.1.0', '19.0.0'].map(deploymentTarget), ['12.0', '14.0', '11.0']);
  assert.equal(buildProgress('[33/181] Linking CXX'), 33 / 181);
  assert.equal(buildProgress('[ 45%] Building C object'), 0.45);
  assert.equal(buildProgress('nothing here'), null);
  assert.equal(buildProgress('[1/4] a\n[3/4] b\n'), 0.75);
});

test('engine: it builds the pinned release from outside the source folder, with the flags this Mac needs', async () => {
  const { engine, dir, changes } = setup();
  const log = path.join(tmp('orin-log-'), 'cmake.log');
  process.env.FAKE_CMAKE_LOG = log;
  try {
    assert.equal(engine.installed(), false);
    await engine.installEngine();
    assert.equal(engine.installed(), true);
    assert.deepEqual(engine.status().install, null);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'engine.json'), 'utf8')).tag, engine.tag);
    assert.ok(!fs.existsSync(path.join(dir, 'build')), 'the build folder is deleted');
    const [configure, build] = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(configure.sourceFiles, ['CMakeLists.txt']);
    assert.ok(!configure.cwd.includes(`${path.sep}src`), 'the tools do not run inside the downloaded source');
    for (const flag of ['-DLLAMA_BUILD_UI=OFF', '-DLLAMA_USE_PREBUILT_UI=OFF', '-DLLAMA_OPENSSL=OFF', '-DBUILD_SHARED_LIBS=OFF', '-DCMAKE_BUILD_TYPE=Release', `-DCMAKE_OSX_DEPLOYMENT_TARGET=${deploymentTarget(os.release())}`]) assert.ok(configure.args.includes(flag), flag);
    assert.deepEqual(build.args.slice(0, 1).concat(build.args.slice(2, 4)), ['--build', '--target', 'llama-server']);
    // Chunking decides which progress lines the parser sees, so only the range, the end, and the steps are fixed.
    const shown = changes.map(c => c.install?.progress).filter(p => p != null);
    assert.ok(shown.every(p => p >= 0 && p <= 1) && shown.at(-1) === 1, `progress ${shown}`);
    const steps = [...new Set(changes.map(c => c.install?.step).filter(Boolean))];
    assert.deepEqual(steps.map(s => s.split(' ')[0]), ['Checking', 'Downloading', 'Building']);
    // A second engine on the same folder finds the installed one.
    assert.equal(new Engine({ dir, library: engine.library }).installed(), true);
  } finally { delete process.env.FAKE_CMAKE_LOG; engine.close(); }
});

test('engine: a missing tool or a compiler error is reported, and a new try can follow', async () => {
  const log = path.join(tmp('orin-log-'), 'cmake.log');
  process.env.FAKE_CMAKE_LOG = log;
  const none = setup({ which: () => null });
  await assert.rejects(none.engine.installEngine(), /Xcode Command Line Tools/);
  assert.match(none.engine.status().install.error, /CMake/);
  const bad = setup();
  process.env.FAKE_CMAKE_FAIL = '1';
  try {
    await assert.rejects(bad.engine.installEngine(), /build failed: .*unknown type name/);
    assert.equal(bad.engine.installed(), false);
    delete process.env.FAKE_CMAKE_FAIL;
    await bad.engine.installEngine();
    assert.equal(bad.engine.installed(), true);
  } finally { delete process.env.FAKE_CMAKE_FAIL; delete process.env.FAKE_CMAKE_LOG; for (const s of [none, bad]) s.engine.close(); }
});

test('engine: use() loads one model at a time, keeps the server while a reply runs, and stops it when idle', async () => {
  const { engine, dir, model, library } = setup({ idleMs: 50 });
  fs.copyFileSync(path.join(fixtures, 'fake-llama-server.cjs'), path.join(dir, 'llama-server'));
  fs.chmodSync(path.join(dir, 'llama-server'), 0o755);
  fs.writeFileSync(path.join(dir, 'engine.json'), JSON.stringify({ tag: 'b1' }));
  engine.info = { tag: 'b1' };
  try {
    const notes = [];
    const url = await engine.use(model, { onStatus: s => notes.push(s) });
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    assert.match(notes[0], /Loading tiny-Q4_K_M\.gguf/);
    const reply = await (await fetch(`${url}/chat/completions`, { method: 'POST', body: JSON.stringify({ model, stream: true, messages: [] }) })).text();
    assert.match(reply, new RegExp(`local ${model.replace('/', '\\/')} ctx=${contextFor(os.totalmem())} parallel=1 `));
    // The same model again reuses the server.
    const again = await engine.use(model);
    assert.equal(again, url);
    // One reply still runs: the idle check keeps the server however long ago the last use was.
    engine.done();
    engine.lastUse = 0;
    await engine.checkIdle();
    assert.equal(engine.status().server.ready, true);
    engine.done();
    await new Promise(r => setTimeout(r, 80));
    await engine.checkIdle();
    assert.equal(engine.status().server, null);
    // Errors: an unknown model, a stop while loading, and a server that fails to load.
    await assert.rejects(engine.use('acme__tiny/missing.gguf'), /not downloaded/);
    const stopper = new AbortController();
    const pending = engine.use(model, { signal: stopper.signal });
    stopper.abort();
    await assert.rejects(pending, /Stopped/);
    assert.equal(engine.busy, 0);
    await engine.stop();
    process.env.FAKE_LLAMA_FAIL = '1';
    await assert.rejects(engine.use(model), /local engine stopped: error: failed to load model: bad magic/);
    assert.equal(engine.busy, 0);
    assert.equal(engine.status().server, null);
    delete process.env.FAKE_LLAMA_FAIL;
    // Removing the engine's model while it is not loaded is plain library work.
    library.remove(model);
    await assert.rejects(engine.use(model), /not downloaded/);
    const uninstalled = new Engine({ dir: tmp('orin-empty-'), library });
    await assert.rejects(uninstalled.use(model), /Install the local engine/);
    uninstalled.close();
  } finally { delete process.env.FAKE_LLAMA_FAIL; await engine.stop(); engine.close(); }
});

test('local models: a conversation on a downloaded model loads the engine, streams the reply, and frees it', async () => {
  const { Store } = require('../electron/store');
  const { Runner } = require('../electron/runner');
  const { engine, dir, model, library } = setup();
  fs.copyFileSync(path.join(fixtures, 'fake-llama-server.cjs'), path.join(dir, 'llama-server'));
  fs.chmodSync(path.join(dir, 'llama-server'), 0o755);
  fs.writeFileSync(path.join(dir, 'engine.json'), JSON.stringify({ tag: 'b1' }));
  engine.info = { tag: 'b1' };
  const store = new Store(path.join(tmp('orin-local-data-'), 'data.json'));
  const workspace = store.addWorkspace(tmp('orin-local-ws-'));
  const thread = store.addThread(workspace.id, { connectionId: 'orin-local', model, effort: '', mode: 'ask' });
  let done;
  const runner = new Runner({ store, secrets: { get: () => null, has: () => false }, mcp: { tools: async () => [] }, local: { engine, library }, send: (c, v) => { if (c === 'run-state' && !v.running) done(v); } });
  try {
    const local = runner.connections().find(c => c.id === 'orin-local');
    assert.deepEqual([local.ready, local.route, local.detail], [true, 'local', 'Runs on this Mac']);
    assert.deepEqual(runner.models('orin-local'), [{ id: model, label: 'tiny · Q4_K_M' }]);
    const end = new Promise(r => { done = r; });
    runner.start(thread.id, { text: 'hello' });
    assert.equal((await end).error, undefined);
    const reply = store.thread(thread.id).messages.at(-1);
    assert.equal(reply.connectionId, 'orin-local');
    assert.match(reply.parts.find(p => p.type === 'thinking').text, /Loading tiny-Q4_K_M\.gguf into memory/);
    assert.match(reply.parts.find(p => p.type === 'text').text, new RegExp(`^local ${model.replace('/', '\\/')} ctx=\\d+ parallel=1 model=${model.replace('/', '\\/')} tools=0$`));
    assert.equal(engine.busy, 0);
    assert.equal(engine.status().server.ready, true);
    // Without the engine or without models the connection is not ready, and the reason says what to do.
    const bare = new Runner({ store, secrets: {}, mcp: {}, local: { engine: new Engine({ dir: tmp('orin-bare-'), library }), library }, send() {} });
    assert.match(bare.connections().find(c => c.id === 'orin-local').detail, /Install the local engine/);
    library.remove(model);
    assert.match(runner.connections().find(c => c.id === 'orin-local').detail, /Download a model/);
    await assert.rejects(async () => runner.start(thread.id, { text: 'again' }), /Download a model/);
  } finally { await engine.stop(); engine.close(); }
});

test('overseer: a local model needs a reply or a choice before it may be routed to', () => {
  const overseer = require('../electron/overseer');
  const { presets } = require('../electron/providers/catalog');
  const connections = [{ id: 'orin-local', preset: 'orin-local', name: 'On this Mac', route: 'local', ready: true }];
  const modelsOf = () => [{ id: 'acme__tiny/tiny-Q4_K_M.gguf', label: 'tiny' }];
  assert.deepEqual(overseer.candidates({ connections, modelsOf, presets }), []);
  const on = overseer.candidates({ connections, modelsOf, presets, prefs: { include: ['orin-local::acme__tiny/tiny-Q4_K_M.gguf'] } });
  assert.deepEqual(on.map(c => [c.tier, c.price]), [['fast', 0]]);
  assert.equal(overseer.candidates({ connections, modelsOf, presets, used: new Set(['orin-local']) }).length, 1);
});
