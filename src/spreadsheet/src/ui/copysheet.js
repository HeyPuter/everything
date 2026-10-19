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
  const nameInput = el('input.input', { type: 'text', value: sheet.name, 'aria-label': 'Name of the new spreadsheet', maxlength: 120, autocomplete: 'off' });
  const fileSel = el('select.select', { 'aria-label': 'Spreadsheet to copy into', disabled: true }, el('option', { value: '' }, 'Loading…'));
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
  const retryBtn = el('button.btn.btn-ghost.btn-sm', { type: 'button', hidden: true, onclick: () => loadTargets() }, 'Try again');
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
  const newField = el('label.field', {}, el('span.field-label', {}, 'Name'), nameInput);
  const existingField = el('label.field', {}, el('span.field-label', {}, 'Spreadsheet'), fileSel);
  const hint = el('p.field-hint', {}, `The copy keeps the sheet's values, formulas, formatting, tables, and charts. References to other sheets keep links to this spreadsheet and cached source values.`);
  const submitBtn = el('button.btn.btn-primary', { type: 'submit' }, 'Copy');

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
    if (attempted) { say('Looking for your spreadsheets…'); retryBtn.disabled = true; retryBtn.setAttribute('aria-busy', 'true'); }
    fileSel.replaceChildren(el('option', { value: '' }, 'Loading…'));
    fileSel.disabled = true;
    const failed = attempted;
    return P.listFiles().then((files) => {
      const targets = files.filter((f) => /\.xlsx$/i.test(f.name) && !P.samePath(f.path, ctx.doc?.path));
      fileSel.replaceChildren(...(targets.length
        ? targets.map((f) => el('option', { value: f.path }, stripExtension(f.name)))
        : [el('option', { value: '' }, 'No other spreadsheets yet')]));
      fileSel.disabled = !targets.length;
      if (!targets.length) closeExisting('There is no other spreadsheet in your Spreadsheets folder to copy into.');
      else openExisting(failed ? 'Your spreadsheets are listed now.' : '');
    }).catch(() => {
      fileSel.replaceChildren(el('option', { value: '' }, 'Could not list your spreadsheets'));
      closeExisting(failed
        ? 'Still could not list your spreadsheets. Check your connection, then choose Try again.'
        : 'Your spreadsheets could not be listed. Choose Try again to look once more.', { retry: true });
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
      if (!await ctx.saveSourceForCopy()) throw new Error('The source spreadsheet could not be saved.');
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
      if (!clean) { refuse(nameInput, 'Enter a name'); return null; }
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
    if (!path) { refuse(fileSel.disabled ? null : fileSel, fileSel.disabled ? 'Still reading your spreadsheets. Try again in a moment.' : 'Choose a spreadsheet'); return null; }
    // Capture the revision before reading: a later stat alone can describe
    // newer bytes than the copy we loaded. A failed check must not overwrite.
    const before = await P.statFile(path);
    if (!before || (before.modified == null && before.created == null)) throw new Error('Could not verify the destination file. Try again.');
    const other = await workbookFromFile(await P.readFile(path), path);
    const one = await oneForPath(path);
    const added = other.importSheets(one)[0];
    // A file whose workbook structure is protected takes no new sheet. Writing it back unchanged and saying the
    // copy was made would be wrong twice over: nothing was copied, and the file was rewritten for nothing.
    if (!added) {
      refuse(fileSel, other.structureProtected ? `${stripExtension(P.displayName(path))} has its workbook structure protected, so no sheet can be added to it` : 'The sheet could not be added to that spreadsheet');
      return null;
    }
    const blob = await workbookToXlsx(other);
    const after = await P.statFile(path);
    if (!after || ['uid', 'id', 'modified', 'created', 'size'].some((key) => before[key] !== after[key])) {
      throw new Error('The destination changed while copying. Try again to include its latest changes.');
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
      toast(`Copied ${done.sheetName} to ${done.name}`, { icon: 'check', action: { label: 'Open', onClick: () => ctx.run('openFile', done.path) } });
    } catch (err) {
      console.error(err);
      refuse(null, `Could not copy: ${err?.message || 'unknown error'}`);
    } finally {
      submitBtn.disabled = false;
    }
  };

  const content = el('form', { onsubmit: submit },
    el('div.field', {}, el('span.field-label', {}, 'Copy to'),
      el('div.row', { style: { gap: '18px' } }, radio('new', 'New spreadsheet'), radio('existing', 'Existing spreadsheet')),
      existingReason,
      retryBtn),
    newField,
    existingField,
    error,
    hint,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      submitBtn));
  const modal = openModal({ title: `Copy "${sheet.name}" to another spreadsheet`, content, onClose: () => ctx.grid?.focus() });
  sync();
  return modal;
}
