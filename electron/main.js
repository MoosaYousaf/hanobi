const { app, BrowserWindow, ipcMain, dialog, shell, Menu, safeStorage, nativeTheme, clipboard, nativeImage, Notification, globalShortcut, screen, session, protocol, systemPreferences } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const { Store } = require('./store');
const { Secrets } = require('./secrets');
const { Mcp } = require('./mcp');
const { Runner } = require('./runner');
const { presets, modes } = require('./providers/catalog');
const projects = require('./projects');

const PALETTES = ['hanobi', 'gemini', 'chatgpt', 'deepseek', 'custom'];
const { cliPath } = require('./providers/cli');
const git = require('./git');
const github = require('./github');
const { Files, safeName, mediaType } = require('./files');
const { Models, MODELS, DEFAULT_MODEL } = require('./models');
const { skills } = require('./skills');
const desktop = require('./desktop');
// From package.json, not from Electron: a script started with `electron <file>` reports Electron's version.
const VERSION = require('../package.json').version;

app.setName('Hanobi');
// Tests and smoke runs use a throwaway data folder.
if (process.env.HANOBI_USER_DATA) app.setPath('userData', process.env.HANOBI_USER_DATA);
// The Whisper worker loads model files from this scheme; main serves them from the model cache.
protocol.registerSchemesAsPrivileged([{ scheme: 'hanobi-model', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
// One Hanobi at a time: a second launch shows the open window.
if (!app.requestSingleInstanceLock()) app.quit();
const windows = new Set();
let store, secrets, mcp, runner, files, models, attention, update = null, shortcutError = '';

function send(channel, value) {
  for (const win of windows) if (!win.isDestroyed()) win.webContents.send(channel, value);
  if (attention) noticeFor(channel, value);
}
// A reply that ends, or a request that waits, while Hanobi is in the background gets a notification.
function noticeFor(channel, value) {
  const thread = value?.threadId && store.data.threads.find(t => t.id === value.threadId);
  if (!thread) return;
  if (channel === 'run-state' && !value.running) {
    const reply = thread.messages.at(-1);
    const text = reply?.role === 'assistant' ? reply.parts.filter(p => p.type === 'text').map(p => p.text).join(' ').replace(/[#*`>_]+/g, '').trim() : '';
    attention.notify({ threadId: thread.id, title: thread.title, body: value.error ? `Failed: ${value.error}` : text || 'The reply is ready.' });
  } else if (channel === 'approval' || channel === 'question') {
    attention.notify({ threadId: thread.id, title: thread.title, body: channel === 'approval' ? `${value.server || 'The agent'} asks to run ${value.tool || value.name || 'a tool'}.` : 'The model has a question for you.', urgent: true });
  }
}
// Shows a window (making one if none is open) and, with a thread id, opens that conversation.
function showWindow(threadId) {
  const win = BrowserWindow.getFocusedWindow() || [...windows].filter(w => !w.isDestroyed()).at(-1) || createWindow();
  if (win.isMinimized()) win.restore();
  win.show(); win.focus(); app.focus({ steal: true });
  if (threadId) { const open = () => win.webContents.send('open-thread', threadId); win.webContents.isLoading() ? win.webContents.once('did-finish-load', open) : open(); }
  return win;
}
// The global shortcut shows Hanobi from any app, and hides it when it is already in front.
function registerShortcut() {
  globalShortcut.unregisterAll();
  shortcutError = '';
  const accelerator = store.data.preferences.shortcut ?? desktop.DEFAULT_SHORTCUT;
  if (!accelerator) return;
  try { if (!globalShortcut.register(accelerator, () => (BrowserWindow.getFocusedWindow() ? app.hide() : showWindow()))) shortcutError = `${accelerator} is in use by another app.`; }
  catch { shortcutError = `${accelerator} is not a valid shortcut.`; }
}
async function checkUpdate() { update = await desktop.checkForUpdate(VERSION); changed(); return update; }
const changed = () => send('changed');
// Menu actions that change one window's layout go only to the focused window.
const focused = action => BrowserWindow.getFocusedWindow()?.webContents.send('menu', action);

const dataFile = () => path.join(app.getPath('userData'), 'hanobi-data.json');

function createWindow() {
  // The first window opens where the last one closed. More windows open with the default size.
  const first = !windows.size, saved = store.data.preferences.window;
  const bounds = first ? desktop.restoreBounds(saved, screen.getAllDisplays()) : {};
  const win = new BrowserWindow({
    width: 1360, height: 880, ...bounds, minWidth: 860, minHeight: 560,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121212' : '#f6f6f4',
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  windows.add(win);
  win.on('closed', () => windows.delete(win));
  if (first && saved?.fullScreen) win.once('ready-to-show', () => win.setFullScreen(true));
  // getNormalBounds is the size outside full screen, so a full-screen window still saves a usable size.
  const remember = () => { if (!win.isDestroyed()) { store.data.preferences.window = { ...win.getNormalBounds(), fullScreen: win.isFullScreen() }; store.save(); } };
  let timer;
  for (const event of ['resize', 'move', 'enter-full-screen', 'leave-full-screen']) win.on(event, () => { clearTimeout(timer); timer = setTimeout(remember, 400); });
  win.on('close', remember);
  // Leaving full screen with the window button also leaves focus mode.
  win.on('leave-full-screen', () => win.webContents.send('menu', 'focus-off'));
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
    voice: { model: MODELS[store.data.preferences.voice?.model] ? store.data.preferences.voice.model : DEFAULT_MODEL, language: store.data.preferences.voice?.language || 'en', models: MODELS },
    desktop: { version: VERSION, packaged: app.isPackaged, openAtLogin: app.isPackaged && app.getLoginItemSettings().openAtLogin, shortcut: store.data.preferences.shortcut ?? desktop.DEFAULT_SHORTCUT, shortcutError, notify: store.data.preferences.notify !== false, update },
    modes, mcpStatus: mcp.statuses(), running: Object.keys(runner.live()), warning: store.warning, secretsAvailable: secrets.available()
  };
}

// Native turns hold provider request data the renderer never needs.
const projectsRoot = () => path.join(app.getPath('userData'), 'Projects');
function projectById(id) {
  const project = store.workspace(id);
  if (project.kind !== 'project') throw new Error('Project not found.');
  return project;
}

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

const TEXT_COPY = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|xml|svg|html?|css|js|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|sql|ini|cfg|log|tex|rst|org)$/i;
// The window for dialogs and Quick Look; a click can arrive while no window has focus.
const activeWindow = () => BrowserWindow.getFocusedWindow() || [...windows].find(w => !w.isDestroyed());
const threadFile = (threadId, file) => { const thread = store.thread(threadId); return files.resolve(thread.id, store.workspace(thread.workspaceId).path, file); };

// Runs an HTML snippet with JavaScript on, in its own window. The page has an opaque origin (a data URL),
// an in-memory session that shares nothing with Hanobi, no preload and no Node.js, and every permission request
// (camera, microphone, location, notifications) is denied. It may load from the internet, so CDN libraries work.
const MAX_RUN = 1.5 * 1024 * 1024;
function runHtml(html, title = 'Snippet') {
  html = String(html || '');
  if (Buffer.byteLength(html) > MAX_RUN) throw new Error('The snippet is too large to run (1.5 MB at most).');
  const ses = session.fromPartition('hanobi-run');
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  const win = new BrowserWindow({ width: 960, height: 720, title: `Run: ${String(title).slice(0, 80)}`, backgroundColor: '#ffffff',
    webPreferences: { partition: 'hanobi-run', sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true, webviewTag: false, spellcheck: false } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => { event.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); });
  win.webContents.on('page-title-updated', event => event.preventDefault());
  win.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html).toString('base64')}`);
  return win;
}

// HTML to PDF with Chromium's printer, in a hidden window with scripts off.
async function printPdf(html) {
  const source = path.join(app.getPath('temp'), `hanobi-print-${crypto.randomUUID()}.html`);
  fs.writeFileSync(source, html);
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false, contextIsolation: true } });
  try {
    await win.loadFile(source);
    return await win.webContents.printToPDF({ printBackground: true, margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } });
  } finally { win.destroy(); fs.rmSync(source, { force: true }); }
}

const handlers = {
  state: () => state(),
  thread: id => threadView(id),
  'workspace:choose': async () => {
    const picked = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    if (picked.canceled || !picked.filePaths[0]) return null;
    const workspace = store.addWorkspace(picked.filePaths[0]); changed(); return workspace;
  },
  'workspace:remove': id => {
    if (store.data.threads.some(t => t.workspaceId === id && runner.runs.has(t.id))) throw new Error('Stop running conversations first.');
    const workspace = store.workspace(id);
    if (workspace.kind === 'chats') throw new Error('The Chats list cannot be removed.');
    store.removeWorkspace(id);
    // A project folder belongs to Hanobi, so it goes with the project. A code folder stays on disk.
    if (workspace.kind === 'project' && fs.existsSync(projectsRoot()) && workspace.path.startsWith(fs.realpathSync(projectsRoot()) + path.sep)) fs.rmSync(workspace.path, { recursive: true, force: true });
    changed();
  },
  'project:create': name => {
    name = String(name || '').trim().slice(0, 80) || 'New project';
    const folder = path.join(projectsRoot(), crypto.randomUUID());
    fs.mkdirSync(folder, { recursive: true });
    const project = store.addWorkspace(folder, name, { kind: 'project', instructions: '' });
    projects.writeContext(project);
    changed(); return project;
  },
  'project:update': (id, patch) => {
    const project = projectById(id);
    if ('name' in patch) project.name = String(patch.name).trim().slice(0, 80) || project.name;
    if ('instructions' in patch) project.instructions = String(patch.instructions).slice(0, 50000);
    store.save(); projects.writeContext(project); changed();
  },
  'project:files': id => projects.files(projectById(id)),
  'project:add-files': async id => {
    const project = projectById(id);
    const picked = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
    if (picked.canceled) return [];
    const added = projects.addFiles(project, picked.filePaths);
    projects.warm(project, added);
    return added;
  },
  'project:remove-file': (id, name) => projects.removeFile(projectById(id), name),
  'workspace:open': id => shell.openPath(store.workspace(id).path),
  'thread:new': (workspaceId, settings) => {
    const base = settings || store.data.preferences.lastModel || { connectionId: runner.connections().find(c => c.ready)?.id || 'claude-code', model: '', effort: '', mode: 'auto' };
    const thread = store.addThread(workspaceId, { connectionId: base.connectionId, model: '', effort: '', mode: 'auto' });
    try { runner.setThreadSettings(thread.id, base); } catch {}
    changed(); return threadView(thread.id);
  },
  'thread:pin': (id, pinned) => { store.thread(id).pinned = !!pinned; store.save(); changed(); },
  // ids: one sidebar list in its new order. Ranks start at the current time, so new threads still sort above them.
  'thread:reorder': ids => {
    if (!Array.isArray(ids)) throw new Error('Expected a list of conversations.');
    const top = Date.now();
    ids.forEach((id, i) => { store.thread(String(id)).rank = top - i; });
    store.save(); changed();
  },
  // Moving changes the working folder, so a CLI session cannot continue; the next turn replays the transcript.
  'thread:move': (id, workspaceId) => {
    if (runner.runs.has(id)) throw new Error('Stop the reply first.');
    const thread = store.thread(id);
    const from = store.workspace(thread.workspaceId), to = store.workspace(workspaceId);
    if ((from.kind === 'code') !== (to.kind === 'code')) throw new Error('A conversation moves only between chats and projects, or between code workspaces.');
    if (from.id !== to.id) store.update(id, { workspaceId, sessionId: null, replay: thread.messages.length > 0 });
    changed(); send('thread-changed', { threadId: id });
  },
  'thread:rename': (id, title) => { store.update(id, { title: String(title).trim().slice(0, 100) || 'Conversation' }); changed(); },
  'thread:delete': id => { if (runner.runs.has(id)) throw new Error('Stop the reply first.'); store.removeThread(id); files.remove(id).catch(() => {}); changed(); },
  'thread:rewind': async (id, messageId, options) => { const result = await runner.rewind(id, messageId, options); changed(); send('thread-changed', { threadId: id }); if (options?.code) send('git-changed', store.thread(id).workspaceId); return result; },
  'thread:fork': (id, messageId) => { const branch = store.fork(id, messageId); changed(); return branch.id; },
  'thread:settings': (id, next) => { runner.setThreadSettings(id, next); changed(); send('thread-changed', { threadId: id }); },
  'run:send': (id, message) => runner.start(id, message),
  'run:stop': id => runner.stop(id),
  'run:approve': (approvalId, decision) => runner.answer(approvalId, decision),
  'run:answer': (questionId, answers) => runner.answer(questionId, answers),
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
    if ('suggestReplies' in patch) store.data.preferences.suggestReplies = !!patch.suggestReplies;
    if ('palette' in patch) store.data.preferences.palette = PALETTES.includes(patch.palette) ? patch.palette : 'hanobi';
    if ('accent' in patch && /^#[0-9a-f]{6}$/i.test(patch.accent)) store.data.preferences.accent = patch.accent.toLowerCase();
    if ('notify' in patch) store.data.preferences.notify = !!patch.notify;
    if ('voice' in patch) {
      const voice = { ...(store.data.preferences.voice || {}), ...patch.voice };
      store.data.preferences.voice = { model: MODELS[voice.model] ? voice.model : DEFAULT_MODEL, language: /^[a-z]{2,3}$/.test(voice.language || '') ? voice.language : 'en' };
    }
    if ('shortcut' in patch) { store.data.preferences.shortcut = String(patch.shortcut || '').slice(0, 60); registerShortcut(); }
    // A login item for the development Electron binary would start Electron, not Hanobi.
    if ('openAtLogin' in patch && app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!patch.openAtLogin });
    store.save(); if ('theme' in patch) nativeTheme.themeSource = ['light', 'dark'].includes(patch.theme) ? patch.theme : 'system'; changed(); },
  'clis:rescan': () => { for (const p of Object.values(presets)) if (p.cli) cliPath(p.cli, true); changed(); },
  skills: id => skills(id ? store.workspace(id).path : null),
  'git:status': id => git.status(store.workspace(id).path),
  'git:diff': (id, file, options) => git.diff(store.workspace(id).path, file, options || {}),
  'git:stage': async (id, file, unstage) => { await git.stage(store.workspace(id).path, file, unstage); send('git-changed', id); },
  'git:commit': async (id, message) => { const out = await git.commit(store.workspace(id).path, message); send('git-changed', id); return out; },
  'git:branches': id => git.branches(store.workspace(id).path),
  'git:checkout': async (id, branch, create) => { await git.checkout(store.workspace(id).path, branch, !!create); send('git-changed', id); },
  'git:push': async id => { await git.push(store.workspace(id).path); send('git-changed', id); },
  'git:pull': async id => { await git.pull(store.workspace(id).path); send('git-changed', id); },
  'github:current': id => github.current(store.workspace(id).path),
  'github:list': id => github.list(store.workspace(id).path),
  'github:default-branch': id => github.defaultBranch(store.workspace(id).path),
  'github:create': async (id, options) => { const url = await github.create(store.workspace(id).path, options || {}); send('git-changed', id); return url; },
  'github:checkout': async (id, number) => { await github.checkout(store.workspace(id).path, number); send('git-changed', id); },
  'github:open': url => { if (!/^https:\/\/github\.com\//.test(url)) throw new Error('Not a GitHub link.'); return shell.openExternal(url); },
  'git:remote': async id => { const { remote } = await git.status(store.workspace(id).path); if (!remote) throw new Error('No GitHub origin remote found.'); return shell.openExternal(remote); },
  // Files in conversations. A path is checked against the thread's folder and its workspace before any action.
  'files:pick': async threadId => {
    const picked = await dialog.showOpenDialog(activeWindow(), { properties: ['openFile', 'multiSelections'] });
    return picked.canceled ? [] : files.attach(store.thread(threadId).id, picked.filePaths);
  },
  'files:attach': (threadId, paths) => files.attach(store.thread(threadId).id, (Array.isArray(paths) ? paths : []).filter(p => typeof p === 'string' && path.isAbsolute(p))),
  'files:attach-data': (threadId, file) => files.attachData(store.thread(threadId).id, file || {}),
  'files:info': async (threadId, list) => {
    const thread = store.thread(threadId), root = store.workspace(thread.workspaceId).path;
    return Promise.all((Array.isArray(list) ? list : []).slice(0, 50).map(file => files.resolve(thread.id, root, file).then(full => files.part(full), () => null)));
  },
  'files:preview': async (threadId, file) => {
    const full = await threadFile(threadId, file);
    activeWindow()?.previewFile(full, path.basename(full));
  },
  'files:open': async (threadId, file) => { const error = await shell.openPath(await threadFile(threadId, file)); if (error) throw new Error(error); },
  'files:reveal': async (threadId, file) => shell.showItemInFolder(await threadFile(threadId, file)),
  'files:save-copy': async (threadId, file) => {
    const full = await threadFile(threadId, file);
    const target = await dialog.showSaveDialog(activeWindow(), { defaultPath: path.join(app.getPath('downloads'), path.basename(full)) });
    if (target.canceled || !target.filePath) return null;
    fs.copyFileSync(full, target.filePath);
    return target.filePath;
  },
  // Text files copy as text, images as images, and other files as a file that Finder and other apps can paste.
  'files:copy': async (threadId, file) => {
    const full = await threadFile(threadId, file);
    if (/^image\/(png|jpeg|gif|webp)$/.test(mediaType(full))) return clipboard.writeImage(nativeImage.createFromPath(full));
    if (TEXT_COPY.test(full) && fs.statSync(full).size < 2 * 1024 * 1024) return clipboard.writeText(fs.readFileSync(full, 'utf8'));
    const xml = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
    clipboard.clear();
    clipboard.writeBuffer('NSFilenamesPboardType', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><array><string>${xml(full)}</string></array></plist>`));
  },
  // Saves text the renderer has (a code snippet or a whole reply) as a file. format: text, html, docx, rtf, odt, or pdf.
  'files:export': async ({ name, text = '', html = '' }) => {
    const target = await dialog.showSaveDialog(activeWindow(), { defaultPath: path.join(app.getPath('downloads'), safeName(name)) });
    if (target.canceled || !target.filePath) return null;
    await files.render(target.filePath, /\.(docx|rtf|odt|pdf|html?)$/i.test(target.filePath) && html ? html : text);
    return target.filePath;
  },
  'snippet:run': (html, title) => { runHtml(html, title); },
  'files:run': async (threadId, file) => { const full = await threadFile(threadId, file); if (!/\.html?$/i.test(full)) throw new Error('Only HTML files can run.'); runHtml(fs.readFileSync(full, 'utf8'), path.basename(full)); },
  // macOS asks once for the microphone. Returns false when the user said no.
  'voice:permission': async () => process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('microphone') === 'granted' || systemPreferences.askForMediaAccess('microphone'),
  'voice:models': () => models.list(),
  'voice:remove-model': async id => { await models.remove(id); changed(); },
  'update:check': () => checkUpdate(),
  'update:open': () => { if (update?.url && /^https:\/\/github\.com\//.test(update.url)) return shell.openExternal(update.url); },
  'open:external': url => { if (/^https:\/\//.test(url)) return shell.openExternal(url); },
  'window:new': () => { createWindow(); },
  'window:fullscreen': on => { const win = BrowserWindow.getFocusedWindow(); if (win && win.isFullScreen() !== !!on) win.setFullScreen(!!on); }
};

app.whenReady().then(() => {
  store = new Store(dataFile());
  secrets = new Secrets(path.join(app.getPath('userData'), 'hanobi-secrets.json'), safeStorage);
  mcp = new Mcp({ store, secrets, openExternal: url => shell.openExternal(url), onChange: changed });
  files = new Files(path.join(app.getPath('userData'), 'Files'), { printPdf });
  // Only real network downloads report progress; files from the cache do not.
  models = new Models(path.join(app.getPath('userData'), 'Models'), { onProgress: p => send('voice-download', p) });
  protocol.handle('hanobi-model', request => models.handle(request));
  // Only Hanobi's own windows may use the microphone, and only for audio. Run windows have their own session.
  const own = wc => [...windows].some(w => !w.isDestroyed() && w.webContents === wc);
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => callback(permission === 'media' && own(wc) && (details.mediaTypes || []).every(t => t === 'audio')));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media' && !!wc && own(wc));
  runner = new Runner({ store, secrets, mcp, send, files });
  nativeTheme.themeSource = ['light', 'dark'].includes(store.data.preferences.theme) ? store.data.preferences.theme : 'system';
  // A general folder for chats that do not belong to a project.
  const general = path.join(app.getPath('userData'), 'Chats');
  fs.mkdirSync(general, { recursive: true });
  const chats = store.addWorkspace(general, 'Chats', { kind: 'chats' });
  if (chats.kind !== 'chats') { chats.kind = 'chats'; store.save(); }
  for (const [name, fn] of Object.entries(handlers)) ipcMain.handle(name, (_event, ...args) => fn(...args));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Hanobi', submenu: [{ role: 'about' }, { type: 'separator' }, { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('menu', 'settings') }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [{ label: 'New Conversation', accelerator: 'CmdOrCtrl+N', click: () => send('menu', 'new-thread') }, { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: createWindow }, { type: 'separator' }, { role: 'close' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+\\', click: () => send('menu', 'sidebar') }, { label: 'New Split Pane', accelerator: 'CmdOrCtrl+D', click: () => focused('split') }, { label: 'Focus Mode', accelerator: 'CmdOrCtrl+Shift+F', click: () => focused('focus') }, { type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
    { role: 'windowMenu' }
  ]));
  if (!app.isPackaged) app.dock?.setIcon(path.join(__dirname, '../build/icon.png'));
  app.dock?.setMenu(Menu.buildFromTemplate([{ label: 'New Conversation', click: () => { showWindow(); send('menu', 'new-thread'); } }, { label: 'New Window', click: () => createWindow() }]));
  attention = new desktop.Attention({ app, Notification, isFocused: () => !!BrowserWindow.getFocusedWindow(), show: showWindow, enabled: () => store.data.preferences.notify !== false });
  app.on('browser-window-focus', () => attention.clear());
  app.on('second-instance', () => showWindow());
  registerShortcut();
  createWindow();
  // A free check against GitHub Releases, once at launch and then once a day. Smoke runs skip it.
  if (!process.env.HANOBI_USER_DATA) { setTimeout(checkUpdate, 5000); setInterval(checkUpdate, 24 * 60 * 60 * 1000).unref(); }
  app.on('activate', () => { if (windows.size === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('before-quit', () => { runner?.stopAll(); mcp?.closeAll(); store?.flush(); });
