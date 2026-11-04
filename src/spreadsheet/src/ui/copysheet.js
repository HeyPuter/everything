import { relativeWorkbookTarget } from '../core/workbook-location.js';
/**
 * Copy a sheet to another spreadsheet: a new file in Spreadsheets/ named
 * after the sheet, or one of the spreadsheets already there (the sheet is
 * added after its sheets and the file rewritten). A toast offers to open the
 * destination.
 */

import { el, fieldId } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { toast } from './toast.js';
import * as P from '../lib/puter.js';
import { workbookFromFile, workbookToXlsx, stripExtension } from '../core/io.js';
import { t } from '../i18n/index.js';

/** The sheet as a one-sheet workbook, imported into `target`; returns the sheet added there. */
export function copySheetInto(target, source, sheetId, options = {}) {
  const one = source.sheetToWorkbook(sheetId, options);
  if (!one) return null;
  return target.importSheets(one)[0] || null;
}

export { relativeWorkbookTarget } from '../core/workbook-location.js';

export function openCopySheetDialog(ctx, sheetId) {
  const { wb } = ctx;
  const sheet = wb.sheet(sheetId);
  if (!sheet) return null;
  if (ctx.grid?.editing && !ctx.grid.commitEdit()) return;

  let mode = 'new';
  const nameInput = el('input.input', { type: 'text', value: sheet.name, 'aria-label': t('copysheet.newNameLabel'), maxlength: 120, autocomplete: 'off' });
  const fileSel = el('select.select', { 'aria-label': t('copysheet.targetLabel'), disabled: true }, el('option', { value: '' }, t('common.loading')));
  const { alert: error, refuse, clear: clearError } = fieldAlert('copy'); // a failed copy is about no field
  const radios = {};
  const labels = {};
  const radio = (key, label) => {
    const input = el('input', { type: 'radio', name: 'copy-sheet-mode', value: key, checked: mode === key, onchange: () => { mode = key; sync(); } });
    radios[key] = input;
    labels[key] = el('label.check', {}, input, el('span', {}, label));
    return labels[key];
  };
  // Why "Existing spreadsheet" cannot be chosen, said beside it while it is off, rather than at submit
  // through a refusal that marks a disabled select and so has nowhere to put the focus. The line is a
  // live region, so each turn of the listing — reading, failed, listed — is announced where it is read.
  const existingReasonId = fieldId('copy-existing');
  const existingReason = el('p.field-hint', { id: existingReasonId, role: 'status', hidden: true });
  const retryBtn = el('button.btn.btn-ghost.btn-sm', { type: 'button', hidden: true, onclick: () => loadTargets() }, t('common.tryAgain'));
  const say = (message) => { existingReason.textContent = message || ''; existingReason.hidden = !message; };
  function closeExisting(reason, { retry = false } = {}) {
    say(reason);
    retryBtn.hidden = !retry;
    radios.existing.disabled = true;
    radios.existing.setAttribute('aria-describedby', existingReasonId);
    labels.existing.classList.add('is-disabled');
    // Chosen before the listing came back: fall back to the choice that still works.
    if (mode === 'existing') { radios.new.checked = true; mode = 'new'; sync(); }
  }
  function openExisting(reason) {
    say(reason);
    retryBtn.hidden = true;
    radios.existing.disabled = false;
    radios.existing.removeAttribute('aria-describedby');
    labels.existing.classList.remove('is-disabled');
  }
  const newField = el('label.field', {}, el('span.field-label', {}, t('common.name')), nameInput);
  const existingField = el('label.field', {}, el('span.field-label', {}, t('copysheet.spreadsheet')), fileSel);
  const hint = el('p.field-hint', {}, t('copysheet.hint'));
  const submitBtn = el('button.btn.btn-primary', { type: 'submit' }, t('common.copy'));

  function sync() {
    newField.hidden = mode !== 'new';
    existingField.hidden = mode !== 'existing';
    clearError();
  }

  // The spreadsheets in the folder, minus this one; only .xlsx files can be rewritten in place.
  // A listing can fail for a moment (no connection), which would otherwise leave the choice off for
  // good: Try again runs it once more. Every attempt passes through "Looking…", so a second failure
  // changes the line and is announced again rather than repeating itself in silence.
  let attempted = false;
  function loadTargets() {
    if (attempted) { say(t('copysheet.looking')); retryBtn.disabled = true; retryBtn.setAttribute('aria-busy', 'true'); }
    fileSel.replaceChildren(el('option', { value: '' }, t('common.loading')));
    fileSel.disabled = true;
    const failed = attempted;
    return P.listFiles().then((files) => {
      const targets = files.filter((f) => /\.xlsx$/i.test(f.name) && !P.samePath(f.path, ctx.doc?.path));
      fileSel.replaceChildren(...(targets.length
        ? targets.map((f) => el('option', { value: f.path }, stripExtension(f.name)))
        : [el('option', { value: '' }, t('copysheet.noOthers'))]));
      fileSel.disabled = !targets.length;
      if (!targets.length) closeExisting(t('copysheet.noOthersReason'));
      else openExisting(failed ? t('copysheet.listedNow') : '');
    }).catch(() => {
      fileSel.replaceChildren(el('option', { value: '' }, t('copysheet.couldNotList')));
      closeExisting(failed
        ? t('copysheet.stillCouldNotList')
        : t('copysheet.couldNotListRetry'), { retry: true });
    }).finally(() => {
      attempted = true;
      retryBtn.disabled = false;
      retryBtn.removeAttribute('aria-busy');
    });
  }
  loadTargets();

  async function oneForPath(path) {
    const build = async () => {
      let sourceWorkbook = null;
      if (ctx.doc?.path) {
        const folder = await P.resolveAppFolder();
        const full = p => folder && p.startsWith(`${P.FOLDER}/`) ? `${folder}/${p.slice(P.FOLDER.length + 1)}` : p;
        sourceWorkbook = relativeWorkbookTarget(full(ctx.doc.path), full(path));
      }
      return wb.sheetToWorkbook(sheetId, { sourceWorkbook });
    };
    let one, saved = false;
    const saveSource = async () => {
      if (!await ctx.saveSourceForCopy()) throw new Error(t('copysheet.sourceNotSaved'));
      saved = true;
    };
    try { one = await build(); }
    catch (error) {
      if (!['PIVOT_SOURCE_LOCATION_REQUIRED', 'EXTERNAL_SOURCE_LOCATION_REQUIRED'].includes(error.code) || !ctx.saveSourceForCopy) throw error;
      await saveSource(); one = await build();
    }
    const linked = (one?.externalWorkbooks?.books.length || 0) > (wb.externalWorkbooks?.books.length || 0) || one?.nativePivots?.caches.some(cache => cache.sourceWorkbook && !wb.nativePivots.caches.find(old => old.key === cache.key)?.sourceWorkbook);
    if (linked && !saved && ctx.saveSourceForCopy) { await saveSource(); one = await build(); }
    return one;
  }

  async function copy() {
    if (mode === 'new') {
      const clean = P.sanitizeName(nameInput.value).replace(/\.xlsx$/i, '');
      if (!clean) { refuse(nameInput, t('copysheet.enterName')); return null; }
      const fileName = await P.uniqueName(clean);
      const path = `${P.FOLDER}/${fileName}`;
      const one = await oneForPath(path);
      // Another tab can claim the suggested name while the file is encoded.
      // Let storage choose a free name and open the file it actually created.
      const written = await P.writeFile(path, await workbookToXlsx(one), { dedupe: true });
      const savedName = written?.name || P.displayName(written?.path || path);
      return { path: P.canonicalPath(`${P.FOLDER}/${savedName}`, written), name: stripExtension(savedName), sheetName: sheet.name };
    }
    const path = fileSel.value;
    // Submitted while the listing is still on its way: the select cannot be picked from yet, so the
    // message stands on its own instead of marking a control that cannot take the focus.
    if (!path) { refuse(fileSel.disabled ? null : fileSel, fileSel.disabled ? t('copysheet.stillReading') : t('copysheet.chooseSpreadsheet')); return null; }
    // Capture the revision before reading: a later stat alone can describe
    // newer bytes than the copy we loaded. A failed check must not overwrite.
    const before = await P.statFile(path);
    if (!before || (before.modified == null && before.created == null)) throw new Error(t('copysheet.couldNotVerify'));
    const other = await workbookFromFile(await P.readFile(path), path);
    const one = await oneForPath(path);
    const added = other.importSheets(one)[0];
    // A file whose workbook structure is protected takes no new sheet. Writing it back unchanged and saying the
    // copy was made would be wrong twice over: nothing was copied, and the file was rewritten for nothing.
    if (!added) {
      refuse(fileSel, other.structureProtected ? t('copysheet.structureProtected', { name: stripExtension(P.displayName(path)) }) : t('copysheet.couldNotAdd'));
      return null;
    }
    const blob = await workbookToXlsx(other);
    const after = await P.statFile(path);
    if (!after || ['uid', 'id', 'modified', 'created', 'size'].some((key) => before[key] !== after[key])) {
      throw new Error(t('copysheet.destinationChanged'));
    }
    await P.writeFile(path, blob);
    return { path, name: stripExtension(P.displayName(path)), sheetName: added.name };
  }

  const submit = async (e) => {
    e?.preventDefault();
    submitBtn.disabled = true;
    try {
      const done = await copy();
      if (!done) return;
      modal.close();
      toast(t('copysheet.copied', { sheet: done.sheetName, name: done.name }), { icon: 'check', action: { label: t('common.open'), onClick: () => ctx.run('openFile', done.path) } });
    } catch (err) {
      console.error(err);
      refuse(null, err?.message ? t('copysheet.couldNotCopy', { reason: err.message }) : t('copysheet.couldNotCopyUnknown'));
    } finally {
      submitBtn.disabled = false;
    }
  };

  const content = el('form', { onsubmit: submit },
    el('div.field', {}, el('span.field-label', {}, t('copysheet.copyTo')),
      el('div.row', { style: { gap: '18px' } }, radio('new', t('copysheet.newSpreadsheet')), radio('existing', t('copysheet.existingSpreadsheet'))),
      existingReason,
      retryBtn),
    newField,
    existingField,
    error,
    hint,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      submitBtn));
  const modal = openModal({ title: t('copysheet.title', { name: sheet.name }), content, onClose: () => ctx.grid?.focus() });
  sync();
  return modal;
}
