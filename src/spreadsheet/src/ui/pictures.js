/**
 * Picture commands beyond inserting a floating picture (the editor's insertImage*): pictures placed
 * in cells and back over the cells (Place in Cell, Place over Cells), a cell picture's alt text, the
 * Picture Format tab's commands (see picture-ribbon.js), and pictures of copied cells (Paste Special
 * ▸ Picture and Linked Picture) with the linked picture's reference edited in the formula bar.
 *
 * The models live in core: cell-picture.js, picture-format.js and range-picture.js.
 */
import { el } from './dom.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import { imageToPng } from './picture-raster.js';
import { pictureNode } from './picture.js';
import { openCropDialog } from './picture-crop.js';
import { cellPicture, cellPictureFromObject, isCellPicture, objectFromCellPicture, placedSize, setCellPictureAlt, CELL_PICTURE_ALT_MAX } from '../core/cell-picture.js';
import { RESET_PICTURE, PICTURE_STYLES, aspectCrop, cropPatch, pictureIsPlain, resetPictureAndSize, sizePatch, normalizePictureFormat, percent } from '../core/picture-format.js';
import { linkedPictureTarget, rangePicture, svgDataUrl } from '../core/range-picture.js';
import { normalizeRange } from '../core/cell.js';
import { placeAlong } from '../core/charts.js';
import { MAX_ROW, MAX_COL } from '../core/refs.js';
import { t } from '../i18n/index.js';

/** The commands this module runs for the editor. */
export const PICTURE_COMMANDS = new Set(['placeOverCells', 'placeObjectInCell', 'cellAltText', 'pictureFormat', 'pastePicture', 'linkedPictureRef']);

const loadImage = (src) => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error(t('pictures.unreadable')));
  image.src = src;
});
const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

/** A picture's own size in pixels (an SVG without one counts as 240 × 160). */
export async function naturalSize(src) {
  try {
    const image = await loadImage(src);
    return { w: image.naturalWidth || image.width || 240, h: image.naturalHeight || image.height || 160 };
  } catch { return { w: 240, h: 160 }; }
}

/**
 * A picture as the file can keep it in a cell: PNG, JPEG, GIF and WebP stay as they are; anything
 * else (SVG, BMP) is drawn into a PNG, at most 2048 pixels on its longer side.
 */
export async function cellReadySource(src) {
  if (/^data:image\/(png|jpeg|gif|webp);base64,/i.test(src)) return src;
  const image = await loadImage(src);
  const w = image.naturalWidth || 240, h = image.naturalHeight || 160, k = Math.min(1, 2048 / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * k)); canvas.height = Math.max(1, Math.round(h * k));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

export function createPictures(ctx, { keepFocus, selectLocation }) {
  const { wb } = ctx;
  const sheetId = () => ctx.sheetId();
  const protectedSheet = (id = sheetId()) => {
    if (!wb.isProtected(id)) return false;
    const name = wb.sheet(id)?.name;
    toast(name ? t('pictures.protectedNamed', { name }) : t('pictures.protected'), { icon: 'lock', duration: 3500 });
    return true;
  };
  /** The floating pictures selected (every one of a selected group). */
  const selectedPictures = () => {
    const sheet = wb.sheet(sheetId()), ids = ctx.grid.selectedCharts?.length ? ctx.grid.selectedCharts : [ctx.grid.selectedChart].filter(Boolean);
    return ids.map((id) => sheet?.charts.find((o) => o.id === id)).filter((o) => o?.type === 'image');
  };

  /**
   * Put a picture into a cell as its value: the cell keeps its format and link, its content goes. One
   * undoable step; false when the cell is locked or the sheet is gone.
   */
  async function placeSourceInCell(src, { sheetId: id = sheetId(), at = { ...ctx.active() }, alt = '' } = {}) {
    const ready = await cellReadySource(src);
    if (!wb.sheet(id) || wb.lockedIn(id, { r1: at.r, c1: at.c, r2: at.r, c2: at.c })) return false;
    const prev = wb.getCell(id, at.r, at.c);
    const cell = { ...(prev?.s ? { s: prev.s } : {}), ...(prev?.hyperlink ? { hyperlink: prev.hyperlink } : {}), v: cellPicture(ready, { alt }), f: null };
    return wb.setCells(id, [{ r: at.r, c: at.c, cell }], t('pictures.undo.placePictureInCell')) > 0;
  }

  /** Right-click a cell picture ▸ Place over Cells: the picture floats over the cell it was in, the cell left empty. */
  async function placeOverCells() {
    const id = sheetId(), at = { ...ctx.active() }, cell = wb.getCell(id, at.r, at.c);
    if (!isCellPicture(cell?.v) || cell.f != null) { toast(t('pictures.selectPlacedPicture'), { icon: 'info', duration: 3000 }); return; }
    if (protectedSheet(id) || wb.lockedIn(id, { r1: at.r, c1: at.c, r2: at.r, c2: at.c })) return;
    const natural = await naturalSize(cell.v.image);
    const obj = objectFromCellPicture(cell.v, at, natural);
    if (!obj) return;
    let objectId = null;
    // The cell keeps its format and link; its content is now the floating picture.
    const keep = { ...(cell.s ? { s: cell.s } : {}), ...(cell.hyperlink ? { hyperlink: cell.hyperlink } : {}) };
    wb.transaction(t('pictures.undo.placeOverCells'), () => {
      wb.setCells(id, [{ r: at.r, c: at.c, cell: Object.keys(keep).length ? { ...keep, v: null, f: null } : null }], t('pictures.undo.placeOverCells'));
      objectId = wb.addChart(id, obj);
    });
    if (objectId && sheetId() === id) ctx.grid.selectChart(objectId);
    ctx.announce?.(t('pictures.nowFloats'));
  }

  /** A floating picture's context menu or Picture Format ▸ Place in Cell: the picture goes into the cell under its top-left corner. */
  async function placeObjectInCell(chartId) {
    const id = sheetId(), obj = wb.chartById(id, chartId || ctx.grid.selectedChart);
    if (obj?.type !== 'image') { toast(t('pictures.selectToPlace'), { icon: 'info', duration: 2500 }); return; }
    if (protectedSheet(id)) return;
    const at = { r: obj.anchor.r, c: obj.anchor.c };
    let src = obj.src;
    try {
      // A linked picture goes in as the picture of its cells it shows now; a cropped, turned or corrected one as it is drawn.
      const target = obj.pictureRef && linkedPictureTarget(wb, id, obj.pictureRef);
      const live = target && rangePicture(wb, target.sheetId, target.range);
      if (live) src = svgDataUrl(live.svg);
      if (!pictureIsPlain(obj) || obj.drawingShape || live) src = await blobToDataUrl(await imageToPng(src, { ...obj, ...(live ? { srcRect: null, fillRect: null } : {}) }));
      src = await cellReadySource(src);
    } catch (e) { console.error(e); toast(t('pictures.couldNotPlace'), { icon: 'alert' }); return; }
    if (!wb.chartById(id, obj.id) || wb.lockedIn(id, { r1: at.r, c1: at.c, r2: at.r, c2: at.c })) return;
    const value = cellPictureFromObject(obj, src);
    const prev = wb.getCell(id, at.r, at.c);
    wb.transaction(t('pictures.undo.placeInCell'), () => {
      wb.setCells(id, [{ r: at.r, c: at.c, cell: { ...(prev?.s ? { s: prev.s } : {}), ...(prev?.hyperlink ? { hyperlink: prev.hyperlink } : {}), v: value, f: null } }], t('pictures.undo.placeInCell'));
      wb.deleteChart(id, obj.id);
    });
    if (sheetId() === id) { ctx.grid.selectChart(null); selectLocation?.(id, { r1: at.r, c1: at.c, r2: at.r, c2: at.c }); }
    ctx.announce?.(t('pictures.nowInCell'));
  }

  /** Alt Text for a picture placed in a cell. */
  function cellAltText() {
    const id = sheetId(), at = { ...ctx.active() }, cell = wb.getCell(id, at.r, at.c);
    if (!isCellPicture(cell?.v)) { toast(t('pictures.selectCellPicture'), { icon: 'info', duration: 2500 }); return; }
    if (cell.f != null) {
      toast(t('pictures.fromFormula'), { icon: 'info', duration: 3500 });
      return;
    }
    const text = el('textarea.input.alt-text-input', { rows: 5, maxlength: CELL_PICTURE_ALT_MAX, 'aria-label': t('pictures.altDescription'), placeholder: t('pictures.altPlaceholder') });
    text.value = cell.v.alt || '';
    const submit = (e) => {
      e?.preventDefault();
      setCellPictureAlt(wb, id, at.r, at.c, text.value);
      modal.close();
    };
    const content = el('form', { onsubmit: submit },
      el('p.small.muted', {}, t('pictures.altPrompt')),
      text,
      el('div.row.row-end', {},
        el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
        el('button.btn.btn-primary', { type: 'submit' }, t('common.ok'))));
    const modal = openModal({ title: t('pictures.altTitle'), content, initialFocus: text, onClose: () => keepFocus() });
  }

  /* ---------- Picture Format ---------- */

  /** Apply `patchOf(picture)` to every selected picture, as one step. */
  /**
   * The crop patch, with the picture anchored again to the cell its corner now lies in (a crop off the left or top
   * moves the corner on): as a drag anchors what it moves, so it follows the columns and rows it lies in.
   */
  function croppedPatch(id, obj, crop) {
    const patch = cropPatch(obj, crop), sheet = wb.sheet(id);
    if (!sheet || sheet.kind === 'chart' || obj.anchorMode === 'absolute' || obj.cellAnchor) return patch;
    const col = placeAlong((c) => wb.colWidth(id, c), MAX_COL + 1, obj.anchor.c, patch.dx, 1);
    const row = placeAlong((r) => wb.rowHeight(id, r), MAX_ROW + 1, obj.anchor.r, patch.dy, 1);
    // A corner past the lines laid out so far (a wide picture at the sheet's right) grows the sheet to it.
    if (col.index >= sheet.cols || row.index >= sheet.rows) wb.ensureSize(id, Math.max(sheet.rows, row.index + 1), Math.max(sheet.cols, col.index + 1));
    return { ...patch, anchor: { r: row.index, c: col.index }, dx: col.offset, dy: row.offset };
  }

  function patchPictures(label, patchOf) {
    const id = sheetId(), pictures = selectedPictures();
    if (!pictures.length) { toast(t('pictures.selectFirst'), { icon: 'info', duration: 2500 }); return false; }
    if (protectedSheet(id)) return false;
    wb.transaction(label, () => { for (const obj of pictures) { const patch = patchOf(obj); if (patch) wb.updateChart(id, obj.id, patch, label); } });
    return true;
  }

  async function pictureFormat(arg = {}) {
    const action = arg.action;
    switch (action) {
      case 'adjust': {
        const adjust = normalizePictureFormat({ adjust: arg.adjust }).adjust || null;
        patchPictures(t('pictures.undo.corrections'), () => ({ adjust }));
        ctx.announce?.(adjust ? t('pictures.correctionsSet', { brightness: percent(adjust.brightness), contrast: percent(adjust.contrast) }) : t('pictures.correctionsRemoved'));
        return;
      }
      case 'recolor': patchPictures(t('pictures.undo.color'), () => ({ recolor: arg.recolor === 'grayscale' ? 'grayscale' : null })); return;
      case 'transparency': patchPictures(t('pictures.undo.transparency'), () => ({ transparency: arg.transparency > 0 ? arg.transparency : null })); return;
      case 'style': {
        const style = PICTURE_STYLES.find((s) => s.id === arg.style);
        if (style) patchPictures(t('pictures.undo.style'), () => ({ ...style.patch }));
        return;
      }
      case 'reset': patchPictures(t('pictures.undo.reset'), () => ({ ...RESET_PICTURE })); return;
      case 'resetSize': {
        const pictures = selectedPictures();
        const sizes = new Map(await Promise.all(pictures.map(async (o) => [o.id, placedSize(await naturalSize(o.src))])));
        patchPictures(t('pictures.undo.resetSize'), (o) => resetPictureAndSize(sizes.get(o.id) || { w: o.w, h: o.h }));
        return;
      }
      case 'size': patchPictures(t('pictures.undo.size'), (o) => sizePatch(o, { w: arg.w, h: arg.h })); return;
      case 'lockAspect': patchPictures(t('pictures.undo.lockAspect'), () => ({ lockAspect: arg.on ? null : false })); return;
      case 'uncrop': patchPictures(t('pictures.undo.removeCrop'), (o) => (o.srcRect || o.fillRect ? croppedPatch(sheetId(), { ...o, fillRect: null }, { x: 0, y: 0, w: 1, h: 1 }) : null)); return;
      case 'cropAspect': patchPictures(t('pictures.undo.cropAspect'), (o) => croppedPatch(sheetId(), o, aspectCrop(o, arg.ratio))); return;
      case 'crop': {
        const obj = selectedPictures()[0];
        if (!obj) { toast(t('pictures.selectToCrop'), { icon: 'info', duration: 2500 }); return; }
        if (protectedSheet()) return;
        if (obj.pictureRef) { toast(t('pictures.linkedNoCrop'), { icon: 'info', duration: 3500 }); return; }
        const id = sheetId();
        openCropDialog({ picture: obj, onApply: (crop) => { if (wb.chartById(id, obj.id)) wb.updateChart(id, obj.id, croppedPatch(id, wb.chartById(id, obj.id), crop), t('pictures.undo.crop')); }, onClose: () => keepFocus() });
        return;
      }
      case 'correctionsDialog': openCorrectionsDialog(); return;
      default: return;
    }
  }

  /** Picture Corrections Options: brightness, contrast and transparency set exactly, previewed in the dialog, applied on OK as one step. */
  function openCorrectionsDialog() {
    const id = sheetId(), obj = selectedPictures()[0];
    if (!obj || protectedSheet(id)) return;
    const row = (label, percentLabel, value, min, max) => {
      const range = el('input', { type: 'range', min, max, step: 1, value: Math.round(value * 100), 'aria-label': label });
      const number = el('input.input.picture-correction-number', { type: 'number', min, max, step: 1, value: Math.round(value * 100), 'aria-label': percentLabel });
      range.addEventListener('input', () => { number.value = range.value; preview(); });
      number.addEventListener('input', () => { range.value = number.value; preview(); });
      return { range, number, node: el('label.picture-correction-row', {}, el('span.picture-correction-label', {}, label), range, number, el('span', {}, '%')) };
    };
    const brightness = row(t('pictures.brightness'), t('pictures.brightnessPercent'), obj.adjust?.brightness || 0, -100, 100);
    const contrast = row(t('pictures.contrast'), t('pictures.contrastPercent'), obj.adjust?.contrast || 0, -100, 100);
    const transparency = row(t('pictures.transparency'), t('pictures.transparencyPercent'), obj.transparency || 0, 0, 100);
    const value = () => ({
      adjust: normalizePictureFormat({ adjust: { brightness: Number(brightness.range.value) / 100, contrast: Number(contrast.range.value) / 100 } }).adjust || null,
      transparency: Math.min(1, Math.max(0, Number(transparency.range.value) / 100)) || null,
    });
    const k = Math.min(260 / obj.w, 160 / obj.h, 2);
    const stage = el('div.picture-corrections-preview', { style: { width: `${Math.round(obj.w * k)}px`, height: `${Math.round(obj.h * k)}px` } });
    function preview() { stage.replaceChildren(pictureNode({ ...obj, ...value(), decorative: true })); }
    preview();
    const reset = el('button.btn.btn-ghost', { type: 'button', onclick: () => {
      for (const f of [brightness, contrast, transparency]) { f.range.value = '0'; f.number.value = '0'; }
      preview();
    } }, t('common.reset'));
    const content = el('form', { onsubmit: (e) => {
      e.preventDefault();
      if (wb.chartById(id, obj.id)) wb.updateChart(id, obj.id, value(), t('pictures.undo.corrections'));
      modal.close();
    } },
      el('div.picture-corrections-stage', {}, el('span.picture-checker', {}, stage)),
      el('div.picture-corrections', {}, brightness.node, contrast.node, transparency.node),
      el('div.row.row-end', {}, reset, el('span', { style: { flex: '1' } }),
        el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
        el('button.btn.btn-primary', { type: 'submit' }, t('common.ok'))));
    const modal = openModal({ title: t('pictures.correctionsTitle'), content, initialFocus: brightness.range, onClose: () => keepFocus() });
  }

  /* ---------- Pictures of cells ---------- */

  /**
   * Paste Special ▸ Picture (`linked` false) or Linked Picture: a picture of the cells copied, at the
   * active cell. A linked one keeps showing what those cells hold.
   */
  function pastePicture({ linked = false, source } = {}) {
    const id = sheetId();
    if (!source || !wb.sheet(source.sheetId)) { toast(t('pictures.copyFirst'), { icon: 'info', duration: 3000 }); return null; }
    if (protectedSheet(id)) return null;
    const range = normalizeRange(source.range);
    const picture = rangePicture(wb, source.sheetId, range);
    if (!picture) { toast(t('pictures.rangeTooLarge'), { icon: 'info', duration: 3000 }); return null; }
    const at = { ...ctx.active() };
    const ref = wb.refTextFor(source.sheetId, range);
    const objectId = wb.addChart(id, {
      type: 'image', src: svgDataUrl(picture.svg), title: linked ? `Linked picture of ${ref}` : `Picture of ${ref}`, anchor: at, dx: 0, dy: 0,
      w: Math.max(1, Math.round(picture.w)), h: Math.max(1, Math.round(picture.h)), border: false,
      ...(linked ? { pictureRef: ref } : {}),
    });
    if (!objectId) return null;
    ctx.grid.selectChart(objectId);
    ctx.announce?.(linked ? t('pictures.linkedPasted', { ref }) : t('pictures.picturePasted', { ref }));
    return objectId;
  }

  /**
   * The formula bar's edit of a linked picture's reference: =Sheet1!$A$1:$C$5 names the cells it shows.
   * Returns a problem to show, or null when the picture now shows the cells named. An empty entry
   * unlinks the picture, leaving the picture it showed last.
   */
  function linkedPictureRef({ id: objectId, text }) {
    const id = sheetId(), obj = wb.chartById(id, objectId);
    if (obj?.type !== 'image') return t('pictures.selectLinked');
    if (wb.isProtected(id)) {
      const name = wb.sheet(id)?.name;
      return name ? t('pictures.sheetProtectedNamed', { name }) : t('pictures.sheetProtected');
    }
    const entry = String(text ?? '').trim().replace(/^=/, '').trim();
    if (!entry) {
      const target = obj.pictureRef && linkedPictureTarget(wb, id, obj.pictureRef);
      const last = target && rangePicture(wb, target.sheetId, target.range);
      wb.updateChart(id, obj.id, { pictureRef: null, ...(last ? { src: svgDataUrl(last.svg) } : {}) }, t('pictures.undo.unlink'));
      return null;
    }
    const target = linkedPictureTarget(wb, id, entry);
    if (!target) return t('pictures.notARange', { entry });
    const picture = rangePicture(wb, target.sheetId, target.range);
    if (!picture) return t('pictures.rangeTooLarge');
    const ref = /^[A-Za-z_\\][\w.\\]*$/.test(entry) && wb.namedRef?.(entry) ? entry : wb.refTextFor(target.sheetId, target.range);
    // A new range brings its own shape: the picture takes the size of the cells it now shows.
    wb.updateChart(id, obj.id, { pictureRef: ref, src: svgDataUrl(picture.svg), w: Math.max(1, Math.round(picture.w)), h: Math.max(1, Math.round(picture.h)) }, t('pictures.undo.changeLinked'));
    return null;
  }

  async function run(cmd, arg) {
    switch (cmd) {
      case 'placeOverCells': return placeOverCells();
      case 'placeObjectInCell': return placeObjectInCell(arg);
      case 'cellAltText': return cellAltText();
      case 'pictureFormat': return pictureFormat(arg);
      case 'pastePicture': return pastePicture(arg);
      case 'linkedPictureRef': return linkedPictureRef(arg);
      default: return undefined;
    }
  }

  return { run, placeSourceInCell, selectedPictures };
}
