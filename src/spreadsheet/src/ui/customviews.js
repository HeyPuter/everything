/**
 * View ▸ Custom Views: the workbook's saved views with Show, Add… and Delete. A view brings back how every
 * sheet was shown (see core/custom-views.js); Add asks for its name and what else it keeps.
 */
import { el, fieldId } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { customViewNameProblem, CUSTOM_VIEW_NAME_MAX } from '../core/custom-views.js';
import { t } from '../i18n/index.js';

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
      return refuse(name, t('customViewsDialog.replaceExisting', { name: existing.name }));
    }
    modal.close();
    Promise.resolve(ctx.run('addCustomView', { name: text, print: print.checked, hidden: hidden.checked }))
      .then(() => onDone?.(wb.customViews.find((v) => v.name.toLowerCase() === text.toLowerCase())?.id ?? null, text));
  };
  let replacing = false;
  name.addEventListener('input', () => { replacing = false; });
  const content = el('form.cv-add', { onsubmit: submit },
    el('div.field', {}, el('label.field-label', { for: name.id }, t('common.name')), name),
    el('fieldset.check-group.vertical', {}, el('legend.field-label', {}, t('customViewsDialog.include')),
      el('label.check', { for: print.id }, print, el('span', {}, t('customViewsDialog.includePrint'))),
      el('label.check', { for: hidden.id }, hidden, el('span', {}, t('customViewsDialog.includeHidden')))),
    el('p.small.muted', {}, t('customViewsDialog.keeps')),
    alert,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('common.ok'))));
  const modal = openModal({ title: t('customViewsDialog.addTitle'), content, initialFocus: name });
  return modal;
}

export function openCustomViews(ctx) {
  const { wb } = ctx;
  const list = el('div.cv-list', { role: 'listbox', tabindex: 0, 'aria-label': t('customViewsDialog.views'), id: fieldId('cv-list') });
  const empty = el('p.small.muted.cv-empty', {}, t('customViewsDialog.empty'));
  const detail = el('p.small.muted.cv-detail', { 'aria-live': 'polite' });
  let current = null;
  const views = () => wb.customViews || [];
  const describe = (v) => {
    const keeps = v.print && v.hidden ? 'both' : v.print ? 'print' : v.hidden ? 'hidden' : 'view';
    const sheet = wb.sheet(v.activeSheetId)?.name;
    return sheet ? t('customViewsDialog.detailOnSheet', { sheet, keeps }) : t('customViewsDialog.detail', { keeps });
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
  buttons.show = el('button.btn.btn-primary', { type: 'button', onclick: show }, t('common.show'));
  buttons.add = el('button.btn', { type: 'button', onclick: () => openAddCustomView(ctx, { onDone: (id) => { sync(id); list.focus(); } }) }, t('customViewsDialog.add'));
  buttons.delete = el('button.btn', { type: 'button', onclick: remove }, t('common.delete'));
  const content = el('div.cv-manager', {},
    el('div.cv-top', {},
      el('div.cv-list-wrap', {}, el('label.field-label', { for: list.id }, t('customViewsDialog.views')), list, empty),
      el('div.cv-buttons', {}, buttons.show, buttons.add, buttons.delete)),
    detail,
    el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.close'))));
  const modal = openModal({ title: t('customViewsDialog.title'), content, initialFocus: views().length ? list : buttons.add, onClose: () => ctx.grid?.focus?.() });
  sync();
  return { ...modal, refresh: () => sync() };
}
