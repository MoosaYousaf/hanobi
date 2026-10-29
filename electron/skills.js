const fs = require('node:fs/promises');
const path = require('node:path');

// Skill folders (each with a SKILL.md) that the CLI agents load. Hanobi lists them read-only.
async function skills(cwd) {
  const home = process.env.HOME || '';
  const locations = [
    ['Claude', path.join(home, '.claude/skills')], ['Codex', path.join(home, '.codex/skills')], ['Gemini', path.join(home, '.gemini/skills')],
    ...(cwd ? [['Workspace', path.join(cwd, '.agents/skills')], ['Workspace', path.join(cwd, '.claude/skills')], ['Workspace', path.join(cwd, '.gemini/skills')]] : [])
  ];
  const found = await Promise.all(locations.map(async ([source, folder]) => {
    const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
    const checks = await Promise.all(entries.filter(e => e.isDirectory()).map(async e => {
      const file = path.join(folder, e.name, 'SKILL.md');
      const text = await fs.readFile(file, 'utf8').catch(() => null);
      if (text === null) return null;
      const description = text.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, '') || '';
      return { source, name: e.name, description, path: path.join(folder, e.name) };
    }));
    return checks.filter(Boolean);
  }));
  return found.flat();
}

module.exports = { skills };
