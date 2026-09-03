// Bootstrap ONLY: parse argv, build stores, register IPC, open the window, run a
// scenario. Everything that used to live here now has a home: main/app (argv,
// logger, window, lifecycle), main/ipc (one module per domain), main/agent
// (runtime factory), main/archify (binary, generation) and scenarios/ for all
// acceptance code. See README "Layout".
import { app, Menu } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createConfigStore } from './main/config-store.mjs';
import { createSecretStore } from './main/secret-store.mjs';
import { createSkillStore } from './main/skills/skill-store.mjs';
import { saveProjectCanvas } from './main/project/project-canvas-file.mjs';
import { createProjectAutosaveQueue } from './main/project/project-autosave.mjs';
import { parseArgs } from './main/app/argv.mjs';
import { createLogger } from './main/app/logger.mjs';
import { createMainWindow, loadRenderer, applyTheme } from './main/app/window.mjs';
import { registerLifecycle } from './main/app/lifecycle.mjs';
import { registerAllIpc } from './main/ipc/index.mjs';
import { createAgentRuntime } from './main/agent/runtime.mjs';
import { runScenario, scenarioIpcOverrides } from './scenarios/index.mjs';
import { captureArtifact, settleFrames } from './scenarios/_helpers/capture.mjs';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = parseArgs(process.argv.slice(2));
const logger = createLogger('[ARCHIFY-GEN]');

// A named profile gets its own userData dir so acceptance runs never touch the
// real config, secrets or skills of a developer's install.
if (argv.profile) {
  app.setPath('userData', path.join(tmpdir(), `canvas-v2-profile-${argv.profile}`));
}

app.disableHardwareAcceleration();

// Frameless window: no native title bar and no default menu bar. Window controls
// are rendered by the renderer and wired through windowControls in preload.cjs.
Menu.setApplicationMenu(null);

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  const configStore = createConfigStore(userData);
  const secretStore = createSecretStore(userData);
  const skillStore = createSkillStore(userData);
  const projectAutosave = createProjectAutosaveQueue({ save: saveProjectCanvas });
  // No module-level state (refactor rule 2): conversations, pending tool results,
  // frozen turn contexts and in-flight generations belong to this instance.
  const agentRuntime = createAgentRuntime({ configStore, secretStore, skillStore, logger });

  registerAllIpc({
    app,
    argv,
    logger,
    configStore,
    secretStore,
    skillStore,
    projectAutosave,
    agentRuntime,
    // Production spreads nothing here. Only an acceptance scenario injects a
    // validate fallback, so production handlers never inspect the scenario name.
    ...(await scenarioIpcOverrides(argv.scenario)),
  });
  registerLifecycle({ app });

  const win = createMainWindow({ appRoot: APP_ROOT });
  await loadRenderer(win, { appRoot: APP_ROOT, mode: argv.mode, scenario: argv.scenario });
  await applyTheme(win, argv.theme);

  const ran = await runScenario(argv.scenario, {
    win,
    app,
    argv,
    theme: argv.theme,
    visualProof: argv.visualProof,
    configStore,
    secretStore,
    skillStore,
  });
  if (ran.terminal) return;

  if (argv.visualProof) {
    await settleFrames(win);
    const suffix = argv.scenario !== 'none' ? `-${argv.scenario}` : '';
    await captureArtifact(win, `electron-${argv.mode}-${argv.theme}${suffix}.png`);
    app.quit();
  }
});
