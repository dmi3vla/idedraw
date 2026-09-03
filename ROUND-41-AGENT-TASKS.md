# Round 41 — Round 40 integration + content-fingerprint autosave

## Integration of reviewer Round 40

- Input archive SHA-256 confirmed: `da24e35101a7fa695943bb55d43bb7e4bd1b2f44c7ba13825f04d185aced2d35`, 107 members.
- Extracted to `/tmp/r40x/review-package/`; **107/107 members present** (only `extra` = `.gitignore` + `extract-archive.mjs` are builder auto-inclusions, kept intentionally).
- Applied all new/modified files from the archive:
  - NEW: `main/project/project-autosave.mjs`, `tests/project-autosave.test.mjs`, `tests/project-autosave-wiring.test.mjs`.
  - MODIFIED: `main/project/project-canvas-file.mjs`, `main.mjs`, `preload.cjs`, `src/canvas/mount.jsx`, `src/renderer-entry.jsx`, `tests/project-canvas-file.test.mjs`, `BRIEF-REPORT.md`.
- Round 39 versions backed up to `/tmp/pre40-backup/`.

### Reviewer feature set (confirmed present)
- Main-owned autosave queue: debounce + latest-wins, serialized per-key saves, bounded retry, `flush()` drains edits during in-flight write, `discard()` cancels pending state, generation validation stays authoritative.
- Renderer/preload/main wiring: narrow `canvas:change` event, 500 ms debounce, suppress load/reset changes, `queueAutosave`/`flushAutosave` without any root/path.
- `.tmp` crash recovery: valid temp promoted only when canonical absent, invalid orphan removed, canonical-wins when both exist, strict regular-file/non-symlink/50 MB/JSON/Excalidraw-shape checks.

## This round: content-fingerprint autosave

### Verified fact
Excalidraw `onChange` fires for viewport-only changes (scroll/zoom) and selection-only changes, not just element mutation. Because `serializeExcalidrawDocument()` keeps only a content appState whitelist (`viewBackgroundColor`, `gridSize`), pan/zoom/selection-only changes produce an identical serialized document. Without a guard they would enqueue redundant disk writes.

### Change made
- `src/renderer-entry.jsx`:
  - Added `lastAutosaveFingerprint` state.
  - Added a deterministic FNV-1a hash `autosaveFingerprint(document)` over the serialized JSON.
  - In the `canvas:change` debounce callback, the serialized document is hashed; if the hash equals the previous one, the write is skipped. Otherwise the fingerprint is stored and `queueAutosave` is invoked.
  - The fingerprint resets to `null` when a project is opened (`activateOpenedProject`) and after `flushAutosave` on `project:open-request`, so a new project's first real change always triggers a save.
- Worst case for a hash collision is only dropping a redundant write (never data loss). `serializeExcalidrawDocument()` is unchanged.

## Live validation (this machine, dependencies + Archify CLI installed)

```
npm run build          → BUILD_EXIT=0 (src/dist/renderer.bundle.js)
npm test               → 232 total / 232 pass / 0 fail / 0 skip
node smoke-test.mjs    → ALL STRUCTURAL CHECKS PASSED
npm run verify:saved-chat → ALL CHECKS PASSED (real model, safeStorage key; ARCHIFY_API_KEY unset)
npm run verify:ui      → ALL CHECKS PASSED (dark + light)
npm run verify:visual  → PIXEL GATE ALL PASSED (dark + light; 11 nodes, pads >= 8, overlap 0, minRowGap >= 32)
```

Notes:
- One transient `HTTP_429` was hit on `verify:saved-chat` and resolved on retry (rate limit, not a code defect).
- GPU/vaapi warnings under `xvfb-run` are non-fatal noise.

## Remaining open tasks

1. Add a live autosave acceptance scenario:
   - open project A;
   - rapid edits → verify latest-only persistence;
   - switch to project B before debounce → prove no cross-project write;
   - close immediately after an edit → prove flush;
   - seed valid/invalid `.tmp` files → verify recovery/cleanup after restart.
2. Add user-visible autosave failure/retry status if a live failure can remain silent.
3. Verify whether `resetScene()` in Excalidraw 0.18.1 actually clears the binary-file store; add a live A→B→empty isolation proof.
4. Move to the official `serializeAsJSON`/restore API and prove an exact elements/files/bindings/frame round-trip.
5. Full project-open → generate → confirm → save → restart → reopen with exact snapshot comparison.
6. Mobile/focus/double-click refresh UI proof.
7. Live delayed-request cancellation proof (old preview token rejected, no pre-confirm mutation, no save).

## Security invariants (unchanged)

- Renderer never supplies a filesystem root/path for autosave.
- Main-owned generation validation prevents stale cross-project saves.
- Recovery never follows a symlink or promotes invalid/oversized JSON.
- No API keys, prompts, source contents, evidence maps, candidates or run tokens persist from this work.
