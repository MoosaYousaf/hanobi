// Desktop app behavior: the window comes back where it was, background replies notify, a global shortcut
// shows Hanobi from any app, and a free update check reads GitHub Releases. Electron objects are passed in.
const RELEASES = 'https://api.github.com/repos/MoosaYousaf/hanobi/releases/latest';
const DEFAULT_SHORTCUT = 'Alt+Space';

// Saved bounds are used only when most of the window is on a display that still exists.
function restoreBounds(saved, displays, fallback = { width: 1360, height: 880 }) {
  if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) return fallback;
  const visible = displays.some(({ workArea: a }) => {
    const w = Math.min(saved.x + saved.width, a.x + a.width) - Math.max(saved.x, a.x);
    const h = Math.min(saved.y + saved.height, a.y + a.height) - Math.max(saved.y, a.y);
    return w > 0 && h > 0 && w * h >= 0.5 * saved.width * saved.height;
  });
  const size = { width: Math.max(860, Math.round(saved.width)), height: Math.max(560, Math.round(saved.height)) };
  return visible && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? { ...size, x: Math.round(saved.x), y: Math.round(saved.y) } : size;
}

// 0.10.0 > 0.9.2; a leading v and pre-release tags are ignored, so "v1.2.0-beta" compares as 1.2.0.
function compareVersions(a, b) {
  const parse = v => String(v).replace(/^v/, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  return 0;
}

// { current, latest, newer, url } or { current, error }. A private repository or no release returns 404.
async function checkForUpdate(current, fetchJson = defaultFetch) {
  try {
    const release = await fetchJson(RELEASES);
    const latest = String(release.tag_name || '').replace(/^v/, '');
    if (!latest) return { current, error: 'No release found.' };
    return { current, latest, newer: compareVersions(latest, current) > 0, url: release.html_url, checkedAt: Date.now() };
  } catch (error) {
    return { current, error: /404/.test(error.message) ? 'No public release yet.' : `Could not check: ${error.message}` };
  }
}

async function defaultFetch(url) {
  const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Hanobi' }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// Background attention: a notification, a Dock badge with the count, and one Dock bounce for approvals.
// Everything clears when a Hanobi window gets focus.
class Attention {
  constructor({ app, Notification, isFocused, show, enabled }) {
    Object.assign(this, { app, Notification, isFocused, show, enabled });
    this.pending = new Set();
  }
  notify({ threadId, title, body, urgent = false }) {
    if (this.isFocused() || !this.enabled()) return false;
    this.pending.add(threadId);
    this.app.dock?.setBadge(String(this.pending.size));
    if (urgent) this.app.dock?.bounce('informational');
    if (this.Notification.isSupported()) {
      const note = new this.Notification({ title, body: String(body || '').slice(0, 180), silent: !urgent });
      note.on('click', () => this.show(threadId));
      note.show();
    }
    return true;
  }
  clear() { this.pending.clear(); this.app.dock?.setBadge(''); }
}

module.exports = { restoreBounds, compareVersions, checkForUpdate, Attention, DEFAULT_SHORTCUT, RELEASES };
