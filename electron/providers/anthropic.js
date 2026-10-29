const { Anthropic, APIError } = require('@anthropic-ai/sdk');
const { toProvider } = require('./transcript');

const MAX_STEPS = 30;
// Adaptive thinking exists on the 4.6+ generations; older models reject the parameter.
const adaptive = model => /^claude-(opus|sonnet|haiku|fable|mythos)-(5|4-[6-9])/.test(model);
// Server-side refusal fallback is available on these models (Claude API only).
const fallbackModels = /^claude-(opus-5(-5)?|fable-5-1|sonnet-5-5)$/;

function client(apiKey) { return new Anthropic({ apiKey, maxRetries: 2 }); }

async function listModels(apiKey) {
  const models = [];
  for await (const model of client(apiKey).models.list({ limit: 100 })) models.push({ id: model.id, label: model.display_name || model.id });
  return models;
}

async function run({ thread, history, attachments, apiKey, system, tools, callTool, draft, signal }) {
  const api = client(apiKey);
  const messages = toProvider(history, 'anthropic', attachments);
  const start = messages.length;
  const definitions = tools.map(t => ({ name: t.qualified, description: `${t.description}\n(From the ${t.server} connector.)`.trim(), input_schema: t.inputSchema, eager_input_streaming: true }));
  const fallback = fallbackModels.test(thread.model);
  let jsonRetries = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    const stream = api.beta.messages.stream({
      model: thread.model,
      max_tokens: 64000,
      messages,
      ...(system ? { system } : {}),
      ...(definitions.length ? { tools: definitions } : {}),
      ...(adaptive(thread.model) ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
      ...(thread.effort ? { output_config: { effort: thread.effort } } : {}),
      ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {})
    }, { signal });
    for await (const event of stream) {
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') draft.tool({ id: event.content_block.id, name: event.content_block.name, input: {} });
      else if (event.type === 'content_block_start' && event.content_block.type === 'text' && draft.last('text')) draft.parts.push({ type: 'text', text: '' });
      else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') draft.write('text', event.delta.text);
      else if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') draft.write('thinking', event.delta.thinking);
    }
    let message;
    try { message = await stream.finalMessage(); jsonRetries = 0; }
    catch (error) {
      // An unparseable streamed tool input is retried; API errors are not.
      if (error instanceof APIError || signal.aborted || jsonRetries++ >= 2) throw error;
      continue;
    }
    const u = message.usage || {};
    draft.usage = { used: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0), window: null };
    messages.push({ role: 'assistant', content: message.content });
    const uses = message.content.filter(b => b.type === 'tool_use');
    if (message.stop_reason === 'refusal') { draft.write('text', '\n\nThe model declined this request.'); break; }
    if (message.stop_reason === 'pause_turn') continue;
    if (message.stop_reason === 'max_tokens' && uses.length) { draft.write('text', '\n\nThe reply reached the output limit before a tool call was complete.'); break; }
    if (message.stop_reason !== 'tool_use' || !uses.length) break;
    for (const use of uses) draft.tool({ id: use.id, name: use.name, input: use.input });
    // Parallel calls run together, and all results return in one user message.
    const results = await Promise.all(uses.map(use => callTool(use.id, use.name, use.input)));
    messages.push({ role: 'user', content: uses.map((use, i) => ({ type: 'tool_result', tool_use_id: use.id, content: results[i].output, ...(results[i].isError ? { is_error: true } : {}) })) });
  }
  return { native: { format: 'anthropic', messages: messages.slice(start) } };
}

// One short non-streaming reply, used for side requests such as suggested replies.
async function complete({ apiKey, model, prompt, signal }) {
  const message = await client(apiKey).messages.create({ model, max_tokens: 400, messages: [{ role: 'user', content: prompt }] }, { signal });
  return message.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

module.exports = { run, listModels, complete };
