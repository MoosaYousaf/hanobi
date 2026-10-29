const { contextBridge, ipcRenderer } = require('electron');

// Main registers one handler per action, so only those channels answer an invoke.
const events = new Set(['changed', 'thread-changed', 'run-update', 'run-state', 'approval', 'approval-done', 'git-changed', 'menu']);
contextBridge.exposeInMainWorld('hanobi', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, callback) => {
    if (!events.has(channel)) throw new Error(`Unknown event ${channel}`);
    const handler = (_event, value) => callback(value);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
});
