/**
 * Templates of your own: any document saved into Documents/Templates on
 * Puter. They show up next to the built-in templates, and a new document
 * from one starts as a copy of the file (saved under its own name once the
 * engine is ready). The id "file:<path>" travels in the #/new/<template>
 * route like the built-in ids do.
 */

import * as P from './puter.js';
import { documentRoot } from './document-paths.js';
import { session } from './session.js';

export const TEMPLATE_FOLDER = `${P.FOLDER}/Templates`;
const PREFIX = 'file:';

export function customTemplateId(path) {
  return `${PREFIX}${path}`;
}

/**
 * The file path inside a custom template id, or null for built-in ids and
 * for anything outside the Templates folder: an address typed by hand must
 * not make the app read and copy an arbitrary file.
 */
export function customTemplatePath(id) {
  if (typeof id !== 'string' || !id.startsWith(PREFIX)) return null;
  const path = id.slice(PREFIX.length);
  // The folder as the app spells it, or as an older link spelled it from the drive's root, then one file name.
  const escaped = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const root = documentRoot();
  const folders = [`(?:/[^/]+/)?${escaped(TEMPLATE_FOLDER)}`, ...(root ? [escaped(`${root}/Templates`)] : [])];
  const inFolder = new RegExp(`^(?:${folders.join('|')})/([^/]+)$`).exec(path);
  return inFolder && P.OPENABLE.test(inFolder[1]) && !/^\.+$/.test(inFolder[1]) ? path : null;
}

/** The templates among a folder listing: openable document files, A to Z. */
export function customTemplatesFrom(items) {
  return (items || [])
    .filter((it) => it && !it.isDir && P.OPENABLE.test(it.name || ''))
    // The id names the file the way the app spells its folder: a listing spells it from the drive's root
    // (/user/AppData/<app>/Documents/Templates/...), which is not an address the app would open.
    .map((it) => ({ id: customTemplateId(`${TEMPLATE_FOLDER}/${it.name}`), name: P.stripExtension(it.name), path: it.path, modified: it.modified || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

/** The templates in the folder; none without a session, since the folder is in the cloud. */
export async function listCustomTemplates() {
  if (session.signedOut) return [];
  return customTemplatesFrom(await P.listFolder(TEMPLATE_FOLDER));
}

/** Where a template of this name is written: "Report", "Report.docx" and "Report.DOCX" all name Report.docx. */
export function templatePathFor(name) {
  return `${TEMPLATE_FOLDER}/${P.documentStem(name)}.docx`;
}

export async function templateExists(name) {
  return P.fileExists(templatePathFor(name));
}

/** Write the document bytes as a template. Resolves { path, name }. */
export async function saveAsTemplate(blob, name, { overwrite = false } = {}) {
  const clean = P.documentStem(name);
  if (!clean) throw new Error('Enter a name');
  const path = templatePathFor(name);
  await P.writeFile(path, blob, { overwrite });
  return { path, name: clean };
}

export async function deleteTemplate(path) {
  await P.deleteFile(path);
}

/**
 * Menu items for the templates of your own, to follow the built-in ones:
 * a header, one item per template, and a manage entry when `onManage` is given.
 */
export function customTemplateItems(templates, { onPick, onManage = null, icon = 'brand' } = {}) {
  if (!templates?.length) return [];
  const items = [
    { separator: true },
    { header: 'My templates' },
    ...templates.map((t) => ({ label: t.name, icon, onSelect: () => onPick(t.id) })),
  ];
  if (onManage) items.push({ label: 'Manage my templates', icon: 'settings', onSelect: onManage });
  return items;
}
