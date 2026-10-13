/**
 * Links panel: every placed image with its link information (name, format,
 * pixel size, effective resolution, placed size, scale, rotation, file
 * size, linked or embedded), and Relink, Go To Link, Update Link, Edit
 * Original and Embed. Images are always embedded in the document (so a file
 * opens anywhere); an image placed from Puter also keeps `node.link`
 * ({ source: 'puter', path, name, size, modified }) to its file, which
 * Update Link re-reads and Edit Original opens. Embed drops the link;
 * Unembed saves the image as a file and links to it. The panel menu adds
 * Placement Options (how a relinked image fits), Link Information, a
 * Show filter, sorting and the thumbnail size.
 */
import { h } from '../../lib/dom.js';
import { Panel } from '../../ui/panels/panel.js';
import { iconButton } from '../../ui/widgets.js';
import { icon } from '../../ui/icons.js';
import { UserError } from '../../lib/errors.js';
import { multiply, translate, scale as scaleM } from '../../lib/matrix.js';
import { nodeBounds } from '../../model/geometry.js';
import { formatBytes } from '../files/naming.js';
import { pickDeviceFiles } from '../io/kinds.js';

const FORMAT = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP', 'image/gif': 'GIF', 'image/svg+xml': 'SVG' };

/** Placed images in paint order. */
export function placedImages(doc) {
  const out = [];
  doc.walk((n) => {
    if (n.type === 'image') out.push(n);
    return true;
  });
  return out;
}

/** Facts about a placed image. Lengths in points, resolution in pixels per inch. */
export function imageInfo(doc, node) {
  const a = doc.assets.get(node.asset) || {};
  const m = node.transform || [1, 0, 0, 1, 0, 0];
  const sx = Math.hypot(m[0], m[1]);
  const sy = Math.hypot(m[2], m[3]);
  const bytes = a.data ? Math.round(((a.data.length - a.data.indexOf(',') - 1) * 3) / 4) : 0;
  return {
    name: node.link?.name || node.name || a.name || 'Image',
    format: FORMAT[a.mime] || (a.mime ? a.mime.replace(/^image\//, '').toUpperCase() : 'Unknown'),
    pixels: { w: node.width, h: node.height },
    placed: { w: node.width * sx, h: node.height * sy },
    ppi: { x: sx ? 72 / sx : 0, y: sy ? 72 / sy : 0 },
    scale: { x: sx * 100, y: sy * 100 },
    rotation: Math.round(((-Math.atan2(m[1], m[0]) * 180) / Math.PI) * 100) / 100 || 0,
    bytes,
    linked: Boolean(node.link),
    location: node.link?.path || null,
    missing: !a.data,
  };
}

/** Placement Options: how a replacement image takes the place of the old one. */
export const PLACEMENTS = [
  { value: 'transforms', label: 'Preserve Transforms' },
  { value: 'fit', label: 'Preserve Proportions (fit inside)' },
  { value: 'fill', label: 'Preserve Proportions (fill)' },
  { value: 'stretch', label: 'Fit to Bounds (stretch)' },
  { value: 'center', label: 'Center (keep pixel size)' },
];

/**
 * New transform for an image of size (w, h) taking the place of `node`.
 * mode: 'fit' (default) keeps its aspect ratio inside the old bounds,
 * 'fill' covers them, 'stretch' matches them, 'center' keeps the old
 * scale and centers it, 'transforms' keeps the old matrix as it is.
 */
export function fitTransform(node, w, h, mode = 'fit') {
  if (mode === 'transforms') return node.transform.slice();
  let sx;
  let sy;
  if (mode === 'stretch') {
    sx = node.width / w;
    sy = node.height / h;
  } else if (mode === 'center') sx = sy = 1;
  else sx = sy = (mode === 'fill' ? Math.max : Math.min)(node.width / w, node.height / h);
  return multiply(node.transform, multiply(translate((node.width - w * sx) / 2, (node.height - h * sy) / 2), scaleM(sx, sy)));
}

/** Swap the image of placed nodes for a new blob (one undo step). */
export async function replaceImage(app, editor, nodeIds, blob, { link = null, label = 'Relink', placement = app.prefs?.get('linkPlacement') || 'fit' } = {}) {
  const doc = editor.doc;
  const io = await import('../io/lazy.js');
  const data = await io.imageNodeData(blob, { name: blob.name?.replace(/\.[^.]+$/, '') || '' });
  doc.assets.set(data.assetId, data.asset);
  doc.transact(label, () => {
    for (const id of nodeIds) {
      const n = doc.get(id);
      if (!n || n.type !== 'image') continue;
      doc.update(id, { asset: data.assetId, width: data.width, height: data.height, transform: fitTransform(n, data.width, data.height, placement), link: link || undefined });
    }
  });
  return data;
}

async function pickImage(app) {
  if (app.user && app.puter?.ui?.showOpenFilePicker) {
    const source = await app.dialogs.open({
      title: 'Relink',
      body: h('p.dialog-message', 'Choose the replacement image.'),
      buttons: [{ label: 'Cancel', value: null }, { label: 'From This Device...', value: 'device' }, { label: 'From Puter...', value: 'puter', primary: true }],
    });
    if (!source) return null;
    if (source === 'puter') {
      const p = app.puter.ui.showOpenFilePicker({ multiple: false, accept: ['.png', '.jpg', '.jpeg', '.webp', '.gif'] });
      let item = await (p && p.undefinedOnCancel ? p.undefinedOnCancel : p);
      if (Array.isArray(item)) item = item[0];
      if (!item) return null;
      const blob = await item.read();
      const file = new File([blob], item.name || 'image', { type: blob.type });
      return { file, link: item.path ? { source: 'puter', path: item.path, name: item.name, size: blob.size, modified: Date.now() } : null };
    }
  }
  const [file] = await pickDeviceFiles();
  if (!file) return null;
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) && !/\.(png|jpe?g|webp|gif)$/i.test(file.name)) throw new UserError('Choose a PNG, JPEG, WebP or GIF image.');
  return { file, link: null };
}

export async function relink(app, editor, ids) {
  const picked = await pickImage(app);
  if (!picked) return false;
  await replaceImage(app, editor, ids, picked.file, { link: picked.link, label: 'Relink' });
  app.notify(`Relinked to ${picked.file.name}.`, { polite: true });
  return true;
}

/** Re-read linked files from Puter. Returns the number of images updated. */
export async function updateLinks(app, editor, ids) {
  const doc = editor.doc;
  const fs = app.puter?.fs;
  let n = 0;
  for (const id of ids) {
    const node = doc.get(id);
    if (!node?.link?.path) continue;
    if (!fs?.read) throw new UserError('Linked files can be updated when Vector Studio runs with Puter.');
    const blob = await fs.read(node.link.path);
    const file = new File([blob], node.link.name || 'image', { type: blob.type });
    await replaceImage(app, editor, [id], file, { link: { ...node.link, size: blob.size, modified: Date.now() }, label: 'Update Link' });
    n++;
  }
  return n;
}

export function embedImages(editor, ids) {
  const doc = editor.doc;
  const targets = ids.filter((id) => doc.get(id)?.link);
  if (!targets.length) return 0;
  doc.transact('Embed Image', () => targets.forEach((id) => doc.update(id, { link: undefined })));
  return targets.length;
}

/**
 * Unembed: save each image as a file in Puter and link to it. Returns the
 * number linked. Without Puter the image is saved to the device instead and
 * stays embedded (a browser download cannot be linked to).
 */
export async function unembedImages(app, editor, ids) {
  const doc = editor.doc;
  let n = 0;
  for (const id of ids) {
    const node = doc.get(id);
    const a = node?.type === 'image' ? doc.assets.get(node.asset) : null;
    if (!a?.data || node.link) continue;
    const info = imageInfo(doc, node);
    const ext = { PNG: 'png', JPEG: 'jpg', WebP: 'webp', GIF: 'gif' }[info.format] || 'png';
    const name = `${String(info.name).replace(/\.[^.]+$/, '') || 'Image'}.${ext}`;
    const blob = await (await fetch(a.data)).blob();
    const ui = app.puter?.ui;
    if (app.user && ui?.showSaveFilePicker) {
      const p = ui.showSaveFilePicker(blob, name);
      const item = await (p && p.undefinedOnCancel ? p.undefinedOnCancel : p);
      if (!item?.path) continue;
      doc.transact('Unembed', () => doc.update(id, { link: { source: 'puter', path: item.path, name: item.name || name, size: blob.size, modified: Date.now() } }));
      n++;
    } else {
      const { downloadBlob } = await import('../io/deliver.js');
      downloadBlob(blob, name);
      app.notify(`Saved ${name}. Images stay embedded in documents kept in this browser.`, { timeout: 6000 });
    }
  }
  return n;
}

/** Link status for the Show filter and sorting: 'missing' | 'modified' | 'linked' | 'embedded'. */
export function linkStatus(doc, node, modified = null) {
  const a = doc.assets.get(node.asset);
  if (!a?.data) return 'missing';
  if (node.link && modified?.has(node.id)) return 'modified';
  return node.link ? 'linked' : 'embedded';
}

/** Images to list: filtered by status ('all' | 'missing' | 'modified' | 'embedded' | 'linked') and sorted ('order' | 'name' | 'kind' | 'status'). */
export function listedImages(doc, { show = 'all', sort = 'order', modified = null } = {}) {
  let imgs = placedImages(doc);
  if (show !== 'all') imgs = imgs.filter((n) => linkStatus(doc, n, modified) === show);
  if (sort === 'order') return imgs;
  const rank = { missing: 0, modified: 1, linked: 2, embedded: 3 };
  const key = (n) => {
    const i = imageInfo(doc, n);
    if (sort === 'name') return [i.name.toLowerCase()];
    if (sort === 'kind') return [i.format, i.name.toLowerCase()];
    return [rank[linkStatus(doc, n, modified)], i.name.toLowerCase()];
  };
  return imgs
    .map((n) => ({ n, k: key(n) }))
    .sort((a, b) => {
      for (let i = 0; i < a.k.length; i++) {
        if (a.k[i] < b.k[i]) return -1;
        if (a.k[i] > b.k[i]) return 1;
      }
      return 0;
    })
    .map((x) => x.n);
}

export function goToLink(editor, id) {
  const doc = editor.doc;
  const n = doc.get(id);
  if (!n) return false;
  editor.select([id]);
  const b = nodeBounds(doc, n);
  if (b) {
    editor.view.centerOn(b.x + b.w / 2, b.y + b.h / 2);
    editor.viewChanged();
  }
  return true;
}

/**
 * Edit Original: open a Puter-linked image in Puter's image editor; any
 * other image is saved to the device to edit elsewhere and bring back with
 * Relink.
 */
export async function editOriginal(app, editor, id) {
  const doc = editor.doc;
  const n = doc.get(id);
  if (!n || n.type !== 'image') return false;
  if (n.link?.path && app.puter?.ui?.launchApp) {
    try {
      await app.puter.ui.launchApp({ name: 'photo-studio', file_paths: [n.link.path] });
      app.notify('Edit and save the image, then choose Update Link.', { polite: true });
      return true;
    } catch {
      // Fall back to saving a copy.
    }
  }
  const a = doc.assets.get(n.asset);
  if (!a?.data) throw new UserError('This image has no data to edit.');
  const info = imageInfo(doc, n);
  const ext = { PNG: 'png', JPEG: 'jpg', WebP: 'webp', GIF: 'gif' }[info.format] || 'png';
  const blob = await (await fetch(a.data)).blob();
  const { downloadBlob } = await import('../io/deliver.js');
  const name = `${String(info.name).replace(/\.[^.]+$/, '')}.${ext}`;
  downloadBlob(blob, name);
  app.notify(`Saved ${name}. Edit it, then use Relink to bring it back.`, { timeout: 6000 });
  return true;
}

const fmt = (v, d = 0) => (Number.isFinite(v) ? Number(v.toFixed(d)).toLocaleString() : '-');

export class LinksPanel extends Panel {
  static id = 'links';
  static title = 'Links';
  static icon = 'panel-links';
  static placement = 'strip';

  menu() {
    const app = this.app;
    const ed = app.editor;
    const ids = this.targets();
    const has = ids.length > 0;
    const linked = has && ids.some((id) => ed.doc.get(id)?.link);
    const embedded = has && ids.some((id) => !ed.doc.get(id)?.link);
    const opt = this.options;
    const show = (value, label) => ({ label, checked: opt.show === value, run: () => this.setOption({ show: value }) });
    const sort = (value, label) => ({ label, checked: opt.sort === value, run: () => this.setOption({ sort: value }) });
    return [
      { label: 'Relink...', enabled: has, run: () => this.run((e, t) => relink(app, e, t)) },
      { label: 'Go To Link', enabled: has, run: () => this.run((e, t) => goToLink(e, t[0])) },
      { label: 'Update Link', enabled: linked, run: () => this.updateBtn.click() },
      { label: 'Edit Original', enabled: has, run: () => this.run((e, t) => editOriginal(app, e, t[0])) },
      '-',
      { label: 'Placement Options...', run: () => this.placementOptions() },
      '-',
      { label: ids.length > 1 ? 'Embed Images' : 'Embed Image', enabled: linked, run: () => this.run((e, t) => embedImages(e, t)) },
      { label: 'Unembed...', enabled: embedded, run: () => this.run((e, t) => unembedImages(app, e, t)) },
      '-',
      { label: 'Link Information...', enabled: has, run: () => this.linkInformation() },
      '-',
      { label: 'Show', submenu: [show('all', 'Show All'), show('missing', 'Show Missing'), show('modified', 'Show Modified'), show('linked', 'Show Linked'), show('embedded', 'Show Embedded')] },
      { label: 'Sort', submenu: [sort('order', 'Stacking Order'), sort('name', 'Sort by Name'), sort('kind', 'Sort by Kind'), sort('status', 'Sort by Status')] },
      '-',
      { label: 'Check for Modified Links', enabled: Boolean(app.puter?.fs?.stat) && Boolean(ed && placedImages(ed.doc).some((n) => n.link?.path)), run: () => this.checkModified() },
      { label: 'Panel Options...', run: () => this.panelOptions() },
    ];
  }

  get options() {
    return { show: 'all', sort: 'order', thumbs: 'small', ...(this.app.prefs.get('linksPanel') || {}) };
  }

  setOption(patch) {
    this.app.prefs.set('linksPanel', { ...this.options, ...patch });
    this.key = null;
    this.update();
  }

  async placementOptions() {
    const v = await this.app.dialogs.form({
      title: 'Placement Options',
      description: 'How a relinked or updated image takes the place of the old one.',
      fields: [{ key: 'placement', label: 'Preserve', type: 'radio', value: this.app.prefs.get('linkPlacement') || 'fit', options: PLACEMENTS }],
    });
    if (v?.placement) this.app.prefs.set('linkPlacement', v.placement);
  }

  async panelOptions() {
    const v = await this.app.dialogs.form({
      title: 'Links Panel Options',
      fields: [
        {
          key: 'thumbs',
          label: 'Thumbnails',
          type: 'radio',
          value: this.options.thumbs,
          options: [
            { value: 'none', label: 'None' },
            { value: 'small', label: 'Small' },
            { value: 'large', label: 'Large' },
          ],
        },
      ],
    });
    if (v?.thumbs) this.setOption({ thumbs: v.thumbs });
  }

  /** Link Information: everything about the panel's image in a dialog. */
  linkInformation() {
    const ed = this.app.editor;
    const id = this.targets()[0];
    const node = ed?.doc.get(id);
    if (!node) return null;
    return this.app.dialogs.open({
      title: 'Link Information',
      body: h('dl.files-info-list.lk-info', this.infoRows(ed.doc, node).flatMap(([k, v]) => [h('dt', k), h('dd', v)])),
      buttons: [{ label: 'OK', value: true, primary: true }],
    });
  }

  /** Stat linked Puter files and mark the ones changed since they were placed or updated. */
  async checkModified() {
    const ed = this.app.editor;
    const fs = this.app.puter?.fs;
    if (!ed || !fs?.stat) return 0;
    this.modified = new Set();
    for (const n of placedImages(ed.doc)) {
      if (!n.link?.path) continue;
      try {
        const st = await fs.stat(n.link.path);
        const t = Number(st?.modified ?? st?.mtime ?? 0) * (Number(st?.modified ?? st?.mtime ?? 0) < 1e12 ? 1000 : 1);
        if (t && n.link.modified && t > n.link.modified + 1000) this.modified.add(n.id);
      } catch {
        // A file that cannot be read shows as linked; Update Link reports the error.
      }
    }
    this.key = null;
    this.update();
    this.app.notify(this.modified.size ? `${this.modified.size} linked file${this.modified.size === 1 ? ' has' : 's have'} changed.` : 'All linked files are up to date.', { polite: true });
    return this.modified.size;
  }

  build() {
    this.modified = new Set();
    this.selectedId = null;
    this.list = h('ul.lk-list', { role: 'listbox', tabindex: '0', 'aria-label': 'Placed images' });
    this.list.addEventListener('keydown', (e) => this.onKey(e));
    this.info = h('dl.lk-info.files-info-list', { 'aria-label': 'Link info' });
    this.infoWrap = h('details.lk-details', { open: true }, h('summary', 'Link Info'), this.info);
    const btn = (name, label, fn) => iconButton(name, label, () => this.run(fn));
    this.footer = h(
      'div.lk-footer',
      (this.relinkBtn = btn('link', 'Relink...', (ed, ids) => relink(this.app, ed, ids))),
      (this.goBtn = btn('go-to', 'Go To Link', (ed, ids) => goToLink(ed, ids[0]))),
      (this.updateBtn = btn('refresh-cw-2', 'Update Link', async (ed, ids) => {
        const n = await updateLinks(this.app, ed, ids);
        this.app.notify(n ? `Updated ${n} link${n === 1 ? '' : 's'}.` : 'Only images placed from Puter can be updated.', { polite: Boolean(n) });
      })),
      (this.editBtn = btn('external-link', 'Edit Original', (ed, ids) => editOriginal(this.app, ed, ids[0]))),
      (this.embedBtn = btn('arrow-down-to-line', 'Embed Image', (ed, ids) => embedImages(ed, ids))),
    );
    this.empty = h('p.panel-empty', 'No placed images.');
    this.el.append(this.list, this.empty, this.infoWrap, this.footer);
  }

  /** Images the footer acts on: the panel's row, else the selected images. */
  targets() {
    const ed = this.app.editor;
    if (!ed) return [];
    const sel = ed.selectedNodes().filter((n) => n.type === 'image').map((n) => n.id);
    if (sel.length > 1) return sel;
    return this.selectedId && ed.doc.has(this.selectedId) ? [this.selectedId] : sel;
  }

  async run(fn) {
    const ed = this.app.editor;
    const ids = this.targets();
    if (!ed || !ids.length) return;
    try {
      await fn(ed, ids);
    } catch (err) {
      this.app.notify(err?.message || 'Something went wrong.', { error: true });
    }
  }

  onKey(e) {
    const ed = this.app.editor;
    if (!ed) return;
    const imgs = listedImages(ed.doc, { ...this.options, modified: this.modified });
    const i = imgs.findIndex((n) => n.id === this.selectedId);
    const j = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: imgs.length - 1 }[e.key];
    if (e.key === 'Enter' && this.selectedId) {
      e.preventDefault();
      goToLink(ed, this.selectedId);
      return;
    }
    if (j === undefined || !imgs.length) return;
    e.preventDefault();
    e.stopPropagation();
    this.selectedId = imgs[Math.max(0, Math.min(imgs.length - 1, j))].id;
    this.key = null;
    this.update();
  }

  update() {
    const ed = this.app.editor;
    const opt = this.options;
    const imgs = ed ? listedImages(ed.doc, { ...opt, modified: this.modified }) : [];
    // Follow the canvas: a single selected image becomes the panel's row.
    const selImg = ed?.selectedNodes().filter((n) => n.type === 'image') || [];
    if (selImg.length === 1 && this.lastSel !== selImg[0].id) this.selectedId = selImg[0].id;
    this.lastSel = selImg.length === 1 ? selImg[0].id : null;
    if (!imgs.some((n) => n.id === this.selectedId)) this.selectedId = imgs[0]?.id || null;
    const key = ed ? `${imgs.map((n) => `${n.id}:${n.asset}:${n.transform}:${Boolean(n.link)}`).join('|')}#${this.selectedId}#${opt.thumbs}` : '';
    this.empty.hidden = imgs.length > 0;
    this.empty.textContent = opt.show === 'all' ? 'No placed images.' : 'No images match the Show filter.';
    this.list.dataset.thumbs = opt.thumbs;
    this.list.hidden = !imgs.length;
    this.infoWrap.hidden = !imgs.length;
    const has = this.targets().length > 0;
    for (const b of [this.relinkBtn, this.goBtn, this.editBtn]) b.disabled = !has;
    this.updateBtn.disabled = !this.targets().some((id) => ed.doc.get(id)?.link);
    this.embedBtn.disabled = this.updateBtn.disabled;
    if (key === this.key && ed?.doc === this.keyDoc) return;
    this.key = key;
    this.keyDoc = ed?.doc;
    if (!ed) {
      this.list.replaceChildren();
      return;
    }
    const doc = ed.doc;
    this.list.replaceChildren(
      ...imgs.map((n) => {
        const info = imageInfo(doc, n);
        const a = doc.assets.get(n.asset);
        const row = h(
          'li.lk-row',
          { id: `lk-${n.id}`, role: 'option', 'aria-selected': String(n.id === this.selectedId) },
          opt.thumbs === 'none' ? null : a?.data ? h('img.lk-thumb', { src: a.data, alt: '' }) : h('span.lk-thumb.missing', icon('image', 14)),
          h('span.lk-name', info.name),
          statusBadge(linkStatus(doc, n, this.modified), info),
        );
        row.addEventListener('click', () => {
          this.selectedId = n.id;
          this.key = null;
          this.update();
        });
        row.addEventListener('dblclick', () => goToLink(ed, n.id));
        return row;
      }),
    );
    if (this.selectedId) this.list.setAttribute('aria-activedescendant', `lk-${this.selectedId}`);
    const node = doc.get(this.selectedId);
    if (!node) {
      this.info.replaceChildren();
      return;
    }
    this.info.replaceChildren(...this.infoRows(doc, node).flatMap(([k, v]) => [h('dt', k), h('dd', v)]));
  }

  /** Link information as [label, value] rows. */
  infoRows(doc, node) {
    const i = imageInfo(doc, node);
    const units = doc.root.units || 'pt';
    const toUnits = (pt) => {
      const f = { pt: 1, px: 1, in: 72, mm: 72 / 25.4, cm: 72 / 2.54, pc: 12 }[units] || 1;
      return `${fmt(pt / f, units === 'pt' || units === 'px' ? 1 : 2)} ${units}`;
    };
    const rows = [
      ['Name', i.name],
      ['Format', i.format],
      ['Pixels', `${fmt(i.pixels.w)} x ${fmt(i.pixels.h)} px`],
      ['Placed Size', `${toUnits(i.placed.w)} x ${toUnits(i.placed.h)}`],
      ['Resolution', `${fmt(i.ppi.x)}${Math.abs(i.ppi.x - i.ppi.y) > 0.5 ? ` x ${fmt(i.ppi.y)}` : ''} ppi`],
      ['Scale', `${fmt(i.scale.x, 1)}%${Math.abs(i.scale.x - i.scale.y) > 0.05 ? ` x ${fmt(i.scale.y, 1)}%` : ''}`],
      ['Rotation', `${fmt(i.rotation, 2)}°`],
      ['File Size', i.bytes ? formatBytes(i.bytes) : '-'],
      ['Status', i.missing ? 'Missing image data' : i.linked ? 'Linked and embedded' : 'Embedded'],
      ...(i.location ? [['Location', i.location]] : []),
    ];
    if (this.modified?.has(node.id)) rows.push(['Note', 'The linked file changed: choose Update Link.']);
    if (i.ppi.x < 150 && i.ppi.x > 0) rows.push(['Note', 'Below 150 ppi: may print soft.']);
    return rows;
  }
}

function statusBadge(status, info) {
  const tip = { missing: 'Missing image data', modified: 'Linked file changed', linked: `Linked to ${info.location}`, embedded: 'Embedded' }[status];
  const ic = { missing: 'link-missing', modified: 'refresh-cw-2', linked: 'link', embedded: 'images' }[status];
  const el = h('span.lk-status', { 'data-tip': tip, 'aria-label': tip }, icon(ic, 14));
  el.dataset.status = status;
  return el;
}
