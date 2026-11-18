import { h } from '../lib/dom.js';
import { openDialog, confirmDialog } from '../ui/dialog.js';
import { sanitizeFileName } from '../export/formats.js';
import { sessionBaseName } from '../model/session-io.js';
import * as puter from '../storage/puter.js';

let nextDialog = 0;

/** Selects and confirms a session destination without writing a draft file. */
export async function sessionSaveDialog(app, doc, { copy = false } = {}) {
  const ownDir = doc.source?.type === 'puter' ? puter.dirname(doc.source.path) : null;
  const dir = ownDir || app.prefs.get('sessionSaveFolder') || await puter.appDir();
  const id = `session-save-${++nextDialog}`;
  const name = h('input.input.io-name', { id: `${id}-name`, 'aria-label': 'File name', value: `${sessionBaseName(doc.name)}.asesx`, spellcheck: false });
  const folder = h('input.input.io-name', { id: `${id}-folder`, 'aria-label': 'Puter folder', value: dir, spellcheck: false });
  const browse = h('button.btn', { type: 'button' }, 'Browse...');
  const error = h('p.io-error', { role: 'alert' });
  const body = h('div.io-export-wrap.io-export',
    h('div.form-grid',
      h('label', { for: name.id }, 'File name:'), name,
      h('label', { for: folder.id }, 'Puter folder:'), h('div.io-loc-path', folder, browse)),
    h('p.muted', 'The session and its media will be saved in this folder.'), error);
  let active = true;
  let checking = false;
  let browsing = false;
  let destination = null;
  let saveButton;
  browse.addEventListener('click', async () => {
    if (browsing || checking) return;
    browsing = true;
    browse.disabled = true;
    saveButton.disabled = true;
    error.textContent = '';
    try {
      const item = await puter.pickDirectory();
      if (active && item?.path) folder.value = item.path;
    } catch (err) {
      if (active) error.textContent = err?.message || 'The folder could not be chosen.';
    } finally {
      browsing = false;
      if (active) {
        browse.disabled = saveButton.disabled = checking;
        if (!checking) browse.focus();
      }
    }
  });
  const shown = openDialog({
    title: copy ? 'Save a Copy' : 'Save Session As',
    className: 'session-save-dialog', body,
    initialFocus: `#${name.id}`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'save', primary: true }],
    onSubmit: async () => {
      if (checking || browsing) return false;
      error.textContent = '';
      const stem = sanitizeFileName(sessionBaseName(name.value)).replace(/\.+$/, '');
      if (!stem) { error.textContent = 'Enter a file name.'; name.focus(); return false; }
      const directory = folder.value.trim();
      if (!/^(\/|~(?:\/|$))/.test(directory) || /[\\\x00-\x1f]/.test(directory)) {
        error.textContent = 'Enter a Puter folder path, or choose Browse.';
        folder.focus();
        return false;
      }
      const fileName = `${stem}.asesx`;
      const path = puter.joinPath(directory, fileName);
      checking = true;
      name.disabled = folder.disabled = browse.disabled = true;
      saveButton.disabled = true;
      saveButton.textContent = 'Checking...';
      try {
        const exists = await puter.exists(path);
        if (!active) return false;
        if (exists && !(await confirmDialog({ title: 'Replace Session?', message: `"${fileName}" already exists in ${directory}. Do you want to replace it?`, confirm: 'Replace', danger: true }))) return false;
        if (!active) return false;
        destination = { path, name: fileName, dir: directory };
        return true;
      } catch (err) {
        if (active) error.textContent = err?.message || 'The destination could not be checked.';
        return false;
      } finally {
        checking = false;
        if (active) {
          name.disabled = folder.disabled = saveButton.disabled = false;
          browse.disabled = browsing;
          saveButton.textContent = 'Save';
          if (!destination) name.focus();
        }
      }
    },
  });
  saveButton = body.closest('.dialog').querySelector('.dialog-foot button[data-value="save"]');
  name.setSelectionRange(0, sessionBaseName(name.value).length);
  const result = await shown;
  active = false;
  if (result !== 'save') return null;
  app.prefs.set('sessionSaveFolder', destination.dir);
  return destination;
}
