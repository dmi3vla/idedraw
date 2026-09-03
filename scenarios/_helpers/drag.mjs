// Moved out of main.mjs: shared acceptance gesture, not production code.
// Drags a node with real pointer events and reports whether the bound arrow
// followed. sendInputEvent lives in main, the aim comes from the renderer via
// the package's own sceneCoordsToViewportCoords (window.__canvasRaw__), and the
// window must hold focus or Excalidraw ignores the events.



export async function runArrowRerouteDrag({ win, nodeId, arrowId, dy }) {
  win.focus();
  win.webContents.focus();
  await new Promise((r) => setTimeout(r, 400));

  const target = await win.webContents.executeJavaScript(`(() => {
    const raw = window.__canvasRaw__;
    const n = raw.elements().find((el) => el.id === ${JSON.stringify(nodeId)});
    const a = raw.elements().find((el) => el.id === ${JSON.stringify(arrowId)});
    if (!n) return { fatal: 'node ' + ${JSON.stringify(nodeId)} + ' not in scene' };
    if (!a) return { fatal: 'arrow ' + ${JSON.stringify(arrowId)} + ' not in scene' };
    const from = raw.sceneToViewport(n.x + n.width / 2, n.y + n.height / 2);
    const to = raw.sceneToViewport(n.x + n.width / 2, n.y + n.height / 2 + ${dy});
    const label = raw.elements().find((el) => el.id === ${JSON.stringify(nodeId.replace('node-', 'text-'))});
    return {
      from: { x: Math.round(from.x), y: Math.round(from.y) },
      to: { x: Math.round(to.x), y: Math.round(to.y) },
      nodeBefore: { x: n.x, y: n.y },
      labelBefore: label ? { x: label.x, y: label.y } : null,
      arrowGeomBefore: { x: a.x, y: a.y, w: a.width, h: a.height },
      arrowVersionBefore: a.version,
    };
  })()`);
  if (target.fatal) return { fatal: target.fatal };

  const send = (type, x, y) =>
    win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1, modifiers: [] });

  send('mouseMove', target.from.x, target.from.y);
  await new Promise((r) => setTimeout(r, 120));
  send('mouseDown', target.from.x, target.from.y);
  await new Promise((r) => setTimeout(r, 150));
  const selectedOnPointerDown = (await win.webContents.executeJavaScript(
    `window.__canvasRaw__.selectedIds()`
  ))[0] || null;

  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    send(
      'mouseMove',
      Math.round(target.from.x + ((target.to.x - target.from.x) * i) / steps),
      Math.round(target.from.y + ((target.to.y - target.from.y) * i) / steps)
    );
    await new Promise((r) => setTimeout(r, 40));
  }
  send('mouseUp', target.to.x, target.to.y);
  await new Promise((r) => setTimeout(r, 600));

  const after = await win.webContents.executeJavaScript(`(() => {
    const raw = window.__canvasRaw__;
    const n = raw.elements().find((el) => el.id === ${JSON.stringify(nodeId)});
    const a = raw.elements().find((el) => el.id === ${JSON.stringify(arrowId)});
    const label = raw.elements().find((el) => el.id === ${JSON.stringify(nodeId.replace('node-', 'text-'))});
    return {
      nodeAfter: { x: n.x, y: n.y },
      labelAfter: label ? { x: label.x, y: label.y } : null,
      arrowGeomAfter: { x: a.x, y: a.y, w: a.width, h: a.height },
      arrowVersionAfter: a.version,
    };
  })()`);

  // Put the node back so the acceptance screenshot still matches the archify
  // reference layout (the drag is a probe, not part of the expected result).
  await win.webContents.executeJavaScript(`
    window.__bridge__.use_command('canvas.updateNode', {
      id: ${JSON.stringify(nodeId)},
      patch: { x: ${target.nodeBefore.x}, y: ${target.nodeBefore.y} },
    });
  `);

  const label = after.labelAfter;
  return {
    ...target,
    ...after,
    selectedOnPointerDown,
    nodeMovedBy: after.nodeAfter.y - target.nodeBefore.y,
    labelMovedBy: label && target.labelBefore ? label.y - target.labelBefore.y : null,
    arrowVersionChanged: after.arrowVersionAfter !== target.arrowVersionBefore,
    arrowGeomChanged: JSON.stringify(after.arrowGeomAfter) !== JSON.stringify(target.arrowGeomBefore),
  };
}
