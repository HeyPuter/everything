import { buildShape, buildTextShape, shapeParams, SHAPE_PRESETS, EMU_PER_INCH, DEFAULT_SHAPE_STYLE, LINE_PRESETS } from './authored-shapes.js';
import { decodeShape } from './canvas-shapes.js';
import { canResizeRetainedPicture } from './picture-resize.js';
import { validateImage, nextDrawingId } from './images.js';
import { carriedFrame } from './inserted-drawings.js';

/**
 * Inserting and editing preset shapes on a canvas editor. A shape is a drawing whose DrawingML this
 * module writes (see authored-shapes.js); every edit writes it again, previews it, then replaces the
 * drawing in one transaction, so undo restores the previous drawing exactly.
 */
let counter = 0;
const freshAssetId = model => { let id; do id = `drawing:canvas-shape-${++counter}`; while (model.assets[id]); return id; };
const images = model => model.paragraphs.flatMap(p => p.runs.filter(r => r.image).map(r => r.image));
const nextImageId = model => nextDrawingId(model.paragraphs);
const nextOrder = model => Math.max(0, ...images(model).map(image => image.anchor?.order || 0)) + 1;

async function prepare(editor, params) {
  const pkg = editor.shapePackage?.();
  const { image, asset, readers } = params.text !== undefined ? await buildTextShape(params, pkg?.parts) : buildShape(params);
  // A document created in this session has no drawing-text readers until it is first saved and reopened;
  // the package that read this text box reads its text the same way, with the same styles.
  if (readers && pkg && !pkg.readDrawingTextBox) Object.assign(pkg, readers);
  const bitmap = await decodeShape(asset, new Map(), editor.model.styles.fontAlternatives, () => {});
  return { image, asset, bitmap };
}
function register(editor, assetId, asset, bitmap) { editor.model.assets[assetId] = asset; editor.images.set(assetId, bitmap); }
function unregister(editor, assetId, bitmap) { delete editor.model.assets[assetId]; editor.images.delete(assetId); bitmap.close?.(); }

/** Insert → Shapes: a default-sized shape in front of the text, anchored to the caret's paragraph. */
export async function insertShape(editor, preset) {
  const entry = SHAPE_PRESETS.find(([p]) => p === preset);
  if (!entry) throw new Error('Choose a shape.');
  if (editor.readOnly) return false;
  editor.finishComposition();
  if (editor.session.path !== null) throw new Error('Shapes can be inserted in the document body. Leave the header or footer first.');
  const model = editor.model, revision = editor.session.revision, selection = { ...model.selection };
  const id = nextImageId(model), assetId = freshAssetId(model), line = LINE_PRESETS.has(preset);
  const params = { id, name: `${entry[1]} ${id}`, preset, width: Math.round(entry[3] * EMU_PER_INCH), height: Math.round(entry[4] * EMU_PER_INCH),
    fill: line ? null : DEFAULT_SHAPE_STYLE.fill, line: line ? DEFAULT_SHAPE_STYLE.fill : DEFAULT_SHAPE_STYLE.line, lineWidth: DEFAULT_SHAPE_STYLE.lineWidth,
    anchor: { horizontal: 'column', vertical: 'paragraph', x: 0, y: 0, wrap: 'none', behind: false, order: nextOrder(model) }, assetId };
  const { image, asset, bitmap } = await prepare(editor, params);
  if (editor.destroyed || revision !== editor.session.revision || selection.anchor !== editor.model.selection.anchor || selection.focus !== editor.model.selection.focus) {
    bitmap.close?.(); throw new Error('The document changed while the shape was prepared. Insert it again.');
  }
  register(editor, assetId, asset, bitmap);
  const { assetId: _asset, id: _id, ...properties } = image;
  const ok = editor.execute(() => editor.model.insertImage(assetId, properties));
  if (!ok) unregister(editor, assetId, bitmap);
  editor.focus(); editor.onSelection?.();
  return ok;
}

/** Insert → Text Box: a 2 × 1 in box with a thin outline, floating in front of the text, holding one paragraph. */
export async function insertTextBox(editor, text = 'Type your text here.') {
  if (editor.readOnly) return false;
  editor.finishComposition();
  if (editor.session.path !== null) throw new Error('Text boxes can be inserted in the document body. Leave the header or footer first.');
  const model = editor.model, revision = editor.session.revision, selection = { ...model.selection };
  const id = nextImageId(model), assetId = freshAssetId(model);
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const params = { id, name: `Text Box ${id}`, preset: 'rect', width: 2 * EMU_PER_INCH, height: EMU_PER_INCH, fill: 'FFFFFF', line: '000000', lineWidth: 6350,
    anchor: { horizontal: 'column', vertical: 'paragraph', x: 0, y: 0, wrap: 'none', behind: false, order: nextOrder(model) }, assetId,
    text: `<w:p><w:r><w:t xml:space="preserve">${escaped}</w:t></w:r></w:p>` };
  const { image, asset, bitmap } = await prepare(editor, params);
  if (editor.destroyed || revision !== editor.session.revision || selection.anchor !== editor.model.selection.anchor || selection.focus !== editor.model.selection.focus) {
    bitmap.close?.(); throw new Error('The document changed while the text box was prepared. Insert it again.');
  }
  register(editor, assetId, asset, bitmap);
  const { assetId: _asset, id: _id, ...properties } = image;
  const ok = editor.execute(() => editor.model.insertImage(assetId, properties));
  if (!ok) unregister(editor, assetId, bitmap);
  editor.focus(); editor.onSelection?.();
  return ok;
}

/** The selected drawing's shape parameters when it is a simple preset shape this editor can rewrite. */
export function selectedShape(editor) {
  const image = editor?.model.selectedImage;
  const params = image && !editor.readOnly ? shapeParams(image) : null;
  return params ? { image, params } : null;
}

/** Rewrite the selected shape with new fill, outline, size or position. patch: { fill, line, lineWidth, width, height, anchor }. */
export async function updateShape(editor, patch) {
  const selected = selectedShape(editor);
  if (!selected) throw new Error('Select a shape to format it.');
  const { image, params } = selected, model = editor.model, revision = editor.session.revision;
  const width = patch.width ?? image.width, height = patch.height ?? image.height, line = LINE_PRESETS.has(params.preset);
  // A line may be straight along either axis (one side 0), or slanted.
  if (!(line ? width >= 0 && height >= 0 && width + height > 0 : width > 0 && height > 0) || width > 22 * EMU_PER_INCH || height > 22 * EMU_PER_INCH) throw new Error('Shape sizes must be greater than 0 and at most 22 inches.');
  // An axis the edit places at an offset no longer follows the alignment or percentage it had.
  const moved = new Set(['x', 'y'].filter(axis => patch.anchor?.[axis] !== undefined));
  const anchor = image.anchor ? { ...image.anchor, ...(patch.anchor || {}) } : undefined;
  if (anchor) for (const axis of moved) { delete anchor[`${axis}Align`]; delete anchor[`${axis}Percentage`]; }
  const next = { ...params, ...Object.fromEntries(['fill', 'line', 'lineWidth'].filter(key => key in patch).map(key => [key, patch[key]])),
    id: image.id, name: image.name, width: Math.round(width), height: Math.round(height), anchor, assetId: freshAssetId(model) };
  const { image: built, asset, bitmap } = await prepare(editor, next);
  if (editor.destroyed || revision !== editor.session.revision || editor.model.selectedImage !== image) { bitmap.close?.(); throw new Error('The shape changed before the edit could be applied. Try again.'); }
  register(editor, next.assetId, asset, bitmap);
  // The drawing keeps everything about it but its shape: alt text, title, flags and alignment, in the model and in its XML.
  const replacement = { ...image, assetId: built.assetId, width: built.width, height: built.height, ...(built.flatLine ? { flatLine: built.flatLine } : {}),
    ...(anchor ? { anchor } : {}), shell: carriedFrame(image.shell, built.shell, moved) };
  const ok = editor.execute(() => {
    const model = editor.model;
    model.checkpoint();
    for (const p of model.paragraphs) for (const run of p.runs) if (run.image === image) run.image = replacement;
    model.didChange();
    return true;
  });
  if (!ok) unregister(editor, next.assetId, bitmap);
  editor.focus(); editor.onSelection?.();
  return ok;
}

/** Let the image frame resize simple shapes by rewriting them, as pictures resize. */
export function attachShapeEditing(editor, onError = error => editor.onError(error), shapePackage = () => null) {
  editor.shapePackage = shapePackage;
  // Painting asks for every visible drawing; parse each drawing's XML once.
  const known = new WeakMap();
  const editable = image => { if (!image?.retainedDrawing) return false; if (!known.has(image)) known.set(image, !!shapeParams(image)); return known.get(image); };
  editor.drawingEditor = {
    canResize: editable,
    resize: patch => updateShape(editor, patch).catch(onError),
  };
  const pictures = new WeakMap();
  editor.pictureEditor = {
    canResize(image) {
      if(!image?.retainedDrawing || !shapePackage()?.resizeDrawingPicture)return false;
      if(!pictures.has(image))pictures.set(image,canResizeRetainedPicture(image));
      return pictures.get(image);
    },
    resize: (patch,{signal}={}) => resizeRetainedPicture(editor,patch,signal).catch(error=>{onError(error);return false;}),
  };
}

async function resizeRetainedPicture(editor,patch,signal) {
  const image=editor.model.selectedImage,pkg=editor.shapePackage?.();
  if(editor.readOnly || !editor.pictureEditor?.canResize(image))throw new Error('Select an editable standalone picture.');
  if(Object.keys(patch).some(k=>!['width','height','anchor'].includes(k)))throw new Error('Unknown picture resize property.');
  if((patch.width??image.width)===image.width && (patch.height??image.height)===image.height && !patch.anchor)return false;
  const model=editor.model,revision=editor.session.revision;
  const sourcePart=model.paragraphs.find(p=>p.runs.some(r=>r.image===image))?.pageStory || 'word/document.xml';
  const rebuilt=pkg.resizeDrawingPicture(image,patch.width??image.width,patch.height??image.height,sourcePart);
  const next={...rebuilt.image,assetId:freshAssetId(model)};
  if(patch.anchor){
    if(!image.anchor || Object.keys(patch.anchor).some(k=>!['x','y'].includes(k)))throw new Error('Unknown picture resize position.');
    next.anchor={...image.anchor,...patch.anchor};
    for(const axis of Object.keys(patch.anchor)){
      if(!Number.isInteger(patch.anchor[axis]) || Math.abs(patch.anchor[axis])>22*EMU_PER_INCH)throw new Error('Picture position must be within 22 inches.');
      delete next.anchor[axis+'Align'];delete next.anchor[axis+'Percentage'];
    }
    next.anchorChanged=true;
  }
  validateImage(next);
  const pixels=b=>b.rasterPixelCount ?? (b.bitmap?.width ?? b.width)*(b.bitmap?.height ?? b.height);
  const usedPixels=()=>[...new Set(editor.images.values())].reduce((sum,b)=>sum+pixels(b),0);
  const limit=64000000;
  const bitmap=await decodeShape(rebuilt.asset,editor.images,model.styles.fontAlternatives,(previous,current)=>{
    if(usedPixels()+pixels(current)-pixels(previous)>limit)throw new Error('This editing session supports up to 64 megapixels of image previews.');
  });
  if(signal?.aborted){bitmap.close?.();return false;}
  if(usedPixels()+pixels(bitmap)>limit){bitmap.close?.();throw new Error('This editing session supports up to 64 megapixels of image previews.');}
  if(editor.destroyed || model!==editor.model || revision!==editor.session.revision || editor.model.selectedImage!==image){bitmap.close?.();throw new Error('The picture changed before resizing finished. Try again.');}
  register(editor,next.assetId,rebuilt.asset,bitmap);
  const ok=editor.execute(()=>{
    model.checkpoint();
    for(const p of model.paragraphs)for(const run of p.runs)if(run.image===image)run.image=next;
    model.didChange();return true;
  });
  if(!ok)unregister(editor,next.assetId,bitmap);
  editor.focus();editor.onSelection?.();return ok;
}
