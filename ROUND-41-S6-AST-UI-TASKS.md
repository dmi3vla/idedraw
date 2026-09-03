# Round 41 + S6 AST UI — integration handoff

This round connects the **already-verified S6 AST anchors** (Round 41 rollback) to a
**new docked AST UI** and adds the **live acceptance scenario + bounded source
preview endpoint**, **without** reintroducing the old Round 42/43 `node-inspector`,
**without** re-scanning the project, and **without** replacing Excalidraw as the main
scene.

## What was implemented (source-verified)

### 1. Fixture `tests/ast-fixture/` (four-tier, exclusive)
A dedicated fixture `web -> api -> db` + `api -> log` used ONLY by the AST-anchor
proof. The canonical `tests/fixture-project` (used by `archify-agent`) is left
untouched so its independent `web/api/db` + 2-edge expectation never drifts.

- `src/web/app.mjs` (imports api)
- `src/api/server.mjs` (imports db + log)
- `src/db/index.mjs`
- `src/log/index.mjs`

### 2. `main/project/ast-anchor-preview.mjs` — pure bounded preview
`buildAnchoredReadPreview({ anchor, scope, rel, file, startLine, endLine, maxLines })`
returns a scope-gated 90/200-line window of an already-read file. It never reads
disk, never returns a root, refuses a `rel` outside the anchor scope (`OUT_OF_SCOPE`),
and caps the window. `PREVIEW_LIMITS = { defaultLines:90, maxLines:200, byteCap:16kB }`.

### 3. `project:readAstPreview` IPC + preload
`projectBridge.readAstPreview(input)`:
- main-owned root, generation gate, `BAD_ANCHOR` component match, scope defaulted to
  `own`, `refs.includes(rel)` gate, snapshot before/after (`PROJECT_CHANGED`), bounded
  read via the confined `readProjectFile`, then `buildAnchoredReadPreview`.
- preload.cjs exposes `readAstPreview`. No root/path is ever passed by the renderer.

### 4. AST dock UI (`src/ast-view/`) — dependency-free vanilla DOM
- `ast-view-state.mjs` — pure tab/scope state (dedupe on reopen, clamp to 8 tabs,
  per-tab scope, `clearTabs` on project boundary).
- `ast-view.mjs` — mounts the dock; listens for `canvas:node-context`, renders
  component tabs, scope buttons `Узел / Связи L1 / Связи L2`, file cards + symbols,
  dependency edges, and a `readAstPreview` code pane with «Загрузить больше».
- `ast-view.css` — themed via CSS custom properties (no self-applied vars).
- React Flow + dagre are **deferred** (no network here to install them); the vanilla
  fallback is intentional and documented.

### 5. Canvas right-click wiring
- `adapter.mjs`: `isArchifyComponent`, `hitTestArchifyComponentAt(clientX, clientY)`
  using the package's own `viewportCoordsToSceneCoords` (correct under pan/zoom/offset);
  returns `{ id, sourceElementId, astAnchor, projectSnapshot }`, never source/root.
- `mount.jsx`: `onContextMenuCapture` — right-click on an Archify component with an
  `astAnchor` dispatches `canvas:node-context` and `preventDefault`/`stopPropagation`;
  any other right-click falls through to Excalidraw's native menu.
- `renderer-entry.jsx`: mounts the dock into `#ast-root` (hidden by default; `.ast-open`
  shows it), resets tabs on project open/link/unlink, exposes `__serialize__` /
  `__loadDocument__` for acceptance.
- `index.html`: adds `#ast-root` and the `ast-view.css` link.

### 6. Live acceptance `npm run verify:ast-anchor`
- `main/ast-anchor-scenario.mjs` + `--scenario=archify-ast-anchor` dispatch in main.mjs.
- `run-ast-anchor-proof.mjs` (dark + light).
- Proves: preview no-mutate → confirm 4 components → every rect has `astAnchor` →
  `web` exact own/depsL1/depsL2(+via)/dependents → no full-manifest leak →
  `expandAstAnchor` for own/l1/l2 (bounded, no content) → `readAstPreview` in-scope
  + out-of-scope refusal → unchanged canvas fingerprint → stale generation refused →
  serialize→save→reopen→anchor survives.

## Checks run in this sandbox
```
node --check main.mjs preload.cjs main/ast-anchor-scenario.mjs src/ast-view/*.mjs : OK
npm run build                                                        : OK
npm test                                                             : 255 pass / 0 fail
node smoke-test.mjs --source / full                                   : ALL STRUCTURAL CHECKS PASSED
project diagnostics                                                   : no errors/warnings
```

## Live proof run here (green)
The Electron scenarios **did run in this sandbox** (the `vaInitialize failed: unknown
libva error` is a benign GPU warning — the renderer proceeds on software GL and does
not hang, matching the existing scenarios). All live gates are green:

```
npm run verify:ast-anchor   -> AST-ANCHOR PROOF: ALL CHECKS PASSED (dark + light)
npm run verify:ui           -> UI PROOF: ALL CHECKS PASSED (dark + light)
npm run verify:pixel        -> PIXEL GATE: ALL PASSED (dark + light, 11 nodes pad>=8)
```

Artifacts written:
- `artifacts/archify-ast-anchor-{dark,light}.png`
- `artifacts/archify-ast-anchor-{dark,light}.json` -> `ok:true`

Verified per theme: `components=4`, `webExact=true`, `expand.ownOk/l1Ok/l2Ok=true`,
`preview.ok=true` + out-of-scope refusal, `fingerprintUnchanged=true`,
`staleRefused=true`, `reopenAnchorOk=true` (anchor survives serialize→save→reopen).

Status:
```
S6 AST UI: source-complete + live dark/light Electron acceptance GREEN
```

## Follow-up (next rounds, out of scope here)
- Phase 2A hardening: explicit `stale`/`partial`/`unsupported` states, `expectedSnapshot`
  refresh button, save expanded files/selected symbol/scrollTop per tab, resize/pin dock,
  focus restoration, rotated/scaled hit-testing.
- `declarationPreview` privacy contract refinement.
- Babel/PHP AST adapters and true AST-grep multi-language parsing (main/worker only).
- «Вынести на холст» (deterministic projection into Excalidraw) — later phase.

## Independent review corrections

The received archive was independently reviewed after the live proof. Three correctness gaps were found and fixed:

1. **Per-tab anchor isolation.** The initial dock kept one global `nodeContext`. After opening `web`, then `api`, switching back to `web` could send the `api` anchor with `projectNodeId: web` and fail with `BAD_ANCHOR`. Every tab now owns its own immutable expansion context; reopening refreshes only that tab. Async graph loads also use a per-tab request id so a slower previous scope cannot overwrite a newer scope.
2. **Actual context-menu action.** Right-click initially opened the dock immediately. It now shows an explicit accessible `Развернуть AST` menu item for anchored Archify components. Non-Archify right-clicks still fall through to Excalidraw.
3. **Preview pagination and byte bound.** The initial IPC always loaded only the first 200 lines, so a request beginning after line 200 produced an invalid/negative range and repeated `Загрузить больше` requests could not advance. Main now reads through the requested bounded window; impossible ranges are rejected; UTF-8 output is capped at 16 KiB; the UI appends only enough lines to reach the explicit 200-line total cap.

Added regression tests for per-tab context isolation, post-line-200 windows, impossible starts and the declared UTF-8 byte cap.

Independent sandbox result after corrections:

```text
npm test                       259 total / 253 pass / 0 fail / 6 optional CLI skips
node smoke-test.mjs --source   ALL STRUCTURAL CHECKS PASSED
archive scan                   no forbidden members / no secret-pattern hits
```

`npm run build` and Electron live proof could not be repeated in the independent review sandbox because the review archive intentionally excludes `node_modules` and `@excalidraw/excalidraw` was unavailable. The original dark/light live artifacts remain evidence for the received source, but the corrected context-menu/multi-tab interactions must be re-run on the developer machine before release.

### Required developer-machine re-proof

- `npm ci && npm run build && npm test`.
- Right-click an anchored component and explicitly select `Развернуть AST`.
- Open at least two component tabs, switch back, change each scope and preview a file; assert no `BAD_ANCHOR` and no cross-tab source/graph mix-up.
- Rapidly switch `own -> l1 -> l2`; assert the final graph is always L2.
- Preview a synthetic file beyond line 200; assert valid ranges and no negative `returnedLines`.
- Confirm the first preview is 90 lines and one explicit load extends it to at most 200 total lines.
- Re-run `verify:ast-anchor`, UI and pixel proofs in dark/light, then replace proof artifacts.

## Full-workspace overlay revision

Per product direction, the 300px dock has been replaced by a full-workspace modal overlay:

- right-click an anchored Archify component;
- choose the explicit `Развернуть AST` action;
- `#ast-root` opens as a fixed `inset: 0` workspace above the still-mounted Excalidraw scene;
- component tabs and `own / L1 / L2` scopes remain inside the overlay;
- close with the header X or Escape;
- focus returns to the invoking UI element;
- window controls remain above the overlay;
- Excalidraw stays mounted underneath and remains the only owner of the primary scene/viewport.

The overlay is marked as an accessible modal dialog and respects reduced-motion preferences. File cards use the expanded workspace with a responsive grid. The supplied architecture HTML/JSON were treated as a full-workspace visual reference, not as executable source.

Developer-machine proof must include screenshots of the overlay in dark/light modes at normal and narrow window sizes and must confirm that closing restores the unchanged Excalidraw fingerprint and viewport.
