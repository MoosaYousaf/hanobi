import { useSyncExternalStore } from 'react';

// One external store for the whole window. Components subscribe to the slice they render,
// so a streaming token re-renders only the live message.
const api = window.hanobi;
export const call = (channel, ...args) => api.invoke(channel, ...args);

let state = {
  app: null,
  threads: {}, // id -> thread with messages
  live: {}, // threadId -> streaming parts
  approvals: [],
  ui: { workspaceId: null, threadId: null, panel: null, settings: null, sidebar: true },
  toast: null
};
const listeners = new Set();
const emit = () => listeners.forEach(l => l());
export const getState = () => state;
export function set(patch) { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; emit(); }
export const setUi = patch => set(s => ({ ui: { ...s.ui, ...patch } }));
const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
export const useStore = selector => useSyncExternalStore(subscribe, () => selector(state));

let toastTimer;
export function toast(message) {
  clearTimeout(toastTimer);
  set({ toast: String(message?.message || message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
  toastTimer = setTimeout(() => set({ toast: null }), 4200);
}
// Wraps an action so a failure shows a toast instead of an unhandled rejection.
export const guard = fn => async (...args) => { try { return await fn(...args); } catch (error) { toast(error); } };

export async function refresh() {
  const app = await call('state');
  const { ui } = state;
  const workspaceId = app.workspaces.some(w => w.id === ui.workspaceId) ? ui.workspaceId : app.workspaces[0]?.id || null;
  const threadId = app.threads.some(t => t.id === ui.threadId) ? ui.threadId : null;
  set({ app, ui: { ...ui, workspaceId, threadId } });
  if (app.warning && !refresh.warned) { refresh.warned = true; toast(app.warning); }
}
export async function loadThread(id) {
  if (!id) return;
  const thread = await call('thread', id);
  set(s => ({ threads: { ...s.threads, [id]: thread }, live: thread.live ? { ...s.live, [id]: thread.live } : s.live }));
}
export async function openThread(id) {
  const thread = state.app.threads.find(t => t.id === id);
  setUi({ threadId: id, workspaceId: thread?.workspaceId ?? state.ui.workspaceId });
  await loadThread(id);
}
export async function newThread(workspaceId = state.ui.workspaceId) {
  if (!workspaceId) { setUi({ settings: 'models' }); return; }
  const thread = await call('thread:new', workspaceId);
  set(s => ({ threads: { ...s.threads, [thread.id]: thread } }));
  setUi({ threadId: thread.id, workspaceId });
  await refresh();
}

export function start() {
  api.on('changed', () => refresh().catch(toast));
  api.on('thread-changed', ({ threadId }) => { if (state.threads[threadId] || state.ui.threadId === threadId) loadThread(threadId).catch(toast); refresh().catch(toast); });
  api.on('run-update', ({ threadId, parts }) => set(s => ({ live: { ...s.live, [threadId]: parts } })));
  api.on('run-state', ({ threadId, running, error }) => {
    if (running) set(s => ({ live: { ...s.live, [threadId]: s.live[threadId] || [] } }));
    // Drop the live copy only after the saved reply has loaded, so the reply never flickers out.
    else loadThread(threadId).catch(toast).finally(() => set(s => {
      const live = { ...s.live };
      delete live[threadId];
      return { live, approvals: s.approvals.filter(a => a.threadId !== threadId) };
    }));
    if (error) toast(error);
  });
  api.on('approval', request => set(s => ({ approvals: [...s.approvals, request] })));
  api.on('approval-done', ({ id }) => set(s => ({ approvals: s.approvals.filter(a => a.id !== id) })));
  api.on('menu', action => {
    if (action === 'settings') setUi({ settings: 'models' });
    if (action === 'new-thread') guard(newThread)();
    if (action === 'sidebar') setUi({ sidebar: !state.ui.sidebar });
  });
  refresh().catch(toast);
}

export async function answerApproval(id, decision) {
  set(s => ({ approvals: s.approvals.filter(a => a.id !== id) }));
  await call('run:approve', id, decision);
}
