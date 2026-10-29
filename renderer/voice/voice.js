// Voice input: one recording at a time for the whole window. The text goes into the conversation's composer,
// after any text already there, so the user can check it before sending.
import { set, getState, call, toast } from '../store.js';
import { getDraft, setDraft } from '../components/Composer.jsx';
import { startRecording } from './recorder.js';

let worker = null, recording = null, meter = null, nextId = 0, stopAsked = false;
const pending = new Map(); // request id -> { resolve, reject }
const files = new Map(); // model file -> { loaded, total }, from main's real downloads

// Main reports downloads from Hugging Face. Loading a cached model reports nothing, so no percentage shows.
window.hanobi.on('voice-download', ({ file, loaded, total, done }) => {
  if (done) files.delete(file); else files.set(file, { loaded, total });
  const all = [...files.values()], sum = all.reduce((n, f) => n + f.total, 0);
  setVoice({ progress: all.length && sum ? all.reduce((n, f) => n + f.loaded, 0) / sum : undefined, loading: true });
});

const setVoice = patch => set(s => ({ voice: { ...s.voice, ...patch } }));

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./whisper.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') { if (!getState().voice.loading) setVoice({ loading: true }); return; }
    if (data.type === 'ready') setVoice({ loading: false });
    const job = pending.get(data.id);
    if (!job) return;
    pending.delete(data.id);
    if (data.type === 'error') job.reject(new Error(data.message)); else job.resolve(data.text ?? '');
  };
  worker.onerror = e => { for (const job of pending.values()) job.reject(new Error(e.message || 'Voice input failed.')); pending.clear(); worker = null; };
  return worker;
}

function ask(message) {
  const id = ++nextId;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); getWorker().postMessage({ ...message, id }); });
}

const settings = () => getState().app?.voice || {};

export async function startVoice(threadId) {
  if (getState().voice.state !== 'idle') return;
  stopAsked = false;
  setVoice({ state: 'starting', threadId, level: 0 });
  try {
    if (!await call('voice:permission')) throw new Error('Hanobi cannot use the microphone. Allow it in System Settings → Privacy & Security → Microphone.');
    recording = await startRecording();
    setVoice({ state: 'listening' });
    meter = setInterval(() => setVoice({ level: recording?.level() ?? 0 }), 80);
    // Load the model while the user speaks, so the first transcription does not wait for it.
    ask({ type: 'load', model: settings().model }).catch(() => {});
    // A hold that ended while the microphone was still starting.
    if (stopAsked) stopVoice();
  } catch (error) {
    recording = null;
    setVoice({ state: 'idle', threadId: null });
    toast(error);
  }
}

export async function stopVoice() {
  if (getState().voice.state === 'starting') { stopAsked = true; return; }
  if (getState().voice.state !== 'listening' || !recording) return;
  clearInterval(meter);
  const { threadId } = getState().voice;
  const current = recording;
  recording = null;
  setVoice({ state: 'transcribing', level: 0 });
  try {
    const audio = await current.stop();
    if (audio.length < 16000 * 0.3) return; // a tap shorter than 0.3 s has nothing to transcribe
    const text = (await ask({ type: 'text', audio, model: settings().model, language: settings().language || '' })).replace(/^\[.*\]$/, '').trim();
    setVoice({ loading: false });
    if (text) { const draft = getDraft(threadId); setDraft(threadId, draft && !/\s$/.test(draft) ? `${draft} ${text}` : draft + text); }
  } catch (error) {
    toast(`Voice input failed: ${error.message}`);
  } finally {
    setVoice({ state: 'idle', threadId: null, progress: undefined, loading: false });
  }
}

export async function cancelVoice() {
  clearInterval(meter);
  await recording?.cancel();
  recording = null;
  setVoice({ state: 'idle', threadId: null, level: 0 });
}
