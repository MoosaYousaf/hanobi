const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Store } = require('./store');
const providers = require('./providers');
const git = require('./git');
const { catalog, modes } = require('./catalog');

let store;
const windows = new Set();
const running = new Map();
const outputs = new Map();

function send(channel, value) {
  for (const win of windows) if (!win.isDestroyed()) win.webContents.send(channel, value);
}
function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 880, minHeight: 600,
    backgroundColor: '#11151d', titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  windows.add(win);
  win.on('closed', () => windows.delete(win));
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  return win;
}
function finishRun(id, ok, error) {
  const output = outputs.get(id);
  if (output) {
    if (output.text || output.tools.length || !ok) store.append(id, { role: 'assistant', text: output.text || error || 'Run failed.', tools: output.tools });
    outputs.delete(id);
  }
  running.delete(id);
  send('run-finished', { threadId: id, ok, error });
  send('run-state', { threadId: id, running: false });
  send('state-changed');
}
function safe(fn) { return async (_event, ...args) => fn(...args); }
function threadAndWorkspace(id) {
  const thread = store.thread(id);
  const workspace = store.data.workspaces.find(w => w.id === thread.workspaceId);
  if (!workspace || !fs.existsSync(workspace.path)) throw new Error('Workspace folder is missing.');
  return { thread, workspace };
}
app.whenReady().then(() => {
  store = new Store(path.join(app.getPath('userData'), 'orbit-data.json'));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Orbit Code', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [{ label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: createWindow }, { role: 'close' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] }
  ]));
  ipcMain.handle('snapshot', safe(() => ({ ...store.snapshot(), providers: providers.available(), catalog, modes })));
  ipcMain.handle('choose-workspace', async () => {
    const picked = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    if (picked.canceled || !picked.filePaths[0]) return null;
    const workspace = store.addWorkspace(picked.filePaths[0]); send('state-changed'); return workspace;
  });
  ipcMain.handle('set-provider-settings', safe((provider, settings) => { const value = store.setSettings(provider, settings); send('state-changed'); return value; }));
  ipcMain.handle('add-thread', safe((workspaceId, provider) => { const thread = store.addThread(workspaceId, provider); send('state-changed'); return thread; }));
  ipcMain.handle('rename-thread', safe((id, title) => { store.update(id, { title: String(title).trim().slice(0, 100) || 'Conversation' }); send('state-changed'); }));
  ipcMain.handle('delete-thread', safe(id => { if (running.has(id)) throw new Error('Stop the run first.'); store.removeThread(id); send('state-changed'); }));
  ipcMain.handle('fork-thread', safe((id, messageId) => { const thread = store.fork(id, messageId); send('state-changed'); return thread; }));
  ipcMain.handle('open-window', safe(() => createWindow().id));
  ipcMain.handle('open-folder', safe(id => { const w = store.data.workspaces.find(w => w.id === id); if (w) return shell.openPath(w.path); }));
  ipcMain.handle('skills', safe(id => { const w = store.data.workspaces.find(w => w.id === id); return providers.skills(w?.path); }));
  ipcMain.handle('git-status', safe(id => { const w = store.data.workspaces.find(w => w.id === id); if (!w) throw new Error('Workspace not found.'); return git.status(w.path); }));
  ipcMain.handle('open-github', safe(id => { const w = store.data.workspaces.find(w => w.id === id); if (!w) throw new Error('Workspace not found.'); const remote = git.status(w.path).remote; if (!remote) throw new Error('No GitHub origin remote found.'); return shell.openExternal(remote); }));
  ipcMain.handle('git-diff', safe((id, file, staged) => { const w = store.data.workspaces.find(w => w.id === id); if (!w) throw new Error('Workspace not found.'); return git.diff(w.path, file, staged); }));
  ipcMain.handle('git-stage', safe((id, file, staged) => { const w = store.data.workspaces.find(w => w.id === id); if (!w) throw new Error('Workspace not found.'); git.stage(w.path, file, staged); send('git-changed', id); }));
  ipcMain.handle('git-commit', safe((id, message) => { const w = store.data.workspaces.find(w => w.id === id); if (!w) throw new Error('Workspace not found.'); const result = git.commit(w.path, message); send('git-changed', id); return result; }));
  ipcMain.handle('send-prompt', safe((id, prompt) => {
    prompt = String(prompt || '').trim();
    if (!prompt) throw new Error('Write a message first.');
    if (running.has(id)) throw new Error('This conversation is already running.');
    const { thread, workspace } = threadAndWorkspace(id);
    const history = thread.messages;
    const actualPrompt = thread.replay ? providers.replayPrompt(history, prompt) : prompt;
    const sessionId = thread.replay ? null : thread.sessionId;
    outputs.set(id, { text: '', tools: [], partialText: '' });
    const run = providers.run({ provider: thread.provider, cwd: workspace.path, prompt: actualPrompt, sessionId, settings: store.settings(thread.provider), onEvent: event => {
      if (event.kind === 'session') { store.update(id, { sessionId: event.id, replay: false }); send('state-changed'); }
      else {
        const output = outputs.get(id);
        if (output) {
          if (event.text) {
            if (event.kind === 'partial') {
              if (!output.partialText && output.text) output.text += '\n\n';
              output.text += event.text;
              output.partialText += event.text;
            } else if (event.kind === 'result') {
              if (!output.text) output.text = event.text;
            } else if (output.partialText) {
              if (event.text !== output.partialText) output.text = output.text.slice(0, -output.partialText.length) + event.text;
              output.partialText = '';
            } else if (event.text !== output.text) output.text += (output.text ? '\n\n' : '') + event.text;
          }
          if (event.tools?.length) output.tools.push(...event.tools);
        }
        send('run-event', { threadId: id, event });
      }
    } });
    store.append(id, { role: 'user', text: prompt });
    send('state-changed');
    running.set(id, run);
    send('run-state', { threadId: id, running: true });
    run.done.then(() => finishRun(id, true), error => finishRun(id, false, error.message));
  }));
  ipcMain.handle('stop-run', safe(id => { running.get(id)?.stop(); }));
  createWindow();
  app.on('activate', () => { if (windows.size === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { for (const run of running.values()) run.stop(); });
