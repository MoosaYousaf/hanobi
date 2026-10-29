import { lazy, Suspense, useEffect } from 'react';
import { useStore } from './store.js';
import { Sidebar } from './components/Sidebar.jsx';
import { ThreadView, Home } from './components/ThreadView.jsx';
import { SidePanel } from './components/SidePanel.jsx';
import { ProjectView } from './components/ProjectView.jsx';
import { Dialog } from './components/Dialog.jsx';

// Settings is opened rarely, so it loads on first use.
const Settings = lazy(() => import('./components/Settings.jsx'));

// Named palettes live in styles.css. A custom palette sets the accent tokens from one color.
function applyPalette(palette, accent) {
  const root = document.documentElement;
  root.dataset.palette = palette;
  for (const token of ['--accent', '--accent-hover', '--accent-soft']) root.style.removeProperty(token);
  if (palette !== 'custom' || !/^#[0-9a-f]{6}$/i.test(accent || '')) return;
  const [r, g, b] = [1, 3, 5].map(i => parseInt(accent.slice(i, i + 2), 16));
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-hover', `rgb(${r * .86 | 0}, ${g * .86 | 0}, ${b * .86 | 0})`);
  root.style.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, .12)`);
}

export function App() {
  const ready = useStore(s => !!s.app);
  const threadId = useStore(s => s.ui.threadId);
  const projectId = useStore(s => s.ui.projectId);
  const sidebar = useStore(s => s.ui.sidebar);
  const panel = useStore(s => s.ui.panel);
  const settings = useStore(s => s.ui.settings);
  const toast = useStore(s => s.toast);
  const palette = useStore(s => s.app?.preferences.palette || 'hanobi');
  const accent = useStore(s => s.app?.preferences.accent);
  useEffect(() => applyPalette(palette, accent), [palette, accent]);
  if (!ready) return <div className="boot" />;
  return (
    <div className={`app ${sidebar ? '' : 'no-sidebar'} ${panel ? 'with-panel' : ''}`}>
      {sidebar ? <Sidebar /> : null}
      <main className="main">{threadId ? <ThreadView key={threadId} threadId={threadId} /> : projectId ? <ProjectView key={projectId} projectId={projectId} /> : <Home />}</main>
      {panel ? <SidePanel /> : null}
      {settings ? <Suspense fallback={null}><Settings /></Suspense> : null}
      <Dialog />
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </div>
  );
}
