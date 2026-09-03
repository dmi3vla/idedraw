import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const PROJECT_CANVAS_FILE = 'architecture.excalidraw';
const MAX_CANVAS_BYTES = 50 * 1024 * 1024;
let generation = 0;
let session = null;

function fail(code, message) { return { ok: false, error: { code, message } }; }
function safeDocument(doc) {
  return !!doc && doc.type === 'excalidraw' && Array.isArray(doc.elements) && (!doc.appState || typeof doc.appState === 'object') && (!doc.files || typeof doc.files === 'object');
}
function canvasPath(root) { return path.join(root, PROJECT_CANVAS_FILE); }
function projectId(root) { return 'project-' + createHash('sha256').update(root).digest('hex').slice(0, 16); }
export function projectDocumentSnapshot(document) {
  if (!safeDocument(document)) return null;
  return createHash('sha256').update(JSON.stringify(document)).digest('hex');
}

function readCandidate(file) {
  const st = lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink()) throw Object.assign(new Error('Canvas must be a regular file.'), { code: 'INVALID_CANVAS_FILE' });
  if (st.size > MAX_CANVAS_BYTES) throw Object.assign(new Error('Canvas exceeds 50 MB.'), { code: 'CANVAS_TOO_LARGE' });
  const document = JSON.parse(readFileSync(file, 'utf8'));
  if (!safeDocument(document)) throw Object.assign(new Error('Invalid Excalidraw document shape.'), { code: 'INVALID_EXCALIDRAW_FILE' });
  return document;
}

// A crash can happen after the fully validated .tmp is written but before the
// atomic rename. Recover only when the canonical file is absent. If both exist,
// the canonical file is authoritative and the stale temp is removed.
function recoverInterruptedSave(file) {
  const temp = file + '.tmp';
  if (!existsSync(temp)) return { recovered: false };
  if (existsSync(file)) {
    try { unlinkSync(temp); } catch {}
    return { recovered: false };
  }
  try {
    readCandidate(temp);
    renameSync(temp, file);
    return { recovered: true };
  } catch {
    try { unlinkSync(temp); } catch {}
    return { recovered: false };
  }
}

export function openProjectCanvas(root) {
  let real;
  try { real = realpathSync(root); } catch { return fail('BAD_ROOT', 'Project directory is not readable.'); }
  const file = canvasPath(real);
  const recovery = recoverInterruptedSave(file);
  let document = null;
  let canvasExists = false;
  if (!existsSync(file)) {
    generation += 1;
    session = { root: real, generation, projectId: projectId(real), projectName: path.basename(real) };
    return { ok: true, data: { ...publicSession(), canvasExists: false, document: null, canvasSnapshot: null } };
  }
  try {
    document = readCandidate(file);
    canvasExists = true;
  } catch (e) { return fail(e.code || 'INVALID_EXCALIDRAW_FILE', e.message || String(e)); }
  // Commit only after the entire candidate document has passed validation.
  // A bad project must leave the previous session/generation untouched.
  generation += 1;
  session = { root: real, generation, projectId: projectId(real), projectName: path.basename(real) };
  return { ok: true, data: { ...publicSession(), canvasExists, document, canvasSnapshot: projectDocumentSnapshot(document), recoveredAutosave: recovery.recovered } };
}

export function publicSession() {
  return session ? { linked: true, generation: session.generation, projectId: session.projectId, projectName: session.projectName, canvasFileName: PROJECT_CANVAS_FILE } : { linked: false };
}

export function saveProjectCanvas({ generation: expectedGeneration, document } = {}) {
  if (!session) return fail('NOT_LINKED', 'No project is open.');
  if (expectedGeneration !== session.generation) return fail('STALE_PROJECT', 'Project changed before save.');
  if (!safeDocument(document)) return fail('INVALID_EXCALIDRAW_FILE', 'Refusing to save an invalid Excalidraw document.');
  const json = JSON.stringify(document, null, 2) + '\n';
  if (Buffer.byteLength(json) > MAX_CANVAS_BYTES) return fail('CANVAS_TOO_LARGE', 'Canvas exceeds 50 MB.');
  const target = canvasPath(session.root);
  const temp = target + '.tmp';
  try {
    writeFileSync(temp, json, { encoding: 'utf8', mode: 0o600 });
    const check = JSON.parse(readFileSync(temp, 'utf8'));
    if (!safeDocument(check)) throw new Error('Temporary canvas validation failed.');
    renameSync(temp, target);
    return { ok: true, data: { ...publicSession(), saved: true, bytes: Buffer.byteLength(json), canvasSnapshot: projectDocumentSnapshot(check) } };
  } catch (e) {
    try { if (existsSync(temp)) unlinkSync(temp); } catch {}
    return fail('SAVE_FAILED', e.message || String(e));
  }
}

export function closeProjectCanvas() { generation += 1; session = null; return { ok: true, data: publicSession() }; }
export function _resetProjectCanvasForTest() { generation = 0; session = null; }
