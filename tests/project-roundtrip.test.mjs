import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os'; import path from 'node:path';
import { openProjectCanvas, saveProjectCanvas, closeProjectCanvas, projectDocumentSnapshot, _resetProjectCanvasForTest } from '../main/project/project-canvas-file.mjs';

test('open -> generate -> save -> restart -> reopen preserves exact document snapshot', () => {
  _resetProjectCanvasForTest(); const root = mkdtempSync(path.join(os.tmpdir(), 'canvas-roundtrip-'));
  const opened = openProjectCanvas(root); assert.equal(opened.ok, true);
  const document = { type:'excalidraw', version:2, source:'roundtrip', elements:[
    { id:'node-web', type:'rectangle', x:10, y:20, width:120, height:60, customData:{ archify:{ sourceElementId:'web', astAnchor:{ componentId:'web', own:['src/web.ts'] } } } },
  ], appState:{ viewBackgroundColor:'#fff', gridSize:null }, files:{ image1:{ id:'image1', dataURL:'data:image/png;base64,AA==', mimeType:'image/png' } } };
  const expected = projectDocumentSnapshot(document);
  const saved = saveProjectCanvas({ generation: opened.data.generation, document });
  assert.equal(saved.ok, true); assert.equal(saved.data.canvasSnapshot, expected);
  closeProjectCanvas();
  const reopened = openProjectCanvas(root); assert.equal(reopened.ok, true);
  assert.equal(reopened.data.canvasSnapshot, expected); assert.deepEqual(reopened.data.document, document);
  assert.equal(reopened.data.document.elements[0].customData.archify.astAnchor.componentId, 'web');
  assert.deepEqual(Object.keys(reopened.data.document.files), ['image1']);
});
