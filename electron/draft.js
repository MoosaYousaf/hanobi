// The one place where streamed output becomes message parts.
// Parts: { type: 'text' | 'thinking', text } and { type: 'tool', id, name, input, output, status }.
class Draft {
  constructor() {
    this.parts = [];
    this.version = 0;
    this.streamed = new Set(); // message ids whose text already arrived as deltas
  }
  last(type) { const part = this.parts.at(-1); return part?.type === type ? part : null; }
  // append=false replaces the current block of that type (used for CLIs that resend whole messages).
  write(type, text, append = true) {
    if (!text) return;
    const part = this.last(type);
    if (part && append) part.text += text;
    else if (part && !append) part.text = text;
    else this.parts.push({ type, text });
    this.version++;
  }
  tool({ id, name, server, input }) {
    const existing = id && this.parts.find(p => p.type === 'tool' && p.id === id);
    if (existing) Object.assign(existing, { input: input ?? existing.input });
    else this.parts.push({ type: 'tool', id, name, server, input, status: 'running' });
    this.version++;
  }
  toolResult(id, { output, isError = false, status }) {
    const part = this.parts.find(p => p.type === 'tool' && p.id === id) || this.parts.findLast(p => p.type === 'tool' && p.status === 'running');
    if (!part) return;
    part.output = typeof output === 'string' ? output.slice(0, 20000) : output;
    part.status = status || (isError ? 'error' : 'done');
    this.version++;
  }
  setStatus(id, status) { const part = this.parts.find(p => p.type === 'tool' && p.id === id); if (part) { part.status = status; this.version++; } }
  hasText() { return this.parts.some(p => p.type === 'text' && p.text.trim()); }
  // Finished tools that never reported a result are marked done, not left spinning.
  final() {
    return this.parts.map(p => (p.type === 'tool' && p.status === 'running' ? { ...p, status: 'done' } : p));
  }
}

module.exports = { Draft };
