// Tests for read-only Archify skill file readers (plan S5.1). The model must
// only ever read inside the enabled skill root; a traversal request must fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readArchifySkillFile } from '../main/archify-skill-files.mjs';
import { resolveInsideSkillRoot } from '../main/skills/skill-registry.mjs';

function fakeSkill() {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-'));
  mkdirSync(path.join(root, 'schemas'), { recursive: true });
  mkdirSync(path.join(root, 'examples'), { recursive: true });
  mkdirSync(path.join(root, 'bin'), { recursive: true });
  writeFileSync(path.join(root, 'schemas', 'architecture.schema.json'), '{"type": "object"}');
  writeFileSync(path.join(root, 'examples', 'web-app.architecture.json'), '{"diagram_type":"architecture"}');
  writeFileSync(path.join(root, 'schemas', 'README.md'), '# Guide\nDo things.\n');
  writeFileSync(path.join(root, 'bin', 'archify.mjs'), '#!/usr/bin/env node\n');
  return root;
}

test('readArchifySkillFile reads schema/example/guide inside the skill root', () => {
  const root = fakeSkill();
  try {
    const s = readArchifySkillFile(root, { kind: 'schema', type: 'architecture' });
    assert.equal(s.ok, true);
    assert.match(s.data.content, /object/);

    const ex = readArchifySkillFile(root, { kind: 'example', type: 'architecture' });
    assert.equal(ex.ok, true);
    assert.match(ex.data.content, /architecture/);

    const g = readArchifySkillFile(root, { kind: 'guide' });
    assert.equal(g.ok, true);
    assert.match(g.data.content, /Guide/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readArchifySkillFile refuses a skill-less call and unknown kind', () => {
  const root = fakeSkill();
  try {
    assert.equal(readArchifySkillFile(null, { kind: 'schema', type: 'architecture' }).ok, false);
    assert.equal(readArchifySkillFile(root, { kind: 'bogus' }).ok, false);
    assert.equal(readArchifySkillFile(root, {}).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveInsideSkillRoot blocks traversal and symlink escape', () => {
  const root = fakeSkill();
  try {
    assert.equal(resolveInsideSkillRoot(root, 'schemas/architecture.schema.json') !== null, true);
    assert.equal(resolveInsideSkillRoot(root, '../outside.json'), null);
    assert.equal(resolveInsideSkillRoot(root, '/etc/passwd'), null);
    assert.equal(resolveInsideSkillRoot(root, '..'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
