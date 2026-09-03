// Skill store (plan slice S1): persists which skills the user registered and
// enabled, plus the previously-accepted sha256 (for "changed on disk" detection)
// and a per-skill profile override. It deliberately does NOT copy or rewrite the
// installed SKILL.md — the user's skill stays owned by the user.
//
// The store is created in the main process with a userData dir (parallel to
// config-store.mjs / secret-store.mjs). Only the non-secret bits are persisted.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { listDiscovered, readSkillFromDir, sortSkills } from './skill-registry.mjs';

const DEFAULT_STATE = {
  // name -> { path, enabled, acceptedHash, profile }
  registrations: [],
};

const DEFAULT_PROFILE = {
  outputTarget: 'canvas', // 'canvas' | 'html'
  allowHtmlExport: false,
  maxRepairRounds: 2,
};

export function createSkillStore(userDataDir, root) {
  const file = path.join(userDataDir, 'skills.json');
  const skillsRoot = root;

  function load() {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      return { registrations: Array.isArray(parsed.registrations) ? parsed.registrations : [], root: parsed.root };
    } catch {
      return { registrations: [], root: null };
    }
  }

  function save(state) {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2));
  }

  const state = load();
  // If the store was created without knowing the root, adopt the registry default
  // on first write. Discovery always uses the same root we pass in.
  if (!state.root) state.root = skillsRoot;

  // Registration records keyed by normalized name.
  const byName = new Map((state.registrations || []).map((r) => [r.name, r]));

  function acceptedHashes() {
    const out = {};
    for (const r of byName.values()) {
      if (r.acceptedHash) out[r.name] = r.acceptedHash;
    }
    return out;
  }

  function list() {
    const discovered = listDiscovered(skillsRoot, acceptedHashes());
    const discByName = new Map(discovered.map((d) => [d.name, d]));
    // Merge discovered facts with persisted user choices (enabled/profile).
    const rows = [];
    const seen = new Set();
    for (const d of discovered) {
      seen.add(d.name);
      const reg = byName.get(d.name);
      rows.push({
        ...d,
        enabled: reg ? !!reg.enabled : false,
        acceptedHash: reg ? reg.acceptedHash : null,
        profile: reg && reg.profile ? reg.profile : { ...DEFAULT_PROFILE },
        profileOverride: !!(reg && reg.profile),
      });
    }
    // Include registrations whose skill dir no longer exists (status missing),
    // or that were added from an external path. Follow reg.path when given, else
    // the default root/name location.
    for (const reg of byName.values()) {
      if (seen.has(reg.name)) continue;
      const target = reg.path ? (reg.path.endsWith('SKILL.md') ? path.dirname(reg.path) : reg.path) : path.join(skillsRoot, reg.name);
      let base = readSkillFromDir(target, reg.acceptedHash);
      if (base.status === 'invalid' && !reg.path) {
        // No dir under root and no explicit path -> genuinely missing.
        base = {
          id: `local:${reg.name}`,
          name: reg.name,
          version: null,
          description: '',
          license: null,
          path: path.join(skillsRoot, reg.name, 'SKILL.md'),
          root: path.join(skillsRoot, reg.name),
          sha256: null,
          status: 'missing',
        };
      }
      rows.push({
        ...base,
        enabled: !!reg.enabled,
        acceptedHash: reg.acceptedHash || null,
        profile: reg.profile ? reg.profile : { ...DEFAULT_PROFILE },
        profileOverride: !!(reg && reg.profile),
      });
    }
    return { skills: sortSkills(rows), root: skillsRoot };
  }

  function get(name) {
    const row = list().skills.find((s) => s.name === name);
    if (!row) return { ok: false, error: { code: 'NOT_FOUND', message: `Skill not found: ${name}` } };
    return { ok: true, data: row };
  }

  function setEnabled(name, enabled) {
    const reg = byName.get(name);
    if (reg) reg.enabled = !!enabled;
    else byName.set(name, { name, enabled: !!enabled, acceptedHash: null, profile: null });
    persist();
    return get(name);
  }

  function acceptHash(name) {
    const row = get(name).data;
    if (!row) return { ok: false, error: { code: 'NOT_FOUND', message: `Skill not found: ${name}` } };
    const reg = byName.get(name) || { name };
    reg.acceptedHash = row.sha256;
    byName.set(name, reg);
    persist();
    return { ok: true, data: get(name).data };
  }

  function addPath(skillPath) {
    // Skill path may be the /SKILL.md file or its directory. Normalize to the
    // directory that contains SKILL.md, then register by its frontmatter name.
    const resolved = path.resolve(skillPath);
    const root = resolved.endsWith('SKILL.md') ? path.dirname(resolved) : resolved;
    const rec = readSkillFromDir(root);
    if (!rec || rec.status === 'missing' || rec.status === 'invalid') {
      return { ok: false, error: { code: 'BAD_INPUT', message: `No valid SKILL.md at: ${skillPath}` } };
    }
    const reg = byName.get(rec.name) || { name: rec.name };
    reg.path = resolved;
    reg.enabled = !!reg.enabled;
    byName.set(rec.name, reg);
    persist();
    return { ok: true, data: get(rec.name).data };
  }

  function remove(name) {
    byName.delete(name);
    persist();
    return { ok: true, data: { removed: name } };
  }

  function setProfile(name, profile) {
    const reg = byName.get(name) || { name };
    reg.profile = { ...DEFAULT_PROFILE, ...(profile || {}) };
    byName.set(name, reg);
    persist();
    return get(name);
  }

  // Frozen, immutable snapshot of the currently ENABLED skills, with their
  // content and sha256, as of this call. The runtime freezes this once per turn
  // so mid-turn settings changes cannot alter an in-flight prompt/toolset.
  function enabledSnapshots() {
    const rows = list().skills.filter((s) => s.enabled && s.status === 'ready');
    const out = [];
    for (const row of rows) {
      try {
        const raw = readFileSync(row.path, 'utf8');
        out.push({
          skillId: row.id,
          name: row.name,
          content: raw,
          sha256: row.sha256,
          loadedAt: Date.now(),
          // path + root let the runtime locate the skill's OWN files (e.g.
          // bin/archify.mjs) inside the skill dir. This is only ever read in the
          // main process; the model never supplies a path.
          path: row.path,
          root: row.root,
        });
      } catch {
        // unreadable skill: skip silently, the runtime just won't include it
      }
    }
    return out;
  }

  function persist() {
    save({ registrations: Array.from(byName.values()), root: skillsRoot });
  }

  return { list, get, setEnabled, acceptHash, addPath, remove, setProfile, enabledSnapshots, root: skillsRoot };
}

// Pure composition used by the agent runtime (main.mjs) to build the system
// prompt for a chat turn. Kept here — and exported — so it can be unit-tested
// without booting Electron. Order: base policy, then each enabled skill's
// SKILL.md content, then a short instruction to lean on the skills.
export function composeAgentSystemPrompt(base, snapshots) {
  const parts = [base || ''];
  for (const s of snapshots || []) {
    if (!s || !s.content) continue;
    const hash = s.sha256 ? s.sha256.slice(0, 10) : 'unknown';
    parts.push(`\n=== Skill: ${s.name} (${hash}) ===\n${s.content}`);
  }
  if (snapshots && snapshots.length) {
    parts.push('\nИспользуй включённые skill-инструкции выше для предметной работы. Не выдумывай факты: опирайся на доступные инструменты и на реальные данные проекта/холста.');
  }
  return parts.join('\n');
}
