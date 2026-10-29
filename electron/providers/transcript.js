// Converts Hanobi's neutral message history into what each provider expects.
// Assistant turns keep their native request messages (`native`), so a conversation that stays on one
// provider replays exactly, including thinking blocks. Turns from another provider become plain text.
const textOf = parts => parts.filter(p => p.type === 'text').map(p => p.text).join('\n\n');
const clip = (value, max) => { const text = typeof value === 'string' ? value : JSON.stringify(value ?? ''); return text.length > max ? text.slice(0, max) + '…' : text; };

function summary(parts) {
  return parts.map(p => {
    if (p.type === 'text') return p.text;
    if (p.type === 'tool') return `[Tool ${p.name}: ${clip(p.input, 400)}${p.output !== undefined ? ` → ${clip(p.output, 800)}` : ''}]`;
    return '';
  }).filter(Boolean).join('\n\n');
}

function userContent(message, format) {
  const images = message.parts.filter(p => p.type === 'image');
  const text = textOf(message.parts);
  if (!images.length) return text;
  if (format === 'anthropic') return [...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })), { type: 'text', text }];
  return [...images.map(i => ({ type: 'image_url', image_url: { url: `data:${i.mediaType};base64,${i.data}` } })), { type: 'text', text }];
}

function toProvider(messages, format) {
  const out = [];
  for (const message of messages) {
    if (message.role === 'user') out.push({ role: 'user', content: userContent(message, format) });
    else if (message.native?.format === format && message.native.messages?.length) out.push(...message.native.messages);
    else { const text = summary(message.parts); if (text) out.push({ role: 'assistant', content: text }); }
  }
  return out;
}

// For CLI sessions that cannot resume (branches, provider switches): newest turns first, up to a limit.
function replayPrompt(messages, prompt, limit = 40000) {
  const lines = [];
  let size = 0;
  for (let i = messages.length - 1; i >= 0 && size < limit; i--) {
    const line = `${messages[i].role === 'user' ? 'User' : 'Assistant'}: ${summary(messages[i].parts)}`;
    lines.unshift(line);
    size += line.length;
  }
  return `Continue this earlier conversation. Its transcript is included for context; check the current files before changing them.\n\n${lines.join('\n\n').slice(-limit)}\n\nUser: ${prompt}`;
}

module.exports = { toProvider, replayPrompt, textOf, summary };
