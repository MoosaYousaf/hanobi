const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { defaultSettings, validate } = require('./catalog');

class Store {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, workspaces: [], threads: [], providerSettings: {} };
    try {
      const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (loaded.version === 1) this.data = loaded;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
  snapshot() { return structuredClone(this.data); }
  settings(provider) { return this.data.providerSettings?.[provider] || defaultSettings(provider); }
  setSettings(provider, settings) {
    const validated = validate(provider, settings);
    this.data.providerSettings ||= {};
    this.data.providerSettings[provider] = validated;
    this.save();
    return validated;
  }
  addWorkspace(folder) {
    const real = fs.realpathSync(folder);
    if (!fs.statSync(real).isDirectory()) throw new Error('Choose a folder.');
    const existing = this.data.workspaces.find(w => w.path === real);
    if (existing) return existing;
    const workspace = { id: crypto.randomUUID(), name: path.basename(real), path: real };
    this.data.workspaces.unshift(workspace);
    this.save();
    return workspace;
  }
  addThread(workspaceId, provider) {
    if (!this.data.workspaces.some(w => w.id === workspaceId)) throw new Error('Workspace not found.');
    if (!['claude', 'codex', 'gemini'].includes(provider)) throw new Error('Unknown provider.');
    const thread = { id: crypto.randomUUID(), workspaceId, provider, title: 'New conversation', sessionId: null, messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    this.data.threads.unshift(thread); this.save(); return thread;
  }
  thread(id) { const value = this.data.threads.find(t => t.id === id); if (!value) throw new Error('Thread not found.'); return value; }
  append(id, message) {
    const thread = this.thread(id);
    thread.messages.push({ id: crypto.randomUUID(), at: Date.now(), ...message });
    if (thread.title === 'New conversation' && message.role === 'user') thread.title = message.text.slice(0, 64).replace(/\s+/g, ' ');
    thread.updatedAt = Date.now(); this.save(); return thread;
  }
  update(id, patch) { Object.assign(this.thread(id), patch, { updatedAt: Date.now() }); this.save(); }
  removeThread(id) { this.thread(id); this.data.threads = this.data.threads.filter(t => t.id !== id); this.save(); }
  fork(id, messageId) {
    const original = this.thread(id);
    const index = original.messages.findIndex(m => m.id === messageId);
    if (index < 0) throw new Error('Message not found.');
    const branch = this.addThread(original.workspaceId, original.provider);
    branch.title = `${original.title} · rewind`;
    branch.messages = structuredClone(original.messages.slice(0, index + 1));
    branch.replay = true;
    this.save(); return branch;
  }
}
module.exports = { Store };
