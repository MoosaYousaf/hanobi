// Suggested replies: short messages the user could send next, shown under the latest reply.
// Claude Code makes its own (--prompt-suggestions). API and local models get one extra request when the user turns it on.
const MAX = 3;

const lastText = message => (message?.parts || []).filter(p => p.type === 'text').map(p => p.text).join('\n\n');

function prompt(user, reply) {
  return [
    'Below is the last exchange of a conversation between a user and an assistant.',
    `<user>\n${lastText(user).slice(-4000)}\n</user>`,
    `<assistant>\n${lastText(reply).slice(-8000)}\n</assistant>`,
    `Write up to ${MAX} short messages that the user could send next. Write them as the user. Keep each under 12 words.`,
    'Return only a JSON array of strings.'
  ].join('\n\n');
}

// Models sometimes wrap the array in prose or a code fence; take the first array and keep only short strings.
function parse(text) {
  const match = String(text || '').match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const list = JSON.parse(match[0]);
    return Array.isArray(list) ? [...new Set(list.filter(s => typeof s === 'string').map(s => s.trim()).filter(s => s && s.length <= 160))].slice(0, MAX) : [];
  } catch { return []; }
}

module.exports = { prompt, parse, MAX };
