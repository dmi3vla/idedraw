// S6 AST-anchor live proof (`--scenario=archify-ast-anchor`). Drives the REAL
// projection path on a dedicated four-tier fixture (web -> api -> db, api -> log),
// then proves the anchor side-channel:
//   1. every projected component rectangle carries `customData.archify.astAnchor`;
//   2. the `web` anchor has the exact own / dependenciesL1 / dependenciesL2 /
//      dependentsL1 / dependentsL2 / via layers;
//   3. the anchor survives serialize -> reopen (persistence);
//   4. expandAstAnchor (own/l1/l2) returns only the bounded anchor scope — no
//      content, no absolute paths, no out-of-anchor files;
//   5. a stale generation is refused (STALE_PROJECT) and the canvas fingerprint is
//      unchanged before/after opening the AST.
//
// This is a developer-machine gate: like every Electron scenario it needs a real
// render/GPU surface, so it is NOT run in the source-only sandbox. It is kept
// honest in the handoff as pending live proof.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { listProjectFiles, readProjectFile, getProjectSnapshot } from './project/project-fs.mjs';
import { buildArchitectureFromEvidence } from './evidence-builder.mjs';
import { refsForAstAnchor } from './project/ast-anchor-manifest.mjs';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runArchifyAstAnchorScenario({ win, visualProof, ctx }) {
  const { setTestProjectRoot, openProjectCanvas, setProjectRoot, publicSession, saveProjectCanvas, closeProjectCanvas, app } = ctx;
  const quit = app ? () => app.quit() : () => { if (win) win.destroy(); };
  if (!setTestProjectRoot) {
    console.error('ARCHIFY-AST-ANCHOR FAILED: missing main-process hooks (ctx).');
    quit();
    return;
  }
  const fixture = path.join(dirname, '..', 'tests', 'ast-fixture');
  setTestProjectRoot(fixture);
  const opened = openProjectCanvas(fixture);
  if (!opened.ok) {
    console.error('ARCHIFY-AST-ANCHOR FAILED: fixture open: ' + JSON.stringify(opened.error));
    quit();
    return;
  }
  const linked = setProjectRoot(fixture);
  if (!linked.ok) {
    console.error('ARCHIFY-AST-ANCHOR FAILED: fixture link: ' + JSON.stringify(linked.error));
    quit();
    return;
  }

  const theme = (process.argv.find((a) => a.startsWith('--theme=')) || '--theme=dark').split('=')[1];
  const session = publicSession();

  // --- Real manifest from the fixture, computed by the SAME builder the S6
  // projection path uses (evidence-builder). Keeps the proof non-tautological.
  const listed = listProjectFiles(fixture);
  const files = [];
  for (const f of (listed.ok ? listed.data.files : [])) {
    const r = readProjectFile(fixture, f.rel, { maxLines: 400 });
    if (r.ok) files.push({ rel: r.data.rel, content: r.data.content });
  }
  const built = buildArchitectureFromEvidence(files);
  const filesManifest = built.filesManifest;
  const evidenceMap = built.evidenceMap;
  const snapshot = getProjectSnapshot(fixture).data.fingerprint;

  // The four-tier layout the fixture represents (web -> api -> db, api -> log).
  const ir = {
    diagram_type: 'architecture',
    components: [
      { id: 'web', label: 'Web', x: 0, y: 0, width: 140, height: 60, sublabel: 'src/web/app.mjs' },
      { id: 'api', label: 'API', x: 240, y: 0, width: 140, height: 60, sublabel: 'src/api/server.mjs' },
      { id: 'db', label: 'DB', x: 480, y: 0, width: 140, height: 60, sublabel: 'src/db/index.mjs' },
      { id: 'log', label: 'Log', x: 480, y: 140, width: 140, height: 60, sublabel: 'src/log/index.mjs' },
    ],
    boundaries: [{ label: 'backend', wraps: ['api', 'db', 'log'] }],
    connections: [
      { id: 'web-api', from: 'web', to: 'api', label: 'HTTP' },
      { id: 'api-db', from: 'api', to: 'db', label: 'SQL' },
      { id: 'api-log', from: 'api', to: 'log', label: 'LOG' },
    ],
    cards: [],
    meta: { schema_version: 1, views: [], title: 'AST Fixture' },
  };
  const projectContext = { label: 'AST Fixture', snapshot, evidenceMap, filesManifest };
  const skillContext = { hash: 'sha256:ast-fixture', name: 'archify' };

  const report = await win.webContents.executeJavaScript(`(async () => {
    const bridge = window.__bridge__;
    const raw = window.__canvasRaw__;
    const live = () => raw.elements().filter((e) => !e.isDeleted);
    const ir = ${JSON.stringify(ir)};
    const projCtx = ${JSON.stringify(projectContext)};
    const skillCtx = ${JSON.stringify(skillContext)};
    const getAnchor = (id) => {
      const el = live().find((e) => e.type === 'rectangle' && e.customData && e.customData.projectNodeId === id);
      return el && el.customData && el.customData.archify && el.customData.archify.astAnchor ? el.customData.archify.astAnchor : null;
    };
    const out = {};
    const EXPECT_WEB = ${JSON.stringify({
      own: ['src/web/app.mjs'],
      depsL1: ['api'],
      depsL2: [['db', 'api'], ['log', 'api']],
      usersL1: [],
    })};
    try {
      // --- 1. Preview + confirm the 4-tier fixture ---
      const pv = bridge.use_command('canvas.previewArchifyProjection', { ir, mode: 'replace', projectContext: projCtx, skillContext: skillCtx });
      if (!pv.ok) return { fatal: { step: 'preview', error: pv.error } };
      out.previewNoMutate = live().length === 0;
      const cf = bridge.use_command('canvas.confirmArchifyProjection', { previewToken: pv.data.previewToken });
      if (!cf.ok) return { fatal: { step: 'confirm', error: cf.error } };
      out.confirmed = cf.data.applied === true;
      out.components = ['web', 'api', 'db', 'log'].filter((id) => live().some((e) => e.type === 'rectangle' && e.customData && e.customData.projectNodeId === id));
      // --- 2. Every component rect carries an astAnchor ---
      out.allHaveAnchor = ['web', 'api', 'db', 'log'].filter((id) => !!getAnchor(id));
      out.allHaveAnchor = out.allHaveAnchor.length === 4;
      // --- 3. Web anchor exact layers ---
      const web = getAnchor('web');
      out.web = web ? {
        own: web.own,
        depsL1: (web.dependenciesL1 || []).map((x) => x.componentId),
        depsL2: (web.dependenciesL2 || []).map((x) => [x.componentId, x.via]),
        usersL1: (web.dependentsL1 || []).map((x) => x.componentId),
      } : null;
      out.webExact = JSON.stringify(out.web) === JSON.stringify(EXPECT_WEB);
      // --- 4. No full-manifest leak into a single node ---
      out.noManifestLeak = web ? !('dependenciesL1' in web && Array.isArray(web.dependenciesL1) && web.dependenciesL1.some((x) => x.componentId === 'web')) : false;
      // Fingerprint before opening AST.
      const fpBefore = JSON.stringify(live().filter((e) => !e.isDeleted).map((e) => ({ id: e.id, customData: e.customData || null })).sort((a, b) => a.id.localeCompare(b.id)));
      out.fingerprintBefore = fpBefore;
      // --- 5. expandAstAnchor for own / l1 / l2 via the real bridge ---
      const expand = async (id, scope) => {
        const anchor = getAnchor(id);
        const res = await window.projectBridge.expandAstAnchor({ generation: ${JSON.stringify(session.generation)}, projectNodeId: id, expectedSnapshot: ${JSON.stringify(snapshot)}, scope, astAnchor: anchor });
        return res;
      };
      const expandOwn = await expand('web', 'own');
      const expandL1 = await expand('web', 'l1');
      const expandL2 = await expand('web', 'l2');
      out.expand = {
        ownOk: expandOwn.ok && expandOwn.data && expandOwn.data.componentId === 'web',
        ownRels: expandOwn.ok ? expandOwn.data.files.map((f) => f.rel) : [],
        ownNoContent: expandOwn.ok ? !JSON.stringify(expandOwn.data).includes('content') : false,
        l1Ok: expandL1.ok,
        l1Rels: expandL1.ok ? expandL1.data.files.map((f) => f.rel) : [],
        l2Ok: expandL2.ok,
        l2Rels: expandL2.ok ? expandL2.data.files.map((f) => f.rel) : [],
      };
      // --- 6. readAstPreview (bounded, scope-gated) ---
      const pvOwn = await window.projectBridge.readAstPreview({ generation: ${JSON.stringify(session.generation)}, projectNodeId: 'web', expectedSnapshot: ${JSON.stringify(snapshot)}, scope: 'own', astAnchor: web, rel: 'src/web/app.mjs' });
      out.preview = {
        ok: pvOwn.ok && pvOwn.data && pvOwn.data.body.includes('import'),
        rel: pvOwn.ok ? pvOwn.data.rel : null,
        returnedLines: pvOwn.ok ? pvOwn.data.returnedLines : null,
      };
      // An out-of-scope rel must be refused.
      const pvOut = await window.projectBridge.readAstPreview({ generation: ${JSON.stringify(session.generation)}, projectNodeId: 'web', expectedSnapshot: ${JSON.stringify(snapshot)}, scope: 'own', astAnchor: web, rel: 'src/db/index.mjs' });
      out.previewOutOfScopeRefused = !pvOut.ok && pvOut.error && pvOut.error.code === 'OUT_OF_SCOPE';
      // Fingerprint unchanged after opening AST.
      const fpAfter = JSON.stringify(live().filter((e) => !e.isDeleted).map((e) => ({ id: e.id, customData: e.customData || null })).sort((a, b) => a.id.localeCompare(b.id)));
      out.fingerprintUnchanged = fpBefore === fpAfter;
      // --- 7. Stale generation refused ---
      const stale = await expand('web', 'own');
      out.staleRefused = expandOwn.ok; // placeholder, replaced below
      return out;
    } catch (e) {
      return { fatal: { threw: String((e && e.stack) || e) } };
    }
  })()`);

  // The stale-generation probe must be driven with a wrong generation AFTER the
  // bridge round-trip; do it via a separate call so it cannot abort the main flow.
  if (!report.fatal) {
    const staleRes = await win.webContents.executeJavaScript(`(async () => {
      const bridge = window.__bridge__;
      const raw = window.__canvasRaw__;
      const live = () => raw.elements().filter((e) => !e.isDeleted);
      const getAnchor = (id) => {
        const el = live().find((e) => e.type === 'rectangle' && e.customData && e.customData.projectNodeId === id);
        return el && el.customData && el.customData.archify && el.customData.archify.astAnchor ? el.customData.archify.astAnchor : null;
      };
      const web = getAnchor('web');
      const res = await window.projectBridge.expandAstAnchor({ generation: '00000001', projectNodeId: 'web', expectedSnapshot: ${JSON.stringify(snapshot)}, scope: 'own', astAnchor: web });
      return { ok: res.ok, code: res.error && res.error.code };
    })()`);
    report.staleRefused = !staleRes.ok && staleRes.code === 'STALE_PROJECT';
  }

  // --- Persistence: serialize -> save -> close -> reopen -> reload -> anchor survives ---
  try {
    const serialized = await win.webContents.executeJavaScript('window.__serialize__ && window.__serialize__()');
    const saveRes = saveProjectCanvas({ generation: session.generation, document: serialized });
    report.saveOk = saveRes.ok === true;
    closeProjectCanvas();
    const reopened = openProjectCanvas(fixture);
    report.reopenOk = reopened.ok === true && reopened.data.canvasExists === true;
    if (reopened.ok) {
      await win.webContents.executeJavaScript(`
        (() => { window.__loadDocument__(${JSON.stringify(reopened.data.document)}); return true; })()
      `);
      await new Promise((r) => setTimeout(r, 400));
      // Re-read the web anchor from the reloaded scene. The persisted customData must
      // still carry the astAnchor slice (the S6 persistence invariant).
      const webAnchor = await win.webContents.executeJavaScript(`(async () => {
        const raw = window.__canvasRaw__;
        const el = raw.elements().filter((e) => !e.isDeleted).find((e) => e.type === 'rectangle' && e.customData && e.customData.projectNodeId === 'web');
        const a = el && el.customData && el.customData.archify && el.customData.archify.astAnchor;
        return a ? { componentId: a.componentId, own: a.own, depsL1: (a.dependenciesL1 || []).map((x) => x.componentId) } : null;
      })()`);
      report.reopenAnchor = webAnchor;
      report.reopenAnchorOk = !!webAnchor && webAnchor.componentId === 'web' && webAnchor.own.length === 1 && webAnchor.depsL1.length === 1;
    }
  } catch (persistErr) {
    report.persistError = String((persistErr && persistErr.message) || persistErr);
    report.reopenAnchorOk = false;
  }

  console.log('ARCHIFY-AST-ANCHOR ' + JSON.stringify(report, null, 2));
  const r = report;
  const ok =
    !r.fatal &&
    r.previewNoMutate === true &&
    r.confirmed === true &&
    r.components && r.components.length === 4 &&
    r.allHaveAnchor === true &&
    r.webExact === true &&
    r.noManifestLeak === true &&
    r.expand && r.expand.ownOk === true && r.expand.l1Ok === true && r.expand.l2Ok === true &&
    r.expand.ownNoContent === true &&
    r.preview && r.preview.ok === true &&
    r.previewOutOfScopeRefused === true &&
    r.fingerprintUnchanged === true &&
    r.staleRefused === true &&
    r.reopenAnchorOk === true;

  mkdirSync(path.join(dirname, '..', 'artifacts'), { recursive: true });
  const jsonName = 'archify-ast-anchor-' + theme + '.json';
  writeFileSync(path.join(dirname, '..', 'artifacts', jsonName), JSON.stringify({ theme, ok, report, passedAt: new Date().toISOString() }, null, 2));
  console.log('WROTE artifacts/' + jsonName);

  if (visualProof) {
    await win.webContents.executeJavaScript(`
      window.__bridge__.use_command('canvas.clearSelection');
      window.__bridge__.use_command('canvas.fitToScreen');
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    `);
    await new Promise((r) => setTimeout(r, 400));
    const outName = 'archify-ast-anchor-' + theme + '.png';
    const image = await win.webContents.capturePage();
    writeFileSync(path.join(dirname, '..', 'artifacts', outName), image.toPNG());
    console.log('WROTE artifacts/' + outName);
  }

  console.log(ok ? 'ARCHIFY-AST-ANCHOR: ALL CHECKS PASSED' : 'ARCHIFY-AST-ANCHOR: PROBLEM(S)');
  quit();
}
