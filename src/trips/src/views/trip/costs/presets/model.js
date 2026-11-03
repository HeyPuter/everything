// Named split weights per trip (`splitPreset` entities, `{name, weights: {who: n}}`). Pure helpers for the expense form
// and the preset dialog.
import { DomainError } from '../../../../shared/errors.js';
import { isWeight } from '../../../../shared/money.js';
import { isId, isUuid } from '../../../../shared/ids.js';
import { parseDecimal } from '../../../../lib/costs/input.js';

export const PRESET_LIMITS = Object.freeze({ name: 100, people: 50 });

/** A weight as stored: a safe integer or a canonical decimal string. */
function stored(decimal) {
  return /^\d+$/.test(decimal) && Number.isSafeInteger(Number(decimal)) ? Number(decimal) : decimal;
}

function scaled(value) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d+(\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return { n: BigInt(whole + fraction), d: fraction.length };
}

/** Exact comparison of two weights (`1`, `'1.0'` and `'1'` are equal). */
export function sameWeight(a, b) {
  const x = scaled(a); const y = scaled(b);
  if (!x || !y) return false;
  const d = Math.max(x.d, y.d);
  return x.n * 10n ** BigInt(d - x.d) === y.n * 10n ** BigInt(d - y.d);
}

const positive = (value) => isWeight(value) && !sameWeight(value, 0);

/** Typed text as a stored weight; blank is 0. Returns null for anything that is not a non-negative number. */
export function parseWeight(text, locale) {
  if (typeof text !== 'string' || !text.trim()) return 0;
  const decimal = parseDecimal(text, locale);
  if (decimal === null || decimal.startsWith('-')) return null;
  const value = stored(decimal);
  return isWeight(value) ? value : null;
}

/**
 * A preset ready to store, from a name and `[[who, typed or stored weight]]`. Zero weights are left out (absent means
 * not in the split). Throws `preset_name`, `preset_weight` (with `who`), `preset_empty` or `preset_people`.
 */
export function buildPreset(name, entries, { locale } = {}) {
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!clean || [...clean].length > PRESET_LIMITS.name) throw new DomainError('preset_name');
  const weights = {};
  for (const [who, raw] of entries) {
    if (!isId(who) && !isUuid(who)) continue;
    const value = typeof raw === 'string' ? parseWeight(raw, locale) : isWeight(raw) ? raw : null;
    if (value === null) throw Object.assign(new DomainError('preset_weight'), { who });
    if (positive(value)) weights[who] = value;
  }
  const count = Object.keys(weights).length;
  if (!count) throw new DomainError('preset_empty');
  if (count > PRESET_LIMITS.people) throw new DomainError('preset_people');
  return { name: clean, weights };
}

/**
 * What applying a preset to the people on an expense does: those with a positive weight take part with it, everyone
 * else on the expense is left out, and people in the preset who are not on the expense (removed members) are skipped.
 * Returns `{participants: [who] (roster order), weights: Map<who, weight>, missing: [who], excluded: [who]}`.
 */
export function applyPreset(preset, roster) {
  const weights = new Map();
  const participants = [];
  const excluded = [];
  const listed = Object.entries(preset?.weights ?? {}).filter(([, value]) => positive(value));
  const byWho = new Map(listed);
  for (const who of roster) {
    if (byWho.has(who)) { participants.push(who); weights.set(who, byWho.get(who)); } else excluded.push(who);
  }
  const missing = listed.map(([who]) => who).filter((who) => !roster.includes(who));
  return { participants, weights, missing, excluded };
}

/** Weights from the form's shares rows (`[[who, typed text]]` for participants), or null when one is not a number. */
export function weightsFromRows(rows, locale) {
  const weights = {};
  for (const [who, text] of rows) {
    const value = parseWeight(text, locale);
    if (value === null) return null;
    if (positive(value)) weights[who] = value;
  }
  return weights;
}

/** The preset whose positive weights equal `weights` exactly, or null. */
export function matchPreset(presets, weights) {
  const wanted = Object.entries(weights ?? {}).filter(([, value]) => positive(value));
  if (!wanted.length) return null;
  return presets.find((preset) => {
    const own = Object.entries(preset.weights ?? {}).filter(([, value]) => positive(value));
    return own.length === wanted.length && wanted.every(([who, value]) => Object.hasOwn(preset.weights, who) && sameWeight(preset.weights[who], value));
  }) ?? null;
}

/** Presets by name, then id, for menus. */
export function sortPresets(list, locale) {
  const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
  return [...list].sort((a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
