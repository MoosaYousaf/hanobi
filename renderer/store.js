import { useSyncExternalStore } from 'react';

// One external store for the whole window. Components subscribe to the slice they render,
// so a streaming token re-renders only the live message.
const api = window.hanobi;
export const call = (channel, ...args) => api.invoke(channel, ...args);

let state = {
  app: null,
  threads: {}, // id -> thread with messages
  live: {}, // threadId -> streaming parts
  approvals: [], // approval requests and model questions; questions carry `questions`
  // panes: the threads shown side by side; threadId is the active pane. sizes: pane width fractions.
  ui: { view: null, workspaceId: null, threadId: null, projectId: null, panes: [], sizes: [], focus: false, panel: null, settings: null, sidebar: true },
  toast: null,
  dialog: null // { kind: 'text' | 'confirm', title, message, value, confirmLabel, danger, resolve }
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

// The sidebar shows Chat (general chats and projects) or Code (folders). A workspace fits the view of its kind.
export const fitsView = (workspace, view) => !!workspace && (view === 'chat') === (workspace.kind !== 'code');

export async function refresh() {
  const app = await call('state');
  const { ui } = state;
  const view = ui.view || (app.workspaces.some(w => w.kind === 'code') ? 'code' : 'chat');
  const current = app.workspaces.find(w => w.id === ui.workspaceId);
  const workspaceId = fitsView(current, view) ? current.id : app.workspaces.find(w => fitsView(w, view))?.id || null;
  const panes = ui.panes.filter(id => app.threads.some(t => t.id === id));
  // When the open thread was deleted, another pane takes over. No open thread (home or a project page) stays that way.
  const threadId = !ui.threadId || app.threads.some(t => t.id === ui.threadId) ? ui.threadId : panes[0] || null;
  const projectId = app.workspaces.some(w => w.id === ui.projectId && w.kind === 'project') ? ui.projectId : null;
  set({ app, ui: { ...ui, view, workspaceId, threadId, projectId, panes, sizes: panes.length === ui.panes.length ? ui.sizes : equal(panes.length) } });
  if (app.warning && !refresh.warned) { refresh.warned = true; toast(app.warning); }
}
export async function loadThread(id) {
  if (!id) return;
  const thread = await call('thread', id);
  set(s => ({ threads: { ...s.threads, [id]: thread }, live: thread.live ? { ...s.live, [id]: thread.live } : s.live }));
}
export const MAX_PANES = 4;
export const equal = n => Array.from({ length: n }, () => 1 / n);

// Opening a thread shows it in the active pane. A thread that is already in a pane gets focus instead.
function panesFor(id, split) {
  const { panes, threadId } = state.ui;
  if (panes.includes(id)) return panes;
  if (!threadId || !panes.includes(threadId)) return [id];
  if (split) return [...panes, id];
  return panes.map(p => (p === threadId ? id : p));
}
export function focusPane(id) { if (id !== state.ui.threadId) show(id); }
function show(id, split = false) {
  const thread = state.app.threads.find(t => t.id === id);
  const workspace = state.app.workspaces.find(w => w.id === thread?.workspaceId);
  const panes = panesFor(id, split);
  setUi({ threadId: id, projectId: null, panes, sizes: panes.length === state.ui.panes.length ? state.ui.sizes : equal(panes.length),
    workspaceId: workspace?.id ?? state.ui.workspaceId, ...(workspace ? { view: workspace.kind === 'code' ? 'code' : 'chat' } : {}) });
}
export async function openThread(id) {
  show(id);
  await loadThread(id);
}
export async function openInSplit(id) {
  if (state.ui.threadId && !state.ui.panes.includes(id) && state.ui.panes.length >= MAX_PANES) throw new Error(`Up to ${MAX_PANES} panes fit. Close a pane first.`);
  show(id, true);
  await loadThread(id);
}
export function closePane(id) {
  const panes = state.ui.panes.filter(p => p !== id);
  setUi({ panes, sizes: equal(panes.length), threadId: state.ui.threadId === id ? panes.at(-1) || null : state.ui.threadId });
}
// Without a workspace id, the new conversation goes to the selected workspace if it fits the view, else the first that fits.
export async function newThread(workspaceId, { split = false } = {}) {
  const { app, ui } = state;
  const selected = app.workspaces.find(w => w.id === ui.workspaceId);
  workspaceId ??= fitsView(selected, ui.view) ? selected.id : app.workspaces.find(w => fitsView(w, ui.view))?.id;
  if (!workspaceId) {
    if (ui.view !== 'code') { setUi({ settings: 'models' }); return; }
    const chosen = await call('workspace:choose');
    if (!chosen) return;
    workspaceId = chosen.id;
  }
  if (split && state.ui.threadId && state.ui.panes.length >= MAX_PANES) throw new Error(`Up to ${MAX_PANES} panes fit. Close a pane first.`);
  const thread = await call('thread:new', workspaceId);
  set(s => ({ threads: { ...s.threads, [thread.id]: thread }, app: { ...s.app, threads: [thread, ...s.app.threads] } }));
  show(thread.id, split);
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
  api.on('question', request => set(s => ({ approvals: [...s.approvals, request] })));
  api.on('approval-done', ({ id }) => set(s => ({ approvals: s.approvals.filter(a => a.id !== id) })));
  api.on('open-thread', id => guard(openThread)(id));
  api.on('menu', action => {
    if (action === 'settings') setUi({ settings: 'models' });
    if (action === 'new-thread') guard(newThread)();
    if (action === 'sidebar') setUi({ sidebar: !state.ui.sidebar });
    if (action === 'split') guard(() => newThread(undefined, { split: true }))();
    if (action === 'focus') toggleFocus();
    if (action === 'focus-off' && state.ui.focus) setUi({ focus: false });
  });
  refresh().catch(toast);
}

export async function answerApproval(id, decision) {
  set(s => ({ approvals: s.approvals.filter(a => a.id !== id) }));
  await call('run:approve', id, decision);
}

export async function answerQuestion(id, answers) {
  set(s => ({ approvals: s.approvals.filter(a => a.id !== id) }));
  await call('run:answer', id, answers);
}

// In-app dialogs. Electron has no window.prompt, and the native confirm sheet does not match the app.
// askText resolves to the text or null; askConfirm resolves to true or false.
export const askText = (title, value = '') => new Promise(resolve => set({ dialog: { kind: 'text', title, value, resolve } }));
export const askConfirm = ({ title, message = '', confirmLabel = 'OK', danger = false }) => new Promise(resolve => set({ dialog: { kind: 'confirm', title, message, confirmLabel, danger, resolve } }));
export function closeDialog(result) {
  state.dialog?.resolve(result);
  set({ dialog: null });
}

export async function deleteThread(thread) {
  if (!await askConfirm({ title: `Delete “${thread.title}”?`, message: 'The conversation is deleted from Hanobi. You cannot undo this.', confirmLabel: 'Delete', danger: true })) return;
  await call('thread:delete', thread.id);
  closePane(thread.id);
}

// Focus mode: one pane, edge to edge, no sidebar or toolbars, in macOS full screen. Escape or the shortcut leaves it
// and keeps full screen.
export function toggleFocus(on = !state.ui.focus) {
  setUi({ focus: on });
  // Leaving focus mode keeps the window as it is; only the layout inside the app changes.
  if (on) call('window:fullscreen', true).catch(() => {});
}
