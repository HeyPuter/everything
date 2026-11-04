/**
 * Data ▸ Queries & Connections ▸ Edit Links: the book's links to other workbooks, each with
 * its source file, kind, how it updates and what was last found when it was checked. The
 * buttons act on the selected link: Update Values reads the source again from the drive,
 * Change Source points the link at another file, Open Source opens it, Break Link turns
 * the formulas that read it into values, and Check Status looks for every source. Startup
 * Prompt sets what opening this book does about its links.
 *
 * `host` carries what the dialog needs from the editor: docPath(), read(path) → Workbook,
 * open(path) (null when nothing can be opened), pick() → { path } | null (null without a
 * file picker), and allow() → whether reading the drive is allowed for this book.
 */
import { el, fieldId } from './dom.js';
import { openModal, confirmDialog, promptDialog } from './modal.js';
import { toast } from './toast.js';
import { linkEntries, linkPath, targetForPath, updateLinkValues, changeLinkSource, breakLink, linkUsage } from '../core/edit-links.js';
import { t } from '../i18n/index.js';

/** What the last look at each source found, by target, for as long as the page is open. */
const statusByTarget = new Map();

/** A target as a person reads it: its escapes decoded where they decode. */
const readable = (target) => { try { return decodeURI(target); } catch { return target; } };

const notFound = (e) => e?.code === 'subject_does_not_exist' || e?.code === 'not_found' || /not.?found|does not exist|no such/i.test(String(e?.message || e));

/**
 * What a look at a source found: { code, sheets? }, code one of ok, unknown, notApplicable, or the errors notOnDrive,
 * notFound, unreadable and sheetMissing (with the sheets not found).
 */
const isError = (status) => !['ok', 'unknown', 'notApplicable'].includes(status.code);

/** A status as the list shows it: "OK", "Error: Source not found". */
function statusText(status) {
  switch (status.code) {
    case 'ok': return t('editlinks.status.ok');
    case 'notApplicable': return t('editlinks.status.notApplicable');
    case 'notOnDrive': return t('editlinks.status.notOnDrive');
    case 'notFound': return t('editlinks.status.notFound');
    case 'unreadable': return t('editlinks.status.unreadable');
    case 'sheetMissing': return t('editlinks.status.sheetMissing', { sheets: status.sheets.join(', ') });
    default: return t('editlinks.status.unknown');
  }
}

/** An error status as the reason a link could not be updated: "source not found". */
function statusReason(status) {
  switch (status.code) {
    case 'notOnDrive': return t('editlinks.reason.notOnDrive');
    case 'notFound': return t('editlinks.reason.notFound');
    case 'sheetMissing': return t('editlinks.reason.sheetMissing', { sheets: status.sheets.join(', ').toLowerCase() });
    default: return t('editlinks.reason.unreadable');
  }
}

/**
 * Read one link's source: { status, source } where source is the Workbook (null when it could not be read)
 * and status what was found (see isError).
 */
export async function readLinkSource(host, entry) {
  if (entry.kind !== 'workbook') return { status: { code: 'notApplicable' }, source: null };
  const path = linkPath(entry.target, host.docPath?.());
  if (!path) return { status: { code: 'notOnDrive' }, source: null };
  let source;
  try { source = await host.read(path); } catch (e) { return { status: { code: notFound(e) ? 'notFound' : 'unreadable' }, source: null }; }
  const missing = entry.sheets.filter((name) => !source.sheets.some((s) => s.name.toLowerCase() === name.toLowerCase()));
  return { status: missing.length ? { code: 'sheetMissing', sheets: missing } : { code: 'ok' }, source };
}

/**
 * Update every workbook link from its source (opening the book, or Update All): one undo step per link
 * refreshed. Returns { updated, failed }.
 */
export async function updateAllLinks(ctx, host, { quiet = false } = {}) {
  let updated = 0;
  let failed = 0;
  for (const entry of linkEntries(ctx.wb)) {
    if (entry.kind !== 'workbook') continue;
    const { status, source } = await readLinkSource(host, entry);
    statusByTarget.set(entry.target, status);
    // The list may have changed while the file was read (a link broken meanwhile): the link is found again by target.
    const now = linkEntries(ctx.wb).find((e) => e.target === entry.target && e.kind === 'workbook');
    if (!source || !now) { failed++; continue; }
    updateLinkValues(ctx.wb, now.index, source);
    updated++;
  }
  if (!quiet && (updated || failed)) toast(failed ? t('editlinks.updatedSomeFailed', { updated, failed }) : t('editlinks.updated', { updated }), { icon: failed ? 'alert' : 'check', duration: 3500 });
  return { updated, failed };
}

/** Startup Prompt: what opening this book does about its links. */
export function openLinkStartupDialog(ctx) {
  const { wb } = ctx;
  const name = fieldId('link-startup');
  const choices = [
    ['ask', t('editlinks.startup.ask')],
    ['none', t('editlinks.startup.none')],
    ['update', t('editlinks.startup.update')],
  ];
  const radios = choices.map(([value]) => el('input', { type: 'radio', name, value, checked: (wb.linkStartup || 'ask') === value }));
  const content = el('form.el-startup', {
    onsubmit: (e) => {
      e.preventDefault();
      const picked = radios.find((r) => r.checked)?.value || 'ask';
      wb.setLinkStartup(picked);
      modal.close();
    },
  },
    el('p.small.muted', {}, t('editlinks.startup.intro')),
    el('fieldset.el-choices', {}, el('legend.visually-hidden', {}, t('editlinks.startup.legend')),
      ...choices.map(([, label], i) => el('label.el-choice', {}, radios[i], el('span', {}, label)))),
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('common.ok'))));
  const modal = openModal({ title: t('editlinks.startup.title'), content, initialFocus: radios.find((r) => r.checked) });
  return modal;
}

/** Open the Edit Links dialog. */
export function openEditLinks(ctx, host) {
  const { wb } = ctx;
  let selected = 1;
  let busy = false;

  const listId = fieldId('edit-links');
  const list = el('div.el-list', { id: listId, role: 'listbox', 'aria-label': t('editlinks.links'), tabindex: 0 });
  const head = el('div.el-row.el-head', { 'aria-hidden': 'true' }, el('span', {}, t('editlinks.column.source')), el('span', {}, t('editlinks.column.type')), el('span', {}, t('editlinks.column.update')), el('span', {}, t('editlinks.column.status')));
  const details = el('dl.el-details');
  const empty = el('p.el-empty.small.muted', { hidden: true }, t('editlinks.empty'));
  const working = el('p.el-working.small', { role: 'status', 'aria-live': 'polite' });

  const btn = (label, onclick) => el('button.btn.btn-sm', { type: 'button', onclick }, label);
  const updateBtn = btn(t('editlinks.updateValues'), () => update());
  const changeBtn = btn(t('editlinks.changeSourceButton'), () => changeSource());
  const openBtn = btn(t('editlinks.openSource'), () => openSource());
  const breakBtn = btn(t('editlinks.breakLinkButton'), () => breakSelected());
  const checkBtn = btn(t('editlinks.checkStatus'), () => checkAll());
  const startupBtn = btn(t('editlinks.startupButton'), () => openLinkStartupDialog(ctx));
  const closeBtn = el('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => modal.close() }, t('common.close'));

  const content = el('div.el-dialog', {},
    el('div.el-top', {},
      el('div.el-table', {}, head, list, empty),
      el('div.el-side', {}, updateBtn, changeBtn, openBtn, breakBtn, checkBtn)),
    details,
    working,
    el('div.row.el-foot', {}, startupBtn, el('span.el-spacer'), closeBtn));

  function onChange() { if (!busy) render(); }
  const entries = () => linkEntries(wb);
  const current = () => entries().find((e) => e.index === selected) || null;
  const statusOf = (entry) => (entry.kind === 'workbook' ? statusByTarget.get(entry.target) || { code: 'unknown' } : { code: 'notApplicable' });

  function render({ focus = false } = {}) {
    const all = entries();
    if (!all.some((e) => e.index === selected)) selected = all[0]?.index ?? 1;
    list.replaceChildren(...all.map((entry) => {
      const status = statusOf(entry);
      const row = el('div.el-row', {
        role: 'option', id: `${listId}-${entry.index}`, 'aria-selected': String(entry.index === selected),
        onclick: () => { selected = entry.index; render({ focus: true }); },
        ondblclick: () => { selected = entry.index; if (entry.kind === 'workbook') openSource(); },
      },
        el('span.el-source', { title: entry.target }, entry.name),
        el('span', {}, entry.type),
        el('span', {}, entry.update),
        el('span', { className: `el-status${isError(status) ? ' error' : status.code === 'ok' ? ' ok' : ''}` }, statusText(status)));
      return row;
    }));
    list.setAttribute('aria-activedescendant', all.length ? `${listId}-${selected}` : '');
    list.hidden = !all.length;
    head.hidden = !all.length;
    empty.hidden = !!all.length;
    const entry = current();
    const path = entry ? linkPath(entry.target, host.docPath?.()) : null;
    const uses = entry ? linkUsage(wb, entry.index) : null;
    details.replaceChildren(...(entry ? [
      el('dt', {}, t('editlinks.details.location')), el('dd', { title: entry.target }, path || readable(entry.target) || '—'),
      el('dt', {}, t('editlinks.details.sheets')), el('dd', {}, entry.sheets.length ? entry.sheets.join(', ') : '—'),
      el('dt', {}, t('editlinks.details.readBy')), el('dd', {}, uses.other ? t('editlinks.details.readByFormulasAndOther', { formulas: uses.cells.length, other: uses.other }) : t('editlinks.details.readByFormulas', { formulas: uses.cells.length })),
    ] : []));
    details.hidden = !entry;
    const workbookLink = entry?.kind === 'workbook';
    updateBtn.disabled = busy || !workbookLink;
    changeBtn.disabled = busy || !workbookLink;
    openBtn.disabled = busy || !workbookLink || !host.open || !path;
    breakBtn.disabled = busy || !entry;
    checkBtn.disabled = busy || !all.some((e) => e.kind === 'workbook');
    // With no links left the list is hidden: Close takes the focus rather than the page.
    if (focus) (list.hidden ? closeBtn : list).focus({ preventScroll: true });
    list.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }

  list.addEventListener('keydown', (e) => {
    const all = entries();
    const at = all.findIndex((x) => x.index === selected);
    let to = null;
    if (e.key === 'ArrowDown') to = Math.min(all.length - 1, at + 1);
    else if (e.key === 'ArrowUp') to = Math.max(0, at - 1);
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = all.length - 1;
    else if (e.key === 'Delete') { e.preventDefault(); breakSelected(); return; }
    if (to == null || to < 0) return;
    e.preventDefault();
    selected = all[to].index;
    render({ focus: true });
  });

  async function work(label, fn) {
    busy = true;
    working.textContent = label;
    render();
    try { return await fn(); } finally {
      busy = false;
      working.textContent = '';
      render();
    }
  }

  async function update() {
    const entry = current();
    if (!entry || entry.kind !== 'workbook' || !await host.allow()) return;
    await work(t('editlinks.updating', { name: entry.name }), async () => {
      const { status, source } = await readLinkSource(host, entry);
      statusByTarget.set(entry.target, status);
      const now = entries().find((x) => x.target === entry.target && x.kind === 'workbook');
      if (!source || !now) { toast(t('editlinks.couldNotUpdate', { name: entry.name, reason: statusReason(status) }), { icon: 'alert', duration: 4000 }); return; }
      const { missing } = updateLinkValues(wb, now.index, source);
      if (missing.length) toast(t('editlinks.updatedMissing', { name: entry.name, sheets: missing.join(', ') }), { icon: 'alert', duration: 4500 });
      else toast(t('editlinks.updatedFrom', { name: entry.name }), { icon: 'check', duration: 2500 });
    });
  }

  async function checkAll() {
    if (!await host.allow()) return;
    await work(t('editlinks.checking'), async () => {
      for (const entry of entries()) {
        if (entry.kind !== 'workbook') continue;
        const { status } = await readLinkSource(host, entry);
        statusByTarget.set(entry.target, status);
        render();
      }
    });
  }

  async function changeSource() {
    const entry = current();
    if (!entry || entry.kind !== 'workbook') return;
    let path = null;
    if (host.pick) {
      const picked = await host.pick();
      path = picked?.path || null;
    } else {
      path = await promptDialog({
        title: t('editlinks.changeSource.title'), label: t('editlinks.changeSource.label'), value: linkPath(entry.target, host.docPath?.()) || '',
        confirmLabel: t('editlinks.changeSource.confirm'), validate: (v) => (String(v).trim().startsWith('/') ? null : t('editlinks.changeSource.fullPath')),
      });
    }
    if (!path || !list.isConnected || list.closest('.closing')) return;
    const target = targetForPath(path, host.docPath?.());
    await work(t('editlinks.readingNewSource'), async () => {
      const probe = { ...entry, target };
      const allowed = await host.allow();
      const { status, source } = allowed ? await readLinkSource(host, probe) : { status: { code: 'unknown' }, source: null };
      const now = entries().find((x) => x.index === entry.index);
      if (!now) return;
      const { missing } = changeLinkSource(wb, entry.index, target, source);
      statusByTarget.set(target, status);
      toast(missing.length ? t('editlinks.nowReadsMissing', { name: probe.name || path, sheets: missing.join(', ') }) : t('editlinks.nowReads', { name: path.split('/').pop() }), { icon: missing.length ? 'alert' : 'check', duration: 4000 });
    });
  }

  function openSource() {
    const entry = current();
    const path = entry && linkPath(entry.target, host.docPath?.());
    if (!path || !host.open) return;
    modal.close();
    host.open(path);
  }

  async function breakSelected() {
    const entry = current();
    if (!entry) return;
    const ok = await confirmDialog({
      title: t('editlinks.breakConfirm.title', { name: entry.name }),
      message: t('editlinks.breakConfirm.message'),
      confirmLabel: t('editlinks.breakConfirm.confirm'),
    });
    if (!ok || !list.isConnected || list.closest('.closing')) return;
    const { converted, removed, kept } = breakLink(wb, entry.index);
    toast(removed ? t('editlinks.broken', { converted }) : t('editlinks.brokenKept', { converted, kept, name: entry.name }), { icon: removed ? 'check' : 'alert', duration: 4500 });
    render({ focus: true });
  }

  // An undo or another edit while the dialog is open changes the links it lists.
  wb.addEventListener('change', onChange);
  // The list and buttons are set before the dialog opens: Update Values, focused first and then turned off
  // for want of a link, dropped the focus to the page.
  render();
  const modal = openModal({ title: t('editlinks.title'), content, wide: true, initialFocus: list.hidden ? closeBtn : list, onClose: () => { wb.removeEventListener('change', onChange); ctx.grid?.focus?.(); } });
  return modal;
}
