const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Store } = require('../electron/store');
const { Mcp } = require('../electron/mcp');
const { Runner } = require('../electron/runner');

// Speaks the Messages API SSE format: a tool_use turn first, then a text turn.
function fakeAnthropic() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const request = JSON.parse(body);
      requests.push({ headers: req.headers, body: request });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
      const usage = { input_tokens: 10, output_tokens: 5 };
      send('message_start', { message: { id: 'msg_' + requests.length, type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, usage } });
      const toolTurn = !request.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'));
      if (toolTurn) {
        send('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
        send('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Check the note.' } });
        send('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig' } });
        send('content_block_stop', { index: 0 });
        send('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'notes__read_note', input: {} } });
        send('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"name":"plan"}' } });
        send('content_block_stop', { index: 1 });
        send('message_delta', { delta: { stop_reason: 'tool_use' }, usage });
      } else {
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Ship on Friday.' } });
        send('content_block_stop', { index: 0 });
        send('message_delta', { delta: { stop_reason: 'end_turn' }, usage });
      }
      send('message_stop', {});
      res.end();
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })));
}

test('the Anthropic adapter streams thinking, runs a tool, and replays thinking blocks unchanged', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hanobi-anthropic-'));
  const fake = await fakeAnthropic();
  process.env.ANTHROPIC_BASE_URL = fake.url;
  const data = { 'key:a': 'sk-test' };
  const secrets = { get: k => data[k] ?? null, has: k => k in data, set: (k, v) => { data[k] = v; }, available: () => true };
  const store = new Store(path.join(root, 'data.json'));
  const mcp = new Mcp({ store, secrets, openExternal: () => {}, onChange: () => {} });
  let runner;
  const done = new Promise(resolve => { runner = new Runner({ store, secrets, mcp, send: (c, v) => { if (c === 'run-state' && !v.running) resolve(v); } }); });
  try {
    store.data.connections.push({ id: 'a', preset: 'anthropic', name: 'Anthropic API', baseURL: '' });
    store.data.mcpServers.push({ id: 'n', name: 'Notes', transport: 'stdio', command: process.execPath, args: [path.join(__dirname, 'fixtures/notes-server.cjs')], enabled: true });
    const thread = store.addThread(store.addWorkspace(root).id, { connectionId: 'a', model: 'claude-opus-5-5', effort: 'high', mode: 'full' });
    runner.start(thread.id, { text: 'What does the plan note say?' });
    const end = await done;
    assert.equal(end.error, undefined);
    const first = fake.requests[0];
    assert.ok(first.headers['x-api-key'] === 'sk-test' || first.headers.authorization === 'Bearer sk-test');
    assert.match(first.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
    assert.equal(first.body.fallbacks, 'default');
    assert.deepEqual(first.body.output_config, { effort: 'high' });
    assert.deepEqual(first.body.thinking, { type: 'adaptive', display: 'summarized' });
    assert.equal(first.body.tools[0].eager_input_streaming, true);
    // The second request sends the thinking block back exactly, then the tool result.
    const second = fake.requests[1].body.messages;
    assert.deepEqual(second[1].content[0], { type: 'thinking', thinking: 'Check the note.', signature: 'sig' });
    assert.deepEqual(second[2].content[0], { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Note plan: ship on Friday' });
    const reply = store.thread(thread.id).messages.at(-1);
    assert.deepEqual(reply.parts.map(p => p.type), ['thinking', 'tool', 'text']);
    assert.equal(reply.parts.at(-1).text, 'Ship on Friday.');
  } finally {
    delete process.env.ANTHROPIC_BASE_URL;
    await mcp.closeAll();
    fake.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
