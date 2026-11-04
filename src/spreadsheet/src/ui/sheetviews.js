/**
 * View ▸ Sheet View: views of a sheet in which a person sorts out their own filters while everyone else
 * keeps the default view. The ribbon offers the views and New, Keep, Exit and Options; Options manages them.
 */
import { el, fieldId } from './dom.js';
import { openModal, promptDialog } from './modal.js';
import { t } from '../i18n/index.js';

/** A name for a kept view: View1, View2… as the sheet's views leave free. */
export function nextViewName(views = []) {
  const taken = new Set(views.map((v) => v.name.toLowerCase()));
  let n = 1;
  while (taken.has(`view${n}`)) n++;
  return `View${n}`;
}

/** Ask for a name (Keep and Rename); `except` is the view being named, whose own name is fine. */
export async function askViewName(views, { title, value, except = null, confirmLabel = t('common.ok') }) {
  return promptDialog({ title, label: t('common.name'), value, confirmLabel,
    validate: (text) => {
      const name = text.trim();
      if (!name) return t('sheetviews.typeName');
      if (name.length > 255) return t('sheetviews.tooLong', { max: 255 });
      if (views.some((v) => v.id !== except && v.name.toLowerCase() === name.toLowerCase())) return t('sheetviews.duplicate');
      return null;
    } });
}

/** Sheet View Options: the sheet's views with Switch To, Rename, Duplicate and Delete. */
export function openSheetViewOptions(ctx) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const list = el('div.cv-list', { role: 'listbox', tabindex: 0, 'aria-label': t('sheetviews.sheetViews'), id: fieldId('sv-list') });
  const empty = el('p.small.muted.cv-empty', {}, t('sheetviews.empty'));
  let current = null;
  const views = () => (wb.sheet(sheetId)?.sheetViews || []).filter((v) => !v.temporary);
  const buttons = {};
  const sync = (keep = current) => {
    const all = views(), mine = wb.sheet(sheetId)?.personalView?.id;
    current = all.some((v) => v.id === keep) ? keep : all[0]?.id ?? null;
    list.replaceChildren(...all.map((v) => el('div.cv-item', {
      role: 'option', id: `${list.id}-${v.id}`, 'aria-selected': String(v.id === current), dataset: { id: v.id },
      onclick: () => sync(v.id), ondblclick: () => run('switch'),
    }, v.id === mine ? t('sheetviews.current', { name: v.name }) : v.name)));
    list.hidden = !all.length; empty.hidden = !!all.length;
    if (current) list.setAttribute('aria-activedescendant', `${list.id}-${current}`); else list.removeAttribute('aria-activedescendant');
    for (const key of ['switch', 'rename', 'duplicate', 'delete']) buttons[key].disabled = !current;
    buttons.switch.disabled = !current || current === mine;
  };
  const run = async (action) => {
    const v = views().find((x) => x.id === current);
    if (!v) return;
    if (action === 'switch') { modal.close(); ctx.run('sheetView', { action: 'switch', id: v.id }); return; }
    if (action === 'rename') {
      const name = await askViewName(views(), { title: t('sheetviews.renameTitle'), value: v.name, except: v.id, confirmLabel: t('common.rename') });
      if (name != null) ctx.run('sheetView', { action: 'rename', id: v.id, name: name.trim() });
    } else if (action === 'duplicate') ctx.run('sheetView', { action: 'duplicate', id: v.id });
    else if (action === 'delete') ctx.run('sheetView', { action: 'delete', id: v.id });
    // With the last view gone the list is hidden: the focus goes to Close rather than to the page.
    setTimeout(() => { sync(); (list.hidden ? closeBtn : list).focus(); }, 0);
  };
  list.addEventListener('keydown', (e) => {
    const all = views(), at = all.findIndex((v) => v.id === current);
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (step && all.length) { e.preventDefault(); sync(all[Math.max(0, Math.min(all.length - 1, at + step))].id); }
    else if (e.key === 'Enter') { e.preventDefault(); run('switch'); }
    else if (e.key === 'F2') { e.preventDefault(); run('rename'); }
    else if (e.key === 'Delete') { e.preventDefault(); run('delete'); }
  });
  buttons.switch = el('button.btn.btn-primary', { type: 'button', onclick: () => run('switch') }, t('sheetviews.switchTo'));
  buttons.rename = el('button.btn', { type: 'button', onclick: () => run('rename') }, t('sheetviews.rename'));
  buttons.duplicate = el('button.btn', { type: 'button', onclick: () => run('duplicate') }, t('sheetviews.duplicateView'));
  buttons.delete = el('button.btn', { type: 'button', onclick: () => run('delete') }, t('common.delete'));
  const closeBtn = el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.close'));
  const content = el('div.cv-manager', {},
    el('div.cv-top', {},
      el('div.cv-list-wrap', {}, el('label.field-label', { for: list.id }, wb.sheet(sheetId)?.name ? t('sheetviews.viewsOf', { name: wb.sheet(sheetId).name }) : t('sheetviews.viewsOfThisSheet')), list, empty),
      el('div.cv-buttons', {}, buttons.switch, buttons.rename, buttons.duplicate, buttons.delete)),
    el('p.small.muted.cv-detail', {}, t('sheetviews.detail')),
    el('div.row.row-end', {}, closeBtn));
  // The buttons are set before the dialog opens: Switch To, focused first and then turned off for want of a
  // view, dropped the focus to the page.
  sync();
  const modal = openModal({ title: t('sheetviews.title'), content, initialFocus: views().length ? list : closeBtn, onClose: () => ctx.grid?.focus?.() });
  return modal;
}
