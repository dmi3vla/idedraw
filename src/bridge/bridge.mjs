// This is the ENTIRE surface chat is allowed to touch. Chat never imports
// canvas/adapter.mjs or project/project-store.mjs directly — only this file.
// That indirection is what keeps chat independent: swap what's behind the
// bridge (a different canvas engine, a real project backend) and chat
// doesn't change.

import { listCommands, useCommand } from './command-registry.mjs';
import { query } from './query-handler.mjs';
import { onContextChange, getSelection } from './context-store.mjs';
import {
  getAstScope, setAstScope, clearAstScope, onAstScopeChange,
  requestAstFocus, onAstFocusRequest, activeThreadId, threadIdForTab,
} from './ast-scope-store.mjs';

export const bridge = {
  list_commands: () => ({ ok: true, data: { commands: listCommands() } }),
  use_command: (name, input) => useCommand(name, input),
  query: (request) => query(request),
  getSelection,
  onContextChange,
  // Сквозное позиционирование между AST-фреймами и ЕДИНСТВЕННЫМ чатом.
  // Оператор → агент: scope (какой файл/символ/строки обсуждаются).
  // Агент → оператор: focus (куда встать фрейму).
  // Чат читает это только отсюда — он по-прежнему не знает ни про DOM дока,
  // ни про projectBridge.
  getAstScope,
  setAstScope,
  clearAstScope,
  onAstScopeChange,
  requestAstFocus,
  onAstFocusRequest,
  // Один чат, но история разделена по фреймам: id треда = ast:<tabId>.
  activeThreadId,
  threadIdForTab,
};
