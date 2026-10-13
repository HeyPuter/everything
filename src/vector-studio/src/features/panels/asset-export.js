/**
 * Asset Export: artwork collected as named export assets, exported in one
 * step at every scale and format of the export settings.
 *
 *   doc.root.exportAssets          [{ id, name, ids: [nodeId] }]
 *   doc.root.assetExportSettings   [{ scale, suffix, format }]
 *
 * Object > Collect For Export > As Single Asset adds the selection as one
 * asset; As Multiple Assets adds each selected object as its own. Both
 * live in the document (saved, undoable). Export renders each asset's
 * objects only, cropped to their visual bounds, through the shared export
 * jobs, and delivers the files (as one zip when there are several).
 */
import { h } from '../../lib/dom.js';
import { uid } from '../../lib/ids.js';
import { Panel } from '../../ui/panels/panel.js';
import { iconButton } from '../../ui/widgets.js';
import { icon } from '../../ui/icons.js';
import { selectionBounds } from '../../model/geometry.js';
import { defaultLabel } from '../../model/nodes.js';

export const EXPORT_FORMATS = [
  { value: 'png', label: 'PNG', ext: 'png' },
  { value: 'jpeg', label: 'JPEG', ext: 'jpg' },
  { value: 'webp', label: 'WebP', ext: 'webp' },
  { value: 'svg', label: 'SVG', ext: 'svg' },
  { value: 'pdf', label: 'PDF', ext: 'pdf' },
];

export const SCALES = [0.5, 0.75, 1, 1.5, 2, 3, 4];

export const DEFAULT_SETTINGS = [{ scale: 1, suffix: '', format: 'png' }];

/** Platform scale sets (resolution conventions of the mobile platforms). */
export const SCALE_PRESETS = {
  ios: [
    { scale: 1, suffix: '', format: 'png' },
    { scale: 2, suffix: '@2x', format: 'png' },
    { scale: 3, suffix: '@3x', format: 'png' },
  ],
  android: [
    { scale: 0.75, suffix: '-ldpi', format: 'png' },
    { scale: 1, suffix: '-mdpi', format: 'png' },
    { scale: 1.5, suffix: '-hdpi', format: 'png' },
    { scale: 2, suffix: '-xhdpi', format: 'png' },
    { scale: 3, suffix: '-xxhdpi', format: 'png' },
    { scale: 4, suffix: '-xxxhdpi', format: 'png' },
  ],
};

export function assetsOf(doc) {
  return doc.root.exportAssets || [];
}

export function settingsOf(doc) {
  return doc.root.assetExportSettings || DEFAULT_SETTINGS;
}

function uniqueAssetName(list, base) {
  const names = new Set(list.map((a) => a.name));
  let name = base || 'Asset';
  for (let i = 2; names.has(name); i++) name = `${base} ${i}`;
  return name;
}

/** Add assets (inside a transaction). `single`: the ids as one asset, else one asset per id. Returns the new assets. */
export function collectAssets(doc, ids, { single = false } = {}) {
  const list = assetsOf(doc).slice();
  const groups = single ? [ids] : ids.map((id) => [id]);
  const added = [];
  for (const g of groups) {
    if (!g.length) continue;
    const first = doc.get(g[0]);
    const base = g.length === 1 && first ? defaultLabel(first).replace(/^<(.*)>$/, '$1') : `Asset ${list.length + 1}`;
    const asset = { id: uid('asset'), name: uniqueAssetName(list, base.trim() || 'Asset'), ids: [...g] };
    list.push(asset);
    added.push(asset);
  }
  doc.updateRoot({ exportAssets: list });
  return added;
}

export function updateAssets(doc, fn) {
  doc.updateRoot({ exportAssets: fn(assetsOf(doc).slice()) });
}

/** Asset objects still in the document. */
export function liveIds(doc, asset) {
  return asset.ids.filter((id) => doc.has(id));
}

export function assetBounds(doc, asset) {
  const ids = liveIds(doc, asset);
  return ids.length ? selectionBounds(doc, ids, true) : null;
}

/** "Name@2x.png" style file name for an asset and a setting. */
export function assetFileName(asset, setting) {
  const fmt = EXPORT_FORMATS.find((f) => f.value === setting.format) || EXPORT_FORMATS[0];
  const stem = String(asset.name).replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Asset';
  return `${stem}${setting.suffix || ''}.${fmt.ext}`;
}

/** Render every asset at every setting: [{ name, blob }]. */
export async function renderAssets(app, editor, assets, settings) {
  const { renderFile } = await import('../io/jobs.js');
  const doc = editor.doc;
  const files = [];
  const used = new Set();
  for (const asset of assets) {
    const ids = liveIds(doc, asset);
    const rect = assetBounds(doc, asset);
    if (!rect) continue;
    for (const s of settings) {
      const vector = s.format === 'svg' || s.format === 'pdf';
      const blob = await renderFile(app, editor, s.format, vector && s.format === 'pdf' ? { rects: [rect], ids } : { rect, ids }, { scale: s.scale, background: s.format === 'jpeg' ? 'white' : 'transparent', title: asset.name });
      let name = assetFileName(asset, s);
      // Two settings that only differ in scale but share a suffix would collide.
      for (let i = 2; used.has(name); i++) name = assetFileName(asset, { ...s, suffix: `${s.suffix || ''}-${i}` });
      used.add(name);
      files.push({ name, blob });
    }
  }
  return files;
}

async function thumbUrl(doc, asset) {
  const rect = assetBounds(doc, asset);
  if (!rect) return null;
  try {
    const { renderRegion } = await import('../io/raster.js');
    const s = Math.min(4, 72 / Math.max(rect.w, rect.h, 1));
    const canvas = await renderRegion(doc, rect, { scale: s, ids: liveIds(doc, asset) });
    if (canvas.convertToBlob) {
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      return URL.createObjectURL(blob);
    }
    return canvas.toDataURL?.('image/png') || null;
  } catch {
    return null;
  }
}

export function registerAssetCommands(app) {
  const collect = (single) => (a) => {
    const ed = a.editor;
    const ids = ed.topSelection();
    if (!ids.length) return;
    let added = [];
    ed.doc.transact(single ? 'Collect as Single Asset' : 'Collect as Multiple Assets', () => {
      added = collectAssets(ed.doc, ids, { single });
    });
    a.openPanel('assetExport');
    a.notify(`Added ${added.length} asset${added.length === 1 ? '' : 's'} to Asset Export.`, { polite: true });
  };
  const hasSel = (a) => Boolean(a.editor?.selection.size);
  app.commands.register([
    { id: 'assetExport.single', label: 'As Single Asset', enabled: hasSel, run: collect(true) },
    { id: 'assetExport.multiple', label: 'As Multiple Assets', enabled: hasSel, run: collect(false) },
  ]);
}

export class AssetExportPanel extends Panel {
  static id = 'assetExport';
  static title = 'Asset Export';
  static icon = 'panel-asset-export';
  static placement = 'strip';

  menu() {
    const doc = this.doc;
    const assets = doc ? assetsOf(doc) : [];
    const n = this.selected.size;
    const one = n === 1 ? assets.find((a) => this.selected.has(a.id)) : null;
    return [
      { id: 'assetExport.single', label: 'Add Selection as Single Asset' },
      { id: 'assetExport.multiple', label: 'Add Selection as Multiple Assets' },
      '-',
      { label: 'Select All', enabled: assets.length > 0, run: () => ((this.selected = new Set(assets.map((a) => a.id))), this.update()) },
      { label: 'Deselect All', enabled: n > 0, run: () => (this.selected.clear(), this.update()) },
      { label: 'Select Artwork', enabled: n > 0, run: () => this.selectArtwork() },
      { label: 'Rename...', enabled: Boolean(one), run: () => this.renameDialog(one) },
      { label: n > 1 ? 'Remove Selected Assets' : 'Remove Selected Asset', enabled: n > 0, run: () => this.removeSelected() },
      { label: 'Remove Assets with Deleted Artwork', enabled: assets.some((a) => !liveIds(doc, a).length), run: () => this.removeMissing() },
      '-',
      { label: n ? 'Export Selected Assets...' : 'Export All Assets...', enabled: assets.length > 0, run: () => this.export() },
      { label: 'Export Settings', submenu: [
        { label: 'iOS Scales', run: () => this.setSettings(structuredClone(SCALE_PRESETS.ios)) },
        { label: 'Android Scales', run: () => this.setSettings(structuredClone(SCALE_PRESETS.android)) },
        { label: 'Reset to 1x PNG', run: () => this.setSettings(structuredClone(DEFAULT_SETTINGS)) },
      ] },
      { label: 'Zip Several Files', checked: this.app.prefs.get('assetExportZip') !== false, run: () => this.setZip(this.app.prefs.get('assetExportZip') === false) },
      '-',
      { label: 'Sort by Name', enabled: assets.length > 1, run: () => this.sortByName() },
    ];
  }

  setZip(on) {
    this.app.prefs.set('assetExportZip', on);
    this.zip.checked = on;
  }

  async renameDialog(asset) {
    const v = await this.app.dialogs.form({ title: 'Rename Asset', fields: [{ key: 'name', label: 'Name', type: 'text', value: asset.name }] });
    const name = v?.name?.trim();
    const doc = this.doc;
    if (name && doc) doc.transact('Rename Asset', () => updateAssets(doc, (list) => list.map((a) => (a.id === asset.id ? { ...a, name } : a))));
  }

  removeMissing() {
    const doc = this.doc;
    doc.transact('Remove Asset', () => updateAssets(doc, (list) => list.filter((a) => liveIds(doc, a).length)));
  }

  sortByName() {
    const doc = this.doc;
    doc.transact('Sort Assets', () => updateAssets(doc, (list) => list.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))));
  }

  build() {
    this.selected = new Set();
    this.thumbs = new Map(); // asset id -> { key, url }
    this.grid = h('ul.ae-grid', { role: 'listbox', 'aria-label': 'Export assets', 'aria-multiselectable': 'true' });
    this.hint = h('p.ae-hint', 'Select artwork and choose Add Selection, or Object > Collect For Export, to add assets.');
    const addBar = h(
      'div.ae-add',
      iconButton('plus', 'Add Selection as One Asset', () => this.app.commands.run('assetExport.single'), { className: 'small' }),
      iconButton('copy-plus', 'Add Each Selected Object as an Asset', () => this.app.commands.run('assetExport.multiple'), { className: 'small' }),
      h('span.ae-spacer'),
      (this.selectArtBtn = iconButton('go-to', 'Select Asset Artwork', () => this.selectArtwork(), { className: 'small' })),
      (this.delBtn = iconButton('trash', 'Remove Asset', () => this.removeSelected(), { className: 'small' })),
    );
    this.settingsList = h('div.ae-settings', { role: 'group', 'aria-label': 'Export settings' });
    this.zip = h('input#ae-zip', { type: 'checkbox', checked: this.app.prefs.get('assetExportZip') !== false, onchange: () => this.app.prefs.set('assetExportZip', this.zip.checked) });
    this.exportBtn = h('button.btn.primary.ae-export', { type: 'button', onclick: () => this.export() }, 'Export...');
    this.empty = h('p.panel-empty', 'No document open.');
    this.body = h(
      'div.ae',
      this.hint,
      this.grid,
      addBar,
      h(
        'details.ae-details',
        { open: true },
        h('summary', 'Export Settings'),
        h(
          'div.ae-presets',
          h('button.btn.small', { type: 'button', onclick: () => this.setSettings(structuredClone(SCALE_PRESETS.ios)) }, 'iOS'),
          h('button.btn.small', { type: 'button', onclick: () => this.setSettings(structuredClone(SCALE_PRESETS.android)) }, 'Android'),
        ),
        h('div.ae-settings-head', { 'aria-hidden': 'true' }, h('span', 'Scale'), h('span', 'Suffix'), h('span', 'Format'), h('span')),
        this.settingsList,
        h('button.btn.small.block.ae-add-scale', { type: 'button', onclick: () => this.addScale() }, icon('plus', 14), 'Add Scale'),
      ),
      h('div.ae-footer', h('div.check-row', this.zip, h('label', { for: 'ae-zip' }, 'Zip several files')), this.exportBtn),
    );
    this.el.append(this.empty, this.body);
  }

  get doc() {
    return this.app.editor?.doc;
  }

  setSettings(list) {
    const doc = this.doc;
    if (!doc) return;
    doc.transact('Export Settings', () => doc.updateRoot({ assetExportSettings: list }));
  }

  addScale() {
    const list = settingsOf(this.doc).slice();
    const used = new Set(list.map((s) => s.scale));
    const scale = SCALES.find((s) => s > 1 && !used.has(s)) || 1;
    list.push({ scale, suffix: scale === 1 ? '' : `@${scale}x`, format: list[list.length - 1]?.format || 'png' });
    this.setSettings(list);
  }

  patchSetting(i, patch) {
    const list = settingsOf(this.doc).map((s, j) => (j === i ? { ...s, ...patch } : s));
    this.setSettings(list);
  }

  removeSetting(i) {
    const list = settingsOf(this.doc).filter((_, j) => j !== i);
    this.setSettings(list.length ? list : structuredClone(DEFAULT_SETTINGS));
  }

  selectArtwork() {
    const ed = this.app.editor;
    if (!ed) return;
    const ids = assetsOf(ed.doc).filter((a) => this.selected.has(a.id)).flatMap((a) => liveIds(ed.doc, a));
    if (ids.length) ed.select(ids);
  }

  removeSelected() {
    const doc = this.doc;
    if (!doc || !this.selected.size) return;
    doc.transact('Remove Asset', () => updateAssets(doc, (list) => list.filter((a) => !this.selected.has(a.id))));
    this.selected.clear();
  }

  rename(asset) {
    const doc = this.doc;
    const tile = this.grid.querySelector(`[data-id="${asset.id}"] .ae-name`);
    if (!tile) return;
    const input = h('input.ae-rename', { type: 'text', value: asset.name, 'aria-label': 'Asset name', spellcheck: false });
    tile.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (save && v && v !== asset.name) doc.transact('Rename Asset', () => updateAssets(doc, (list) => list.map((a) => (a.id === asset.id ? { ...a, name: v } : a))));
      this.renderKey = null;
      this.update();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  async export() {
    const ed = this.app.editor;
    if (!ed) return;
    const all = assetsOf(ed.doc).filter((a) => liveIds(ed.doc, a).length);
    const assets = this.selected.size ? all.filter((a) => this.selected.has(a.id)) : all;
    if (!assets.length) {
      this.app.notify('Add artwork to Asset Export first.');
      return null;
    }
    this.exportBtn.disabled = true;
    try {
      const files = await renderAssets(this.app, ed, assets, settingsOf(ed.doc));
      const { deliverFiles } = await import('../io/deliver.js');
      const base = ed.name.replace(/\.[^.]+$/, '') || 'Assets';
      const msg = await deliverFiles(this.app, files, { dest: this.app.user && this.app.puter?.ui ? 'puter' : 'device', zip: this.zip.checked, zipName: `${base} Assets.zip` });
      if (msg) this.app.notify(msg, { polite: true });
      return files;
    } catch (err) {
      this.app.notify(err?.message || 'Export failed.', { error: true });
      return null;
    } finally {
      this.exportBtn.disabled = false;
    }
  }

  update() {
    const ed = this.app.editor;
    this.empty.hidden = Boolean(ed);
    this.body.hidden = !ed;
    if (!ed) return;
    const doc = ed.doc;
    const assets = assetsOf(doc);
    for (const id of [...this.selected]) if (!assets.some((a) => a.id === id)) this.selected.delete(id);
    this.hint.hidden = assets.length > 0;
    this.delBtn.disabled = this.selectArtBtn.disabled = !this.selected.size;
    this.exportBtn.textContent = this.selected.size ? `Export ${this.selected.size} Selected...` : 'Export All...';
    this.exportBtn.disabled = !assets.length;
    const key = `${doc.nodes.version}|${[...this.selected].join(',')}`;
    if (this.renderKey === key && this.renderDoc === doc) return;
    this.renderKey = key;
    this.renderDoc = doc;
    this.renderGrid(doc, assets);
    this.renderSettings(doc);
  }

  renderGrid(doc, assets) {
    this.grid.replaceChildren(
      ...assets.map((a) => {
        const missing = !liveIds(doc, a).length;
        const img = h('span.ae-thumb', { 'aria-hidden': 'true' });
        const tile = h(
          'li.ae-tile',
          { role: 'option', tabindex: '0', 'aria-selected': String(this.selected.has(a.id)), 'data-id': a.id, 'aria-label': `${a.name}${missing ? ' (artwork deleted)' : ''}` },
          img,
          h('span.ae-name', a.name),
        );
        tile.classList.toggle('missing', missing);
        const toggle = (e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey) {
            if (this.selected.has(a.id)) this.selected.delete(a.id);
            else this.selected.add(a.id);
          } else this.selected = new Set(this.selected.size === 1 && this.selected.has(a.id) ? [] : [a.id]);
          this.update();
        };
        tile.addEventListener('click', toggle);
        tile.addEventListener('dblclick', () => this.rename(a));
        tile.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle(e);
          } else if (e.key === 'F2') {
            e.preventDefault();
            this.rename(a);
          } else if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            this.selected = new Set([a.id]);
            this.removeSelected();
          } else return;
          e.stopPropagation();
        });
        this.fillThumb(doc, a, img);
        return tile;
      }),
    );
  }

  async fillThumb(doc, asset, el) {
    const key = `${doc.nodes.version}:${asset.ids.join(',')}`;
    let t = this.thumbs.get(asset.id);
    if (!t || t.key !== key) {
      if (t?.url?.startsWith('blob:')) URL.revokeObjectURL(t.url);
      t = { key, url: null, pending: thumbUrl(doc, asset) };
      this.thumbs.set(asset.id, t);
      t.url = await t.pending;
    } else if (t.pending) await t.pending;
    if (t.url) el.style.backgroundImage = `url("${t.url}")`;
  }

  renderSettings(doc) {
    const list = settingsOf(doc);
    this.settingsList.replaceChildren(
      ...list.map((s, i) => {
        const scale = h(
          'select.select',
          { 'aria-label': `Scale ${i + 1}`, onchange: () => this.patchSetting(i, { scale: Number(scale.value) }) },
          [...new Set([...SCALES, s.scale])].sort((a, b) => a - b).map((v) => h('option', { value: String(v), selected: v === s.scale }, `${v}x`)),
        );
        const suffix = h('input.ae-suffix', { type: 'text', value: s.suffix || '', placeholder: 'None', 'aria-label': `Suffix ${i + 1}`, spellcheck: false });
        suffix.addEventListener('change', () => this.patchSetting(i, { suffix: suffix.value.trim() }));
        suffix.addEventListener('keydown', (e) => e.stopPropagation());
        const format = h(
          'select.select',
          { 'aria-label': `Format ${i + 1}`, onchange: () => this.patchSetting(i, { format: format.value }) },
          EXPORT_FORMATS.map((f) => h('option', { value: f.value, selected: f.value === s.format }, f.label)),
        );
        return h('div.ae-setting', scale, suffix, format, iconButton('x', `Remove scale ${i + 1}`, () => this.removeSetting(i), { className: 'small', disabled: list.length < 2 }));
      }),
    );
  }
}
