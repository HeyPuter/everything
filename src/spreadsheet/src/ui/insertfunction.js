/**
 * Insert Function and Function Arguments dialogs: find a function by search
 * or category, read its signature and description, then fill its arguments
 * one field at a time with each argument's value and the formula's result
 * previewed for the active cell.
 */

import { el, fieldId, isComposing } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { FUNCTION_NAMES, FUNCTIONS } from '../core/formula/functions.js';
import { signatureFor } from '../core/formula/hints.js';
import { functionCategories, PRIMARY_CATEGORIES, MORE_CATEGORIES } from '../core/formula/categories.js';
import { evaluateParts, describeValue } from '../core/formula/print.js';
import { recentFunctionNames } from './recent-functions.js';

// Functions that reach out to the network or an AI model are not run just to preview them.
const NO_PREVIEW = /\b(AI|IMPORT\w*|GOOGLETRANSLATE|DETECTLANGUAGE|TRANSLATE|IMAGE|WEBSERVICE|FILTERXML)\s*\(/i;
const MAX_ARGS = 30;

/** The arguments a function takes, from its documented signature or else its arity. */
export function functionParams(name) {
  const sig = signatureFor(name);
  if (sig.params && sig.params !== '...') {
    const list = sig.params.split(/,\s*/).map(s => s.trim()).filter(Boolean);
    const repeat = list.includes('...');
    const params = list.filter(p => p !== '...' && !/^\[?\.\.\.\]?$/.test(p)).map(p => {
      const optional = /^\[.*\]$/.test(p);
      return { name: p.replace(/^\[|\]$/g, ''), optional };
    });
    return { params, repeat };
  }
  const spec = FUNCTIONS[name] || {};
  const min = Number.isInteger(spec.minArgs) ? spec.minArgs : 1;
  const max = Number.isInteger(spec.maxArgs) ? Math.min(spec.maxArgs, 8) : null;
  const count = max ?? Math.max(min, 1);
  return {
    params: Array.from({ length: count }, (_, i) => ({ name: `value${i + 1}`, optional: i >= min })),
    repeat: max == null,
  };
}

/** Join the filled arguments, dropping trailing empty optional ones. */
export function buildCall(name, values) {
  const args = [...values];
  while (args.length && !String(args.at(-1) ?? '').trim()) args.pop();
  return `${name}(${args.map(v => String(v ?? '').trim()).join(', ')})`;
}

/** A value as a preview shows it: arrays and ranges in braces, rows split by semicolons, as a formula writes them. */
function previewText(value) {
  const rows = value?.range ? value.values : Array.isArray(value) ? (Array.isArray(value[0]) ? value : [value]) : null;
  if (!rows) return describeValue(value).split('\n')[0];
  if (rows.length === 1 && rows[0].length === 1) return previewText(rows[0][0]);
  const text = `{${rows.slice(0, 20).map(row => row.slice(0, 20).map(v => describeValue(v)).join(',')).join(';')}${rows.length > 20 ? ';…' : ''}}`;
  return text.length > 80 ? `${text.slice(0, 79)}…}` : text;
}

function preview(ctx, text) {
  const formula = String(text || '').trim();
  if (!formula) return '';
  if (NO_PREVIEW.test(formula)) return '(calculated when entered)';
  const a = ctx.active();
  const context = ctx.wb.contextFor(ctx.sheetId(), a.r, a.c);
  try {
    let { error, parts } = evaluateParts(formula, context);
    // A lone literal or reference is not a part of its own; read it through a call that returns it unchanged.
    if (!error && !parts.length) ({ error, parts } = evaluateParts(`IF(TRUE,${formula})`, context));
    if (error || !parts.length) return 'Invalid';
    return previewText(parts.at(-1).value);
  } catch {
    return 'Invalid';
  }
}

/** Insert Function: search or browse, then OK opens Function Arguments for the chosen function. */
export function openInsertFunctionDialog(ctx, { onPick } = {}) {
  const categories = functionCategories();
  const search = el('input.input', { type: 'search', 'aria-label': 'Search for a function', placeholder: 'Type a brief description of what you want to do', autocomplete: 'off', spellcheck: false });
  const go = el('button.btn', { type: 'button' }, 'Go');
  const category = el('select.select', { 'aria-label': 'Or select a category' },
    el('option', { value: 'recent' }, 'Most Recently Used'), el('option', { value: 'all' }, 'All'),
    ...[...PRIMARY_CATEGORIES, ...MORE_CATEGORIES].filter(c => categories.get(c)?.length).map(c => el('option', { value: c }, c)));
  const listId = fieldId('fn-list');
  const list = el('div.fn-dialog-list', { role: 'listbox', id: listId, 'aria-label': 'Select a function', tabindex: 0 });
  const signature = el('div.fn-dialog-signature');
  const description = el('p.fn-dialog-description');
  let names = [];
  let selected = 0;
  let query = '';

  const matches = () => {
    if (query) {
      const q = query.toUpperCase();
      const words = q.split(/\s+/).filter(Boolean);
      return FUNCTION_NAMES.filter(n => n.includes(q) || words.every(w => n.includes(w) || signatureFor(n).description.toUpperCase().includes(w)));
    }
    if (category.value === 'recent') return recentFunctionNames().filter(n => FUNCTION_NAMES.includes(n));
    if (category.value === 'all') return [...FUNCTION_NAMES].sort();
    return categories.get(category.value) || [];
  };
  const describe = () => {
    const name = names[selected];
    signature.textContent = name ? `${name}(${signatureFor(name).params === '...' ? functionParams(name).params.map(p => p.optional ? `[${p.name}]` : p.name).join(', ') + (functionParams(name).repeat ? ', ...' : '') : signatureFor(name).params})` : '';
    description.textContent = name ? signatureFor(name).description || 'No description is available for this function.' : 'No functions match. Try other words or another category.';
    for (const [i, option] of [...list.children].entries()) {
      option.setAttribute('aria-selected', String(i === selected));
      if (i === selected) { list.setAttribute('aria-activedescendant', option.id); option.scrollIntoView?.({ block: 'nearest' }); }
    }
  };
  const render = () => {
    names = matches();
    selected = Math.min(selected, Math.max(0, names.length - 1));
    list.replaceChildren(...names.map((name, i) => el('div.fn-dialog-option', {
      role: 'option', id: `${listId}-${i}`, 'aria-selected': 'false',
      onclick: () => { selected = i; describe(); },
      ondblclick: () => { selected = i; ok(); },
    }, name)));
    describe();
  };
  const ok = () => {
    const name = names[selected];
    if (!name) return;
    modal.close();
    onPick?.(name);
  };
  const runSearch = () => { query = search.value.trim(); selected = 0; render(); };
  go.addEventListener('click', runSearch);
  // The list follows the search as it is typed: it kept the functions listed before, so Down and Enter
  // after typing "vlookup" inserted whatever function headed the old list.
  const follow = (e) => { if (!e.isComposing && search.value.trim() !== query) runSearch(); };
  search.addEventListener('input', follow);
  search.addEventListener('compositionend', follow);
  search.addEventListener('keydown', e => {
    if (isComposing(e)) return;
    if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); if (search.value.trim() !== query) runSearch(); list.focus(); }
  });
  category.addEventListener('change', () => { query = ''; search.value = ''; selected = 0; render(); });
  list.addEventListener('keydown', e => {
    if (isComposing(e)) return;
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 }[e.key];
    if (step) { e.preventDefault(); selected = Math.max(0, Math.min(names.length - 1, selected + step)); describe(); return; }
    if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); selected = e.key === 'Home' ? 0 : names.length - 1; describe(); return; }
    if (e.key === 'Enter') { e.preventDefault(); ok(); return; }
    // Typing a letter jumps to the first function starting with it, as in a list box.
    if (e.key.length === 1 && /\w/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const at = names.findIndex(n => n.startsWith(e.key.toUpperCase()));
      if (at >= 0) { e.preventDefault(); selected = at; describe(); }
    }
  });
  const content = el('form.fn-dialog', { onsubmit: e => { e.preventDefault(); ok(); } },
    el('label.field', {}, el('span.field-label', {}, 'Search for a function:'), el('div.row', {}, search, go)),
    el('label.field', {}, el('span.field-label', {}, 'Or select a category:'), el('div.select-wrap', {}, category)),
    el('div.field', {}, el('span.field-label', { id: `${listId}-label` }, 'Select a function:'), list),
    signature, description,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
  list.setAttribute('aria-labelledby', `${listId}-label`);
  const modal = openModal({ title: 'Insert Function', content, className: 'fn-dialog-panel', initialFocus: search, onClose: () => ctx.grid?.focus?.() });
  render();
  return modal;
}

/**
 * Function Arguments: one field per argument with its value, and the formula's result, previewed live.
 * `apply(callText)` enters the finished call; `initial` fills the first fields.
 */
export function openFunctionArgumentsDialog(ctx, name, { apply, initial = [] } = {}) {
  const { params, repeat } = functionParams(name);
  const rows = el('div.fn-args-rows');
  const fields = [];
  const result = el('output.fn-args-result');
  const { alert: error, refuse, clear } = fieldAlert('fn-args');
  const update = () => {
    for (const f of fields) f.value.textContent = f.input.value.trim() ? `= ${preview(ctx, f.input.value)}` : '';
    const call = buildCall(name, fields.map(f => f.input.value));
    result.textContent = `Formula result = ${preview(ctx, call)}`;
  };
  const addField = (param, index) => {
    const id = fieldId('fn-arg');
    const input = el('input.input', { id, type: 'text', autocomplete: 'off', spellcheck: false, 'aria-label': param.name, value: initial[index] ?? '' });
    const value = el('span.fn-args-value', { 'aria-live': 'off' });
    const label = el('label.fn-args-label', { for: id, className: `fn-args-label${param.optional ? '' : ' required'}` }, param.name);
    input.addEventListener('input', () => {
      clear();
      // A function that repeats its last argument offers another field once the last one is used, up to the argument limit.
      if (repeat && fields.at(-1)?.input === input && input.value.trim() && fields.length < MAX_ARGS) {
        const base = params.at(-1)?.name.replace(/\d+$/, '') || 'value';
        addField({ name: `${base}${fields.length + 1}`, optional: true }, fields.length);
      }
      update();
    });
    rows.append(el('div.fn-args-row', {}, label, input, value));
    fields.push({ input, value, param });
  };
  params.forEach(addField);
  if (repeat && !params.length) addField({ name: 'value1', optional: false }, 0);
  if (repeat && params.length && initial.length > params.length) for (let i = params.length; i < initial.length; i++) addField({ name: `value${i + 1}`, optional: true }, i);
  const submit = e => {
    e?.preventDefault();
    const missing = fields.find(f => !f.param.optional && !f.input.value.trim());
    if (missing && fields.some(f => f.input.value.trim())) return refuse(missing.input, `${missing.param.name} is required`);
    modal.close();
    apply?.(buildCall(name, fields.map(f => f.input.value)));
  };
  const content = el('form.fn-args', { onsubmit: submit },
    el('div.fn-args-name', {}, name), rows,
    el('p.fn-dialog-description', {}, signatureFor(name).description || ''),
    result, error,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
  const modal = openModal({ title: 'Function Arguments', content, className: 'fn-args-panel', initialFocus: fields[0]?.input, onClose: () => ctx.grid?.focus?.() });
  update();
  return modal;
}
