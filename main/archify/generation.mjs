// Production project generation, moved out of the IPC layer (it was ~150 lines
// living inside registerConfigIpc, of all places). The handler is now a thin
// wrapper; this module owns the flow.
import path from 'node:path';
import { getProjectRoot } from '../project/project-root.mjs';
import { getProjectSnapshot } from '../project/project-fs.mjs';
import { publicSession } from '../project/project-canvas-file.mjs';
import { parseArchifyResult } from '../archify-result.mjs';
import { bindEvidenceToArchifyIr } from '../evidence-builder.mjs';
import { buildArchifyGenerationPrompt, buildRepairNudge, summarizeDiagnostics } from '../archify-generation-prompt.mjs';
import { resolveArchifyBinary } from './binary.mjs';
import { lastAuthorResult, lastAuthorFailure, walkToolCalls } from '../agent/conversation.mjs';

export function registerGenerationIpc({ ipcMain, configStore, secretStore, skillStore, agentRuntime, logger }) {
  const { log: gLog, err: gErr, snip: gSnip } = logger;

  // Production project generation: the Archify button uses the SAME endpoint,
  // model and encrypted API key as chat settings. Unlike the deterministic demo
  // adapter, this starts a fresh real model turn over a fresh project snapshot.
  ipcMain.handle('archify:generateProject', async (event, input) => {
    const progress = (stage, detail = null) => {
      if (!event.sender.isDestroyed()) event.sender.send('archify:generationProgress', { stage, detail });
    };
    const session = publicSession();
    gLog('== генерация началась ==');
    if (!session.linked || !getProjectRoot()) {
      gErr('guard NOT_LINKED — проект не привязан');
      return { ok: false, error: { code: 'NOT_LINKED', message: 'Open a project first.' } };
    }
    if (!input || input.generation !== session.generation) {
      gErr(`guard STALE_PROJECT — input.generation=${JSON.stringify(input && input.generation)} session.generation=${session.generation}`);
      return { ok: false, error: { code: 'STALE_PROJECT', message: 'Project changed before generation.' } };
    }
    const hasKey = !!secretStore.getKey();
    if (!hasKey) {
      gErr('guard NO_API_KEY — ключ не сохранён в настройках чата');
      return { ok: false, error: { code: 'NO_API_KEY', message: 'Настройте API-ключ во встроенных настройках чата.' } };
    }
    const cfg = configStore.load();
    if (!cfg.model) {
      gErr('guard NO_MODEL — модель не выбрана в настройках чата');
      return { ok: false, error: { code: 'NO_MODEL', message: 'Выберите модель во встроенных настройках чата.' } };
    }
    const arch = resolveArchifyBinary(skillStore);
    if (!arch.ok) {
      gErr('guard', arch.error.code, arch.error.message);
      return { ok: false, error: arch.error };
    }
    gLog('config', JSON.stringify({ endpoint: cfg.endpoint, model: cfg.model, apiKey: hasKey ? 'set' : 'missing', skill: arch.name || 'archify', skillHash: arch.skillHash }));
    const startSnapshotResult = getProjectSnapshot(getProjectRoot());
    const startSnapshot = startSnapshotResult && startSnapshotResult.ok ? startSnapshotResult.data.fingerprint : null;
    gLog('snapshot', startSnapshot ? `fingerprint=${startSnapshot}` : 'FAILED');
    if (!startSnapshot) {
      gErr('guard SNAPSHOT_FAILED — не удалось зафиксировать снимок проекта');
      return { ok: false, error: { code: 'SNAPSHOT_FAILED', message: 'Не удалось зафиксировать снимок проекта.' } };
    }
    progress('snapshot');

    const previous = agentRuntime.activeArchifyGenerations.get(event.sender.id);
    if (previous) { gLog('отменяю предыдущую генерацию этого окна'); previous.abort(); }
    const controller = new AbortController();
    agentRuntime.activeArchifyGenerations.set(event.sender.id, controller);
    // Текст запроса живёт в main/archify-generation-prompt.mjs (юнит-тестируем, одни
    // и те же геометрические лимиты для запроса, repair-подсказки и авторемонта).
    const conv = [{ role: 'user', content: buildArchifyGenerationPrompt({
      projectName: path.basename(getProjectRoot() || ''),
      snapshot: startSnapshot,
    }) }];
    const generationId = `archify-generate-${event.sender.id}-${Date.now()}`;
    // Only project/archify descriptors are accepted for this dedicated turn.
    const tools = Array.isArray(input.tools)
      ? input.tools.filter((t) => t && (String(t.name).startsWith('project.') || String(t.name).startsWith('archify.')))
      : [];
    const quietSender = { id: event.sender.id, send: () => {} };
    try {
      let authorAttempts = 0;
      const onToolUse = (toolUse, meta) => {
        const name = String(toolUse && toolUse.name || '');
        gLog('tool_use', name, `round=${meta && meta.rounds}`, gSnip(toolUse && toolUse.input));
        if (name.startsWith('project.')) progress('evidence', name);
        else if (name === 'archify.author') {
          authorAttempts += 1;
          progress(authorAttempts > 1 ? 'repair' : 'author', name);
        } else if (name.startsWith('archify.')) progress('author', name);
      };
      gLog('старт turn', JSON.stringify({ generationId, systemPromptLength: conv[0] && conv[0].content ? conv[0].content.length : 0, tools: tools.map((t) => t.name) }));
      const turn = await agentRuntime.runChatTurn(quietSender, generationId, conv, tools, configStore, secretStore, {
        signal: controller.signal,
        onToolUse,
      });
      gLog('turn результат', JSON.stringify({ ok: turn && turn.ok, error: turn && turn.error }));
      if (controller.signal.aborted) { gErr('отменено — controller.signal.aborted'); return { ok: false, error: { code: 'CANCELLED', message: 'Генерация отменена.' } }; }
      if (turn && turn.ok === false) { gErr('turn вернул ошибку:', JSON.stringify(turn.error)); return turn; }
      const now = publicSession();
      if (!now.linked || now.generation !== session.generation) { gErr('guard STALE_PROJECT — сессия изменилась во время генерации'); return { ok: false, error: { code: 'STALE_PROJECT', message: 'Project changed during generation.' } }; }
      const endSnapshotResult = getProjectSnapshot(getProjectRoot());
      const endSnapshot = endSnapshotResult && endSnapshotResult.ok ? endSnapshotResult.data.fingerprint : null;
      gLog('конечный snapshot', endSnapshot ? `fingerprint=${endSnapshot}` : 'FAILED', `изменился=${endSnapshot !== startSnapshot}`);
      if (!endSnapshot || endSnapshot !== startSnapshot) { gErr('guard PROJECT_CHANGED — файлы изменились во время генерации'); return { ok: false, error: { code: 'PROJECT_CHANGED', message: 'Файлы проекта изменились во время генерации. Нажмите «Обновить» ещё раз.' } }; }
      // Regression: a weak model sometimes ends the turn SILENTLY right after a
      // failed archify.author (seen live: round 10 end_turn, textLen=0, no
      // tool_use -> guard GENERATION_FAILED). One bounded continuation nudge
      // turns that stall into a repair instead of a failed generation.
      let authored = lastAuthorResult(conv);
      if (!authored || !authored.ir) {
        gLog('nudge — ход прерван без успешного archify.author, продолжаю один раз', JSON.stringify({ authorAttempts }));
        const lastFailure = lastAuthorFailure(conv);
        conv.push({ role: 'user', content: buildRepairNudge({
          attempts: authorAttempts,
          diagnostics: lastFailure && lastFailure.diagnostics,
          error: lastFailure && lastFailure.error,
        }) });
        const turn2 = await agentRuntime.runChatTurn(quietSender, generationId, conv, tools, configStore, secretStore, {
          signal: controller.signal,
          onToolUse,
        });
        gLog('nudge turn результат', JSON.stringify({ ok: turn2 && turn2.ok, error: turn2 && turn2.error }));
        if (controller.signal.aborted) { gErr('отменено — controller.signal.aborted'); return { ok: false, error: { code: 'CANCELLED', message: 'Генерация отменена.' } }; }
        if (turn2 && turn2.ok === false) { gErr('nudge turn вернул ошибку:', JSON.stringify(turn2.error)); return turn2; }
        authored = lastAuthorResult(conv);
      }
      if (!authored || !authored.ir) {
        gErr('guard GENERATION_FAILED — модель не завершила Archify authoring (lastAuthorResult пуст)');
        const trace = walkToolCalls(conv).map((c) => {
          const r = parseArchifyResult(c.resultText);
          // For the failing author call, surface the structured error + diagnostics
          // (the actual reason the CLI rejected the candidate) instead of just `ok`.
          const extra = c.name === 'archify.author' && r && r.ok === false
            ? { code: r.error && r.error.code, message: r.error && r.error.message, diagnostics: (r.diagnostics || []).slice(0, 8) }
            : {};
          return { name: c.name, ok: r ? Boolean(r.ok) : null, ...extra };
        });
        const authorCalls = walkToolCalls(conv).filter((c) => c.name === 'archify.author');
        for (const a of authorCalls) {
          const r = parseArchifyResult(a.resultText);
          if (r && r.ok === false) gErr('archify.author отказ\n' + summarizeDiagnostics(r.diagnostics, r.error));
          else if (r) gErr('archify.author ok components=' + ((r.data && r.data.ir && r.data.ir.components || []).length));
        }
        gLog('walkToolCalls:', JSON.stringify(trace));
        return { ok: false, error: { code: 'GENERATION_FAILED', message: 'Модель не завершила Archify authoring. Проверьте настройки чата и повторите.' } };
      }
      gLog('author успех', JSON.stringify({ componentCount: Array.isArray(authored.ir.components) ? authored.ir.components.length : 0, connectionCount: Array.isArray(authored.ir.connections) ? authored.ir.connections.length : 0 }));

      const readFiles = [];
      for (const call of walkToolCalls(conv).filter((c) => c.name === 'project.readFile')) {
        const parsed = parseArchifyResult(call.resultText);
        if (parsed && parsed.ok && parsed.data && typeof parsed.data.content === 'string') readFiles.push({ rel: parsed.data.rel, content: parsed.data.content });
      }
      // S6 manifest is a parallel channel, never a field in the strict Archify
      // candidate. Model-authored ids may differ from path-derived tier ids, so
      // bind the successful IR back to the exact files before projection.
      const evidence = bindEvidenceToArchifyIr(authored.ir, readFiles);
      gLog('evidence', JSON.stringify({
        readFiles: readFiles.map((f) => f.rel),
        evidenceCount: Object.keys(evidence.evidenceMap || {}).length,
        anchorCount: Object.keys(evidence.filesManifest?.components || {}).length,
        bindings: evidence.bindings,
      }));
      progress('preview');
      gLog('генерация завершена OK');
      return { ok: true, data: {
        ir: authored.ir,
        projectContext: {
          snapshot: startSnapshot,
          evidenceMap: evidence.evidenceMap,
          filesManifest: evidence.filesManifest,
        },
        skillContext: { hash: authored.skillHash || arch.skillHash || null, name: 'archify' },
        generationProof: { authorCompleted: true, projectReadCount: readFiles.length, usedConfiguredModel: true },
      } };
    } finally {
      if (agentRuntime.activeArchifyGenerations.get(event.sender.id) === controller) agentRuntime.activeArchifyGenerations.delete(event.sender.id);
    }
  });

  ipcMain.handle('archify:cancelGeneration', (event) => {
    const controller = agentRuntime.activeArchifyGenerations.get(event.sender.id);
    if (controller) controller.abort();
    return { ok: true, data: { cancelled: !!controller } };
  });
}
