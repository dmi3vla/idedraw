import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAstFile, parseJavaScriptAst, parsePhpAst } from '../main/project/ast-adapters.mjs';

test('JS/TS adapter returns stable exact declaration ranges', () => {
  const source = `// function Fake() {}\nexport async function real(a: number) { return a }\nexport const arrow = (x: number) => x + 1;\ninterface User { id: string }`;
  const first = parseJavaScriptAst('src/app.ts', source); const second = parseJavaScriptAst('src/app.ts', source);
  assert.deepEqual(first, second);
  assert.deepEqual(first.symbols.map((s) => s.name), ['real', 'arrow', 'User']);
  for (const symbol of first.symbols) { assert.ok(symbol.end > symbol.start); assert.ok(source.slice(symbol.start, symbol.end).includes(symbol.name)); }
});

test('PHP adapter identifies class/trait/method/function with exact ranges', () => {
  const source = `<?php\ntrait Logs { public function write() { return true; } }\nfinal class Service { public function run(): void {} }\nfunction helper() {}`;
  const parsed = parsePhpAst('src/Service.php', source);
  assert.equal(parsed.adapter, 'php');
  assert.deepEqual(parsed.symbols.map((s) => s.name), ['Logs', 'write', 'Service', 'run', 'helper']);
  for (const symbol of parsed.symbols) assert.ok(source.slice(symbol.start, symbol.end).includes(symbol.name));
});

test('unsupported adapter result is explicit and content-free', () => {
  const parsed = parseAstFile({ rel: 'README.md', content: 'private source' });
  assert.deepEqual(parsed, { adapter: null, language: 'md', supported: false, symbols: [] });
  assert.equal(JSON.stringify(parsed).includes('private source'), false);
});

test('JS decorators do not consume the decorated declaration', () => {
  const source = `@Component({ selector: 'app' })\nexport class Widget {}\n@Injectable()\n@Optional()\nexport async function factory() {}\nclass Bare {}`;
  const parsed = parseJavaScriptAst('src/widget.ts', source);
  const names = parsed.symbols.map((s) => s.name);
  assert.deepEqual(names, ['Widget', 'factory', 'Bare']);
  assert.ok(names.includes('Widget') && names.includes('factory') && names.includes('Bare'));
  for (const symbol of parsed.symbols) assert.ok(source.slice(symbol.start, symbol.end).includes(symbol.name));
});

test('anonymous/default exports are recorded under a stable `default` name', () => {
  const source = `export default function() {}\nexport default class extends Base {}\nexport default (x) => x + 1;\nexport default async function named() {}\nexport const namedArrow = (a) => a;`;
  const parsed = parseJavaScriptAst('src/anonymous.js', source);
  const names = parsed.symbols.map((s) => s.name);
  // Each anonymous/default export appears (named anchor `default`); named ones keep their identifier.
  assert.ok(names.indexOf('default') >= 0);
  assert.ok(names.includes('named') && names.includes('namedArrow'));
  // The synthetic name is chosen so it is still contained in the declaration slice.
  for (const symbol of parsed.symbols.filter((symbol) => symbol.name === 'default')) {
    assert.ok(source.slice(symbol.start, symbol.end).includes('default'));
  }
});

test('anonymous default export does NOT misread a named class as `extends`', () => {
  const source = `export default class extends Base {}\nexport class Named extends Base {}`;
  const parsed = parseJavaScriptAst('src/mix.js', source);
  const names = parsed.symbols.map((s) => s.name);
  assert.ok(names.includes('default'), 'anonymous class recorded');
  assert.ok(names.includes('Named'), 'named class keeps its identifier');
  assert.ok(!names.includes('extends'), 'extends is never a name');
});

test('PHP 8 attributes are masked, not treated as a line comment', () => {
  const source = `<?php\n#[Route('/user/{id}')]\nclass UserController {}\n#[Entity] #[Column] class User {}`;
  const parsed = parsePhpAst('src/User.php', source);
  const names = parsed.symbols.map((s) => s.name);
  assert.deepEqual(names, ['UserController', 'User']);
  for (const symbol of parsed.symbols) assert.ok(source.slice(symbol.start, symbol.end).includes(symbol.name));
});

test('PHP attribute on the SAME line as a declaration still finds it', () => {
  const source = `<?php\n#[Route('/x')] public function show() {}`;
  const parsed = parsePhpAst('src/A.php', source);
  assert.ok(parsed.symbols.some((symbol) => symbol.name === 'show'));
});

test('malformed / truncated partial files never throw', () => {
  for (const input of [
    'export default function foo(',
    'export default class extends',
    'interface',
    '<?php\n#[$%^] class',
    'function abc() {',
    'export const x = (a, b',
    '',
    undefined,
    null,
  ]) {
    for (const rel of ['broken.js', 'broken.tsx', 'broken.php']) {
      assert.doesNotThrow(() => parseAstFile({ rel, content: input }));
    }
  }
});
