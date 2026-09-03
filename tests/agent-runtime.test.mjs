// Tests for the AgentRunContext building blocks (plan S4.2 / S4.2.1): the
// main-owned tool allowlist, the profile-driven repair budget reader, run-dir
// cleanup, AND the frozen tool executor. All pure and verifiable without booting
// Electron or the real Archify skill.

import { test } from 'node:test';
import { writeFakeArchifyCli } from './helpers/fake-archify-cli.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  resolveAllowedCommands,
  intersectToolsWithAllowlist,
  isToolAllowed,
} from '../main/agent-allowlist.mjs';
import { readSkillProfile, DEFAULT_SKILL_PROFILE } from '../main/skill-profile.mjs';
import {
  resolveRun,
  createRun,
  cleanupStaleRunDirs,
  cleanupExpired,
  baseRunDir,
  _resetRuns,
} from '../main/archify-runs.mjs';
import {
  classifyTool,
  executeProjectTool,
  executeArchifyTool,
  toToolContent,
  isMainExecuted,
} from '../main/agent-tool-executor.mjs';

// ============================ allowlist =====================================

test('allowlist always includes the base canvas chat commands', () => {
  const allowed = resolveAllowedCommands({});
  assert.ok(allowed.has('canvas.addNode'));
  assert.ok(allowed.has('canvas.updateNode'));
  assert.ok(allowed.has('canvas.fitToScreen'));
  assert.ok(allowed.has('canvas.linkProject'));
  assert.equal(allowed.has('canvas.importArchify'), false, 'importArchify is notForChat');
});

test('allowlist excludes project read tools unless a project is linked', () => {
  const unlinked = resolveAllowedCommands({ projectLinked: false });
  assert.equal(unlinked.has('project.readFile'), false);
  assert.equal(unlinked.has('project.getStatus'), false);
  const linked = resolveAllowedCommands({ projectLinked: true });
  assert.ok(linked.has('project.readFile'));
  assert.ok(linked.has('project.getStatus'));
  assert.ok(linked.has('project.listFiles'));
});

test('allowlist only grants skill commands when the skill is enabled', () => {
  const noSkill = resolveAllowedCommands({ skillNames: [] });
  assert.equal(noSkill.has('archify.author'), false);
  assert.equal(noSkill.has('archify.getSkillFile'), false);
  const enabled = resolveAllowedCommands({ skillNames: ['archify'] });
  assert.ok(enabled.has('archify.author'));
  assert.ok(enabled.has('archify.getSkillFile'));
  const otherSkill = resolveAllowedCommands({ skillNames: ['orchestration'] });
  assert.equal(otherSkill.has('archify.author'), false);
});

test('intersectToolsWithAllowlist drops tools the main allowlist forbids', () => {
  const allowed = resolveAllowedCommands({ skillNames: ['archify'], projectLinked: true });
  const tools = [
    { name: 'canvas.addNode' },
    { name: 'project.readFile' },
    { name: 'archify.author' },
    { name: 'canvas.importArchify' },
    { name: 'archify.getSkillFile' },
  ];
  const filtered = intersectToolsWithAllowlist(tools, allowed);
  const names = filtered.map((t) => t.name);
  assert.deepEqual(names.sort(), ['archify.author', 'archify.getSkillFile', 'canvas.addNode', 'project.readFile']);
  assert.ok(!names.includes('canvas.importArchify'));
});

test('isToolAllowed rejects a name outside the allowlist even for a stale renderer list', () => {
  const allowed = resolveAllowedCommands({ skillNames: [] });
  assert.equal(isToolAllowed('archify.author', allowed), false);
  assert.equal(isToolAllowed('canvas.addNode', allowed), true);
  assert.equal(isToolAllowed('project.readFile', allowed), false);
});

// ============================ skill profile =================================

test('readSkillProfile handles the { skills, root } store shape', () => {
  const store = { list: () => ({ skills: [{ name: 'archify', enabled: true, status: 'ready', profile: { maxRepairRounds: 1 } }], root: '/x' }) };
  const profile = readSkillProfile(store);
  assert.equal(profile.maxRepairRounds, 1, 'profile-driven budget wins');
});

test('readSkillProfile falls back to default when archify is missing', () => {
  const store = { list: () => ({ skills: [], root: null }) };
  assert.deepEqual(readSkillProfile(store), DEFAULT_SKILL_PROFILE);
  assert.deepEqual(readSkillProfile(null), DEFAULT_SKILL_PROFILE);
});

test('readSkillProfile falls back to default even when list() throws', () => {
  const store = { list: () => { throw new Error('boom'); } };
  assert.deepEqual(readSkillProfile(store), DEFAULT_SKILL_PROFILE);
});

test('readSkillProfile returns default for a disabled or non-ready archify skill', () => {
  const disabled = { list: () => ({ skills: [{ name: 'archify', enabled: false, status: 'ready', profile: { maxRepairRounds: 9 } }], root: '/x' }) };
  assert.deepEqual(readSkillProfile(disabled), DEFAULT_SKILL_PROFILE);
  const changed = { list: () => ({ skills: [{ name: 'archify', enabled: true, status: 'changed', profile: { maxRepairRounds: 9 } }], root: '/x' }) };
  assert.deepEqual(readSkillProfile(changed), DEFAULT_SKILL_PROFILE);
});

// A profile with maxRepairRounds:1 must permit exactly ONE repair after the
// initial validation (attempt 1 -> repair attempt 2 -> second repair exhausted).
test('a profile maxRepairRounds of 1 permits exactly one repair', () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'skill-prof-'));
  try {
    _resetRuns();
    const budget = readSkillProfile({ list: () => ({ skills: [{ name: 'archify', enabled: true, status: 'ready', profile: { maxRepairRounds: 1 } }], root: null }) }).maxRepairRounds;
    const r = createRun(ud, { diagramType: 'architecture', quality: 'showcase', budget });
    assert.equal(r.maxRepairRounds, 1, 'profile drives the budget');
    assert.equal(r.attempt, 1, 'initial validation is attempt 1');
    const repair1 = resolveRun(r.token, ud, { diagramType: 'architecture', quality: 'showcase' });
    assert.equal(repair1.ok, true);
    assert.equal(repair1.attempt, 2);
    const repair2 = resolveRun(r.token, ud, { diagramType: 'architecture', quality: 'showcase' });
    assert.equal(repair2.ok, false);
    assert.equal(repair2.error.code, 'REPAIR_BUDGET_EXHAUSTED');
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
});

// ============================ cleanup =======================================

test('cleanupStaleRunDirs removes on-disk dirs not in the in-memory map', () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'cleanup-'));
  try {
    _resetRuns();
    const r = createRun(ud, { diagramType: 'architecture', quality: 'showcase', budget: 1 });
    const staleDir = path.join(baseRunDir(ud), 'stale-uuid-that-is-not-in-map');
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(path.join(staleDir, 'candidate.json'), '{}');

    const removed = cleanupStaleRunDirs(ud);
    assert.equal(removed, 1, 'the stale dir is removed');
    assert.equal(existsSync(staleDir), false, 'stale dir is gone from disk');
    assert.equal(existsSync(r.dir), true);
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
});

test('cleanupExpired removes expired in-memory runs and their on-disk dirs', () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'cleanup-exp-'));
  try {
    _resetRuns();
    const r = createRun(ud, { diagramType: 'architecture', quality: 'showcase', budget: 1 });
    r.expiresAt = Date.now() - 1000;
    const removed = cleanupExpired();
    assert.equal(removed, 1);
    assert.equal(existsSync(r.dir), false, 'expired run dir is removed from disk');
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
});

// ===================== frozen tool execution (S4.2.1) =======================

test('classifyTool routes canvas/project/archify, rejects unknown', () => {
  assert.equal(classifyTool('canvas.addNode'), 'canvas');
  assert.equal(classifyTool('project.readFile'), 'project');
  assert.equal(classifyTool('archify.author'), 'archify');
  assert.equal(classifyTool('project.getStatus'), 'project');
  assert.equal(classifyTool('something.else'), null);
  assert.equal(classifyTool(''), null);
  assert.equal(classifyTool(null), null);
});

test('isMainExecuted is true for project.* and archify.*, false for canvas.*', () => {
  assert.equal(isMainExecuted('project.readFile'), true);
  assert.equal(isMainExecuted('archify.author'), true);
  assert.equal(isMainExecuted('canvas.addNode'), false);
});

test('executeProjectTool reads from ctx.projectRoot, never global getProjectRoot()', () => {
  const dirA = mkdtempSync(path.join(tmpdir(), 'agent-proj-a-'));
  const dirB = mkdtempSync(path.join(tmpdir(), 'agent-proj-b-'));
  try {
    writeFileSync(path.join(dirA, 'alpha.js'), 'export const a = 1;');
    writeFileSync(path.join(dirB, 'beta.js'), 'export const b = 2;');

    const ctxA = { projectRoot: dirA };
    const ctxB = { projectRoot: dirB };

    const listA = executeProjectTool(ctxA, 'project.listFiles', {});
    const listB = executeProjectTool(ctxB, 'project.listFiles', {});
    assert.equal(listA.ok, true);
    assert.equal(listB.ok, true);
    assert.deepEqual(listA.data.files.map((f) => f.rel).sort(), ['alpha.js']);
    assert.deepEqual(listB.data.files.map((f) => f.rel).sort(), ['beta.js']);

    const readA = executeProjectTool(ctxA, 'project.readFile', { rel: 'alpha.js' });
    assert.equal(readA.ok, true);
    assert.match(readA.data.content, /a = 1/);
    const readB = executeProjectTool(ctxB, 'project.readFile', { rel: 'beta.js' });
    assert.match(readB.data.content, /b = 2/);
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test('executeProjectTool refuses project tools when ctx has no root (NOT_LINKED)', () => {
  const res = executeProjectTool({ projectRoot: null }, 'project.readFile', { rel: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'NOT_LINKED');
  const status = executeProjectTool({ projectRoot: null }, 'project.getStatus', {});
  assert.equal(status.ok, true);
  assert.equal(status.data.linked, false);
});


const VALID = {
  schema_version: 1,
  diagram_type: 'architecture',
  meta: { title: 'Frozen', quality_profile: 'showcase' },
  components: [
    { id: 'web', type: 'frontend', label: 'Web', pos: [40, 100], size: [120, 60] },
    { id: 'api', type: 'backend', label: 'API', pos: [220, 100], size: [120, 60] },
  ],
  connections: [{ id: 'w-a', from: 'web', to: 'api', label: 'HTTPS' }],
};

test('executeArchifyTool runs author with ctx.archify.binary (frozen), independent of the store', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'agent-archify-'));
  try {
    const bin = writeFakeArchifyCli(ud);
    const ctx = {
      archify: { root: ud, binary: bin, skillHash: 'deadbeef', profile: { maxRepairRounds: 1, outputTarget: 'canvas', allowHtmlExport: false } },
      appUserData: ud,
    };
    const res = await executeArchifyTool(ctx, 'archify.author', { type: 'architecture', candidate: VALID, quality: 'showcase' });
    assert.equal(res.ok, true, `expected ok, got ${JSON.stringify(res.error || {})}`);
    assert.ok(res.data.runToken);
    assert.equal(res.data.candidateHash.length >= 64, true);
    assert.equal(res.data.ir.components.length, 2);
    assert.equal(res.data.maxRepairRounds, 1);
    // Skill hash is carried into the run receipt, tying execution to the frozen snapshot.
    assert.equal(res.data.skillHash, 'deadbeef');
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
});

test('executeArchifyTool returns SKILL_DISABLED when ctx.archify is null', async () => {
  const res = await executeArchifyTool({ archify: null, appUserData: '/tmp' }, 'archify.author', { type: 'architecture', candidate: VALID });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'SKILL_DISABLED');
});

// Regression: a failed archify.author used to hand the model a bare {ok:false}
// and a weak model would stop with an empty end_turn instead of repairing (seen
// live as `guard GENERATION_FAILED — lastAuthorResult пуст`). The failure result
// must carry an actionable retry hint INSIDE the JSON, switching to `new_run`
// once the repair budget is exhausted.
test('a failed archify.author carries a retry hint (repair | new_run) and stays parseable JSON', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'agent-archify-retry-'));
  try {
    _resetRuns();
    const failing = path.join(ud, 'failing-archify.mjs');
    writeFileSync(
      failing,
      `console.log(JSON.stringify({ ok: false, error: 'candidate failed schema checks', diagnostics: [{ code: 'E_TYPE', message: 'bad component type' }] })); process.exit(1);`,
      'utf8'
    );
    const ctx = {
      archify: { root: ud, binary: failing, skillHash: 'cafe', profile: { maxRepairRounds: 1 } },
      appUserData: ud,
    };
    const input = { type: 'architecture', candidate: VALID, quality: 'showcase' };

    // Attempt 1 (fresh run): VALIDATION failure + a repair hint with the runToken.
    const first = await executeArchifyTool(ctx, 'archify.author', input);
    assert.equal(first.ok, false);
    assert.equal(first.error.code, 'VALIDATION');
    assert.deepEqual(first.diagnostics, [{ code: 'E_TYPE', message: 'bad component type' }]);
    assert.equal(first.retry.action, 'repair');
    assert.ok(first.retry.hint.includes('runToken'));
    assert.ok(first.runToken, 'failed author still returns the runToken for repair');

    // The tool_result string the model receives must stay parseable JSON.
    const parsed = JSON.parse(toToolContent(first));
    assert.equal(parsed.retry.action, 'repair');
    assert.equal(parsed.error.code, 'VALIDATION');

    // Attempt 2 (repair, same token): budget 1 still allows this one repair.
    const second = await executeArchifyTool(ctx, 'archify.author', { ...input, runToken: first.runToken });
    assert.equal(second.ok, false);
    assert.equal(second.retry.action, 'repair');

    // Attempt 3: the repair budget (1) is exhausted -> the hint switches to new_run.
    const third = await executeArchifyTool(ctx, 'archify.author', { ...input, runToken: first.runToken });
    assert.equal(third.ok, false);
    assert.equal(third.error.code, 'REPAIR_BUDGET_EXHAUSTED');
    assert.equal(third.retry.action, 'new_run');
  } finally {
    _resetRuns();
    rmSync(ud, { recursive: true, force: true });
  }
});

test('toToolContent preserves error + diagnostics (so the model can repair)', () => {
  const fail = { ok: false, error: { code: 'VALIDATION', message: 'bad' }, diagnostics: [{ code: 'E1', message: 'missing id' }] };
  const parsed = JSON.parse(toToolContent(fail));
  assert.equal(parsed.error.code, 'VALIDATION');
  assert.deepEqual(parsed.diagnostics, [{ code: 'E1', message: 'missing id' }]);
});

test('toToolContent returns string data verbatim and JSON-stringifies object data', () => {
  assert.equal(toToolContent({ ok: true, data: 'hello' }), 'hello');
  assert.equal(toToolContent({ ok: true, data: { a: 1 } }), '{"a":1}');
});
