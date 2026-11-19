// Saving a small file the app makes (a marker list, the application settings):
// signed in to Puter, a dialog asks for the name and a Puter folder (or This
// device); otherwise the file downloads at once.

import { h } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { openDialog, confirmDialog } from '../ui/dialog.js';
import * as puter from '../storage/puter.js';
import { downloadBlob } from '../storage/files.js';
import { sanitizeFileName } from './formats.js';

/** `name` with extension `ext` (".csv"), whatever extension was typed. */
export function withFileExtension(name, ext) {
  const base = String(name || '').trim().replace(/\.+$/, '');
  return base.toLowerCase().endsWith(ext.toLowerCase()) ? base : `${base.replace(/\.[a-z0-9]{1,5}$/i, '')}${ext}`;
}

/**
 * Saves `blob` as `fileName`. Resolves { type: 'puter', path } | { type: 'download', name } | null
 * (cancelled). `pref` names the preference that remembers the folder.
 */
export async function saveSmallFile(app, blob, fileName, { title = 'Save', ext = '', pref = 'smallFileFolder' } = {}) {
  if (!(puter.sdk() && puter.isSignedIn())) {
    downloadBlob(blob, fileName);
    return { type: 'download', name: fileName };
  }
  const extension = ext || (/\.[a-z0-9]+$/i.exec(fileName)?.[0] ?? '');
  let dir = app.prefs.get(pref) || '';
  const nameInput = h('input.input.io-name', { type: 'text', value: fileName, 'aria-label': 'File name', spellcheck: 'false', autocomplete: 'off' });
  const locSelect = h('select.select', { 'aria-label': 'Location' }, h('option', { value: 'puter' }, 'Puter folder'), h('option', { value: 'download' }, 'This device (download)'));
  locSelect.value = app.prefs.get(`${pref}Location`) === 'download' ? 'download' : 'puter';
  const dirText = h('span.io-path');
  const browse = h('button.btn', { type: 'button' }, 'Browse...');
  const pathRow = h('div.io-loc-path', icon('folder', 14), dirText, browse);
  const error = h('div.io-error', { role: 'alert' });
  const show = () => {
    pathRow.hidden = locSelect.value !== 'puter';
    dirText.textContent = dir || `~/${puter.APP_DIR}`;
  };
  locSelect.addEventListener('change', show);
  browse.addEventListener('click', async () => {
    try {
      const item = await puter.pickDirectory();
      if (item?.path) {
        dir = item.path;
        show();
      }
    } catch (err) {
      error.textContent = err?.message || 'The folder could not be chosen.';
    }
  });
  show();
  let target = null;
  const r = await openDialog({
    title,
    className: 'io-export-dialog',
    body: h('div.io-export-wrap', h('div.io-export', h('div.form-grid.io-grid', h('label', 'File Name:'), nameInput, h('label', 'Location:'), h('div.io-loc', locSelect, pathRow)), error)),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Save', value: 'ok', primary: true },
    ],
    onSubmit: async () => {
      const name = withFileExtension(sanitizeFileName(nameInput.value), extension);
      if (!sanitizeFileName(nameInput.value) || name === extension) {
        error.textContent = 'Enter a file name.';
        nameInput.focus();
        return false;
      }
      if (locSelect.value === 'download') {
        target = { type: 'download', name };
        return true;
      }
      const folder = dir || (await puter.appDir());
      const path = puter.joinPath(folder, name);
      if ((await puter.exists(path)) && !(await confirmDialog({ title: 'Replace File?', message: `"${name}" already exists in ${folder}. Do you want to replace it?`, confirm: 'Replace', danger: true }))) return false;
      target = { type: 'puter', path, dir: folder, name };
      return true;
    },
  });
  if (r !== 'ok' || !target) return null;
  app.prefs.set(`${pref}Location`, target.type);
  if (target.type === 'download') {
    downloadBlob(blob, target.name);
    return { type: 'download', name: target.name };
  }
  app.prefs.set(pref, target.dir);
  await puter.writeFile(target.path, blob);
  return { type: 'puter', path: target.path };
}
