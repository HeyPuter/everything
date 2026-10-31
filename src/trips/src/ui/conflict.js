import './conflict.css';
import { el } from './dom.js';
import { button, emptyState } from './bits.js';
import { segmented } from './fields.js';
import { openModal } from './modal.js';
import { t } from '../lib/i18n/index.js';

const STAMPS = new Set(['id', 'v', 'rev', 'upd', 'by', 'cr', 't', 'deleted']);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function display(value) {
  if (value === undefined || value === null || value === '') return t('conflict.empty');
  if (typeof value === 'boolean') return t(value ? 'conflict.yes' : 'conflict.no');
  if (typeof value === 'number') return new Intl.NumberFormat().format(value);
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

function reason(conflict, type) {
  const server = conflict.server;
  if (conflict.code === 'stale') return t('conflict.stale', { type });
  if (conflict.code === 'gone' || server?.deleted) return t('conflict.gone', { type });
  if (conflict.code === 'already_exists') return t('conflict.exists', { type });
  return t('conflict.invalid', { type });
}

const fieldOf = (path) => path.split('.')[0];

/** Top-level fields the parked patch changed whose values now differ from the server's. */
export function conflictFields(conflict) {
  const { op, local, server } = conflict;
  if (op.do || op.del || op.put || !local || !server || server.deleted) return [];
  const touched = [...new Set([...Object.keys(op.set ?? {}), ...(op.unset ?? [])].map(fieldOf))].filter((name) => !STAMPS.has(name));
  return touched.map((name) => ({ name, mine: local[name], theirs: server[name] })).filter((field) => !same(field.mine, field.theirs));
}

/**
 * The `merge` resolution: for each field kept as "mine", the parked op's own paths under it are resent against the
 * server version, so per-user (`rating.<uuid>`) and nested paths never overwrite other members' values.
 */
export function mergeChoice(op, choices) {
  const keep = (path) => choices[fieldOf(path)] === 'mine';
  const set = Object.fromEntries(Object.entries(op.set ?? {}).filter(([path]) => keep(path)).map(([path, value]) => [path, structuredClone(value)]));
  const unset = (op.unset ?? []).filter(keep);
  return Object.keys(set).length || unset.length ? { keep: 'merge', set, unset } : { keep: 'theirs' };
}

/**
 * Keep mine / Keep theirs / Merge fields for one parked conflict. `onResolve(choice)` receives
 * `{keep:'mine'|'theirs'}` or `{keep:'merge', set, unset}` and may reject to keep the dialog open.
 */
export function openConflictDialog({ conflict, typeLabel, fieldLabel, onResolve }) {
  if (typeof typeLabel !== 'function' || typeof fieldLabel !== 'function') throw new TypeError('Translated type and field labels are required');
  const type = conflict.op.do ? t('conflict.change') : typeLabel(conflict.op.t);
  const fields = conflictFields(conflict);
  const choices = Object.fromEntries(fields.map((field) => [field.name, 'mine']));
  const error = el('p.field-error', { role: 'alert', hidden: true });
  const rows = fields.map((field) => {
    const label = fieldLabel(conflict.op.t, field.name);
    const control = segmented({
      label: t('conflict.keepField', { field: label }), value: choices[field.name],
      items: [{ value: 'mine', label: t('conflict.mine') }, { value: 'theirs', label: t('conflict.theirs') }],
      onChange: (value) => { choices[field.name] = value; },
    });
    return el('div.conflict-field', { role: 'group', 'aria-label': label },
      el('h3.conflict-field-name', {}, label),
      el('dl.conflict-values', {},
        el('dt', {}, t('conflict.mine')), el('dd', {}, display(field.mine)),
        el('dt', {}, t('conflict.theirs')), el('dd', {}, display(field.theirs))),
      control.element);
  });
  const gone = conflict.code === 'gone' || conflict.server?.deleted;
  let dialog;
  const actions = [];
  async function resolve(choice, node) {
    for (const action of actions) action.disabled = true;
    node.setAttribute('aria-busy', 'true');
    error.hidden = true;
    try { await onResolve(choice); dialog.close('resolved'); }
    catch {
      error.textContent = t('conflict.failed'); error.hidden = false;
      for (const action of actions) action.disabled = false;
      node.setAttribute('aria-busy', 'false');
    }
  }
  const theirs = button(t('conflict.keepTheirs'), { onclick: () => resolve({ keep: 'theirs' }, theirs) });
  const mine = button(gone ? t('conflict.restore') : t('conflict.keepMine'), { onclick: () => resolve({ keep: 'mine' }, mine) });
  actions.push(theirs);
  if (!(gone && conflict.op.del)) actions.push(mine);
  if (fields.length) {
    const merge = button(t('conflict.merge'), { variant: 'primary', onclick: () => resolve(mergeChoice(conflict.op, choices), merge) });
    actions.push(merge);
  }
  dialog = openModal({
    title: t('conflict.title'), wide: fields.length > 0, actions,
    content: el('div.conflict', {}, el('p', {}, reason(conflict, type)), fields.length ? el('div.conflict-fields', {}, rows) : null, error),
  });
  return dialog;
}

/** The parked-conflict list for Settings → Offline. `describe(conflict)` returns translated `{type, name}`. */
export function conflictList({ conflicts, describe, onOpen, formatTime }) {
  if (typeof describe !== 'function') throw new TypeError('A translated describe() is required');
  if (!conflicts.length) return emptyState({ title: t('conflict.none'), body: t('conflict.noneBody'), icon: 'check' });
  const time = formatTime ?? ((at) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at));
  return el('ul.conflict-list', { 'aria-label': t('conflict.listLabel') }, conflicts.map((conflict) => {
    const { type, name } = describe(conflict);
    return el('li.conflict-item', {},
      el('div.conflict-item-text', {},
        el('strong', {}, name ? t('conflict.itemNamed', { type, name }) : type),
        el('span.field-hint', {}, reason(conflict, type)),
        Number.isFinite(conflict.at) ? el('span.field-hint', {}, time(conflict.at)) : null),
      button(t('conflict.review'), { size: 'sm', onclick: () => onOpen(conflict) }));
  }));
}
