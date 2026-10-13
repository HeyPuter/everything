/**
 * FileService: opening and saving documents.
 *
 * Where files live:
 *   Cloud (signed in, or inside the Puter desktop): real files in the
 *     user's Puter storage. Save writes in place with puter.fs.write; Save As
 *     on a new document offers the "Your files" folder (Documents/Vector
 *     Studio when the user grants Documents access, otherwise the app's own
 *     Puter folder) or Puter's own Save dialog for any other location; Open
 *     uses Puter's own Open dialog.
 *   This computer (signed out on the open web): Open uses the File System
 *     Access API in Chromium (true save-in-place) or an <input type=file>;
 *     Save writes through the handle or downloads, and offers sign-in.
 *
 * editor.file = { kind: 'puter', path, name } | { kind: 'local', name, handle, handleId }
 *             | { kind: 'download', name } | { kind: 'import', name, path?, format }
 */
import { h } from '../../lib/dom.js';
import { uid } from '../../lib/ids.js';
import { openDialog } from '../../ui/dialogs/dialog.js';
import { serializeDocument, parseDocument, FileFormatError, toBytes, isGzip, gunzip, canCompress } from './format.js';
import { renderThumbnail } from './thumbnail.js';
import { NATIVE_EXT, NATIVE_MIME, baseName, ensureExtension, extensionOf, fileKind, joinPath, stripExtension, suggestFileName, uniqueName } from './naming.js';
import { classifyError, errorText, saveErrorDialog, sleep } from './errors.js';
import { handleStore, ensurePermission, fsAccessAvailable } from './handles.js';
import { isMissing, toMs } from './backends.js';

/** App-relative fallback folder (inside the app's own Puter folder). */
export const APPDATA_DIR = 'Documents';
export const DOCS_SUBDIR = 'Vector Studio';
export const OPEN_EXTS = ['.vstudio', '.svg', '.svgz'];

export function blobOf(bytes) {
  return new Blob([bytes], { type: NATIVE_MIME });
}

export function downloadBytes(bytes, name, type = NATIVE_MIME) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = h('a', { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The picker promise, resolving undefined on cancel where the SDK supports it. */
function cancellable(p) {
  return p && p.undefinedOnCancel ? p.undefinedOnCancel : p;
}

export class FileService {
  constructor(app, { recent, recovery = null, handles = handleStore } = {}) {
    this.app = app;
    this.recent = recent;
    this.recovery = recovery;
    this.handles = handles;
    this.docsDir = null; // resolved absolute "Documents/Vector Studio" path once granted
  }

  get puter() {
    return this.app.puter;
  }

  /** Files go to the Puter cloud when signed in or running inside the Puter desktop. */
  get cloud() {
    return Boolean(this.puter?.fs && (this.app.env === 'app' || this.app.user));
  }

  // ---- encoding ----

  async encode(editor, { thumbnail = true } = {}) {
    const doc = editor.doc;
    const rev = doc.revision;
    const thumb = thumbnail ? await renderThumbnail(doc) : null;
    const bytes = await serializeDocument(doc, { thumbnail: thumb });
    return { bytes, thumb, rev };
  }

  // ---- default folder ("Your files") ----

  /**
   * The folders "Your files" lists and the default Save location writes to.
   * Documents/Vector Studio in the user's home when Documents access is
   * granted (checked without prompting), plus the app's own folder.
   */
  async folders({ prompt = false } = {}) {
    const out = [];
    const docs = await this.documentsDir({ prompt });
    if (docs) out.push(docs);
    out.push(APPDATA_DIR);
    return out;
  }

  async documentsDir({ prompt = false } = {}) {
    if (this.docsDir) return this.docsDir;
    const perms = this.puter?.perms;
    const username = this.app.user?.username;
    if (!perms?.check || !this.cloud) return null;
    const details = { name: 'Documents', access: 'write' };
    try {
      let granted = await perms.check('folder', details);
      let base = null;
      if (!granted && prompt && perms.request) {
        base = await perms.request('folder', details);
        granted = Boolean(base);
      }
      if (!granted) return null;
      if (typeof base !== 'string') base = username ? `/${username}/Documents` : null;
      if (!base) return null;
      this.docsDir = joinPath(base, DOCS_SUBDIR);
      return this.docsDir;
    } catch {
      return null;
    }
  }

  /** Default Save location: Documents/Vector Studio when allowed, else the app folder. */
  async defaultDir({ prompt = true } = {}) {
    if (this.app.prefs.get('filesUseDocuments') !== false) {
      const d = await this.documentsDir({ prompt });
      if (d) return d;
    }
    return APPDATA_DIR;
  }

  /** .vstudio and .svg files in the default folders, newest first. */
  async listYourFiles() {
    if (!this.cloud) return [];
    const seen = new Set();
    const out = [];
    for (const dir of await this.folders()) {
      let items = [];
      try {
        items = await this.puter.fs.readdir(dir);
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
      for (const it of items || []) {
        if (it.is_dir || it.isDir) continue;
        const ext = extensionOf(it.name);
        if (!OPEN_EXTS.includes(ext)) continue;
        const path = it.path || joinPath(dir, it.name);
        if (seen.has(path)) continue;
        seen.add(path);
        out.push({ kind: 'puter', name: it.name, path, modified: toMs(it.modified), size: it.size || 0, format: ext === '.svg' || ext === '.svgz' ? 'svg' : 'native' });
      }
    }
    return out.sort((a, b) => b.modified - a.modified);
  }

  // ---- saving ----

  /** Save in place (Save As when the document has no file yet). Resolves true when saved. */
  save(editor = this.app.editor) {
    if (!editor) return Promise.resolve(false);
    if (editor._saving) return editor._saving;
    const job = this.#save(editor).finally(() => {
      editor._saving = null;
    });
    editor._saving = job;
    return job;
  }

  async #save(editor) {
    const f = editor.file;
    if (f?.kind === 'puter' && f.path && this.puter?.fs) return this.#writeCloud(editor, f);
    if (f?.kind === 'local' && f.handle) return this.#writeHandle(editor, f);
    if (f?.kind === 'download') {
      const enc = await this.encode(editor);
      downloadBytes(enc.bytes, f.name);
      this.#markSaved(editor, enc, f);
      return true;
    }
    return this.saveAs(editor);
  }

  async #writeCloud(editor, file, enc = null) {
    enc = enc || (await this.encode(editor));
    const r = await this.#withRetry(editor, enc, () => this.puter.fs.write(file.path, blobOf(enc.bytes), { overwrite: true, dedupeName: false, createMissingParents: true }));
    if (!r) return false;
    if (r.saveAs) return this.saveAs(editor);
    if (r.downloaded) return true;
    const item = r.result;
    this.#markSaved(editor, enc, { kind: 'puter', path: item?.path || file.path, name: item?.name || file.name });
    return true;
  }

  async #writeHandle(editor, file, enc = null) {
    enc = enc || (await this.encode(editor));
    if (!(await ensurePermission(file.handle, 'readwrite'))) {
      this.app.notify(`Permission to save "${file.name}" was not granted.`, { error: true });
      return false;
    }
    const r = await this.#withRetry(editor, enc, async () => {
      const w = await file.handle.createWritable();
      await w.write(blobOf(enc.bytes));
      await w.close();
    });
    if (!r) return false;
    if (r.saveAs) return this.saveAs(editor);
    if (r.downloaded) return true;
    this.#markSaved(editor, enc, file);
    return true;
  }

  /** Run a write with one quiet retry for transient errors, then ask. */
  async #withRetry(editor, enc, write) {
    for (let attempt = 0; ; attempt++) {
      try {
        return { result: await write() };
      } catch (err) {
        console.warn('Save failed', err);
        const info = classifyError(err);
        if (attempt === 0 && info.transient) {
          await sleep(900);
          continue;
        }
        const choice = await saveErrorDialog(editor.name, info);
        if (choice === 'retry') continue;
        if (choice === 'saveAs') return { saveAs: true };
        if (choice === 'download') {
          downloadBytes(enc.bytes, suggestFileName(editor.name));
          return { downloaded: true };
        }
        return null;
      }
    }
  }

  #markSaved(editor, enc, file) {
    const doc = editor.doc;
    editor.file = file;
    doc.savedRevision = enc.rev;
    doc.emit('saved');
    this.#remember(file, enc.thumb);
    this.recovery?.discard(editor);
    this.app.renderTabs();
    this.app.emit('file-saved', editor);
    this.app.notify(`Saved "${file.name}"`, { polite: true });
  }

  async #remember(file, thumb) {
    if (!this.recent) return;
    if (file.kind === 'puter' && file.path) await this.recent.add({ kind: 'puter', path: file.path, name: file.name, thumb });
    else if (file.kind === 'local' && file.handle) {
      let id = file.handleId || (await this.handles.find(file.handle));
      if (!id) {
        id = uid('h');
        if (!(await this.handles.put(id, file.handle))) return;
      }
      file.handleId = id;
      await this.recent.add({ kind: 'local', name: file.name, handleId: id, thumb });
    }
  }

  /**
   * Save As (or Save a Copy with copy: true, which leaves the document's
   * file and saved state alone). Resolves true when written.
   */
  async saveAs(editor = this.app.editor, { copy = false } = {}) {
    if (!editor) return false;
    const current = editor.file?.name || editor.doc.root.name;
    let suggested = suggestFileName(current);
    if (copy) suggested = `${stripExtension(suggested)} copy${NATIVE_EXT}`;

    if (!this.cloud && this.app.onSignIn && this.app.prefs.get('filesOfferSignIn') !== false) {
      const choice = await this.#offerSignIn(copy);
      if (!choice) return false;
      if (choice === 'signin') {
        await this.app.onSignIn();
        if (!this.cloud) return false;
      }
    }

    const enc = await this.encode(editor);
    if (this.cloud) return this.#saveAsCloud(editor, enc, suggested, { copy });
    if (fsAccessAvailable()) return this.#saveAsHandle(editor, enc, suggested, { copy });
    downloadBytes(enc.bytes, suggested);
    if (!copy) this.#markSaved(editor, enc, { kind: 'download', name: suggested });
    else this.app.notify(`Downloaded "${suggested}"`);
    return true;
  }

  async #offerSignIn(copy) {
    const skip = h('input', { type: 'checkbox', id: 'files-skip-signin' });
    const choice = await openDialog({
      title: copy ? 'Save a Copy' : 'Save',
      body: h(
        'div.files-signin',
        h('p.dialog-message', 'Sign in to save to your Puter cloud. Your files stay in your own storage and open from any device.'),
        h('p.dialog-message.muted', 'Or save the file to this computer instead.'),
        h('div.form-row.check', skip, h('label', { for: 'files-skip-signin' }, "Don't ask again")),
      ),
      buttons: [
        { label: 'Save to This Computer', value: 'local', left: true },
        { label: 'Cancel', value: null },
        { label: 'Sign In', value: 'signin', primary: true },
      ],
    });
    if (choice && skip.checked) this.app.prefs.set('filesOfferSignIn', false);
    return choice;
  }

  async #saveAsCloud(editor, enc, suggested, { copy }) {
    let target = null;
    if (this.app.prefs.get('filesSaveDialog') !== 'puter') target = await this.#saveDialog(editor, suggested, { copy });
    else target = { picker: true, name: suggested };
    if (!target) return false;
    let item = null;
    if (target.picker) {
      const ui = this.puter.ui;
      if (!ui?.showSaveFilePicker) {
        this.app.notify('The Puter Save dialog is not available here.', { error: true });
        return false;
      }
      try {
        item = await cancellable(ui.showSaveFilePicker(blobOf(enc.bytes), target.name));
      } catch (err) {
        await saveErrorDialog(editor.name, classifyError(err), { canSaveAs: false });
        return false;
      }
      if (!item) return false;
      // Keep the native extension so the file opens with Vector Studio later.
      if (!/\.vstudio$/i.test(item.name || '') && this.puter.fs.rename) {
        try {
          item = (await this.puter.fs.rename(item.path, ensureExtension(item.name))) || item;
        } catch {
          // Keep the name the user typed.
        }
      }
    } else {
      const r = await this.#withRetry(editor, enc, () => this.puter.fs.write(target.path, blobOf(enc.bytes), { overwrite: true, dedupeName: false, createMissingParents: true }));
      if (!r) return false;
      if (r.saveAs) return this.#saveAsCloud(editor, enc, suggested, { copy });
      if (r.downloaded) return !copy;
      item = r.result || { path: target.path, name: baseName(target.path) };
    }
    const file = { kind: 'puter', path: item.path, name: item.name || baseName(item.path) };
    if (copy) {
      this.#remember(file, enc.thumb);
      this.app.notify(`Saved a copy as "${file.name}"`);
      return true;
    }
    this.#markSaved(editor, enc, file);
    return true;
  }

  /**
   * Vector Studio's Save dialog: a name and the "Your files" folder, with
   * "Choose Location..." for Puter's own Save dialog. Resolves
   * { path } | { picker: true, name } | null.
   */
  async #saveDialog(editor, suggested, { copy }) {
    const dir = await this.defaultDir({ prompt: false });
    const nameInput = h('input', { type: 'text', id: 'files-save-name', value: stripExtension(suggested), spellcheck: false, autocomplete: 'off' });
    const where = h('p.form-help', { id: 'files-save-where' }, `Saves to Your files (${dir === APPDATA_DIR ? 'Vector Studio app folder' : dir.replace(/^\/[^/]+\//, '')}) in your Puter cloud.`);
    const error = h('p.form-error', { role: 'alert' });
    const usingDocs = dir !== APPDATA_DIR;
    const body = h(
      'div.form.files-save',
      h('div.form-row', h('label', { for: 'files-save-name' }, 'File name'), h('div.files-name-wrap', nameInput, h('span.files-ext', NATIVE_EXT))),
      where,
      !usingDocs && this.puter?.perms?.request && this.app.prefs.get('filesUseDocuments') !== false
        ? h('p.form-help', 'Tip: allow access to your Documents folder when asked to keep your files in Documents/Vector Studio.')
        : null,
      error,
    );
    let chosenDir = dir;
    const result = await openDialog({
      title: copy ? 'Save a Copy' : 'Save As',
      body,
      describedBy: 'files-save-where',
      initialFocus: () => nameInput,
      buttons: [
        { label: 'Choose Location...', value: () => ({ picker: true, name: ensureExtension(nameInput.value) }), left: true },
        { label: 'Cancel', value: null },
        {
          label: 'Save',
          primary: true,
          validate: async () => {
            const stem = nameInput.value.trim();
            if (!stem) {
              error.textContent = 'Enter a file name.';
              nameInput.focus();
              return false;
            }
            // The click is a user gesture, so the Documents permission prompt may show here.
            if (!usingDocs) chosenDir = await this.defaultDir({ prompt: true });
            const path = joinPath(chosenDir, ensureExtension(stem));
            if (await this.#exists(path)) {
              const ok = await openDialog({
                title: 'Replace File?',
                body: h('p.dialog-message', `"${ensureExtension(stem)}" already exists. Do you want to replace it?`),
                buttons: [
                  { label: 'Cancel', value: false },
                  { label: 'Replace', value: true, danger: true },
                ],
              });
              if (!ok) return false;
            }
            return true;
          },
          value: () => ({ path: joinPath(chosenDir, ensureExtension(nameInput.value.trim())) }),
        },
      ],
    });
    return result;
  }

  async #exists(path) {
    try {
      await this.puter.fs.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async #saveAsHandle(editor, enc, suggested, { copy }) {
    let handle;
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: suggested,
        types: [{ description: 'Vector Studio document', accept: { [NATIVE_MIME]: [NATIVE_EXT] } }],
      });
    } catch (err) {
      if (err?.name === 'AbortError') return false;
      // Some contexts (iframes, policies) block the picker: fall back to a download.
      downloadBytes(enc.bytes, suggested);
      if (!copy) this.#markSaved(editor, enc, { kind: 'download', name: suggested });
      return true;
    }
    const file = { kind: 'local', name: handle.name, handle, handleId: null };
    if (copy) {
      const r = await this.#withRetry(editor, enc, async () => {
        const w = await handle.createWritable();
        await w.write(blobOf(enc.bytes));
        await w.close();
      });
      if (r && !r.saveAs) this.#remember(file, enc.thumb);
      return Boolean(r);
    }
    return this.#writeHandle(editor, file, enc);
  }

  // ---- opening ----

  /** File > Open: Puter's Open dialog in the cloud, this computer otherwise. */
  async open() {
    if (this.cloud && this.puter.ui?.showOpenFilePicker) {
      let picked;
      try {
        picked = await cancellable(this.puter.ui.showOpenFilePicker({ multiple: true, accept: this.openExtensions() }));
      } catch (err) {
        this.app.notify(`Could not open the file dialog: ${errorText(err) || 'unknown error'}`, { error: true });
        return null;
      }
      if (!picked) return null;
      const items = Array.isArray(picked) ? picked : [picked];
      let last = null;
      for (const it of items) last = (await this.openPath(it.path, { name: it.name, item: it })) || last;
      return last;
    }
    return this.openLocal();
  }

  /** Open from this computer: File System Access (Chromium) or a file input. */
  async openLocal() {
    if (fsAccessAvailable()) {
      let handles;
      try {
        const other = this.app.importers?.openTypes || [];
        handles = await window.showOpenFilePicker({
          multiple: true,
          types: [{ description: 'Vector Studio and SVG files', accept: { [NATIVE_MIME]: [NATIVE_EXT], 'image/svg+xml': ['.svg', '.svgz'] } }, ...other],
        });
      } catch (err) {
        if (err?.name === 'AbortError') return null;
        handles = null;
      }
      if (handles) {
        let last = null;
        for (const handle of handles) {
          const file = await handle.getFile();
          last = (await this.openFileBlob(file, { handle })) || last;
        }
        return last;
      }
    }
    const files = await pickWithInput(this.openExtensions().join(',') + ',image/svg+xml');
    let last = null;
    for (const f of files) last = (await this.openFileBlob(f)) || last;
    return last;
  }

  /** Extensions File > Open accepts: native and SVG, plus the formats importers register. */
  openExtensions() {
    return [...OPEN_EXTS, ...(this.app.importers?.openExtensions || [])];
  }

  /** An editor already showing this file, if any. */
  findOpen(file) {
    return (
      this.app.editors.find((ed) => {
        const f = ed.file;
        if (!f || !file) return false;
        if (file.kind === 'puter' && f.kind === 'puter') return f.path === file.path;
        // An SVG opened from the cloud is shown as an imported document that remembers its path.
        if (file.kind === 'puter' && f.kind === 'import' && f.path) return f.path === file.path;
        if (file.kind === 'local' && f.kind === 'local' && file.handleId) return f.handleId === file.handleId;
        return false;
      }) || null
    );
  }

  /** Open a file from the Puter cloud by path. */
  async openPath(path, { name = baseName(path), item = null } = {}) {
    const existing = this.findOpen({ kind: 'puter', path });
    if (existing) {
      this.app.activate(existing);
      return existing;
    }
    let blob;
    try {
      blob = item?.read ? await item.read() : await this.puter.fs.read(path);
    } catch (err) {
      const info = classifyError(err);
      if (info.kind === 'missing') {
        await this.app.dialogs.alert({ title: 'File Not Found', message: `"${name}" could not be found. It may have been moved, renamed or deleted.` });
        await this.recent?.remove({ kind: 'puter', path });
      } else await this.app.dialogs.alert({ title: 'Could Not Open', message: `"${name}" could not be opened. ${info.message}` });
      return null;
    }
    return this.openBytes(await toBytes(blob), { name, file: { kind: 'puter', path, name } });
  }

  /** Open a File or Blob (drag and drop, file input, File System Access). */
  async openFileBlob(file, { handle = null } = {}) {
    const name = file?.name || 'Untitled';
    let fileInfo = null;
    if (handle) {
      const handleId = (await this.handles.find(handle)) || uid('h');
      const existing = this.findOpen({ kind: 'local', handleId });
      if (existing) {
        this.app.activate(existing);
        return existing;
      }
      await this.handles.put(handleId, handle);
      fileInfo = { kind: 'local', name: handle.name || name, handle, handleId };
    }
    let bytes;
    try {
      bytes = await toBytes(file);
    } catch {
      await this.app.dialogs.alert({ title: 'Could Not Open', message: `"${name}" could not be read.` });
      return null;
    }
    return this.openBytes(bytes, { name, file: fileInfo });
  }

  /**
   * Open file bytes as a new document tab. Native files open directly;
   * SVG goes through the SVG importer when it is available.
   */
  async openBytes(bytes, { name, file = null }) {
    const kind = fileKind(name, bytes.subarray(0, 256));
    if (kind === 'svg') return this.#openSvg(bytes, { name, file });
    // Other formats (PDF, EPS, DXF, raster images) through the importers that registered them.
    const format = kind === 'native' ? null : this.app.importers?.detect?.(name, bytes.subarray(0, 1024));
    if (format) return this.#openForeign(bytes, { name, file, format });
    if (kind === 'unknown' && extensionOf(name) && extensionOf(name) !== NATIVE_EXT) {
      await this.app.dialogs.alert({ title: 'Could Not Open', message: `"${name}" is not a file Vector Studio can open. Open .vstudio documents or .svg files.` });
      return null;
    }
    let parsed;
    try {
      parsed = await parseDocument(bytes);
    } catch (err) {
      if (err instanceof FileFormatError && err.code === 'svg') return this.#openSvg(bytes, { name, file });
      await this.app.dialogs.alert({ title: 'Could Not Open', message: `"${name}" could not be opened. ${err instanceof FileFormatError ? err.message : errorText(err)}` });
      return null;
    }
    const { doc, meta, migrated, repaired } = parsed;
    // Files without a location to write back to (dropped, picked with a file input) save with Save As.
    const fileInfo = file || { kind: 'import', format: 'native', name };
    const editor = this.app.addDocument(doc, { file: fileInfo });
    if (file) this.#remember(file, meta.thumbnail);
    if (repaired) this.app.notify(`"${name}" had ${repaired} damaged item${repaired === 1 ? '' : 's'}, which were removed.`, { error: true, timeout: 6000 });
    else if (migrated) this.app.notify(`"${name}" was upgraded from an older format. Saving keeps the new format.`, { timeout: 5000 });
    this.app.emit('file-opened', editor);
    return editor;
  }

  async #openSvg(bytes, { name, file }) {
    const importer = this.app.importers?.svg;
    if (typeof importer !== 'function') {
      await this.app.dialogs.alert({ title: 'SVG Import Unavailable', message: `"${name}" is an SVG file. Opening SVG files needs the SVG importer, which is not available in this version yet.` });
      return null;
    }
    let doc;
    try {
      // .svgz files are gzip-compressed SVG.
      const raw = isGzip(bytes) && canCompress() ? await gunzip(bytes) : bytes;
      const text = new TextDecoder().decode(raw);
      doc = await importer(text, { name: stripExtension(baseName(name)) });
    } catch (err) {
      await this.app.dialogs.alert({ title: 'Could Not Open', message: `"${name}" could not be imported. ${errorText(err)}` });
      return null;
    }
    if (!doc) return null;
    // Saving an imported SVG writes a new .vstudio file (Save As); the SVG is left untouched.
    const editor = this.app.addDocument(doc, { file: { kind: 'import', format: 'svg', name, path: file?.path || null } });
    if (file?.kind === 'puter') renderThumbnail(doc).then((thumb) => this.#remember(file, thumb));
    else if (file?.kind === 'local') renderThumbnail(doc).then((thumb) => this.#remember(file, thumb));
    this.app.emit('file-opened', editor);
    return editor;
  }

  async #openForeign(bytes, { name, file, format }) {
    let doc;
    try {
      doc = await this.app.importers.open(bytes, { name, format });
    } catch (err) {
      await this.app.dialogs.alert({ title: 'Could Not Open', message: `"${name}" could not be imported. ${errorText(err)}` });
      return null;
    }
    if (!doc) return null;
    // Like SVG, an imported file saves as a new .vstudio document; the original is left untouched.
    const editor = this.app.addDocument(doc, { file: { kind: 'import', format, name, path: file?.path || null } });
    if (file?.kind === 'puter' || file?.kind === 'local') renderThumbnail(doc).then((thumb) => this.#remember(file, thumb));
    if (doc.importWarnings?.length) this.app.importers.report?.(doc.importWarnings);
    this.app.emit('file-opened', editor);
    return editor;
  }

  /** Reopen an entry from the recent list. */
  async openRecent(entry) {
    if (entry.kind === 'puter') return this.openPath(entry.path, { name: entry.name });
    if (entry.kind === 'local') {
      const handle = await this.handles.get(entry.handleId);
      if (!handle) {
        await this.recent?.remove(entry);
        await this.app.dialogs.alert({ title: 'File Not Available', message: `"${entry.name}" can no longer be opened from here. Use Open to choose it again.` });
        return null;
      }
      const existing = this.findOpen({ kind: 'local', handleId: entry.handleId });
      if (existing) {
        this.app.activate(existing);
        return existing;
      }
      try {
        if (!(await ensurePermission(handle, 'readwrite'))) return null;
        const f = await handle.getFile();
        const bytes = await toBytes(f);
        return this.openBytes(bytes, { name: handle.name, file: { kind: 'local', name: handle.name, handle, handleId: entry.handleId } });
      } catch (err) {
        if (isMissing(err)) {
          await this.recent?.remove(entry);
          await this.app.dialogs.alert({ title: 'File Not Found', message: `"${entry.name}" could not be found. It may have been moved or deleted.` });
        } else await this.app.dialogs.alert({ title: 'Could Not Open', message: `"${entry.name}" could not be opened. ${errorText(err)}` });
        return null;
      }
    }
    return null;
  }

  // ---- revert ----

  canRevert(editor) {
    const f = editor?.file;
    return Boolean(editor?.doc.dirty && f && ((f.kind === 'puter' && f.path) || (f.kind === 'local' && f.handle)));
  }

  async revert(editor = this.app.editor) {
    if (!this.canRevert(editor)) return false;
    const ok = await this.app.dialogs.confirm({ title: 'Revert', message: `Revert to the saved version of "${editor.name}"? Changes since the last save will be lost.`, okLabel: 'Revert' });
    if (!ok) return false;
    const f = editor.file;
    let bytes;
    try {
      if (f.kind === 'puter') bytes = await toBytes(await this.puter.fs.read(f.path));
      else bytes = await toBytes(await f.handle.getFile());
    } catch (err) {
      await this.app.dialogs.alert({ title: 'Could Not Revert', message: `The saved version of "${editor.name}" could not be read. ${classifyError(err).message}` });
      return false;
    }
    let parsed;
    try {
      parsed = await parseDocument(bytes);
    } catch (err) {
      await this.app.dialogs.alert({ title: 'Could Not Revert', message: err.message });
      return false;
    }
    return this.replaceDocument(editor, parsed.doc, f);
  }

  /** Swap the document shown in a tab, keeping its place in the tab order and its view. */
  async replaceDocument(old, doc, file) {
    const app = this.app;
    const index = app.editors.indexOf(old);
    const view = { zoom: old.view.zoom, panX: old.view.panX, panY: old.view.panY, rotation: old.view.rotation };
    const ed = app.addDocument(doc, { file, activate: false });
    app.editors.splice(app.editors.indexOf(ed), 1);
    app.editors.splice(index, 0, ed);
    await app.closeDocument(old, { force: true });
    app.activate(ed);
    ed.viewInitialized = true;
    ed.view.set(view);
    ed.viewChanged();
    return ed;
  }
}

/** A one-shot <input type=file>; resolves [] when cancelled. */
export function pickWithInput(accept) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple: true, hidden: true });
    let done = false;
    const finish = (files) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish([...(input.files || [])]));
    input.addEventListener('cancel', () => finish([]));
    document.body.append(input);
    input.click();
  });
}
