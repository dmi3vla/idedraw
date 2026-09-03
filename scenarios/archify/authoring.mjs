// Moved verbatim out of main.mjs (step 1 of the main.mjs decomposition).
// Acceptance code must not sit next to production code, and must not be
// loaded into the production main process on every launch.
// S5: the full authoring loop in the real app. The agent is the author: it links
// a project directory, gathers evidence via read-only project tools, authors a
// candidate, and runs archify.author over IPC to get a validated layout IR. This
// scenario drives that chain through the renderer bridge (the same surface the
// model uses), proving the wiring — IPC handlers + preload bridges + command
// registry — actually works end to end, not just in unit tests.

import path from 'node:path';
import { APP_ROOT } from '../_helpers/paths.mjs';
import { app } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTestProjectRoot } from '../_helpers/project-root.mjs';

export async function run(ctx = {}) {
  const { win, visualProof } = ctx;
  const { mode = 'full', theme = 'dark', scenario = 'none' } = ctx.argv || {};
  const __dirname = APP_ROOT;
  // MAIN-only test hook: set the fixture project root before the scenario runs.
  // This is never exposed to the renderer, so the scenario proves the tool
  // surface uses the main-owned root, not a renderer-supplied path.
  // Was a hardcoded developer home-directory path, i.e. this scenario only ever ran on one
  // machine. ARCHIFY_EXAMPLES_DIR wins; otherwise the in-repo fixture project is
  // used, and a missing directory fails loudly instead of linking nothing.
  setTestProjectRoot(archifyExamplesDir());

  const report = await win.webContents.executeJavaScript(`(async () => {
    const bridge = window.__bridge__;
    try {
      const status = await bridge.use_command('project.getStatus', {});
      if (!status.ok) return { fatal: { step: 'status', error: status.error } };

      const files = await bridge.use_command('project.listFiles', {});
      if (!files.ok) return { fatal: { step: 'listFiles', error: files.error, raw: files } };

      const cand = {
        schema_version: 1,
        diagram_type: 'architecture',
        meta: { title: 'Authoring Probe', quality_profile: 'showcase' },
        components: [
          { id: 'web', type: 'frontend', label: 'Web', sublabel: 'SPA', pos: [40, 100], size: [120, 60] },
          { id: 'api', type: 'backend', label: 'API', sublabel: ':8080', pos: [220, 100], size: [120, 60] },
          { id: 'db', type: 'database', label: 'DB', sublabel: 'pg', pos: [400, 100], size: [120, 60] },
        ],
        connections: [
          { id: 'web-api', from: 'web', to: 'api', label: 'HTTPS' },
          { id: 'api-db', from: 'api', to: 'db', label: 'SQL' },
        ],
      };

      // Capability gate: archify.author is refused when the Archify skill is not
      // enabled. Explicitly disable it first (the persisted store may have it
      // enabled from a prior run), assert the gate fires, then enable it for the
      // happy path.
      await window.skillsBridge.setEnabled('archify', false);
      const gated = await bridge.use_command('archify.author', { type: 'architecture', candidate: cand, quality: 'showcase' });
      const gatedCode = gated.ok ? null : (gated.error && gated.error.code);
      const schemaGated = await bridge.use_command('archify.getSkillFile', { kind: 'schema', type: 'architecture' });
      const schemaGatedCode = schemaGated.ok ? null : (schemaGated.error && schemaGated.error.code);
      const enabledRes = await window.skillsBridge.setEnabled('archify', true);
      if (!enabledRes.ok) return { fatal: { step: 'enableSkill', error: enabledRes.error } };

      const authored = await bridge.use_command('archify.author', { type: 'architecture', candidate: cand, quality: 'showcase' });
      if (!authored.ok) return { fatal: { step: 'author', error: authored.error } };

      const schema = await bridge.use_command('archify.getSkillFile', { kind: 'schema', type: 'architecture' });

      // Project the authored IR onto the live canvas (S6) through the PROVEN
      // preview -> confirm path (the user-visible contract), not a one-shot
      // import. Preview must not mutate the scene; confirm applies the exact
      // previewed plan in ONE undo transaction. This is the S6-LEGACY-1 goal:
      // no remaining agent/authoring flow bypasses preview/confirm.
      // The authoring scenario drives a HARDCODED candidate with no evidence
      // files, so there is no real per-component evidenceMap. Pass an honest,
      // empty map (projectContext for the projection is optional and carries no
      // absolute paths or source content).
      const projectContext = {
        evidenceMap: {},
        projectLabel: status.data.label ?? null,
        projectRoot: null,
      };
      const previewed = await bridge.use_command('canvas.previewArchifyProjection', { ir: authored.data.ir, mode: 'replace', projectContext });
      if (!previewed.ok) return { fatal: { step: 'preview', error: previewed.error } };
      const previewCounts = previewed.data.counts;
      const rawBefore = window.__canvasRaw__;
      const beforeElements = rawBefore.elements();

      const confirmed = await bridge.use_command('canvas.confirmArchifyProjection', { previewToken: previewed.data.previewToken });
      if (!confirmed.ok) return { fatal: { step: 'confirm', error: confirmed.error } };
      const raw = window.__canvasRaw__;
      const all = raw.elements();
      const counts = {
        frames: all.filter((e) => e.type === 'frame').length,
        nodes: all.filter((e) => e.type === 'rectangle').length,
        arrows: all.filter((e) => e.type === 'arrow').length,
      };

      return {
        linked: status.data.linked,
        gatedCode,
        schemaGatedCode,
        schemaOk: schema.ok && /type/.test(schema.data.content),
        files: { count: files.data.files.length, first: files.data.files[0] },
        runToken: authored.data.runToken,
        candidateHash: authored.data.candidateHash.slice(0, 12),
        ir: {
          components: authored.data.ir.components.length,
          boundaries: authored.data.ir.boundaries.length,
          connections: authored.data.ir.connections.length,
          firstX: authored.data.ir.components[0].x,
        },
        checks: authored.data.checks.length,
        projected: { ok: confirmed.ok && confirmed.data.applied === true, counts },
        preview: {
          ok: previewed.ok,
          nodes: previewCounts.components,
          edges: previewCounts.connections,
          frames: previewCounts.boundaries,
        },
        confirm: {
          applied: confirmed.data.applied === true,
          projectionId: confirmed.data.projectionId,
          status: confirmed.data.receipt && confirmed.data.receipt.status,
        },
      };
    } catch (e) {
      return { fatal: { threw: String((e && e.stack) || e) } };
    }
  })()`);

  if (report.fatal) {
    console.error('ARCHIFY-AUTHORING FAILED: ' + JSON.stringify(report.fatal));
    app.quit();
    return;
  }

  console.log('ARCHIFY-AUTHORING ' + JSON.stringify(report, null, 2));

  if (visualProof) {
    await win.webContents.executeJavaScript(`
      window.__bridge__.use_command('canvas.clearSelection');
      window.__bridge__.use_command('canvas.fitToScreen');
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    `);
    await new Promise((r) => setTimeout(r, 400));
    mkdirSync(path.join(__dirname, 'artifacts'), { recursive: true });
    const outName = `archify-authoring-${theme}.png`;
    const image = await win.webContents.capturePage();
    writeFileSync(path.join(__dirname, 'artifacts', outName), image.toPNG());
    console.log('WROTE artifacts/' + outName);
  }

  const ok =
    report.linked === true &&
    report.gatedCode === 'SKILL_DISABLED' &&
    report.schemaGatedCode === 'SKILL_DISABLED' &&
    report.schemaOk === true &&
    report.files.count > 0 &&
    report.ir.components === 3 &&
    report.ir.connections === 2 &&
    report.checks > 0 &&
    !!report.runToken &&
    Number.isFinite(report.ir.firstX) &&
    report.preview && report.preview.ok === true &&
    report.preview.nodes === 3 &&
    report.preview.edges === 2 &&
    report.confirm && report.confirm.applied === true &&
    report.confirm.status === 'applied' &&
    report.projected && report.projected.ok === true &&
    report.projected.counts.nodes === 3 &&
    report.projected.counts.arrows === 2;
  console.log(ok ? 'ARCHIFY-AUTHORING: ALL CHECKS PASSED' : 'ARCHIFY-AUTHORING: PROBLEM(S)');
  app.quit();
}
