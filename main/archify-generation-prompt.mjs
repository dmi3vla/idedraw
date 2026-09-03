// Prompt-раскладка для генерации холста под проект (рефакторинг R5).
//
// ЗАЧЕМ ЭТОТ МОДУЛЬ
// Раньше текст запроса на генерацию был вписан прямо в ipcMain.handle
// ('archify:generate') в main.mjs одной длинной конкатенацией. Из-за этого:
//   - его нельзя было юнит-тестировать;
//   - в нём не было правил, которые реально валит archify-валидатор
//     (label/label-route clearance) — по логу это 6 отказов подряд:
//       * Label "project.*" overlaps component "command_engine"
//       * [composition/label-route-clearance] ... is 0px from ... (minimum 4px)
//   - модель тратила круги на повторные вызовы (archify.getSkillFile schema
//     трижды, 14 project.readFile), payload дорос с 20KB до 244KB за 13 кругов.
//
// Здесь собран один структурированный запрос: жёсткий порядок инструментов,
// бюджет чтений, геометрические инварианты раскладки, правила подписей и
// протокол repair. Плюс компактная выжимка диагностик (summarizeDiagnostics),
// которую run-loop добавляет в repair-подсказку вместо дословного JSON.

// Геометрические константы раскладки. Держим в одном месте, чтобы текст
// запроса и тесты не расходились.
export const LAYOUT_LIMITS = Object.freeze({
  minComponents: 8,
  maxComponents: 10,
  maxConnections: 9,
  colGap: 90, // минимальный горизонтальный зазор между узлами одного ряда
  rowStep: 160, // минимальный шаг между рядами
  labelClearance: 8, // запас подписи до чужого узла/маршрута (валидатор просит >=4)
  labelOffset: 24, // минимальный labelDy, который уводит подпись с узла
  maxLabelChars: 14,
  maxNoteChars: 140,
  maxReadFiles: 8,
  maxReadLines: 400,
});

const L = LAYOUT_LIMITS;

// Правила подписей связей — единственная причина всех VALIDATION-отказов в логе.
const LABEL_RULES = [
  `подпись связи <= ${L.maxLabelChars} символов, без кавычек и без "*" ("project.*" -> "project");`,
  `подпись не должна попадать в прямоугольник ЛЮБОГО компонента: держи запас >= ${L.labelClearance}px, при сомнении ставь labelDy ${L.labelOffset} (ниже) или -${L.labelOffset + 34} (выше);`,
  `подпись не должна подходить ближе ${L.labelClearance}px к чужому маршруту (валидатор считает минимум 4px и падает на 0px) — если две связи идут по одному коридору, подписи разнеси: одной labelDy +${L.labelOffset}, другой -${L.labelOffset};`,
  'подпись ставится на СВОБОДНЫЙ длинный сегмент (labelSegment), а не на угол/стык маршрутов;',
  'если у двух связей общий источник или общий приёмник — подписывай только одну, вторую оставляй без подписи;',
  'labelAt указывай только когда labelDx/labelDy/labelSegment не помогают.',
];

const TOOL_ORDER = [
  'project.getStatus и project.getSnapshot — один раз;',
  'project.listFiles — один раз;',
  `project.readFile — только по релевантным файлам (точка входа, bridge/IPC, слой холста, слой чата, слой проекта), максимум ${L.maxReadFiles} файлов, до ${L.maxReadLines} строк;`,
  'archify.getSkillFile kind=schema и kind=example — РОВНО по одному вызову на каждый; результаты уже у тебя в истории, повторно не запрашивай;',
  'archify.author (type=architecture, quality=showcase) — после того как собран candidate.',
];

/**
 * Основной запрос на генерацию архитектуры проекта.
 * @param {{ projectName?: string|null, snapshot?: string|null }} [opts]
 * @returns {string}
 */
export function buildArchifyGenerationPrompt(opts = {}) {
  const projectName = opts.projectName ? String(opts.projectName) : null;
  const snapshot = opts.snapshot ? String(opts.snapshot).slice(0, 16) : null;

  const head = [
    'ЗАДАЧА: заново изучи привязанный проект и собери его АКТУАЛЬНУЮ архитектуру',
    'через включённый Archify skill.',
    projectName ? `Проект: ${projectName}.` : '',
    snapshot ? `Снимок проекта: ${snapshot}.` : '',
  ].filter(Boolean).join(' ');

  return [
    head,
    '',
    'ПОРЯДОК ИНСТРУМЕНТОВ (не отклоняйся, не дублируй вызовы — каждый повтор',
    'одного и того же вызова только раздувает контекст и ничего не добавляет):',
    ...TOOL_ORDER.map((s, i) => `${i + 1}. ${s}`),
    '',
    'СОДЕРЖАНИЕ candidate:',
    `- ${L.minComponents}-${L.maxComponents} компонентов, не больше ${L.maxConnections} связей;`,
    '- одна главная цепочка слева направо (UI -> мост/IPC -> движок -> данные);',
    '- каждый компонент отражает реальный файл/слой, который ты прочитал; не выдумывай слои;',
    `- note в meta.views <= ${L.maxNoteChars} символов.`,
    '',
    'ГЕОМЕТРИЯ:',
    `- узлы выравнивай в чистые ряды: горизонтальный зазор >= ${L.colGap}px, шаг рядов >= ${L.rowStep}px;`,
    '- связь не должна пересекать чужие узлы — если пересекает, переставь соседа рядом, а не рисуй объезд;',
    '- маршруты оставляй автоматическими (без via), пока валидатор не потребует иного.',
    '',
    'ПОДПИСИ СВЯЗЕЙ (именно на них падала валидация):',
    ...LABEL_RULES.map((s) => `- ${s}`),
    '',
    'ПРОТОКОЛ REPAIR (обязателен):',
    '- если archify.author вернул ok:false — НЕ завершай ход и НЕ переписывай candidate целиком;',
    '- правь ТОЛЬКО те объекты, что названы в error/diagnostics, дословно применяя',
    '  "Suggested fix" (labelAt / labelDx / labelDy / labelSegment) из диагностики;',
    '- повторный вызов archify.author делай с тем же runToken из результата;',
    '- при REPAIR_BUDGET_EXHAUSTED — новый вызов archify.author БЕЗ runToken;',
    '- ход завершай только после ok:true.',
    '',
    'ЗАПРЕЩЕНО: вызывать canvas.* команды, писать в файлы проекта, придумывать',
    'компоненты без подтверждения из прочитанных файлов, возвращать текстовое',
    'описание вместо вызова archify.author.',
  ].join('\n');
}

/**
 * Подсказка-продолжение, когда модель молча завершила ход без успешного author.
 * @param {{ attempts?: number, diagnostics?: Array<object>, error?: object }} [state]
 */
export function buildRepairNudge(state = {}) {
  const attempts = Number.isFinite(state.attempts) ? state.attempts : 0;
  const summary = summarizeDiagnostics(state.diagnostics, state.error);
  return [
    `Генерация не завершена: успешного archify.author не было (попыток: ${attempts}).`,
    'Продолжи ЭТОТ ЖЕ ход.',
    summary ? `Что именно не прошло валидацию:\n${summary}` : '',
    'Правь только названные места, дословно применяя Suggested fix.',
    `Инварианты: одна главная цепочка, <= ${L.maxConnections} связей, зазоры >= ${L.colGap}px,`,
    `подписи <= ${L.maxLabelChars} символов и >= ${L.labelClearance}px от чужих узлов и маршрутов,`,
    `note <= ${L.maxNoteChars} символов.`,
    'Вызови archify.author повторно (repair — тот же runToken; при REPAIR_BUDGET_EXHAUSTED — без runToken).',
    'Завершай ход только после ok:true.',
  ].filter(Boolean).join(' ');
}

/**
 * Компактная выжимка диагностик валидатора: по строке на проблему, с сохранением
 * кода, субъекта и Suggested fix. Нужна, чтобы не переливать в контекст
 * многокилобайтный JSON diagnostics (в логе он повторялся дважды за круг).
 *
 * @param {Array<object>} diagnostics
 * @param {object} [error]
 * @param {number} [limit]
 * @returns {string}
 */
export function summarizeDiagnostics(diagnostics, error, limit = 6) {
  const rows = [];
  for (const d of Array.isArray(diagnostics) ? diagnostics.slice(0, limit) : []) {
    if (!d || typeof d !== 'object') continue;
    const code = d.code ? String(d.code) : 'validation';
    const subject = d.subject && typeof d.subject === 'object'
      ? [d.subject.collection, d.subject.id || d.subject.from, d.subject.to].filter(Boolean).join(' ')
      : '';
    const message = String(d.message || '').replace(/\s+/g, ' ').trim();
    const fix = firstSuggestedFix(d, message);
    rows.push(`- [${code}]${subject ? ` ${subject}:` : ''} ${clip(message, 220)}${fix ? ` | fix: ${clip(fix, 90)}` : ''}`);
  }
  if (!rows.length && error && error.message) {
    rows.push(`- [${error.code || 'VALIDATION'}] ${clip(String(error.message).replace(/\s+/g, ' '), 260)}`);
  }
  return rows.join('\n');
}

function firstSuggestedFix(d, message) {
  if (Array.isArray(d.supportedFixes) && d.supportedFixes.length) return String(d.supportedFixes[0]);
  const m = /Suggested fix:\s*([^\n]+)/.exec(message || '');
  return m ? m[1] : '';
}

function clip(text, max) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
