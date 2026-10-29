// Plan limits of the CLI subscriptions, from main's 'limits' event and the limits:get handler.
import { useEffect } from 'react';
import { set, getState, useStore, call, toast } from './store.js';

export const WARN = 80, CRITICAL = 95;
export const level = used => (used >= CRITICAL ? 'full' : used >= WARN ? 'high' : '');

// "at 4:40 PM" today, "Sat 10:00 PM" this week, else "Nov 1".
export function resetText(ms) {
  if (!ms) return '';
  const date = new Date(ms), now = new Date();
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return `resets at ${time}`;
  if (ms - now < 6 * 24 * 3600 * 1000) return `resets ${date.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return `resets ${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}
export const leftText = w => (w.total ? `${w.left} of ${w.total} left` : `${100 - w.used}% left`);

// One warning per usage window and level (80%, 95%) until the window resets.
const warned = new Set();
function warn(cli, reading) {
  const lines = [];
  for (const w of reading.windows || []) {
    const at = w.used >= CRITICAL ? CRITICAL : w.used >= WARN ? WARN : 0, key = `${cli}:${w.id}:${at}:${w.resetsAt}`;
    if (!at || warned.has(key)) continue;
    warned.add(key);
    lines.push(`${w.label} ${w.used}% used, ${leftText(w)}${w.resetsAt ? `, ${resetText(w.resetsAt)}` : ''}`);
  }
  if (lines.length) toast(`${reading.plan}: near the usage limit. ${lines.join('. ')}.`);
}

export function receive({ cli, ...reading }) {
  set(s => ({ limits: { ...s.limits, [cli]: reading } }));
  warn(cli, reading);
}
window.hanobi.on('limits', receive);

// The limits of a connection's CLI, read when the conversation opens and when the hover card opens.
export function useLimits(connectionId, cli) {
  const reading = useStore(s => (cli ? s.limits?.[cli] : null));
  useEffect(() => { if (cli) refreshLimits(connectionId, cli); }, [connectionId, cli]);
  return reading;
}
export function refreshLimits(connectionId, cli) {
  const cached = getState().limits?.[cli];
  if (cached && Date.now() - cached.at < 60 * 1000) return;
  call('limits:get', connectionId).then(reading => reading && receive({ cli, ...reading })).catch(() => {});
}
