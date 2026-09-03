# canvas-v2-rebuild

Independent Excalidraw canvas + independent chat, connected only through a
bridge protocol, with an optional (off by default) link to a project graph,
in light/dark theme. See `ACCEPTANCE.md` for what's verified and how.

## Quickstart

```
npm install
npm run build
npm start                      # full app, both panels
npm start -- --mode=chat-only  # chat alone, no canvas mounted
npm start -- --mode=canvas-only
npm run test:protocol          # structural checks (fast, no Electron window)
npm run verify:visual          # real screenshots into artifacts/
npm run verify:ui              # live S6 UI acceptance (real toolbar + React dialog) into artifacts/
npm run verify:pixel           # S7 mandatory dark/light pixel gate (all nodes lPad/rPad >= 8)
npm run verify:stress         # load test: 100/500/1500 nodes, bridge vs baseline
```

Note: `npm start` runs Electron with `--no-sandbox` because npm install cannot
set the SUID sandbox helper permissions (`chrome-sandbox` must be root-owned
with mode 4755). To restore the sandbox instead, run once:

```
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

## Layout

```
src/
  canvas/
    adapter.mjs     — vanilla boundary; only this file talks to Excalidraw's API
    mount.jsx        — React island, mounts <Excalidraw>, wires real onChange events
  project/
    project-store.mjs — independent project graph + link/unlink state
  bridge/
    bridge.mjs         — the ONLY surface chat is allowed to import
    command-registry.mjs, query-handler.mjs, context-store.mjs, protocol-result.mjs
  chat/
    chat-panel.mjs    — vanilla DOM chat UI, imports only bridge.mjs
    llm-client.mjs    — STUB, see file header — swap for real Anthropic streaming client
    models.json       — model id list for the settings form (editable without rebuild)
    chat.css
  theme/
    theme.mjs         — single pub/sub theme store, applied once on <html>
  stress/
    generate-graph.mjs — deterministic synthetic graph (grid + seeded neighbor edges)
    run-stress.mjs     — renderer-side runner: bridge/baseline fill, FPS pan test, add/remove cycles
  renderer-entry.jsx  — composition root; the only file that imports both canvas and chat
main.mjs              — bootstrap ONLY (≤150 lines): parse argv, build stores, registerAllIpc(deps),
                        open the window, run a scenario. No handlers, no scenario bodies.
main/
  app/
    argv.mjs         — parseArgs(): --mode, --theme, --scenario, --visual-proof, --count, --profile
    logger.mjs       — createLogger(tag) → { log, err, snip }
    window.mjs       — createMainWindow / loadRenderer / applyTheme (idempotent __setTheme__)
    lifecycle.mjs    — window-all-closed + the hourly cleanup timer
  ipc/
    index.mjs        — registerAllIpc(deps): the single registration point
    window.ipc.mjs, config.ipc.mjs, chat.ipc.mjs, archify.ipc.mjs, project.ipc.mjs, skills.ipc.mjs
    ast.ipc.mjs      — project:expandAstAnchor / readAstPreview (READ-only AST)
    editor.ipc.mjs   — project:writeAstFile — the ONE write path into a linked project, isolated for audit
  agent/
    runtime.mjs      — createAgentRuntime({...}); owns conversations, pending tool results, turn contexts
    conversation.mjs — walkToolCalls / lastAuthorResult / lastAuthorFailure / lastCallResult (pure, unit-tested)
    system-prompt.mjs
  archify/
    binary.mjs       — resolveArchifyBinary(skillStore)
    generation.mjs   — the archify:generateProject flow, out of the IPC layer
  config-store.mjs   — chat connection config (endpoint/model), JSON in userData, no secrets
  secret-store.mjs   — API key via safeStorage (OS keyring); never sent to the renderer
  anthropic-client.mjs — minimal non-streaming client: the settings form's connection test
scenarios/            — ALL acceptance code, deliberately OUTSIDE main/ so it never ships next to production
  index.mjs           — SCENARIOS registry + runScenario(name, ctx); requiresCanvas is checked here
  _helpers/           — captureArtifact/settleFrames, drag, fixtures, paths, fixture project root
  canvas/ chat/ archify/ ast/  — one file per scenario, each exporting run(ctx)
tools/
  check-file-sizes.mjs — CI guard: main.mjs ≤150 lines, main/ ≤400, scenarios/ ≤700
preload.cjs           — configBridge: the only config/secret surface exposed to the renderer

Dependencies flow one way: main.mjs → ipc/agent/archify modules, and scenarios/ → main modules.
Nothing imports main.mjs, and no production handler ever inspects the scenario name — an acceptance
run injects what it needs (e.g. archifyValidateFallback) at registration time instead.
run-visual-proof.mjs  — themed screenshot scenarios into artifacts/
run-stress-proof.mjs  — stress automation: 100/500/1500 x bridge/baseline + leak cycles + report
```

## Design rules this codebase enforces (and tests check)

1. Chat never imports `canvas/*` or Excalidraw. Canvas never imports `chat/*`.
   Both only meet at `renderer-entry.jsx` (composition) and through `bridge.mjs` (behavior).
2. A canvas can exist with no project linked — that's the default. Linking is
   one explicit, reversible command (`canvas.linkProject` / `canvas.unlinkProject`).
3. The LLM seam is a labeled stub, not a disguised mock — see `llm-client.mjs`.


## Project-backed canvas (Round 28)

Use the Excalidraw hamburger → **Открыть проект…**. The app loads `<project>/architecture.excalidraw` when present and saves the confirmed Archify projection back to that canonical file using a generation-protected atomic write.


## True Archify regeneration (Round 34)

For an opened real project, **Archify** and preview **Обновить** use the endpoint, model and encrypted API key from built-in Chat settings. Each action starts a fresh evidence-reading Archify skill authoring turn; the deterministic scripted model remains acceptance-only. The resulting IR is previewed before any canvas mutation and saved only after Confirm.
