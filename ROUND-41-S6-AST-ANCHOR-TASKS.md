# Round 41 rollback — S6 AST anchor integration handoff

## Base and intent

This branch deliberately starts from the supplied Round 41 archive, SHA-256:

`55ad8bfdf9ac221abe005f31c56998be98cbf0eb90459d5aa8a5290641ac4281`

It does not merge the Round 42–44 dock implementation. The goal is the earlier S6 design: when Archify aggregates files into a component, persist a bounded AST initialization anchor on that Excalidraw node, including its own files and one/two dependency layers. AST expansion then reads the prepared anchor instead of scanning the project.

The supplied `code-canvas-review.tar.gz` was used as the integration frame. Its unsafe standalone behavior (`buildGraph(root)` + recursive project walk + full source payload + React Flow scene ownership) was not copied. The reusable seam was adapted to a main-owned `buildAnchoredAstGraph({ anchor, scope, files })` that receives only files selected from the S6 anchor and returns compact metadata without source content.

## Implemented

### 1. Manifest at Archify aggregation time

New `main/project/ast-anchor-manifest.mjs`:

- builds deterministic component-local anchors from the existing `tierFiles` and resolved `connections`;
- preserves edge direction:
  - `dependenciesL1` / `dependenciesL2` — outgoing imports;
  - `dependentsL1` / `dependentsL2` — incoming imports;
- L2 entries record `via`, the deterministic first-hop component;
- stores `own` files separately;
- caps own files, neighbor components, files per neighbor and total scope refs;
- provides `refsForAstAnchor(anchor, scope)` for `own | l1 | l2`.

`buildArchitectureFromEvidence()` now returns `filesManifest` beside the Archify candidate/evidence map. The manifest is not inserted into the strict Archify JSON schema.

### 2. Side-channel to Excalidraw provenance

The real-project generation result now carries:

```js
projectContext: {
  snapshot,
  evidenceMap,
  filesManifest
}
```

`buildArchifyProjectionPlan()`:

- sanitizes only anchors matching placed component source ids;
- includes the sanitized `anchorMap` in the content-complete source hash;
- returns `anchorMap` beside `evidenceMap`.

`applyProjectionPlan()` writes only the matching component-local slice to:

```js
customData.archify.astAnchor
```

The full all-component manifest is never copied into each node.

### 3. Sanitization

`sanitizeAstAnchor()` in `src/canvas/archify-provenance.mjs`:

- validates component ids;
- sanitizes every path through the existing S6 relative-path policy;
- drops absolute, traversal and unsafe paths;
- caps all arrays;
- keeps the object deterministic and serializable.

### 4. Code Canvas backend seam

New `main/project/ast-anchor-graph.mjs` adapts the supplied integration frame:

- accepts an anchor scope, not a root/entry point;
- never walks the project;
- filters even supplied file objects against the scope refs;
- derives compact file nodes, declaration summaries and import edges;
- never returns `content`.

New main-owned IPC:

```text
project:expandAstAnchor
```

Input:

```js
{
  generation,
  projectNodeId,
  expectedSnapshot,
  scope: "own" | "l1" | "l2",
  astAnchor
}
```

The handler:

- uses the main-owned project root;
- rejects stale generations and component/anchor mismatches;
- derives paths only with `refsForAstAnchor`;
- reads through the existing confined `readProjectFile` boundary;
- verifies project snapshot before/after;
- returns compact anchored graph + stale/partial/warning state.

Preload exposes only `projectBridge.expandAstAnchor(input)`; no root/path-bearing API was added.

## Tests

New `tests/ast-anchor-manifest.test.mjs` proves:

1. Exact own/dependencies/dependents L1/L2 sets.
2. Deterministic L2 `via` paths.
3. Scope expansion reads only anchor refs.
4. A supplied file outside the anchor is excluded from the Code Canvas graph.
5. Source content is absent from the response.
6. Projection persists only the local anchor slice.
7. Unsafe paths are removed.
8. IPC is generation/snapshot scoped and renderer cannot supply a root.

Updated the pre-existing production-generation source assertion so multiline `projectContext` remains covered and `filesManifest` is required.

Verification in review sandbox:

```text
node --check -> green
npm test -> 238 total / 232 pass / 0 fail / 6 optional CLI skips
node smoke-test.mjs --source -> ALL STRUCTURAL CHECKS PASSED
```

## What remains for the integration agent

### P0 — live proof of S6 persistence

1. Build on the developer machine.
2. Generate a real architecture from a fixture with at least `web -> api -> db` and an incoming dependent.
3. Confirm every generated component rectangle has `customData.archify.astAnchor`.
4. Confirm the node contains only its own slice, never `filesManifest.components` for the full project.
5. Save/reopen `architecture.excalidraw`; verify anchors survive serialization.
6. Confirm source hash changes when only an anchor changes.
7. Invoke `projectBridge.expandAstAnchor` for `own`, `l1`, `l2`; record exactly which files were read.
8. Assert every read is a subset of the matching anchor scope.
9. Change project files during expansion and prove `PROJECT_CHANGED`.
10. Switch projects and prove stale generation rejection.

### P1 — attach the Code Canvas UI frame

- Do not replace Excalidraw or mount React Flow as the application scene.
- Use a dock/tab/panel owned by the existing renderer.
- Feed it the compact `project:expandAstAnchor` result.
- Scope controls: `Узел`, `Связи L1`, `Связи L2`.
- Do not expose the frame's `Open Project` command or recursive root scan.
- Do not return full file content. Add a separate selected-file/symbol range endpoint later.
- Reuse Code Canvas card styling/layout ideas only; preserve Excalidraw as the main canvas owner.

### P2 — real parser adapters

The current graph seam uses a bounded JS/TS declaration/import fallback so the S6 contract is testable without new dependencies. Next:

1. Add parser adapter interface.
2. Port Babel parser walking from `code-canvas-review/electron/ast.js` for JS/TS.
3. Add PHP parser as an optional isolated adapter.
4. Add exact ranges/stable symbol ids.
5. Keep parser dependencies in main/worker only; never bundle them into the Excalidraw renderer.
6. Add worker timeout/cancellation/cache keyed by snapshot + file hash + parser version.

## Packaging gate for the next archive

- `npm ci && npm run build && npm test`.
- Live anchor persistence/reopen proof.
- Anchored scope read log with zero out-of-manifest reads.
- No root/full source in renderer response.
- Update report, package, verify clean extraction, SHA-256 and secret scan.
