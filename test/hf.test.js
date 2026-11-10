const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const hf = require('../electron/hf');

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const { server, body, GB } = require('./fixtures/fake-hf.cjs');
const settle = (downloads, id) => new Promise(resolve => { const check = () => { const job = downloads.jobs.get(id); if (!job || job.state !== 'downloading') resolve(job); else setTimeout(check, 20); }; check(); });

test('hf: search asks for GGUF text models, and drops ids that are not repository names', async () => {
  const { srv, seen, base } = await server();
  try {
    const found = await hf.search({ query: ' qwen ', sort: 'new', base });
    assert.deepEqual(found, [{ id: 'acme/tiny-GGUF', downloads: 5, likes: 2, updated: '2026-11-01T00:00:00Z' }]);
    const q = new URL(seen.urls[0], 'http://x').searchParams;
    assert.deepEqual([q.get('filter'), q.get('pipeline_tag'), q.get('sort'), q.get('search'), q.get('direction')], ['gguf', 'text-generation', 'lastModified', 'qwen', '-1']);
    await assert.rejects(hf.files('acme/gated', { base }), /sign-in/);
    await assert.rejects(hf.files('../evil', { base }), /repository name/);
  } finally { srv.close(); }
});

test('hf: files group split parts, skip projectors, and rate the fit on this much RAM', async () => {
  const { srv, base } = await server();
  try {
    const list = await hf.files('acme/tiny-GGUF', { base, ram: 8 * GB });
    assert.deepEqual(list.map(f => [f.name, f.quant, f.fit]), [['tiny-Q4_K_M.gguf', 'Q4_K_M', 'good'], ['tiny-IQ2_XS.gguf', 'IQ2_XS', 'good'], ['tiny-Q8_0.gguf', 'Q8_0', 'good'], ['big-Q4_K_M-00001-of-00002.gguf', 'Q4_K_M', 'no']].sort((a, b) => 0).sort((a, b) => list.findIndex(f => f.name === a[0]) - list.findIndex(f => f.name === b[0])));
    const big = list.find(f => f.name.startsWith('big'));
    assert.equal(big.size, 8 * GB);
    assert.equal(big.parts.length, 2);
    assert.deepEqual(list.filter(f => f.recommended).map(f => f.name), ['tiny-Q4_K_M.gguf']);
    assert.equal(hf.fit(3 * GB, 8 * GB), 'good');
    assert.equal(hf.fit(4.5 * GB, 8 * GB), 'tight');
    assert.equal(hf.fit(6 * GB, 8 * GB), 'no');
    assert.equal(hf.quantOf('Qwen3-27B-UD-Q3_K_XL.gguf'), 'Q3_K_XL');
    assert.equal(hf.quantOf('model-IQ4_XS.gguf'), 'IQ4_XS');
    assert.equal(hf.quantOf('model.bf16.gguf'), 'BF16');
  } finally { srv.close(); }
});

test('hf: a download verifies its SHA-256, resumes after a cut connection, and lands in the library', async () => {
  const { srv, seen, base } = await server({ cut: true });
  try {
    const library = new hf.Library({ root: tmp('orin-models-') });
    const downloads = new hf.Downloads({ library, base, statfs: async () => ({ bavail: 1e9, bsize: 4096 }) });
    const [entry] = (await hf.files('acme/tiny-GGUF', { base, ram: 8 * GB })).filter(f => f.name === 'tiny-Q4_K_M.gguf');
    const id = downloads.start('acme/tiny-GGUF', entry);
    assert.equal(id, 'acme__tiny-GGUF/tiny-Q4_K_M.gguf');
    assert.throws(() => downloads.start('acme/tiny-GGUF', entry), /already downloading/);
    let job = await settle(downloads, id);
    assert.equal(job.state, 'failed');
    assert.match(job.error, /incomplete|terminated|aborted|fetch failed/i);
    const part = path.join(library.root, 'acme__tiny-GGUF', 'tiny-Q4_K_M.gguf.part');
    assert.ok(fs.statSync(part).size > 0 && fs.statSync(part).size < body.length);
    downloads.start('acme/tiny-GGUF', entry);
    job = await settle(downloads, id);
    assert.equal(job.state, 'done');
    assert.ok(seen.ranges.at(-1) > 0, 'the second request asked to resume');
    assert.deepEqual(fs.readFileSync(library.resolve(id)), body);
    assert.ok(!fs.existsSync(part));
    assert.deepEqual(library.list().map(m => [m.id, m.repo, m.quant, m.size]), [[id, 'acme/tiny-GGUF', 'Q4_K_M', body.length]]);
    library.remove(id);
    assert.deepEqual(library.list(), []);
    assert.ok(!fs.existsSync(path.join(library.root, 'acme__tiny-GGUF')));
  } finally { srv.close(); }
});

test('hf: a wrong checksum deletes the file; unsafe names, a full disk, and a stop are refused cleanly', async () => {
  const { srv, base } = await server({ badHash: true });
  try {
    const library = new hf.Library({ root: tmp('orin-models-') });
    const free = { bavail: 1e9, bsize: 4096 };
    const downloads = new hf.Downloads({ library, base, statfs: async () => free });
    const [entry] = (await hf.files('acme/tiny-GGUF', { base, ram: 8 * GB })).filter(f => f.name === 'tiny-Q4_K_M.gguf');
    const id = downloads.start('acme/tiny-GGUF', entry);
    const job = await settle(downloads, id);
    assert.match(job.error, /SHA-256/);
    assert.ok(!fs.existsSync(path.join(library.root, 'acme__tiny-GGUF', 'tiny-Q4_K_M.gguf.part')));
    assert.deepEqual(library.list(), []);
    for (const path of ['../x.gguf', 'a/../../x.gguf', '/etc/x.gguf', 'x.bin', 'a\\b.gguf']) assert.throws(() => downloads.start('acme/tiny-GGUF', { ...entry, path, parts: [{ ...entry.parts[0], path }] }), /GGUF/);
    assert.throws(() => downloads.start('../x', entry), /repository name/);
    assert.throws(() => library.resolve('../../etc/passwd'), /not downloaded/);
    const small = new hf.Downloads({ library, base, statfs: async () => ({ bavail: 10, bsize: 1 }) });
    const full = small.start('acme/tiny-GGUF', entry);
    assert.match((await settle(small, full)).error, /not enough disk space/);
    const stopper = new hf.Downloads({ library, base, statfs: async () => free });
    const stopped = stopper.start('acme/tiny-GGUF', entry);
    stopper.cancel(stopped);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(stopper.jobs.has(stopped), false);
  } finally { srv.close(); }
});
