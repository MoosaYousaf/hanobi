// Voice input: one recording at a time for the whole window. Main runs Apple speech recognition on this Mac
// (electron/speech.js). The words go into the conversation's composer while the user speaks, after any text
// already there, so the user can check them before sending. Esc puts the composer back as it was.
import { set, getState, call, toast } from '../store.js';
import { getDraft, setDraft } from '../components/Composer.jsx';

let before = '', stopAsked = false;
const setVoice = patch => set(s => ({ voice: { ...s.voice, ...patch } }));
const join = (text, words) => (!words ? text : text && !/\s$/.test(text) ? `${text} ${words}` : text + words);

window.orin.on('voice', event => {
  const { state, threadId } = getState().voice;
  if (state !== 'listening' && state !== 'transcribing') return;
  if (event.type === 'level') setVoice({ level: event.value });
  if (event.type === 'partial') setDraft(threadId, join(before, event.text));
});

export async function startVoice(threadId) {
  if (getState().voice.state !== 'idle') return;
  stopAsked = false;
  before = getDraft(threadId);
  setVoice({ state: 'starting', threadId, level: 0 });
  try {
    await call('voice:start');
    setVoice({ state: 'listening' });
    // A hold that ended while the microphone was still starting.
    if (stopAsked) stopVoice();
  } catch (error) {
    setVoice({ state: 'idle', threadId: null });
    toast(error);
  }
}

export async function stopVoice() {
  if (getState().voice.state === 'starting') { stopAsked = true; return; }
  if (getState().voice.state !== 'listening') return;
  const { threadId } = getState().voice;
  setVoice({ state: 'transcribing', level: 0 });
  try {
    setDraft(threadId, join(before, await call('voice:stop')));
  } catch (error) {
    toast(`Voice input failed: ${String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
  } finally {
    setVoice({ state: 'idle', threadId: null, level: 0 });
  }
}

export async function cancelVoice() {
  const { threadId } = getState().voice;
  setVoice({ state: 'idle', threadId: null, level: 0 });
  await call('voice:cancel').catch(() => {});
  if (threadId) setDraft(threadId, before);
}
