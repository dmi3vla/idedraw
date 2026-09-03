// Tests for read-only project file tools (plan slice S5). Pure Node, no renderer.
// Real temp dirs stand in for a linked project root so guards can be exercised
// against an actual escaping symlink.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listProjectFiles, readProjectFile, writeProjectTextFile, searchProjectFiles, getProjectSnapshot, resolveInside } from '../main/project/project-fs.mjs';

function setupTree() {
  const root = mkdtempSync(path.join(tmpdir(), 'projfs-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'lib'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'main.js'), "export const hi = 'world';\n");
  writeFileSync(path.join(root, 'src', 'index.md'), '# Index\nHello project.\n');
  writeFileSync(path.join(root, 'lib', 'config.mjs'), "export default { a: 1 };\n");
  writeFileSync(path.join(root, '.env'), 'SECRET=shhh\n');
  writeFileSync(path.join(root, 'README.md'), 'Read me.\n');
  mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  writeFileSync(path.join(root, 'node_modules', 'dep.js'), 'not scanned\n');
  return root;
}

test('resolveInside rejects traversal and symlink escape', () => {
  const root = setupTree();
  try {
    assert.equal(resolveInside(root, 'src/../src/main.js') !== null, true);
    assert.equal(resolveInside(root, '../outside.js'), null);
    assert.equal(resolveInside(root, '/etc/passwd'), null);
    // symlink pointing outside is refused
    const outside = mkdtempSync(path.join(tmpdir(), 'projfs-out-'));
    writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
    try {
      symlinkSync(outside, path.join(root, 'escape-link'));
      assert.equal(resolveInside(root, 'escape-link/secret.txt'), null);
    } catch (e) {
      // symlink may be unsupported on some CI; the resolveInside guard must still return null
      assert.equal(resolveInside(root, 'escape-link/secret.txt'), null);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listProjectFiles returns text files, skips node_modules/secret/binaries', () => {
  const root = setupTree();
  try {
    const res = listProjectFiles(root);
    assert.equal(res.ok, true);
    const rels = res.data.files.map((f) => f.rel);
    assert.ok(rels.includes('src/main.js'));
    assert.ok(rels.includes('README.md'));
    assert.equal(rels.some((r) => r.includes('node_modules')), false, 'node_modules must not be listed');
    assert.equal(rels.some((r) => r.includes('.env')), false, 'secret-like path must not be listed');
    assert.equal(rels.length, 4, 'only the 4 text project files should be listed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readProjectFile returns capped text and refuses secrets/binary', () => {
  const root = setupTree();
  try {
    const ok = readProjectFile(root, 'src/index.md');
    assert.equal(ok.ok, true);
    assert.match(ok.data.content, /Hello project/);
    assert.equal(ok.data.lines, 3); // trailing newline adds a line in split

    const secret = readProjectFile(root, '.env');
    assert.equal(secret.ok, false);
    assert.equal(secret.error.code, 'FORBIDDEN_PATH');

    const escaped = readProjectFile(root, '../../etc/passwd');
    assert.equal(escaped.ok, false);
    assert.equal(escaped.error.code, 'FORBIDDEN_PATH');

    const missing = readProjectFile(root, 'nope.js');
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'NOT_FOUND');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('searchProjectFiles finds name and content matches (capped)', () => {
  const root = setupTree();
  try {
    const byName = searchProjectFiles(root, 'readme');
    assert.equal(byName.ok, true);
    assert.ok(byName.data.results.some((r) => r.rel === 'README.md' && r.where === 'name'));

    const byContent = searchProjectFiles(root, 'hello');
    assert.equal(byContent.ok, true);
    assert.ok(byContent.data.results.some((r) => r.rel === 'src/index.md' && r.where === 'content'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('getProjectSnapshot yields a deterministic fingerprint', () => {
  const root = setupTree();
  try {
    const a = getProjectSnapshot(root);
    const b = getProjectSnapshot(root);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.data.fingerprint, b.data.fingerprint, 'snapshot must be stable within a run');
    assert.equal(a.data.fileCount, 4);
    assert.ok(a.data.totalBytes > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writeProjectTextFile atomically edits an existing safe source file', () => {
  const root = setupTree();
  try {
    const before = getProjectSnapshot(root).data.fingerprint;
    const saved = writeProjectTextFile(root, 'src/main.js', "export const hi = 'edited';\n");
    assert.equal(saved.ok, true);
    assert.equal(readFileSync(path.join(root, 'src', 'main.js'), 'utf8'), "export const hi = 'edited';\n");
    assert.notEqual(getProjectSnapshot(root).data.fingerprint, before);
    assert.equal(writeProjectTextFile(root, '../outside.js', 'x').error.code, 'FORBIDDEN_PATH');
    assert.equal(writeProjectTextFile(root, '.env', 'x').error.code, 'FORBIDDEN_PATH');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
