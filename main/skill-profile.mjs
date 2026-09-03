// Read the enabled Archify skill's integration profile (maxRepairRounds,
// outputTarget, allowHtmlExport) from a skill store. This is the source of truth
// for the repair budget — never a model-supplied value. Kept pure (no Electron,
// no main.mjs globals) so it can be unit-tested without booting the app.
//
// The `store` is a skill-store instance (or null when the registry is absent).
// `store.list()` returns `{ skills: [...], root }` — NOT a plain array — so we
// defensively handle both shapes. When archify is missing/disabled we fall back
// to a safe default; the budget default keeps the run bounded at 4 repairs
// (the archify-runs clamp ceiling) so a weak model can iterate on diagnostics.

export const DEFAULT_SKILL_PROFILE = {
  outputTarget: 'canvas',
  allowHtmlExport: false,
  maxRepairRounds: 4,
};

export function readSkillProfile(store) {
  try {
    const result = store ? store.list() : [];
    const rows = Array.isArray(result) ? result : (result && result.skills) || [];
    const archify = rows.find((r) => r.name === 'archify' && r.enabled && r.status === 'ready');
    if (archify && archify.profile) return archify.profile;
    return { ...DEFAULT_SKILL_PROFILE };
  } catch {
    return { ...DEFAULT_SKILL_PROFILE };
  }
}
