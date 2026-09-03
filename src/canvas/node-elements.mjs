// Pure element construction for archify-derived nodes. Kept free of any
// @excalidraw/excalidraw import on purpose: this module is importable from plain
// Node (unit tests) without dragging in the Excalidraw package and its
// transitive JSON dependencies. The Excalidraw-bound adapter (adapter.mjs)
// re-imports buildNodeElements/baseElementProps from here.
//
// buildNodeElements returns EXCALIDRAW-READY SKELETONS: a single rectangle
// container carrying a `label` on the node. The adapter feeds these into the
// package's own `convertToExcalidrawElements`, which builds the rectangle <-> 
// bound-text pair through Excalidraw's real binding machinery
// (bindTextToContainer -> redrawTextBoundingBox -> computeBoundTextPosition).
// That is what guarantees a VALID binding: the text is born at Excalidraw's
// canonical centred position and stays there on every recompute, instead of
// silently sinking below the container as a hand-built (containerId +
// boundElements) pair did. This module deliberately stays data-only so the
// skeleton contract is testable without Electron/Excalidraw.

export function baseElementProps() {
  return {
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: { type: 3 },
    seed: Math.floor(Math.random() * 2 ** 31),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
  };
}

export function buildNodeElements({
  id,
  label,
  sublabel = null,
  renderedText = null, // S7/P2: pre-wrapped display text (explicit newlines)
  x = 100,
  y = 100,
  width = 180,
  height = 90,
  frameId = null,
  meta = null,
}) {
  const rectId = `node-${id}`;
  const textId = `text-${id}`;
  const customData = { projectNodeId: id, ...(meta ? { archify: meta } : {}) };
  const hasSub = typeof sublabel === 'string' && sublabel.length > 0;
  // Review decision: for the first correct variant, merge the main label and the
  // file path sublabel into ONE two-line bound text (single font size). Mixed
  // typography (code-font path) is deferred; separate a sublabel only after the
  // drag/interaction model is proven with a proper bound label.
  // S7/P2: when the import already wrapped an extreme label (or sublabel) across
  // lines, prefer that explicit multi-line text so the box grows vertically
  // instead of clipping horizontally. Absent a pre-wrapped string the original
  // two-line merge is used.
  const fullLabel = typeof renderedText === 'string' && renderedText
    ? renderedText
    : (hasSub ? `${label}\n${sublabel}` : label);
  return [
    {
      type: 'rectangle',
      id: rectId,
      x,
      y,
      width,
      height,
      angle: 0,
      frameId,
      locked: false,
      backgroundColor: 'transparent',
      strokeColor: '#1e1e1e',
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roundness: { type: 3 },
      customData,
      // Excalidraw's own container label. These props are forwarded into the
      // bound text element it creates (id/frameId/customData keep our stable,
      // bridge-addressed identifiers; text is the two-line label).
      label: {
        id: textId,
        text: fullLabel,
        fontSize: 16,
        fontFamily: 1,
        textAlign: 'center',
        verticalAlign: 'middle',
        frameId,
        customData,
      },
    },
  ];
}
