// A fake Hugging Face for tests and smoke runs: search, a file tree, and file downloads with Range.
// server({ cut }) makes the first download stop halfway; server({ badHash }) serves a wrong SHA-256.
const http = require('node:http');
const crypto = require('node:crypto');

const GB = 1e9;
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const body = Buffer.alloc(300000, 'orin-gguf-');

function server({ cut = false, badHash = false } = {}) {
  const seen = { urls: [], ranges: [] };
  let cutOnce = cut;
  const tree = [
    { type: 'file', path: 'README.md', size: 10 },
    { type: 'file', path: 'tiny-Q4_K_M.gguf', size: body.length, lfs: { oid: badHash ? 'f'.repeat(64) : sha(body), size: body.length } },
    { type: 'file', path: 'tiny-Q8_0.gguf', size: 900 * 1e6, lfs: { oid: 'a'.repeat(64), size: 900 * 1e6 } },
    { type: 'file', path: 'big-Q4_K_M-00001-of-00002.gguf', size: 4 * GB, lfs: { oid: 'b'.repeat(64), size: 4 * GB } },
    { type: 'file', path: 'big-Q4_K_M-00002-of-00002.gguf', size: 4 * GB, lfs: { oid: 'c'.repeat(64), size: 4 * GB } },
    { type: 'file', path: 'mmproj-F16.gguf', size: 1000, lfs: { oid: 'd'.repeat(64), size: 1000 } },
    { type: 'file', path: 'sub/tiny-IQ2_XS.gguf', size: 600 * 1e6, lfs: { oid: 'e'.repeat(64), size: 600 * 1e6 } }
  ];
  const srv = http.createServer((req, res) => {
    seen.urls.push(req.url);
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/models') return res.end(JSON.stringify([{ id: 'acme/tiny-GGUF', downloads: 5, likes: 2, lastModified: '2026-11-01T00:00:00Z' }, { id: '../evil', downloads: 1 }]));
    if (url.pathname === '/api/models/acme/tiny-GGUF/tree/main') return res.end(JSON.stringify(tree));
    if (url.pathname === '/api/models/acme/gated/tree/main') { res.statusCode = 401; return res.end('{}'); }
    if (url.pathname === '/acme/tiny-GGUF/resolve/main/tiny-Q4_K_M.gguf') {
      const range = /bytes=(\d+)-/.exec(req.headers.range || '');
      seen.ranges.push(range ? Number(range[1]) : null);
      const start = range ? Number(range[1]) : 0;
      res.statusCode = range ? 206 : 200;
      const chunk = body.subarray(start);
      if (cutOnce && !range) { cutOnce = false; res.setHeader('Content-Length', chunk.length); res.write(chunk.subarray(0, 100000)); return setTimeout(() => res.destroy(), 50); }
      return res.end(chunk);
    }
    res.statusCode = 404; res.end();
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, base: `http://127.0.0.1:${srv.address().port}` })));
}

module.exports = { server, body, sha, GB };
