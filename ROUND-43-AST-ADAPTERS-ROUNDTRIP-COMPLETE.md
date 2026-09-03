# Round 43 — AST adapters + project round-trip complete

## Implemented

- Main-owned JavaScript/TypeScript/JSX/TSX adapter with comment/string masking, stable symbol IDs, exact source offsets and declaration ranges.
- Separate PHP adapter for classes, interfaces, traits, enums, functions and methods, with the same stable range contract.
- Explicit unsupported-language result with no source content.
- Anchored graph version 2 uses adapters only for the bounded files already selected by the component-local anchor; no root scan and no content crosses IPC.
- JS/PHP relative dependency resolution remains bounded to the selected anchor.
- Canonical Excalidraw document SHA-256 snapshots on save and reopen.
- Exact open → generate/document → save → close/restart → reopen proof, including AST-anchor persistence and binary-file-map preservation.

## Verification

```text
node --check                         green
npm test                             269 total / 263 pass / 0 fail / 6 optional CLI skips
node smoke-test.mjs --source         ALL STRUCTURAL CHECKS PASSED
secret scan                          0 matches
```

## Next agent: polish only

1. Run build and Electron dark/light gates on a machine with installed dependencies.
2. Visually tune pinned width, narrow-window spacing, graph density and symbol selection.
3. Optionally replace the dependency-free graph list with React Flow/dagre when network/dependencies are available; do not change the anchor/IPC/privacy contract.
4. Add more parser fixtures for decorators, anonymous/default exports, PHP attributes and malformed partial files.
