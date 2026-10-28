const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { catalog, modes } = require('../src/catalog');
let sent = 0;
const data = {
  workspaces: [{ id: 'workspace', name: 'Example', path: '/tmp/example' }],
  threads: [{ id: 'thread', workspaceId: 'workspace', provider: 'claude', title: 'New conversation', messages: [], updatedAt: Date.now() }],
  providerSettings: { claude: { model: 'claude-opus-5-5', effort: 'high', mode: 'read' } },
  providers: [{ id: 'claude', name: 'Claude Code', installed: true }], catalog, modes
};
app.whenReady().then(async () => {
  ipcMain.handle('snapshot', () => data);
  ipcMain.handle('send-prompt', () => { sent++; });
  ipcMain.handle('set-provider-settings', (_event, provider, settings) => { data.providerSettings[provider] = settings; });
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  try {
    await win.loadFile(path.join(__dirname, '../src/index.html'));
    await new Promise(resolve => setTimeout(resolve, 400));
    const initial = await win.webContents.executeJavaScript(`({model:document.getElementById('model').value,effort:document.getElementById('effort-value').textContent,access:document.getElementById('access-mode').value})`);
    if (initial.model !== 'claude-opus-5-5' || initial.effort !== 'high' || initial.access !== 'read') throw new Error('Composer settings did not render: ' + JSON.stringify(initial));
    await win.webContents.executeJavaScript(`document.getElementById('prompt').value='Smoke test';document.getElementById('prompt').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));`);
    await new Promise(resolve => setTimeout(resolve, 300));
    if (sent !== 1) throw new Error('Enter did not send the prompt.');
    process.stdout.write('UI smoke passed: settings rendered and Enter sent.\n');
    app.exit(0);
  } catch (error) { process.stderr.write(String(error.stack || error) + '\n'); app.exit(1); }
});
