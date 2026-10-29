const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Main registers one handler per action, so only those channels answer an invoke.
const events = new Set(['changed', 'thread-changed', 'run-update', 'run-state', 'approval', 'approval-done', 'question', 'git-changed', 'menu', 'open-thread']);
contextBridge.exposeInMainWorld('hanobi', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  // The path of a dropped or pasted File; empty when it has none (for example a screenshot in the clipboard).
  pathFor: file => webUtils.getPathForFile(file),
  on: (channel, callback) => {
    if (!events.has(channel)) throw new Error(`Unknown event ${channel}`);
    const handler = (_event, value) => callback(value);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
});
