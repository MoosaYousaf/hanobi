// Local models from Hugging Face: search GGUF repositories, list their files with a fit estimate for this Mac,
// and download a file with resume and a SHA-256 check. GGUF files are data, never code. The API needs no key;
// repositories that need a sign-in (gated models) are reported as such and are not downloaded.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const BASE = 'https://huggingface.co';
const REPO = /^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/;
const SORTS = { downloads: 'downloads', trending: 'trendingScore', new: 'lastModified', likes: 'likes' };
const GB = 1e9;

const folderOf = repo => repo.replace('/', '__');

function check(repo, file) {
  if (!REPO.test(repo)) throw new Error('That is not a Hugging Face repository name.');
  const parts = String(file || '').split('/');
  if (!parts.length || parts.some(p => !p || p === '.' || p === '..' || /[\\\0]/.test(p)) || !/\.gguf$/i.test(file)) throw new Error('That is not a GGUF file.');
}

async function getJson(fetch, url, what) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Orin', Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (response.status === 401 || response.status === 403) throw new Error(`${what} needs a Hugging Face sign-in, which Orin does not support.`);
  if (!response.ok) throw new Error(`Hugging Face answered ${response.status} for ${what}.`);
  return response.json();
}

// sort: downloads | trending | new | likes. An empty query lists what is popular or new.
async function search({ query = '', sort = 'trending', limit = 24, fetch = globalThis.fetch, base = BASE } = {}) {
  const params = new URLSearchParams({ filter: 'gguf', pipeline_tag: 'text-generation', sort: SORTS[sort] || SORTS.trending, direction: '-1', limit: String(Math.min(50, limit)) });
  if (query.trim()) params.set('search', query.trim().slice(0, 100));
  const list = await getJson(fetch, `${base}/api/models?${params}`, 'the model search');
  return list.filter(m => REPO.test(m.id || '')).map(m => ({ id: m.id, downloads: m.downloads || 0, likes: m.likes || 0, updated: m.lastModified || '' }));
}

const QUANT = /(?:^|[-_.])((?:IQ\d(?:_[A-Z]+)*|Q\d(?:_K)?(?:_[A-Z0-9]+)?|MXFP4|BF16|F16|F32))(?=[-_.]|$)/i;
const quantOf = name => (QUANT.exec(name.replace(/\.gguf$/i, ''))?.[1] || '').toUpperCase();
// Quality order for the recommended pick: Q4_K_M is the usual balance of size and quality.
const PREFERRED = ['Q4_K_M', 'Q4_K_S', 'Q4_0', 'IQ4_XS', 'Q5_K_M', 'Q5_K_S', 'Q3_K_M', 'Q6_K', 'Q3_K_L', 'Q8_0', 'Q2_K'];

// How a file of this size runs here: weights plus about 0.6 GB for the context and the program, against the RAM.
// good: fits comfortably; tight: it fits but the Mac slows down and may swap; no: too big.
function fit(size, ram = os.totalmem()) {
  const need = size + 0.6 * GB;
  return need <= ram * 0.45 ? 'good' : need <= ram * 0.7 ? 'tight' : 'no';
}

// The GGUF files of a repository: one entry per model file (split files are one entry, with the first part to load),
// without vision projectors and importance matrices.
async function files(repo, { fetch = globalThis.fetch, base = BASE, ram = os.totalmem() } = {}) {
  if (!REPO.test(repo)) throw new Error('That is not a Hugging Face repository name.');
  const tree = await getJson(fetch, `${base}/api/models/${repo}/tree/main?recursive=true`, repo);
  const groups = new Map();
  for (const f of tree) {
    if (f.type !== 'file' || !/\.gguf$/i.test(f.path) || /mmproj|imatrix/i.test(f.path)) continue;
    const shard = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i.exec(f.path);
    const key = shard ? shard[1] : f.path;
    const entry = groups.get(key) || { parts: [] };
    entry.parts.push({ path: f.path, size: f.lfs?.size ?? f.size ?? 0, sha256: f.lfs?.oid || '', index: shard ? Number(shard[2]) : 1 });
    groups.set(key, entry);
  }
  const out = [...groups.values()].map(({ parts }) => {
    parts.sort((a, b) => a.index - b.index);
    const size = parts.reduce((n, p) => n + p.size, 0);
    return { path: parts[0].path, name: path.basename(parts[0].path), quant: quantOf(path.basename(parts[0].path)), size, parts: parts.map(({ path: p, size: s, sha256 }) => ({ path: p, size: s, sha256 })), fit: fit(size, ram) };
  }).sort((a, b) => a.size - b.size);
  const best = PREFERRED.map(q => out.find(f => f.quant === q && f.fit === 'good')).find(Boolean) || out.filter(f => f.fit !== 'no').at(-1) || null;
  if (best) best.recommended = true;
  return out;
}

// Downloaded models live in <root>/<owner>__<repo>/<file>.gguf with a <file>.gguf.json note next to each.
class Library {
  constructor({ root }) { this.root = root; }
  dirOf(repo) { return path.join(this.root, folderOf(repo)); }
  // The model id that a chat stores: a path relative to the root.
  idOf(repo, file) { return `${folderOf(repo)}/${path.basename(file)}`; }
  resolve(id) {
    const full = path.resolve(this.root, String(id || ''));
    if (!full.startsWith(this.root + path.sep) || !/\.gguf$/i.test(full) || !fs.existsSync(full)) throw new Error('That local model is not downloaded.');
    return full;
  }
  list() {
    const out = [];
    for (const dir of safeDir(this.root)) {
      for (const name of safeDir(path.join(this.root, dir))) {
        if (!name.endsWith('.gguf.json')) continue;
        try {
          const note = JSON.parse(fs.readFileSync(path.join(this.root, dir, name), 'utf8'));
          const file = path.join(this.root, dir, name.slice(0, -5));
          if (fs.existsSync(file)) out.push({ id: `${dir}/${path.basename(file)}`, repo: note.repo, name: path.basename(file), quant: note.quant, size: note.size || fs.statSync(file).size, at: note.at });
        } catch {}
      }
    }
    return out.sort((a, b) => (b.at || 0) - (a.at || 0));
  }
  remove(id) {
    const full = this.resolve(id);
    let parts;
    try { parts = JSON.parse(fs.readFileSync(`${full}.json`, 'utf8')).parts; } catch {}
    if (!parts?.length) {
      const shard = /^(.*)-\d{5}-of-(\d{5})\.gguf$/i.exec(path.basename(full));
      parts = shard ? Array.from({ length: Math.min(Number(shard[2]), 10000) }, (_, i) => `${shard[1]}-${String(i + 1).padStart(5, '0')}-of-${shard[2]}.gguf`) : [path.basename(full)];
    }
    for (const part of parts) {
      if (typeof part !== 'string' || part !== path.basename(part) || !/\.gguf$/i.test(part)) throw new Error('Invalid model part.');
      fs.rmSync(path.join(path.dirname(full), part), { force: true });
      fs.rmSync(path.join(path.dirname(full), `${part}.part`), { force: true });
    }
    fs.rmSync(`${full}.json`, { force: true });
    // An empty repository folder goes too, but a folder with other files stays.
    try { fs.rmdirSync(path.dirname(full)); } catch {}
  }
}
const safeDir = dir => { try { return fs.readdirSync(dir); } catch { return []; } };

// One download at a time per file. The part file keeps what arrived, so a failed or restarted download resumes.
class Downloads {
  constructor({ library, fetch = globalThis.fetch, base = BASE, onChange = () => {}, statfs = fs.promises.statfs }) {
    Object.assign(this, { library, fetch, base, onChange, statfs });
    this.jobs = new Map(); // id -> { id, repo, name, size, done, state, error?, controller }
  }
  list() { return [...this.jobs.values()].map(({ controller, ...job }) => job); }
  // entry: one item of files(); every part is downloaded in order, then verified by its SHA-256.
  start(repo, entry) {
    check(repo, entry.path);
    if (!Array.isArray(entry.parts) || !entry.parts.length) throw new Error('Model parts are missing.');
    entry.parts.forEach(p => { check(repo, p.path); if (!Number.isSafeInteger(p.size) || p.size <= 0) throw new Error('Invalid model size.'); });
    if (new Set(entry.parts.map(p => path.basename(p.path))).size !== entry.parts.length) throw new Error('Model parts have colliding file names.');
    const id = this.library.idOf(repo, entry.path);
    if (this.jobs.get(id)?.state === 'downloading') throw new Error('This model is already downloading.');
    const job = { id, repo, name: entry.name, quant: entry.quant, size: entry.size, done: 0, state: 'downloading', controller: new AbortController() };
    this.jobs.set(id, job);
    this.onChange(this.list());
    this.run(job, entry).catch(error => {
      job.state = job.controller.signal.aborted ? 'cancelled' : 'failed';
      job.error = job.controller.signal.aborted ? undefined : error.message || String(error);
      if (job.state === 'cancelled') {
        for (const part of entry.parts) fs.rmSync(path.join(this.library.dirOf(repo), `${path.basename(part.path)}.part`), { force: true });
        this.jobs.delete(id);
      }
      this.onChange(this.list());
    });
    return id;
  }
  cancel(id) { const job = this.jobs.get(id); if (job?.state === 'downloading') job.controller.abort(); else this.jobs.delete(id); this.onChange(this.list()); }

  async run(job, entry) {
    const dir = this.library.dirOf(job.repo);
    fs.mkdirSync(dir, { recursive: true });
    const free = await this.statfs(dir).then(s => s.bavail * s.bsize, () => Infinity);
    if (free < entry.size * 1.05 + 0.2 * GB) throw new Error(`There is not enough disk space: ${(entry.size / GB).toFixed(1)} GB needed, ${(free / GB).toFixed(1)} GB free.`);
    let before = 0;
    for (const part of entry.parts) {
      job.controller.signal.throwIfAborted();
      const target = path.join(dir, path.basename(part.path));
      if (fs.existsSync(target) && fs.statSync(target).size === part.size) { before += part.size; job.done = before; continue; }
      await this.fetchPart(job, part, `${target}.part`, before);
      fs.renameSync(`${target}.part`, target);
      before += part.size;
    }
    const first = path.join(dir, path.basename(entry.path));
    fs.writeFileSync(`${first}.json`, JSON.stringify({ repo: job.repo, file: entry.path, parts: entry.parts.map(p => path.basename(p.path)), quant: entry.quant, size: entry.size, at: Date.now() }));
    job.state = 'done';
    job.done = job.size;
    this.onChange(this.list());
  }

  async fetchPart(job, part, partFile, before) {
    let have = fs.existsSync(partFile) ? fs.statSync(partFile).size : 0;
    if (have >= part.size) { fs.rmSync(partFile, { force: true }); have = 0; }
    // base can be a function, so a test or smoke run can set the address after the app started.
    const base = (typeof this.base === 'function' ? this.base() : this.base) || BASE;
    const url = `${base}/${job.repo}/resolve/main/${part.path.split('/').map(encodeURIComponent).join('/')}`;
    const headers = { 'User-Agent': 'Orin', ...(have ? { Range: `bytes=${have}-` } : {}) };
    const response = await this.fetch(url, { headers, signal: AbortSignal.any([job.controller.signal, AbortSignal.timeout(30 * 60 * 1000)]) });
    if (response.status === 416 && have) {
      await response.body?.cancel(); fs.rmSync(partFile, { force: true });
      return this.fetchPart(job, part, partFile, before);
    }
    if (response.status === 206 && response.headers.get('content-range')?.match(/^bytes (\d+)-/)?.[1] !== String(have)) {
      await response.body?.cancel(); throw new Error('The server returned an invalid download range.');
    }
    if (response.status === 401 || response.status === 403) throw new Error('This model needs a Hugging Face sign-in, which Orin does not support.');
    // A server that ignores Range sends the whole file (200): start again from zero.
    const resumed = response.status === 206 && have > 0;
    if (!response.ok) throw new Error(`Hugging Face answered ${response.status} for ${path.basename(part.path)}.`);
    const hash = crypto.createHash('sha256');
    // The part that is already on disk goes through the hash first.
    if (resumed) await new Promise((resolve, reject) => fs.createReadStream(partFile).on('data', c => hash.update(c)).on('end', resolve).on('error', reject));
    let done = resumed ? have : 0, last = 0;
    const self = this;
    async function* checked(source) {
      for await (const chunk of source) {
        if (done + chunk.length > part.size) throw new Error('The download exceeded the expected file size.');
        hash.update(chunk);
        done += chunk.length;
        job.done = before + done;
        if (Date.now() - last > 300) { last = Date.now(); self.onChange(self.list()); }
        yield chunk;
      }
    }
    await pipeline(Readable.fromWeb(response.body), checked, fs.createWriteStream(partFile, { flags: resumed ? 'a' : 'w' }), { signal: job.controller.signal });
    if (done !== part.size) throw new Error(`${path.basename(part.path)} arrived incomplete (${done} of ${part.size} bytes). Try again to resume.`);
    if (part.sha256 && hash.digest('hex') !== part.sha256) { fs.rmSync(partFile, { force: true }); throw new Error(`${path.basename(part.path)} failed its SHA-256 check and was deleted. Try again.`); }
  }
}
module.exports = { search, files, fit, quantOf, Library, Downloads, REPO, SORTS, PREFERRED };
