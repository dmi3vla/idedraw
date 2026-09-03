// Сквозное позиционирование между AST-фреймами и ЕДИНСТВЕННЫМ чатом.
//
// Два направления, оба проходят через этот один модуль:
//   оператор → агент:  setAstScope()  — фрейм говорит чату «говорим про вот этот
//                            файл/символ/строки», чат рисует scope-чип.
//   агент → оператор:  requestAstFocus() — модель говорит «смотри сюда», фрейм
//                            сам открывает карточку и подсвечивает строки.
//
// Модуль ЧИСТЫЙ: ни DOM, ни IPC, ни canvas — только состояние и подписчики,
// поэтому его можно юнит-тестить без Electron. Фреймы регистрируют свой host,
// а командный реестр вызывает его методы — так же, как чат никогда не импортирует
// adapter.mjs напрямую.

// Один чат, НО история разделёна по фреймам: переключение таба = переключение
// треда, а не волочение предыдущего файла за собой.
export const AST_THREAD_PREFIX = 'ast:';
export const MAIN_THREAD_ID = 'main';
// Граница одного чтения агентом: сознательно маленькая, чтобы не вернуться
// к раздутым payload'ам из лога генерации (20KB → 244KB за 13 кругов).
export const SCOPE_MAX_LINES = 200;

const scopeListeners = new Set();
const focusListeners = new Set();

let scope = null;
let host = null;

function clampLine(value) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function clone(value) {
  return value === null || value === undefined ? null : JSON.parse(JSON.stringify(value));
}

/** Стабильный id треда для фрейма (один чат — несколько историй). */
export function threadIdForTab(tabId) {
  return tabId ? `${AST_THREAD_PREFIX}${tabId}` : MAIN_THREAD_ID;
}

/**
 * Приводит scope к единому виду. В scope лежат ТОЛЬКО границы и идентификаторы,
 * никогда — тело файла: текст агент берёт инструментом и только при необходимости.
 */
export function normalizeScope(input) {
  if (!input || !input.rel) return null;
  const startLine = clampLine(input.startLine);
  const endLineRaw = clampLine(input.endLine);
  const endLine = startLine && endLineRaw ? Math.max(startLine, endLineRaw) : endLineRaw;
  return Object.freeze({
    tabId: input.tabId || null,
    threadId: threadIdForTab(input.tabId),
    rel: String(input.rel),
    symbol: input.symbol ? String(input.symbol) : null,
    startLine,
    endLine,
    totalLines: clampLine(input.totalLines),
    astAnchor: clone(input.astAnchor),
    snapshot: input.snapshot || null,
    scopeLevel: input.scopeLevel || null,
    at: new Date().toISOString(),
  });
}

/** Оператор → агент: фрейм объявляет, что именно обсуждается. */
export function setAstScope(input) {
  scope = normalizeScope(input);
  emitScope();
  return scope;
}

export function clearAstScope() {
  if (!scope) return null;
  scope = null;
  emitScope();
  return null;
}

export function getAstScope() {
  return scope ? { ...scope } : null;
}

/** id треда, в который должно уйти следующее сообщение чата. */
export function activeThreadId() {
  return scope ? scope.threadId : MAIN_THREAD_ID;
}

export function onAstScopeChange(cb) {
  scopeListeners.add(cb);
  return () => scopeListeners.delete(cb);
}

function emitScope() {
  const snapshot = getAstScope();
  for (const cb of scopeListeners) cb(snapshot);
}

/**
 * Агент → оператор: попросить фреймы встать на конкретное место.
 * Возвращает число доставок: 0 означает «док AST не смонтирован», и инструмент
 * честно сообщает об этом модели вместо тихого успеха.
 */
export function requestAstFocus(target) {
  if (!target || !target.rel) return { delivered: 0, target: null };
  const focus = Object.freeze({
    tabId: target.tabId || (scope ? scope.tabId : null),
    rel: String(target.rel),
    symbol: target.symbol ? String(target.symbol) : null,
    startLine: clampLine(target.startLine),
    endLine: clampLine(target.endLine),
    note: target.note ? String(target.note).slice(0, 240) : null,
    at: new Date().toISOString(),
  });
  let delivered = 0;
  for (const cb of focusListeners) {
    try { cb(focus); delivered += 1; } catch { /* один сломанный фрейм не гасит остальные */ }
  }
  return { delivered, target: focus };
}

export function onAstFocusRequest(cb) {
  focusListeners.add(cb);
  return () => focusListeners.delete(cb);
}

/**
 * Фреймовый host — единственная точка, через которую инструменты astFrame.*
 * добираются до дока. Методы: listFrames, readScope, proposeEdit
 * (позиционирование идёт не через host, а широковещательно через requestAstFocus).
 */
export function registerAstFrameHost(next) {
  host = next || null;
  return () => { if (host === next) host = null; };
}

export function getAstFrameHost() {
  return host;
}
