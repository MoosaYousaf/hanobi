// Microphone audio as 16 kHz mono samples, the input Whisper expects. Chromium resamples when the
// AudioContext asks for 16 kHz. level() gives a 0..1 loudness for the button's meter.
const RATE = 16000;
const MAX_SECONDS = 300;

export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const context = new AudioContext({ sampleRate: RATE });
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  let size = 0, loudness = 0;
  processor.onaudioprocess = e => {
    const input = e.inputBuffer.getChannelData(0);
    if (size < RATE * MAX_SECONDS) { chunks.push(new Float32Array(input)); size += input.length; }
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    loudness = Math.min(1, Math.sqrt(sum / input.length) * 6);
  };
  source.connect(processor);
  processor.connect(context.destination);
  const close = async () => { processor.disconnect(); source.disconnect(); stream.getTracks().forEach(t => t.stop()); await context.close().catch(() => {}); };
  return {
    level: () => loudness,
    seconds: () => size / RATE,
    // Resolves to the samples. cancel() drops them.
    async stop() {
      await close();
      const audio = new Float32Array(size);
      let offset = 0;
      for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.length; }
      return audio;
    },
    cancel: close
  };
}
