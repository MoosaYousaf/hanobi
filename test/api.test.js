const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Store } = require('../electron/store');
const { Mcp } = require('../electron/mcp');
const { Runner } = require('../electron/runner');

// Streams a tool call on the first request and a text answer once a tool result is present.
function fakeOpenAI() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.url.endsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] })); return; }
      const request = JSON.parse(body);
      requests.push(request);
      // A non-streaming request is the suggested-replies side request.
      if (!request.stream) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: 'y', object: 'chat.completion', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Here you go:\n```json\n["Ship it today", "Open the note", "Ship it today"]\n```' } }] })); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = delta => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, ...delta }] })}\n\n`);
      if (request.messages.some(m => m.role === 'tool')) {
        chunk({ delta: { content: 'The note says ' } });
        chunk({ delta: { content: 'ship on Friday.' }, finish_reason: 'stop' });
      } else {
        chunk({ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'notes__read_note', arguments: '{"name":' } }] } });
        chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: '"plan"}' } }] }, finish_reason: 'tool_calls' });
      }
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

const memorySecrets = () => { const data = {}; return { get: k => data[k] ?? null, has: k => k in data, set: (k, v) => { if (v == null) delete data[k]; else data[k] = v; }, available: () => true }; };

test('an OpenAI-compatible model calls an MCP tool after approval and the reply is saved', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hanobi-api-'));
  const fake = await fakeOpenAI();
  const events = [];
  const store = new Store(path.join(root, 'data.json'));
  const secrets = memorySecrets();
  const mcp = new Mcp({ store, secrets, openExternal: () => {}, onChange: () => {} });
  let runner;
  const done = new Promise(resolve => {
    runner = new Runner({ store, secrets, mcp, send: (channel, value) => {
      events.push([channel, value]);
      if (channel === 'approval') setImmediate(() => runner.answer(value.id, 'allow'));
      if (channel === 'run-state' && !value.running) resolve(value);
    } });
  });
  try {
    store.data.connections.push({ id: 'local', preset: 'custom', name: 'Fake', baseURL: fake.url });
    store.data.mcpServers.push({ id: 'n', name: 'Notes', transport: 'stdio', command: process.execPath, args: [path.join(__dirname, 'fixtures/notes-server.cjs')], enabled: true });
    assert.deepEqual((await runner.refreshModels('local')).map(m => m.id), ['fake-model']);
    const workspace = store.addWorkspace(root);
    const thread = store.addThread(workspace.id, { connectionId: 'local', model: 'fake-model', effort: '', mode: 'ask' });
    runner.start(thread.id, { text: 'What does the plan note say?' });
    const end = await done;
    assert.equal(end.error, undefined);
    const approval = events.find(([c]) => c === 'approval')[1];
    assert.equal(approval.server, 'Notes');
    assert.deepEqual(approval.input, { name: 'plan' });
    const reply = store.thread(thread.id).messages.at(-1);
    assert.deepEqual(reply.parts.map(p => p.type), ['tool', 'text']);
    assert.equal(reply.parts[0].output, 'Note plan: ship on Friday');
    assert.equal(reply.parts[1].text, 'The note says ship on Friday.');
    // The second request carried the tool call and its result in OpenAI format.
    assert.deepEqual(fake.requests[1].messages.slice(-2).map(m => m.role), ['assistant', 'tool']);
    assert.equal(fake.requests[0].tools[0].function.name, 'notes__read_note');
    // A follow-up turn replays the native messages, not a text summary.
    assert.equal(reply.native.format, 'openai');
    assert.throws(() => runner.start(thread.id, { text: '' }), /Write a message/);
  } finally {
    await mcp.closeAll();
    fake.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a denied tool call returns a refusal to the model', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hanobi-deny-'));
  const fake = await fakeOpenAI();
  const store = new Store(path.join(root, 'data.json'));
  const secrets = memorySecrets();
  const mcp = new Mcp({ store, secrets, openExternal: () => {}, onChange: () => {} });
  let runner;
  const done = new Promise(resolve => {
    runner = new Runner({ store, secrets, mcp, send: (channel, value) => {
      if (channel === 'approval') setImmediate(() => runner.answer(value.id, 'deny'));
      if (channel === 'run-state' && !value.running) resolve(value);
    } });
  });
  try {
    store.data.connections.push({ id: 'local', preset: 'custom', name: 'Fake', baseURL: fake.url });
    store.data.mcpServers.push({ id: 'n', name: 'Notes', transport: 'stdio', command: process.execPath, args: [path.join(__dirname, 'fixtures/notes-server.cjs')], enabled: true });
    const thread = store.addThread(store.addWorkspace(root).id, { connectionId: 'local', model: 'fake-model', effort: '', mode: 'ask' });
    runner.start(thread.id, { text: 'Read the plan note.' });
    await done;
    const reply = store.thread(thread.id).messages.at(-1);
    assert.equal(reply.parts[0].status, 'denied');
    assert.equal(fake.requests[1].messages.at(-1).content, 'The user declined this tool call.');
  } finally {
    await mcp.closeAll();
    fake.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('suggested replies: one extra request after an API reply, saved on that reply when the setting is on', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hanobi-suggest-'));
  const fake = await fakeOpenAI();
  const store = new Store(path.join(root, 'data.json'));
  const secrets = memorySecrets();
  let finished = false;
  const suggested = new Promise(resolve => {
    const runner = new Runner({ store, secrets, mcp: { tools: async () => [] }, send: (channel, value) => {
      if (channel === 'run-state' && !value.running) finished = true;
      else if (channel === 'thread-changed' && finished && store.thread(value.threadId).messages.at(-1).suggestions) resolve();
    } });
    store.data.connections.push({ id: 'local', preset: 'custom', name: 'Fake', baseURL: fake.url });
    store.data.preferences.suggestReplies = true;
    const thread = store.addThread(store.addWorkspace(root).id, { connectionId: 'local', model: 'fake-model', effort: '', mode: 'full' });
    runner.start(thread.id, { text: 'What does the plan note say?' });
  });
  try {
    await suggested;
    const reply = store.data.threads[0].messages.at(-1);
    assert.deepEqual(reply.suggestions, ['Ship it today', 'Open the note']);
    const side = fake.requests.at(-1);
    assert.equal(side.stream, undefined);
    assert.match(side.messages[0].content, /What does the plan note say\?/);
  } finally {
    fake.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
