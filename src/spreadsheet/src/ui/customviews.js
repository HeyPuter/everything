/**
 * View ▸ Custom Views: the workbook's saved views with Show, Add… and Delete. A view brings back how every
 * sheet was shown (see core/custom-views.js); Add asks for its name and what else it keeps.
 */
import { el, fieldId } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { customViewNameProblem, CUSTOM_VIEW_NAME_MAX } from '../core/custom-views.js';

/** Add View: a name, and whether the view keeps the page setup and the hidden rows, columns and filters. */
export function openAddCustomView(ctx, { onDone } = {}) {
  const { wb } = ctx;
  const name = el('input.input', { type: 'text', id: fieldId('cv-name'), autocomplete: 'off', maxLength: CUSTOM_VIEW_NAME_MAX, spellcheck: false });
  const print = el('input', { type: 'checkbox', id: fieldId('cv-print'), checked: true });
  const hidden = el('input', { type: 'checkbox', id: fieldId('cv-hidden'), checked: true });
  const { alert, refuse } = fieldAlert('custom-view-add');
  const submit = (e) => {
    e.preventDefault();
    const text = name.value.trim();
    const existing = wb.customViews.find((v) => v.name.toLowerCase() === text.toLowerCase());
    const problem = customViewNameProblem(text, wb.customViews, existing?.id);
    if (problem) return refuse(name, problem);
    // A view of the same name is replaced, as the list shows only one view of each name.
    if (existing && !replacing) {
      replacing = true;
      return refuse(name, `“${existing.name}” already exists. Choose OK again to replace it with the workbook as it is now.`);
    }
    modal.close();
    Promise.resolve(ctx.run('addCustomView', { name: text, print: print.checked, hidden: hidden.checked }))
      .then(() => onDone?.(wb.customViews.find((v) => v.name.toLowerCase() === text.toLowerCase())?.id ?? null, text));
  };
  let replacing = false;
  name.addEventListener('input', () => { replacing = false; });
  const content = el('form.cv-add', { onsubmit: submit },
    el('div.field', {}, el('label.field-label', { for: name.id }, 'Name'), name),
    el('fieldset.check-group.vertical', {}, el('legend.field-label', {}, 'Include in the view'),
      el('label.check', { for: print.id }, print, el('span', {}, 'Page setup and print settings')),
      el('label.check', { for: hidden.id }, hidden, el('span', {}, 'Hidden rows and columns, and filters'))),
    el('p.small.muted', {}, 'Every view keeps each sheet’s zoom, selection, scroll position, frozen panes and view.'),
    alert,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
  const modal = openModal({ title: 'Add View', content, initialFocus: name });
  return modal;
}

export function openCustomViews(ctx) {
  const { wb } = ctx;
  const list = el('div.cv-list', { role: 'listbox', tabindex: 0, 'aria-label': 'Views', id: fieldId('cv-list') });
  const empty = el('p.small.muted.cv-empty', {}, 'No views yet. Choose Add to keep the workbook’s present view under a name.');
  const detail = el('p.small.muted.cv-detail', { 'aria-live': 'polite' });
  let current = null;
  const views = () => wb.customViews || [];
  const describe = (v) => {
    const keeps = [v.print && 'print settings', v.hidden && 'hidden rows, columns and filters'].filter(Boolean);
    const sheet = wb.sheet(v.activeSheetId)?.name;
    return `${sheet ? `Opens on ${sheet}. ` : ''}${keeps.length ? `Includes ${keeps.join(' and ')}.` : 'Includes the view of each sheet only.'}`;
  };
  const buttons = {};
  const sync = (keep = current) => {
    const all = views();
    current = all.some((v) => v.id === keep) ? keep : all[0]?.id ?? null;
    list.replaceChildren(...all.map((v) => el('div.cv-item', {
      role: 'option', id: `${list.id}-${v.id.replace(/[{}]/g, '')}`, 'aria-selected': String(v.id === current), dataset: { id: v.id },
      onclick: () => sync(v.id), ondblclick: () => show(),
    }, v.name)));
    list.hidden = !all.length;
    empty.hidden = !!all.length;
    const v = all.find((x) => x.id === current);
    if (v) list.setAttribute('aria-activedescendant', `${list.id}-${v.id.replace(/[{}]/g, '')}`); else list.removeAttribute('aria-activedescendant');
    list.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
    detail.textContent = v ? describe(v) : '';
    buttons.show.disabled = buttons.delete.disabled = !v;
  };
  list.addEventListener('keydown', (e) => {
    const all = views(), at = all.findIndex((v) => v.id === current);
    const step = { ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity }[e.key];
    if (step != null && all.length) {
      e.preventDefault();
      sync(all[Math.max(0, Math.min(all.length - 1, step === -Infinity ? 0 : step === Infinity ? all.length - 1 : at + step))].id);
    } else if (e.key === 'Enter') { e.preventDefault(); show(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(); }
  });
  const show = () => {
    if (!current) return;
    modal.close();
    ctx.run('showCustomView', current);
  };
  const remove = () => {
    const v = views().find((x) => x.id === current);
    if (!v) return;
    const at = views().indexOf(v);
    Promise.resolve(ctx.run('deleteCustomView', v.id)).then(() => {
      sync(views()[Math.min(at, views().length - 1)]?.id ?? null);
      (views().length ? list : buttons.add).focus();
    });
  };
  buttons.show = el('button.btn.btn-primary', { type: 'button', onclick: show }, 'Show');
  buttons.add = el('button.btn', { type: 'button', onclick: () => openAddCustomView(ctx, { onDone: (id) => { sync(id); list.focus(); } }) }, 'Add…');
  buttons.delete = el('button.btn', { type: 'button', onclick: remove }, 'Delete');
  const content = el('div.cv-manager', {},
    el('div.cv-top', {},
      el('div.cv-list-wrap', {}, el('label.field-label', { for: list.id }, 'Views'), list, empty),
      el('div.cv-buttons', {}, buttons.show, buttons.add, buttons.delete)),
    detail,
    el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Close')));
  const modal = openModal({ title: 'Custom Views', content, initialFocus: views().length ? list : buttons.add, onClose: () => ctx.grid?.focus?.() });
  sync();
  return { ...modal, refresh: () => sync() };
}
