import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { PanelLeftOpen, RotateCcw } from 'lucide-react';
import { useStore, getState, setUi, call } from '../store.js';

// The Terminal page: a tmux client that main runs in a pseudo terminal (electron/terminal.js). Leaving the page
// detaches; the tmux session and its programs keep running, and the page attaches to them again.
const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');
const theme = () => {
  const css = getComputedStyle(document.documentElement);
  const v = name => css.getPropertyValue(name).trim();
  return { background: v('--bg'), foreground: v('--text'), cursor: v('--accent'), cursorAccent: v('--bg'),
    selectionBackground: darkScheme.matches ? 'rgba(245, 246, 247, .28)' : 'rgba(15, 20, 25, .18)' };
};
const message = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export default function TerminalView() {
  const sidebar = useStore(s => s.ui.sidebar);
  const box = useRef(null);
  const [error, setError] = useState('');
  const [ended, setEnded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setError(''); setEnded(false);
    const css = getComputedStyle(document.documentElement);
    const term = new Terminal({ fontFamily: css.getPropertyValue('--mono').trim(), fontSize: 13, lineHeight: 1.2, theme: theme(), cursorBlink: true, macOptionIsMeta: true, scrollback: 5000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box.current);
    fit.fit();
    let id = null, live = true;
    const early = []; // output that arrives before the client id
    const show = m => { if (m.data) term.write(m.data); if ('exit' in m) setEnded(true); };
    const off = window.orin.on('terminal', m => { if (id === null) early.push(m); else if (m.id === id) show(m); });
    // The workspace of the Code tab gives the folder of a new session; an existing session keeps its own.
    const { view, workspaceId } = getState().ui;
    call('terminal:open', { workspaceId: view === 'code' ? workspaceId : null, cols: term.cols, rows: term.rows }).then(client => {
      if (!live) { call('terminal:close', client).catch(() => {}); return; }
      id = client;
      early.filter(m => m.id === id).forEach(show);
      term.focus();
    }, e => live && setError(message(e)));
    const input = term.onData(data => { if (id) call('terminal:write', id, data).catch(() => {}); });
    const resized = term.onResize(({ cols, rows }) => { if (id) call('terminal:resize', id, cols, rows).catch(() => {}); });
    const observer = new ResizeObserver(() => { try { fit.fit(); } catch {} });
    observer.observe(box.current);
    const recolor = () => { term.options.theme = theme(); };
    darkScheme.addEventListener('change', recolor);
    return () => {
      live = false;
      darkScheme.removeEventListener('change', recolor);
      observer.disconnect(); input.dispose(); resized.dispose(); off();
      if (id) call('terminal:close', id).catch(() => {});
      term.dispose();
    };
  }, [attempt]);
  return (
    <div className="thread">
      <header className="topbar drag">
        {!sidebar ? <button className="icon-btn no-drag" title="Show sidebar (⌘\)" onClick={() => setUi({ sidebar: true })}><PanelLeftOpen size={16} /></button> : null}
        <div className="crumbs no-drag"><span className="crumb-ws">Terminal</span><span className="crumb-sep">/</span><span className="crumb-title">tmux</span></div>
      </header>
      <div className="terminal-wrap"><div className="terminal-box" ref={box} /></div>
      {error || ended ? (
        <div className="terminal-note" role="status">
          <span>{error || 'tmux closed. The session ended or you detached from it.'}</span>
          {ended ? <button className="btn" onClick={() => setAttempt(attempt + 1)}><RotateCcw size={14} /> Open tmux again</button> : null}
        </div>
      ) : null}
    </div>
  );
}
