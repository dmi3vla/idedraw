import * as canvas from '../canvas/adapter.mjs';
import * as project from '../project/project-store.mjs';
import { ok, err, fromThrow } from './protocol-result.mjs';
import { getAstScope, getAstFrameHost, requestAstFocus, SCOPE_MAX_LINES } from './ast-scope-store.mjs';

// astFrame.* only means something while an AST frame is mounted. Refusing loudly
// (instead of returning an empty success) is what keeps the model from claiming
// it "showed" the operator something that was never rendered.
function requireFrameHost() {
  const host = getAstFrameHost();
  if (!host) {
    throw Object.assign(
      new Error('Ни один AST-фрейм не смонтирован — попросите оператора развернуть компонент.'),
      { code: 'NO_AST_FRAME' },
    );
  }
  return host;
}

function requireId(input) {
  if (!input || typeof input.id !== 'string') {
    throw Object.assign(new Error('Missing required field: id'), { code: 'BAD_INPUT' });
  }
}

// inputSchema is the REAL JSON Schema handed to the model as tool input_schema.
// `input` (below) is only the human-readable description used by the smoke test
// and the stub parser; the model never sees `input`, it sees inputSchema.
const commands = new Map([
  ['canvas.addNode', {
    description: 'Add one rectangle node to the canvas.',
    mutates: true,
    input: { id: 'string', label: 'string', x: 'number?', y: 'number?' },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Unique node id, e.g. "A".' },
        label: { type: 'string', description: 'Display label shown centered in the node.' },
        x: { type: 'number', description: 'Scene X coordinate (optional; default 100).' },
        y: { type: 'number', description: 'Scene Y coordinate (optional; default 100).' },
      },
      required: ['id', 'label'],
    },
    run: (input) => fromThrow(() => canvas.addNode(input)),
  }],
  ['canvas.addNodes', {
    description: 'Add multiple rectangle nodes to the canvas in one commit.',
    mutates: true,
    input: { nodes: 'Array<{id,label,x?,y?}>' },
    inputSchema: {
      type: 'object',
      properties: {
        nodes: {
          type: 'array',
          description: 'Nodes to add.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' },
            },
            required: ['id', 'label'],
          },
        },
      },
      required: ['nodes'],
    },
    run: (input) => fromThrow(() => canvas.addNodes(input.nodes)),
  }],
  ['canvas.updateNode', {
    description: 'Patch an existing canvas element by id (move/resize/relabel).',
    mutates: true,
    input: { id: 'string', patch: 'object' },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id of the element to patch.' },
        patch: {
          type: 'object',
          description: 'Partial element fields: x, y, width, height, label, etc.',
          additionalProperties: true,
        },
      },
      required: ['id', 'patch'],
    },
    run: (input) => { requireId(input); return fromThrow(() => canvas.updateNode(input.id, input.patch)); },
  }],
  ['canvas.removeNode', {
    description: 'Remove a canvas element by id.',
    mutates: true,
    input: { id: 'string' },
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    run: (input) => { requireId(input); return fromThrow(() => canvas.removeNode(input.id)); },
  }],
  ['canvas.removeNodes', {
    description: 'Remove multiple canvas elements by id in one batch.',
    mutates: true,
    input: { ids: 'Array<string>' },
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' } } },
      required: ['ids'],
    },
    run: (input) => fromThrow(() => canvas.removeNodes(input.ids)),
  }],
  ['canvas.addEdge', {
    description: 'Draw a connecting arrow between two existing nodes.',
    mutates: true,
    input: { fromId: 'string', toId: 'string', label: 'string?' },
    inputSchema: {
      type: 'object',
      properties: {
        fromId: { type: 'string', description: 'Source node id.' },
        toId: { type: 'string', description: 'Target node id.' },
        label: { type: 'string', description: 'Optional edge label.' },
      },
      required: ['fromId', 'toId'],
    },
    run: (input) => fromThrow(() => canvas.addEdge(input)),
  }],
  ['canvas.addEdges', {
    description: 'Draw multiple connecting arrows in one batch. Validate-then-commit: if any endpoint is missing, nothing is added.',
    mutates: true,
    input: { edges: 'Array<{fromId,toId,label?}>' },
    inputSchema: {
      type: 'object',
      properties: {
        edges: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              fromId: { type: 'string' },
              toId: { type: 'string' },
              label: { type: 'string' },
            },
            required: ['fromId', 'toId'],
          },
        },
      },
      required: ['edges'],
    },
    run: (input) => fromThrow(() => canvas.addEdges(input.edges)),
  }],
  ['canvas.compact', {
    description: 'Drop tombstoned (isDeleted) elements from scene memory. Call after bulk removeNode/removeNodes; also fires automatically when tombstones exceed 30% of the scene.',
    mutates: true,
    input: {},
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: () => fromThrow(() => canvas.compact()),
  }],
  ['canvas.selectElement', {
    description: 'Select a canvas element by id.',
    mutates: false,
    input: { id: 'string' },
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    run: (input) => { requireId(input); return fromThrow(() => canvas.selectElement(input.id)); },
  }],
  ['canvas.clearSelection', {
    description: 'Clear current canvas selection.',
    mutates: false,
    input: {},
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: () => fromThrow(() => canvas.clearSelection()),
  }],
  ['canvas.fitToScreen', {
    description: 'Fit all visible canvas content to the viewport.',
    mutates: false,
    input: {},
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: () => fromThrow(() => canvas.fitToScreen()),
  }],
  ['canvas.linkProject', {
    description: 'Link the current canvas to a project graph (canvas is standalone until this is called).',
    mutates: true,
    input: { canvasId: 'string', projectId: 'string?' },
    inputSchema: {
      type: 'object',
      properties: {
        canvasId: { type: 'string', description: 'Id of the canvas to link.' },
        projectId: { type: 'string', description: 'Optional project id; defaults to the demo project.' },
      },
      required: ['canvasId'],
    },
    run: (input) => {
      // A new project link means the previous canvas context is gone; forget any
      // pending projection plan so it can never be confirmed on this new scene.
      canvas.clearProjectionState();
      return project.linkCanvas(input.canvasId, input.projectId);
    },
  }],
  ['canvas.unlinkProject', {
    description: 'Unlink the current canvas from any project — it becomes a freeform sketch again.',
    mutates: true,
    input: {},
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: () => {
      canvas.clearProjectionState();
      return project.unlinkCanvas();
    },
  }],
  ['canvas.importArchify', {
    description:
      'Materialise an archify architecture IR (components/boundaries/connections) as live Excalidraw ' +
      'elements in one scene commit: boundaries become native frames, components become nodes with ' +
      'label + sublabel, connections become bound arrows. Programmatic import — NOT intended to be ' +
      'reachable from chat text on this pass (see notForChat).',
    mutates: true,
    // The intent parser in llm-client.mjs must not be able to trigger a
    // whole-diagram import from a stray sentence; this flag is what keeps it
    // out of the chat-reachable set (asserted in smoke-test.mjs).
    notForChat: true,
    input: { ir: 'object (archify IR)', mode: 'merge|replace|reset?', replace: 'boolean?', projectContext: 'object?', skillContext: 'object?' },
    inputSchema: {
      type: 'object',
      properties: {
        ir: { type: 'object', description: 'Archify architecture IR: { components, boundaries, connections }.' },
        mode: { type: 'string', enum: ['merge', 'replace', 'reset'], description: 'Import mode (default: merge unless replace=true).' },
        replace: { type: 'boolean', description: 'Legacy shorthand for mode=replace (kept for existing callers).' },
        projectContext: { type: 'object', description: 'Optional { label, snapshot, evidenceRefs } used for safe provenance.' },
        skillContext: { type: 'object', description: 'Optional { hash, name } used for safe provenance.' },
      },
      required: ['ir'],
    },
    run: (input) => fromThrow(() => {
      const mode = input.mode || (input.replace ? 'replace' : 'merge');
      return canvas.importArchifyProjected({
        ir: input.ir,
        mode,
        projectContext: input.projectContext ?? null,
        skillContext: input.skillContext ?? null,
      });
    }),
  }],
  ['canvas.previewArchifyProjection', {
    description:
      'Build (and cache) a deterministic Archify projection plan for the given IR WITHOUT mutating ' +
      'the scene. Returns the plan a later confirm would apply: counts, bounds, warnings, provenance. ' +
      'Programmatic — notForChat.',
    mutates: false,
    notForChat: true,
    input: { ir: 'object (archify IR)', mode: 'merge|replace|reset?', projectContext: 'object?', skillContext: 'object?' },
    inputSchema: {
      type: 'object',
      properties: {
        ir: { type: 'object', description: 'Archify architecture IR: { components, boundaries, connections }.' },
        mode: { type: 'string', enum: ['merge', 'replace', 'reset'], description: 'Import mode contract (default merge).' },
        projectContext: { type: 'object', description: 'Optional { label, snapshot, evidenceRefs } provenance context.' },
        skillContext: { type: 'object', description: 'Optional { hash, name } provenance context.' },
      },
      required: ['ir'],
    },
    run: (input) => fromThrow(() =>
      canvas.previewArchifyProjection({
        ir: input.ir,
        mode: input.mode ?? 'merge',
        projectContext: input.projectContext ?? null,
        skillContext: input.skillContext ?? null,
      })
    ),
  }],
  ['canvas.confirmArchifyProjection', {
    description:
      'Apply a previously previewed projection in ONE undo transaction. Idempotent (a second confirm ' +
      'of the same content id returns alreadyApplied and re-applies nothing). Refuses a stale preview if the ' +
      'scene changed since the plan was built. Prefer the opaque previewToken returned by ' +
      'canvas.previewArchifyProjection; projectionId is accepted for backward compatibility. ' +
      'Programmatic — notForChat.',
    mutates: true,
    notForChat: true,
    input: { previewToken: 'string?', projectionId: 'string?' },
    inputSchema: {
      type: 'object',
      properties: {
        previewToken: { type: 'string', description: 'opaque previewToken returned by previewArchifyProjection.' },
        projectionId: { type: 'string', description: 'legacy content id; used only when previewToken is absent.' },
      },
      required: [],
    },
    run: (input) => fromThrow(() => canvas.confirmArchifyProjection({ previewToken: input.previewToken, projectionId: input.projectionId })),
  }],
  ['canvas.cancelArchifyProjection', {
    description: 'Drop a pending Archify projection without mutating the scene. Prefer the opaque previewToken; projectionId is accepted for backward compatibility. Programmatic — notForChat.',
    mutates: false,
    notForChat: true,
    input: { previewToken: 'string?', projectionId: 'string?' },
    inputSchema: {
      type: 'object',
      properties: {
        previewToken: { type: 'string', description: 'opaque previewToken returned by previewArchifyProjection.' },
        projectionId: { type: 'string', description: 'legacy content id; used only when previewToken is absent.' },
      },
      required: [],
    },
    run: (input) => fromThrow(() => canvas.cancelArchifyProjection({ previewToken: input.previewToken, projectionId: input.projectionId })),
  }],
  ['canvas.clearProjectionState', {
    description: 'Drop every pending Archify projection and the idempotency memory. Called automatically on project link/unlink; call again on any real new-canvas / clear-scene / document-load boundary so a preview token from a previous canvas can never be confirmed on this one. Programmatic — notForChat.',
    mutates: false,
    notForChat: true,
    input: {},
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: () => fromThrow(() => canvas.clearProjectionState()),
  }],
  ['project.getStatus', {
    description: 'Return whether the canvas is linked to a project directory (and its name). Read-only; the model never supplies a root — the project is chosen by the user through the app.',
    mutates: false,
    input: {},
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: async () => {
      const pb = window.projectBridge;
      if (!pb) throw Object.assign(new Error('projectBridge unavailable — preload did not load.'), { code: 'NO_BRIDGE' });
      return pb.getStatus();
    },
  }],
  ['project.listFiles', {
    description: 'List text source files in the linked project (relative paths, capped). Read-only evidence gathering. Uses the project directory chosen by the user — no path is accepted from the model.',
    mutates: false,
    input: {},
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: async () => {
      const pb = window.projectBridge;
      if (!pb) throw Object.assign(new Error('projectBridge unavailable — preload did not load.'), { code: 'NO_BRIDGE' });
      return pb.listFiles();
    },
  }],
  ['project.readFile', {
    description: 'Read one text file from the linked project (capped, binary/secret refused). Read-only. The path is always relative to the user-chosen project dir.',
    mutates: false,
    input: { rel: 'string (relative path)' },
    inputSchema: {
      type: 'object',
      properties: {
        rel: { type: 'string', description: 'File path relative to the project root.' },
      },
      required: ['rel'],
    },
    run: async (input) => {
      const pb = window.projectBridge;
      if (!pb) throw Object.assign(new Error('projectBridge unavailable — preload did not load.'), { code: 'NO_BRIDGE' });
      return pb.readFile({ rel: input.rel });
    },
  }],
  ['project.search', {
    description: 'Search file names + text content in the linked project (capped). Read-only. Uses the user-chosen project dir.',
    mutates: false,
    input: { query: 'string' },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (case-insensitive).' },
      },
      required: ['query'],
    },
    run: async (input) => {
      const pb = window.projectBridge;
      if (!pb) throw Object.assign(new Error('projectBridge unavailable — preload did not load.'), { code: 'NO_BRIDGE' });
      return pb.search({ query: input.query });
    },
  }],
  ['project.getSnapshot', {
    description: 'Get a cheap deterministic snapshot of the linked project (name, file count, SHA-256 fingerprint). Use to prove what state the evidence came from.',
    mutates: false,
    input: {},
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: async () => {
      const pb = window.projectBridge;
      if (!pb) throw Object.assign(new Error('projectBridge unavailable — preload did not load.'), { code: 'NO_BRIDGE' });
      return pb.getSnapshot();
    },
  }],
  ['archify.author', {
    description: 'Author + validate an archify diagram candidate against the enabled Archify CLI, returning the resolved layout IR. The agent authors the candidate JSON from project evidence; the CLI validates it (returning diagnostics for repair) and lays it out. Requires the Archify skill to be enabled. Returns an opaque runToken to continue a bounded repair loop.',
    mutates: false,
    requiresSkill: 'archify',
    input: { type: 'string', candidate: 'object', quality: 'string?', runToken: 'string?' },
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle'], description: 'Diagram type.' },
        candidate: { type: 'object', description: 'Authored diagram JSON (components/boundaries/connections/meta).' },
        quality: { type: 'string', enum: ['standard', 'showcase'], description: 'Quality profile (default showcase).' },
        runToken: { type: 'string', description: 'Opaque, server-owned token returned by a previous validation_failed call, to continue the repair loop.' },
      },
      required: ['type', 'candidate'],
    },
    run: async (input) => {
      const ab = window.archifyBridge;
      if (!ab || !ab.author) throw Object.assign(new Error('archifyBridge.author unavailable — preload did not load.'), { code: 'NO_BRIDGE' });
      // maxRepairRounds is PROFILE-DRIVEN in the main process (main.mjs reads it
      // from the enabled Archify skill profile + an internal clamp); it is not a
      // model-facing input, so the model can never enlarge its own repair budget.
      return ab.author({ type: input.type, candidate: input.candidate, quality: input.quality || 'showcase', runToken: input.runToken });
    },
  }],
  ['archify.getSkillFile', {
    description: 'Read a reference file from the enabled Archify skill (schema, example, or guide) to author a schema-valid candidate reproducibly. The agent supplies only kind + type; the path is always resolved inside the enabled skill root.',
    mutates: false,
    requiresSkill: 'archify',
    input: { kind: 'string (schema|example|guide)', type: 'string?' },
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['schema', 'example', 'guide'], description: 'Which reference to read.' },
        type: { type: 'string', description: 'Diagram type for schema/example (default architecture).' },
      },
      required: ['kind'],
    },
    run: async (input) => {
      const ab = window.archifyBridge;
      if (!ab || !ab.readSkillFile) throw Object.assign(new Error('archifyBridge.readSkillFile unavailable — preload did not load.'), { code: 'NO_BRIDGE' });
      return ab.readSkillFile({ kind: input.kind, type: input.type || 'architecture' });
    },
  }],

  // --- Сквозное позиционирование чат ⇄ AST-фреймы -------------------------
  // Один чат обслуживает все фреймы, поэтому модели нужен явный ответ на
  // вопрос «где сейчас стоит оператор» и явный способ позвать его в другое
  // место. Записи на диск здесь нет: proposeEdit только наполняет редактор
  // фрейма, а сохраняет всегда человек кнопкой «Сохранить».
  ['astFrame.getScope', {
    description: 'Read the operator current AST scope (frame, file, symbol, line range) and the list of open AST frames. Read-only. Call this FIRST when the operator says "here", "this function" or "this file" without naming it.',
    mutates: false,
    input: {},
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: () => fromThrow(() => ({
      scope: getAstScope(),
      frames: getAstFrameHost()?.listFrames?.() || [],
    })),
  }],
  ['astFrame.readScope', {
    description: `Read a bounded slice (max ${SCOPE_MAX_LINES} lines per call) of a file that is open in an AST frame. Defaults to the operator current scope file and line range. Read-only.`,
    mutates: false,
    input: { rel: 'string?', startLine: 'number?', endLine: 'number?' },
    inputSchema: {
      type: 'object',
      properties: {
        rel: { type: 'string', description: 'File path relative to the project root. Defaults to the current scope file.' },
        startLine: { type: 'number', description: '1-based first line. Defaults to the current scope start.' },
        endLine: { type: 'number', description: `1-based last line, clamped to ${SCOPE_MAX_LINES} returned lines.` },
      },
      required: [],
    },
    run: (input) => fromThrow(() => requireFrameHost().readScope(input)),
  }],
  ['astFrame.revealAt', {
    description: 'Agent -> operator positioning: move the AST frame to a file/line/symbol and highlight it, so the operator sees exactly what is being discussed. UI only — it writes nothing and reads nothing.',
    mutates: false,
    input: { rel: 'string', startLine: 'number?', endLine: 'number?', symbol: 'string?', note: 'string?' },
    inputSchema: {
      type: 'object',
      properties: {
        rel: { type: 'string', description: 'File path relative to the project root, as listed by astFrame.getScope.' },
        startLine: { type: 'number', description: '1-based first line to highlight.' },
        endLine: { type: 'number', description: '1-based last line to highlight.' },
        symbol: { type: 'string', description: 'Optional symbol name to name in the frame badge.' },
        note: { type: 'string', description: 'Short reason shown to the operator, e.g. "здесь течёт листенер".' },
      },
      required: ['rel'],
    },
    run: (input) => fromThrow(() => {
      const res = requestAstFocus(input);
      if (!res.delivered) {
        throw Object.assign(
          new Error('Ни один AST-фрейм не принял позиционирование: файл не открыт ни в одном фрейме или док AST закрыт.'),
          { code: 'NO_AST_FRAME' },
        );
      }
      return res.target;
    }),
  }],
  ['astFrame.proposeEdit', {
    description: 'Propose an edit to a file open in an AST frame. Send oldStr + newStr (preferred; oldStr must be unique) or full content for files of at most 200 lines. The patch is loaded into the frame editor as a PENDING change and is NOT written to disk: the operator reviews it and presses Save.',
    mutates: true,
    input: { rel: 'string', oldStr: 'string?', newStr: 'string?', content: 'string?', note: 'string?' },
    inputSchema: {
      type: 'object',
      properties: {
        rel: { type: 'string', description: 'File path relative to the project root.' },
        oldStr: { type: 'string', description: 'Exact unique fragment to replace, copied from astFrame.readScope output.' },
        newStr: { type: 'string', description: 'Replacement for oldStr.' },
        content: { type: 'string', description: 'Full new file content. Only accepted for files up to 200 lines; prefer oldStr/newStr.' },
        note: { type: 'string', description: 'Short explanation shown next to the pending patch.' },
      },
      required: ['rel'],
    },
    run: (input) => fromThrow(() => requireFrameHost().proposeEdit(input)),
  }],
]);

export function listCommands() {
  return Array.from(commands.entries()).map(([name, c]) => ({
    name,
    description: c.description,
    mutates: c.mutates,
    input: c.input,
    inputSchema: c.inputSchema,
    ...(c.notForChat ? { notForChat: true } : {}),
    ...(c.requiresSkill ? { requiresSkill: c.requiresSkill } : {}),
  }));
}

// The model may only call commands that are explicitly chat-reachable.
function listChatTools() {
  return listCommands()
    .filter((c) => !c.notForChat)
    .map((c) => ({
      name: c.name,
      description: c.description,
      input_schema: c.inputSchema,
    }));
}

export function useCommand(name, input) {
  const cmd = commands.get(name);
  if (!cmd) return err('UNKNOWN_COMMAND', `No such command: ${name}`);
  return cmd.run(input || {});
}
