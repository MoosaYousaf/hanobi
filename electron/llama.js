// The local engine: llama.cpp's llama-server, built on this Mac from a pinned release and started on demand for one
// downloaded model at a time. It speaks the OpenAI API on 127.0.0.1, so the openai adapter runs it like any server.
// Why a build and not a download: the release binaries need macOS 13.3 or newer, and Ollama and LM Studio need
// macOS 14 or an Apple Silicon Mac. A build needs the Xcode Command Line Tools and CMake. The tag is pinned to a
// release that was built and run here; moving it is a code change.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { Readable } = require('node:stream');

const TAG = 'b12233';
const SOURCE = tag => `https://github.com/ggml-org/llama.cpp/archive/refs/tags/${encodeURIComponent(tag)}.tar.gz`;
const IDLE_MS = 10 * 60 * 1000;
const LOAD_MS = 3 * 60 * 1000;
const GB = 1e9;

const run = (file, args, options = {}) => new Promise((resolve, reject) => execFile(file, args, { timeout: 30000, encoding: 'utf8', ...options }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve(stdout))));

// Context size by RAM: the cache grows with it (about 0.15 MB per token for a 4B model).
const contextFor = ram => (ram <= 8.6 * GB ? 4096 : ram <= 17.2 * GB ? 8192 : 16384);
// The OS version the build targets: Darwin 21 is macOS 12.
const deploymentTarget = release => { const major = Number(String(release).split('.')[0]); return major >= 20 ? `${major - 9}.0` : '11.0'; };
// Ninja prints [12/181]; make prints [ 45%].
function buildProgress(text) {
  const step = [...text.matchAll(/\[\s*(\d+)\/(\d+)\]|\[\s*(\d+)%\]/g)].pop();
  return step ? (step[3] ? Number(step[3]) / 100 : Number(step[1]) / Number(step[2])) : null;
}
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
async function physicalCores() {
  const n = await run('sysctl', ['-n', 'hw.physicalcpu']).then(Number, () => 0);
  return n > 0 ? n : Math.max(1, Math.floor(os.cpus().length / 2));
}

// Where a build tool is. The compiler counts only when the Xcode Command Line Tools are installed: /usr/bin/c++ exists
// without them but only opens an install dialog.
function toolPath(name, dirs = [], { exists = fs.existsSync } = {}) {
  if (name === 'c++' || name === 'clang++') return ['/Library/Developer/CommandLineTools/usr/bin/clang++', '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang++'].find(p => exists(p)) || null;
  return dirs.map(d => path.join(d, name)).find(p => exists(p)) || null;
}

class Engine {
  constructor({ dir, library, fetch = globalThis.fetch, onChange = () => {}, which = () => null, memory = os.totalmem(), tag = TAG, source = SOURCE, release = os.release(), idleMs = IDLE_MS }) {
    Object.assign(this, { dir, library, fetch, onChange, which, memory, tag, source, release, idleMs });
    this.install = null; // { step, progress, error? } while building or after a failure
    this.server = null; // { modelId, child, port, ready, log, starting, exited }
    this.busy = 0;
    this.lastUse = 0;
    try { this.info = JSON.parse(fs.readFileSync(path.join(dir, 'engine.json'), 'utf8')); } catch { this.info = null; }
    this.timer = setInterval(() => this.checkIdle().catch(() => {}), 30000);
    this.timer.unref();
  }
  // The model stays in memory while a reply runs, and goes after the idle time, so it does not hold RAM all day.
  async checkIdle() { if (this.server && !this.busy && Date.now() - this.lastUse > this.idleMs) await this.stop(); }
  binary() { return path.join(this.dir, 'llama-server'); }
  installed() { return !!this.info && fs.existsSync(this.binary()); }
  emit() { this.onChange(this.status()); }
  status() {
    const { child, ...install } = this.install || {};
    return { installed: this.installed(), tag: this.info?.tag || null, wanted: this.tag, install: this.install ? install : null,
      tools: { cmake: !!this.which('cmake'), compiler: !!(this.which('c++') || this.which('clang++')) },
      server: this.server ? { model: this.server.modelId, ready: this.server.ready } : null, memory: this.memory };
  }
  setInstall(patch) { this.install = { ...this.install, ...patch }; this.emit(); }

  // Builds the pinned release for this Mac. Progress and errors go to status().install. One build at a time.
  async installEngine() {
    if (this.install && !this.install.error) return;
    const cmake = this.which('cmake'), compiler = this.which('c++') || this.which('clang++');
    this.install = { step: 'Checking the build tools', progress: null };
    this.emit();
    const work = path.join(this.dir, 'build');
    try {
      if (!cmake || !compiler) throw new Error('Orin builds the local engine on this Mac. Install the Xcode Command Line Tools (xcode-select --install) and CMake (brew install cmake), then try again.');
      await fsp.rm(work, { recursive: true, force: true });
      await fsp.mkdir(work, { recursive: true });
      // The source is downloaded data: it goes in its own new folder, and the tools run from outside it.
      const src = path.join(work, 'src');
      await fsp.mkdir(src);
      this.setInstall({ step: `Downloading llama.cpp ${this.tag}`, progress: 0 });
      await this.save(this.source(this.tag), path.join(work, 'src.tar.gz'));
      await run('tar', ['-xzf', path.join(work, 'src.tar.gz'), '-C', src, '--strip-components', '1']);
      const ninja = this.which('ninja');
      const build = path.join(work, 'out');
      this.setInstall({ step: 'Building the engine for this Mac (10 to 40 minutes)', progress: 0 });
      // Flags: no web UI (its assets come from a download), no OpenSSL (it would link a library from Homebrew), a static
      // build (one file), Metal only on Apple Silicon, and the macOS version of this Mac as the minimum.
      await this.spawn(cmake, ['-S', src, '-B', build, ...(ninja ? ['-G', 'Ninja', `-DCMAKE_MAKE_PROGRAM=${ninja}`] : []), '-DCMAKE_BUILD_TYPE=Release', `-DGGML_METAL=${process.arch === 'arm64' ? 'ON' : 'OFF'}`,
        '-DLLAMA_BUILD_UI=OFF', '-DLLAMA_USE_PREBUILT_UI=OFF', '-DLLAMA_OPENSSL=OFF', '-DLLAMA_CURL=OFF', '-DBUILD_SHARED_LIBS=OFF', '-DLLAMA_BUILD_TESTS=OFF', '-DLLAMA_BUILD_EXAMPLES=OFF', `-DCMAKE_OSX_DEPLOYMENT_TARGET=${deploymentTarget(this.release)}`], work);
      await this.spawn(cmake, ['--build', build, '--target', 'llama-server', '-j', String(await physicalCores())], work);
      const built = path.join(build, 'bin', 'llama-server');
      await run(built, ['--version']).catch(error => { throw new Error(`The engine was built but does not run: ${String(error.stderr || error.message).trim().split('\n').pop()}`); });
      await this.stop();
      await fsp.copyFile(built, `${this.binary()}.new`);
      await fsp.chmod(`${this.binary()}.new`, 0o755);
      await fsp.rename(`${this.binary()}.new`, this.binary());
      this.info = { tag: this.tag, at: Date.now() };
      await fsp.writeFile(path.join(this.dir, 'engine.json'), JSON.stringify(this.info));
      this.install = null;
    } catch (error) {
      this.install = { error: error.message || String(error) };
      throw error;
    } finally {
      await fsp.rm(work, { recursive: true, force: true });
      this.emit();
    }
  }
  cancelInstall() { this.install?.child?.kill('SIGTERM'); }
  async save(url, file) {
    const response = await this.fetch(url, { headers: { 'User-Agent': 'Orin' }, signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (!response.ok) throw new Error(`The download failed (HTTP ${response.status}).`);
    const total = Number(response.headers.get('content-length')) || 0;
    const out = fs.createWriteStream(file);
    let received = 0, shown = 0;
    try {
      for await (const chunk of Readable.fromWeb(response.body)) {
        if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
        received += chunk.length;
        if (total && Date.now() - shown > 250) { shown = Date.now(); this.setInstall({ progress: received / total }); }
      }
    } finally { await new Promise(r => out.end(r)); }
  }
  spawn(file, args, cwd) {
    return new Promise((resolve, reject) => {
      // Tools found outside the system folders (Homebrew) need their own folder on the path.
      const env = { ...process.env, PATH: [...new Set([path.dirname(file), '/usr/bin', '/bin', '/usr/sbin', '/sbin', ...(process.env.PATH || '').split(':')])].join(':') };
      const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.install.child = child;
      let tail = '';
      const read = chunk => {
        const text = chunk.toString();
        tail = (tail + text).slice(-6000);
        const progress = buildProgress(text);
        if (progress != null) this.setInstall({ progress });
      };
      child.stdout.on('data', read);
      child.stderr.on('data', read);
      child.on('error', reject);
      child.on('close', code => (code === 0 ? resolve() : reject(new Error(`The engine build failed: ${tail.split('\n').filter(l => /error/i.test(l)).slice(-2).join(' ').trim() || `exit code ${code}`}`))));
    });
  }

  // Starts llama-server for this model if needed and returns its OpenAI-compatible URL. Every use() needs one done().
  async use(modelId, { signal, onStatus = () => {} } = {}) {
    if (!this.installed()) throw new Error('Install the local engine first: Settings → Local models.');
    const file = this.library.resolve(modelId);
    this.busy++;
    this.lastUse = Date.now();
    try {
      if (this.server?.modelId !== modelId) { onStatus(`Loading ${path.basename(file)} into memory…`); await this.start(modelId, file); }
      else if (!this.server.ready) onStatus(`Loading ${path.basename(file)} into memory…`);
      const server = this.server;
      await new Promise((resolve, reject) => {
        const stop = () => reject(new Error('Stopped.'));
        if (signal?.aborted) return stop();
        signal?.addEventListener('abort', stop, { once: true });
        server.starting.then(resolve, reject).finally(() => signal?.removeEventListener('abort', stop));
      });
      return `http://127.0.0.1:${server.port}/v1`;
    } catch (error) { this.done(); throw error; }
  }
  done() { this.busy = Math.max(0, this.busy - 1); this.lastUse = Date.now(); }

  async start(modelId, file) {
    await this.stop();
    const port = await freePort();
    // One slot: with several, llama-server splits the context between them.
    const args = ['--model', file, '--host', '127.0.0.1', '--port', String(port), '--alias', modelId, '--ctx-size', String(contextFor(this.memory)), '--threads', String(await physicalCores()), '--parallel', '1', '--jinja', '--no-webui'];
    const child = spawn(this.binary(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const server = { modelId, child, port, ready: false, log: '' };
    child.stderr.on('data', chunk => { server.log = (server.log + chunk).slice(-4000); });
    child.on('error', error => { server.log += String(error.message); });
    server.exited = new Promise(resolve => child.on('close', resolve));
    let gone = false;
    server.exited.then(() => { gone = true; });
    server.starting = (async () => {
      const deadline = Date.now() + LOAD_MS;
      while (Date.now() < deadline) {
        if (gone) throw new Error(`The local engine stopped: ${server.log.trim().split('\n').filter(Boolean).slice(-2).join(' ') || 'no output'}`);
        if (await this.fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok, () => false)) { server.ready = true; this.emit(); return; }
        await new Promise(r => setTimeout(r, 250));
      }
      child.kill('SIGTERM');
      throw new Error('The model took more than 3 minutes to load.');
    })();
    server.starting.catch(() => { if (this.server === server) { this.server = null; this.emit(); } });
    this.server = server;
    this.emit();
  }
  async stop() {
    const server = this.server;
    if (!server) return;
    this.server = null;
    server.child.kill('SIGTERM');
    const timer = setTimeout(() => server.child.kill('SIGKILL'), 5000);
    await server.exited;
    clearTimeout(timer);
    this.emit();
  }
  close() { clearInterval(this.timer); this.server?.child.kill('SIGTERM'); this.install?.child?.kill('SIGTERM'); }
}

module.exports = { Engine, toolPath, TAG, contextFor, deploymentTarget, buildProgress };
