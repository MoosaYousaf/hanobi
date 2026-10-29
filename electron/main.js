const { app, BrowserWindow, ipcMain, dialog, shell, Menu, safeStorage, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const { Store } = require('./store');
const { Secrets } = require('./secrets');
const { Mcp } = require('./mcp');
const { Runner } = require('./runner');
const { presets, modes } = require('./providers/catalog');

const PALETTES = ['hanobi', 'gemini', 'chatgpt', 'deepseek', 'custom'];
const { cliPath } = require('./providers/cli');
const git = require('./git');
const { skills } = require('./skills');

app.setName('Hanobi');
// Tests and smoke runs use a throwaway data folder.
if (process.env.HANOBI_USER_DATA) app.setPath('userData', process.env.HANOBI_USER_DATA);
const windows = new Set();
let store, secrets, mcp, runner;

function send(channel, value) { for (const win of windows) if (!win.isDestroyed()) win.webContents.send(channel, value); }
const changed = () => send('changed');

// Orbit Code, the earlier name, kept its data in a different folder.
function dataFile() {
  const file = path.join(app.getPath('userData'), 'hanobi-data.json');
  if (!fs.existsSync(file) && !process.env.HANOBI_USER_DATA) {
    const old = ['Orbit Code', 'orbit-code'].map(dir => path.join(app.getPath('appData'), dir, 'orbit-data.json')).find(f => fs.existsSync(f));
    if (old) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.copyFileSync(old, file); }
  }
  return file;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1360, height: 880, minWidth: 860, minHeight: 560,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121212' : '#f6f6f4',
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  windows.add(win);
  win.on('closed', () => windows.delete(win));
  if (process.env.VITE_DEV_SERVER_URL) win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else win.loadFile(path.join(__dirname, '../dist/renderer/index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => { if (url !== win.webContents.getURL()) { event.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); } });
  return win;
}

function state() {
  const summary = store.summary();
  return {
    ...summary,
    mcpServers: summary.mcpServers.map(s => { const secret = secrets.get(`mcp:${s.id}`) || {}; return { ...s, envKeys: Object.keys(secret.env || {}), headerKeys: Object.keys(secret.headers || {}) }; }),
    connections: runner.connections(),
    presets: Object.fromEntries(Object.entries(presets).map(([id, p]) => [id, { name: p.name, kind: p.kind, route: p.route, needsKey: !!p.needsKey, baseURL: p.baseURL || '', efforts: p.efforts, keyUrl: p.keyUrl || '', note: p.note || '', customModels: !!p.customModels, asks: !!p.asks, ...(p.kind === 'cli' ? { models: p.models } : {}) }])),
    modes, mcpStatus: mcp.statuses(), running: Object.keys(runner.live()), warning: store.warning, secretsAvailable: secrets.available()
  };
}

// Native turns hold provider request data the renderer never needs.
function threadView(id) {
  const { messages, ...thread } = store.thread(id);
  return { ...thread, messages: messages.map(({ native, checkpoint, ...m }) => ({ ...m, ...(checkpoint ? { checkpoint: true } : {}) })), live: runner.live()[id] || null };
}

function mcpRecord(input, existing = {}) {
  const name = String(input.name || existing.name || '').trim().slice(0, 60);
  if (!name) throw new Error('Name the server.');
  const transport = input.transport === 'http' ? 'http' : 'stdio';
  if (transport === 'stdio' && !String(input.command || '').trim()) throw new Error('Enter the command that starts the server.');
  if (transport === 'http' && !/^https?:\/\//.test(String(input.url || ''))) throw new Error('Enter an http or https URL.');
  return { id: existing.id || crypto.randomUUID(), name, transport, command: String(input.command || '').trim(), args: (input.args || []).map(a => String(a).replace(/^~(?=\/|$)/, os.homedir())), url: String(input.url || '').trim(), oauth: transport === 'http' && !!input.oauth, enabled: input.enabled ?? existing.enabled ?? !(transport === 'http' && input.oauth) };
}

const handlers = {
  state: () => state(),
  thread: id => threadView(id),
  'workspace:choose': async () => {
    const picked = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    if (picked.canceled || !picked.filePaths[0]) return null;
    const workspace = store.addWorkspace(picked.filePaths[0]); changed(); return workspace;
  },
  'workspace:remove': id => { if (store.data.threads.some(t => t.workspaceId === id && runner.runs.has(t.id))) throw new Error('Stop running conversations first.'); store.removeWorkspace(id); changed(); },
  'workspace:open': id => shell.openPath(store.workspace(id).path),
  'thread:new': (workspaceId, settings) => {
    const base = settings || store.data.preferences.lastModel || { connectionId: runner.connections().find(c => c.ready)?.id || 'claude-code', model: '', effort: '', mode: 'auto' };
    const thread = store.addThread(workspaceId, { connectionId: base.connectionId, model: '', effort: '', mode: 'auto' });
    try { runner.setThreadSettings(thread.id, base); } catch {}
    changed(); return threadView(thread.id);
  },
  'thread:rename': (id, title) => { store.update(id, { title: String(title).trim().slice(0, 100) || 'Conversation' }); changed(); },
  'thread:delete': id => { if (runner.runs.has(id)) throw new Error('Stop the reply first.'); store.removeThread(id); changed(); },
  'thread:rewind': async (id, messageId, options) => { const result = await runner.rewind(id, messageId, options); changed(); send('thread-changed', { threadId: id }); if (options?.code) send('git-changed', store.thread(id).workspaceId); return result; },
  'thread:fork': (id, messageId) => { const branch = store.fork(id, messageId); changed(); return branch.id; },
  'thread:settings': (id, next) => { runner.setThreadSettings(id, next); changed(); send('thread-changed', { threadId: id }); },
  'run:send': (id, message) => runner.start(id, message),
  'run:stop': id => runner.stop(id),
  'run:approve': (approvalId, decision) => runner.answer(approvalId, decision),
  'models:list': id => runner.models(id),
  'models:refresh': async id => { const models = await runner.refreshModels(id); changed(); return models; },
  'connection:save': input => {
    const preset = presets[input.preset];
    if (!preset || preset.kind === 'cli') throw new Error('Choose a provider.');
    const baseURL = String(input.baseURL || preset.baseURL || '').trim();
    if (preset.kind === 'openai' && !/^https?:\/\//.test(baseURL)) throw new Error('Enter an http or https base URL.');
    const existing = store.data.connections.find(c => c.id === input.id);
    const record = store.upsert('connections', { id: existing?.id || crypto.randomUUID(), preset: input.preset, name: String(input.name || preset.name).trim().slice(0, 60), baseURL: preset.kind === 'openai' ? baseURL : '' });
    if (input.apiKey) secrets.set(`key:${record.id}`, String(input.apiKey).trim());
    changed(); return record.id;
  },
  'connection:remove': id => { store.remove('connections', id); secrets.set(`key:${id}`, null); delete store.data.modelCache[id]; changed(); },
  'mcp:save': async input => {
    const existing = store.data.mcpServers.find(s => s.id === input.id) || {};
    const record = mcpRecord(input, existing);
    store.upsert('mcpServers', record);
    const previous = secrets.get(`mcp:${record.id}`) || {};
    // Blank values keep the stored secret, so editing never shows or needs the old value.
    const merge = (incoming = {}, stored = {}) => Object.fromEntries(Object.entries(incoming).filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v === '' ? stored[k] ?? '' : String(v)]));
    secrets.set(`mcp:${record.id}`, { env: merge(input.env, previous.env), headers: merge(input.headers, previous.headers) });
    await mcp.disconnect(record.id);
    changed(); return record.id;
  },
  'mcp:remove': async id => { await mcp.disconnect(id); store.remove('mcpServers', id); secrets.set(`mcp:${id}`, null); secrets.set(`mcp-oauth:${id}`, null); changed(); },
  // Connect turns the connector on and connects; OAuth connectors open the provider's consent page.
  'mcp:connect': async id => {
    const server = store.data.mcpServers.find(s => s.id === id);
    if (!server) throw new Error('Connector not found.');
    store.upsert('mcpServers', { id, enabled: true });
    await (server.oauth ? mcp.authorize(id) : mcp.reconnect(id));
    changed();
  },
  // Disconnect turns it off; for OAuth it also deletes the saved tokens, so the next Connect asks again.
  'mcp:disconnect': async id => {
    const server = store.data.mcpServers.find(s => s.id === id);
    if (!server) throw new Error('Connector not found.');
    store.upsert('mcpServers', { id, enabled: false });
    await mcp.disconnect(id);
    if (server.oauth) secrets.set(`mcp-oauth:${id}`, null);
    changed();
  },
  'prefs:set': patch => {
    const allowed = ['theme', 'systemPrompt']; for (const k of allowed) if (k in patch) store.data.preferences[k] = String(patch[k]).slice(0, 20000);
    if ('palette' in patch) store.data.preferences.palette = PALETTES.includes(patch.palette) ? patch.palette : 'hanobi';
    if ('accent' in patch && /^#[0-9a-f]{6}$/i.test(patch.accent)) store.data.preferences.accent = patch.accent.toLowerCase();
    store.save(); if ('theme' in patch) nativeTheme.themeSource = ['light', 'dark'].includes(patch.theme) ? patch.theme : 'system'; changed(); },
  'clis:rescan': () => { for (const p of Object.values(presets)) if (p.cli) cliPath(p.cli, true); changed(); },
  skills: id => skills(id ? store.workspace(id).path : null),
  'git:status': id => git.status(store.workspace(id).path),
  'git:diff': (id, file, options) => git.diff(store.workspace(id).path, file, options || {}),
  'git:stage': async (id, file, unstage) => { await git.stage(store.workspace(id).path, file, unstage); send('git-changed', id); },
  'git:commit': async (id, message) => { const out = await git.commit(store.workspace(id).path, message); send('git-changed', id); return out; },
  'git:remote': async id => { const { remote } = await git.status(store.workspace(id).path); if (!remote) throw new Error('No GitHub origin remote found.'); return shell.openExternal(remote); },
  'open:external': url => { if (/^https:\/\//.test(url)) return shell.openExternal(url); },
  'window:new': () => { createWindow(); }
};

app.whenReady().then(() => {
  store = new Store(dataFile());
  secrets = new Secrets(path.join(app.getPath('userData'), 'hanobi-secrets.json'), safeStorage);
  mcp = new Mcp({ store, secrets, openExternal: url => shell.openExternal(url), onChange: changed });
  runner = new Runner({ store, secrets, mcp, send });
  nativeTheme.themeSource = ['light', 'dark'].includes(store.data.preferences.theme) ? store.data.preferences.theme : 'system';
  // A general folder for chats that do not belong to a project.
  if (!store.data.workspaces.length) {
    const general = path.join(app.getPath('userData'), 'Chats');
    fs.mkdirSync(general, { recursive: true });
    store.addWorkspace(general, 'Chats');
  }
  for (const [name, fn] of Object.entries(handlers)) ipcMain.handle(name, (_event, ...args) => fn(...args));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Hanobi', submenu: [{ role: 'about' }, { type: 'separator' }, { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('menu', 'settings') }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [{ label: 'New Conversation', accelerator: 'CmdOrCtrl+N', click: () => send('menu', 'new-thread') }, { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: createWindow }, { type: 'separator' }, { role: 'close' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+\\', click: () => send('menu', 'sidebar') }, { type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
    { role: 'windowMenu' }
  ]));
  if (!app.isPackaged) app.dock?.setIcon(path.join(__dirname, '../build/icon.png'));
  createWindow();
  app.on('activate', () => { if (windows.size === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { runner?.stopAll(); mcp?.closeAll(); store?.flush(); });
