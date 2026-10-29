const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = 2;
const empty = () => ({ version: VERSION, workspaces: [], threads: [], connections: [], mcpServers: [], modelCache: {}, preferences: { theme: 'system', systemPrompt: '', lastModel: null } });

// Converts the Orbit Code v1 file: provider-keyed threads become connection-keyed threads.
function migrate(loaded) {
  if (loaded.version === VERSION) return { ...empty(), ...loaded, preferences: { ...empty().preferences, ...loaded.preferences } };
  if (loaded.version !== 1) throw new Error(`Unknown data version ${loaded.version}.`);
  const data = empty();
  data.workspaces = loaded.workspaces || [];
  data.threads = (loaded.threads || []).map(({ provider, messages = [], ...thread }) => {
    const settings = loaded.providerSettings?.[provider] || {};
    return {
      ...thread, connectionId: provider === 'claude' ? 'claude-code' : provider, model: settings.model || '', effort: settings.effort || '', mode: settings.mode || 'auto',
      messages: messages.map(m => ({ id: m.id, at: m.at, role: m.role, parts: [...(m.text ? [{ type: 'text', text: m.text }] : []), ...(m.tools || []).map(t => ({ type: 'tool', name: t.name, input: t.detail, status: 'done' }))] }))
    };
  });
  return data;
}

class Store {
  constructor(file) {
    this.file = file;
    this.timer = null;
    this.warning = null;
    try {
      this.data = migrate(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (error) {
      this.data = empty();
      if (error.code !== 'ENOENT') {
        // Keep the unreadable file for recovery instead of refusing to start.
        const backup = `${file}.corrupt-${Date.now()}`;
        try { fs.renameSync(file, backup); } catch {}
        this.warning = `Saved data could not be read (${error.message}). A copy is at ${backup}.`;
      }
    }
  }
  // Writes are coalesced; flush() runs synchronously at quit.
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
  // Thread list without message bodies; the renderer loads one thread at a time.
  summary() {
    const { threads, modelCache, ...rest } = this.data;
    return { ...rest, threads: threads.map(({ messages, ...t }) => ({ ...t, messageCount: messages.length })) };
  }
  workspace(id) {
    const value = this.data.workspaces.find(w => w.id === id);
    if (!value) throw new Error('Workspace not found.');
    return value;
  }
  thread(id) {
    const value = this.data.threads.find(t => t.id === id);
    if (!value) throw new Error('Conversation not found.');
    return value;
  }
  addWorkspace(folder, name = path.basename(folder)) {
    const real = fs.realpathSync(folder);
    if (!fs.statSync(real).isDirectory()) throw new Error('Choose a folder.');
    const existing = this.data.workspaces.find(w => w.path === real);
    if (existing) return existing;
    const workspace = { id: crypto.randomUUID(), name, path: real };
    this.data.workspaces.unshift(workspace);
    this.save();
    return workspace;
  }
  removeWorkspace(id) {
    this.workspace(id);
    this.data.workspaces = this.data.workspaces.filter(w => w.id !== id);
    this.data.threads = this.data.threads.filter(t => t.workspaceId !== id);
    this.save();
  }
  addThread(workspaceId, settings) {
    this.workspace(workspaceId);
    const now = Date.now();
    const thread = { id: crypto.randomUUID(), workspaceId, title: 'New conversation', sessionId: null, replay: false, messages: [], createdAt: now, updatedAt: now, ...settings };
    this.data.threads.unshift(thread);
    this.save();
    return thread;
  }
  append(id, message) {
    const thread = this.thread(id);
    const value = { id: crypto.randomUUID(), at: Date.now(), ...message };
    thread.messages.push(value);
    if (thread.title === 'New conversation' && message.role === 'user') {
      const text = message.parts.find(p => p.type === 'text')?.text || '';
      thread.title = text.replace(/\s+/g, ' ').trim().slice(0, 64) || thread.title;
    }
    thread.updatedAt = Date.now();
    this.save();
    return value;
  }
  update(id, patch) { Object.assign(this.thread(id), patch, { updatedAt: Date.now() }); this.save(); }
  removeThread(id) { this.thread(id); this.data.threads = this.data.threads.filter(t => t.id !== id); this.save(); }
  // The branch ends just before the chosen user message, so the user can edit and resend it.
  fork(id, messageId) {
    const original = this.thread(id);
    const index = original.messages.findIndex(m => m.id === messageId && m.role === 'user');
    if (index < 0) throw new Error('Message not found.');
    const { id: _id, messages, sessionId, createdAt, updatedAt, title, ...settings } = original;
    const now = Date.now();
    const branch = { ...settings, id: crypto.randomUUID(), title: `${title} · branch`, sessionId: null, replay: index > 0, messages: structuredClone(messages.slice(0, index)), createdAt: now, updatedAt: now };
    this.data.threads.unshift(branch);
    this.save();
    return branch;
  }
  upsert(collection, value) {
    const list = this.data[collection];
    const index = list.findIndex(item => item.id === value.id);
    if (index < 0) list.push(value); else list[index] = { ...list[index], ...value };
    this.save();
    return list[index < 0 ? list.length - 1 : index];
  }
  remove(collection, id) { this.data[collection] = this.data[collection].filter(item => item.id !== id); this.save(); }
}

module.exports = { Store, migrate };
