# Brief report — Round 36

## Review of Round 35

Archive metadata matched: 171 files, 3,707,238 bytes, SHA-256 `81f5ea3c6f58b7e5b98c83dc6791d712c4fb540deb3b2a6fe2d4eb6525599221`. Source tests and structural smoke were green. S7 pixel/UI artifacts remained green.

The claimed live model run was useful but did **not** satisfy the product requirement that generation use the API key stored by built-in Chat settings: it used `process.env.ARCHIFY_API_KEY`, and no safe machine-readable live-model artifact was included. That acceptance was reopened.

## Corrections

- Hardened OpenAI tool-name mapping: strict, bounded, collision-free indexed wire names; one reversible map is used for tool declarations, historical assistant tool calls, and incoming deltas.
- Multi-tool results are emitted as one OpenAI tool message per call; object content is JSON encoded.
- Added pure OpenAI protocol regressions.
- Added `npm run verify:saved-chat`: a manual Electron production gate using the normal app userData profile and only the encrypted key saved by Chat settings. The runner explicitly removes `ARCHIFY_API_KEY` from child environment, generates through the production handler, confirms preview, and checks saved `architecture.excalidraw`.
- Added a safe artifact contract with key source, configured-model use, author completion, project-read count, pre-confirm non-mutation, and save counts. No key, prompt, source, runToken, evidence map, candidate or path is written.
- Removed dead `archify:validateProject` and `project:canvasStatus` IPC/preload APIs.
- Removed historical handoff files and stale generated visual/stress artifacts from the review package.

## Local verification

```text
node --check: green
source tests: 218 total / 212 pass / 0 fail / 6 CLI skip
structural smoke: green
```

The saved-Chat live proof cannot be honestly executed in this sandbox because it does not contain the user's OS-encrypted app key. It must be run on the real machine with existing Chat settings via `npm run verify:saved-chat`, without exporting an environment key.

## Next handoff

See `ROUND-36-AGENT-TASKS.md`.

---

# Round 37 review addendum

Implemented cancellation/progress and actionable generation errors. Main now reports safe stages (`snapshot → evidence → author → repair → preview`), propagates structured abort/network/budget failures, and keeps cancellation main-owned. Renderer provides a guarded Cancel button plus Escape handling and maps known failure codes to actionable Russian copy. Added 4 regressions in `tests/generation-ux.test.mjs`.

Clean-room verification: `node --check` green; `npm test` = 222 total / 216 pass / 0 fail / 6 CLI skip. Build/UI proof requires the developer machine's installed dependencies; network package fetch is unavailable in this review sandbox. See `ROUND-38-AGENT-TASKS.md`.

---

# Round 39 review addendum

Confirmed the Round 39 archive checksum/member count and both live-regression fixes. Implemented a main-owned debounced autosave queue with latest-wins semantics, serialized saves, bounded retry, lifecycle flush, and stale-generation protection. Added safe interrupted `.tmp` recovery. Added 7 new autosave tests and 3 recovery tests; clean-room suite is 232 total / 226 pass / 0 fail / 6 CLI skip. Source structural smoke is green. See `ROUND-40-AGENT-TASKS.md` for required live gates and remaining work.


## Round 41 rollback branch — S6 AST anchors

Started from the supplied, hash-confirmed Round 41 package and implemented the S6 AST-anchor side channel discussed with the user. The existing evidence aggregation now precomputes bounded own/dependency/dependent L1/L2 file layers from `tierFiles` and resolved component connections. The manifest stays outside strict Archify JSON, is sanitized in the projection plan, participates in the content-complete source hash and is persisted as only the matching component-local `customData.archify.astAnchor` slice.

Adapted the supplied Code Canvas frame at the backend seam: a new main-owned `project:expandAstAnchor` endpoint expands `own | l1 | l2` without accepting a root or recursively scanning the project, reads only through the existing confined filesystem boundary, checks generation and before/after snapshots, and returns a compact graph without source content. React Flow and the standalone frame's project-opening/root-scan path were not imported; Excalidraw remains the sole main scene owner.

Verification: **238 total / 232 pass / 0 fail / 6 optional CLI skips**; source structural smoke green. Developer-machine build/live persistence/UI attachment remain in `ROUND-41-S6-AST-ANCHOR-TASKS.md`.

---

## Round 41 rollback branch — S6 AST UI (docked inspector)

Built on top of the verified S6 AST anchors: added a **dependency-free vanilla-DOM AST dock** (`src/ast-view/`), a **right-click capture** on Archify components, a **bounded rootless source preview** endpoint (`project:readAstPreview`), a **four-tier `tests/ast-fixture/`**, and a **live acceptance harness** (`npm run verify:ast-anchor`).

Key invariants preserved: Excalidraw stays the sole main-scene owner; the dock never re-scans the project and never receives a root or full source (only a scope-gated 90/200-line slice); reopen dedupes tabs; a project boundary clears all tabs. React Flow + dagre are intentionally deferred (no network in this sandbox to install them); the vanilla fallback is deliberate and documented.

Source-level verification in sandbox: `node --check` green; `npm run build` OK; `npm test` = **255 total / 255 pass / 0 fail / 0 skip**; structural smoke green; project diagnostics clean. **Live Electron acceptance ran and is GREEN** (the `vaInitialize failed: unknown libva error` is a benign GPU warning; the renderer proceeds on software GL and does not hang): `npm run verify:ast-anchor` = ALL CHECKS PASSED (dark + light, PNG + `ok:true` JSON), `verify:ui` = ALL CHECKS PASSED, `verify:pixel` = ALL PASSED (11 nodes pad>=8). Per theme the AST proof confirms 4 components, exact `web` own/depsL1/depsL2(+via)/dependents, bounded own/l1/l2 expansion with no content, in-scope preview + out-of-scope refusal, unchanged canvas fingerprint, stale-generation refusal and anchor persistence across serialize→save→reopen. See `ROUND-41-S6-AST-UI-TASKS.md`.

### Independent S6 AST UI review fixes

Reviewed the supplied S6 AST UI archive and fixed a blocking multi-tab context defect: each tab now retains its own component anchor instead of using the last-opened component globally. Added stale async graph-response suppression. Replaced direct right-click opening with the requested explicit `Развернуть AST` context-menu action. Repaired source-preview pagination after line 200, impossible-range handling, the declared 16 KiB UTF-8 cap, and the one-click 200-line UI expansion limit. Regression suite: 259 total / 253 pass / 0 fail / 6 optional CLI skips; source smoke green. Developer-machine build and dark/light interaction proof must be rerun because this clean review environment lacks the excluded Excalidraw dependency.

### Full-workspace AST overlay

Changed the S6 AST presentation from a narrow 300px dock to the requested full-workspace modal overlay. The explicit `Развернуть AST` context-menu action opens a fixed workspace over the still-mounted Excalidraw scene; tabs/scopes remain available, X/Escape close it, and focus is restored. Added structural regression checks for fixed full-area positioning, modal semantics and removal of the old split-pane width.

### Overlay-reviewed archive integrated + re-verified (Round 41 + S6 AST overlay)

The supplied `phase1-review-round41-s6-ast-overlay-reviewed.tar.gz` was integrated verbatim (11 files: the AST view/state/css, `main.mjs`, `ast-anchor-preview.mjs`, `mount.jsx`, `chat.css`, the two AST test files, and the docs). The review's three correctness fixes are now in the tree:

1. **Per-tab anchor isolation** — each tab owns its own expansion `context` and `requestId` (global `nodeContext` removed; stale async graph responses suppressed).
2. **Explicit context-menu action** — right-click on an anchored Archify component shows an accessible `Развернуть AST` menu item; non-Archify right-clicks still fall through to Excalidraw.
3. **Preview pagination & byte bound** — main reads through the requested bounded window; impossible ranges return `RANGE_OUT_OF_BOUNDS`/`RANGE_UNAVAILABLE`; UTF-8 output is capped at 16 KiB; the UI appends only enough lines to reach the explicit 200-line total cap.

Full re-verification on the developer tree (this sandbox runs Electron on software GL; the `vaInitialize failed` line is a benign GPU warning):

```text
node --check                       green (main.mjs, preload.cjs, ast-anchor-preview.mjs)
npm run build                      OK
npm test                           259 total / 259 pass / 0 fail / 0 skip
node smoke-test.mjs --source       ALL STRUCTURAL CHECKS PASSED
project diagnostics                no errors/warnings
npm run verify:ast-anchor          ALL CHECKS PASSED (dark + light, PNG + ok:true JSON)
npm run verify:ui                  ALL CHECKS PASSED (dark + light)
npm run verify:pixel               ALL PASSED (dark + light, 11 nodes pad>=8)
```

Per-theme AST proof fields confirmed green: `allHaveAnchor`, `webExact` (own/depsL1/depsL2+via/dependents), `expand.own/l1/l2` with no content, in-scope preview + out-of-scope refusal, `fingerprintUnchanged`, `staleRefused`, `reopenAnchorOk`, `preview.ok`. The previously-deferred developer-machine dark/light interaction proof is now complete here (see new `ROUND-41-S6-AST-OVERLAY-VERIFIED-TASKS.md`).


---

## Round 42 — Phase 2A AST workspace hardening

Implemented explicit stale/partial/unsupported tab states with a visible stale refresh driven only by the main-owned current snapshot. Tabs now retain expanded files, selected symbol, preview, and scroll position independently. The workspace can be pinned and resized (pointer or keyboard) while preserving full-workspace modal mode.

Lifecycle and accessibility hardening now resets AST tabs on open/link/unlink and empty-canvas boundaries, restores focus when the context menu is dismissed and after the AST workspace closes, and uses inverse-rotation hit-testing after viewport-to-scene conversion. The fallback graph privacy contract is metadata-only (`id/kind/name/line`): unsupported extensions are explicitly labeled and no declaration/source fragment is returned.

Verification in the extracted clean tree: `node --check` green; `npm test` = **265 total / 259 pass / 0 fail / 6 optional CLI skips**; source structural smoke green. Build/live visual gates are not claimed here because registry access is disabled and `npm ci` could not restore the archive-excluded Excalidraw dependency. See `ROUND-42-PHASE-2A-HARDENING-TASKS.md` for the exact developer-machine re-proof commands.


---

## Round 43 — AST adapters and exact project round-trip

Completed the remaining functional backend work without adding runtime dependencies. Added main-owned JS/TS/JSX/TSX and PHP adapters with stable symbol IDs and exact declaration offsets/ranges. The anchored graph remains rootless and bounded to component-local refs; renderer output contains metadata only and explicitly labels unsupported languages.

Added canonical document SHA-256 snapshots to save/open results and an exact open → generate/document → save → close/restart → reopen regression, covering AST-anchor and binary-file-map persistence. Verification: **269 total / 263 pass / 0 fail / 6 optional CLI skips**, source smoke green. Remaining work is interaction polish and developer-machine Electron dark/light re-proof; see `ROUND-43-AST-ADAPTERS-ROUNDTRIP-COMPLETE.md`.


---

## Round 44 — adapter hardening + narrow-dock polish

Hardened the AST adapters (Round 43 task 4) against the four listed gaps without adding runtime dependencies:

- **PHP 8 attributes** — `#[...]` is now masked as a bracket block, not treated as a line comment. A `#` that opens an attribute no longer swallows the rest of the line, so a declaration on the same line as its attribute is still found (`#[Route('/x')] public function show() {}`).
- **Anonymous / default exports** — `export default function() {}`, `export default class {}`, `export default class extends Base {}`, and `export default (x) => x` are recorded under a stable synthetic `default` name and still satisfy the exact-range contract.
- **Named class guard** — a negative lookahead prevents `class extends Base` from being misread as a class literally named `extends`.
- **Decorators** — TS/JS decorators (`@Component`, `@Injectable`) provably don't consume the decorated declaration.
- **Malformed partial files** — truncated/empty/garbage inputs never throw across `.js/.tsx/.php`.

Also tuned the AST dock (Round 43 task 2): file cards now reflow at a 220px minimum and, in a narrow (`@container (max-width: 460px)`) dock, collapse to one column and wrap their headers so the pinned width, narrow-window spacing and graph density behave.

Verification (clean review sandbox, Electron on software GL; the `vaInitialize failed` line is the known benign GPU warning):

```text
node --check                     green
npm test                         275 total / 275 pass / 0 fail / 0 skip
npm run build                    OK
node smoke-test.mjs --source     ALL STRUCTURAL CHECKS PASSED
project diagnostics              no errors/warnings
npm run verify:ast-anchor        ALL CHECKS PASSED (dark + light, PNG + ok:true JSON)
npm run verify:ui                ALL CHECKS PASSED (dark + light)
npm run verify:pixel             ALL PASSED (dark + light, 11 nodes pad>=8)
```

Deferred to a machine with network + installed dependencies (Round 43 task 1 / task 3): the optional React Flow/dagre graph-list replacement and any pixel-perfect dark/light re-proof on the developer tree. See `ROUND-44-ADAPTER-HARDENING-POLISH.md`.


---

## Round 45 — detailed formation diagnostics

Added a detailed, searchable console trace for the whole canvas-formation pipeline so a user hitting `Не удалось построить архитектуру` can see the exact stage, config facts (never the key), tool flow and failure reason.

- `[ARCHIFY-GEN]` (main, terminal): generation start, config (endpoint/model/key-set/skill), project snapshot fingerprint, each `tool_use` (name + bounded input), author/repair attempts, turn result, `walkToolCalls` dump on `generation failed`, every guard rejection (NOT_LINKED/STALE_PROJECT/NO_API_KEY/NO_MODEL/SNAPSHOT_FAILED/PROJECT_CHANGED/CANCELLED).
- `[CHAT-STREAM]` (terminal): `openai`/`anthropic` POST (endpoint/model/key-set/bytes/tools/messages), response status, `HTTP_FAIL` with status + error body, `NETWORK_FAIL`, and `DONE` with stopReason + toolUses.
- `[ARCHIFY-UI]` (DevTools, F12): stage labels, generation/preview ok, and the final failure code+message.
- Network classification: a plain `fetch` failure is now `NETWORK` (not a blanket `GENERATION_FAILED`), so the renderer shows `Ошибка сети или API…` instead of the generic message; `HTTP_xxx` errors still propagate with their status.

Live confirmation in the review sandbox (real stored key, real endpoint): the generation actually reached the API and the trace surfaced an `openai HTTP_FAIL 429` → `runChatTurn ошибка code=HTTP_429` → `turn вернул ошибку`, i.e. the exact cause that was previously hidden behind the generic banner.

Files: `main.mjs` (handler + `runChatTurn` + helper), `main/chat-stream.mjs` (both clients), `src/renderer-entry.jsx` (UI trace), `tests/generation-ux.test.mjs` (two assertions updated to the refactored error classification). Verification: **275 total / 275 pass / 0 fail / 0 skip**, build OK, source smoke green, diagnostics clean.


---

## Handoff

Round 45 is complete and verified in this clean review sandbox. The saved-Chat live proof (`npm run verify:saved-chat`) is green: it used the real stored safeStorage key and configured model, completed the author turn, and confirmed the preview without mutating the canvas before Confirm. See `ROUND-44-ADAPTER-HARDENING-POLISH.md` for the deferred developer-machine items (React Flow/dagre replacement and the pixel-perfect dark/light re-proof).

---

## Author-failure recovery hardening (live-fix)

A live generation hit `guard GENERATION_FAILED — lastAuthorResult пуст`: `archify.author` returned `ok:false` once and the model gave up with an empty `end_turn` instead of repairing. Three targeted fixes, no contract changes:

- **Retry hint in the failure JSON** (`main/agent-tool-executor.mjs`): a failed `archify.author` now carries `retry: { action: 'repair' | 'new_run', hint }` inside the same JSON (parseArchifyResult and the scripted repair loop keep working). `new_run` fires on `REPAIR_BUDGET_EXHAUSTED`.
- **Generation prompt** (`main.mjs`): the turn instruction now explicitly forbids ending the turn on `ok:false` and spells out repair-with-runToken / new-run-without-token.
- **Diagnostics fix**: `onToolUse` passed `{ rounds }` but the trace read `meta.round` — every `[ARCHIFY-GEN] tool_use` line showed `round=undefined`. Fixed.

Live re-proof on the real stored key + configured model: first author attempt failed `VALIDATION_FAILED (repository-evidence/repository-required)`, the model repaired, `SAVED CHAT PROOF: ALL CHECKS PASSED` (8 elements saved). The `[AUTHOR]` trace now always shows the exact validation reason. Tests: **276 total / 276 pass / 0 fail / 0 skip**; build OK; source smoke green.
