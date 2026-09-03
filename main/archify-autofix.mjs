// Детерминированный авторемонт candidate по диагностикам валидатора (R5).
//
// ЗАЧЕМ: в логе валидатор САМ пишет готовое решение:
//   Label "project.*" overlaps component "command_engine" …
//   Suggested fix: labelAt [620, 358] or labelDy +24 (below); or labelAt [620, 276] …
// Раньше это решение возвращалось модели и стоило целого круга LLM (десятки
// килобайт пересылки и секунды) — и модель часто ломала другое место
// (6 подряд VALIDATION_FAILED на одном и том же классе ошибки).
//
// Здесь такие чисто геометрические правки применяются локально, без сети:
//   1) label overlaps component            → labelAt из Suggested fix (или labelDy)
//   2) composition/label-route-clearance   → разводим подпись по labelDy
//   3) слишком длинный note                → обрезаем до лимита
// Функции чистые (без fs/сети/Electron) и никогда не мутируют вход.

import { LAYOUT_LIMITS } from './archify-generation-prompt.mjs';

const LABEL_OVERLAP_RE = /Label\s+"([^"]+)"\s+overlaps component/i;
const LABEL_AT_RE = /labelAt\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/;
const LABEL_DY_RE = /labelDy\s*([+-]\d+)/;

function connectionsOf(candidate) {
  if (!candidate || typeof candidate !== 'object') return [];
  if (Array.isArray(candidate.connections)) return candidate.connections;
  if (Array.isArray(candidate.relationships)) return candidate.relationships;
  return [];
}

function connectionsKey(candidate) {
  return Array.isArray(candidate && candidate.connections) ? 'connections' : 'relationships';
}

/**
 * Применяет детерминированные правки к candidate по диагностикам/тексту ошибки.
 *
 * @param {object} candidate
 * @param {{ diagnostics?: Array<object>, error?: { message?: string } }} failure
 * @returns {{ candidate: object, applied: Array<string>, changed: boolean }}
 */
export function autofixCandidate(candidate, failure = {}) {
  const applied = [];
  if (!candidate || typeof candidate !== 'object') return { candidate, applied, changed: false };

  const key = connectionsKey(candidate);
  const next = { ...candidate, [key]: connectionsOf(candidate).map((c) => ({ ...c })) };
  const conns = next[key];
  const diagnostics = Array.isArray(failure.diagnostics) ? failure.diagnostics : [];
  const errorMessage = String((failure.error && failure.error.message) || '');
  const messages = [errorMessage, ...diagnostics.map((d) => String((d && d.message) || ''))];

  // 1) Подпись налезает на компонент — берём готовый Suggested fix.
  for (const message of messages) {
    const hit = LABEL_OVERLAP_RE.exec(message);
    if (!hit) continue;
    const label = hit[1];
    const target = conns.find((c) => String(c && c.label || '') === label);
    if (!target) continue;
    const at = LABEL_AT_RE.exec(message);
    const dy = LABEL_DY_RE.exec(message);
    if (at) {
      target.labelAt = [Number(at[1]), Number(at[2])];
      delete target.labelDx;
      delete target.labelDy;
      applied.push(`labelAt для "${label}" ← [${target.labelAt.join(', ')}]`);
    } else if (dy) {
      target.labelDy = Number(dy[1]);
      applied.push(`labelDy для "${label}" ← ${target.labelDy}`);
    } else {
      target.labelDy = LAYOUT_LIMITS.labelOffset;
      applied.push(`labelDy для "${label}" ← ${LAYOUT_LIMITS.labelOffset}`);
    }
  }

  // 2) Подпись слишком близко к чужому маршруту — разводим по вертикали.
  for (const d of diagnostics) {
    if (!d || d.code !== 'composition/label-route-clearance') continue;
    const idx = d.subject && Number.isInteger(d.subject.index) ? d.subject.index : -1;
    const byId = d.subject && d.subject.id ? conns.find((c) => c && c.id === d.subject.id) : null;
    const target = byId || (idx >= 0 ? conns[idx] : null);
    if (!target) continue;
    const current = Number.isFinite(target.labelDy) ? target.labelDy : 0;
    const step = LAYOUT_LIMITS.labelOffset;
    target.labelDy = current >= 0 ? current + step : current - step;
    delete target.labelAt;
    applied.push(`labelDy для связи "${target.id || idx}" ← ${target.labelDy} (зазор от чужого маршрута)`);
  }

  // 3) Слишком длинные note в meta.views — обрезаем по лимиту.
  const views = next.meta && Array.isArray(next.meta.views) ? next.meta.views : null;
  if (views) {
    let touched = false;
    const trimmedViews = views.map((v) => {
      if (!v || typeof v.note !== 'string' || v.note.length <= LAYOUT_LIMITS.maxNoteChars) return v;
      touched = true;
      return { ...v, note: `${v.note.slice(0, LAYOUT_LIMITS.maxNoteChars - 1)}…` };
    });
    if (touched) {
      next.meta = { ...next.meta, views: trimmedViews };
      applied.push(`note в meta.views обрезаны до ${LAYOUT_LIMITS.maxNoteChars} символов`);
    }
  }

  // 4) Слишком длинные подписи связей — частая причина налезания.
  for (const c of conns) {
    if (!c || typeof c.label !== 'string') continue;
    if (c.label.length <= LAYOUT_LIMITS.maxLabelChars) continue;
    const short = c.label.replace(/[*"]/g, '').slice(0, LAYOUT_LIMITS.maxLabelChars).trim();
    applied.push(`подпись "${c.label}" ← "${short}"`);
    c.label = short;
  }

  return { candidate: applied.length ? next : candidate, applied, changed: applied.length > 0 };
}
