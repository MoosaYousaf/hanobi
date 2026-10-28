const { contextBridge, ipcRenderer } = require('electron');
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const listen = (channel, callback) => { const handler = (_event, value) => callback(value); ipcRenderer.on(channel, handler); return () => ipcRenderer.removeListener(channel, handler); };
contextBridge.exposeInMainWorld('orbit', {
  snapshot: () => invoke('snapshot'), chooseWorkspace: () => invoke('choose-workspace'),
  addThread: (workspaceId, provider) => invoke('add-thread', workspaceId, provider),
  setProviderSettings: (provider, settings) => invoke('set-provider-settings', provider, settings),
  renameThread: (id, title) => invoke('rename-thread', id, title),
  deleteThread: id => invoke('delete-thread', id), forkThread: (id, messageId) => invoke('fork-thread', id, messageId),
  openWindow: () => invoke('open-window'), openFolder: id => invoke('open-folder', id), skills: id => invoke('skills', id),
  gitStatus: id => invoke('git-status', id), openGithub: id => invoke('open-github', id), gitDiff: (id, file, staged) => invoke('git-diff', id, file, staged),
  gitStage: (id, file, staged) => invoke('git-stage', id, file, staged), gitCommit: (id, message) => invoke('git-commit', id, message),
  sendPrompt: (id, prompt) => invoke('send-prompt', id, prompt), stopRun: id => invoke('stop-run', id),
  on: listen
});
