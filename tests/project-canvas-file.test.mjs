import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openProjectCanvas, saveProjectCanvas, closeProjectCanvas, publicSession, PROJECT_CANVAS_FILE, _resetProjectCanvasForTest } from '../main/project/project-canvas-file.mjs';

const doc = (id='a') => ({ type:'excalidraw', version:2, source:'test', elements:[{id,type:'rectangle'}], appState:{}, files:{} });

test('new project opens empty and atomically saves canonical architecture.excalidraw', () => {
  _resetProjectCanvasForTest();
  const root=mkdtempSync(path.join(os.tmpdir(),'canvas-project-'));
  const opened=openProjectCanvas(root);
  assert.equal(opened.ok,true); assert.equal(opened.data.canvasExists,false);
  const saved=saveProjectCanvas({generation:opened.data.generation,document:doc()});
  assert.equal(saved.ok,true);
  const file=path.join(root,PROJECT_CANVAS_FILE);
  assert.equal(existsSync(file),true); assert.equal(existsSync(file+'.tmp'),false);
  assert.equal(JSON.parse(readFileSync(file,'utf8')).type,'excalidraw');
});

test('existing canonical canvas is validated and returned on reopen', () => {
  _resetProjectCanvasForTest(); const root=mkdtempSync(path.join(os.tmpdir(),'canvas-project-'));
  writeFileSync(path.join(root,PROJECT_CANVAS_FILE),JSON.stringify(doc('persisted')));
  const opened=openProjectCanvas(root); assert.equal(opened.ok,true); assert.equal(opened.data.canvasExists,true); assert.equal(opened.data.document.elements[0].id,'persisted');
});

test('stale generation cannot save into a newly opened project', () => {
  _resetProjectCanvasForTest(); const a=mkdtempSync(path.join(os.tmpdir(),'canvas-a-')); const b=mkdtempSync(path.join(os.tmpdir(),'canvas-b-'));
  const old=openProjectCanvas(a); openProjectCanvas(b);
  const saved=saveProjectCanvas({generation:old.data.generation,document:doc()}); assert.equal(saved.ok,false); assert.equal(saved.error.code,'STALE_PROJECT');
});

test('invalid and symlink canvas files are refused', () => {
  _resetProjectCanvasForTest(); const root=mkdtempSync(path.join(os.tmpdir(),'canvas-project-'));
  writeFileSync(path.join(root,PROJECT_CANVAS_FILE),'{bad'); assert.equal(openProjectCanvas(root).error.code,'INVALID_EXCALIDRAW_FILE');
  const root2=mkdtempSync(path.join(os.tmpdir(),'canvas-project-')); const outside=path.join(root,'outside.excalidraw'); writeFileSync(outside,JSON.stringify(doc())); symlinkSync(outside,path.join(root2,PROJECT_CANVAS_FILE));
  assert.equal(openProjectCanvas(root2).error.code,'INVALID_CANVAS_FILE');
});

test('failed project open is transactional and preserves prior session generation', () => {
  _resetProjectCanvasForTest();
  const good=mkdtempSync(path.join(os.tmpdir(),'canvas-good-'));
  const bad=mkdtempSync(path.join(os.tmpdir(),'canvas-bad-'));
  const opened=openProjectCanvas(good);
  writeFileSync(path.join(bad,PROJECT_CANVAS_FILE),'{broken');
  const failed=openProjectCanvas(bad);
  assert.equal(failed.ok,false);
  assert.deepEqual(publicSession(), { linked:true, generation:opened.data.generation, projectId:opened.data.projectId, projectName:opened.data.projectName, canvasFileName:PROJECT_CANVAS_FILE });
  assert.equal(saveProjectCanvas({generation:opened.data.generation,document:doc('still-good')}).ok,true);
});

test('close invalidates the active project session', () => {
  _resetProjectCanvasForTest(); const root=mkdtempSync(path.join(os.tmpdir(),'canvas-project-')); const opened=openProjectCanvas(root); closeProjectCanvas();
  assert.equal(saveProjectCanvas({generation:opened.data.generation,document:doc()}).error.code,'NOT_LINKED');
});

test('open recovers a valid interrupted .tmp save when canonical file is absent', () => {
  _resetProjectCanvasForTest();
  const root=mkdtempSync(path.join(os.tmpdir(),'canvas-recover-'));
  const target=path.join(root,PROJECT_CANVAS_FILE);
  writeFileSync(target+'.tmp',JSON.stringify(doc('recovered')));
  const opened=openProjectCanvas(root);
  assert.equal(opened.ok,true);
  assert.equal(opened.data.recoveredAutosave,true);
  assert.equal(opened.data.document.elements[0].id,'recovered');
  assert.equal(existsSync(target),true);
  assert.equal(existsSync(target+'.tmp'),false);
});

test('open removes invalid orphan .tmp without creating a canvas', () => {
  _resetProjectCanvasForTest();
  const root=mkdtempSync(path.join(os.tmpdir(),'canvas-recover-'));
  const temp=path.join(root,PROJECT_CANVAS_FILE+'.tmp');
  writeFileSync(temp,'{broken');
  const opened=openProjectCanvas(root);
  assert.equal(opened.ok,true);
  assert.equal(opened.data.canvasExists,false);
  assert.equal(existsSync(temp),false);
});

test('canonical canvas wins over and cleans a stale .tmp', () => {
  _resetProjectCanvasForTest();
  const root=mkdtempSync(path.join(os.tmpdir(),'canvas-recover-'));
  const target=path.join(root,PROJECT_CANVAS_FILE);
  writeFileSync(target,JSON.stringify(doc('canonical')));
  writeFileSync(target+'.tmp',JSON.stringify(doc('stale')));
  const opened=openProjectCanvas(root);
  assert.equal(opened.ok,true);
  assert.equal(opened.data.document.elements[0].id,'canonical');
  assert.equal(opened.data.recoveredAutosave,false);
  assert.equal(existsSync(target+'.tmp'),false);
});
