// Voice input: one recording at a time for the whole window. Main runs Apple speech recognition on this Mac
// (electron/speech.js). The words go into the conversation's composer while the user speaks, after any text
// already there, so the user can check them before sending. Esc puts the composer back as it was.
import { set, getState, call, toast } from '../store.js';
import { getDraft, setDraft } from '../components/Composer.jsx';

let before = '', lastApplied = '', stopAsked = false, generation = 0, startPending, stopPending;
const setVoice = patch => set(s => ({ voice: { ...s.voice, ...patch } }));
const join = (text, words) => (!words ? text : text && !/\s$/.test(text) ? `${text} ${words}` : text + words);

window.orin.on('voice', event => {
  const { state, threadId } = getState().voice;
  if (state !== 'listening' && state !== 'transcribing') return;
  if (event.type === 'level') setVoice({ level: event.value });
  if (event.type === 'partial') applyWords(threadId, event.text);
});

function applyWords(threadId, words) {
  if (getDraft(threadId) !== lastApplied) { cancelVoice({ restore: false }); return; }
  lastApplied = join(before, words);
  setDraft(threadId, lastApplied);
}

export async function startVoice(threadId) {
  if (getState().voice.state !== 'idle') return;
  stopAsked = false;
  const token = ++generation;
  before = lastApplied = getDraft(threadId);
  setVoice({ state: 'starting', threadId, level: 0 });
  try {
    startPending = call('voice:start');
    await startPending;
    if (token !== generation) { await call('voice:cancel'); return; }
    setVoice({ state: 'listening' });
    // A hold that ended while the microphone was still starting.
    if (stopAsked) stopVoice();
  } catch (error) {
    setVoice({ state: 'idle', threadId: null });
    toast(error);
  }
}

export async function stopVoice({ finish = false } = {}) {
  if (getState().voice.state === 'starting') {
    if (finish) { await startPending; return stopVoice({ finish: true }); }
    stopAsked = true; return;
  }
  if (getState().voice.state === 'transcribing') { if (finish) await stopPending; return; }
  if (getState().voice.state !== 'listening') return;
  const token = generation;
  const { threadId } = getState().voice;
  setVoice({ state: 'transcribing', level: 0 });
  stopPending = (async () => {
  try {
    const words = await call('voice:stop');
    if (token === generation) applyWords(threadId, words);
  } catch (error) {
    toast(`Voice input failed: ${String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
  } finally {
    if (token === generation) setVoice({ state: 'idle', threadId: null, level: 0 });
  }
  })();
  await stopPending;
}

export async function cancelVoice({ restore = true } = {}) {
  const { threadId } = getState().voice;
  generation++;
  setVoice({ state: 'idle', threadId: null, level: 0 });
  await call('voice:cancel').catch(() => {});
  if (restore && threadId && getDraft(threadId) === lastApplied) setDraft(threadId, before);
}
