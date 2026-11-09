const crypto = require('node:crypto');
const { OpenAI } = require('openai');
const { toProvider } = require('./transcript');

// One adapter for every OpenAI-compatible server: OpenAI, Google, OpenRouter, Ollama, LM Studio, and custom URLs.
const MAX_STEPS = 30;
function client(baseURL, apiKey) {
  // Local servers ignore the key, but the SDK requires a value.
  return new OpenAI({ baseURL, apiKey: apiKey || 'not-needed', maxRetries: 2, defaultHeaders: baseURL.includes('openrouter.ai') ? { 'HTTP-Referer': 'https://github.com/MoosaYousaf/hanobi', 'X-Title': 'Orin' } : {} });
}

// Some servers (GitHub Models) list models at a separate catalog URL instead of {baseURL}/models.
async function listModels(baseURL, apiKey, modelsURL) {
  if (modelsURL) {
    const response = await fetch(modelsURL, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Model list failed: ${response.status} ${response.statusText}`);
    const list = await response.json();
    return (Array.isArray(list) ? list : list.data || []).map(m => ({ id: m.id, label: m.name || m.id })).sort((a, b) => a.id.localeCompare(b.id));
  }
  const models = [];
  for await (const model of client(baseURL, apiKey).models.list()) models.push({ id: model.id.replace(/^models\//, ''), label: model.id.replace(/^models\//, '') });
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

async function run({ thread, baseURL, history, attachments, apiKey, system, tools, callTool, draft, signal }) {
  const api = client(baseURL, apiKey);
  const messages = toProvider(history, 'openai', attachments);
  const start = messages.length;
  const definitions = tools.map(t => ({ type: 'function', function: { name: t.qualified, description: `${t.description}\n(From the ${t.server} connector.)`.trim(), parameters: t.inputSchema } }));

  for (let step = 0; step < MAX_STEPS; step++) {
    const stream = await api.chat.completions.create({
      model: thread.model,
      stream: true,
      messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
      ...(definitions.length ? { tools: definitions } : {}),
      ...(thread.effort ? { reasoning_effort: thread.effort } : {}),
      // Mistral rejects unknown fields and sends usage without asking.
      ...(baseURL.includes('mistral.ai') ? {} : { stream_options: { include_usage: true } })
    }, { signal });
    let text = '', finish = null;
    const calls = [];
    for await (const chunk of stream) {
      // The usage chunk comes last and has no choices.
      if (chunk.usage) draft.usage = { used: (chunk.usage.prompt_tokens || 0) + (chunk.usage.completion_tokens || 0), window: null };
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (delta.content) { text += delta.content; draft.write('text', delta.content); }
      // Reasoning field names differ by server (OpenRouter, Ollama, DeepSeek-style).
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string' && reasoning) draft.write('thinking', reasoning);
      for (const call of delta.tool_calls || []) {
        const slot = calls[call.index ?? calls.length] ||= { id: call.id || `call_${crypto.randomUUID().slice(0, 8)}`, name: '', args: '' };
        if (call.function?.name) { slot.name += call.function.name; draft.tool({ id: slot.id, name: slot.name, input: {} }); }
        if (call.function?.arguments) slot.args += call.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    const present = calls.filter(Boolean);
    messages.push({ role: 'assistant', content: text || null, ...(present.length ? { tool_calls: present.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) } : {}) });
    if (!present.length || finish === 'length') break;
    const results = await Promise.all(present.map(c => {
      let input;
      try { input = JSON.parse(c.args || '{}'); }
      catch { const result = { output: 'The tool arguments were not valid JSON.', isError: true }; draft.toolResult(c.id, result); return result; }
      draft.tool({ id: c.id, name: c.name, input });
      return callTool(c.id, c.name, input);
    }));
    present.forEach((c, i) => messages.push({ role: 'tool', tool_call_id: c.id, content: results[i].output }));
  }
  return { native: { format: 'openai', messages: messages.slice(start) } };
}

// One short non-streaming reply, used for side requests such as suggested replies.
async function complete({ baseURL, apiKey, model, prompt, signal }) {
  const response = await client(baseURL, apiKey).chat.completions.create({ model, messages: [{ role: 'user', content: prompt }] }, { signal });
  return response.choices?.[0]?.message?.content || '';
}

module.exports = { run, listModels, complete };
