// Token budgets for what is sent to the model. Estimates use about four characters per token, which overestimates
// for the JSON sent here; the budgets leave room for that.

export const BUDGET = Object.freeze({
  context: 2500, // trip snapshot sent with each user message
  result: 3000, // one tool result
  history: 30000, // the whole transcript per request
});

export const estimateTokens = (text) => Math.ceil(String(text ?? '').length / 4);

/**
 * JSON for the model with `<` and `>` escaped, so text inside trip data can never close or open the tags that mark
 * it as data. Still valid JSON; the model reads the same characters.
 */
export function encode(data) {
  return JSON.stringify(data ?? null).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
export const tokensOf = (data) => estimateTokens(encode(data));

/** The longest prefix of `items` for which `wrap(prefix, omitted)` fits in `budget` tokens (binary search). */
export function fitList(items, budget, wrap) {
  if (tokensOf(wrap(items, 0)) <= budget) return wrap(items, 0);
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (tokensOf(wrap(items.slice(0, mid), items.length - mid)) <= budget) low = mid; else high = mid - 1;
  }
  return wrap(items.slice(0, low), items.length - low);
}

/**
 * The trip snapshot at the most detailed level that fits: days with their items, then days with counts and first
 * names, then counts only, then as many days as fit. Big trips are summarized; the model reads the rest with tools.
 */
export function tripContext(reader, { budget = BUDGET.context, focusDay = null } = {}) {
  const summary = reader.summary();
  const focus = focusDay ? reader.day(focusDay) : null;
  const base = { trip: summary, ...(focus ? { userIsViewing: focus } : {}) };
  const levels = [
    () => ({ ...base, detail: 'full', days: reader.days('full') }),
    () => ({ ...base, detail: 'brief', days: reader.days('brief') }),
    () => ({ ...base, detail: 'counts', days: reader.days('count') }),
  ];
  for (const level of levels) {
    const value = level();
    if (tokensOf(value) <= budget) return value;
  }
  const trimmed = { ...base, detail: 'counts' };
  if (tokensOf({ ...trimmed, days: [] }) > budget) delete trimmed.userIsViewing;
  return fitList(reader.days('count'), budget, (days, omitted) => ({ ...trimmed, days, ...(omitted ? { daysOmitted: omitted, hint: 'Use get_days with from to read later days.' } : {}) }));
}

/**
 * Cuts a tool result to the budget: its `items` (or `days`) list is shortened and marked so the model can page on.
 * Anything else that is still too large is replaced by an error the model can act on.
 */
export function capResult(value, budget = BUDGET.result) {
  if (tokensOf(value) <= budget) return value;
  for (const key of ['items', 'days', 'results']) {
    if (!Array.isArray(value?.[key])) continue;
    const fitted = fitList(value[key], budget, (list, omitted) => ({ ...value, [key]: list, ...(omitted ? { truncated: omitted, hint: 'Shortened to fit; ask for fewer with offset and limit.' } : {}) }));
    if (tokensOf(fitted) <= budget) return fitted;
  }
  return { error: 'result_too_large', hint: 'Ask for less, for example one day or a smaller limit.' };
}
