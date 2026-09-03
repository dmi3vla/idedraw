import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const renderer = readFileSync(path.join(root, 'src/renderer-entry.jsx'), 'utf8');
const overlay = readFileSync(path.join(root, 'src/canvas/archify-projection-overlay.jsx'), 'utf8');
const mount = readFileSync(path.join(root, 'src/canvas/mount.jsx'), 'utf8');

test('toolbar uses validate -> preview -> React overlay, never one-shot import', () => {
  assert.ok(renderer.includes('window.archifyBridge.validate(status.specPath)'));
  assert.ok(renderer.includes("bridge.use_command('canvas.previewArchifyProjection'"));
  assert.ok(renderer.includes('showArchifyProjectionPreview({'));
  assert.ok(!renderer.includes("bridge.use_command('canvas.runArchifyImport'"));
});

test('overlay confirms and cancels only by opaque previewToken', () => {
  assert.ok(overlay.includes('model.preview.previewToken'));
  assert.ok(renderer.includes("canvas.confirmArchifyProjection', { previewToken }"));
  assert.ok(renderer.includes("canvas.cancelArchifyProjection', { previewToken }"));
  assert.ok(!overlay.includes('projectionId:'));
});

test('overlay can regenerate by consuming the old token and publishing a fresh preview', () => {
  assert.ok(overlay.includes("run('regenerate')"));
  assert.ok(overlay.includes('Обновить'));
  assert.ok(overlay.includes('model.onRegenerate'));
  assert.ok(renderer.includes('onRegenerate: async (previewToken)'));
  assert.ok(renderer.includes("canvas.cancelArchifyProjection', { previewToken: replacePreviewToken }"));
  assert.ok(renderer.includes('generateArchifyPreview({ replacePreviewToken: previewToken })'));
  const cancelAt = renderer.indexOf("canvas.cancelArchifyProjection', { previewToken: replacePreviewToken }");
  const regenerateAt = renderer.indexOf('window.archifyBridge.generateProject(', cancelAt);
  assert.ok(cancelAt >= 0 && regenerateAt > cancelAt, 'old preview is cancelled before regeneration starts');
});

test('overlay is React-mounted, accessible, and guards double submit', () => {
  assert.ok(mount.includes('<ArchifyProjectionOverlay />'));
  assert.ok(overlay.includes('role="dialog"'));
  assert.ok(overlay.includes('aria-modal="true"'));
  assert.ok(overlay.includes("if (!model || busy) return"));
  assert.ok(overlay.includes("terminal.receipt?.status === 'applied'"), 'repeat confirm exposes already_applied receipt');
});

test('terminal UI renders safe receipt fields, not raw plan payloads', () => {
  for (const field of ['mode', 'projectionId', 'sourceHash', 'projectSnapshot']) assert.ok(overlay.includes(field));
  assert.ok(!overlay.includes('evidenceMap'));
  assert.ok(!overlay.includes('preview.nodes'));
});
