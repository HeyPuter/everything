/**
 * File menu commands: Save as Template (My Templates in New from Template),
 * Version History, Document Color Mode, File Info and Package.
 *
 * Templates and versions live in the app's private storage on this device
 * (the files module's cache backend: the origin private file system, or
 * memory where that is unavailable). Puter storage has no file versions, so
 * every save keeps a local version of the document instead (the most recent
 * VERSION_LIMIT per file), which Version History lists, previews and
 * restores.
 */
import { h } from '../../lib/dom.js';
import { uid } from '../../lib/ids.js';
import { UserError } from '../../lib/errors.js';
import { memoryBackend } from '../files/backends.js';
import { hashKey } from '../files/recent.js';
import { formatBytes, relativeTime } from '../files/naming.js';

import { serializeDocument, parseDocument } from '../files/format.js';
import { renderThumbnail } from '../files/thumbnail.js';
import { familyInfo } from '../type/fonts.js';

export const VERSION_LIMIT = 20;

let fallbackStore = null;
/** The app-private storage backend. */
export function localStore(app) {
  if (app.files?.cache) return app.files.cache;
  if (!fallbackStore) fallbackStore = memoryBackend();
  return fallbackStore;
}

async function encodeDoc(doc) {
  const thumb = await renderThumbnail(doc, { size: 192 }).catch(() => null);
  const bytes = await serializeDocument(doc, { thumbnail: thumb });
  return { bytes, thumb };
}

async function blobBytes(blob) {
  if (!blob) return null;
  if (blob instanceof Uint8Array) return blob;
  if (typeof blob === 'string') return new TextEncoder().encode(blob);
  return new Uint8Array(await blob.arrayBuffer());
}

// ---- Templates ----

export class TemplateStore {
  constructor(store) {
    this.store = store;
  }

  async list() {
    return (await this.store.readJSON('templates/index.json')) || [];
  }

  async save(doc, name) {
    const { bytes, thumb } = await encodeDoc(doc);
    const a = doc.artboards[0] || { w: 612, h: 792 };
    const entry = { id: uid('tpl'), name, savedAt: Date.now(), width: a.w, height: a.h, artboards: doc.artboards.length, thumb };
    await this.store.writeBlob(`templates/${entry.id}.vstudio`, new Blob([bytes]));
    const list = (await this.list()).filter((t) => t.name !== name);
    list.push(entry);
    await this.store.writeJSON('templates/index.json', list);
    return entry;
  }

  async remove(id) {
    await this.store.remove(`templates/${id}.vstudio`);
    await this.store.writeJSON('templates/index.json', (await this.list()).filter((t) => t.id !== id));
  }

  /** A fresh document from a template, named `name`, with a clean history. */
  async load(id, name) {
    const bytes = await blobBytes(await this.store.readBlob(`templates/${id}.vstudio`));
    if (!bytes) throw new UserError('This template is no longer available.');
    const { doc } = await parseDocument(bytes);
    doc.nodes.set('root', { ...doc.root, name, info: undefined });
    return doc;
  }
}

async function saveAsTemplate(app) {
  const ed = app.editor;
  const res = await app.dialogs.form({
    title: 'Save as Template',
    description: 'Templates appear under My Templates in File > New from Template on this device.',
    fields: [{ key: 'name', label: 'Template Name', type: 'text', value: ed.name.replace(/\.[^.]+$/, '') }],
    okLabel: 'Save',
  });
  const name = res?.name?.trim();
  if (!name) return null;
  const templates = app.userTemplates;
  if ((await templates.list()).some((t) => t.name === name) && !(await app.dialogs.confirm({ title: 'Save as Template', message: `Replace the template "${name}"?`, okLabel: 'Replace' }))) return null;
  const entry = await templates.save(ed.doc, name);
  app.notify(`Saved template "${name}".`, { polite: true });
  return entry;
}

// ---- Versions ----

/** The storage key for an editor's file: its path, file name or document name. */
export function versionKey(editor) {
  const f = editor.file;
  return hashKey(f?.path ? `puter:${f.path}` : f?.handleId ? `local:${f.handleId}` : `name:${f?.name || editor.doc.root.name}`);
}

export class VersionStore {
  constructor(store, limit = VERSION_LIMIT) {
    this.store = store;
    this.limit = limit;
  }

  async list(key) {
    return (await this.store.readJSON(`versions/${key}/index.json`)) || [];
  }

  async add(key, doc, { name = '', label = '' } = {}) {
    const { bytes, thumb } = await encodeDoc(doc);
    const entry = { id: uid('ver'), time: Date.now(), size: bytes.length, name, label, thumb };
    await this.store.writeBlob(`versions/${key}/${entry.id}.vstudio`, new Blob([bytes]));
    const list = [...(await this.list(key)), entry];
    while (list.length > this.limit) {
      const old = list.shift();
      await this.store.remove(`versions/${key}/${old.id}.vstudio`);
    }
    await this.store.writeJSON(`versions/${key}/index.json`, list);
    return entry;
  }

  async read(key, id) {
    const bytes = await blobBytes(await this.store.readBlob(`versions/${key}/${id}.vstudio`));
    if (!bytes) throw new UserError('This version is no longer available.');
    return (await parseDocument(bytes)).doc;
  }

  async remove(key, id) {
    await this.store.remove(`versions/${key}/${id}.vstudio`);
    await this.store.writeJSON(`versions/${key}/index.json`, (await this.list(key)).filter((v) => v.id !== id));
  }
}

/** Replace the editor's document content with another document's, as one undo step. */
export function restoreDocumentContent(editor, other, label = 'Restore Version') {
  const doc = editor.doc;
  const snap = other.snapshot();
  // Keep the document's own name: restoring content does not rename it.
  snap.nodes.set('root', { ...snap.nodes.get('root'), name: doc.root.name });
  doc.transact(label, () => doc.restoreSnapshot(snap));
  editor.clearSelection();
  editor.setActiveArtboard(Math.min(editor.activeArtboard, doc.artboards.length - 1));
}

async function versionHistoryDialog(app) {
  const ed = app.editor;
  const versions = app.versions;
  const key = versionKey(ed);
  let list = (await versions.list(key)).slice().reverse();
  let selected = list[0]?.id || null;
  const listEl = h('ul.vh-list', { role: 'listbox', tabindex: '0', 'aria-label': 'Versions' });
  const preview = h('div.vh-preview', { 'aria-live': 'polite' });
  const restoreBtn = h('button.btn.primary', { type: 'button' }, 'Restore');
  const copyBtn = h('button.btn', { type: 'button' }, 'Open as Copy');
  const delBtn = h('button.btn', { type: 'button' }, 'Delete');
  const saveBtn = h('button.btn', { type: 'button' }, 'Save Version Now');
  let close = null;
  const render = () => {
    listEl.replaceChildren(
      ...list.map((v, i) =>
        h(
          'li.vh-row',
          { id: `vh-${v.id}`, role: 'option', 'aria-selected': String(v.id === selected), onclick: () => select(v.id) },
          v.thumb ? h('img.vh-thumb', { src: v.thumb, alt: '' }) : h('span.vh-thumb.blank'),
          h('span.vh-text', h('span.vh-name', v.label || (i === 0 ? 'Latest save' : 'Saved version')), h('span.vh-meta', `${relativeTime(v.time)} · ${new Date(v.time).toLocaleString()} · ${formatBytes(v.size)}`)),
        ),
      ),
    );
    if (!list.length) listEl.append(h('li.muted.vh-empty', 'No versions yet. A version is kept every time you save.'));
    if (selected) listEl.setAttribute('aria-activedescendant', `vh-${selected}`);
    const v = list.find((x) => x.id === selected);
    preview.replaceChildren(v?.thumb ? h('img.vh-big', { src: v.thumb, alt: `Preview of the version from ${new Date(v.time).toLocaleString()}` }) : h('p.muted', v ? 'No preview for this version.' : 'Select a version to preview it.'));
    restoreBtn.disabled = copyBtn.disabled = delBtn.disabled = !v;
  };
  const select = (id) => {
    selected = id;
    render();
  };
  listEl.addEventListener('keydown', (e) => {
    const i = list.findIndex((v) => v.id === selected);
    const j = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: list.length - 1 }[e.key];
    if (j === undefined || !list.length) return;
    e.preventDefault();
    select(list[Math.max(0, Math.min(list.length - 1, j))].id);
  });
  restoreBtn.addEventListener('click', async () => {
    const doc = await versions.read(key, selected);
    restoreDocumentContent(ed, doc);
    app.notify('Restored the version. Undo returns to the current content.', { polite: true });
    close?.(true);
  });
  copyBtn.addEventListener('click', async () => {
    const doc = await versions.read(key, selected);
    const v = list.find((x) => x.id === selected);
    doc.nodes.set('root', { ...doc.root, name: `${ed.name.replace(/\.[^.]+$/, '')} (${new Date(v.time).toLocaleString()})` });
    close?.(true);
    app.addDocument(doc);
  });
  delBtn.addEventListener('click', async () => {
    await versions.remove(key, selected);
    list = list.filter((v) => v.id !== selected);
    selected = list[0]?.id || null;
    render();
  });
  saveBtn.addEventListener('click', async () => {
    const entry = await versions.add(key, ed.doc, { name: ed.name, label: 'Saved manually' });
    list.unshift(entry);
    selected = entry.id;
    render();
  });
  render();
  return app.dialogs.open({
    title: `Version History: ${ed.name}`,
    className: 'wide vh-dialog',
    body: h('div.vh', h('div.vh-side', listEl, h('div.vh-actions', saveBtn, delBtn)), h('div.vh-main', preview, h('div.vh-actions', copyBtn, restoreBtn))),
    onOpen: (d) => (close = d.close),
    buttons: [{ label: 'Close', value: null }],
  });
}

// ---- Document color mode ----

export function setColorMode(app, editor, mode) {
  const doc = editor.doc;
  if ((doc.root.colorMode || 'RGB') !== mode) doc.transact('Document Color Mode', () => doc.updateRoot({ colorMode: mode }));
  syncColorPanelMode(app, editor);
}

/** The Color panel shows CMYK sliders by default for CMYK documents and RGB for RGB ones. */
export function syncColorPanelMode(app, editor = app.editor) {
  if (!editor) return;
  const want = editor.doc.root.colorMode === 'CMYK' ? 'cmyk' : 'rgb';
  const current = app.prefs.get('colorPanelMode') || 'rgb';
  const family = current === 'cmyk' ? 'cmyk' : 'rgb';
  if (family === want) return;
  const panel = app.dock?.panels.get('color');
  if (panel?.built && panel.setMode) panel.setMode(want);
  else app.prefs.set('colorPanelMode', want);
}

// ---- File Info ----

export const INFO_FIELDS = [
  { key: 'title', label: 'Document Title', type: 'text' },
  { key: 'author', label: 'Author', type: 'text', help: 'Separate several authors with semicolons.' },
  { key: 'authorTitle', label: 'Author Title', type: 'text' },
  { key: 'description', label: 'Description', type: 'textarea' },
  { key: 'rating', label: 'Rating', type: 'select', options: [{ value: '', label: 'None' }, ...[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${'\u2605'.repeat(n)}${'\u2606'.repeat(5 - n)} (${n})` }))] },
  { key: 'descriptionWriter', label: 'Description Writer', type: 'text' },
  { key: 'keywords', label: 'Keywords', type: 'textarea', help: 'Separate keywords with commas or semicolons.' },
  { key: 'copyrightStatus', label: 'Copyright Status', type: 'select', options: [{ value: 'unknown', label: 'Unknown' }, { value: 'copyrighted', label: 'Copyrighted' }, { value: 'public', label: 'Public Domain' }] },
  { key: 'copyright', label: 'Copyright Notice', type: 'textarea' },
  { key: 'copyrightUrl', label: 'Copyright Info URL', type: 'text' },
];

/** Split a keyword or author field into a clean list. */
export function splitList(s) {
  return String(s || '')
    .split(/[;,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Normalized metadata for a document (empty fields left out). */
export function cleanInfo(values, prev = {}) {
  const out = {};
  for (const f of INFO_FIELDS) {
    let v = values[f.key];
    if (f.key === 'keywords' || f.key === 'author') v = splitList(v);
    if (Array.isArray(v) ? v.length : typeof v === 'string' ? v.trim() : v) out[f.key] = typeof v === 'string' ? v.trim() : v;
  }
  if (out.copyrightStatus === 'unknown') delete out.copyrightStatus;
  if (out.copyrightUrl && !/^https?:\/\//i.test(out.copyrightUrl)) out.copyrightUrl = `https://${out.copyrightUrl}`;
  out.created = prev.created || Date.now();
  out.modified = Date.now();
  return out;
}

async function fileInfoDialog(app) {
  const ed = app.editor;
  const doc = ed.doc;
  const info = doc.root.info || {};
  const fields = INFO_FIELDS.map((f) => ({ ...f, value: Array.isArray(info[f.key]) ? info[f.key].join('; ') : info[f.key] ?? (f.key === 'copyrightStatus' ? 'unknown' : '') }));
  const dates = info.created ? `Created ${new Date(info.created).toLocaleString()}${info.modified ? `, last changed ${new Date(info.modified).toLocaleString()}` : ''}.` : 'Saved with the document and written to exported SVG and PDF files.';
  const v = await app.dialogs.form({ title: `File Info: ${ed.name}`, description: dates, fields });
  if (!v) return;
  doc.transact('File Info', () => doc.updateRoot({ info: cleanInfo(v, info) }));
}

// ---- Package ----

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };

/** Fonts used by type: [{ family, weight, style, count }]. */
export function fontsUsed(doc) {
  const map = new Map();
  const add = (c) => {
    if (!c?.fontFamily) return;
    const k = `${c.fontFamily}|${c.fontWeight || 400}|${c.fontStyle || 'normal'}`;
    const e = map.get(k) || { family: c.fontFamily, weight: c.fontWeight || 400, style: c.fontStyle || 'normal', count: 0 };
    e.count++;
    map.set(k, e);
  };
  doc.walk((n) => {
    if (n.type !== 'text') return;
    add(n.char);
    for (const r of n.runs || []) if (r.fontFamily || r.fontWeight || r.fontStyle) add({ ...n.char, ...r });
  });
  return [...map.values()].sort((a, b) => a.family.localeCompare(b.family) || a.weight - b.weight);
}

/** Files for a package: the document, its images and a report. */
export async function packageEntries(app, editor, { includeFonts = true, copyLinks = true, linksFolder = true, report: withReport = true, folder = null } = {}) {
  const doc = editor.doc;
  const { dataUrlToBytes, sniffMime } = await import('../io/image-info.js');
  const name = (editor.name || 'Untitled').replace(/\.[^.]+$/, '') || 'Untitled';
  const base = String(folder || '').replace(/[\\/:*?"<>|]+/g, '-').trim() || name;
  const { bytes } = await encodeDoc(doc);
  const entries = [{ name: `${base}/${name}.vstudio`, data: bytes }];
  const used = new Set();
  doc.walk((n) => {
    if (n.type === 'image' && n.asset) used.add(n.asset);
  });
  const imageLines = [];
  const names = new Set();
  for (const id of used) {
    const a = doc.assets.get(id);
    if (!a?.data) continue;
    const data = dataUrlToBytes(a.data);
    const mime = sniffMime(data) || a.mime || 'image/png';
    let stem = String(a.link?.name || a.name || id).replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '-') || id;
    let name = `${stem}.${EXT[mime] || 'bin'}`;
    for (let i = 2; names.has(name); i++) name = `${stem}-${i}.${EXT[mime] || 'bin'}`;
    names.add(name);
    if (copyLinks) entries.push({ name: `${base}/${linksFolder ? 'Links/' : ''}${name}`, data });
    imageLines.push(`  ${name}  (${formatBytes(data.length)}${a.link ? `, linked from ${a.link.path || a.link.name}` : ', embedded'})`);
  }
  const fonts = fontsUsed(doc);
  const fontLines = [];
  for (const f of fonts) {
    const fam = familyInfo(f.family);
    const face = fam?.faces?.find((x) => x.weight === f.weight && x.style === f.style) || fam?.faces?.[0];
    let note = fam ? (fam.source === 'bundled' ? 'included with Vector Studio (SIL Open Font License)' : 'installed on this computer, not included') : 'not available, substituted when shown';
    if (includeFonts && fam?.source === 'bundled' && face?.url) {
      try {
        const res = await fetch(face.url);
        if (res.ok) {
          const file = `${f.family}-${f.weight}${f.style === 'italic' ? '-italic' : ''}.woff`.replace(/\s+/g, '');
          entries.push({ name: `${base}/Fonts/${file}`, data: new Uint8Array(await res.arrayBuffer()) });
          note += `, copied to Fonts/${file}`;
        }
      } catch {
        // Offline: the report still names the font.
      }
    }
    fontLines.push(`  ${f.family} ${f.weight}${f.style === 'italic' ? ' Italic' : ''}  (${f.count} use${f.count === 1 ? '' : 's'}): ${note}`);
  }
  const report = [
    `Package report for ${base}`,
    `Created ${new Date().toLocaleString()} by Vector Studio`,
    '',
    `Artboards: ${doc.artboards.length}`,
    `Color mode: ${doc.root.colorMode || 'RGB'}`,
    '',
    `Images (${imageLines.length}):`,
    ...(imageLines.length ? imageLines : ['  None']),
    '',
    `Fonts (${fontLines.length}):`,
    ...(fontLines.length ? fontLines : ['  None']),
    '',
  ].join('\n');
  if (withReport) entries.push({ name: `${base}/Report.txt`, data: report });
  return { entries, base, report };
}

async function packageDocument(app) {
  const ed = app.editor;
  const v = await app.dialogs.form({
    title: 'Package',
    description: 'Collects the document, its images, the fonts it uses (where their license allows) and a report into one zip file.',
    fields: [
      { key: 'folder', label: 'Folder Name', type: 'text', value: `${(ed.name || 'Untitled').replace(/\.[^.]+$/, '')} Folder` },
      { type: 'heading', label: 'Options' },
      { key: 'links', label: 'Copy Images', type: 'checkbox', value: true },
      { key: 'linksFolder', label: 'Collect Images in a Separate Folder', type: 'checkbox', value: true, disabled: (x) => !x.links },
      { key: 'fonts', label: 'Copy Fonts Used in Document', type: 'checkbox', value: true },
      { key: 'report', label: 'Create Report', type: 'checkbox', value: true },
    ],
    okLabel: 'Package',
  });
  if (!v) return null;
  const { entries, base } = await packageEntries(app, ed, { includeFonts: v.fonts, copyLinks: v.links, linksFolder: v.linksFolder, report: v.report, folder: v.folder });
  const [{ createZip }, { deliverFiles }] = await Promise.all([import('../io/zip.js'), import('../io/deliver.js')]);
  const blob = await createZip(entries);
  const msg = await deliverFiles(app, [{ name: `${base}.zip`, blob }], { dest: app.user && app.puter?.ui ? 'puter' : 'device' });
  if (msg) app.notify(msg, { polite: true });
  return blob;
}

export function registerFileCommands(app) {
  const store = localStore(app);
  app.userTemplates = new TemplateStore(store);
  app.versions = new VersionStore(store);

  // Keep a version every time a document is saved.
  const watched = new WeakSet();
  const watch = (ed) => {
    if (!ed || watched.has(ed)) return;
    watched.add(ed);
    ed.doc.on('saved', () => {
      const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
      idle(() => app.versions.add(versionKey(ed), ed.doc, { name: ed.name }).catch((err) => console.warn('Could not keep a version', err)));
    });
  };
  app.on('active-editor', (ed) => {
    watch(ed);
    if (ed) syncColorPanelMode(app, ed);
  });

  const hasDoc = (a) => Boolean(a.editor);
  app.commands.register([
    { id: 'file.saveAsTemplate', label: 'Save as Template...', enabled: hasDoc, run: (a) => saveAsTemplate(a) },
    { id: 'file.versionHistory', label: 'Version History', enabled: hasDoc, run: (a) => versionHistoryDialog(a) },
    { id: 'file.colorMode.cmyk', label: 'CMYK Color', enabled: hasDoc, checked: (a) => a.editor?.doc.root.colorMode === 'CMYK', run: (a) => setColorMode(a, a.editor, 'CMYK') },
    { id: 'file.colorMode.rgb', label: 'RGB Color', enabled: hasDoc, checked: (a) => Boolean(a.editor) && a.editor.doc.root.colorMode !== 'CMYK', run: (a) => setColorMode(a, a.editor, 'RGB') },
    { id: 'file.info', label: 'File Info...', shortcut: 'Alt+Shift+Mod+I', enabled: hasDoc, run: (a) => fileInfoDialog(a) },
    { id: 'file.package', label: 'Package...', shortcut: 'Alt+Shift+Mod+P', enabled: hasDoc, run: (a) => packageDocument(a) },
  ]);
}
