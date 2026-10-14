import { workbookPathUri } from '../core/workbook-location.js';
import { sheetFilters } from '../core/sheet-filters.js';
/**
 * The open document: a Workbook plus where it lives on Puter and whether
 * what is on screen matches what is on disk.
 *
 * Saving writes a complete .xlsx to `path`. Edits autosave after a short
 * pause; a document that has never been saved gets a file the first time it
 * changes, so nothing typed is ever only in memory for long. Files opened
 * from outside the app folder (the Puter file picker, "Open with") save back
 * to where they came from. A file that is not .xlsx (a CSV, say) is saved
 * as a new .xlsx beside it (in the app folder, when its own folder will not
 * take it) rather than overwritten with a format its extension does not match.
 *
 * Unsaved edits are also copied to this browser's storage (see drafts.js);
 * a file opened while such a draft exists offers the draft back.
 *
 * Without a Puter session there is nowhere to write: autosaves wait (the
 * local draft still keeps the edits) and an explicit save fails with
 * SIGN_IN_TO_SAVE so the view can ask for a sign-in.
 *
 * status: 'saved' | 'unsaved' | 'saving' | 'error' | 'offline'
 */

import { Workbook, EXCEL_SHEET_DEFAULTS } from '../core/workbook.js';
import { formulaReachesOut } from '../core/reaches-out.js';
import { recordStep } from '../core/change-history.js';
import { isRangeSource } from '../core/validation.js';
import { workbookToXlsx, workbookToOds, workbookFromFile, sheetToCsv, sheetToTsv, sheetToHtml, stripExtension, XLSX_MIME, CSV_MIME, TSV_MIME, HTML_MIME } from '../core/io.js';
import * as P from './puter.js';
import { trackEvent } from './analytics.js';
import { session } from './session.js';
import { draftKey, liveDraftKey, draftRevision, saveDraft, loadDraft, clearDraft, moveDraft, parkDraft, isUnsavedDraftKey, sameBook, draftKeyForFile, readableDraft, uniqueId } from './drafts.js';
import { adoptVersionsByUid, listVersions, saveVersion, readVersion, dueForVersion, moveVersions, parkVersions, RESTORE_LABEL } from './versions.js';
import { storageScope, accountStorageKey, isAccountScope, isProvisionalScope } from './account-storage.js';
import { optionState } from './option-state.js';

const AUTOSAVE_MS = 1500;
// The title row's AutoSave switch: off, edits wait for Save (the local draft still keeps them). Per device.
const AUTOSAVE_KEY = 'spreadsheet:autosave';
// A device that never flipped the switch saves as it goes unless the app's options say not to (Save ▸ AutoSave by default).
export function autoSaveEnabled() {
  try {
    const kept = globalThis.localStorage?.getItem(AUTOSAVE_KEY);
    return kept == null ? optionState.autoSave !== false : kept !== 'off';
  } catch { return optionState.autoSave !== false; }
}
export function setAutoSaveEnabled(on) {
  try { globalThis.localStorage?.setItem(AUTOSAVE_KEY, on ? 'on' : 'off'); } catch { /* optional storage */ }
}
// A failed autosave is tried again after this long, then at doubling intervals, up to the cap.
const RETRY_MS = 8000;
const RETRY_MAX_MS = 5 * 60_000;
// A file up to this size is read back, when its time is newer but its size the same, to tell a rename or
// move made elsewhere from a change made there before the conflict dialog is raised over it.
const COMPARE_MAX_BYTES = 4 * 1024 * 1024;
// Files the user has allowed to load outside content, remembered per account and path.
const EXTERNAL_PREFIX = 'spreadsheet:external';
const externalKey = (path, scope) => `${accountStorageKey(EXTERNAL_PREFIX, scope)}${path}`;
/** The decision remembered for a path, { allowed, uid } (uid null for records from before file ids were kept), or null when none was made. */
function rememberedExternal(path, scope) {
  let remembered = null;
  try { remembered = globalThis.localStorage?.getItem(externalKey(path, scope)) ?? null; } catch { /* no storage */ }
  const m = /^([01])(?::(.+))?$/.exec(remembered || '');
  return m ? { allowed: m[1] === '1', uid: m[2] || null } : null;
}
/**
 * Whether a file may load outside content (IMPORT* formulas, AI, web images) is
 * decided once per file, whichever way it went: an import from elsewhere stays
 * blocked after its first save puts it in the app folder, and an allowed file
 * stays allowed. The decision is kept with the account in puter.kv under the
 * file's id, which survives renames and reaches every device; this browser keeps
 * a copy by path, with the file's id, which answers when the store cannot be
 * reached and is put in the store when found there alone. Another file dropped
 * at the address of an allowed one is a newcomer, not the file that was allowed:
 * a record that allows is trusted only for the file it was made for, or when
 * there is no way to tell. A record that blocks costs a question at most.
 */
const EXTERNAL_RECORD = 'spreadsheet:external:v1:';
const externalRecordKey = (uid) => `${EXTERNAL_RECORD}${uid}`;
const STORE_UNREACHABLE = Symbol('unreachable');
/** The recorded decision for a file: true, false, or null when none was made. */
async function recordedExternalDecision({ path, uid }, scope) {
  let stored = null;
  if (uid) {
    stored = await P.kvGet(externalRecordKey(uid), STORE_UNREACHABLE);
    if (stored === '1' || stored === true) return true;
    if (stored === '0' || stored === false) return false;
  }
  const local = rememberedExternal(path, scope);
  if (local == null) return null;
  if (local.uid && uid && local.uid !== uid) return null; // another file's record
  const sameFile = !!uid && local.uid === uid;
  const unverifiable = !uid || (stored === STORE_UNREACHABLE && !local.uid);
  if (local.allowed && !sameFile && !unverifiable) return null;
  if (uid) P.kvSet(externalRecordKey(uid), local.allowed ? '1' : '0');
  return local.allowed;
}
/** Record the decision for a file everywhere it is kept; `null` forgets it. */
function recordExternal({ path, uid }, scope, allowed) {
  rememberExternal(path, scope, allowed, uid);
  if (!uid) return;
  if (allowed == null) P.kvDel(externalRecordKey(uid));
  else P.kvSet(externalRecordKey(uid), allowed ? '1' : '0');
}
/**
 * Does the book hold a formula that could reach out, anywhere a formula can live? A rule's value
 * or a dropdown's list is only a formula when the rule says so (as the workbook reads them), so a
 * rule highlighting the text "AI" or a list offering it does not ask.
 */
function usesExternalContent(wb) {
  const reaches = formulaReachesOut;
  if (wb.names?.some((n) => reaches(n.ref))) return true;
  if (wb.externalWorkbooks?.books.some(book => book.names.some(name => reaches(name.ref)))) return true;
  for (const sheet of wb.sheets) {
    for (const group of sheet.sparklineGroups || []) if (reaches(group.dateFormula) || group.sparklines.some(spark => reaches(spark.formula))) return true;
    for (const cell of sheet.cells.values()) if (reaches(cell.f)) return true;
    for (const table of sheet.tables || []) for (const f of Object.values(table.calc || {})) if (reaches(f)) return true;
    for (const rule of sheet.rules || []) if (rule.type === 'formula' && reaches(rule.value)) return true;
    for (const rule of sheet.validations || []) if ((rule.type === 'formula' || (rule.type === 'list' && isRangeSource(rule.source))) && reaches(rule.source)) return true;
    for (const filter of sheetFilters(sheet)) for (const criterion of Object.values(filter.criteria || {})) if (reaches(criterion.formula)) return true;
  }
  return false;
}
/** Record the decision for a path ('1' allowed, '0' blocked, with the file's id when known); `null` forgets it, for a path that no longer holds this file. */
function rememberExternal(path, scope, allowed, uid = null) {
  try {
    if (!path) return;
    if (allowed == null) globalThis.localStorage?.removeItem(externalKey(path, scope));
    else globalThis.localStorage?.setItem(externalKey(path, scope), `${allowed ? '1' : '0'}${uid ? `:${uid}` : ''}`);
  } catch { /* no storage */ }
}
/**
 * A file is now known by `to`; the records this browser kept under `from`, another spelling
 * of its address (the relative one, before the drive's own was adopted), follow it. A record
 * already kept under the new address stands.
 */
function adoptRecords(from, to, scope) {
  if (!from || from === to) return;
  // The draft, and the edits kept beside it while it awaited a decision (see _ownDraftKey), each where free.
  for (const at of [(key) => key, liveDraftKey]) {
    if (loadDraft(at(draftKey(to, '', scope))) == null) moveDraft(at(draftKey(from, '', scope)), at(draftKey(to, '', scope)));
  }
  if (rememberedExternal(to, scope) == null) moveExternalDecision(from, to, scope);
}

/** A file was renamed or moved (its id, and so the account's record, stays): this browser's record follows it. */
export function moveExternalDecision(from, to, scope = storageScope()) {
  const decision = rememberedExternal(from, scope);
  if (decision == null) return;
  rememberExternal(to, scope, decision.allowed, decision.uid);
  rememberExternal(from, scope, null);
}

/** A copy of a file holds the same content: it starts with the file's own decision. */
export async function copyExternalDecision(source, copy, scope = storageScope()) {
  const decision = await recordedExternalDecision(source, scope);
  if (decision != null) recordExternal(copy, scope, decision);
}

/** The file is gone: whatever lands at its address later is another file. */
export function forgetExternalDecision(file, scope = storageScope()) {
  recordExternal(file, scope, null);
}
// Unsaved edits are copied to this browser's storage after this pause; the app's options can lengthen it (Save).
const draftMs = () => {
  const s = Number(optionState.draftDelay);
  return Number.isFinite(s) && s > 1 ? Math.min(s, 3600) * 1000 : 600;
};
export const UNTITLED = 'Untitled spreadsheet';
/** How long a shared workbook waits after its last change before its owner's browser writes the .xlsx file. */
const SHARED_FILE_MS = 15_000;
export const SIGN_IN_TO_SAVE = 'Sign in to Puter to save this spreadsheet';
/** Why a spreadsheet shared with the user only to view is not saved. */
export const VIEW_ONLY = 'You can view this spreadsheet, but not change it. Use File > Save a copy to keep your changes';

/** A Puter FSItem's modified time in milliseconds (the API gives seconds), or null. */
function modifiedMs(item) {
  const m = item?.modified ?? item?.created;
  if (m == null) return null;
  const n = typeof m === 'number' ? m : new Date(m).getTime();
  if (!Number.isFinite(n)) return null;
  return n < 1e12 ? n * 1000 : n;
}

/** A Puter FSItem's size in bytes, or null when it is not reported (a spreadsheet file is never empty). */
function sizeOf(item) {
  return Number.isFinite(item?.size) && item.size > 0 ? item.size : null;
}

/**
 * The folder a source file from elsewhere on the drive lives in, for its .xlsx to go beside it; null for
 * one in the app folder, in the trash, or known only by a relative address (which names the app's own data).
 */
function besideDir(path) {
  if (!P.isAbsolutePath(path) || P.inAppFolder(path) || P.inTrash(path)) return null;
  const slash = path.lastIndexOf('/');
  return slash > 0 ? path.slice(0, slash) : null;
}

/**
 * Found again by its id, is the file somewhere a document last at `from` can follow it? Not in
 * the trash: deleting a file on the desktop moves it there under its bare id, and following it
 * would turn the deletion into a file named after the id. Nor at a name that lost the .xlsx
 * extension it had, which the next save would take for a foreign format and make a new file for.
 * Either counts as gone, so the user is asked what to do with the edits.
 */
function followable(moved, from) {
  if (!moved?.path || P.inTrash(moved.path)) return false;
  return !/\.xlsx$/i.test(from) || /\.xlsx$/i.test(moved.path);
}

/**
 * How a draft found on open relates to the file: 'current', 'older', or 'stale'.
 *
 * A draft records the file's modification time as the document knew it when the
 * edits were made. Equal to the file's now, the edits were made on this very
 * revision and never saved. Different (or unknown), the file was written since,
 * by another tab or device, say: the edits may be older than the file, but they
 * never reached it either, so they are still offered. Drafts from before that
 * record was kept can only be compared by this browser's clock against the
 * server's; only one from well before the file's last save is stale.
 */
const LEGACY_DRAFT_SLACK_MS = 60_000;
function draftVerdict(draft, remoteModified) {
  if ('fileModified' in draft) {
    const base = draft.fileModified;
    return base && remoteModified && base === remoteModified ? 'current' : 'older';
  }
  if (remoteModified == null || draft.savedAt > remoteModified) return 'current';
  return draft.savedAt > remoteModified - LEGACY_DRAFT_SLACK_MS ? 'older' : 'stale';
}

export class Doc extends EventTarget {
  constructor({ wb = null, name = UNTITLED, path = null, uid = null, trusted = true } = {}) {
    super();
    this.wb = wb || new Workbook();
    this.name = name;
    this.path = path;
    this.uid = uid; // the file's id on the drive, the same whatever it is called
    this.viewOnly = false; // someone else's file, shared with the user only to view: the editor finds out, as Puter refuses its saves
    this._storageScope = storageScope();
    // A document made here, or one the user already allowed, may load outside content.
    this.wb.setExternalAllowed(trusted);
    this._draftId = uniqueId(); // new documents with the same title need independent recovery copies
    this._recoveredDraftKey = null;
    this.status = 'saved';
    this.error = null;
    this.lastSaved = null;
    this.remoteModified = null; // when the file on the drive was last written, as we last saw it (ms)
    this.remoteSize = null; // and how many bytes it held then: modification times are whole seconds, and two tabs can save within one
    this._written = null; // the bytes last written to the file, kept while small enough to read the file back and compare (see _holdsLastWrite)
    this._timer = null;
    this._retryDelay = 0; // the pause before the next try of a failing autosave, growing while it keeps failing
    this._draftTimer = null;
    this._draftRevision = null; // only this exact local snapshot may be moved or cleared
    this.draftKept = true; // does this browser hold a copy of the unsaved edits? Not once a book outgrows local storage
    this._saving = null;
    this._versioning = null; // the automatic snapshot of the last save, while it is being written
    this.recoverable = null; // a local draft newer than the file, awaiting a decision
    this._recoverableKey = null; // where that draft lives; it follows the document when its key changes
    this.recoverableMayBeOlder = false; // the file was written after those edits were made (or could not be checked)
    this._lastVersionAt = undefined; // when the newest snapshot was written; undefined until looked up
    this._onChange = (e) => this._changed(e.detail?.type);
    this.wb.addEventListener('change', this._onChange);
    this._onSession = () => this._followStorageScope();
    session.addEventListener('change', this._onSession);
    if (this.wb.dirty) this._changed('cells');
  }

  /**
   * A sign-in moved this browser's guest records into the account (or the
   * account's identity, unknown at boot, was resolved and the records kept
   * meanwhile moved); the document's draft went with them. A document opened
   * under one account stays with that account, though, whoever signs in later.
   */
  _followStorageScope() {
    const scope = storageScope();
    // A provisional scope's draft follows the account, never another throwaway scope after a failed identity lookup.
    if (!isProvisionalScope(this._storageScope) || scope === this._storageScope || !isAccountScope(scope)) return;
    const oldKey = this.draftKey;
    if (this._recoveredDraftKey) this._recoveredDraftKey = this._recoveredDraftKey.replace(accountStorageKey('', this._storageScope), accountStorageKey('', scope));
    this._storageScope = scope;
    this._moveDraft(oldKey); // already moved with the rest, usually
  }

  /** The document's key changed: its draft follows, whether it holds this document's edits or a recovered draft awaiting a decision (with the edits made meanwhile beside it). */
  _moveDraft(oldKey) {
    const to = this.draftKey;
    if (this.recoverable) {
      const from = this._recoverableKey || oldKey;
      // The key follows the draft only where the draft went: should storage refuse the record under the
      // new key (full, say), the draft stays under the old one, and a later discard must clear it there.
      // A sign-in that resolves an account moves every record this browser kept into it, so the draft
      // may be at the new key already; the key follows it there too, or a discard would clear the old,
      // empty one and the file would offer the discarded draft again on its next open.
      if (moveDraft(from, to, draftRevision(this.recoverable)) || draftRevision(loadDraft(to)) === draftRevision(this.recoverable)) this._recoverableKey = to;
      moveDraft(liveDraftKey(from), liveDraftKey(to), this._draftRevision);
    } else {
      moveDraft(oldKey, to, this._draftRevision);
    }
  }

  /** The file this document is: where it lives and its id on the drive, which the records kept for it are keyed by. */
  get file() {
    return { path: this.path, uid: this.uid };
  }

  /** "Budget" for Spreadsheets/Budget.xlsx; the file name for others. */
  static nameFor(path) {
    return stripExtension(P.displayName(path));
  }

  get isXlsxPath() {
    return !!this.path && /\.xlsx$/i.test(this.path);
  }

  get fileName() {
    return P.ensureXlsx(this.name);
  }

  /** File and version operations may still be pending while the book is clean. */
  get hasPendingWrites() {
    return this._saving != null;
  }

  destroy() {
    if (this.collab) { this._leaveRoom(); return; }
    clearTimeout(this._timer);
    clearTimeout(this._draftTimer);
    if (!this.wb.dirty) clearDraft(this._ownDraftKey, this._draftRevision);
    this.wb.removeEventListener('change', this._onChange);
    session.removeEventListener('change', this._onSession);
  }

  /** The user allowed IMPORT* formulas and web images in this file; recorded for the file. */
  allowExternal() {
    this.wb.setExternalAllowed(true);
    recordExternal({ path: this.path, uid: this.uid }, this._storageScope, true);
  }

  /** Content from another file was merged in: ask again before anything reaches out. */
  distrustExternal() {
    this.wb.setExternalAllowed(false);
    recordExternal({ path: this.path, uid: this.uid }, this._storageScope, false);
  }

  /** Where this document's local draft lives. */
  get draftKey() {
    return !this.path && this._recoveredDraftKey || draftKey(this.path, this.name, this._storageScope, this._draftId);
  }

  /**
   * Where this document's own edits are drafted. A recovered draft awaiting a decision lives under
   * the document's key and must not be overwritten by the edits made meanwhile, or the offer to
   * restore it would restore those instead; they are kept beside it until the decision is made.
   */
  get _ownDraftKey() {
    return this.recoverable ? liveDraftKey(this.draftKey) : this.draftKey;
  }

  /** Copy the unsaved book to local storage (no-op once it is clean). */
  writeDraft() {
    // A shared workbook keeps unsent changes in its own outbox (see collab/outbox.js), not in a draft.
    if (this.collab) return false;
    clearTimeout(this._draftTimer);
    if (!this.wb.dirty) { clearDraft(this._ownDraftKey, this._draftRevision); return false; }
    // Timestamps and workbook versions can coincide across tabs. Each write
    // needs its own identity so a later save cannot clear another tab's edits.
    const revision = uniqueId();
    // The file's revision these edits were made on, so reopening can tell whether it changed since,
    // and its id, by which the file is found again should it be moved or renamed elsewhere.
    const saved = saveDraft(this._ownDraftKey, this.wb, this.name, revision, { fileModified: this.path ? this.remoteModified : undefined, fileUid: (this.path && this.uid) || undefined });
    if (saved) this._draftRevision = revision;
    this._noteDraft(saved);
    return saved;
  }

  /**
   * The file holds the book: this document's own draft goes, from where it lives now and, when a first save
   * or a copy under a new name moved it, from where it lived before, should it not have followed (storage
   * refused the record under the new address, say) — a draft left there listed an unsaved spreadsheet for
   * a file that was saved. A recovered draft still awaiting a decision is not this document's, and stays.
   */
  _clearOwnDraft(oldKey = null) {
    clearTimeout(this._draftTimer);
    for (const key of new Set([this._ownDraftKey, ...(oldKey ? [oldKey, liveDraftKey(oldKey)] : [])])) clearDraft(key, this._draftRevision);
  }

  /** Whether the draft could be written: the view is told when that changes, so nobody counts on a copy that is not there. */
  _noteDraft(kept) {
    if (this.draftKept === kept) return;
    this.draftKept = kept;
    this.dispatchEvent(new CustomEvent('draft', { detail: { kept } }));
  }

  /** Put the recovered draft's contents in place of the file's; it saves like any edit. */
  restoreDraft() {
    const draft = this.recoverable;
    if (!draft) return false;
    // Older than the file, the draft replaces what the file got since (from another device, say), which the
    // restore's save then writes over and the cleared history cannot bring back: it is kept as a version first,
    // as a restore from Version history keeps the current state, so that the dialog's choice loses nothing.
    if (this.recoverableMayBeOlder && this.path && this.isXlsxPath) this._snapshotBeforeRestore(this.wb.toJSON());
    // The edits made meanwhile give way to the restored ones, in storage as in the book: whatever is kept
    // beside the draft goes, whether this document wrote it or an earlier one that closed before deciding.
    clearDraft(this._ownDraftKey);
    this._draftRevision = draftRevision(draft);
    this.recoverable = null;
    this._recoverableKey = null;
    this.recoverableMayBeOlder = false;
    this.wb.replaceWith(draft.workbook);
    this._changed('cells');
    return true;
  }

  /** A "Before restore" snapshot of the book as it was (`json`), written ahead of the saves queued after it (best effort). */
  _snapshotBeforeRestore(json) {
    return this._enqueueWrite(async () => {
      if (!this.path || !this.isXlsxPath) return;
      try {
        const entry = await saveVersion(this.file, await workbookToXlsx(new Workbook(json)), RESTORE_LABEL);
        this._lastVersionAt = entry.at;
      } catch (e) { console.warn('Version snapshot failed', e); }
    });
  }

  /** Forget the recovered draft; the file's contents stand. */
  discardDraft() {
    const key = this._recoverableKey || this.draftKey;
    clearDraft(key, draftRevision(this.recoverable));
    this.recoverable = null;
    this._recoverableKey = null;
    this.recoverableMayBeOlder = false;
    // The edits made meanwhile are the document's draft now, whichever document wrote them beside it.
    moveDraft(liveDraftKey(key), this.draftKey);
  }

  _setStatus(status, error = null) {
    if (this.status === status && this.error === error) return;
    this.status = status;
    this.error = error;
    this.dispatchEvent(new CustomEvent('status', { detail: { status, error } }));
  }

  _changed(type) {
    if (type === 'active-sheet') return;
    if (this.collab) { this._sharedChanged(type); return; }
    if (type === 'clean') {
      // The book was declared clean without a save (columns fitted on open, say): nothing is pending.
      if (!this.wb.dirty && this.status === 'unsaved') {
        clearTimeout(this._timer);
        clearTimeout(this._draftTimer);
        this._setStatus('saved');
      }
      return;
    }
    if (!this.wb.dirty) return;
    this._setStatus('unsaved');
    clearTimeout(this._timer);
    // Signing in later saves the pending edits; the view asks for it.
    if (!session.signedOut && autoSaveEnabled()) {
      this._timer = setTimeout(() => this.save({ auto: true }).catch(() => {}), AUTOSAVE_MS);
      this._timerIsRetry = false;
    }
    clearTimeout(this._draftTimer);
    this._draftTimer = setTimeout(() => this.writeDraft(), draftMs());
  }

  /** Turn AutoSave on or off; turning it on saves what is waiting. */
  setAutoSave(on) {
    setAutoSaveEnabled(!!on);
    // Off, an edit's AutoSave still waiting is dropped too; a retry of a failed save keeps going, as it does after Save.
    if (!on && !this._timerIsRetry) clearTimeout(this._timer);
    if (on && this.wb.dirty && !session.signedOut) this.save({ auto: true }).catch(() => {});
    this.dispatchEvent(new CustomEvent('autosave', { detail: { on: !!on } }));
  }

  /** Save now. Returns true when the file was written. */
  save({ auto = false, retry = false } = {}) {
    if (this.collab) return this._enqueueWrite(() => this._saveShared({ auto }));
    clearTimeout(this._timer);
    if (!retry) this._retryDelay = 0; // an edit, a save asked for, or coming back online starts the retries over
    return this._enqueueWrite(() => {
      // Nothing to write: a clean file, or an automatic save (coming back
      // online, say) of a book that never changed and has no file yet.
      if (!this.wb.dirty && (auto || (this.path && this.isXlsxPath))) {
        // A stale error or offline status from an earlier attempt does not describe a clean book.
        if (this.status === 'error' || this.status === 'offline') this._setStatus('saved');
        return true;
      }
      if (session.signedOut) {
        if (auto) return false;
        return Promise.reject(new Error(SIGN_IN_TO_SAVE));
      }
      return this._doSave(auto);
    });
  }

  /** Saves and path changes share one queue, including operations queued while another waits. */
  _enqueueWrite(action) {
    const operation = this._saving ? this._saving.catch(() => {}).then(action) : Promise.resolve(action());
    const pending = operation.finally(() => {
      if (this._saving === pending) this._saving = null;
    });
    this._saving = pending;
    return pending;
  }

  /** Save even if the file changed elsewhere (the user chose to overwrite). */
  forceSave() {
    clearTimeout(this._timer);
    return this._enqueueWrite(() => this._doSave(false, true));
  }

  async _doSave(auto, force = false) {
    const version = this.wb.version;
    try {
      // A failed check cannot establish that overwriting is safe. Keep the
      // edits dirty and use the normal save-error/retry path in that case.
      if (this.path && this.isXlsxPath && this.remoteModified != null && !force) {
        // Gone from its address, the file was moved or renamed elsewhere (the drive still knows it by
        // its id, and the document follows) or deleted: writing here would make another file of that
        // name, so the user is asked instead.
        const st = await P.statFile(this.path) || await this._followMove();
        if (!st) {
          this._setStatus('conflict', 'This file was moved or deleted');
          this.dispatchEvent(new CustomEvent('conflict', { detail: { kind: 'missing' } }));
          return false;
        }
        const mod = modifiedMs(st);
        // Written from elsewhere within the same second as our last save, the time cannot tell; a different size can.
        const resized = this.remoteSize != null && sizeOf(st) != null && sizeOf(st) !== this.remoteSize;
        const newer = mod != null && mod > this.remoteModified;
        // The drive stamps a rename or move as a modification: a file renamed away and back, or put back
        // from the trash, elsewhere is at its address again with a newer time and the same bytes, which
        // read as a change made there, and the dialog's "Reload theirs" would discard the edits. With the
        // size unchanged, the bytes decide when the file is small enough to read back: still the ones
        // written here, the new time is the baseline the next save checks against (see _adoptMovedTime).
        // Modification times are whole seconds: a write from elsewhere within the very second this
        // document's baseline names reads as no change at all, and one of the same length passes the
        // size check too, so the bytes are asked for when they are in hand. Bytes that are not this
        // document's are a change made elsewhere; a read that will not answer leaves the save as it
        // was, rather than putting the question to the user on every save a flaky connection meets.
        const ambiguous = !newer && !resized && mod != null && mod === this.remoteModified && !!this._written && sizeOf(st) != null;
        if (newer && !resized && await this._holdsLastWrite(st) === true) this.remoteModified = mod;
        else if (newer || resized || (ambiguous && await this._holdsLastWrite(st) === false)) {
          // With no baseline (the look-up failed at open) nobody can say the file changed: the question is put as such.
          const unchecked = this.remoteModified === 0;
          this._setStatus('conflict', unchecked ? 'This file could not be checked for changes made elsewhere' : 'This file changed elsewhere');
          this.dispatchEvent(new CustomEvent('conflict', { detail: { kind: unchecked ? 'unchecked' : 'changed', remoteModified: mod } }));
          return false;
        }
      }
      this._setStatus('saving');
      const fresh = !this.path || !this.isXlsxPath;
      let target = this.path;
      let dir = P.FOLDER; // the folder a fresh file goes in
      let oldKey = null; // where the draft lived before a first save gave the document its file
      if (fresh) {
        // First save, or a non-xlsx source: pick a fresh name. A name with nothing left once sanitized
        // ("..", a lone space) would make the nameless dotfile ".xlsx": it is untitled instead.
        const base = this.path ? Doc.nameFor(this.path) : this.name;
        const fileName = P.ensureXlsx(P.sanitizeName(base) || UNTITLED);
        // A file from elsewhere on the drive (a .csv double-clicked on the desktop, say) gets its .xlsx beside
        // it, where whoever opened it looks for it; anything else gets one in the app folder.
        dir = besideDir(this.path) ?? P.FOLDER;
        target = dir === P.FOLDER ? `${P.FOLDER}/${await P.uniqueName(fileName)}` : `${dir}/${fileName}`;
      }
      // The book is encoded once per version: a retry after a failed write, or a save forced after a
      // conflict, sends the bytes already built instead of building the whole book again on the main thread.
      const exportedVersion = this.wb.version;
      const blob = this._exported?.wb === this.wb && this._exported.version === exportedVersion ? this._exported.blob : await workbookToXlsx(this.wb);
      this._exported = { wb: this.wb, version: exportedVersion, blob };
      // The name check is advisory: another tab can create that file before
      // this write reaches the server. Deduplicate there, then adopt its name.
      let written;
      try {
        written = await P.writeFile(target, blob, { dedupe: fresh });
      } catch (e) {
        // A folder this user may not write in (someone else's, shared with them) refuses the file beside the
        // source: the app folder takes it instead. Offline, neither would, and the retry tries beside it again.
        if (dir === P.FOLDER || globalThis.navigator?.onLine === false) throw e;
        dir = P.FOLDER;
        target = `${P.FOLDER}/${await P.uniqueName(P.displayName(target))}`;
        written = await P.writeFile(target, blob, { dedupe: true });
      }
      this.uid = written?.uid || written?.id || this.uid;
      if (fresh) {
        oldKey = this.draftKey;
        // The name storage chose, at the address it reports (see puter.js: one file, one address).
        this.path = P.canonicalPath(`${dir}/${written?.name || P.displayName(written?.path || target)}`, written);
        this.name = Doc.nameFor(this.path);
        this._moveDraft(oldKey);
        recordExternal({ path: this.path, uid: this.uid }, this._storageScope, this.wb.externalAllowed);
        // A history left under the new file's name by a file that is gone is put aside: this file's starts empty.
        await parkVersions(this.file).catch(() => {});
        this.dispatchEvent(new CustomEvent('path', { detail: { path: this.path, name: this.name } }));
      }
      this.lastSaved = Date.now();
      this._retryDelay = 0;
      this.remoteModified = modifiedMs(written) ?? modifiedMs(await P.statFile(this.path).catch(() => null)) ?? Date.now();
      this.remoteSize = blob.size;
      this._written = blob.size <= COMPARE_MAX_BYTES ? blob : null;
      // Edits that landed while the write was in flight keep the doc dirty.
      if (this.wb.version === version) this.wb.markClean();
      this._setStatus(this.wb.dirty ? 'unsaved' : 'saved');
      if (this.wb.dirty) {
        this._changed('cells');
        // Edits that landed meanwhile were drafted against the file as it was before this save. Written
        // again now, the draft names the revision the file has, so that a tab closed before the next pause
        // in editing rewrote it does not offer them, on reopening, as older than the file they postdate.
        this.writeDraft();
      } else this._clearOwnDraft(oldKey);
      // In the background, but kept in hand: a rename waits for it, or the snapshot would land under the old name.
      const versioning = this._autoVersion(blob).catch(() => {}).finally(() => { if (this._versioning === versioning) this._versioning = null; });
      this._versioning = versioning;
      trackEvent('Spreadsheet Saved', { method: auto ? 'auto' : 'manual' });
      return true;
    } catch (e) {
      console.error(e);
      // Shared with the user only to view (see viewOnly): Puter refuses the write, and asking again changes nothing.
      const refused = this.viewOnly && navigator.onLine;
      this._setStatus(navigator.onLine ? 'error' : 'offline', refused ? VIEW_ONLY : e?.message || String(e));
      // Try again later; a transient failure should not lose the edit. One that lasts (a full drive,
      // say) is not helped by encoding and sending the whole book every few seconds, so the pauses grow.
      // A save asked for by hand reports its failure to the caller, but leaves the edit in the autosave's
      // hands as well: it cleared the retry a failed autosave had scheduled, so without one of its own
      // nothing tried again until the next edit. The retry is an ordinary save, which checks the file
      // again and asks again if it is still changed or missing, never one forced over what landed since.
      if (this.wb.dirty && !session.signedOut && !refused) {
        this._retryDelay = Math.min(this._retryDelay ? this._retryDelay * 2 : RETRY_MS, RETRY_MAX_MS);
        this._timer = setTimeout(() => this.save({ auto: true, retry: true }).catch(() => {}), this._retryDelay);
        this._timerIsRetry = true;
      }
      if (!auto) throw e;
      return false;
    }
  }

  /** A snapshot after a save, when the newest one is old enough (best effort, in the background). */
  async _autoVersion(blob) {
    if (!this.path || !this.isXlsxPath) return;
    const { path } = this;
    const file = this.file;
    if (this._lastVersionAt === undefined) {
      // The first save of a session takes over the history this file kept under its name, so that it
      // is the file's own from here on, whatever a rename made outside the app calls the file next.
      await adoptVersionsByUid(file).catch(() => {});
      let lastAt;
      try { lastAt = (await listVersions(file))[0]?.at ?? null; } catch { lastAt = null; }
      // A path change or another completed snapshot may have happened while
      // the history was loading. Do not attach this blob to a different file.
      if (this.path !== path) return;
      if (this._lastVersionAt === undefined) this._lastVersionAt = lastAt;
    }
    if (!dueForVersion(this._lastVersionAt)) return;
    this._lastVersionAt = Date.now(); // claimed first, so overlapping saves write one snapshot
    try { await saveVersion(file, blob); } catch (e) { console.warn('Version snapshot failed', e); }
  }

  /**
   * A snapshot was removed from the history (by hand, in the dialog): which snapshot is the newest
   * is looked up again before the next save decides whether another is due, rather than going on
   * naming one that is gone and skipping its own for as long as that one would have counted.
   */
  forgetVersionClock() {
    this._lastVersionAt = undefined;
  }

  /** Save a snapshot of the current state now, optionally labeled. */
  saveVersion(label = '') {
    return this._enqueueWrite(() => this._saveVersion(label));
  }

  async _saveVersion(label) {
    // Already inside the write queue; a first save must not enqueue itself. A CSV or other
    // foreign file gets its .xlsx first, so the snapshot lands in that file's history.
    if (!this.path || !this.isXlsxPath) await this._doSave(false);
    const blob = await workbookToXlsx(this.wb);
    const entry = await saveVersion(this.file, blob, label);
    this._lastVersionAt = entry.at;
    return entry;
  }

  /** Replace the contents with a snapshot's, keeping a snapshot of the current state first. */
  restoreVersion(versionPath) {
    return this._enqueueWrite(() => this._restoreVersion(versionPath));
  }

  async _restoreVersion(versionPath) {
    const bytes = await readVersion(versionPath);
    const other = await workbookFromFile(bytes, 'version.xlsx', { sourceWorkbook: workbookPathUri(P.resolvedAbsolutePath(this.path)) });
    // A snapshot is content from a file, and histories are kept by name: it may be another file's (one deleted
    // since, whose name this one took). One that reaches out is taken like an import, asking before anything
    // reaches out, unless the user allowed this very file, whose own snapshots it then is.
    const distrust = usesExternalContent(other) && await recordedExternalDecision({ path: this.path, uid: this.uid }, this._storageScope) !== true;
    const version = this.wb.version;
    await this._saveVersion(RESTORE_LABEL);
    // The backup contains the state at serialization, not edits made while
    // it uploads. Those edits must remain available in the current workbook.
    if (this.wb.version !== version) throw new Error('The spreadsheet changed while preparing to restore. Your edits are intact; try restoring again.');
    if (distrust) this.distrustExternal();
    // The record of edits (Show Changes) goes on through a restore, which is one more change to it.
    const changeHistory = this.wb.changeHistory;
    this.wb.replaceWith(other.toJSON());
    this.wb.changeHistory = changeHistory;
    recordStep(this.wb, 'structure', 'Restore version');
    this._changed('cells');
    return true;
  }

  /** Rename the file (and the document). Returns null or an error message. */
  rename(newName) {
    return this._enqueueWrite(() => this._rename(newName));
  }

  async _rename(newName) {
    const clean = P.sanitizeName(newName).replace(/\.xlsx$/i, '');
    if (!clean) return 'Enter a name';
    if (clean === this.name) return null;
    if (!this.path) {
      const oldKey = this.draftKey;
      this.name = clean;
      this._recoveredDraftKey = null;
      this._moveDraft(oldKey);
      this.dispatchEvent(new CustomEvent('path', { detail: { path: null, name: clean } }));
      return null;
    }
    // A snapshot of the last save may still be on its way to the old name's history; let it land before that history moves.
    await this._versioning;
    const slash = this.path.lastIndexOf('/');
    const dot = this.path.lastIndexOf('.');
    const dir = slash >= 0 ? this.path.slice(0, slash + 1) : '';
    // A file without an extension keeps having none.
    const ext = this.isXlsxPath ? '.xlsx' : dot > slash ? this.path.slice(dot) : '';
    const target = `${dir}${clean}${ext}`;
    try {
      // A failed look-up (offline, an expired session) is an answer for the user, not an exception.
      if (await P.fileExists(target)) return 'A file with that name already exists';
      // The file as it was just before: whether its new time stands for the rename alone (see _adoptMovedTime).
      const before = await P.statFile(this.path);
      const renamed = await P.renameFile(this.path, `${clean}${ext}`);
      this._adoptMovedTime(renamed, before);
    } catch (e) {
      return e?.message || 'Could not rename the file';
    }
    await this._adoptPath(target, clean);
    return null;
  }

  /**
   * Does the file, as `st` describes it, hold the bytes this document last wrote? True or false when
   * they can be compared, and null when they cannot: no write of this document's in hand to compare
   * with, a file too large for the read to be cheap, a size the drive does not report, or a read that
   * would not answer. Not knowing counts against a file whose time says it was written elsewhere, so
   * that doubt raises the question there, and for the rest leaves the save as it would have been.
   */
  async _holdsLastWrite(st) {
    const mine = this._written;
    if (!mine || sizeOf(st) == null) return null;
    if (sizeOf(st) !== mine.size) return false;
    try {
      const theirs = new Uint8Array(await P.readFile(this.path));
      const ours = new Uint8Array(await mine.arrayBuffer());
      return theirs.length === ours.length && theirs.every((byte, i) => byte === ours[i]);
    } catch { return null; }
  }

  /**
   * The drive stamps a rename or move as a modification, though the bytes are the same. With the
   * size as last written, the file's new time is the baseline the next save checks against, not a
   * change made elsewhere: read as one, every rename would raise the conflict dialog, whose "Reload
   * theirs" discards the edits. A different size still reads as a change, and so does a write from
   * elsewhere the file showed just before it was renamed here. A baseline never known stays unknown.
   */
  _adoptMovedTime(item, before = null) {
    if (!this.remoteModified) return;
    const resized = (it) => this.remoteSize != null && sizeOf(it) != null && sizeOf(it) !== this.remoteSize;
    if (resized(item) || (before && (resized(before) || modifiedMs(before) > this.remoteModified))) return;
    this.remoteModified = modifiedMs(item) ?? this.remoteModified;
  }

  /** The file is known by `target` now: the document, its draft, history and outside-content decision follow, and the view learns of it. */
  async _adoptPath(target, name) {
    const oldKey = this.draftKey;
    const oldPath = this.path;
    this.path = target;
    this.name = name;
    this._lastVersionAt = undefined;
    this._moveDraft(oldKey);
    // A history kept under the file's id stays where it is; one still kept under the old name moves
    // before anything else writes under the new one, or a snapshot taken meanwhile would occupy the
    // folder and strand the old ones (this already runs in the write queue).
    await moveVersions({ path: oldPath, uid: this.uid }, this.file).catch(() => {});
    // The decision follows the file; whatever lands at the old path later is another file.
    rememberExternal(oldPath, this._storageScope, null);
    recordExternal({ path: this.path, uid: this.uid }, this._storageScope, this.wb.externalAllowed);
    this.dispatchEvent(new CustomEvent('path', { detail: { path: this.path, name: this.name, oldPath } }));
  }

  /**
   * The file is not at its address any more. Moved or renamed elsewhere it kept its id, and the
   * document follows it there. Its entry where it is now, or null when the drive has no such file.
   */
  async _followMove() {
    const moved = this.uid ? await P.statByUid(this.uid).catch(() => null) : null;
    if (!followable(moved, this.path)) return null;
    if (!P.samePath(moved.path, this.path)) {
      await this._versioning; // a snapshot of the last save may still be on its way to the old name's history
      await this._adoptPath(moved.path, Doc.nameFor(moved.path));
      this._adoptMovedTime(moved);
    }
    return moved;
  }

  /** Save a copy under a new name in the app folder and switch to it. */
  saveAs(newName) {
    return this._enqueueWrite(() => this._saveAs(newName));
  }

  async _saveAs(newName) {
    const clean = P.sanitizeName(newName).replace(/\.xlsx$/i, '');
    if (!clean) return 'Enter a name';
    const target = `${P.FOLDER}/${clean}.xlsx`;
    try {
      if (await P.fileExists(target)) return 'A file with that name already exists';
    } catch (e) {
      return e?.message || 'Could not save';
    }
    clearTimeout(this._timer);
    const version = this.wb.version;
    this._setStatus('saving');
    let written;
    try {
      const blob = await workbookToXlsx(this.wb);
      written = await P.writeFile(target, blob, { overwrite: false });
      this.remoteModified = modifiedMs(written) ?? modifiedMs(await P.statFile(target).catch(() => null)) ?? Date.now();
      this.remoteSize = blob.size;
      this._written = blob.size <= COMPARE_MAX_BYTES ? blob : null;
    } catch (e) {
      // The copy failed; the original is as it was. Its own edits, if any, keep saving as usual.
      this._setStatus(this.wb.dirty ? 'unsaved' : 'saved');
      if (this.wb.dirty) this._changed('cells');
      return e?.message || 'Could not save';
    }
    clearTimeout(this._draftTimer);
    const oldKey = this.draftKey;
    this.path = P.canonicalPath(target, written);
    this.uid = written?.uid || written?.id || null; // another file, with its own decision
    this.viewOnly = false; // the copy is the user's own
    this.name = clean;
    this._lastVersionAt = undefined;
    this._moveDraft(oldKey);
    recordExternal({ path: this.path, uid: this.uid }, this._storageScope, this.wb.externalAllowed);
    await parkVersions(this.file).catch(() => {}); // a gone file's history under the new name is not the copy's
    this.lastSaved = Date.now();
    if (this.wb.version === version) this.wb.markClean();
    this._setStatus(this.wb.dirty ? 'unsaved' : 'saved');
    if (this.wb.dirty) { this.writeDraft(); this._changed('cells'); }
    else this._clearOwnDraft(oldKey);
    this.dispatchEvent(new CustomEvent('path', { detail: { path: this.path, name: this.name } }));
    trackEvent('Spreadsheet Saved', { method: 'copy' });
    return null;
  }

  /** A downloaded copy, to keep or hand on: without Show Changes' record of what cells used to hold. */
  async toXlsxBlob() {
    return workbookToXlsx(this.wb, { history: false });
  }

  async toOdsBlob() {
    return workbookToOds(this.wb, { history: false });
  }

  toCsvBlob(sheetId = this.wb.activeSheetId) {
    return new Blob([sheetToCsv(this.wb, sheetId)], { type: CSV_MIME });
  }

  toTsvBlob(sheetId = this.wb.activeSheetId) {
    return new Blob([sheetToTsv(this.wb, sheetId)], { type: TSV_MIME });
  }

  /** The sheet as a web page, titled with the document (and sheet, when there are several). */
  toHtmlBlob(sheetId = this.wb.activeSheetId) {
    const sheet = this.wb.sheet(sheetId);
    const title = this.wb.sheets.length > 1 && sheet ? `${this.name} — ${sheet.name}` : this.name;
    return new Blob([sheetToHtml(this.wb, sheetId, { title })], { type: HTML_MIME });
  }

  /* ---------- Constructors ---------- */

  /** Recover a spreadsheet that closed before its first cloud save. */
  /* ---------- Shared workbooks (see collab/client.js) ---------- */

  /**
   * The document of a shared workbook: its changes go to everyone through the room as they are made, and
   * saving writes a checkpoint and the .xlsx file (over the owner's file, so it still opens anywhere).
   */
  static forRoom(client, { path = null, uid = null } = {}) {
    const doc = new Doc({ wb: client.wb, name: client.name || UNTITLED, path: client.file?.path ?? path, uid: client.file?.uid ?? uid });
    doc.collab = client;
    doc._onRoomStatus = () => doc._sharedChanged('room');
    client.addEventListener('status', doc._onRoomStatus);
    doc._setStatus(client.status.pending ? 'saving' : 'saved');
    return doc;
  }

  get isOwner() {
    return !!this.collab && this.collab.user?.uuid === this.collab.owner;
  }

  /** A change reached a shared workbook (here or from someone else): the status follows the room's, and the file is written once things settle. */
  _sharedChanged(type) {
    const { state, pending } = this.collab.status;
    if (state === 'offline') this._setStatus('offline', this.collab.status.message);
    else if (state === 'error') this._setStatus('error', this.collab.status.message);
    else this._setStatus(pending ? 'saving' : 'saved');
    if (type === 'room' || type === 'clean' || !this.wb.dirty) return;
    // The owner's browser keeps the .xlsx current while it is open: a while after the last change, everyone's.
    if (this.isOwner && autoSaveEnabled() && !session.signedOut) {
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this.save({ auto: true }).catch(() => {}), SHARED_FILE_MS);
    }
  }

  /** Deliver what is pending, then write a checkpoint and the .xlsx. */
  async _saveShared({ auto = false } = {}) {
    const client = this.collab;
    clearTimeout(this._timer);
    await client.flush();
    await client.settled();
    if (client.replica.pending.length) {
      this._sharedChanged('room');
      if (auto) return false;
      throw new Error(client.status.message || 'Your changes are waiting to be sent. They are kept on this device until the connection returns.');
    }
    if (!client.canEdit) { this.wb.markClean(); return true; }
    this._setStatus('saving');
    try {
      const res = await client.checkpoint({ file: true });
      // The worker writes the owner's file when Puter lets it; the owner's own browser can always.
      if (this.isOwner && this.path && this.isXlsxPath && !res?.wrote) await P.writeFile(this.path, await workbookToXlsx(this.wb), { overwrite: true });
      this.lastSaved = Date.now();
      this.wb.markClean();
      this._setStatus('saved');
      return true;
    } catch (e) {
      this._setStatus(client.status.state === 'offline' ? 'offline' : 'error', e?.message || 'Could not save');
      if (auto) return false;
      throw e;
    }
  }

  _leaveRoom() {
    clearTimeout(this._timer);
    this.collab.removeEventListener('status', this._onRoomStatus);
    this.wb.removeEventListener('change', this._onChange);
    session.removeEventListener('change', this._onSession);
    this.collab.leave().catch(() => {});
  }

  static fromDraft(key) {
    // Only this account's drafts of spreadsheets that have no file are recovered this way.
    const draft = isUnsavedDraftKey(key) ? loadDraft(key) : null;
    if (!draft) throw new Error('That unsaved spreadsheet is no longer available');
    const doc = Doc._fromDraftRecord(draft);
    // A record that cannot be read or loaded (damaged in storage, or written in another shape) would
    // fail the same way each time it is picked: it is dropped, and the failure put in words for the screen.
    if (!doc) { clearDraft(key, draftRevision(draft)); throw new Error('Could not read the unsaved spreadsheet'); }
    // Keep the exact source key, including older title-only drafts, until
    // this recovered document is renamed or gets a cloud path.
    doc._recoveredDraftKey = key;
    return doc;
  }

  /** A dirty document holding a draft's book, under the draft's name; it saves like any unsaved sheet. Null for a record the workbook cannot load. */
  static _fromDraftRecord(draft) {
    if (!readableDraft(draft)) return null;
    let wb;
    try { wb = new Workbook(draft.workbook); } catch { return null; }
    // A draft of an import from elsewhere keeps its outside content blocked.
    const doc = new Doc({ wb, name: draft.name, trusted: draft.external !== false });
    doc._draftRevision = draftRevision(draft);
    doc.wb.dirty = true;
    doc._changed('cells');
    return doc;
  }

  /**
   * A file is gone from its address, but this browser kept edits made to it that never reached
   * Puter. When the draft names the file's id and the drive still has the file, moved or renamed
   * elsewhere, the file opens from where it is now, with the draft offered as usual. Otherwise the
   * edits open as a new spreadsheet, so that they are not lost with the file. Null without such a draft.
   */
  static async _fromLostFile(path, scope) {
    const key = draftKey(path, '', scope);
    let draft = loadDraft(key);
    // Edits made while that draft awaited a decision were kept beside it (see _ownDraftKey). Never saved
    // either, and the newer, they are the lost file's draft; the earlier draft is kept as an unsaved
    // spreadsheet of its own rather than left behind under the address, where nothing lists it.
    const live = loadDraft(liveDraftKey(key));
    if (readableDraft(live) && (!readableDraft(draft) || parkDraft(key, draftRevision(draft)))) {
      moveDraft(liveDraftKey(key), key, draftRevision(live));
      draft = live;
    }
    // A record that is no readable book is dropped, as it would be were the file still here, so the address is not kept alive by it.
    if (!readableDraft(draft)) { if (draft) clearDraft(key, draftRevision(draft)); return null; }
    const moved = draft.fileUid ? await P.statByUid(draft.fileUid).catch(() => null) : null;
    if (followable(moved, path) && !P.samePath(moved.path, path)) {
      moveDraft(key, draftKey(moved.path, '', scope), draftRevision(draft));
      moveDraft(liveDraftKey(key), liveDraftKey(draftKey(moved.path, '', scope))); // still beside it when the earlier draft could not be parked
      return Doc.fromPath(moved.path);
    }
    const doc = Doc._fromDraftRecord(draft);
    if (!doc) { clearDraft(key, draftRevision(draft)); return null; } // shaped like a book, but the workbook will not load it
    // Whatever lands at the old address later is another file: the draft is an unsaved spreadsheet's now.
    moveDraft(key, doc.draftKey, doc._draftRevision);
    return doc;
  }

  static async fromPath(path) {
    // Capture the baseline before reading bytes. A stat after a slow read
    // can describe somebody else's newer file, making stale edits look safe.
    const st = await P.statFile(path).catch(() => null);
    const remoteModified = modifiedMs(st);
    // One file, one address: keep the one the drive reports, and let the records this
    // browser kept under another spelling of it (the relative one, say) follow.
    const canonical = P.canonicalPath(path, st);
    if (P.isAbsolutePath(canonical)) await P.resolveAppFolder();
    const scope = storageScope();
    for (const other of new Set([path, P.legacyAppPath(canonical)])) adoptRecords(other, canonical, scope);
    let bytes;
    try {
      bytes = await P.readFile(path);
    } catch (e) {
      // No such file, but perhaps a draft of edits made to it here that never reached Puter.
      const lost = !st && P.isNotFound(e) ? await Doc._fromLostFile(canonical, scope) : null;
      if (!lost) throw e;
      return lost;
    }
    const wb = await workbookFromFile(bytes, P.displayName(canonical), { sourceWorkbook: workbookPathUri(P.resolvedAbsolutePath(canonical)) });
    const uid = st?.uid || st?.id || null;
    // With no decision yet, a file in the app's own folder is trusted unless it reaches out (then it
    // asks first, however it got there); a file from elsewhere on the drive asks first regardless.
    const decision = await recordedExternalDecision({ path: canonical, uid }, scope);
    const trusted = decision ?? (P.inAppFolder(canonical) && !usesExternalContent(wb));
    const doc = new Doc({ wb, name: Doc.nameFor(canonical), path: canonical, uid, trusted });
    // An unknown baseline must not be treated as newer than the remote file.
    // With no baseline (the look-up failed) the first save cannot tell whether the file changed:
    // it asks, saying so, rather than overwriting blind.
    doc.remoteModified = remoteModified ?? 0;
    doc.remoteSize = sizeOf(st);
    // The bytes just read are what the file holds: kept, when small enough, so that the first save can read
    // the file back and tell a rename away and back (or a trash restore) elsewhere from a change made there.
    doc._written = bytes.byteLength <= COMPARE_MAX_BYTES ? new Blob([bytes]) : null;
    // A draft holds edits that never reached Puter; only one clearly from before the file's last save is dropped,
    // or one whose edits the file holds after all (the save landed, but the tab closed before the draft was cleared).
    const key = doc.draftKey;
    let book;
    /** Does the file hold the draft's edits already? Null for a draft this browser cannot read. */
    const inFile = (draft) => {
      if (!readableDraft(draft)) return null;
      try { return sameBook(draft.workbook, (book ??= wb.toJSON())); } catch { return null; }
    };
    /**
     * The draft under a key when it is worth offering, with its verdict. Dropped: a stale draft, one the file
     * holds already, and one that cannot be read (damaged in storage, or written in another shape), which
     * must not keep the file from opening.
     */
    const offered = (at) => {
      const draft = loadDraft(at);
      if (!draft) return null;
      // Made for another file, deleted since with this one saved under its name: not this file's unsaved
      // changes, so not offered as such (restoring would have put the old edits in the new file). They are
      // kept as an unsaved spreadsheet of their own, where the home screen lists them.
      if (readableDraft(draft) && draft.fileUid && uid && draft.fileUid !== uid && parkDraft(at, draftRevision(draft))) return null;
      const verdict = draftVerdict(draft, remoteModified);
      if (verdict === 'stale' || inFile(draft) !== false) { clearDraft(at, draftRevision(draft)); return null; }
      return { draft, verdict };
    };
    let undecided = offered(key);
    let live = offered(liveDraftKey(key));
    // Renamed or moved elsewhere since edits to it were drafted here, the file kept its id but not
    // the address the draft is keyed by: the draft follows it to the address it has now, and so do
    // the edits kept beside it while it awaited a decision, which are the newer and are offered below.
    // The address may have been holding a record of another file's, which is set aside just above:
    // the move is tried once that has happened, or the real edits would stay where nothing reads them.
    if (uid && loadDraft(key) == null) {
      const orphan = draftKeyForFile(uid, scope);
      if (orphan) {
        moveDraft(orphan, key);
        // What is kept beside a draft here already is this file's too, and stands.
        if (loadDraft(liveDraftKey(key)) == null) moveDraft(liveDraftKey(orphan), liveDraftKey(key));
        undecided = offered(key);
        live ??= offered(liveDraftKey(key));
      }
    }
    // Edits made while an earlier draft awaited a decision were kept beside it (see _ownDraftKey). Never
    // saved either, and the newer, they are the draft on offer; the earlier draft, still undecided, is kept
    // as an unsaved spreadsheet of its own, listed on the home screen, rather than offered again with the
    // edits stranded beside it, where the first edit here would have written over them.
    let offer = undecided;
    if (live && (!undecided || parkDraft(key, draftRevision(undecided.draft)))) {
      moveDraft(liveDraftKey(key), key, draftRevision(live.draft));
      offer = live;
    }
    if (offer) {
      doc.recoverable = offer.draft;
      doc._recoverableKey = key;
      doc.recoverableMayBeOlder = offer.verdict === 'older';
    }
    return doc;
  }

  /** From a browser File (device import). Saves as a new file on first change. */
  static async fromBrowserFile(file) {
    const wb = await workbookFromFile(await file.arrayBuffer(), file.name);
    // The name the file will be saved under; one with nothing left once sanitized ("...csv") is untitled.
    const doc = new Doc({ wb, name: P.sanitizeName(stripExtension(file.name)) || UNTITLED, path: null, trusted: false });
    // An import is worth keeping even before the first edit.
    doc.wb.dirty = true;
    doc._changed('cells');
    return doc;
  }

  /** A new, empty spreadsheet; `excel` starts it with the usual .xlsx defaults: Calibri 11 (the theme's body font) as the
   * Normal font, cells aligned to the bottom, and the format's default column width and row height. */
  /**
   * A new, empty workbook. `start` carries the app's options for new workbooks (lib/app-options.js): the font
   * and size, how many sheets, the view and headers they open with, and how the workbook calculates.
   */
  static blank({ excel = false, start = null } = {}) {
    if (!excel) return new Doc({ wb: new Workbook(null), name: UNTITLED });
    const font = start?.fontName && start.fontName !== 'Calibri' ? { name: start.fontName, sz: start.fontSize || 11 }
      : { name: 'Calibri', sz: start?.fontSize || 11, scheme: 'minor' };
    const count = Math.max(1, Math.min(255, Math.round(start?.newSheets || 1)));
    const view = start?.newView && start.newView !== 'normal' ? { viewMode: start.newView } : {};
    const headers = start && start.showHeaders === false ? { headers: false } : {};
    const sheets = Array.from({ length: count }, (_, i) => ({ name: `Sheet${i + 1}`, ...EXCEL_SHEET_DEFAULTS, defaultVAlign: 'bottom', ...view, ...headers }));
    const wb = new Workbook({ normalFont: font, sheets, ...(start?.newCalcMode === 'manual' ? { calcMode: 'manual' } : {}) });
    return new Doc({ wb, name: UNTITLED });
  }
}

export { XLSX_MIME };
