// Чистая часть предложенных агентом правок. Здесь нет ни DOM, ни IPC — только
// вычисление нового текста из текущего. Запись на диск остаётся за оператором:
// агент предлагает, фрейм показывает, человек жмёт «Сохранить» и только тогда
// уходит штатный writeAstFile с expectedSnapshot.

// Целиком переписывать разрешаем только маленькие файлы: для 1000-строчного
// adapter.mjs модель начнёт врать в нетронутых местах.
export const FULL_REWRITE_MAX_LINES = 200;

function countLines(text) {
  return text ? text.split('\n').length : 0;
}

/**
 * @param {string} current текущий текст файла в редакторе
 * @param {{ oldStr?: string, newStr?: string, content?: string }} proposal
 * @returns {{ ok: boolean, value?: string, mode?: 'patch'|'full', error?: { code: string, message: string } }}
 */
export function applyProposedEdit(current, proposal = {}) {
  const base = typeof current === 'string' ? current : '';
  const { oldStr, newStr, content } = proposal;

  if (typeof oldStr === 'string' && oldStr.length > 0) {
    if (typeof newStr !== 'string') {
      return { ok: false, error: { code: 'BAD_INPUT', message: 'newStr обязателен вместе с oldStr.' } };
    }
    const first = base.indexOf(oldStr);
    if (first < 0) {
      return { ok: false, error: { code: 'ANCHOR_NOT_FOUND', message: 'Якорь oldStr не найден в текущем тексте файла.' } };
    }
    if (base.indexOf(oldStr, first + oldStr.length) >= 0) {
      return { ok: false, error: { code: 'ANCHOR_NOT_UNIQUE', message: 'Якорь oldStr встречается несколько раз — расширьте контекст.' } };
    }
    return {
      ok: true,
      mode: 'patch',
      value: base.slice(0, first) + newStr + base.slice(first + oldStr.length),
    };
  }

  if (typeof content === 'string') {
    const lines = countLines(base);
    if (lines > FULL_REWRITE_MAX_LINES) {
      return {
        ok: false,
        error: {
          code: 'FULL_REWRITE_TOO_LARGE',
          message: `Файл из ${lines} строк переписывать целиком нельзя (лимит ${FULL_REWRITE_MAX_LINES}). Пришлите oldStr/newStr.`,
        },
      };
    }
    return { ok: true, mode: 'full', value: content };
  }

  return { ok: false, error: { code: 'BAD_INPUT', message: 'Нужен либо oldStr+newStr, либо content.' } };
}

/** Компактная сводка изменения для строки статуса в редакторе. */
export function describeEdit(before, after) {
  const from = countLines(before);
  const to = countLines(after);
  const delta = to - from;
  const sign = delta > 0 ? `+${delta}` : String(delta);
  return delta === 0 ? `строк: ${to}` : `строк: ${to} (${sign})`;
}

/**
 * Номера строк выделенного фрагмента в textarea — так кнопка «Спросить чат»
 * из редактора отдаёт агенту границы, а не тело файла.
 * Строки 1-based; отсчёт относительный, baseLine сдвигает в координаты файла.
 */
export function selectionToLineRange(text, selectionStart, selectionEnd, baseLine = 1) {
  const body = typeof text === 'string' ? text : '';
  const start = Math.max(0, Math.min(body.length, Number(selectionStart) || 0));
  const end = Math.max(start, Math.min(body.length, Number(selectionEnd) || 0));
  if (end === start) return null;
  const base = Math.max(1, Math.trunc(Number(baseLine)) || 1);
  const startLine = base + countLines(body.slice(0, start)) - 1;
  const endLine = base + countLines(body.slice(0, end)) - 1;
  return { startLine, endLine };
}
