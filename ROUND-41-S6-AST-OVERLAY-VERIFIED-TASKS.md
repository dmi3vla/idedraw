# Round 41 + S6 AST overlay (reviewed) — integration handoff

This round integrates the reviewer's `phase1-review-round41-s6-ast-overlay-reviewed.tar.gz`
onto the Round 41 + S6 AST anchors + S6 AST UI baseline, and re-verifies the previously
deferred developer-machine dark/light interaction proof **in this sandbox** (Electron runs
here on software GL; the `vaInitialize failed: unknown libva error` line is a benign GPU
warning and does not hang).

## What was integrated (verbatim from the reviewed archive)

The reviewer's archive is the **same file set** as the baseline (125 members) with 11 files
changed. All 11 were copied in. The only tree-only files are `.gitignore` and
`extract-archive.mjs`, both excluded by `make-review-archive.mjs`.

The three correctness fixes (now in the tree):

1. **Per-tab anchor isolation.** `ast-view-state.mjs` no longer keeps one global
   `nodeContext`. Every tab owns its own immutable `context` (the `{ sourceElementId,
   astAnchor, generation, snapshot }` of the component that opened it) plus a `requestId`.
   `ast-view.mjs` reads `tab.context` instead of a global, and async graph/scoped loads
   verify `requestId === tab.requestId` before committing, so a slower earlier scope can
   never overwrite a newer scope. Reopening a tab refreshes only that tab's context.
2. **Explicit context-menu action.** `mount.jsx` no longer opens the dock on right-click.
   It renders an accessible `Развернуть AST` menu item (`role="menu"`/`role="menuitem"`,
   `ast-context-menu`) for anchored Archify components; selecting it dispatches
   `canvas:node-context`. Non-Archify right-clicks fall through to Excalidraw's native menu
   (verified: the capture branch only `preventDefault`s for anchored components).
3. **Preview pagination & byte bound.** `main.mjs` `project:readAstPreview` now reads
   **through the requested bounded window** (`readThrough = start + count - 1`) instead of
   always loading only the first 200 lines, so a preview beginning after line 200 produces
   valid ranges. `ast-anchor-preview.mjs` returns `RANGE_OUT_OF_BOUNDS` for impossible
   starts and `RANGE_UNAVAILABLE` when the window was not loaded; it caps the UTF-8 output
   at 16 KiB (byte-truncated bodies are not resumable line-wise, so `nextStartLine` is
   suppressed) and only reports `nextStartLine` when pagination is safe. The UI appends
   only enough lines to reach the explicit 200-line total cap
   (`PREVIEW_MAX_LINES - result.data.returnedLines`).

The dock was also switched from a narrow 300px split pane to a **full-workspace modal
overlay** (`#ast-root.ast-open` → `position: fixed; inset: 0; z-index: 40`), marked as an
accessible dialog (`role="dialog"`, `aria-modal="true"`, `aria-label`), closes on header X
or Escape, restores focus to the invoking element, and respects reduced-motion.
`src/chat/chat.css` was updated (the `flex: 0 0 300px` split rule is gone).

## Full verification (run on the developer tree, this sandbox)

```text
node --check main.mjs preload.cjs main/project/ast-anchor-preview.mjs  green
npm run build                                                       OK
npm test                                                           259 total / 259 pass / 0 fail / 0 skip
node smoke-test.mjs --source                                       ALL STRUCTURAL CHECKS PASSED
project diagnostics                                                no errors/warnings
npm run verify:ast-anchor                                          AST-ANCHOR PROOF: ALL CHECKS PASSED (dark + light)
npm run verify:ui                                                  UI PROOF: ALL CHECKS PASSED (dark + light)
npm run verify:pixel                                               PIXEL GATE: ALL PASSED (dark + light, 11 nodes pad>=8)
```

Per-theme AST proof fields confirmed green in
`artifacts/archify-ast-anchor-{dark,light}.json` (`ok:true`):
`components=4`, `allHaveAnchor=true`, `webExact=true` (own = `src/web/app.mjs`,
depsL1 = `api`, depsL2 = `[[db,api],[log,api]]`, usersL1 = `[]`),
`expand.ownOk/l1Ok/l2Ok=true` with `ownNoContent=true`, and bounded `ownRels`/`l1Rels`/
`l2Rels`; `preview.ok=true` for in-scope and `previewOutOfScopeRefused=true`;
`fingerprintUnchanged=true` (opening the AST overlay does not mutate the Excalidraw
document); `staleRefused=true` (STALE_PROJECT); `saveOk=true` + `reopenOk=true` +
`reopenAnchorOk=true` (anchor survives serialize→save→reopen).

The `verify:ast-anchor` run regenerates `tests/ast-fixture/architecture.excalidraw`; that
generated artifact was removed before packaging (it must never ship in a review archive).

Status:
```text
S6 AST overlay (reviewed): integrated + live dark/light Electron acceptance GREEN
```

## Next agent tasks (out of scope for this round)

1. **Phase 2A hardening** of the overlay: explicit `stale`/`partial`/`unsupported` states
   driven by `expectedSnapshot`; a visible `Обновить` action on a stale tab; reset tabs on
   unlink/clear in addition to open; persist expanded files/selected symbol/scrollTop per
   tab; resize + pin dock; verify focus restoration after closing the context menu; check
   hit-testing for rotated/scaled elements; tighten the `declarationPreview` privacy
   contract (rename or drop it if no source fragments should ever reach the renderer).
2. **Real AST adapters** (main/worker only): Babel for JS/TS/JSX/TSX with exact symbol
   ranges and stable symbol IDs; a separate PHP adapter; AST-grep later. Keep the fallback
   graph parser until then.
3. **Project round-trip**: open → generate → save → restart → reopen → exact snapshot
   comparison; autosave queue/recovery; binary-file isolation (verify `resetScene` clears
   the Excalidraw binary store).
4. **Deferred deps** (needs network): install `reactflow`/`dagre` to replace the fallback
   graph view inside the overlay only — Excalidraw remains the sole main-scene owner.

Recommended developer-machine re-proof before release: `npm ci && npm run build && npm test`,
then open the overlay on real projects in dark/light at normal and narrow windows, exercise
multi-tab scope/preview, and confirm closing restores the unchanged Excalidraw fingerprint
and viewport.
