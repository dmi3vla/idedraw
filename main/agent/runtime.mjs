// The agent runtime as a FACTORY (refactor rule 2). Everything that used to be
// module-level mutable state in main.mjs — conversations, pending tool results,
// frozen per-turn contexts, in-flight generations, and the `let
// skillStoreInstance` that was assigned in whenReady but declared 3000 lines
// later — is now owned by the object this returns.
import { streamChat } from '../chat-stream.mjs';
import { composeAgentSystemPrompt } from '../skills/skill-store.mjs';
import { resolveAllowedCommands, intersectToolsWithAllowlist } from '../agent-allowlist.mjs';
import { classifyTool, executeProjectTool, executeArchifyTool, toToolContent } from '../agent-tool-executor.mjs';
import { getProjectRoot, getProjectStatus } from '../project/project-root.mjs';
import { publicSession } from '../project/project-canvas-file.mjs';
import { getProjectSnapshot } from '../project/project-fs.mjs';
import { readSkillProfile } from '../skill-profile.mjs';
import { wouldExceedToolBudget } from '../tool-budget.mjs';
import { compactConversation, conversationBytes } from '../conv-compact.mjs';
import { CHAT_SYSTEM, CHAT_MAX_TOKENS, MAX_TOOL_ROUNDS, MAX_TOOL_CALLS } from './system-prompt.mjs';

export function createAgentRuntime({ configStore, secretStore, skillStore = null, logger }) {
  const { log: gLog, err: gErr, snip: gSnip } = logger;

  let skillStoreInstance = null;
  const chatConversations = new Map(); // `${webContents.id}:${threadId}` -> messages[]
  const pendingToolResults = new Map(); // `${senderId}:${toolUseId}` -> resolver
  const activeArchifyGenerations = new Map(); // webContents.id -> AbortController
  const agentTurnContexts = new Map(); // `${sender.id}:${conversationId}` -> frozen ctx

  async function runChatTurn(sender, id, conv, rendererTools, configStore, secretStore, opts = {}) {
    const emit = (type, extra) => sender.send('chat:stream', { id, type, ...extra });
    const contextKey = `${sender.id}:${id}`;
    const cfg = configStore.load();
    const apiKey = secretStore.getKey();
    const model = cfg.model || 'claude-sonnet-5';
  
    // S5.2: the acceptance scenario injects a deterministic model adapter instead
    // of a real network client, and may run without a configured API key. `requireKey`
    // stays `true` for the live chat path; scenarios that drive the loop headlessly
    // pass a scripted model and set it to `false`.
    const modelFn = opts.modelFn || streamChat;
    const requireKey = opts.requireKey !== false;
    const onFinish = opts.onFinish || null;
  
    gLog('runChatTurn start', JSON.stringify({ id, model, endpoint: cfg.endpoint, apiKey: apiKey ? 'set' : 'missing', requireKey, toolCount: (rendererTools || []).length }));
    if (requireKey && !apiKey) {
      gErr('runChatTurn: NO_API_KEY');
      emit('text', { text: '\n[нет API-ключа — задайте его в настройках чата (⚙)]' });
      emit('done', { error: 'no-key' });
      return { ok: false, error: { code: 'NO_API_KEY', message: 'API key is not configured.' } };
    }
  
    // Holds the structured error when the turn aborts/errors; the finally block
    // releases the context and this value is returned after it. Must be declared
    // up-front: ESM strict mode makes assigning to an undeclared name throw a
    // ReferenceError (which would surface as a generic GENERATION_FAILED).
    let turnError = null;
  
    try {
      // S4.2 AgentRunContext — built ONCE, immutably, before the tool loop so a
      // mid-turn settings change (enable/disable a skill, link a project) cannot
      // alter an in-flight prompt/toolset/allowlist. Every use in this turn comes
      // from the same context: the system prompt, the tools handed to the model,
      // the allowlist used to gate tool_use, and the receipt.
      const ctx = buildAgentRunContext({ id, model, rendererTools });
      agentTurnContexts.set(contextKey, ctx);
      sender.send('chat:runReceipt', { id, ...ctx.receipt });
  
      let rounds = 0;
      let totalToolCalls = 0;
      for (;;) {
        gLog(`round ${rounds + 1} · вызов модели endpoint=${cfg.endpoint} model=${model} tools=${ctx.tools.length} key=${apiKey ? 'set' : 'missing'}`);
        // Память/трафик: в живом логе тело запроса росло 20KB → 244KB за 13 кругов,
        // потому что всю историю (все project.readFile и все candidate/diagnostics)
        // пересылали целиком каждый круг. Старые tool_result урезаются только в
        // КОПИИ, которая уходит в модель: сам conv остаётся полным для walkToolCalls()
        // и lastAuthorResult(), а парность tool_use ↔ tool_result не нарушается.
        const compacted = compactConversation(conv);
        if (compacted.trimmed) {
          gLog(`round ${rounds + 1} · история сжата blocks=${compacted.trimmed} chars=-${compacted.savedChars} bytes=${conversationBytes(compacted.messages)}`);
        }
        const { stopReason, text, toolUses } = await modelFn({
          endpoint: cfg.endpoint,
          apiKey,
          model,
          maxTokens: CHAT_MAX_TOKENS,
          messages: compacted.messages,
          system: ctx.system,
          tools: ctx.tools,
          signal: opts.signal,
          onText: (t) => emit('text', { text: t }),
        });
        gLog(`round ${rounds + 1} · ответ stopReason=${stopReason} textLen=${text ? text.length : 0} toolUses=${toolUses ? toolUses.length : 0}`);
  
        // If the model is done (no tool_use), persist the assistant message and stop.
        if (stopReason !== 'tool_use' || toolUses.length === 0) {
          const finalContent = text ? [{ type: 'text', text }] : [];
          if (finalContent.length) conv.push({ role: 'assistant', content: finalContent });
          gLog(`round ${rounds + 1} · модель завершила (без tool_use) — финальный текст: ${text ? JSON.stringify(text.slice(0, 240)) : '(пусто)'}`);
          break;
        }
  
        // Tool budget: a model can loop forever calling tools. Enforce a hard cap on
        // rounds (one model turn that ends in tool_use) and on cumulative tool calls.
        // IMPORTANT: check BEFORE appending the assistant tool_use block, so a cap
        // violation never leaves a dangling tool_use in the conversation (which a real
        // Anthropic-style API would reject on the next turn). The pure helper bills the
        // number of tool_use calls THIS turn would add against the CURRENT counters, so
        // a threshold hit is caught before the message is recorded.
        const nextRounds = rounds + 1;
        const nextTotalCalls = totalToolCalls + toolUses.length;
        if (wouldExceedToolBudget({ rounds, calls: totalToolCalls, nextCalls: toolUses.length }, { maxRounds: MAX_TOOL_ROUNDS, maxCalls: MAX_TOOL_CALLS })) {
          emit('text', { text: `\n[остановлено: исчерпан лимит итераций инструментов (${MAX_TOOL_ROUNDS} кругов / ${MAX_TOOL_CALLS} вызовов)]` });
          emit('done', { error: 'TOOL_BUDGET_EXHAUSTED' });
          return { ok: false, error: { code: 'TOOL_BUDGET_EXHAUSTED', message: 'Tool iteration budget exhausted.' } };
        }
        rounds = nextRounds;
        totalToolCalls = nextTotalCalls;
  
        const assistantContent = [];
        if (text) assistantContent.push({ type: 'text', text });
        for (const tu of toolUses) {
          assistantContent.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
        }
        conv.push({ role: 'assistant', content: assistantContent });
  
        const results = [];
        for (const tu of toolUses) {
          if (opts.onToolUse) opts.onToolUse(tu, { rounds, totalToolCalls });
          emit('tool', { name: tu.name });
          const content = await executeTurnTool(sender, tu, ctx);
          results.push({ type: 'tool_result', tool_use_id: tu.id, content });
        }
        conv.push({ role: 'user', content: results });
      }
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      const aborted = opts.signal && opts.signal.aborted;
      const name = String((e && e.name) || '');
      const code = (e && e.code) || (aborted || name === 'AbortError' ? 'CANCELLED' : null)
        || (/fetch|network|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket|abort/i.test(msg) ? 'NETWORK' : null)
        || 'GENERATION_FAILED';
      turnError = { code, message: aborted ? 'Generation cancelled.' : msg };
      gErr(`runChatTurn ошибка code=${code} name=${name} message=${msg}`, e && e.stack ? `stack=${String(e.stack).split('\n').slice(0, 3).join(' | ')}` : '');
      emit('text', { text: `\n[ошибка чата] ${msg}` });
    } finally {
      // The turn ended: release the frozen context so it can't be reused by a later
      // conversation (and so the map cannot grow unbounded across turns).
      agentTurnContexts.delete(contextKey);
    }
    emit('done', {});
    if (onFinish) onFinish();
    return turnError ? { ok: false, error: turnError } : { ok: true };
  }

  function buildAgentRunContext({ id, model, rendererTools }) {
    const skillSnapshots = skillStore ? skillStore.enabledSnapshots() : [];
    const skillNames = skillSnapshots.map((s) => s.name);
    const projectRoot = getProjectRoot();
    const projectLinked = !!projectRoot;
    const allowedCommands = resolveAllowedCommands({ skillNames, projectLinked });
    const tools = intersectToolsWithAllowlist(rendererTools || [], allowedCommands);
    const allowedToolNames = new Set(tools.map((t) => t.name));
    const system = composeAgentSystemPrompt(CHAT_SYSTEM, skillSnapshots);
  
    // FROZEN archify execution context: resolve the binary + skill hash + profile
    // ONCE, at turn start, so a mid-turn enable/disable/edit of the Archify skill
    // cannot silently swap the CLI or the repair budget on THIS turn. This is what
    // makes the receipt's snapshot match the actual execution (S4.2.1).
    const bin = resolveArchifyBinary(skillStore);
    const archify = bin.ok
      ? {
          root: bin.root,
          binary: bin.binary,
          skillHash: bin.skillHash,
          profile: readSkillProfile(skillStore),
        }
      : null;
    const appUserData = app.getPath('userData');
  
    // A cheap, deterministic project snapshot for the receipt (guarded: a project
    // may be large; the fingerprint is capped by the project-fs MAX_FILES bound).
    let projectSnapshotHash = null;
    if (projectRoot) {
      try {
        const snap = getProjectSnapshot(projectRoot);
        if (snap && snap.ok && snap.data) projectSnapshotHash = snap.data.fingerprint;
      } catch {
        projectSnapshotHash = null;
      }
    }
  
    // SAFETY: the receipt never contains SKILL.md content, binary/candidate paths,
    // API keys, or absolute project file paths — only stable public identity.
    // `allowedCommands` is the policy allowlist; `modelAvailableCommands` is what was
    // actually handed to the model (the intersection with what the renderer offered).
    const receipt = {
      runId: id,
      model,
      startedAt: Date.now(),
      skills: skillSnapshots.map((s) => ({ skillId: s.skillId || `local:${s.name}`, sha256: s.sha256 })),
      allowedCommands: Array.from(allowedCommands).sort(),
      modelAvailableCommands: tools.map((t) => t.name).sort(),
      projectLinked,
      projectSnapshotHash,
    };
  
    return { id, model, system, tools, allowedToolNames, skillSnapshots, projectRoot, archify, appUserData, receipt };
  }

  async function executeTurnTool(sender, tu, ctx) {
    // Security boundary: reject any tool_use outside the frozen allowlist BEFORE
    // doing anything. The renderer filter is UX; this is authoritative.
    if (!ctx || !ctx.allowedToolNames.has(tu.name)) {
      return `Команда "${tu.name}" не разрешена в этом ходе — выключенный skill, отсутствующий linked project или не в allowlist.`;
    }
    const kind = classifyTool(tu.name);
    if (kind === 'project') {
      return toToolContent(executeProjectTool(ctx, tu.name, tu.input));
    }
    if (kind === 'archify') {
      return toToolContent(await executeArchifyTool(ctx, tu.name, tu.input));
    }
    // canvas.* (and any other allowed chat command the renderer owns)
    return askRendererForTool(sender, tu);
  }

  function askRendererForTool(sender, tu) {
    return new Promise((resolve) => {
      const key = `${sender.id}:${tu.id}`;
      const timer = setTimeout(() => {
        pendingToolResults.delete(key);
        resolve('Таймаут ожидания результата инструмента от холста');
      }, 60000);
      pendingToolResults.set(key, (payload) => {
        clearTimeout(timer);
        if (!payload || !payload.ok) {
          const code = (payload && payload.error && payload.error.code) || 'ERR';
          const msg = (payload && payload.error && payload.error.message) || 'неизвестная ошибка';
          resolve(`Ошибка команды: ${code} — ${msg}`);
          return;
        }
        const data = payload.data;
        resolve(typeof data === 'string' ? data : JSON.stringify(data));
      });
      sender.send('chat:toolRequest', { tool_use_id: tu.id, name: tu.name, input: tu.input });
    });
  }

  return {
    runChatTurn,
    buildAgentRunContext,
    executeTurnTool,
    askRendererForTool,
    // Exposed so the chat/archify IPC modules can reach the SAME state they used
    // to share by living in one file. Nothing else may mutate them.
    chatConversations,
    pendingToolResults,
    activeArchifyGenerations,
    agentTurnContexts,
  };
}
