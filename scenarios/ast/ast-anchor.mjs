// Thin wrapper over the existing main/ast-anchor-scenario.mjs (rule 8: that
// module is imported, not modified). The production functions it needs are
// imported here instead of being threaded through main.mjs, so the bootstrap no
// longer has to know what this scenario touches.
import { app } from 'electron';
import { setProjectRoot } from '../../main/project/project-root.mjs';
import { openProjectCanvas, saveProjectCanvas, publicSession, closeProjectCanvas } from '../../main/project/project-canvas-file.mjs';
import { runArchifyAstAnchorScenario } from '../../main/ast-anchor-scenario.mjs';
import { setTestProjectRoot } from '../_helpers/project-root.mjs';

export async function run(ctx = {}) {
  const { win, visualProof } = ctx;
  await runArchifyAstAnchorScenario({
    win,
    visualProof,
    ctx: { setTestProjectRoot, openProjectCanvas, setProjectRoot, publicSession, saveProjectCanvas, closeProjectCanvas, app },
  });
}
