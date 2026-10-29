import { lazy, Suspense, useEffect, useRef, Fragment } from 'react';
import { useStore, getState, setUi, focusPane, toggleFocus, equal } from './store.js';
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

const MIN_PANE = 340; // px

// Threads side by side. Each divider resizes its two neighbours; a double click makes all panes equal.
function Panes() {
  const panes = useStore(s => s.ui.panes);
  const sizes = useStore(s => s.ui.sizes);
  const threadId = useStore(s => s.ui.threadId);
  const focus = useStore(s => s.ui.focus);
  const ref = useRef(null);
  const list = focus || !panes.includes(threadId) ? [threadId] : panes;
  const fractions = list.length === sizes.length ? sizes : equal(list.length);
  const drag = (i, start) => {
    const total = ref.current.getBoundingClientRect().width;
    const min = Math.min(MIN_PANE / total, 0.6 / list.length);
    const pair = fractions[i] + fractions[i + 1];
    const move = e => {
      const left = Math.min(pair - min, Math.max(min, fractions[i] + (e.clientX - start) / total));
      setUi({ sizes: fractions.map((f, j) => (j === i ? left : j === i + 1 ? pair - left : f)) });
    };
    const up = () => { document.body.classList.remove('resizing'); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    document.body.classList.add('resizing');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return (
    <div className="panes" ref={ref}>
      {list.map((id, i) => (
        <Fragment key={id}>
          {i ? <div className="pane-divider" role="separator" aria-orientation="vertical" aria-label="Resize panes" title="Drag to resize. Double-click to make panes equal."
            onMouseDown={e => { e.preventDefault(); drag(i - 1, e.clientX); }} onDoubleClick={() => setUi({ sizes: equal(list.length) })} /> : null}
          <div className={`pane ${list.length > 1 && id === threadId ? 'active' : ''}`} style={{ flex: `${fractions[i]} 1 0` }} onMouseDownCapture={() => focusPane(id)}>
            <ThreadView threadId={id} panes={list.length} index={i} />
          </div>
        </Fragment>
      ))}
    </div>
  );
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
  const focus = useStore(s => s.ui.focus);
  // Escape leaves focus mode unless a dialog, menu, or message edit is open.
  useEffect(() => {
    const key = e => {
      if (e.key !== 'Escape' || !getState().ui.focus || getState().dialog) return;
      if (document.activeElement?.closest('.edit-box, .menu, .dialog, .settings, .rewind-menu')) return;
      toggleFocus(false);
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  if (!ready) return <div className="boot" />;
  return (
    <div className={`app ${sidebar && !focus ? '' : 'no-sidebar'} ${panel && !focus ? 'with-panel' : ''} ${focus && threadId ? 'focus' : ''}`}>
      {sidebar && !focus ? <Sidebar /> : null}
      <main className="main">{threadId ? <Panes /> : projectId ? <ProjectView key={projectId} projectId={projectId} /> : <Home />}</main>
      {panel && !focus ? <SidePanel /> : null}
      {settings ? <Suspense fallback={null}><Settings /></Suspense> : null}
      <Dialog />
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </div>
  );
}
