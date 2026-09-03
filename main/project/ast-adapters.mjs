import path from 'node:path';
import { createHash } from 'node:crypto';

const JS_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);
const PHP_EXT = new Set(['.php', '.phtml', '.php3', '.php4', '.php5', '.php8']);

function lineOf(source, offset) { let line = 1; for (let i = 0; i < offset; i++) if (source.charCodeAt(i) === 10) line++; return line; }
function stableId(rel, kind, name, start, end) { return createHash('sha256').update(`${rel}\0${kind}\0${name}\0${start}\0${end}`).digest('hex').slice(0, 24); }
function rangeSymbol(rel, source, kind, name, start, end) { return { id: stableId(rel, kind, name, start, end), kind, name, line: lineOf(source, start), start, end }; }
function cap(symbols) { return symbols.sort((a,b) => a.start - b.start || a.kind.localeCompare(b.kind)).slice(0, 200); }

// Masks comments and quoted/template strings without changing offsets. This makes
// declaration matching range-exact while avoiding identifiers in comments/text.
// PHP 8 attributes `#[...]` are masked as a bracket block so their arguments
// (which may contain `class`/`function`-like identifiers) never match, and so a
// `#` that opens an attribute is NOT treated as a line comment.
function codeMask(source, php = false) {
  const out = [...source]; let i = 0; let mode = 'code'; let quote = ''; let attrDepth = 0;
  while (i < source.length) {
    const a = source[i], b = source[i + 1];
    if (mode === 'code') {
      if (a === '/' && b === '/') { out[i++] = ' '; out[i++] = ' '; mode = 'line'; continue; }
      if (a === '/' && b === '*') { out[i++] = ' '; out[i++] = ' '; mode = 'block'; continue; }
      if (php && a === '#') {
        if (b === '[') { out[i++] = ' '; out[i++] = ' '; attrDepth = 1; mode = 'attr'; continue; }
        out[i++] = ' '; mode = 'line'; continue;
      }
      if (a === '"' || a === "'" || (!php && a === '`')) { quote = a; out[i++] = ' '; mode = 'string'; continue; }
      i++; continue;
    }
    if (mode === 'line') { if (a === '\n') mode = 'code'; else out[i] = ' '; i++; continue; }
    if (mode === 'block') { out[i] = ' '; if (a === '*' && b === '/') { out[i + 1] = ' '; i += 2; mode = 'code'; } else i++; continue; }
    if (mode === 'attr') {
      out[i] = ' ';
      if (a === '"' || a === "'") { quote = a; mode = 'attr-string'; i++; continue; }
      if (a === '[') attrDepth++;
      else if (a === ']' && --attrDepth <= 0) mode = 'code';
      i++; continue;
    }
    if (mode === 'attr-string') {
      out[i] = ' ';
      if (a === '\\') { if (i + 1 < out.length) out[i + 1] = ' '; i += 2; continue; }
      if (a === quote) mode = 'attr'; i++; continue;
    }
    out[i] = ' ';
    if (a === '\\') { if (i + 1 < out.length) out[i + 1] = ' '; i += 2; continue; }
    if (a === quote) mode = 'code'; i++;
  }
  return out.join('');
}

function declarationEnd(mask, start) {
  const brace = mask.indexOf('{', start); const semi = mask.indexOf(';', start);
  if (brace < 0 || (semi >= 0 && semi < brace)) return semi >= 0 ? semi + 1 : start;
  let depth = 0;
  for (let i = brace; i < mask.length; i++) { if (mask[i] === '{') depth++; else if (mask[i] === '}' && --depth === 0) return i + 1; }
  return mask.length;
}

function collect(rel, source, mask, patterns) {
  const symbols = []; const seen = new Set();
  for (const [kind, regex, synthName] of patterns) {
    regex.lastIndex = 0; let match;
    while ((match = regex.exec(mask))) {
      const name = synthName || match.groups?.name || match[1];
      if (!name) continue;
      const nameOffset = match.index + match[0].lastIndexOf(name);
      const end = declarationEnd(mask, match.index);
      const key = `${kind}:${nameOffset}`; if (seen.has(key)) continue; seen.add(key);
      symbols.push(rangeSymbol(rel, source, kind, name, match.index, end));
    }
  }
  return cap(symbols);
}

export function parseJavaScriptAst(rel, content) {
  const source = String(content || ''); const mask = codeMask(source);
  const patterns = [
    ['function', /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(?<name>[A-Za-z_$][\w$]*)\s*\(/g],
    ['class', /\b(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(?!(?:extends\b|\{))(?<name>[A-Za-z_$][\w$]*)\b/g],
    ['interface', /\b(?:export\s+)?interface\s+(?<name>[A-Za-z_$][\w$]*)\b/g],
    ['type', /\b(?:export\s+)?type\s+(?<name>[A-Za-z_$][\w$]*)\b/g],
    ['enum', /\b(?:export\s+)?(?:const\s+)?enum\s+(?<name>[A-Za-z_$][\w$]*)\b/g],
    ['function', /\b(?:export\s+)?(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^;{}]*\)|[A-Za-z_$][\w$]*)\s*=>/g],
    // Anonymous/default exports carry no identifier; record them under a stable
    // synthetic `default` name so they still appear in the bounded graph.
    ['function', /\bexport\s+default\s+(?:async\s+)?function\s*\*?\s*\(/g, 'default'],
    ['class', /\bexport\s+default\s+(?:abstract\s+)?class\s*(?:extends\s+(?:[A-Za-z_$][\w$]*)\b|\{)/g, 'default'],
    ['arrow', /\bexport\s+default\s+(?:async\s*)?(?:\([^;{}]*\)|[A-Za-z_$][\w$]*)\s*=>/g, 'default'],
  ];
  return { adapter: 'javascript', language: 'javascript', supported: true, symbols: collect(rel, source, mask, patterns) };
}

export function parsePhpAst(rel, content) {
  const source = String(content || ''); const mask = codeMask(source, true);
  const patterns = [
    ['class', /\b(?:abstract\s+|final\s+|readonly\s+)*class\s+(?!(?:extends\b|\{))(?<name>[A-Za-z_][\w]*)\b/gi],
    ['interface', /\binterface\s+(?<name>[A-Za-z_][\w]*)\b/gi],
    ['trait', /\btrait\s+(?<name>[A-Za-z_][\w]*)\b/gi],
    ['enum', /\benum\s+(?<name>[A-Za-z_][\w]*)\b/gi],
    ['function', /\bfunction\s*&?\s*(?<name>[A-Za-z_][\w]*)\s*\(/gi],
  ];
  return { adapter: 'php', language: 'php', supported: true, symbols: collect(rel, source, mask, patterns) };
}

export function parseAstFile({ rel = '', content = '' } = {}) {
  const ext = path.posix.extname(rel).toLowerCase();
  if (JS_EXT.has(ext)) return parseJavaScriptAst(rel, content);
  if (PHP_EXT.has(ext)) return parsePhpAst(rel, content);
  return { adapter: null, language: ext.slice(1) || 'unknown', supported: false, symbols: [] };
}
