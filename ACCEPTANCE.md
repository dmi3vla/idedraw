# Acceptance — canvas + chat, independent, project-aware, themed

## What this proves (verified, not asserted)

Run these two commands yourself:

```
npm install
npm run build
npm run test:protocol   # structural checks — imports, no cross-coupling, real Excalidraw in bundle
npm run verify:visual   # real headless Electron, real capturePage() screenshots into artifacts/
python3 verify-pixels.py artifacts/electron-full-dark-draw-and-ask.png   # objective color check
```

## Real, not mocked

- `@excalidraw/excalidraw` is a genuine runtime dependency (see `package.json`), bundled via esbuild
  (`src/dist/renderer.bundle.js`, 13.8MB — real library code, not a hand-drawn SVG mockup).
- `src/canvas/adapter.mjs` calls the real `excalidrawAPI.updateScene()` / `getSceneElements()`, with
  full Excalidraw element shape (stroke/fill/roughness/seed/etc.), not a stripped-down placeholder.
- `src/chat/chat-panel.mjs` is plain DOM (no React), reaches canvas/project **only** through
  `src/bridge/bridge.mjs` — verified by `smoke-test.mjs` grepping actual import statements, not by
  claiming it in prose.
- `src/chat/llm-client.mjs` is an **explicitly labeled stub** — a tiny pattern-matcher that calls the
  real `bridge.use_command`/`bridge.query`, not a real Anthropic streaming client. This is the one
  piece that is intentionally not real, and it says so in its own file header. Swapping it for a real
  Messages API client (tools array from `bridge.list_commands()`, SSE parsing, `tool_result` round
  trip) is the next real piece of work, not something this prototype claims to have done.

## Independence, checked mechanically

- `smoke-test.mjs` greps `chat-panel.mjs` / `llm-client.mjs` for imports of `canvas/` or Excalidraw —
  fails the run if found.
- `run-visual-proof.mjs` captures a `chat-only` screenshot (canvas never mounted) and a `canvas-only`
  screenshot (chat never mounted) — both are real Electron windows, not a single mode pretending to
  be two.

## Project layer, checked mechanically

- `src/project/project-store.mjs` never imports `canvas/`.
- Canvas defaults to **unlinked** ("Холст не связан с проектом (набросок)") — a canvas is a freeform
  sketch until `canvas.linkProject` is explicitly called. Screenshots show this default state.
- `query({what:'project.graph'})` works whether or not a canvas is even mounted (see chat-only
  screenshot: the badge and context bar both come from live bridge calls, not from canvas state).

## Themes

- `verify-pixels.py` reads actual PNG pixel values (not a visual glance) and asserts dark-theme
  backgrounds are near-black and light-theme backgrounds are near-white, for both the canvas region
  and the chat region, on every captured screenshot.
- **Dark is the default.** Three places have to agree and each has silently disagreed at least once,
  so `smoke-test.mjs` now asserts all three: `theme.mjs` store default (`let current = 'dark'`),
  `main.mjs` `--theme` default, and `chat.css` (`color-scheme: dark light` + dark `var()` fallbacks,
  so the pre-hydration frame doesn't flash light). It also asserts `main.mjs` applies the theme via
  the idempotent `__setTheme__` and **never** via `__toggleTheme__` — a toggle depends on whatever
  the renderer's current default happens to be, and did double-flip `--theme=dark` back to light when
  that default changed.

## Toolbar vs Excalidraw's hamburger — measured, not eyeballed

Our fixed toolbar strip occupies `y=8..32`; Excalidraw's left menu column (the hamburger, ☰) sits at
`y=16` by default, i.e. underneath it once the native title bar is gone. `chat.css` pushes **only**
the left column down (`.App-menu_top > .App-menu_top__left { margin-top: 72px }`) so the centered
shape tools are not moved.

The number went 28px → 46px → 72px, and the two revisions are the point: *geometric* non-overlap was
not the same as *looking* separate. At 28px the hamburger landed at `y=44` — not overlapping, but 12px
below the toolbar and still above the bottom edge of Excalidraw's own centered tool island (`y=60`).
At 46px it landed at `y=62` with `overlap: false` and a 30px gap — and the user still reported the
Theme button sitting on the hamburger, which was correct as a visual judgement even though every
mechanical check passed. Measured DOM geometry at 72px, via a real window with the real preload:

| element | rect |
| --- | --- |
| our toolbar | `y=8 h=24` (bottom 32) |
|  Theme button | `x=8 y=8 w=59 h=24` |
|  Link project button | `x=73 y=8 w=83 h=24` |
| Excalidraw centered tool island | `y=16 h=44` (bottom 60) |
| hamburger / left menu column | `y=88 h=36` (bottom 124) |
| overlap | `false`, gap toolbar→hamburger `56px`, gap island→hamburger `28px` |

Same geometry in `mode=full` and `mode=canvas-only`. Below roughly 900px wide Excalidraw switches to
its mobile layout, `.App-menu_top__left` stops existing entirely and the hamburger moves to the
*bottom* of the window (measured: `y=546` in a 900×600 window) — so the rule is inert there, which is
the desired outcome rather than a gap in it.

Confirmed in pixels on `artifacts/electron-full-dark-draw-and-ask.png`: in the hamburger's x-band
(`x=16..52`) the gap rows `y=33..87` hold **8/2035 non-background pixels** — and all 8 are on row
`y=87`, one pixel above the hamburger island, at value `rgb(17,17,17)` against a `rgb(18,18,18)`
background (a single-pixel antialiased top edge of the island itself, a difference of 1/255 per
channel). Rows `y=88..124` are `1298/1369`, i.e. the hamburger is there. `smoke-test.mjs` guards the
offset stays `>= 64px`.

## An honest note on how the dark-theme check went

During development, the dark-theme chat panel was repeatedly misjudged as "still white" by visually
inspecting the rendered screenshot preview — several rounds of real code changes were made chasing
that (removing duplicate theme application across three places, forcing reflow, forcing extra
animation frames, forcing a window resize repaint). Some of those changes were genuine
simplifications worth keeping (theme is now applied once, on `document.documentElement`, instead of
redundantly on three separate elements). But the specific "still white" diagnosis that motivated the
last two rounds turned out to be wrong: direct pixel sampling (`PIL.Image.getpixel`) showed the panel
was already correctly dark (`rgb(26,26,30)`) at that point — the screenshot was fine, the visual
read of it was not.

That's why `verify-pixels.py` exists and why `npm run verify:visual`'s output should be checked with
it, not just glanced at — this project's own development process is the demonstration of why.

## Real chat — Anthropic streaming with tool use (stream A)

The chat is no longer the keyword-stub. A real streaming client lives in the **main
process** (`main/chat-stream.mjs`) and talks to whatever endpoint/key/model the user
configured in the settings window — the model id is read from `config-store.model` at
request time, so "what is set in the window" is authoritative (no hardcoded default in
the client). The API key never crosses into the renderer: `preload.cjs` exposes
`window.chatBridge`; the renderer calls `chatBridge.send(text, { tools })`, the main
process streams `chat:stream` events back (`text` / `tool` / `done`), and tool calls
are delegated to the renderer via `chat:toolRequest` → `bridge.use_command` →
`chat:toolResult`. So the model can create/move/link nodes on the live canvas.

Why the split: `main/` must not import `src/` (Excalidraw/React), so it cannot run the
commands itself — yet the key must stay in main. The renderer owns the canvas, so it
runs the tools; main only parses the SSE and drives the conversation loop. `tools` are
built in the renderer from `bridge.list_commands()` filtered to `!notForChat`, so
the import command is never reachable from chat text.

Each chat-reachable command now carries a **real JSON `inputSchema`** (not prose) so the
model emits valid tool inputs. The SSE parser reassembles streamed `input_json_delta`
fragments and detects `stop_reason: tool_use` to continue the multi-turn
`tool_use → tool_result` loop. A live call could not be exercised in this sandbox
because it has **no OS keyring**, so `safeStorage` is unavailable and no key can be
stored (the app correctly stays in stub mode until a key exists — that gating is
intended). The mechanic was instead verified directly: a mock Anthropic SSE server
drove `streamAnthropic` through a full tool_use→tool_result turn; partial JSON was
reassembled to `{id:'Z',label:'Z',x:100,y:100}` and `stop_reason`/`end_turn` handled.
In-app, `window.chatBridge` with `send`/`onToolRequest` is exposed, all 13
chat-reachable tools carry `inputSchema`, `canvas.importArchify` is excluded (`notForChat`),
and `bridge.use_command('canvas.addNode', …)` executes on a live node.

To run it for real: open ⚙ in the chat header, paste the Anthropic endpoint, key and
model (catalog refreshed to `claude-sonnet-5` / `claude-opus-5` / `claude-fable-5` /
`claude-haiku-4-5-*` per current docs), save — then ask the chat to draw/connect nodes.

**Wire format is auto-selected from the endpoint.** The original client speaks the
Anthropic Messages API (`/v1/messages`, `x-api-key`). The endpoint `…/v1/chat/completions`
(OpenAI-compatible gateways — e.g. GLM/`glm-5.3-flash` behind a `/v1/chat/completions`
URL) is detected and routed to a second client that uses `Authorization: Bearer`, the
OpenAI `tool_calls` streaming shape, and converts the conversation to/from OpenAI
`messages`/`tool` roles. Both share one dispatcher `streamChat(endpoint → client)`.
Verified against a mock OpenAI SSE server: `tool_calls` fragments reassembled to
`{id:'Z',label:'Z',x:100,y:100}` and the `tool_use → tool_result` loop ran.


- Real Anthropic API streaming client in place of `llm-client.mjs`'s stub.
- Real project graph extraction (the AST/LSP "layer 2" from the wider plan) in place of
  `project-store.mjs`'s hardcoded demo graph. This is also what would replace archify's curated
  "Semantic Passport" data with mechanically extracted facts — see the Archify Phase 1 section.
- dock/controller.mjs registration into the actual Code Canvas Focus Dock app shell — this prototype
  runs as its own standalone Electron app, not yet wired into the real project's `main/plugins/`.
- Archify phases 2–6: the CLI invoked as a subprocess from inside the app (an "Architecture Overview"
  mode) instead of a pre-generated HTML file in the repo root, chat patching the IR, two-way
  canvas↔archify sync, live preview, evidence links.

## Stream D — load test, measured (not eyeballed)

Run `npm run verify:stress`. Same deterministic graph (seed 42) through two insertion paths:

- **bridge** — batched `canvas.addNodes` (20/call) + one batched `canvas.addEdges` call
  (validate-then-commit: any unresolved endpoint aborts the whole batch, nothing half-built)
- **baseline** — the identical graph in ONE direct `updateScene` (pure Excalidraw cost, no bridge layer)

Environment: Wayland + software rendering (`disableHardwareAcceleration`) — treat FPS as a conservative
floor; run-to-run FPS variance on this setup is ~±25% at 1500 nodes (both modes shift together).

| mode | nodes | edges | addNodesMs | addEdgesMs | fillMs total | avgFps (3s pan) |
|----------|------:|------:|-----------:|-----------:|-------------:|----------------:|
| bridge | 100 | 66 | 18.7 | 1.5 | 20.3 | 59.7 |
| baseline | 100 | 66 | — | — | 4.6 | 60.0 |
| bridge | 500 | 371 | 159.3 | 5.5 | 165.0 | 40.8 |
| baseline | 500 | 371 | — | — | 18.7 | 45.8 |
| bridge | 1500 | 1137 | 1119.9 | 17.1 | 1137.0 | 22.7 |
| baseline | 1500 | 1137 | — | — | 41.2 | 29.8 |

Before/after for the batched-edges fix (per-edge `addEdge` loop → one `canvas.addEdges` call,
old artifacts kept as `artifacts/stress-*-before.json`):

| nodes | addEdgesMs before | addEdgesMs after |
|------:|------------------:|-----------------:|
| 100 | 16.9 | 1.5 |
| 500 | 262.1 | 5.5 |
| 1500 | 2065.1 | 17.1 |

Reading (D7):

- **Pan/zoom FPS is Excalidraw-bound, not bridge-bound**: at 1500 nodes bridge and baseline FPS are
  equal within run variance. Any virtualization/lazy-drawing decision belongs to the Excalidraw layer.
- **Edge insert latency is fixed**: 2065ms → 17ms at 1500 (one updateScene instead of 1137). The
  remaining insert gap (1137ms vs 41ms baseline) is now ENTIRELY the per-node `updateScene` inside
  `addNodes` — that's the next (and last) bridge-layer win, deliberately not done in this edit.
- **Leak check — honest result, criterion partially met.** Compaction (`canvas.compact` +
  auto-threshold at 30% tombstone share inside `removeNode`/`removeNodes`) does what it claims at
  OUR layer: the scene array no longer accumulates tombstones (plain vs explicitly-compacted runs
  end at the same memory, so the array is provably not the driver). But end-of-run RSS still
  plateaus at ~1.04GB total / ~655MB renderer — the same level as before compaction (1026MB).
  The residual retention is inside Excalidraw internals (undo-history snapshots and render caches
  holding element references until their own eviction/GC), which our scene compaction cannot touch.
  Follow-up if real graphs will see heavy add/remove churn: investigate resetting/trimming
  Excalidraw's history between bulk operations — deliberately out of scope for this edit.

Full JSON per run: `artifacts/stress-<mode>-<count>.json` (+ `-cycles10` / `-cycles10-compacted`),
screenshots `artifacts/stress-*.png` (with `elementsInScene` confirming no elements were lost in
batch insertion). Pre-change artifacts are preserved as `artifacts/stress-*-before.json`.

## Stream C — chat connection config (endpoint, key, model)

Scope decision (C0): a single configurable endpoint + model + key — the endpoint field is the
flexibility hook (proxy / self-hosted gateway); no multi-provider abstraction was built.

- `main/config-store.mjs` — `{endpoint, model, createdAt, updatedAt}` JSON in `app.getPath('userData')`,
  whitelisted fields on write, `https://` enforced. The key NEVER goes here.
- `main/secret-store.mjs` — key encrypted via `safeStorage` (OS keyring) into `chat-key.bin`.
  The key never crosses the preload boundary back to the renderer — only a boolean status
  (this deviates from the plan's `secret:getKey` channel name on purpose: the renderer never needs
  the key itself, only `secret:keyStatus`).
- `preload.cjs` → `window.configBridge` — narrow IPC surface: `config:get/set`, `secret:keyStatus/`
  `setKey`/`clearKey`, `config:testConnection`.
- Settings UI in `chat-panel.mjs` — gear in the header opens an overlay: endpoint (text), model
  (input + datalist from `src/chat/models.json` — editable without rebuild), key (password, never
  rendered back once stored). "Save" runs the connection test FIRST — failed checks save nothing (C4).
- Fresh profile shows an explicit "ключ не настроен" banner (C5) — the stub parser still works, so
  the composer stays usable; the situation is stated, not silent.
- `main/anthropic-client.mjs` is deliberately MINIMAL (single 1-token test request in the main
  process, no CORS). The full streaming client is still Stream A3 work.

Verified by `--scenario=config-selftest --profile=<name>` (isolated userData): config round-trip,
safeStorage available → set/status/clear, `testConnection` failure path against a dead endpoint
returns an error instead of saving, form opens prefilled with the key field empty, fresh-profile
banner visible. Real-endpoint probe with an invalid key returns HTTP 401 — TLS and the endpoint
path work from this machine. Screenshots: `artifacts/electron-chat-only-light-config-form.png`.

Still open in this stream: the C7 end-to-end loop with a REAL API key (needs the user's key),
and the real streaming client (Stream A3) that will read config per-request via the same stores (C6).

## Archify Phase 1 — the IR becomes LIVE canvas elements (not a picture)

Goal of the phase, in the user's words: *the archify nodes are static, the canvas is dynamic — so the
integration has to go **into** the canvas.* So this is deliberately **not** "embed archify's HTML as a
second view". `canvas-v2-architecture.json` is converted into ordinary Excalidraw elements that can be
selected, dragged and fed to the chat context like anything else drawn by hand.

### The converter is data-only

`src/canvas/archify-import.mjs` exports one pure function, `importArchifyIR(ir) → { nodes, edges,
frames, warnings, source }`. It imports nothing from `adapter.mjs`, React or Excalidraw, so it is unit
testable without a window (`smoke-test.mjs` guards that). It accepts **both** shapes the archify CLI
produces: the authored form (`pos`/`size`) and the resolved form from `archify validate ...
--layout-json` (`x`/`y`/`width`/`height`). Refusals are explicit, with codes, not silent best-effort:
`MISSING_GEOMETRY` (row/col layouts — the message names `--layout-json` as the remedy),
`UNSUPPORTED_DIAGRAM_TYPE`, `BAD_INPUT`.

### The mapping, and what is deliberately dropped

| IR | canvas | note |
| --- | --- | --- |
| `components[]` | rectangle + bound label + sublabel | `x/y/w/h` copied verbatim, not re-laid-out |
| `connections[]` | arrows, border-clipped | existing `addEdges` contract |
| `boundaries[]` | **native** `type: 'frame'` elements | geometry derived, see below |
| `cards[]` | — | prose bullets, not graph facts; returned under `source` as unconverted |
| `meta.views[]` | — | overlaps Stream B's `pinnedContext`; needs a product decision first |

`cards`/`views` are reported as unconverted rather than quietly ignored — `smoke-test.mjs` checks they
never leak into the graph.

Boundary geometry is **not** in the IR (only `wraps`), so it is derived the same way archify's own
renderer derives it (`boundaryPad: 30`, `boundaryExtraBottom: 20`, `topPad: 30`). Replicating a
constant is a drift risk, so the test asserts against the real thing: `tests/archify-import.test.mjs`
runs the archify CLI with `--layout-json` and requires our derived frame rects to equal archify's own
resolved boundary rects. The same test confirms archify's layout is byte-identical across runs, i.e.
re-exporting is safe. 15 tests, all passing (`node --test "tests/*.test.mjs"` — note: **not**
`node --test tests/`, which fails to resolve).

Two Excalidraw facts that shaped the mapping, both verified against the shipped `.d.ts` rather than
guessed: `ExcalidrawFrameElement` needs exactly one field beyond our base props (`name`), and
`frameId` is a single string — so two overlapping boundaries **cannot** both own a node. The converter
keeps the first and warns. Frames are inserted **before** their members in the scene array; the
reverse order renders incorrectly.

A sublabel cannot be a second line of the bound label: a container holds one bound text and centres the
whole block, so two font sizes in one label are impossible. It is therefore a separate text element
(12px, code font, `customData.role: 'sublabel'`) — this is the only place the IR carries a file path,
so dropping it would have lost the one file-level fact in the data.

### Proof that the result is editable, not a prettier picture

`--scenario=archify-import` (reads the spec in main — the renderer has no `fs`), all checks passing on
both themes, `artifacts/archify-import.json` + `artifacts/archify-import-{dark,light}.png`:

- 4/4 frames (all `type: 'frame'`), 11/11 nodes, 10/10 arrows, 11/11 sublabels
- `misplaced: []` — every rect sits exactly at its IR coordinates
- `membershipBroken: []` — every wrapped node's `frameId` points at a real frame in the scene
- selection of an imported node reaches the chat context store: `["node-bridge_layer"]`
- programmatic `canvas.updateNode` moves it: `movedBy: 60`
- **real pointer drag**: `selectedOnPointerDown: "node-command_engine"`, `nodeMovedBy: 120`,
  `arrowVersionChanged: true`, `arrowGeomChanged: true` (arrow `72×0` → `103.8×54.5`)

Two findings behind that last line, both of which had produced a *false* pass/fail earlier:

1. **`updateScene` does not run Excalidraw's binding recalculation.** A programmatic move leaves the
   arrow where it was no matter how correct the bindings are. So "the arrow re-routed" is now asserted
   only via a real `sendInputEvent` drag; the old programmatic assertion was replaced, not kept
   alongside, because it could never have been true.
2. **Arrow bindings are two-way, and the shape side is the one that matters for dragging.**
   `startBinding`/`endBinding` on the arrow is only half of it — Excalidraw consults the *shape's*
   `boundElements` to decide which arrows to re-route. With only the arrow side set, the node dragged
   and the arrow stayed put. `importArchifyGraph` now writes the back-references too.
   The pre-existing `addEdge`/`addEdges` still set only the arrow side; they were left alone because
   their Stream D numbers are measured against that behaviour. That is a known, unfixed inconsistency,
   not an oversight.

A third finding, before either of those was reachable: centre-to-centre arrows **swallow clicks on the
node**. The stored points are both what gets drawn and what gets hit-tested, so an arrow passing
through a node's interior wins the hit test at its centre — a click on `command_engine` selected
`edge-command_engine-canvas_adapter`. Border-clipping the arrows (`buildBorderArrowElement`) is what
made the node clickable at all, and the scenario now guards it (`selectedOnPointerDown`).

### Stress numbers re-measured, because the canvas layer changed

`buildNodeElements` can now return 3 elements instead of 2, so Stream D was re-run rather than
trusted. Element counts are **identical** to the pre-Phase-1 artifacts (266 / 1371 / 4137 for
100 / 500 / 1500) — the stress generator passes no `sublabel`, so the third element is never created
and the shape of the scene is unchanged. Previous artifacts kept as `stress-*-prephase1.json`.

Timings did move, and honestly: `avgFps` at bridge-500 read 45.8 in the old artifact and 9.5 in the
re-run. That is **not** a Phase 1 regression — it is the documented ±25% software-rendering spread
plus load on this machine, and it does not reproduce: three consecutive re-runs of the same command
gave 22.6 / 23.1 / 22.6 fps, and the `baseline` path (which does not touch the bridge at all) gave
21.7 fps in the same conditions. Comparing modes *within one run* remains the only meaningful read;
cross-run absolute FPS from this environment is not evidence of anything.

### Phase 1 close-out — review-found label regression (root cause + fix)

The Aug-29 review screenshots showed `command_engine` with its **main label sunk
below** the rectangle. A *human* review of the rendered picture caught it; the
import harness's `problems[]` could not, because it only counted elements and
checked rect coordinates — a mispositioned label is invisible to that.

**Root cause — bound-text layout desync, NOT data, NOT a missing font.** The first
agent diagnosis was wrong and circular: it compared the *stored* `text.y` against
the very formula that wrote it, and (after `updateScene`, which never recomputes
bound-text layout) they always agreed. The real test is what Excalidraw paints
*after* a real interaction. A live diagnostic (`--scenario=archify-diag`) imported
the real spec and compared the label's offset from its rect before vs. after a
genuine pointer drag:

- `labelOffsetBefore = 12` (exactly the value `buildNodeElements` wrote)
- `labelOffsetAfter  = 72` (= container height 64 + 8px gap, i.e. the bound text
  was re-laid-out **below** the rectangle)

So Excalidraw, on recompute, was treating our hand-built `containerId` +
`rect.boundElements` binding as malformed and re-anchoring the label beneath the
box. The missing-font theory (a 404 on Excalidraw's `Assistant` webfont, which
*was* a real but **separate** bug — fixed by copying `fonts/` in `build.mjs`) was
a red herring: a font change shifts glyph metrics, it does not move a label
outside its container.

**Fix (option A per review — native bound text, NOT a free overlay).** The label is
now created through Excalidraw's OWN converter. `buildNodeElements` returns a
single rectangle skeleton carrying a `label`, and the adapter feeds that into
`convertToExcalidrawElements`. That path runs Excalidraw's real binding machinery
(`bindTextToContainer` → `redrawTextBoundingBox` → `computeBoundTextPosition`), so
the text is born at `containerId: node-<id>` with Excalidraw's canonical centred
position, and stays there on **every** recompute. Because the binding is valid,
the label follows the rectangle on a real pointer-drag and there is no desync left.
The earlier **free-overlay** variant (`containerId: null`, `boundElements: null`)
was rejected by the review and abandoned: an unlocked overlay intercepts clicks
meant for the rect (`selectedOnPointerDown: text-…`), a locked one blocks selection
altogether (`selectedOnPointerDown: null`), and in both cases the label does not
follow a real drag.

For the first correct variant, the main label and the file-path sublabel are merged
into **one two-line bound text** (single font size). Mixed typography (code-font
path) is deferred; a rich/mixed label is only worth revisiting once the interaction
model is proven with a proper binding.

**What changed structurally (this is the real fix).**

- `buildNodeElements` (`src/canvas/node-elements.mjs`) now emits ONE rectangle with a
  `label` (id `text-<id>`, `textAlign: center`, `verticalAlign: middle`, the two-line
  text). It is dependency-free so the unit tests import it from plain Node.
- `adapter.mjs` imports `convertToExcalidrawElements` from `@excalidraw/excalidraw`
  (it already imported `sceneCoordsToViewportCoords`) and converts every skeleton
  in `addNode` / `importArchifyGraph`.
- `resolveNodeParts(id)` was added, and `updateNode` / `removeNode` now act on the
  whole composite node (rect + bound text + arrows + arrows' bound labels), so CRUD
  no longer tombstones just the rectangle.
- `_getRawElements` now also returns `text` / `originalText`, so `labelProbe` can
  actually read the label text instead of `undefined`.

**Verification (measured, not eyeballed).**

- `labelProbe: []` — every imported node's label is container-bound to its rect,
  the rect back-references it, the text sits inside the rect, and the sublabel line
  is present.
- Real pointer drag of `command_engine` (dy 120): `selectedOnPointerDown:
  node-command_engine` (a click on the node hits the **node**, not the label),
  `nodeMovedBy: 120`, `labelMovedBy: 120` (the label follows), `arrowGeomChanged:
  true` (the arrow re-routes).
- Selection reaches the chat context store (`contextSelectionIds: node-bridge_layer`).
- Pixel probe reads the real rendered canvas in **both** themes. **The round-2
  reviewer found the vertical-only probe insufficient**: it checked `inkBelow` but
  not whether the label is clipped at the LEFT/RIGHT border. A per-node probe that
  scans the whole text block (excluding arrow ink near the vertical centre)
  reports `archify-import-pixel-dark.json -> ok: false` with `overflow:
  [command_engine (lPad 0, rPad 0), canvas_island (lPad 1, rPad 1)]`. So the
  label is inside vertically but **clipped horizontally on those two nodes —
  Phase 1 is NOT closed.**

**Remaining work (the round-2 blocker).** The IR declares all boxes 150–160 px
wide, but the actual render uses fontFamily 1 (Virgil, size 16), and the longest
line (`command-registry.mjs`, 20 chars) exceeds 160 px; `Command Engine` renders
at ~160 px though its stored `text.width` is only 143.4 (`text.width` for bound
text under-reports the painted glyphs, so `fitProbe`/`labelProbe` show `fits: true`
and miss the clipping). The agreed fix is to **auto-widen the box to fit the actual
rendered text at import** (`rect.width = max(declared, measuredRenderW +
BOUND_TEXT_PADDING*2 + margin)`), re-measure with the per-node pixel probe until
`lPad/rPad ≥ 8` on all 11 nodes in both themes, then regenerate the evidence and
only then re-open the Phase 1 close-out.

**Systemic rule (handoff 1.2) — do not hand-build bound/linked geometry without a
real UI trigger.** Any element created via `updateScene` with manual coordinates for a
bound or linked part (`bound-text`, `arrow-bindings`) will, on the next real
interaction, be recomputed by Excalidraw and may land in a layout that disagrees
with what the data says. The reliable way to avoid the desync is (a) build the
binding through Excalidraw's own API so it records valid internal geometry — the
path taken here — or (b) make the part a free overlay that Excalidraw never
recomputes (rejected here because it breaks pointer-drag). This applies not just to
archify import but to `addNode`/`addNodes` in general: if those ever grow a
two-line/sublabel pattern, the same native-binding API must be used, or the same
sag returns.

**Acceptance (handoff 1.4).** The bug is closed only when both
`artifacts/archify-import-light.png` and `artifacts/archify-import-dark.png` show
"Command Engine" rendered **inside** its rectangle. Programmatic checks missed this
twice, so the picture is the arbiter. The import scenario writes those screenshots
from the *clean* imported layout (before the arrow-reroute drag scrambles
`command_engine`) and additionally runs an in-page **pixel probe** that reads the
real rendered canvas: it confirms ink pixels sit inside the rect and none below it
(`artifacts/archify-import-pixel-{light,dark}.json`). When `ok: true` in both, the
label is provably inside its box.

Reference screenshots: `artifacts/archify-import-{light,dark}.png`.

### Honest side effect of this approach

The imported nodes do **not** carry archify's own "Semantic Passport" panel. That panel is part of
archify's separate JS application, bound to its JSON — it does not travel with the elements. So after
import, clicking a node gives an ordinary Excalidraw selection, not the card with tags and
upstream/downstream lists. This is expected, not a bug: the replacement (a real AST overlay on click)
was explicitly deferred by the user to a later pass. Also worth restating: the tags and edge labels in
`canvas-v2-architecture.json` are **curated** output from the archify skill reading the code, not a
mechanical AST extract — valuable as a UI template, provisional as data.

---

# Phase 2 — archify import as a real, in-app command

Phase 1 turned the archify IR into **live** canvas elements via a CLI-driven scenario. Phase 2 makes
that import a **command inside the running app** (a toolbar button), driven by the linked project's
spec, instead of a `--scenario` flag or a committed root file.

## Why it was built this way (verified against the CLI)

A key finding that shaped the design: **archify has no command that scans a repository and produces an
architecture spec.** Its subcommands (`validate`, `render`, `deliver`, `preview`, ...) all operate on an
**already-authored** `input.json`. The authoring step is the archify skill/agent reading the code and
writing the spec. So "run archify against a project" really means "run archify against that project's
published spec" — the spec path is the parameter, and it comes from the linked project.

## What changed

- **`main/archify-client.mjs`** (new): resolves the archify bin from a predictable path
  (`~/.agents/skills/archify/bin/archify.mjs`), expands the `@app/...` marker against the app root, and
  runs `archify validate architecture <spec> --layout-json` in the **main** process. Failures are
  structured (`{ ok:false, error }`) — `ARCHIFY_NOT_FOUND` if the skill is missing, `CLI_ERROR` on a bad
  spec — never a raw throw.
- **`main.mjs`**: `registerArchifyIpc()` adds `ipcMain.handle('archify:validate', ...)`.
- **`preload.cjs`**: exposes `window.archifyBridge.validate(specPath)` (narrow, named surface, like
  `configBridge`/`chatBridge`).
- **`src/project/project-store.mjs`**: link state now carries a `specPath`; `linkCanvas(canvasId,
  projectId, specPath)` defaults the demo spec to `@app/canvas-v2-architecture.json`.
- **`src/bridge/command-registry.mjs`**: `canvas.runArchifyImport` — reads the link status, requires a
  linked project (`NOT_LINKED` otherwise), calls the CLI over IPC, converts the IR via `importArchifyIR`,
  and commits via `importArchifyGraph({ replace: true })`. Marked `notForChat: true`, same reason as
  `canvas.importArchify`.
- **`src/renderer-entry.jsx`**: an **Archify** toolbar button. Disabled (with a tooltip explaining why)
  when no project is linked; on click shows a live status: `Строю архитектуру…` → `Готово: N узлов, M
  связей, K зон.` or `Ошибка: …`.
- **`src/bridge/protocol-result.mjs`**: `fromThrow` now resolves async fns (the CLI command crosses
  IPC), so it returns a promise for async commands and the sync value for the rest.

## How it's verified (real command path, not the scenario flag)

The `--scenario=archify-button` path links the project, then calls `canvas.runArchifyImport` — the same
code the button runs (link → IPC → CLI → `importArchifyIR` → `importArchifyGraph`), reading the spec by
path rather than inlining it in main. Both themes render the full 11-node / 10-edge / 4-frame diagram:

- `artifacts/archify-button-dark.png`, `artifacts/archify-button-light.png`.

`--scenario=archify-unlinked` proves an unlinked canvas refuses to import with an explicit `NOT_LINKED`
error and shows the button disabled:

- `artifacts/archify-unlinked-dark.png`.

## Known, deferred (does not block Phase 2)

- ~~**Horizontal label clipping** (found in Phase 1 round 2)~~ — **closed (Round 24–26).** The IR box
  was narrower than the real Virgil render (stored `text.width` under-reports painted glyphs). Fixed by
  deterministic S7 sizing in `archify-import.mjs` (`estimateArchifyLabelWidth` + 36px guard, centre
  preserved, boundaries → union with widened members) plus wrapped-max-width/row-reflow. The live
  pixel probe (`archify-import-pixel-{dark,light}.json`) was regenerated in Round 26 on a real
  Electron/Xvfb machine and reads `ok: true` with all 11 nodes at `lPad/rPad >= 8` (min lPad 9,
  min rPad 11), empty `nullExtent`/`overflow`, and the machine-readable `layoutSafety` gate:
  `overlapCount === 0`, `minimumRowGap = 44` (>= 32). Enforced as a mandatory CI gate (`verify:pixel`),
  which also checks PNG existence and the live overlap/gap metrics — prose or a pure unit test alone
  is no longer sufficient to claim no overlaps.
- **Merge, not replace**: `runArchifyImport` currently replaces the scene (`{ replace: true }`). Merging
  with hand-drawn content is a separate, later task.
- **Real third-party spec**: the demo link points at the bundled spec (the app's own architecture). The
  mechanism is fully parameterized (any project link can carry any spec path); running it against a
  different real repo only needs that repo's spec to be authored and its path linked.

---

# UI — chat tucked behind a button (like the Library panel)

The chat no longer occupies the right panel permanently. In `full` mode it is **collapsed by default**,
visible only as a **Chat** toolbar button. Clicking the button opens the panel (the button hides); the
**✕** in the panel header closes it and the Chat button reappears.

- `src/renderer-entry.jsx`: **Chat** button + `setChatOpen(open)` (toggles `#chat-root` and the button's
  visibility); `window.__setChatOpen__` is exposed for scenario drivers.
- `src/chat/chat-panel.mjs`: `mountChat(containerEl, { onClose })` renders the **✕** in the header;
  it calls `onClose` (the composition root owns the layout decision).
- `src/chat/chat.css`: `.chat-close` styling (inherits `.chat-gear`, red hover).
- `main.mjs`: `draw-and-ask` opens the chat before typing so the visual proof shows the conversation.

---

# S5.2 — natural-language, model-driven Archify authoring

Phase 2 proved that a *published spec* can be imported over IPC. S5.2 is a stronger claim: the whole
chain starts from a **natural-language request** and the agent drives it by choosing tool calls, exactly
the way a live model would. It is proven by `--scenario=archify-agent`.

## The claim

```
«Изучи проект fixture-project и построй его архитектурную схему на холсте.»
  → agent reads project evidence (project.getStatus → project.listFiles → project.readFile ×N)
  → loads the Archify schema + common-schema ($ref) + an example (archify.getSkillFile)
  → authors a candidate DERIVED FROM THE FILES IT READ (archify.author)
  → first candidate is deliberately invalid → the CLI returns diagnostics
  → the agent repairs with the returned runToken (bounded loop)
  → gets a layout IR → projects it onto the live canvas
```

## What runs the real runtime

The authoring scenario *before* Round 10 fed a hardcoded candidate straight into IPC; the Round-10
adapter derived its candidate from a **hardcoded `candidateFor()`** (`web → api → db`), so the model
drove the sequence but not the content. This pass closes that gap (**S5.2b**): `main/evidence-builder.mjs`
is a pure, deterministic builder that turns the `(rel, content)` pairs the agent actually read into
components + edges. The scripted model (`main/agent-scripted-model.mjs`) now drives `project.readFile`
for every source file the `project.listFiles` result surfaces, then runs the real `buildArchitectureFromEvidence`
over those results. No diagram content is hardcoded.

`runChatTurn` builds an immutable `AgentRunContext` (frozen prompt + allowlist + Archify binary/hash/profile),
then routes each tool_use through `executeTurnTool` — `project.*` and `archify.*` execute **in main against
the frozen context**, and the projection is committed on the canvas through the renderer bridge. A
deterministic **scripted model adapter** stands in for the LLM: it has the same `streamChat` signature, stitches
the next `tool_use` from the accumulated message history, and is how the loop is proven headlessly (no
API key / no network in the harness).

The repair is exercised honestly: the FIRST authored candidate uses an invalid component `type`, so
the Archify CLI returns a `schema/enum` diagnostic, and the agent re-authors with the returned
`runToken`. That is the bounded repair loop, not just the happy path.

## Verified output (real Electron run)

```
flow: project.getStatus → project.listFiles → project.readFile ×3
      → archify.getSkillFile (schema) → archify.getSkillFile (common-schema)
      → archify.getSkillFile (example)
      → archify.author (broken) → archify.author (repair w/ runToken)
authorAttempts: 2   firstAuthorFailed: true   repaired: true
components: 3   connections: 2   checks: 9   candidateHash: a88f30fdf2ab
projected: { frames: 0, nodes: 3, arrows: 2 }
ARCHIFY-AGENT: ALL CHECKS PASSED
```

The live canvas ends up with the `Web → API → DB` architecture (3 nodes, 2 arrows) as **editable
Excalidraw elements**: `artifacts/archify-agent-dark.png`.

## Evidence-driven proof (S5.2b)

Beyond the happy path, the scenario now asserts the candidate is a **pure function of the read files**:

- The flow includes `project.readFile` (not the old `project.search` probe).
- The authored components are compared to `buildArchitectureFromEvidence` over the files the agent read
  at the **structural level** (`evidenceDerived`: normalized `{id, type, label}` + `{from, to}` edges),
  not just by id — so a hardcoded candidate with the right ids but wrong types/labels/edges would NOT pass.
- Every authored node id maps back to a real file the agent read (`nodesHaveEvidence` via the builder's
  `evidenceMap`), and the **discovery plan** (what the model intended to read, reconstructed via
  `planEvidenceReads`) is fully satisfied — every planned file was actually read and no read failed
  (`planSatisfied`) — and an **independent expected fixture** (`web/api/db` + `web→api`, `api→db`, not
  derived from the builder) matches the authored IR (`expectedMatches`). No absolute paths or a `sources`
  array leak into the candidate or the receipt.
- A **metamorphic** unit test (in `tests/evidence-builder.test.mjs`) renames `api → worker` in the
  fixture and asserts the derived architecture becomes `web → worker → db`. Same builder, different
  evidence, different diagram — proof it is data-driven, not template-driven.

## Project-grade evidence building — honest scope (Round 13 / 14 / 15 / 16)

**Round 12 / 13** hardening makes the builder survive a real repository, **Round 14** closes the
reviewer's P1/P2 findings (monorepo identity, real `$ref` schema causality, snap-not-drop), **Round 15**
fixes the two findings that Round 14 introduced but did not actually wire up (priority discovery received a
component id instead of a file path; `common-schema` was an availability check, not a causal gate), and
**Round 16** resolves the last required P1 before S6: an example must NOT be allowed to override the
schema's pinned `schema_version`/`diagram_type` `const`s (precedence is now schema `const` → validated
example value → safe default), plus the `planEvidenceReads({maxFiles: 0})` edge case. The honest milestone
is **S5.2b.2 — bounded JS/TS fixture-driven authoring with tier aggregation**, not full project-grade.
What is proven:

- **Module identity is separate from component type** (`componentId`): the id is the nearest
  meaningful directory segment, walking through generic role names (`index`/`main`/`app`/`server`/
  `config`/`utils`/…) and stopping before a module root (`src`/`packages`/`apps`/`services`/…). So
  `src/catalog/index.ts → catalog` and `src/billing/index.ts → billing` are DISTINCT modules and the
  `catalog → billing` edge survives (no false `index` merge). `src/server/index.ts → server` (fallback
  generic) when no meaningful directory sits above it.
- **Namespace-aware identity in a monorepo** (Round 14): when a file sits under a workspace root
  (`apps`/`packages`/`libs`/`modules`), `componentId` prefixes the module identity with the app/package
  namespace, so `apps/web/src/api/index.ts → web-api` ≠ `apps/admin/src/api/index.ts → admin-api`, and
  `packages/catalog/src/components/Button.tsx → catalog-components` ≠ `packages/billing/… → billing-components`
  (Round-13 false merge repaired). `src/catalog/index.ts → catalog` still holds (single-app repo).
- **Tier aggregation (variant A)**: `src/api/users.mjs` + `src/api/orders.mjs` become ONE `api` component
  instead of duplicate `api` ids. Every file of the tier is still recorded (`tierFiles` / `evidenceRefs`),
  but the derived candidate has unique, schema-valid component ids.
- **Canonical import resolution**: imports are resolved against the importing file's directory, not by
  basename, so `src/api/index.ts` and `src/db/index.ts` no longer collide, and `import x from "../api"`
  resolves to `src/api/index.*`. (`resolveImport` is exported + unit-tested.)
- **Tier-balanced discovery** (`planEvidenceReads`): the model groups source files by module identity
  and round-robins across them up to `MAX_EVIDENCE_FILES` (16), so a big `api/` directory cannot crowd out
  `web/`/`db/`. Deterministic and bounded — a 50+ file repo cannot guarantee `TOOL_BUDGET_EXHAUSTED`.
- **Relevance-priority discovery when >16 modules** (Round 14, FIXED in Round 15): groups are ordered by
  `groupPriority(rels) = Math.min(…priorityOf(rel))` — `priorityOf` is applied to each FILE PATH, then the
  minimum lifts the whole module. Round 14 mistakenly called `priorityOf(groupId)` (a component id like
  `api`), so every group got priority 3 and fell back to alphabetical sorting; with a large `api/` the
  `zzz-api`/`zzz-db`/`zzz-web` entrypoints were silently skipped. Round 15 orders manifest/entrypoint/tier-root
  files (and thus their modules) first, so the round-robin cap never drops the persistence/API layers in
  favour of alphabetically-first dirs. Regression test: 18 `aNN` generic dirs + `zzz-api/db/web` must read
  the zzz entrypoints first.
- **Schema/example are causal, not an availability gate**: `usesSkillContent` requires a real JSON Schema
  (`type: "object"` + a `components` property, rejecting `{nonsense:true}`), and `usesExampleContent` requires
  `diagram_type === "architecture"` + a non-empty `components[]`. When the schema constrains the componentType
  enum, `buildArchitectureFromEvidence(files, { allowedComponentTypes })` no longer DROPS disallowed modules — it
  **SNAPS** them (`snapType`: the inferred type, then `external`, then the first allowed type; the module is
  never silently erased, and a warning is surfaced). Round 14 resolves the **real `$ref`**
  (`common.schema.json#/$defs/componentType`) by loading `common-schema`; Round 15 makes `common-schema` a **hard
  causal gate** (`schemaNeedsCommon`): if the schema depends on common and the common schema failed to resolve
  a usable enum, authoring STOPS (a broken common schema is not silently ignored). Round 15 also dereferences
  `components.items` first, so the nested `items.$ref → $defs/component → type.$ref` form resolves too. Broken
  schema/example ⇒ the turn ends with a clear error, not a fabricated diagram.
- **Example defaults shape the candidate, but the schema's `const`s win** (Round 14/15, tightened in
  Round 16): `usesExampleContent` surfaces `schema_version`, `diagram_type`, `quality_profile` into
  `mkCandidate`, and the title precedence is explicit (`projectTitle ?? exampleTitle ?? 'App'` — `titleFor`
  returns null without a linked project). The CLI `quality` option is single-sourced from the candidate
  (`qualityOf(candidate)`), so `meta.quality_profile` and `input.quality` can no longer diverge. Round 16
  adds a **hard precedence rule**: `schemaDefaults(primarySchema)` reads the `const`s on `schema_version` /
  `diagram_type`, and those win over the example; the example may only supply a value when the schema does
  NOT pin one. An example that contradicts the schema `const` (e.g. schema `{const: 1}`, example `2`) stops
  authoring (`end_turn`, no `archify.author`) — otherwise it would emit a candidate the CLI rejects even
  after a repair round. Metamorphic test: changing the example's `quality_profile` still changes the
  authored candidate AND the `input.quality`, while a `schema_version`-contradicting example is rejected.
- **Acceptance is no longer self-referential**: the scenario now asserts an **independent expected fixture**
  (`web/api/db` + `web→api`, `api→db`) that is NOT derived from the builder, and a non-tautological
  `planSatisfied` (the discovery plan is reconstructed and every planned file was actually read, `failedReads === 0`).
- **Budgets are a pure helper**: `main/tool-budget.mjs` (`wouldExceedToolBudget`) is checked before the
  assistant tool_use block is recorded, so a cap violation never leaves a dangling `tool_use`.

## Boundaries (what this does NOT yet claim)

- The model adapter is **deterministic** — it proves the runtime plumbing + the evidence-driven builder,
  not a particular model's judgement. A real natural-language run needs a live API key and network, which
  the headless harness cannot provide; `llm-client.mjs` remains an explicitly-labelled stub. A live model
  would still produce the `schema`/`example`/candidate via the same tools, but its *reasoning* is not
  under test here.
- The projection (canvas.importArchify) is performed by the scenario after the agent produces a layout
  IR, because `canvas.importArchify` is deliberately `notForChat` (an import must not be triggerable
  from a random phrase). The merge/replace/undo story is S6, still ahead.
- **Evidence refs are computed for the acceptance check, not yet persisted** into `customData` on the
  canvas nodes (that is S6, where `customData: { archifyComponentId, archifyType, evidenceRefs, sourceRunId, candidateHash }`
  will be written).
- The **end-to-end metamorphic** check is currently builder-level (unit test on `buildArchitectureFromEvidence`);
  a full e2e run (scripted model → CLI → canvas) with a renamed fixture would be the S6-era extension.
- **Language / import scope of the builder**: only `.js/.mjs/.cjs/.ts/.tsx/.jsx`, relative imports and
  catalog-module ids. Not covered: Python/Go/Rust/Java/C#/Ruby/PHP, Vue/Svelte, path aliases, workspace
  package imports, dynamic `import()`, framework routing/config. To claim true `project-grade` these must
  be extended (or explicitly documented as out of scope).
- **Type scoring/conflict warning (P2, open)**: when a module's files infer CONFLICTING non-external types
  (e.g. `api/cache.ts → database` + `api/server.ts → backend`), the builder still takes the first non-external
  inference. The reviewer's Round-13 suggestion (score/majority + an explicit conflict warning) is not yet
  implemented; the module is NOT dropped, but the type is best-effort. Documented as open (non-blocking).
- **Budget continuation is predicate-level, not e2e (P2, open)**: `wouldExceedToolBudget` and the
  check-before-append ordering in `runChatTurn` are unit-tested, but there is no end-to-end test that runs
  `runChatTurn` to `TOOL_BUDGET_EXHAUSTED`, asserts the history stays balanced (no dangling `tool_use`), and
  sends the next turn. Documented as open (non-blocking).
- **`snapType` is deterministic but not strictly "nearest" (P2, open)**: a `database` component snapped to
  `['frontend', 'backend']` becomes `frontend` (first allowed), not the semantically-along neighbour
  (`backend`/`external`). It never drops evidence, but the mapping is best-effort; a more faithful policy
  (`database→external`, `messagebus→backend`) or stopping authoring on an unsafe fallback is left open.

---

# S6 — Controlled Canvas Projection

S6 turns the already-valid Archify `layout IR` into a **safe, previewable, single-undo** Excalidraw import:

```
Archify layout IR → projection plan → preview → confirm → one Excalidraw transaction → receipt + provenance
```

It does **not** change evidence authoring (S5.2b.2 stays closed). It starts from a valid layout IR.

## What is proven mechanically

### Pure projection plan (`src/canvas/archify-projection-plan.mjs`)

`buildArchifyProjectionPlan({ ir, mode, existingElements, projectContext, skillContext })` is a **pure, deterministic**
function: it reuses `importArchifyIR` (never duplicates the Archify→node/edge/frame mapping), returns a serializable plan
(`version`, `projectionId`, `sourceHash`, `mode`, `nodes`, `edges`, `frames`, `elementIdsToDelete`, `counts`, `bounds`,
`warnings`, `unsupported`, `evidenceMap`, `provenance`), and never mutates the scene.

- **Content-complete identity (Round 17 P0 fix)**. `projectionId`/`sourceHash` are **SHA-256** (a pure, browser-safe
  implementation — no `node:crypto`, no 32-bit FNV) of the **full** projection payload: `sourceHash` hashes the complete
  normalized Archify IR + provenance context (labels, sublabels, x/y/w/h, component type, edge labels + `sourceId`,
  boundary geometry + name, project snapshot, skill hash, per-component evidence), and `projectionId` fingerprints the exact
  **placed/remapped** plan + mode + deletions + bounds. Two projections differing in ANY content (a label, a coordinate, a
  snapshot, a skill hash) get **different** `sourceHash`/`projectionId` — the idempotency registry can no longer apply the
  wrong projection (Round 17 P0); verified by a known FIPS-180-4 SHA-256 vector and by content-difference regression tests.
- **Immutable `sourceId`** is preserved on every node/frame/edge alongside the (possibly remapped) canvas `id`: a merge
  collision remaps `web → web-2` but provenance still reports `sourceElementId: web`. The original `connection.id` is now
  carried as the edge `sourceId` (it was previously dropped).
- **Per-component evidence** (`projectContext.evidenceMap`): each node carries **only** its own evidence refs; the
  projection-level `provenance.evidenceRefs` is for the receipt. A node with no attributable evidence omits `evidenceRefs`
  rather than copying a project-wide global list.
- No `Date.now()`, no `crypto.randomUUID()`.

- **Determinism**: identical `(ir, mode, scene)` → byte-identical plan (tested).
- **Merge** keeps the existing scene (`elementIdsToDelete = []`) and places the import to the right of existing content
  (fixed `MERGE_GAP`, top-aligned).
- **Replace / Reset** list every existing live element id for deletion and normalise the projection to the origin
  (a repeated import is byte-identical regardless of prior scene position — verified for off-origin IR too).
- **Collision remap** (merge, deterministic): when an imported id collides with an existing element, it is remapped
  (`web → web-2`) and every binding (edge `from`/`to`, frame member `frameId`, edge id) points at the remapped id.
- **Unsupported** `cards[]` / `meta.views[]` are surfaced in `unsupported` and `warnings`, never converted to nodes.
- **Invalid IR** (null, non-architecture, empty components, missing geometry) throws `{ code }` rather than silently
  building a broken plan.
- **Bug fixed during S6**: `unionBounds` previously let an empty bounds box pull the union toward `(0,0)`, breaking
  replace origin-normalisation for IRs whose content does not start at the origin (now covered by a regression test).

### Safe provenance (`src/canvas/archify-provenance.mjs`)

`buildArchifyProvenance` + `sanitizeEvidenceRefs` write the `customData.archify` object on every projected element:

```js
{ version, projectionId, diagramType, sourceElementKind, sourceElementId, skillHash, projectSnapshot, evidenceRefs }
```

- `sourceElementKind`: `component` (rect + bound text), `connection` (arrow), `boundary` (frame).
- `sourceElementId` is the **immutable Archify id** (component id / connection id / boundary label), not the remapped
  canvas id — so provenance survives a merge collision remap. Edges carry the original `connection.id` (or `null` when
  the IR has none; it is never fabricated).
- Evidence refs are **project-relative only**, deduplicated, sorted, capped (64 / 200 chars); absolute paths, drive
  letters, `.`/`..` segments and backslash paths are dropped. Edges never fabricate evidence refs (the builder does
  not know which import produced an edge). Per-node refs come from `evidenceMap[sourceId]` and a node with no
  attributable evidence omits the field rather than copying a global list.
- **Never stores**: project root, Archify binary path, API keys, prompt content, source code, run directory, IPC sender
  key, raw session/thread id, or the main-owned `runToken`.

The Electron acceptance proves the serialized `customData` on the scene contains no `/home/`, `C:`, `..`, `runToken`,
`apiKey`, `prompt`, `node_modules`.

### One undo transaction (`src/canvas/adapter.mjs` `applyProjectionPlan`)

`applyProjectionPlan(plan)` applies the plan as **one** `excalidrawAPI.updateScene` call (frames first, then existing,
then nodes, then edges — same order as `importArchifyGraph`). Merge keeps the scene; Replace/Reset drop the old array
(Excalidraw snapshots the prior array on `updateScene`, so a single undo restores it). It never calls `compact()`, and
never calls per-element mutators. The imperative Excalidraw API (0.18.1) exposes **no** `undo`/`redo`/`captureUpdate`
method, so the single-undo invariant is pinned structurally
(`tests/archify-projection-transaction.test.mjs` asserts exactly one `excalidrawAPI.updateScene(` call and no
`compact(` inside the apply) and by the keyboard attempt in the acceptance run (reported as a soft metric).

### Preview / Confirm / Cancel command layer

- `canvas.previewArchifyProjection` — builds + caches a plan, **no scene mutation**, returns the same object confirm
  would apply, plus an opaque **`previewToken`** that identifies THIS preview (content identity lives in `projectionId`).
- `canvas.confirmArchifyProjection` — applies the previewed plan in **one** transaction, routed by `previewToken`
  (legacy `projectionId` still works for backward compatibility). **Idempotent by consumed `previewToken`** (second confirm of that token → `alreadyApplied`,
  re-applies nothing) and **stale-protected** (if the scene changed since preview, it returns `stale` and applies nothing).
- `canvas.cancelArchifyProjection` — drops the pending plan without touching the scene.
- **Scene fingerprint is content-complete** (`src/canvas/archify-preview-state.mjs`): it hashes id + version/versionNonce
  + x/y/w/h + frameId + containerId + text, so a move / resize / edit / re-frame between preview and confirm (same id)
  is detected as stale — not just an id-list change. Pure + unit-tested.
- **Registries are bounded** (TTL 5 min + cap, eviction): pending previews and applied projections can't grow without
  bound, and `canvas.clearProjectionState()` is wired into `canvas.linkProject` / `canvas.unlinkProject` so a new canvas
  never inherits a stale block.
- All three (like `canvas.importArchify`) are `notForChat`: a model may prepare an IR but must never bypass
  preview/confirm to mutate the canvas.

### Electron acceptance (`--scenario=archify-projection`, `runArchifyProjectionScenario`)

Real renderer, real scene, real CLI-produced IR (Round 17 P1: the layout comes from `archify validate
<bundled-spec> --layout-json`, not an inline fixture with fabricated `sources`; the expected counts are derived from the
actual IR so the check holds for any size): manual sketch → preview (count unchanged, opaque previewToken) → confirm merge
(sketch preserved, imported `frames=boundaries/nodes=components/arrows=connections`, provenance present + safe with
immutable `sourceId` and per-component evidence) → cancel → idempotent re-confirm → stale refusal → replace (preview
reports exactly the live elements to delete; after confirm all remaining elements are projection-owned) → fit.
**ALL CHECKS PASSED** on 2026-09-01 (`cliGated: true`). Undo/redo is reported as a soft metric (see Boundary).

### Electron acceptance — real toolbar + React dialog (`--scenario=archify-projection-ui`, `runArchifyProjectionUiScenario`)

Drives the **real** UI, never a direct command call: click the toolbar `Link project` → click `Archify` → wait for the
`[data-testid=projection-dialog]` React overlay. Expected counts come from the **same** `archify validate` the toolbar
runs (`cliGated`), so the assertions hold for any spec size. Phases, all through real DOM:

- **Preview** — dialog opens, scene unchanged, mode + counts rendered, no raw paths / `evidenceMap` / `runToken` leak.
- **Cancel** — `Отменить` → receipt `cancelled`, scene unchanged.
- **Confirm** — `Импортировать` → receipt `applied`, applied **exactly once**, receipt carries `replace` mode.
- **Repeat-confirm** — `Проверить повторный confirm` → receipt `already_applied`, scene unchanged.
- **Stale** — change the canvas after preview → confirm → receipt `stale`, scene unchanged.
- **Failed** — invalidate the pending preview → confirm → receipt `failed`, scene unchanged, no plan/source leak.
- **Escape** — `Escape` cancels an active preview, scene unchanged.
- **Lifecycle gate** — preview (token A) → clear projection state (the same boundary hook `link`/`unlink` use) → confirm
  token A is **rejected** and applies nothing (scene unchanged).
- **Direct by-token idempotency** (diagnostic) — `confirm` of the same `previewToken` twice → `applied` then `already_applied`,
  independent of the overlay, so a failure is attributable to one layer.

**ALL CHECKS PASSED** on 2026-09-01 (dark + light), screenshots captured to `artifacts/archify-projection-ui-{dark,light}.png`
via `npm run verify:ui`. `clearProjectionState()` is also wired into `canvas.linkProject` / `canvas.unlinkProject` and is
exposed as an explicit `canvas.clearProjectionState` command for the future new-canvas / load / clear-scene boundaries.

## Boundary — what is NOT yet proven in S6

- **The React preview/confirm overlay UI** (`S6.3`) — **built and live-proven** (`--scenario=archify-projection-ui`),
  not a boundary item any more. The overlay renders mode/counts/warnings/source, guards double-submit, and drives
  confirm/cancel through the real toolbar button + dialog. Previews surface as a rendered card, not a raw result object.
- **Stale-preview re-preview flow** (`S6.4`): a stale preview is *refused* (never applied silently), and the live UI
  reports `stale` through the real dialog, but the automatic re-compute + re-preview path for Merge is not built (it
  returns `stale` instead of re-computing a fresh preview).
- **Receipt UI actions** (`S6.8`): the `layout_ready → preview_ready → applying → applied/cancelled/stale/failed`
  receipt state machine and `Fit imported / Select imported / Undo import / View warnings` actions are not wired into
  the chat receipt yet (the overlay shows a terminal receipt; the chat receipt actions are still ahead).
- **New-canvas / document-load / clear-scene lifecycle boundary**: there is no `new canvas`, `open document`, or
  `clear scene` flow in the app yet, so `clearProjectionState()` is wired to the boundaries that exist today (project
  `link`/`unlink`) and exposed as an explicit `canvas.clearProjectionState` command to be called on those flows when
  they appear. The live lifecycle gate proves a preview token from a previous canvas context is rejected on a fresh one.
- **Live keyboard undo/redo verification — now a hard gate** (closed in the Round 20 corrective pass on a machine with dependencies). The imperative Excalidraw API (0.18.1) exposes no `undo`/`redo`/`captureUpdate` method, so we drive the real shortcut via trusted main-process input (`win.webContents.sendInputEvent`). Two source-level fixes make it deterministic: all user edits and the final `applyProjectionPlan` pass `captureUpdate: CaptureUpdateAction.IMMEDIATELY` (the default `EVENTUALLY` leaves elements uncommitted, so a later replace drops them and undo can never restore them), and the exact-snapshot comparison (`normalizeScene`/`readNormalizedSnapshot`) filters `!isDeleted` because Excalidraw keeps `isDeleted=true` tombstones in the scene array after undo. Result on the acceptance machine: merge `beforeUndo:38 → afterUndo:2 → afterRedo:38`; replace `36 → 38 → 36`, `undoRestoresExactOldScene`/`redoRestoresExactProjection`/merge `undoOK` all `true`.
- **`canvas.importArchify` remains `notForChat`** (unchanged) and is kept only as a legacy/internal path; the model-driven S5.2 acceptance now uses preview/confirm for the authored IR and evidenceMap. The older authoring/
  agent scenarios (it builds + applies in one call). The interactive `layout_ready → preview → confirm → apply` UX is the
  S6.1 command surface; the chat receipt state-machine actions (S6.8) are still ahead.
- **HTML Archify viewer is not embedded** — only resolved IR becomes live Excalidraw elements.

## Round summary

| Area | Status |
| --- | --- |
| Pure projection plan | ✅ deterministic, tested |
| Content-complete identity (SHA-256) | ✅ label/coord/snapshot/skill → different id |
| Immutable `sourceId` + connection id | ✅ keeps Archify id under merge remap |
| Per-component evidence map | ✅ no global-list leak |
| Safe provenance (`customData.archify`) | ✅ no absolute/secret/source |
| Merge / Replace / Reset modes | ✅ merge preserves, replace resets |
| Collision remap + binding update | ✅ deterministic |
| One undo transaction (single `updateScene`) | ✅ code + structural test + live proof |
| Preview / Confirm / Cancel command layer | ✅ + idempotent + stale |
| Opaque previewToken + content fingerprint | ✅ token routing + move/edit stale |
| Bounded pending/applied registries | ✅ TTL + cap + clear on link/unlink |
| Electron acceptance (command layer) | ✅ ALL CHECKS PASSED (real CLI IR) |
| Electron acceptance — real toolbar + React dialog | ✅ `archify-projection-ui` ALL CHECKS PASSED (dark+light) |
| Live preview/cancel/confirm/repeat/stale/failed | ✅ real DOM, verified live |
| Lifecycle gate (token canvas A → canvas B → confirm rejected) | ✅ live-gated, applies nothing |
| UI screenshots in `artifacts/` | ✅ `archify-projection-ui-{dark,light}.png` via `verify:ui` |
| React preview/confirm overlay UI | ✅ built + live-proven |
| Receipt state-machine UI actions | ⏳ not wired into chat receipt yet |
| Live keyboard undo/redo proof | ✅ hard gate (merge + replace exact snapshots) |

Milestone status: **S6 core delivered (previewable, confirmable, single-undo, provenance-safe, main/renderer ownership
intact, content-complete identity, immutable source provenance), and the React preview/confirm overlay (S6.3) built and
live-proven end-to-end** through the real toolbar button + dialog (`--scenario=archify-projection-ui`, dark + light,
lifecycle gate included, screenshots in `artifacts/`). Round 17's P0 (content-blind `projectionId`),
P0/P1 (id-only stale fingerprint) and the two provenance P1s (sourceId lost on remap, connection id dropped,
global-evidence leak) are closed. Live keyboard Undo/Redo is proven as a hard gate (merge + replace exact
snapshots). Remaining open items are the S6.4 auto-re-preview for a stale Merge and the S6.8 chat receipt
state-machine actions — documented honestly rather than silently claimed.
