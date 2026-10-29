const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// Speech models for voice input. The renderer's Whisper worker asks for files at
// hanobi-model://hf/<repo>/resolve/main/<file>. Main answers from <userData>/Models and downloads a missing file
// once from Hugging Face. Only the Whisper repositories below can be fetched, so the scheme is not a general proxy.
const MODELS = {
  'onnx-community/whisper-tiny': { label: 'Tiny', size: '45 MB', note: 'Fastest. The default on Intel Macs.' },
  'onnx-community/whisper-base': { label: 'Base', size: '80 MB', note: 'More accurate. The default on Apple Silicon.' },
  'onnx-community/whisper-small': { label: 'Small', size: '250 MB', note: 'Most accurate. Slower on Intel Macs.' }
};
// Intel Macs get Tiny: on a 2-core Intel MacBook Air, Base takes about 8 s for 6 s of speech and Tiny about 4 s.
const DEFAULT_MODEL = process.arch === 'arm64' ? 'onnx-community/whisper-base' : 'onnx-community/whisper-tiny';
const HUB = 'https://huggingface.co';
const FILE = /^[\w.-]+(\/[\w.-]+)?$/;
const TYPES = { json: 'application/json', onnx: 'application/octet-stream', txt: 'text/plain' };

// The repository and file of a model URL, or null when the URL is not an allowed model file.
function parse(url) {
  const match = /^hanobi-model:\/\/hf\/([\w-]+\/[\w.-]+)\/resolve\/main\/(.+)$/.exec(url);
  if (!match || !MODELS[match[1]]) return null;
  const file = decodeURIComponent(match[2]);
  return FILE.test(file) && !file.split('/').includes('..') ? { repo: match[1], file } : null;
}

class Models {
  constructor(root, { fetch = globalThis.fetch, onProgress = () => {} } = {}) {
    Object.assign(this, { root, fetch, onProgress });
    this.downloads = new Map(); // cache path -> promise, so two requests for one file download it once
  }

  path(repo, file) { return path.join(this.root, ...repo.split('/'), ...file.split('/')); }

  // Downloads to a .part file and renames it, so a stopped download never looks complete.
  async ensure(repo, file) {
    const target = this.path(repo, file);
    if (fs.existsSync(target)) return target;
    if (!this.downloads.has(target)) {
      const job = (async () => {
        const response = await this.fetch(`${HUB}/${repo}/resolve/main/${file}`, { redirect: 'follow' });
        if (response.status === 404) throw Object.assign(new Error(`${file} is not in ${repo}.`), { status: 404 });
        if (!response.ok) throw new Error(`Download of ${file} failed: HTTP ${response.status}.`);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        const total = Number(response.headers.get('content-length')) || 0;
        let loaded = 0;
        const counted = Readable.fromWeb(response.body).on('data', chunk => { loaded += chunk.length; this.onProgress({ repo, file, loaded, total }); });
        const part = `${target}.part`;
        await pipeline(counted, fs.createWriteStream(part));
        await fsp.rename(part, target);
        this.onProgress({ repo, file, loaded, total: total || loaded, done: true });
        return target;
      })().finally(() => this.downloads.delete(target));
      this.downloads.set(target, job);
    }
    return this.downloads.get(target);
  }

  // The protocol handler: a Response for an allowed model file, 404 for a file the repository lacks, 403 for anything else.
  async handle(request) {
    const wanted = parse(request.url);
    if (!wanted) return new Response('Not allowed', { status: 403 });
    try {
      const file = await this.ensure(wanted.repo, wanted.file);
      const type = TYPES[path.extname(file).slice(1)] || 'application/octet-stream';
      const size = fs.statSync(file).size;
      const headers = { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range', 'Accept-Ranges': 'bytes' };
      // The library asks for bytes=0-0 to learn whether a file exists and how large it is.
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers?.get?.('range') || '');
      if (range && size) {
        const start = Math.min(+range[1], size - 1), end = Math.min(range[2] ? +range[2] : size - 1, size - 1);
        return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), { status: 206, headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` } });
      }
      return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
    } catch (error) {
      return new Response(error.message, { status: error.status === 404 ? 404 : 502 });
    }
  }

  // Which models are on disk and how much space each one uses.
  async list() {
    return Promise.all(Object.entries(MODELS).map(async ([id, info]) => {
      const dir = this.path(id, '');
      const bytes = await sizeOf(dir);
      return { id, ...info, bytes, downloaded: bytes > 0 && fs.existsSync(path.join(dir, 'config.json')) };
    }));
  }

  async remove(repo) {
    if (!MODELS[repo]) throw new Error('Unknown model.');
    await fsp.rm(this.path(repo, ''), { recursive: true, force: true });
  }
}

async function sizeOf(dir) {
  let total = 0;
  for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? await sizeOf(full) : (await fsp.stat(full)).size;
  }
  return total;
}

module.exports = { Models, MODELS, DEFAULT_MODEL, parse };
