# Round 42 — Phase 2A AST workspace hardening

## Implemented

1. Explicit per-tab states: `idle`, `loading`, `ready`, `stale`, `partial`, `unsupported`, `error`.
2. `stale` is driven by the main-owned snapshot returned by `expandAstAnchor`; the visible `Обновить` action adopts only that returned fingerprint and reloads the tab.
3. Per-tab UI memory: expanded files, selected symbol, preview and `scrollTop` survive tab switches.
4. Optional pinned dock with pointer and keyboard resizing (360–960 px); unpinned mode remains the full-workspace modal.
5. AST tabs reset on open/link/unlink boundaries and when the canvas becomes empty.
6. Context-menu dismissal restores focus; choosing `Развернуть AST` carries the original focus target into the workspace so closing the workspace restores it.
7. Hit-testing inverse-rotates the scene point around the node center; viewport conversion continues to cover pan/zoom/scale.
8. Privacy contract tightened: the fallback graph emits symbol metadata only (`id/kind/name/line`), never declaration/source fragments. Unsupported file extensions are explicit and content-free.

## Verification in this clean sandbox

```text
node --check main.mjs preload.cjs main/project/ast-anchor-graph.mjs
node --check src/ast-view/ast-view-state.mjs src/ast-view/ast-view.mjs
npm test                              265 total / 259 pass / 0 fail / 6 optional CLI skips
node smoke-test.mjs --source          ALL STRUCTURAL CHECKS PASSED
```

`npm ci` could not complete because registry access is disabled (`ENOTFOUND`), leaving the excluded `@excalidraw/excalidraw` package unavailable. Therefore build and Electron visual/live gates are deliberately not claimed for this Round 42 candidate. Re-run on the developer machine:

```text
npm ci
npm run build
npm test
npm run verify:ast-anchor
npm run verify:ui
npm run verify:pixel
```

## Next tasks

- Review the Phase 2A interaction details and rerun dark/light visual gates at normal and narrow widths, including pinned resizing.
- Implement real main/worker AST adapters: Babel for JS/TS/JSX/TSX, then a separate PHP adapter; retain the bounded fallback.
- Add the full project restart round-trip and autosave recovery proof.
