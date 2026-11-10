const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { searchPath } = require('./providers/cli');

// The Terminal page: a tmux client in a pseudo terminal. The tmux session outlives the page and Orin, so leaving the
// page detaches and opening it again attaches to the same windows. Other terminals reach it with `tmux attach -t orin`.
// Tests and smoke runs set ORIN_TMUX_SOCKET, so they use their own tmux server.
const SESSION = 'orin';

function tmuxPath() {
  for (const dir of searchPath()) {
    const file = path.join(dir, 'tmux');
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch {}
  }
  return null;
}

// npm loses the execute bit of node-pty's helper; without it every spawn fails with "posix_spawnp failed".
function helperReady(pty) {
  const helper = path.join(path.dirname(require.resolve('node-pty/package.json')), 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
    .replace('app.asar', 'app.asar.unpacked');
  try { if (!(fs.statSync(helper).mode & 0o111)) fs.chmodSync(helper, 0o755); } catch {}
  return pty;
}

class Terminal {
  constructor() { this.ptys = new Map(); } // id -> pty

  status() { return { tmux: tmuxPath() }; }

  // Starts a tmux client for the session, made in `cwd` when it does not exist yet. `emit` gets { id, data } and
  // { id, exit }. Returns the client id.
  open({ cwd, cols = 80, rows = 24 } = {}, emit) {
    const tmux = tmuxPath();
    if (!tmux) throw new Error('tmux is not installed. Install it with Homebrew: brew install tmux');
    const pty = helperReady(require('node-pty'));
    const folder = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    const socket = process.env.ORIN_TMUX_SOCKET ? ['-L', process.env.ORIN_TMUX_SOCKET] : [];
    // Apps opened from Finder get no LANG, and tmux then draws Unicode as underscores.
    const env = { ...process.env, PATH: searchPath().join(path.delimiter), TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'en_US.UTF-8' };
    delete env.ELECTRON_RUN_AS_NODE;
    const id = crypto.randomUUID();
    const term = pty.spawn(tmux, [...socket, '-u', 'new-session', '-A', '-s', SESSION, '-c', folder], { name: 'xterm-256color', cols: size(cols, 80), rows: size(rows, 24), cwd: folder, env });
    this.ptys.set(id, term);
    term.onData(data => emit({ id, data }));
    term.onExit(({ exitCode }) => { this.ptys.delete(id); emit({ id, exit: exitCode }); });
    return id;
  }

  write(id, data) { if (typeof data === 'string') this.ptys.get(id)?.write(data); }
  resize(id, cols, rows) { try { this.ptys.get(id)?.resize(size(cols, 80), size(rows, 24)); } catch {} }
  // Ends the client only: the tmux session and its programs keep running.
  close(id) { const term = this.ptys.get(id); this.ptys.delete(id); try { term?.kill(); } catch {} }
  closeAll() { for (const id of [...this.ptys.keys()]) this.close(id); }
}

const size = (value, fallback) => (Number.isInteger(value) && value > 0 && value < 1000 ? value : fallback);

module.exports = { Terminal, tmuxPath, SESSION };
