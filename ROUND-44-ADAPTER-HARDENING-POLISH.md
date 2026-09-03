# Round 44 — adapter hardening + narrow-dock polish

## Implemented

- **PHP 8 attributes** masked as a bracket block (not a line comment) in `codeMask`, so `#[...]` no longer swallows the rest of the line and a same-line declaration is still found.
- **Anonymous / default exports** recorded under a stable synthetic `default` name: `export default function() {}`, `export default class {}`, `export default class extends Base {}`, `export default (x) => x`.
- **Named class guard**: negative lookahead so `class extends Base` is never misread as a class literally named `extends`.
- **Decorator coverage**: TS/JS decorators provably don't consume the decorated declaration.
- **Malformed-partial-file robustness**: truncated/empty/garbage inputs never throw across `.js/.tsx/.php`.
- **Narrow-dock CSS polish** in `ast-view.css`: file cards reflow at a 220px minimum; a `@container (max-width: 460px)` rule collapses to one column, wraps file headers and lets the pinned width behave on narrow docks. No anchor/IPC/privacy contract changed.

## Verification (this clean review sandbox)

```text
node --check                     green (main/project/ast-adapters.mjs, tests/ast-adapters.test.mjs, src/ast-view/ast-view.mjs …)
npm test                         275 total / 275 pass / 0 fail / 0 skip
npm run build                    OK
node smoke-test.mjs --source     ALL STRUCTURAL CHECKS PASSED
project diagnostics              no errors/warnings
npm run verify:ast-anchor        ALL CHECKS PASSED (dark + light, PNG + ok:true JSON)
npm run verify:ui                ALL CHECKS PASSED (dark + light)
npm run verify:pixel             ALL PASSED (dark + light, 11 nodes pad>=8)
```

## Files changed

- `main/project/ast-adapters.mjs` — attribute masking, anonymous/default-export capture, named-class guard.
- `tests/ast-adapters.test.mjs` — 6 new tests (decorators, anonymous/default exports, `extends` guard, PHP attributes, same-line attribute, malformed partial files).
- `src/ast-view/ast-view.css` — narrow-dock density/spacing.

## Next agent: optional / machine-dependent

1. Optional React Flow/dagre graph-list replacement — needs network + installed dependencies; do NOT change the anchor/IPC/privacy contract (`buildAnchoredAstGraph` still returns metadata-only, rootless, bounded).
2. Re-run the dark/light interaction proof on the developer machine with full installed dependencies.
3. When adding real parser fixtures for new languages/edge cases, extend `tests/ast-fixture/` and the four-tier AST-anchor acceptance scenario.
