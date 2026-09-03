// Prompt text and the hard bounds on a single chat turn.
export const CHAT_MAX_TOKENS = 16384; // request max_tokens = generation cap, not context
export const CHAT_SYSTEM = [
  'Ты — агент-помощник, управляющий холстом Excalidraw через инструменты (commands).',
  'Используй canvas.* команды, чтобы создавать узлы (addNode/addNodes), соединять их',
  'стрелками (addEdge/addEdges), выделять, перемещать (updateNode) и очищать холст.',
  'Когда пользователь просит что-то нарисовать или изменить на холсте — вызывай нужный',
  'инструмент вместо того, чтобы просто описывать это словами. Отвечай кратко по-русски.',
].join(' ');

// --- Agent runtime: pluggable skills (plan S4) -------------------------------
// Enabled skills are frozen into an immutable snapshot once per turn (see
// runChatTurn below), and their SKILL.md content is appended to the base system
// prompt. The store is set in whenReady; if it is absent (e.g. a chat-only edge),
// the prompt degrades to the base CHAT_SYSTEM with no skills appended.

// Frozen AgentRunContext per conversation id (S4.2.1). The turn holds its own
// ctx via closure; this map keeps a single source of truth keyed by an internal id
// that the model never sees, so cleanup can drop abandoned turns and any future
// IPC handler can look up the SAME frozen context a tool_use was issued under.
// The key is `${sender.id}:${conversationId}` so two windows/renderers can never
// collide on the same id and inherit another renderer's frozen context.

// Hard bounds on a single chat turn. A live model can loop calling tools forever;
// these caps (which mirror the reviewer's TOOL_BUDGET_EXHAUSTED requirement) turn
// a runaway loop into a bounded, observable error instead of an infinite hang.
export const MAX_TOOL_ROUNDS = 20; // model turns that end in >=1 tool_use kept as rounds
export const MAX_TOOL_CALLS = 50; // total tool_use calls across the turn
