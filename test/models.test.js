const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Models, parse } = require('../electron/models');

const tmp = prefix => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const url = file => `hanobi-model://hf/onnx-community/whisper-tiny/resolve/main/${file}`;

test('models: only Whisper files of allowed repositories can be asked for', () => {
  assert.deepEqual(parse(url('onnx/encoder_model_quantized.onnx')), { repo: 'onnx-community/whisper-tiny', file: 'onnx/encoder_model_quantized.onnx' });
  assert.equal(parse('hanobi-model://hf/someone/else/resolve/main/config.json'), null);
  assert.equal(parse(url('../../secrets.json')), null);
  assert.equal(parse(url('%2e%2e/x.json')), null);
  assert.equal(parse(url('a/b/c.json')), null);
  assert.equal(parse('https://huggingface.co/onnx-community/whisper-tiny/resolve/main/config.json'), null);
});

test('models: one download per file, progress, ranges, and 404 pass through', async () => {
  const root = tmp('hanobi-models-');
  const body = Buffer.from('{"model_type":"whisper"}');
  const asked = [], progress = [];
  const fetch = async address => {
    asked.push(address);
    await new Promise(r => setTimeout(r, 30));
    if (address.endsWith('/processor_config.json')) return new Response('missing', { status: 404 });
    if (address.endsWith('/broken.json')) return new Response('nope', { status: 500 });
    return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
  };
  const models = new Models(root, { fetch, onProgress: p => progress.push(p) });
  try {
    const [a, b] = await Promise.all([models.handle(new Request(url('config.json'))), models.handle(new Request(url('config.json')))]);
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.equal(await a.text(), body.toString());
    assert.deepEqual(asked, ['https://huggingface.co/onnx-community/whisper-tiny/resolve/main/config.json']);
    assert.ok(progress.at(-1).done && progress.at(-1).loaded === body.length);
    assert.ok(!fs.existsSync(path.join(root, 'onnx-community/whisper-tiny/config.json.part')));
    // Cached now: no second request.
    assert.equal((await models.handle(new Request(url('config.json')))).status, 200);
    assert.equal(asked.length, 1);
    const head = await models.handle(new Request(url('config.json'), { headers: { Range: 'bytes=0-0' } }));
    assert.equal(head.status, 206);
    assert.equal(head.headers.get('content-range'), `bytes 0-0/${body.length}`);
    assert.equal(await head.text(), '{');
    assert.equal((await models.handle(new Request(url('processor_config.json')))).status, 404);
    assert.equal((await models.handle(new Request(url('broken.json')))).status, 502);
    assert.equal((await models.handle(new Request('hanobi-model://hf/evil/repo/resolve/main/x.json'))).status, 403);
    const listed = await models.list();
    assert.deepEqual(listed.map(m => [m.id, m.downloaded]), [['onnx-community/whisper-tiny', true], ['onnx-community/whisper-base', false], ['onnx-community/whisper-small', false]]);
    assert.equal(listed[0].bytes, body.length);
    await models.remove('onnx-community/whisper-tiny');
    assert.equal((await models.list())[0].downloaded, false);
    await assert.rejects(models.remove('../../x'), /Unknown model/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
