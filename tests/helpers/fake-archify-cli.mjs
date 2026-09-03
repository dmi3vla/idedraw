// Общий тест-хелпер (рефакторинг R5): раньше почти идентичный writeFakeCli был
// скопирован в tests/agent-runtime.test.mjs и tests/archify-author.test.mjs.
//
// Фейковый archify CLI НЕ зависит от реальной установки: отвечает на
//   validate <type> <candidate> --quality <q> --json   -> расписка ok
//   validate <type> <candidate> --layout-json          -> layout из самого candidate
// Это позволяет детерминированно прогонять ПОЛНЫЙ успешный путь, а не только
// ветку ARCHIFY_NOT_FOUND.
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const SOURCE = [
  "import { readFileSync } from 'node:fs';",
  'const args = process.argv.slice(2);\n',
  "const mode = args.includes('--json') ? 'json' : args.includes('--layout-json') ? 'layout' : 'none';",
  "const candidatePath = args.find((a) => a.endsWith('.json'));",
  "if (mode === 'json') {",
  "  console.log(JSON.stringify({ ok: true, checks: [{ code: 'ok', message: 'fake ok' }], diagnostics: [] }));",
  '  process.exit(0);',
  '}',
  "if (mode === 'layout') {",
  "  const candidate = JSON.parse(readFileSync(candidatePath, 'utf8'));",
  '  const comps = (candidate.components || []).map((c) => ({ id: c.id, label: c.label, sublabel: c.sublabel, x: (c.pos && c.pos[0]) || 40, y: (c.pos && c.pos[1]) || 100, width: (c.size && c.size[0]) || 120, height: (c.size && c.size[1]) || 60 }));',
  "  console.log(JSON.stringify({ diagram_type: candidate.diagram_type || 'architecture', viewBox: null, components: comps, boundaries: candidate.boundaries || [], connections: candidate.connections || [] }));",
  '  process.exit(0);',
  '}',
  'console.log(JSON.stringify({ ok: false })); process.exit(1);',
].join('\n');

/**
 * Пишет фейковый archify CLI в каталог и возвращает путь к нему.
 * @param {string} dir
 * @returns {string}
 */
export function writeFakeArchifyCli(dir) {
  const fakePath = path.join(dir, 'fake-archify.mjs');
  writeFileSync(fakePath, `${SOURCE}\n`, 'utf8');
  return fakePath;
}
