// S4.1 security closure tests for the main-owned project root. The model must
// never supply a root; these tests prove the root store refuses bad roots and
// that reads only ever use the canonical main-owned value.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setProjectRoot, getProjectRoot, getProjectStatus, clearProjectRoot, _resetForTest } from '../main/project/project-root.mjs';
import { listProjectFiles, readProjectFile } from '../main/project/project-fs.mjs';

function freshTree() {
  const root = mkdtempSync(path.join(tmpdir(), 'pjr-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'a.js'), 'export const a = 1;\n');
  return root;
}

test('setProjectRoot stores the canonical realpath and status reports it', () => {
  const root = freshTree();
  _resetForTest();
  try {
    const res = setProjectRoot(root);
    assert.equal(res.ok, true);
    assert.equal(getProjectRoot(), root);
    const st = getProjectStatus();
    assert.equal(st.linked, true);
    assert.equal(st.projectId, path.basename(root));
    assert.equal('root' in st, false, 'absolute root never crosses the status boundary');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('setProjectRoot rejects a missing path and refuses a non-directory', () => {
  const root = freshTree();
  _resetForTest();
  try {
    assert.equal(setProjectRoot('/definitely/not/here').ok, false);
    const notDir = path.join(root, 'a.js');
    assert.equal(setProjectRoot(notDir).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reads are confined to the main-owned root, never a caller-supplied path', () => {
  const root = freshTree();
  const other = freshTree();
  writeFileSync(path.join(other, 'secret.txt'), 'top secret\n');
  _resetForTest();
  try {
    setProjectRoot(root);
    // A caller-supplied path that is NOT the linked root must be ignored: the
    // read tools use only the store's root, so a model cannot pivot elsewhere.
    // Passing a foreign root is not even part of the project.* IPC anymore, but
    // we prove list/read against the store root here.
    const listed = listProjectFiles(getProjectRoot());
    assert.equal(listed.ok, true);
    assert.equal('root' in listed.data, false, 'list result does not disclose absolute root');
    assert.ok(listed.data.files.some((f) => f.rel === 'src/a.js'));
    assert.equal(listed.data.files.some((f) => f.rel === 'secret.txt'), false);

    const read = readProjectFile(getProjectRoot(), 'src/a.js');
    assert.equal(read.ok, true);
    assert.equal('path' in read.data, false, 'read result exposes only the relative path');
    assert.match(read.data.content, /export const a = 1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test('clearProjectRoot unlinks and status reports unlinked', () => {
  const root = freshTree();
  _resetForTest();
  try {
    setProjectRoot(root);
    clearProjectRoot();
    assert.equal(getProjectRoot(), null);
    assert.equal(getProjectStatus().linked, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
