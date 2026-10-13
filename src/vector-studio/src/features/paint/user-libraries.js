/**
 * User-defined libraries (swatches, graphic styles, brushes, ...): named
 * collections the user saves from a panel, kept in their preferences so
 * every document can open them, plus exporting a library to a JSON file
 * and importing one back.
 */
import { h } from '../../lib/dom.js';
import { uid } from '../../lib/ids.js';
import { downloadBlob, safeFileName } from '../io/deliver.js';

const prefKey = (kind) => `userLibraries:${kind}`;

/** Saved libraries of a kind: [{ id, name, items }]. */
export function userLibraries(app, kind) {
  const list = app.prefs.get(prefKey(kind));
  return Array.isArray(list) ? list.filter((l) => l && l.id && Array.isArray(l.items)) : [];
}

/** Save (or replace by name) a library. Returns its id. */
export function storeUserLibrary(app, kind, name, items) {
  const list = userLibraries(app, kind);
  const existing = list.find((l) => l.name === name);
  const lib = { id: existing?.id || uid('lib'), name, items: structuredClone(items) };
  app.prefs.set(prefKey(kind), [...list.filter((l) => l !== existing), lib]);
  return lib.id;
}

export function removeUserLibrary(app, kind, id) {
  app.prefs.set(prefKey(kind), userLibraries(app, kind).filter((l) => l.id !== id));
}

/** Ask for a library name, then store it. Resolves to the library name or null. */
export async function saveLibraryDialog(app, kind, { title, items, defaultName }) {
  if (!items.length) return null;
  const res = await app.dialogs.form({ title, fields: [{ key: 'name', label: 'Library Name', type: 'text', value: defaultName }] });
  const name = res?.name?.trim();
  if (!name) return null;
  const replacing = userLibraries(app, kind).some((l) => l.name === name);
  if (replacing && !(await app.dialogs.confirm({ title, message: `Replace the library "${name}"?`, okLabel: 'Replace' }))) return null;
  storeUserLibrary(app, kind, name, items);
  app.notify(`Saved "${name}" (${items.length} ${items.length === 1 ? 'item' : 'items'}).`, { polite: true });
  return name;
}

/** Download a library as a JSON file in the given format. */
export function exportLibraryFile(format, name, items, key = 'items') {
  const data = { format, version: 1, name, [key]: items };
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `${safeFileName(name, 'Library')}.json`);
}

/** Let the user pick a file; resolves to { name, text } or null. */
export function pickTextFile(accept) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, hidden: true });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(v);
    };
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return finish(null);
      try {
        finish({ name: file.name, text: await file.text() });
      } catch {
        finish(null);
      }
    });
    input.addEventListener('cancel', () => finish(null));
    document.body.append(input);
    input.click();
  });
}

/** Menu entries for the user's saved libraries of a kind, with a way to delete each. */
export function userLibraryMenu(app, kind, open) {
  const libs = userLibraries(app, kind);
  if (!libs.length) return [{ label: 'No Saved Libraries', enabled: false, run() {} }];
  return [
    ...libs.map((l) => ({ label: l.name, run: () => open(l) })),
    '-',
    {
      label: 'Delete Saved Library',
      submenu: libs.map((l) => ({
        label: l.name,
        run: async () => {
          if (await app.dialogs.confirm({ title: 'Delete Library', message: `Delete the saved library "${l.name}"?`, okLabel: 'Delete', danger: true })) removeUserLibrary(app, kind, l.id);
        },
      })),
    },
  ];
}
