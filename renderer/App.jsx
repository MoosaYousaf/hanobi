import { lazy, Suspense } from 'react';
import { useStore } from './store.js';
import { Sidebar } from './components/Sidebar.jsx';
import { ThreadView, Home } from './components/ThreadView.jsx';
import { SidePanel } from './components/SidePanel.jsx';

// Settings is opened rarely, so it loads on first use.
const Settings = lazy(() => import('./components/Settings.jsx'));

export function App() {
  const ready = useStore(s => !!s.app);
  const threadId = useStore(s => s.ui.threadId);
  const sidebar = useStore(s => s.ui.sidebar);
  const panel = useStore(s => s.ui.panel);
  const settings = useStore(s => s.ui.settings);
  const toast = useStore(s => s.toast);
  if (!ready) return <div className="boot" />;
  return (
    <div className={`app ${sidebar ? '' : 'no-sidebar'} ${panel ? 'with-panel' : ''}`}>
      {sidebar ? <Sidebar /> : null}
      <main className="main">{threadId ? <ThreadView key={threadId} threadId={threadId} /> : <Home />}</main>
      {panel ? <SidePanel /> : null}
      {settings ? <Suspense fallback={null}><Settings /></Suspense> : null}
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </div>
  );
}
