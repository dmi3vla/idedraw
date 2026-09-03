// Moved verbatim out of main.mjs (step 1 of the main.mjs decomposition).
// Acceptance code must not sit next to production code, and must not be
// loaded into the production main process on every launch.
// S5.2 model-driven acceptance. Unlike runArchifyAuthoringScenario, which feeds a
// hardcoded candidate straight into IPC, this drives the REAL agent runtime with a
// NATURAL-LANGUAGE request and a scripted model adapter (a stand-in for the LLM):
// the model chooses tool_use calls (project evidence -> archify schema/example ->
// author -> repair -> done), which are routed through buildAgentRunContext and
// executeTurnTool the same way a live hold would be. It then projects the produced
// layout IR onto the live canvas (import is never a chat-reachable text), so the
// proof shows:  request -> project tools -> archify skill files -> author -> repair
// -> layout IR -> canvas.
//
// The repair is exercised by making the FIRST authored candidate deliberately
// invalid (invalid component `type`), so the CLI returns diagnostics and the model
// re-authors with the returned runToken — proving the bounded repair loop, not just
// the happy path.

import path from 'node:path';
import { APP_ROOT } from '../_helpers/paths.mjs';
import { app } from 'electron';
import { buildArchitectureFromEvidence } from '../../main/evidence-builder.mjs';
import { lastAuthorResult, lastCallResult, walkToolCalls } from '../../main/agent/conversation.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArchifyResult } from '../../main/archify-result.mjs';
import { planEvidenceReads, scriptedArchifyModel } from '../../main/agent-scripted-model.mjs';
import { setTestProjectRoot } from '../_helpers/project-root.mjs';

export async function run(ctx = {}) {
  const { win, visualProof, configStore, secretStore } = ctx;
  const { mode = 'full', theme = 'dark' } = ctx.argv || {};
  const __dirname = APP_ROOT;
  // MAIN-only test hooks (never exposed to the renderer): enable the archify skill
  // and point the read-only project root at the fixture project the agent studies.
  if (skillStoreInstance) skillStoreInstance.setEnabled('archify', true);
  setTestProjectRoot(path.join(__dirname, 'tests', 'fixture-project'));

  // Collect the renderer-side tool list using the SAME capability filter the chat
  // panel uses, so the model sees exactly what a real annotated turn would see.
  const rendererTools = await win.webContents.executeJavaScript(`(async () => {
    const bridge = window.__bridge__;
    const sb = window.skillsBridge;
    let enabled = [];
    try {
      const res = await sb.list();
      const rows = res && res.ok ? res.data : (res && res.data ? res.data : []);
      const skills = Array.isArray(rows) ? rows : (rows && rows.skills) || [];
      enabled = skills.filter((s) => s.enabled && s.status === 'ready').map((s) => s.name);
    } catch (e) {
      enabled = ['archify'];
    }
    return bridge.list_commands().data.commands
      .filter((c) => {
        if (c.notForChat) return false;
        if (c.requiresSkill && !enabled.includes(c.requiresSkill)) return false;
        return true;
      })
      .map((c) => ({ name: c.name, description: c.description, input_schema: c.inputSchema }));
  })()`);

  const conv = [
    { role: 'user', content: 'Изучи проект fixture-project и построй его архитектурную схему на холсте.' },
  ];
  const turnId = 'agent-' + Date.now();

  await runChatTurn(win.webContents, turnId, conv, rendererTools, configStore, secretStore, {
    modelFn: scriptedArchifyModel,
    requireKey: false,
  });

  // The agent stops after producing a valid layout IR. Extract the last successful
  // `archify.author` result from the conversation history (its success data carries
  // the IR and the opaque runToken).
  const authored = lastAuthorResult(conv);
  if (!authored || !authored.ir || !authored.runToken) {
    console.error('ARCHIFY-AGENT FAILED: no valid authored IR produced');
    app.quit();
    return;
  }

  // Reconstruct the tool flow before projection so the SAME repository reads that
  // caused authoring also provide per-component evidence provenance on the canvas.
  const flowCalls = walkToolCalls(conv);
  const projectionReadFiles = [];
  for (const c of flowCalls.filter((x) => x.name === 'project.readFile')) {
    const r = parseArchifyResult(c.resultText);
    if (r && r.ok && r.data && typeof r.data.content === 'string') {
      projectionReadFiles.push({ rel: r.data.rel, content: r.data.content });
    }
  }
  const projectionEvidence = buildArchitectureFromEvidence(projectionReadFiles);
  const receipt = await win.webContents.executeJavaScript('window.__lastRunReceipt__ || null');
  const projectionContext = {
    snapshot: receipt && receipt.projectSnapshotHash ? receipt.projectSnapshotHash : null,
    evidenceMap: projectionEvidence.evidenceMap,
  };
  const projectionSkillContext = { hash: authored.skillHash || null, name: 'archify' };

  // Production-shaped S6 path: preview the exact authored IR, then confirm that
  // preview by its opaque token. This replaces the legacy one-shot import in the
  // model-driven acceptance and proves evidence -> author -> preview -> confirm.
  const projected = await win.webContents.executeJavaScript(`(async () => {
    const bridge = window.__bridge__;
    const preview = bridge.use_command('canvas.previewArchifyProjection', {
      ir: ${JSON.stringify(authored.ir)},
      mode: 'replace',
      projectContext: ${JSON.stringify(projectionContext)},
      skillContext: ${JSON.stringify(projectionSkillContext)},
    });
    if (!preview || !preview.ok) return { ok: false, stage: 'preview', error: (preview && preview.error) || { code: 'ERR', message: 'unknown' } };
    const confirmed = bridge.use_command('canvas.confirmArchifyProjection', { previewToken: preview.data.previewToken });
    if (!confirmed || !confirmed.ok || !confirmed.data.applied) return { ok: false, stage: 'confirm', error: (confirmed && confirmed.error) || confirmed };
    const raw = window.__canvasRaw__;
    const all = raw.elements().filter((e) => !e.isDeleted);
    const rectangles = all.filter((e) => e.type === 'rectangle');
    const evidenceNodes = rectangles.filter((e) => e.customData && e.customData.archify && Array.isArray(e.customData.archify.evidenceRefs) && e.customData.archify.evidenceRefs.length > 0);
    const expectedEvidence = ${JSON.stringify(projectionContext.evidenceMap)};
    const evidenceMatches = rectangles.every((rect) => {
      const sourceId = rect.customData && rect.customData.archify && rect.customData.archify.sourceElementId;
      const actual = (rect.customData && rect.customData.archify && rect.customData.archify.evidenceRefs) || [];
      const expected = expectedEvidence[sourceId] || [];
      return JSON.stringify(actual) === JSON.stringify(expected);
    });
    return {
      ok: true,
      previewToken: preview.data.previewToken,
      projectionId: confirmed.data.projectionId,
      evidenceNodes: evidenceNodes.length,
      evidenceMatches,
      counts: {
        frames: all.filter((e) => e.type === 'frame').length,
        nodes: rectangles.length,
        arrows: all.filter((e) => e.type === 'arrow').length,
      },
    };
  })()`);

  // Reconstruct the tool flow the scripted model took, for the report.
  const flow = flowCalls.map((c) => c.name);
  const authorCalls = flowCalls.filter((c) => c.name === 'archify.author');
  const firstAuthor = authorCalls[0];
  const repaired = authorCalls.length >= 2 && !!authorCalls[1].input.runToken;
  const firstAuthorFailed = !!(firstAuthor && firstAuthor.resultText && parseArchifyResult(firstAuthor.resultText).ok === false);

  console.log('ARCHIFY-AGENT ' + JSON.stringify({
    flow,
    toolCount: flow.length,
    projectLinked: !!(receipt && receipt.projectLinked),
    modelAvailableCommands: receipt && receipt.modelAvailableCommands,
    authorAttempts: authorCalls.length,
    firstAuthorFailed,
    repaired,
    components: authored.ir.components.length,
    connections: authored.ir.connections.length,
    candidateHash: authored.candidateHash ? authored.candidateHash.slice(0, 12) : null,
    checks: authored.checks ? authored.checks.length : 0,
    projected: projected.ok ? { ...projected.counts, evidenceNodes: projected.evidenceNodes, evidenceMatches: projected.evidenceMatches, previewConfirmed: true } : projected.error,
  }, null, 2));

  if (visualProof) {
    await win.webContents.executeJavaScript(`
      window.__bridge__.use_command('canvas.clearSelection');
      window.__bridge__.use_command('canvas.fitToScreen');
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    `);
    await new Promise((r) => setTimeout(r, 400));
    mkdirSync(path.join(__dirname, 'artifacts'), { recursive: true });
    const outName = 'archify-agent-' + theme + '.png';
    const image = await win.webContents.capturePage();
    writeFileSync(path.join(__dirname, 'artifacts', outName), image.toPNG());
    console.log('WROTE artifacts/' + outName);
  }

  // Prove the authored IR is EVIDENCE-driven: reconstruct the set of source files
  // the agent actually READ, feed them through the same pure builder, and confirm
  // the authored components + connections match — so nothing was hardcoded or could
  // be satisfied by a hardcoded set of ids alone.
  //
  // Two INDEPENDENT checks guard against the builder being its own oracle:
  //   1. An explicit, hand-written expected fixture (web/api/db + web->api, api->db)
  //      is compared against the authored IR. This is NOT derived from the builder,
  //      so a builder bug (e.g. a false catalog/index + billing/index -> index merge)
  //      cannot satisfy it.
  //   2. The discovery PLAN (what the model intended to read) is reconstructed via
  //      planEvidenceReads and we assert every planned (and thus needed) file was
  //      actually read successfully AND no evidence read failed — replacing the old
  //      `evidenceRefs ⊆ readRels` tautology (evidenceRefs came FROM the reads).
  const readCalls = flowCalls.filter((c) => c.name === 'project.readFile');
  const readFiles = [];
  const readRels = new Set();
  let failedReads = 0;
  for (const c of readCalls) {
    const r = parseArchifyResult(c.resultText);
    if (r && r.ok && r.data && typeof r.data.content === 'string') {
      readFiles.push({ rel: r.data.rel, content: r.data.content });
      readRels.add(r.data.rel);
    } else {
      failedReads++;
    }
  }
  const evidence = buildArchitectureFromEvidence(readFiles);

  // Reconstruct the intended discovery plan (what the model should have selected to
  // read) and assert the plan was fully fulfilled: every planned rel was read, and
  // no read failed. This is the non-tautological version of `allEvidenceRead`.
  const listFilesResult = lastCallResult(conv, 'project.listFiles');
  const planRel = planEvidenceReads(listFilesResult ? { files: listFilesResult.files } : null);
  const planSatisfied = !!planRel.length && planRel.every((rel) => readRels.has(rel)) && failedReads === 0;

  // INDEPENDENT expected fixture (not derived from the builder): the canonical
  // fixture-project is exactly web -> api -> db with 2 edges.
  const expectedComponents = ['web', 'api', 'db'];
  const expectedConnections = [
    { from: 'web', to: 'api' },
    { from: 'api', to: 'db' },
  ];
  const authoredIds = (authored.ir.components || []).map((c) => c.id).sort();
  const authoredConnections = (authored.ir.connections || []).map((c) => ({ from: c.from, to: c.to })).sort((a, b) => (a.from + '->' + a.to).localeCompare(b.from + '->' + b.to));
  const expectedMatches =
    JSON.stringify(authoredIds) === JSON.stringify(expectedComponents.slice().sort()) &&
    JSON.stringify(authoredConnections) === JSON.stringify(expectedConnections.slice().sort((a, b) => (a.from + '->' + a.to).localeCompare(b.from + '->' + b.to)));

  // Normalized structural equality: components by (id, type, label) and connections
  // by (from, to). We compare only fields the CLI layout IR actually carries — it
  // preserves id/type/label but NOT sublabel (which drops at layout time), so a
  // hardcoded candidate with the right ids but wrong types/labels/edges would NOT pass.
  const normComp = (list) => list.map((c) => ({ id: c.id, type: c.type, label: c.label || null })).sort((a, b) => a.id.localeCompare(b.id));
  const normConn = (list) => list.map((c) => ({ from: c.from, to: c.to })).sort((a, b) => (a.from + '->' + a.to).localeCompare(b.from + '->' + b.to));
  const evidenceDerived = evidence.components.length > 0 &&
    JSON.stringify(normComp(authored.ir.components)) === JSON.stringify(normComp(evidence.components)) &&
    JSON.stringify(normConn(authored.ir.connections)) === JSON.stringify(normConn(evidence.connections));
  const nodesHaveEvidence = (authored.ir.components || []).every((n) => !!evidence.evidenceMap[n.id]);

  const sub = {
    getStatus: flow.includes('project.getStatus'),
    listFiles: flow.includes('project.listFiles'),
    readFile: flow.includes('project.readFile'),
    skillFile: flow.includes('archify.getSkillFile'),
    twoAuthorCalls: authorCalls.length === 2,
    firstAuthorFailed,
    repaired,
    comp3: authored.ir.components.length === 3,
    conn2: authored.ir.connections.length === 2,
    evidenceDerived,
    nodesHaveEvidence,
    planSatisfied,
    expectedMatches,
    projectedOk: projected.ok,
    previewConfirmed: projected.ok && !!projected.previewToken && !!projected.projectionId,
    evidencePersisted: projected.ok && projected.evidenceNodes === authored.ir.components.length,
    evidenceMatches: projected.ok && projected.evidenceMatches === true,
    nodes3: projected.ok && (projected.counts && projected.counts.nodes) === 3,
    arrows2: projected.ok && (projected.counts && projected.counts.arrows) === 2,
  };
  const ok =
    sub.getStatus &&
    sub.listFiles &&
    sub.readFile &&
    sub.skillFile &&
    sub.twoAuthorCalls &&
    sub.firstAuthorFailed &&
    sub.repaired &&
    sub.comp3 &&
    sub.conn2 &&
    sub.evidenceDerived &&
    sub.nodesHaveEvidence &&
    sub.planSatisfied &&
    sub.expectedMatches &&
    sub.projectedOk &&
    sub.previewConfirmed &&
    sub.evidencePersisted &&
    sub.evidenceMatches &&
    sub.nodes3 &&
    sub.arrows2;
  if (!ok) console.log('ARCHIFY-AGENT SUB-CHECKS ' + JSON.stringify(sub, null, 2));
  console.log(ok ? 'ARCHIFY-AGENT: ALL CHECKS PASSED' : 'ARCHIFY-AGENT: PROBLEM(S)');
  app.quit();
}
