// Whisper speech-to-text, off the UI thread. Model files come from hanobi-model:// (Hanobi's main process caches
// them), and Vite bundles the ONNX runtime's WebAssembly file next to this worker, so a transcription needs no network.
import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = false;
// The library checks files only on http(s) URLs, so it keeps Hugging Face URLs and every request goes to Hanobi's cache.
const HUB = 'https://huggingface.co/';
const fetchFromCache = env.fetch || fetch;
env.fetch = (url, options) => fetchFromCache(String(url).startsWith(HUB) ? 'hanobi-model://hf/' + String(url).slice(HUB.length) : url, options);
env.backends.onnx.wasm.numThreads = 1; // file:// pages are not cross-origin isolated, so no shared memory threads
env.backends.onnx.wasm.proxy = false;

let loaded = null; // { model, promise }

function load(model) {
  if (loaded?.model === model) return loaded.promise;
  const promise = pipeline('automatic-speech-recognition', model, {
    device: 'wasm', dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    progress_callback: p => { if (p.status === 'progress') self.postMessage({ type: 'progress' }); }
  });
  loaded = { model, promise };
  promise.catch(() => { if (loaded?.promise === promise) loaded = null; });
  return promise;
}

self.onmessage = async ({ data }) => {
  const { id, model, audio, language } = data;
  try {
    const transcribe = await load(model);
    if (data.type === 'load') return self.postMessage({ type: 'ready', id });
    // Speech is rarely more than 4 tokens a second. The cap stops a decoder that repeats itself.
    const seconds = audio.length / 16000;
    const out = await transcribe(audio, { chunk_length_s: 30, stride_length_s: 5, max_new_tokens: Math.min(440, Math.ceil(Math.min(seconds, 30) * 6) + 24), language: language || 'en', task: 'transcribe' });
    self.postMessage({ type: 'text', id, text: String(out.text || '').trim() });
  } catch (error) {
    self.postMessage({ type: 'error', id, message: error?.message || String(error) });
  }
};
