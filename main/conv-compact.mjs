// Сжатие истории хода (рефакторинг R5, память/производительность).
//
// ЗАЧЕМ: в логе реальной генерации тело запроса росло линейно:
//   round 1  → 20 918 байт
//   round 6  → 186 256 байт
//   round 13 → 244 605 байт
// Причина — вся история (все project.readFile, все повторные schema/example и все
// candidate/diagnostics) копится в памяти и пересылается целиком каждый круг.
// Это O(n²) по трафику/токенам и линейный рост RSS на длинных ходах.
//
// ИНВАРИАНТЫ (важно для Anthropic/OpenAI-шлюзов):
//   - структура сообщений НЕ меняется: ни один tool_use/tool_result не удаляется
//     и не переставляется, парность tool_use ↔ tool_result сохраняется;
//   - урезается только ТЕКСТ СТАРЫХ tool_result (свежие круги остаются целыми);
//   - всегда создаётся НОВЫЙ массив (исходный conv не мутируется), чтобы
//     последующие walkToolCalls()/lastAuthorResult() видели полную историю.

export const COMPACT_DEFAULTS = Object.freeze({
  keepFullResults: 4, // сколько последних tool_result оставить без изменений
  maxResultChars: 2000, // порог урезания старого tool_result
  headChars: 700, // сколько оставить в начале
  tailChars: 300, // и в конце (там обычно закрывающий JSON/итог)
});

const isToolResultBlock = (b) => b && typeof b === 'object' && b.type === 'tool_result';

/**
 * Подсчёт размера истории в байтах (для трассировки).
 * @param {Array<object>} conv
 * @returns {number}
 */
export function conversationBytes(conv) {
  try {
    return Buffer.byteLength(JSON.stringify(conv || []), 'utf8');
  } catch {
    return 0;
  }
}

/**
 * Возвращает копию истории, в которой старые крупные tool_result урезаны.
 *
 * @param {Array<object>} conv
 * @param {{ keepFullResults?: number, maxResultChars?: number, headChars?: number, tailChars?: number }} [opts]
 * @returns {{ messages: Array<object>, trimmed: number, savedChars: number }}
 */
export function compactConversation(conv, opts = {}) {
  const cfg = { ...COMPACT_DEFAULTS, ...opts };
  const messages = Array.isArray(conv) ? conv : [];

  // Сначала найдём индексы всех tool_result-блоков в порядке появления,
  // чтобы точно оставить нетронутыми ровно keepFullResults последних.
  const coords = [];
  messages.forEach((m, mi) => {
    if (!m || !Array.isArray(m.content)) return;
    m.content.forEach((b, bi) => {
      if (isToolResultBlock(b)) coords.push([mi, bi]);
    });
  });
  const protectedFrom = Math.max(0, coords.length - Math.max(0, cfg.keepFullResults));
  const protectedSet = new Set(coords.slice(protectedFrom).map(([mi, bi]) => `${mi}:${bi}`));

  let trimmed = 0;
  let savedChars = 0;

  const out = messages.map((m, mi) => {
    if (!m || !Array.isArray(m.content)) return m;
    let changed = false;
    const content = m.content.map((b, bi) => {
      if (!isToolResultBlock(b) || protectedSet.has(`${mi}:${bi}`)) return b;
      const text = typeof b.content === 'string' ? b.content : null;
      if (text === null || text.length <= cfg.maxResultChars) return b;
      changed = true;
      trimmed += 1;
      const head = text.slice(0, cfg.headChars);
      const tail = text.slice(-cfg.tailChars);
      const omitted = text.length - head.length - tail.length;
      savedChars += omitted;
      return {
        ...b,
        content: `${head}\n…[свёрнуто ${omitted} символов старого результата; перечитай файл, если нужны детали]…\n${tail}`,
      };
    });
    return changed ? { ...m, content } : m;
  });

  return { messages: out, trimmed, savedChars };
}
