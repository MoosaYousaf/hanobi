const test = require('node:test');
const assert = require('node:assert/strict');
const { restoreBounds, compareVersions, checkForUpdate, Attention } = require('../electron/desktop');

test('desktop: saved window bounds come back only on a display that still shows them', () => {
  const displays = [{ workArea: { x: 0, y: 25, width: 1440, height: 875 } }];
  assert.deepEqual(restoreBounds({ x: 100, y: 60, width: 1200, height: 800 }, displays), { x: 100, y: 60, width: 1200, height: 800 });
  // A window that was on a display that is now gone keeps its size and lets macOS place it.
  assert.deepEqual(restoreBounds({ x: 3000, y: 60, width: 1200, height: 800 }, displays), { width: 1200, height: 800 });
  assert.deepEqual(restoreBounds({ x: 0, y: 0, width: 300, height: 200 }, displays), { x: 0, y: 0, width: 860, height: 560 });
  assert.deepEqual(restoreBounds(null, displays), { width: 1360, height: 880 });
  assert.deepEqual(restoreBounds({ width: 'x' }, displays), { width: 1360, height: 880 });
});

test('desktop: versions compare by number, and the update check reads the latest release', async () => {
  assert.equal(compareVersions('0.10.0', '0.9.2'), 1);
  assert.equal(compareVersions('v1.2.0-beta', '1.2.0'), 0);
  assert.equal(compareVersions('0.3.0', '0.3.1'), -1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  const asked = [];
  const newer = await checkForUpdate('0.3.0', async url => { asked.push(url); return { tag_name: 'v0.4.0', html_url: 'https://github.com/MoosaYousaf/orin/releases/tag/v0.4.0' }; });
  assert.deepEqual({ ...newer, checkedAt: 0 }, { current: '0.3.0', latest: '0.4.0', newer: true, url: 'https://github.com/MoosaYousaf/orin/releases/tag/v0.4.0', checkedAt: 0 });
  assert.equal(asked[0], 'https://api.github.com/repos/MoosaYousaf/orin/releases/latest');
  assert.equal((await checkForUpdate('0.4.0', async () => ({ tag_name: 'v0.4.0' }))).newer, false);
  assert.deepEqual(await checkForUpdate('0.3.0', async () => { throw new Error('HTTP 404'); }), { current: '0.3.0', error: 'No public release yet.' });
  assert.match((await checkForUpdate('0.3.0', async () => { throw new Error('offline'); })).error, /Could not check: offline/);
});

test('desktop: attention notifies only in the background, counts on the Dock badge, and clears on focus', () => {
  const badges = [], bounces = [], shown = [], notes = [];
  class Notification {
    static isSupported() { return true; }
    constructor(options) { this.options = options; notes.push(this); }
    on(event, fn) { this.click = fn; }
    show() { this.shown = true; }
  }
  let focused = true, enabled = true;
  const app = { dock: { setBadge: b => badges.push(b), bounce: t => bounces.push(t) } };
  const attention = new Attention({ app, Notification, isFocused: () => focused, show: id => shown.push(id), enabled: () => enabled });
  assert.equal(attention.notify({ threadId: 't1', title: 'Plan', body: 'Done.' }), false);
  focused = false;
  assert.equal(attention.notify({ threadId: 't1', title: 'Plan', body: 'x'.repeat(300) }), true);
  attention.notify({ threadId: 't2', title: 'Fix', body: 'Allow Bash?', urgent: true });
  attention.notify({ threadId: 't2', title: 'Fix', body: 'Again' });
  assert.deepEqual(badges, ['1', '2', '2']);
  assert.deepEqual(bounces, ['informational']);
  assert.equal(notes[0].options.body.length, 180);
  assert.equal(notes[0].options.silent, true);
  assert.equal(notes[1].options.silent, false);
  notes[1].click();
  assert.deepEqual(shown, ['t2']);
  attention.clear();
  assert.equal(badges.at(-1), '');
  enabled = false;
  assert.equal(attention.notify({ threadId: 't3', title: 'Off', body: '' }), false);
});
