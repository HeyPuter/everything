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

/** The commands this module runs for the editor. */
export const PICTURE_COMMANDS = new Set(['placeOverCells', 'placeObjectInCell', 'cellAltText', 'pictureFormat', 'pastePicture', 'linkedPictureRef']);

const loadImage = (src) => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('That picture could not be read'));
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
    toast(`${wb.sheet(id)?.name || 'This sheet'} is protected. Unprotect it to change its pictures`, { icon: 'lock', duration: 3500 });
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
    return wb.setCells(id, [{ r: at.r, c: at.c, cell }], 'Place picture in cell') > 0;
  }

  /** Right-click a cell picture ▸ Place over Cells: the picture floats over the cell it was in, the cell left empty. */
  async function placeOverCells() {
    const id = sheetId(), at = { ...ctx.active() }, cell = wb.getCell(id, at.r, at.c);
    if (!isCellPicture(cell?.v) || cell.f != null) { toast('Select a cell holding a picture placed in it', { icon: 'info', duration: 3000 }); return; }
    if (protectedSheet(id) || wb.lockedIn(id, { r1: at.r, c1: at.c, r2: at.r, c2: at.c })) return;
    const natural = await naturalSize(cell.v.image);
    const obj = objectFromCellPicture(cell.v, at, natural);
    if (!obj) return;
    let objectId = null;
    // The cell keeps its format and link; its content is now the floating picture.
    const keep = { ...(cell.s ? { s: cell.s } : {}), ...(cell.hyperlink ? { hyperlink: cell.hyperlink } : {}) };
    wb.transaction('Place over cells', () => {
      wb.setCells(id, [{ r: at.r, c: at.c, cell: Object.keys(keep).length ? { ...keep, v: null, f: null } : null }], 'Place over cells');
      objectId = wb.addChart(id, obj);
    });
    if (objectId && sheetId() === id) ctx.grid.selectChart(objectId);
    ctx.announce?.('The picture now floats over the cells');
  }

  /** A floating picture's context menu or Picture Format ▸ Place in Cell: the picture goes into the cell under its top-left corner. */
  async function placeObjectInCell(chartId) {
    const id = sheetId(), obj = wb.chartById(id, chartId || ctx.grid.selectedChart);
    if (obj?.type !== 'image') { toast('Select a picture to place in a cell', { icon: 'info', duration: 2500 }); return; }
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
    } catch (e) { console.error(e); toast('Could not place that picture in a cell', { icon: 'alert' }); return; }
    if (!wb.chartById(id, obj.id) || wb.lockedIn(id, { r1: at.r, c1: at.c, r2: at.r, c2: at.c })) return;
    const value = cellPictureFromObject(obj, src);
    const prev = wb.getCell(id, at.r, at.c);
    wb.transaction('Place in cell', () => {
      wb.setCells(id, [{ r: at.r, c: at.c, cell: { ...(prev?.s ? { s: prev.s } : {}), ...(prev?.hyperlink ? { hyperlink: prev.hyperlink } : {}), v: value, f: null } }], 'Place in cell');
      wb.deleteChart(id, obj.id);
    });
    if (sheetId() === id) { ctx.grid.selectChart(null); selectLocation?.(id, { r1: at.r, c1: at.c, r2: at.r, c2: at.c }); }
    ctx.announce?.('The picture is now in the cell');
  }

  /** Alt Text for a picture placed in a cell. */
  function cellAltText() {
    const id = sheetId(), at = { ...ctx.active() }, cell = wb.getCell(id, at.r, at.c);
    if (!isCellPicture(cell?.v)) { toast('Select a cell holding a picture', { icon: 'info', duration: 2500 }); return; }
    if (cell.f != null) {
      toast('This picture comes from a formula: give IMAGE its alt text as the second argument', { icon: 'info', duration: 3500 });
      return;
    }
    const text = el('textarea.input.alt-text-input', { rows: 5, maxlength: CELL_PICTURE_ALT_MAX, 'aria-label': 'Alt text description', placeholder: 'Describe this picture for someone who can\'t see it' });
    text.value = cell.v.alt || '';
    const submit = (e) => {
      e?.preventDefault();
      setCellPictureAlt(wb, id, at.r, at.c, text.value);
      modal.close();
    };
    const content = el('form', { onsubmit: submit },
      el('p.small.muted', {}, 'How would you describe this picture and its context to someone who is blind or has low vision? The description goes with the cell when it is copied, sorted or saved.'),
      text,
      el('div.row.row-end', {},
        el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
        el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
    const modal = openModal({ title: 'Alt Text', content, initialFocus: text, onClose: () => keepFocus() });
  }

  /* ---------- Picture Format ---------- */

  /** Apply `patchOf(picture)` to every selected picture, as one step. */
  function patchPictures(label, patchOf) {
    const id = sheetId(), pictures = selectedPictures();
    if (!pictures.length) { toast('Select a picture first', { icon: 'info', duration: 2500 }); return false; }
    if (protectedSheet(id)) return false;
    wb.transaction(label, () => { for (const obj of pictures) { const patch = patchOf(obj); if (patch) wb.updateChart(id, obj.id, patch, label); } });
    return true;
  }

  async function pictureFormat(arg = {}) {
    const action = arg.action;
    switch (action) {
      case 'adjust': {
        const adjust = normalizePictureFormat({ adjust: arg.adjust }).adjust || null;
        patchPictures('Picture corrections', () => ({ adjust }));
        ctx.announce?.(adjust ? `Brightness ${percent(adjust.brightness)}, contrast ${percent(adjust.contrast)}` : 'Corrections removed');
        return;
      }
      case 'recolor': patchPictures('Picture color', () => ({ recolor: arg.recolor === 'grayscale' ? 'grayscale' : null })); return;
      case 'transparency': patchPictures('Picture transparency', () => ({ transparency: arg.transparency > 0 ? arg.transparency : null })); return;
      case 'style': {
        const style = PICTURE_STYLES.find((s) => s.id === arg.style);
        if (style) patchPictures('Picture style', () => ({ ...style.patch }));
        return;
      }
      case 'reset': patchPictures('Reset picture', () => ({ ...RESET_PICTURE })); return;
      case 'resetSize': {
        const pictures = selectedPictures();
        const sizes = new Map(await Promise.all(pictures.map(async (o) => [o.id, placedSize(await naturalSize(o.src))])));
        patchPictures('Reset picture and size', (o) => resetPictureAndSize(sizes.get(o.id) || { w: o.w, h: o.h }));
        return;
      }
      case 'size': patchPictures('Size picture', (o) => sizePatch(o, { w: arg.w, h: arg.h })); return;
      case 'lockAspect': patchPictures('Lock aspect ratio', () => ({ lockAspect: arg.on ? null : false })); return;
      case 'uncrop': patchPictures('Remove crop', (o) => (o.srcRect || o.fillRect ? cropPatch({ ...o, fillRect: null }, { x: 0, y: 0, w: 1, h: 1 }) : null)); return;
      case 'cropAspect': patchPictures('Crop to aspect ratio', (o) => cropPatch(o, aspectCrop(o, arg.ratio))); return;
      case 'crop': {
        const obj = selectedPictures()[0];
        if (!obj) { toast('Select a picture to crop', { icon: 'info', duration: 2500 }); return; }
        if (protectedSheet()) return;
        if (obj.pictureRef) { toast('A linked picture shows its whole range: change the range in the formula bar instead', { icon: 'info', duration: 3500 }); return; }
        const id = sheetId();
        openCropDialog({ picture: obj, onApply: (crop) => { if (wb.chartById(id, obj.id)) wb.updateChart(id, obj.id, cropPatch(wb.chartById(id, obj.id), crop), 'Crop picture'); }, onClose: () => keepFocus() });
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
    const row = (label, value, min, max) => {
      const range = el('input', { type: 'range', min, max, step: 1, value: Math.round(value * 100), 'aria-label': label });
      const number = el('input.input.picture-correction-number', { type: 'number', min, max, step: 1, value: Math.round(value * 100), 'aria-label': `${label} (percent)` });
      range.addEventListener('input', () => { number.value = range.value; preview(); });
      number.addEventListener('input', () => { range.value = number.value; preview(); });
      return { range, number, node: el('label.picture-correction-row', {}, el('span.picture-correction-label', {}, label), range, number, el('span', {}, '%')) };
    };
    const brightness = row('Brightness', obj.adjust?.brightness || 0, -100, 100);
    const contrast = row('Contrast', obj.adjust?.contrast || 0, -100, 100);
    const transparency = row('Transparency', obj.transparency || 0, 0, 100);
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
    } }, 'Reset');
    const content = el('form', { onsubmit: (e) => {
      e.preventDefault();
      if (wb.chartById(id, obj.id)) wb.updateChart(id, obj.id, value(), 'Picture corrections');
      modal.close();
    } },
      el('div.picture-corrections-stage', {}, el('span.picture-checker', {}, stage)),
      el('div.picture-corrections', {}, brightness.node, contrast.node, transparency.node),
      el('div.row.row-end', {}, reset, el('span', { style: { flex: '1' } }),
        el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
        el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
    const modal = openModal({ title: 'Picture Corrections', content, initialFocus: brightness.range, onClose: () => keepFocus() });
  }

  /* ---------- Pictures of cells ---------- */

  /**
   * Paste Special ▸ Picture (`linked` false) or Linked Picture: a picture of the cells copied, at the
   * active cell. A linked one keeps showing what those cells hold.
   */
  function pastePicture({ linked = false, source } = {}) {
    const id = sheetId();
    if (!source || !wb.sheet(source.sheetId)) { toast('Copy a range of cells first, then paste it as a picture', { icon: 'info', duration: 3000 }); return null; }
    if (protectedSheet(id)) return null;
    const range = normalizeRange(source.range);
    const picture = rangePicture(wb, source.sheetId, range);
    if (!picture) { toast('That range is too large, or all hidden, to show as a picture', { icon: 'info', duration: 3000 }); return null; }
    const at = { ...ctx.active() };
    const ref = wb.refTextFor(source.sheetId, range);
    const objectId = wb.addChart(id, {
      type: 'image', src: svgDataUrl(picture.svg), title: linked ? `Linked picture of ${ref}` : `Picture of ${ref}`, anchor: at, dx: 0, dy: 0,
      w: Math.max(1, Math.round(picture.w)), h: Math.max(1, Math.round(picture.h)), border: false,
      ...(linked ? { pictureRef: ref } : {}),
    });
    if (!objectId) return null;
    ctx.grid.selectChart(objectId);
    ctx.announce?.(linked ? `Linked picture of ${ref} pasted. It follows the cells; its reference shows in the formula bar` : `Picture of ${ref} pasted`);
    return objectId;
  }

  /**
   * The formula bar's edit of a linked picture's reference: =Sheet1!$A$1:$C$5 names the cells it shows.
   * Returns a problem to show, or null when the picture now shows the cells named. An empty entry
   * unlinks the picture, leaving the picture it showed last.
   */
  function linkedPictureRef({ id: objectId, text }) {
    const id = sheetId(), obj = wb.chartById(id, objectId);
    if (obj?.type !== 'image') return 'Select a linked picture';
    if (wb.isProtected(id)) return `${wb.sheet(id)?.name || 'This sheet'} is protected`;
    const entry = String(text ?? '').trim().replace(/^=/, '').trim();
    if (!entry) {
      const target = obj.pictureRef && linkedPictureTarget(wb, id, obj.pictureRef);
      const last = target && rangePicture(wb, target.sheetId, target.range);
      wb.updateChart(id, obj.id, { pictureRef: null, ...(last ? { src: svgDataUrl(last.svg) } : {}) }, 'Unlink picture');
      return null;
    }
    const target = linkedPictureTarget(wb, id, entry);
    if (!target) return `${entry} is not a range the picture can show`;
    const picture = rangePicture(wb, target.sheetId, target.range);
    if (!picture) return 'That range is too large, or all hidden, to show as a picture';
    const ref = /^[A-Za-z_\\][\w.\\]*$/.test(entry) && wb.namedRef?.(entry) ? entry : wb.refTextFor(target.sheetId, target.range);
    // A new range brings its own shape: the picture takes the size of the cells it now shows.
    wb.updateChart(id, obj.id, { pictureRef: ref, src: svgDataUrl(picture.svg), w: Math.max(1, Math.round(picture.w)), h: Math.max(1, Math.round(picture.h)) }, 'Change linked picture');
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
