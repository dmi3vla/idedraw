// Read-only Archify skill content readers (plan S5.1). The agent needs the
// skill's own schema/example/guide to author a reproducibly valid candidate, but
// it must only ever read files INSIDE the enabled Archify skill root. These are
// main-process helpers that resolve a known subpath under that root via the
// same symlink/traversal guard used everywhere else. The model never supplies a
// path — only a symbolic `kind` (schema/example/guide) and a `type`.

import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { resolveInsideSkillRoot } from './skills/skill-registry.mjs';

const KNOWN = {
  schema: (type) => path.join('schemas', `${type}.schema.json`),
  'common-schema': () => path.join('schemas', 'common.schema.json'),
  example: { list: true },
  guide: () => path.join('schemas', 'README.md'),
};

/**
 * Resolve + read a known Archify skill file. Returns the text, or an error.
 *
 *   readArchifySkillFile(root, { kind: 'schema'|'example'|'guide', type })
 */
export function readArchifySkillFile(skillRoot, { kind, type }) {
  if (!skillRoot) return { ok: false, error: { code: 'SKILL_DISABLED', message: 'Archify skill not enabled.' } };
  if (!kind) return { ok: false, error: { code: 'BAD_INPUT', message: 'Missing `kind` (schema|example|guide).' } };
  const spec = KNOWN[kind];
  if (!spec) return { ok: false, error: { code: 'BAD_INPUT', message: `Unknown kind: ${kind}` } };

  const rel = typeof spec === 'function' ? spec(type) : null;

  if (spec.list) {
    const dir = resolveInsideSkillRoot(skillRoot, 'examples');
    if (!dir) return { ok: false, error: { code: 'NOT_FOUND', message: 'Archify skill has no examples dir.' } };
    return readMatchingExample(dir, type);
  }

  if (!rel) return { ok: false, error: { code: 'BAD_INPUT', message: `Unsupported kind: ${kind}` } };
  const abs = resolveInsideSkillRoot(skillRoot, rel);
  if (!abs) return { ok: false, error: { code: 'NOT_FOUND', message: `Archify skill has no ${kind} file for type "${type}".` } };
  try {
    const text = readFileSync(abs, 'utf8');
    return { ok: true, data: { kind, type, path: abs, content: text } };
  } catch (e) {
    return { ok: false, error: { code: 'READ_ERROR', message: String((e && e.message) || e) } };
  }
}

function readMatchingExample(dir, type) {
  let files;
  try { files = readdirSync(dir); } catch { return { ok: false, error: { code: 'READ_ERROR', message: 'Cannot list examples dir.' } }; }
  const match = files.find((f) => f.endsWith(`.${type}.json`)) || files.find((f) => f.includes(`.${type}.json`));
  if (!match) return { ok: false, error: { code: 'NOT_FOUND', message: `No example for type "${type}".` } };
  const abs = path.join(dir, match);
  try {
    const text = readFileSync(abs, 'utf8');
    return { ok: true, data: { kind: 'example', type, path: abs, content: text } };
  } catch (e) {
    return { ok: false, error: { code: 'READ_ERROR', message: String((e && e.message) || e) } };
  }
}
