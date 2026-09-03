// Chat-turn tool budget (plan S4.2 / reviewer TOOL_BUDGET_EXHAUSTED). A live model
// can loop calling tools forever, so the run loop enforces a hard cap on both the
// number of model turns that end in a tool_use (rounds) and the cumulative number
// of tool_use calls (calls). This helper is pure and small so it can be unit-tested
// in isolation — and so the conversation-invariant (a budget violation never leaves
// a dangling tool_use in the history) can be proven independently of Electron.
//
// The helper is a pure predicate: given the CURRENT counters and how many extra
// tool_use calls the NEXT model turn would add, does that exceed the budget? The
// run loop appends the assistant tool_use block only AFTER this returns false, so a
// capped turn never strands a tool_use without its matching tool_result.

export const DEFAULT_TOOL_BUDGET = { maxRounds: 20, maxCalls: 50 };

/**
 * @param {{ rounds?: number, calls?: number, nextCalls?: number }} state
 * @param {{ maxRounds?: number, maxCalls?: number }} [budget]
 * @returns {boolean} true when the NEXT model turn would exceed the budget.
 */
export function wouldExceedToolBudget(state = {}, budget = DEFAULT_TOOL_BUDGET) {
  const maxRounds = Number.isFinite(budget.maxRounds) ? Math.max(0, Math.trunc(budget.maxRounds)) : 20;
  const maxCalls = Number.isFinite(budget.maxCalls) ? Math.max(0, Math.trunc(budget.maxCalls)) : 50;
  const rounds = Number.isFinite(state.rounds) ? Math.max(0, Math.trunc(state.rounds)) : 0;
  const calls = Number.isFinite(state.calls) ? Math.max(0, Math.trunc(state.calls)) : 0;
  const nextCalls = Number.isFinite(state.nextCalls) ? Math.max(0, Math.trunc(state.nextCalls)) : 0;

  const nextRounds = rounds + (nextCalls > 0 ? 1 : 0);
  const nextTotalCalls = calls + nextCalls;

  return nextRounds > maxRounds || nextTotalCalls > maxCalls;
}
