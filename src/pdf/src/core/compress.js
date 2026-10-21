/**
 * Reduce a PDF's size without changing what its pages show: oversized pictures are downsampled
 * to the resolution they are printed at and re-encoded as JPEG, uncompressed streams are
 * deflated, page thumbnails go, and objects nothing references any more are dropped. Edits leave
 * such leftovers behind because pdf-lib keeps every object it has parsed.
 *
 * Images are decoded by rendering a one-image PDF through PDF.js (the `codec.render` callback),
 * so every color space, filter, decode array, and mask a viewer understands comes out right.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFObjectCopier,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from 'pdf-lib';
import { savePdf } from './version.js';
import { inspectImages } from './image-edit.js';
import { IMAGE_ORIENTATION_KEY } from './image-orientation.js';
import { pageUserUnit, repairForm } from './structure.js';

export const COMPRESSION_LEVELS = {
  smallest: { dpi: 100, quality: 0.6, label: 'Smallest file', hint: 'Pictures at 100 dpi' },
  balanced: { dpi: 150, quality: 0.75, label: 'Balanced', hint: 'Pictures at 150 dpi' },
  quality: { dpi: 220, quality: 0.85, label: 'Higher quality', hint: 'Pictures at 220 dpi' },
};
/** Pictures smaller than this are not worth re-encoding. */
const MIN_PIXELS = 128 * 128;
const get = (dict, key) => dict?.lookup(PDFName.of(key));
const number = (dict, key) => get(dict, key)?.asNumber?.();
const names = (dict, key) => {
  const value = get(dict, key);
  const list =
    value instanceof PDFArray ? value.asArray().map((v) => dict.context.lookup(v)) : [value];
  return list.filter((v) => v instanceof PDFName).map((v) => v.decodeText());
};

/**
 * Every image stream reachable from a resources dictionary: images placed directly, images
 * inside Form XObjects, and images inside tiling patterns, following each once. The content
 * walk does not enter patterns, transparency masks, Type 3 glyphs, or annotation appearances.
 * Sizing their images by a smaller direct use elsewhere would wreck them.
 * With includeDirect=false, follow page forms but only collect these unmeasured image uses.
 */
function reachableImages(doc, resources, into, seen = new Map(), includeDirect = true) {
  const pending = [{ resources, includeDirect }];
  while (pending.length) {
    const { resources, includeDirect } = pending.pop();
    if (!(resources instanceof PDFDict)) continue;
    // A shared resource dictionary can first appear in a measured page form, then in a
    // pattern. Revisit it in the latter context to protect every image the pattern uses.
    const mode = includeDirect ? 2 : 1;
    const visited = seen.get(resources) || 0;
    if (visited & mode) continue;
    seen.set(resources, visited | mode);
    for (const key of ['XObject', 'Pattern']) {
      const dict = get(resources, key);
      if (!(dict instanceof PDFDict)) continue;
      for (const [, value] of dict.entries()) {
        const object = doc.context.lookup(value);
        if (!(object instanceof PDFStream)) continue;
        const subtype = get(object.dict, 'Subtype');
        if (subtype === PDFName.of('Image')) {
          if (includeDirect) into.add(object);
        } else {
          const nested = get(object.dict, 'Resources');
          pending.push({
            resources: nested,
            includeDirect: includeDirect || key === 'Pattern',
          });
          // PDF.js merges a tiling pattern's resources with its enclosing resources.
          // Without its own XObject category, it can paint the enclosing images at
          // sizes the content walk never measures. An explicit category shadows it.
          if (
            key === 'Pattern' &&
            (!(nested instanceof PDFDict) || !nested.has(PDFName.of('XObject')))
          )
            pending.push({ resources, includeDirect: true });
        }
      }
    }
    const states = get(resources, 'ExtGState');
    if (states instanceof PDFDict)
      for (const [, value] of states.entries()) {
        const state = doc.context.lookup(value);
        const mask = state instanceof PDFDict ? get(state, 'SMask') : null;
        const group = mask instanceof PDFDict ? get(mask, 'G') : null;
        if (group instanceof PDFStream) {
          const nested = get(group.dict, 'Resources');
          // A transparency group without its own resources uses the enclosing ones.
          // Its image placements are not measured by the page content walk.
          pending.push({
            resources: nested instanceof PDFDict ? nested : resources,
            includeDirect: true,
          });
        }
      }
    const fonts = get(resources, 'Font');
    if (fonts instanceof PDFDict)
      for (const [, value] of fonts.entries()) {
        const font = doc.context.lookup(value);
        if (!(font instanceof PDFDict) || get(font, 'Subtype') !== PDFName.of('Type3')) continue;
        pending.push({ resources: get(font, 'Resources') || resources, includeDirect: true });
      }
  }
  return into;
}
/** Every image an annotation draws through its appearance streams. */
function annotationImages(doc, page, into) {
  const annots = page.node.lookup(PDFName.of('Annots'));
  if (!(annots instanceof PDFArray)) return into;
  const seen = new Map();
  for (const ref of annots.asArray()) {
    const annot = doc.context.lookup(ref);
    const ap = annot instanceof PDFDict ? annot.lookup(PDFName.of('AP')) : null;
    if (!(ap instanceof PDFDict)) continue;
    for (const [, entry] of ap.entries()) {
      const value = doc.context.lookup(entry);
      const forms =
        value instanceof PDFStream
          ? [value]
          : value instanceof PDFDict
            ? [...value.entries()].map(([, v]) => doc.context.lookup(v))
            : [];
      for (const form of forms)
        if (form instanceof PDFStream)
          reachableImages(doc, get(form.dict, 'Resources'), into, seen);
    }
  }
  return into;
}
/**
 * Every painted image with the largest size it takes on any page, in points, and the resources
 * it was found under. Pages whose content could not be followed leave their images out, so an
 * image whose full use is unknown is never shrunk.
 */
function imageUsage(doc) {
  const usage = new Map();
  const unknown = new Set();
  for (let index = 0; index < doc.getPageCount(); index++) {
    const page = doc.getPage(index);
    const unmeasuredResources = new Set();
    const found = inspectImages(doc, index, { unmeasuredResources });
    // A partially inspected form can share an image with a smaller, measured placement.
    // Preserve all images reachable through the skipped branch, even ones in `found`.
    const seen = new Map();
    for (const resources of unmeasuredResources) reachableImages(doc, resources, unknown, seen);
    // Size pictures in physical points, including pages whose user-space unit is fractional.
    const unit = pageUserUnit(page);
    for (const entry of found) {
      // Resolution is measured along the encoded pixels, before intrinsic EXIF orientation.
      const m = entry.pixelTransform || entry.transform;
      const width = Math.hypot(m[0], m[1]) * unit,
        height = Math.hypot(m[2], m[3]) * unit;
      const seen = usage.get(entry.object) || { width: 0, height: 0, resources: entry.resources };
      seen.width = Math.max(seen.width, width);
      seen.height = Math.max(seen.height, height);
      usage.set(entry.object, seen);
    }
    // Images the page's resources name but the walk did not reach cannot be sized safely.
    const painted = new Set(found.map((entry) => entry.object));
    const xobjects = get(page.node.Resources(), 'XObject');
    if (xobjects instanceof PDFDict)
      for (const [, value] of xobjects.entries()) {
        const object = doc.context.lookup(value);
        if (
          object instanceof PDFStream &&
          get(object.dict, 'Subtype') === PDFName.of('Image') &&
          !painted.has(object)
        )
          unknown.add(object);
      }
    // Images drawn only through a tiling pattern or an annotation's appearance are not sized by
    // the content walk, so an image also used at a smaller size elsewhere is kept, not shrunk.
    reachableImages(doc, page.node.Resources(), unknown, new Map(), false);
    annotationImages(doc, page, unknown);
  }
  for (const object of unknown) usage.delete(object);
  return usage;
}

/** A PDF whose single page shows one image at exactly `width` by `height` points. */
async function imageDocument(doc, object, resources, width, height) {
  const preview = await PDFDocument.create();
  const copier = PDFObjectCopier.for(doc.context, preview.context);
  const page = preview.addPage([width, height]);
  const resource = preview.context.register(copier.copy(object));
  const colors = get(resources, 'ColorSpace');
  page.node.set(
    PDFName.of('Resources'),
    preview.context.obj({
      XObject: { Im: resource },
      ...(colors ? { ColorSpace: copier.copy(colors) } : {}),
    }),
  );
  page.node.set(
    PDFName.of('Contents'),
    preview.context.register(
      preview.context.flateStream(`q ${width} 0 0 ${height} 0 0 cm /Im Do Q`),
    ),
  );
  return preview.save();
}

const streamSize = (value) => (value instanceof PDFStream ? value.getContents().length : 0);

/**
 * A smaller replacement for one image, or null when it should stay: stencil masks, 1-bit
 * scans, tiny pictures, optional content, and pictures already small enough stay as they are.
 */
async function shrinkImage(doc, object, usage, { dpi, quality }, codec, signal) {
  const { dict } = object;
  const width = number(dict, 'Width'),
    height = number(dict, 'Height');
  if (!(width > 0 && height > 0) || width * height < MIN_PIXELS) return null;
  if (get(dict, 'ImageMask')?.asBoolean?.() || number(dict, 'BitsPerComponent') === 1) return null;
  if (get(dict, 'OC')) return null;
  const filters = names(dict, 'Filter');
  const lossy = filters.includes('DCTDecode') || filters.includes('JPXDecode');
  // Aim at the largest size the picture is shown at, never above its current size, and keep
  // the more demanding axis when placements stretch the picture.
  const scale = Math.min(
    1,
    Math.max(((usage.width / 72) * dpi) / width, ((usage.height / 72) * dpi) / height),
  );
  const downsample = scale < 1 / 1.15;
  if (!downsample && lossy) return null;
  const outWidth = downsample ? Math.max(1, Math.round(width * scale)) : width;
  const outHeight = downsample ? Math.max(1, Math.round(height * scale)) : height;
  const preview = await imageDocument(doc, object, usage.resources, outWidth, outHeight);
  signal?.throwIfAborted();
  const rendered = await codec.render(preview, outWidth, outHeight, { signal });
  signal?.throwIfAborted();
  const { data } = rendered;
  if (data.length !== outWidth * outHeight * 4) return null;
  let opaque = true;
  for (let i = 3; i < data.length; i += 4)
    if (data[i] !== 255) {
      opaque = false;
      break;
    }
  const color = new Uint8ClampedArray(data);
  for (let i = 3; i < color.length; i += 4) color[i] = 255;
  const jpeg = await codec.encodeJpeg(
    { data: color, width: outWidth, height: outHeight },
    quality,
    { signal },
  );
  signal?.throwIfAborted();
  let alpha = null;
  if (!opaque) {
    const samples = new Uint8Array(outWidth * outHeight);
    for (let k = 0; k < samples.length; k++) samples[k] = data[k * 4 + 3];
    alpha = doc.context.flateStream(samples, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: outWidth,
      Height: outHeight,
      ColorSpace: 'DeviceGray',
      BitsPerComponent: 8,
    });
  }
  const before =
    object.getContents().length + streamSize(get(dict, 'SMask')) + streamSize(get(dict, 'Mask'));
  const after = jpeg.length + (alpha ? alpha.getContents().length : 0);
  if (after >= before * 0.9) return null;
  const stream = doc.context.stream(jpeg, {
    Type: 'XObject',
    Subtype: 'Image',
    Width: outWidth,
    Height: outHeight,
    ColorSpace: 'DeviceRGB',
    BitsPerComponent: 8,
    Filter: 'DCTDecode',
  });
  for (const key of ['Interpolate', 'Intent', IMAGE_ORIENTATION_KEY])
    if (dict.has(PDFName.of(key))) stream.dict.set(PDFName.of(key), dict.get(PDFName.of(key)));
  if (alpha) stream.dict.set(PDFName.of('SMask'), doc.context.register(alpha));
  return stream;
}

/** Streams stored without any filter, except the ones the format wants readable as they are. */
function deflatable(stream) {
  const { dict } = stream;
  if (get(dict, 'Filter') || get(dict, 'DecodeParms')) return false;
  const type = get(dict, 'Type');
  if ([PDFName.of('Metadata'), PDFName.of('XRef'), PDFName.of('ObjStm')].includes(type))
    return false;
  return stream.getContents().length > 64;
}
function deflated(doc, stream) {
  const next = doc.context.flateStream(stream.getContents());
  for (const [key, value] of stream.dict.entries())
    if (![PDFName.of('Length'), PDFName.of('Filter'), PDFName.of('DecodeParms')].includes(key))
      next.dict.set(key, value);
  return next.getContents().length < stream.getContents().length ? next : null;
}

/** Drop every indirect object that nothing reachable from the trailer refers to. */
export function sweepUnreferenced(context) {
  const live = new Set();
  const pending = [];
  const roots = [
    context.trailerInfo.Root,
    context.trailerInfo.Info,
    context.trailerInfo.Encrypt,
    context.trailerInfo.ID,
    context.pushGraphicsStateContentStreamRef,
    context.popGraphicsStateContentStreamRef,
  ];
  for (const root of roots) if (root) pending.push(root);
  while (pending.length) {
    const value = pending.pop();
    if (value instanceof PDFRef) {
      if (live.has(value)) continue;
      live.add(value);
      const target = context.lookup(value);
      if (target) pending.push(target);
    } else if (value instanceof PDFStream) pending.push(value.dict);
    else if (value instanceof PDFDict) for (const [, entry] of value.entries()) pending.push(entry);
    else if (value instanceof PDFArray) for (const entry of value.asArray()) pending.push(entry);
  }
  let removed = 0;
  for (const [ref] of context.enumerateIndirectObjects())
    if (!live.has(ref)) {
      context.delete(ref);
      removed++;
    }
  return removed;
}

/**
 * Shrink `doc` in place. `codec.render(pdfBytes, width, height, { signal })` resolves to RGBA pixels of
 * the one-page PDF's page and `codec.encodeJpeg({ data, width, height }, quality, { signal })` to JPEG
 * bytes; without a codec only the lossless steps run. Resolves to what changed.
 */
export async function compressDocument(doc, { level = 'balanced', codec = null, signal } = {}) {
  signal?.throwIfAborted();
  const settings = COMPRESSION_LEVELS[level];
  if (!settings) throw new Error('Choose how much to reduce the file.');
  const { context } = doc;
  // A form that loops back on itself would overflow the stack when saved; break the loop.
  repairForm(doc);
  const stats = { images: 0, streams: 0, thumbnails: 0, removed: 0 };
  if (codec) {
    const refs = new Map(context.enumerateIndirectObjects().map(([ref, object]) => [object, ref]));
    // A mask can also be painted as an ordinary grayscale image elsewhere. Recompressing
    // that placement would replace the shared stream with RGB and invalidate its mask use.
    const masks = new Set();
    for (const object of refs.keys()) {
      if (!(object instanceof PDFStream) || get(object.dict, 'Subtype') !== PDFName.of('Image'))
        continue;
      for (const key of ['SMask', 'Mask']) {
        const mask = get(object.dict, key);
        if (mask instanceof PDFStream) masks.add(mask);
      }
    }
    for (const [object, usage] of imageUsage(doc)) {
      signal?.throwIfAborted();
      const ref = refs.get(object);
      if (!ref || !(object instanceof PDFRawStream) || masks.has(object)) continue;
      // A picture PDF.js cannot render stays as it is.
      const replacement = await shrinkImage(doc, object, usage, settings, codec, signal).catch(
        () => null,
      );
      signal?.throwIfAborted();
      if (replacement) {
        context.assign(ref, replacement);
        stats.images++;
      }
    }
  }
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream) || !deflatable(object)) continue;
    const next = deflated(doc, object);
    if (next) {
      context.assign(ref, next);
      stats.streams++;
    }
  }
  for (const page of doc.getPages())
    if (page.node.has(PDFName.of('Thumb'))) {
      page.node.delete(PDFName.of('Thumb'));
      stats.thumbnails++;
    }
  stats.removed = sweepUnreferenced(context);
  return stats;
}

/** Compress a PDF's bytes; the result reports the sizes before and after. */
export async function compressPdf(bytes, options = {}) {
  const { signal } = options;
  signal?.throwIfAborted();
  // Preserve the source timestamps until Info and XMP have been reconciled.
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const stats = await compressDocument(doc, options);
  signal?.throwIfAborted();
  const synchronized =
    doc.catalog.has(PDFName.of('Metadata')) &&
    (await import('./details.js')).synchronizeDocumentMetadata(doc);
  signal?.throwIfAborted();
  if (!synchronized) doc.setModificationDate(new Date());
  // A file that claims PDF/A keeps the file structure its part requires (no object streams
  // in PDF/A-1).
  let saveOptions;
  if (doc.catalog.has(PDFName.of('Metadata'))) {
    const { pdfaIdentification, pdfaSaveOptions } = await import('./pdfa.js');
    const claim = pdfaIdentification(doc);
    if (claim) saveOptions = pdfaSaveOptions(claim.part);
    signal?.throwIfAborted();
  }
  const next = await savePdf(doc, saveOptions);
  signal?.throwIfAborted();
  return { bytes: next, before: bytes.length, after: next.length, ...stats };
}
