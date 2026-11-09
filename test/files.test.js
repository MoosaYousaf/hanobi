const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { Files, attachmentBlock, safeName, toHtml } = require('../electron/files');
const { extractText } = require('../electron/extract');
const { toProvider } = require('../electron/providers/transcript');
const { Store } = require('../electron/store');
const { Mcp } = require('../electron/mcp');
const { Runner } = require('../electron/runner');

const tmp = prefix => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('files: attach, write in each format, and only resolve paths of the thread and its workspace', async () => {
  const root = tmp('orin-files-'), workspace = tmp('orin-ws-'), outside = tmp('orin-out-');
  const printed = [];
  const files = new Files(root, { printPdf: async html => { printed.push(html); return Buffer.from('%PDF-1.4 fake'); } });
  try {
    fs.writeFileSync(path.join(outside, 'notes.md'), '# Notes\nShip it.');
    const [part] = await files.attach('t1', [path.join(outside, 'notes.md')]);
    assert.deepEqual({ ...part, path: undefined }, { type: 'file', name: 'notes.md', path: undefined, size: 16, mediaType: 'text/markdown' });
    assert.ok(part.path.startsWith(path.join(root, 't1', 'in') + path.sep));
    // The same name twice gets its own folder, so the first attachment stays.
    const [again] = await files.attach('t1', [path.join(outside, 'notes.md')]);
    assert.notEqual(again.path, part.path);
    const pasted = await files.attachData('t1', { name: '../../shot.png', data: PNG.toString('base64') });
    assert.equal(pasted.name, 'shot.png');
    assert.equal(pasted.mediaType, 'image/png');
    assert.ok(pasted.path.startsWith(path.join(root, 't1', 'in')));

    const csv = await files.write('t1', 'report.csv', 'a,b\n1,2\n');
    assert.equal(fs.readFileSync(csv.path, 'utf8'), 'a,b\n1,2\n');
    assert.equal((await files.write('t1', 'report.csv', 'x')).name, 'report 2.csv');
    const pdf = await files.write('t1', 'summary.pdf', '<h1>Summary</h1><p>Ship on <strong>Friday</strong>.</p>');
    assert.equal(fs.readFileSync(pdf.path, 'utf8'), '%PDF-1.4 fake');
    assert.match(printed[0], /<!doctype html>[\s\S]*<style>[\s\S]*<h1>Summary<\/h1>/);
    const html = await files.write('t1', 'page.html', '# Title\n\n- one\n- two');
    assert.match(fs.readFileSync(html.path, 'utf8'), /<h1>Title<\/h1>\n<ul><li>one<\/li><li>two<\/li><\/ul>/);
    await assert.rejects(files.write('t1', 'archive.zip', 'x'), /cannot make \.zip/);
    await assert.rejects(files.write('t1', '', 'x'), /Give the file a name/);
    if (process.platform === 'darwin') {
      const docx = await files.write('t1', 'memo.docx', '<h2>Memo</h2><p>Ship on Friday.</p><table><tr><td>Q3</td><td>Done</td></tr></table>');
      assert.equal(docx.mediaType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      assert.match(await extractText(docx.path), /Memo[\s\S]*Ship on Friday\.\nQ3\s+Done/);
    }

    fs.writeFileSync(path.join(workspace, 'app.js'), 'x');
    assert.equal(await files.resolve('t1', workspace, 'app.js'), path.join(workspace, 'app.js'));
    assert.equal(await files.resolve('t1', workspace, csv.path), csv.path);
    await assert.rejects(files.resolve('t1', workspace, path.join(outside, 'notes.md')), /only opens files/);
    await assert.rejects(files.resolve('t1', workspace, '../' + path.basename(outside) + '/notes.md'), /only opens files/);
    await assert.rejects(files.resolve('t2', workspace, csv.path), /only opens files/);
    fs.symlinkSync(path.join(outside, 'notes.md'), path.join(workspace, 'link.md'));
    await assert.rejects(files.resolve('t1', workspace, 'link.md'), /only opens files/);
    await assert.rejects(files.resolve('t1', workspace, 'gone.txt'), /no longer exists/);
    assert.throws(() => files.dir('../x', 'in'), /Invalid conversation/);

    await files.remove('t1');
    assert.ok(!fs.existsSync(path.join(root, 't1')));
  } finally { for (const d of [root, workspace, outside]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('files: names, simple Markdown to HTML, and attachment blocks for API and CLI prompts', async () => {
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('.env'), 'env');
  assert.throws(() => safeName('..'), /Give the file a name/);
  assert.equal(toHtml('<p>kept</p>'), '<p>kept</p>');
  assert.equal(toHtml('**Bold** & <x>'), '<p><strong>Bold</strong> &amp; &lt;x&gt;</p>');
  const parts = [
    { type: 'file', name: 'a.md', path: '/f/a.md', mediaType: 'text/markdown' },
    { type: 'file', name: 'scan.pdf', path: '/f/scan.pdf', mediaType: 'application/pdf' },
    { type: 'file', name: 'shot.png', path: '/f/shot.png', mediaType: 'image/png' }
  ];
  const texts = new Map([['/f/a.md', 'Alpha'], ['/f/scan.pdf', null]]);
  assert.equal(attachmentBlock(parts, texts), '<attachment name="a.md">\nAlpha\n</attachment>\n\n<attachment name="scan.pdf" type="application/pdf">No text could be read from this file.</attachment>');
  const cli = attachmentBlock(parts, texts, { paths: true });
  assert.match(cli, /<attachment name="a.md" path="\/f\/a.md">\nAlpha/);
  assert.match(cli, /<attachment name="shot.png" path="\/f\/shot.png" type="image\/png">An image\. Open it from its path\.<\/attachment>/);
});

// One tool turn that makes a file, then a text turn. Records each request.
function fakeAnthropic() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const request = JSON.parse(body);
      requests.push(request);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
      const usage = { input_tokens: 10, output_tokens: 5 };
      send('message_start', { message: { id: 'm' + requests.length, type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, usage } });
      if (requests.length === 1) {
        send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'orin__write_file', input: {} } });
        send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ name: 'totals.csv', content: 'region,total\nNorth,12\n' }) } });
        send('content_block_stop', { index: 0 });
        send('message_delta', { delta: { stop_reason: 'tool_use' }, usage });
      } else {
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Here is totals.csv.' } });
        send('content_block_stop', { index: 0 });
        send('message_delta', { delta: { stop_reason: 'end_turn' }, usage });
      }
      send('message_stop', {});
      res.end();
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })));
}

test('runner: attachments reach the API model as text and images, and write_file makes a file part', async () => {
  const root = tmp('orin-run-files-'), src = tmp('orin-src-');
  const fake = await fakeAnthropic();
  process.env.ANTHROPIC_BASE_URL = fake.url;
  const data = { 'key:a': 'sk-test' };
  const secrets = { get: k => data[k] ?? null, has: k => k in data, set() {}, available: () => true };
  const store = new Store(path.join(root, 'data.json'));
  const mcp = new Mcp({ store, secrets, openExternal() {}, onChange() {} });
  const files = new Files(path.join(root, 'Files'));
  let runner;
  const done = new Promise(resolve => { runner = new Runner({ store, secrets, mcp, files, send: (c, v) => { if (c === 'run-state' && !v.running) resolve(v); } }); });
  try {
    store.data.connections.push({ id: 'a', preset: 'anthropic', name: 'Anthropic API', baseURL: '' });
    const thread = store.addThread(store.addWorkspace(root).id, { connectionId: 'a', model: 'claude-opus-5-5', effort: 'low', mode: 'ask' });
    fs.writeFileSync(path.join(src, 'sales.csv'), 'region,amount\nNorth,7\nNorth,5\n');
    fs.writeFileSync(path.join(src, 'chart.png'), PNG);
    const attached = await files.attach(thread.id, [path.join(src, 'sales.csv'), path.join(src, 'chart.png')]);
    assert.throws(() => runner.start(thread.id, { text: 'x', files: [{ path: path.join(src, 'sales.csv'), name: 'sales.csv' }] }), /Attach sales\.csv again/);
    runner.start(thread.id, { text: 'Total by region as a CSV file.', files: attached.map(({ path, name }) => ({ path, name })) });
    assert.equal((await done).error, undefined);
    const user = fake.requests[0].messages[0].content;
    assert.deepEqual(user.map(b => b.type), ['image', 'text']);
    assert.equal(user[0].source.data, PNG.toString('base64'));
    assert.equal(user[1].text, '<attachment name="sales.csv">\nregion,amount\nNorth,7\nNorth,5\n\n</attachment>\n\nTotal by region as a CSV file.');
    assert.ok(fake.requests[0].tools.some(t => t.name === 'orin__write_file'));
    const messages = store.thread(thread.id).messages;
    assert.deepEqual(messages[0].parts.map(p => p.type), ['file', 'file', 'text']);
    const reply = messages.at(-1);
    assert.deepEqual(reply.parts.map(p => p.type), ['tool', 'file', 'text']);
    const made = reply.parts[1];
    assert.equal(made.name, 'totals.csv');
    assert.equal(fs.readFileSync(made.path, 'utf8'), 'region,total\nNorth,12\n');
    assert.match(reply.parts[0].output, /Saved totals\.csv/);
    // A later turn on another provider still sees the attachment through the transcript.
    const replay = toProvider(messages, 'openai', await files.promptTexts(messages));
    assert.match(replay[0].content.find(b => b.type === 'text').text, /<attachment name="sales.csv">/);
    assert.match(replay[1].content, /\[File totals\.csv\]/);
  } finally {
    delete process.env.ANTHROPIC_BASE_URL;
    await mcp.closeAll();
    fake.server.close();
    for (const d of [root, src]) fs.rmSync(d, { recursive: true, force: true });
  }
});
