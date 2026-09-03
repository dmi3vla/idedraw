// Tests for the skill registry + store (plan slice S1). Pure Node, no renderer.
// A transient temp dir stands in for ~/.agents/skills so the tests never depend
// on the real user install and never mutate it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseFrontmatter,
  sha256Of,
  listDiscovered,
  readSkillFromDir,
  sortSkills,
} from '../main/skills/skill-registry.mjs';
import { createSkillStore, composeAgentSystemPrompt } from '../main/skills/skill-store.mjs';

function makeSkillDir(root, name, opts = {}) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  const md = opts.md ?? `---\nname: ${name}\ndescription: ${opts.desc || 'A skill.'}\nlicense: ${opts.license || 'MIT'}\nmetadata:\n  version: ${JSON.stringify(opts.version || '1.0.0')}\n---\n# ${name}\nBody text.\n`;
  writeFileSync(path.join(dir, 'SKILL.md'), md);
  const dataPath = path.join(dir, 'extra.json');
  writeFileSync(dataPath, JSON.stringify({ name }));
  return dir;
}

test('parseFrontmatter extracts name, description and nested metadata.version', () => {
  const md = `---\nname: archify\ndescription: Create diagrams.\nlicense: MIT\nmetadata:\n  version: "2.16"\n  author: tt-a1i\n---\nBody\n`;
  const { meta, body } = parseFrontmatter(md);
  assert.equal(meta.name, 'archify');
  assert.equal(meta.description, 'Create diagrams.');
  assert.equal(meta.license, 'MIT');
  assert.equal(meta.metadata.version, '2.16');
  assert.equal(body.trim(), 'Body');
});

test('parseFrontmatter returns null meta when no frontmatter', () => {
  const { meta, body } = parseFrontmatter('# Title\nplain text');
  assert.equal(meta, null);
  assert.equal(body, '# Title\nplain text');
});

test('sha256 is stable and differs for different content', () => {
  assert.equal(sha256Of('abc'), sha256Of('abc'));
  assert.notEqual(sha256Of('abc'), sha256Of('abd'));
});

test('readSkillFromDir reads a valid SKILL.md and reports ready', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-reg-'));
  try {
    makeSkillDir(root, 'archify', { version: '2.16', desc: 'Architecture diagrams.' });
    const rec = readSkillFromDir(path.join(root, 'archify'));
    assert.equal(rec.name, 'archify');
    assert.equal(rec.status, 'ready');
    assert.equal(rec.version, '2.16');
    assert.ok(rec.sha256);
    assert.equal(rec.id, 'local:archify');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readSkillFromDir reports missing when no SKILL.md', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-reg-'));
  try {
    mkdirSync(path.join(root, 'empty'), { recursive: true });
    const rec = readSkillFromDir(path.join(root, 'empty'));
    assert.equal(rec.status, 'missing');
    const rec2 = readSkillFromDir(path.join(root, 'nope'));
    assert.equal(rec2.status, 'invalid'); // dir does not exist
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('changed status appears when accepted hash differs', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-reg-'));
  try {
    const dir = makeSkillDir(root, 'mod', { version: '1.0.0' });
    const first = readSkillFromDir(dir);
    assert.equal(first.status, 'ready');
    // Simulate the user accepting this hash, then the file changes on disk.
    const changed = readSkillFromDir(dir, first.sha256);
    assert.equal(changed.status, 'ready');
    const mdFile = path.join(dir, 'SKILL.md');
    const withVersionBump = readFileSync(mdFile, 'utf8').replace('1.0.0', '1.1.0');
    writeFileSync(mdFile, withVersionBump);
    const after = readSkillFromDir(dir, first.sha256);
    assert.equal(after.status, 'changed');
    assert.equal(after.sha256 !== first.sha256, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listDiscovered finds skills and blocks symlink escape from the root', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-reg-'));
  try {
    makeSkillDir(root, 'alpha', { version: '1.0.0' });
    makeSkillDir(root, 'beta', { version: '2.0.0' });
    // A symlinked dir that points OUTSIDE the root must not be discovered.
    const outside = mkdtempSync(path.join(tmpdir(), 'skill-out-'));
    makeSkillDir(outside, 'evil', { version: '99' });
    symlinkSync(outside, path.join(root, 'evil-link'));
    // A dangling symlink must not break discovery either.
    symlinkSync(path.join(root, 'does-not-exist'), path.join(root, 'dangling-link'));
    try {
      const rediscovered = listDiscovered(root, {});
      const names = rediscovered.map((r) => r.name).sort();
      assert.deepEqual(names, ['alpha', 'beta']);
      assert.equal(rediscovered.some((r) => r.name === 'evil'), false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sortSkills is deterministic and case-insensitive', () => {
  const sorted = sortSkills([{ name: 'Beta' }, { name: 'alpha' }, { name: 'Gamma' }]);
  assert.deepEqual(sorted.map((s) => s.name), ['alpha', 'Beta', 'Gamma']);
});

test('skill-store persists enabled and change-detection state', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-reg-'));
  const userData = mkdtempSync(path.join(tmpdir(), 'skill-store-'));
  try {
    makeSkillDir(root, 'archify', { version: '2.16' });

    const store1 = createSkillStore(userData, root);
    const list1 = store1.list().skills;
    assert.equal(list1.length, 1);
    assert.equal(list1.find((s) => s.name === 'archify').enabled, false);

    store1.setEnabled('archify', true);
    const get1 = store1.get('archify').data;
    assert.equal(get1.enabled, true);

    // New store instance over the same userData must see the persisted enable.
    const store2 = createSkillStore(userData, root);
    const get2 = store2.get('archify').data;
    assert.equal(get2.enabled, true);

    // Accept the current hash -> a fresh read is 'ready' (not 'changed').
    store2.acceptHash('archify');
    const get3 = store2.get('archify').data;
    assert.equal(get3.status, 'ready');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});

test('remove unregisters an external skill without touching its folder', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-reg-'));
  const userData = mkdtempSync(path.join(tmpdir(), 'skill-store-'));
  const external = mkdtempSync(path.join(tmpdir(), 'skill-ext-'));
  try {
    const dir = makeSkillDir(external, 'converter', { version: '3.0.0' });
    const store = createSkillStore(userData, root);
    store.addPath(dir);
    assert.equal(store.list().skills.some((s) => s.name === 'converter'), true);

    store.remove('converter');
    const fresh = createSkillStore(userData, root);
    // The external folder is NOT under the default root so discovery no longer
    // sees it after unregistration, and the folder still exists on disk.
    assert.equal(fresh.list().skills.some((s) => s.name === 'converter'), false);
    assert.equal(existsSync(dir), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

// --- S4: agent runtime prompt composition -----------------------------------

test('composeAgentSystemPrompt keeps the base when no skills are enabled', () => {
  const out = composeAgentSystemPrompt('BASE', []);
  assert.equal(out, 'BASE');
});

test('composeAgentSystemPrompt appends each enabled skill snapshot with its hash', () => {
  const out = composeAgentSystemPrompt('BASE', [
    { name: 'archify', sha256: 'abc123456789', content: '# Archify\ndo things' },
    { name: 'orchestration', sha256: 'def987654321', content: '# Orca\ncoordinate' },
  ]);
  assert.match(out, /^BASE/);
  assert.match(out, /=== Skill: archify \(abc1234567\) ===/);
  assert.match(out, /# Archify\ndo things/);
  assert.match(out, /=== Skill: orchestration \(def9876543\) ===/);
  assert.match(out, /Не выдумывай факты/);
  // order: base first, then each skill in snapshot order
  assert.ok(out.indexOf('BASE') < out.indexOf('archify'));
  assert.ok(out.indexOf('archify') < out.indexOf('orchestration'));
});

test('enabledSnapshots returns only enabled+ready skills with content and sha256', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-snap-'));
  const userData = mkdtempSync(path.join(tmpdir(), 'skill-snap-store-'));
  try {
    makeSkillDir(root, 'archify', { version: '2.16' });
    makeSkillDir(root, 'finder', { version: '1.2.0' });
    const store = createSkillStore(userData, root);
    store.setEnabled('archify', true);
    const snaps = store.enabledSnapshots();
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].name, 'archify');
    assert.ok(snaps[0].content.includes('# archify'));
    assert.ok(snaps[0].sha256.length >= 64);
    assert.ok(snaps[0].loadedAt > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});

test('skill-store addPath registers a skill from outside the default root', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-reg-'));
  const userData = mkdtempSync(path.join(tmpdir(), 'skill-store-'));
  const external = mkdtempSync(path.join(tmpdir(), 'skill-ext-'));
  try {
    const dir = makeSkillDir(external, 'converter', { version: '3.0.0' });
    const store = createSkillStore(userData, root);
    const res = store.addPath(dir);
    assert.equal(res.ok, true);
    assert.equal(res.data.name, 'converter');
    const after = store.list().skills;
    assert.equal(after.some((s) => s.name === 'converter'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});
