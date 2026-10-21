import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFObjectCopier,
  PDFRawStream,
  PDFStream,
  decodePDFRawStream,
} from 'pdf-lib';
import { retainCryptFilter, withoutCryptFilter } from './stream-filters.js';
import { inverse } from './image-edit.js';

/**
 * Pixel-level redaction of image XObjects and inline images. The image is decoded to its own
 * samples (in its own color space, bit depth, and Decode array), the samples under each area are
 * overwritten, and the result is stored losslessly with Flate, so pixels outside the areas keep
 * their exact values. JPEGs are decoded with PDF.js's pure-JS decoder; filters without a
 * decoder here (JBIG2, CCITT, JPX) can go through an optional PDF.js-rendering codec, and
 * otherwise the caller removes the whole placement.
 */

const get = (dict, key) => dict?.lookup(PDFName.of(key));
const MAX_SAMPLES = 64 * 1024 * 1024;
// Inline images abbreviate their keys and values (PDF 32000, tables 92 and 93).
const INLINE_KEYS = {
  BPC: 'BitsPerComponent',
  CS: 'ColorSpace',
  D: 'Decode',
  DP: 'DecodeParms',
  F: 'Filter',
  H: 'Height',
  IM: 'ImageMask',
  I: 'Interpolate',
  W: 'Width',
  L: 'Length',
};
const INLINE_VALUES = {
  G: 'DeviceGray',
  RGB: 'DeviceRGB',
  CMYK: 'DeviceCMYK',
  I: 'Indexed',
  AHx: 'ASCIIHexDecode',
  A85: 'ASCII85Decode',
  LZW: 'LZWDecode',
  Fl: 'FlateDecode',
  RL: 'RunLengthDecode',
  CCF: 'CCITTFaxDecode',
  DCT: 'DCTDecode',
};
export const expandInlineKey = (key) => INLINE_KEYS[key] || key;
export const expandInlineValue = (value) => INLINE_VALUES[value] || value;

const filterList = (dict) => {
  const value = get(dict, 'Filter');
  const list =
    value instanceof PDFArray ? value.asArray().map((v) => dict.context.lookup(v)) : [value];
  return list.filter((v) => v instanceof PDFName).map((v) => v.decodeText());
};
const parmsList = (dict, count) => {
  const value = get(dict, 'DecodeParms');
  if (value instanceof PDFArray)
    return Array.from({ length: count }, (_, i) => {
      const item = value.lookup(i);
      return item instanceof PDFDict ? item : null;
    });
  return Array.from({ length: count }, (_, i) =>
    i === 0 && value instanceof PDFDict ? value : null,
  );
};
const IMAGE_FILTERS = new Set(['DCTDecode', 'JPXDecode', 'JBIG2Decode', 'CCITTFaxDecode']);

/** Undo PNG and TIFF predictors, which pdf-lib's Flate and LZW decoders leave in place. */
export function unpredict(bytes, parms) {
  const predictor = get(parms, 'Predictor')?.asNumber?.() ?? 1;
  if (predictor < 2) return bytes;
  const colors = get(parms, 'Colors')?.asNumber?.() ?? 1;
  const bpc = get(parms, 'BitsPerComponent')?.asNumber?.() ?? 8;
  const columns = get(parms, 'Columns')?.asNumber?.() ?? 1;
  const pixelBytes = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);
  if (predictor === 2) {
    if (bpc !== 8) throw new Error('Unsupported TIFF predictor depth');
    const out = new Uint8Array(bytes);
    for (let row = 0; row + rowBytes <= out.length; row += rowBytes)
      for (let i = pixelBytes; i < rowBytes; i++)
        out[row + i] = (out[row + i] + out[row + i - pixelBytes]) & 255;
    return out;
  }
  const rows = Math.floor(bytes.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  let previous = new Uint8Array(rowBytes);
  for (let r = 0; r < rows; r++) {
    const type = bytes[r * (rowBytes + 1)];
    const line = bytes.subarray(r * (rowBytes + 1) + 1, (r + 1) * (rowBytes + 1));
    const current = out.subarray(r * rowBytes, (r + 1) * rowBytes);
    for (let i = 0; i < rowBytes; i++) {
      const left = i >= pixelBytes ? current[i - pixelBytes] : 0;
      const up = previous[i];
      const corner = i >= pixelBytes ? previous[i - pixelBytes] : 0;
      let value = line[i];
      if (type === 1) value += left;
      else if (type === 2) value += up;
      else if (type === 3) value += (left + up) >> 1;
      else if (type === 4) {
        const p = left + up - corner,
          pa = Math.abs(p - left),
          pb = Math.abs(p - up),
          pc = Math.abs(p - corner);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      } else if (type !== 0) throw new Error('Unknown PNG predictor');
      current[i] = value & 255;
    }
    previous = current;
  }
  return out;
}

/** Run the general-purpose filters; returns the remaining image filter, if any, and its bytes. */
function generalDecode(stream) {
  const dict = withoutCryptFilter(stream.dict);
  const filters = filterList(dict);
  const parms = parmsList(dict, filters.length);
  let bytes = stream.getContents();
  let imageFilter = null;
  for (let i = 0; i < filters.length; i++) {
    const name = filters[i];
    if (IMAGE_FILTERS.has(name)) {
      if (i !== filters.length - 1) throw new Error('Image filter is not last');
      imageFilter = { name, parms: parms[i] };
      break;
    }
    const single = dict.context.obj({ Filter: name });
    if (parms[i]) single.set(PDFName.of('DecodeParms'), parms[i]);
    bytes = decodePDFRawStream(PDFRawStream.of(single, bytes)).decode();
    bytes = unpredict(bytes, parms[i]);
  }
  return { bytes, imageFilter };
}

let jpegModule;
async function decodeJpeg(bytes, parms) {
  jpegModule ??= import('pdfjs-dist/image_decoders/pdf.image_decoders.mjs');
  const { JpegImage } = await jpegModule;
  const start = bytes.findIndex((b, i) => b === 0xff && bytes[i + 1] === 0xd8);
  const colorTransform = get(parms, 'ColorTransform')?.asNumber?.();
  const jpeg = new JpegImage({
    colorTransform: Number.isInteger(colorTransform) ? colorTransform : undefined,
  });
  jpeg.parse(start > 0 ? bytes.subarray(start) : bytes);
  const data = jpeg.getData({ width: jpeg.width, height: jpeg.height });
  return {
    bytes: new Uint8Array(data.buffer, data.byteOffset, data.length),
    components: jpeg.numComponents,
    width: jpeg.width,
    height: jpeg.height,
  };
}

/** Color space family, component count, and default decode ranges for an image. */
export function describeColorSpace(value, resources, depth = 0) {
  const context = resources?.context;
  if (depth > 8) return null;
  if (value instanceof PDFName) {
    const name = expandInlineValue(value.decodeText());
    if (['DeviceGray', 'CalGray'].includes(name)) return { family: 'gray', n: 1 };
    if (['DeviceRGB', 'CalRGB'].includes(name)) return { family: 'rgb', n: 3 };
    if (name === 'DeviceCMYK') return { family: 'cmyk', n: 4 };
    const named = get(get(resources, 'ColorSpace'), name);
    return named ? describeColorSpace(named, resources, depth + 1) : null;
  }
  if (!(value instanceof PDFArray) || !value.size()) return null;
  const family = value.lookup(0)?.decodeText?.();
  const lookup = (i) => value.lookup(i);
  switch (expandInlineValue(family || '')) {
    case 'CalGray':
      return { family: 'gray', n: 1 };
    case 'CalRGB':
      return { family: 'rgb', n: 3 };
    case 'Lab': {
      const range = get(lookup(1), 'Range')
        ?.asArray?.()
        .map((n) => context.lookup(n).asNumber()) || [-100, 100, -100, 100];
      return { family: 'lab', n: 3, decode: [0, 100, ...range] };
    }
    case 'ICCBased': {
      const stream = lookup(1);
      const n = get(stream?.dict, 'N')?.asNumber?.();
      const alternate = get(stream?.dict, 'Alternate');
      if (alternate) {
        const described = describeColorSpace(alternate, resources, depth + 1);
        if (described?.n === n) return described;
      }
      return n === 1
        ? { family: 'gray', n }
        : n === 3
          ? { family: 'rgb', n }
          : n === 4
            ? { family: 'cmyk', n }
            : null;
    }
    case 'Indexed': {
      const base = describeColorSpace(lookup(1), resources, depth + 1);
      const hival = lookup(2)?.asNumber?.();
      const table = lookup(3);
      if (!base || !Number.isInteger(hival)) return null;
      let palette;
      if (table instanceof PDFStream) palette = generalDecode(table).bytes;
      else if (table?.asBytes) palette = table.asBytes();
      else if (table?.decodeText)
        palette = Uint8Array.from(table.asString?.() ?? '', (c) => c.charCodeAt(0));
      return { family: 'indexed', n: 1, base, hival, palette };
    }
    case 'Separation':
      return { family: 'tint', n: 1 };
    case 'DeviceN': {
      const names = lookup(1);
      return names instanceof PDFArray ? { family: 'tint', n: names.size() } : null;
    }
    case 'DeviceGray':
    case 'DeviceRGB':
    case 'DeviceCMYK':
      return describeColorSpace(lookup(0), resources, depth + 1);
    default:
      return null;
  }
}

const gray = ([r, g, b]) => 0.3 * r + 0.59 * g + 0.11 * b;
function toFamily(rgb, space) {
  switch (space.family) {
    case 'gray':
      return [gray(rgb)];
    case 'rgb':
      return rgb;
    case 'cmyk': {
      const k = 1 - Math.max(...rgb);
      return k >= 1 ? [0, 0, 0, 1] : [...rgb.map((c) => (1 - c - k) / (1 - k)), k];
    }
    case 'lab':
      return [gray(rgb) * 100, 0, 0];
    case 'tint':
      return Array(space.n).fill(1 - gray(rgb));
    default:
      return Array(space.n).fill(0);
  }
}
/** The palette index whose colour is closest to `rgb`. */
function nearestIndex(rgb, space) {
  const { base, hival, palette } = space;
  if (!palette) return 0;
  let best = 0,
    distance = Infinity;
  for (let i = 0; i <= hival; i++) {
    const entry = Array.from({ length: base.n }, (_, k) => (palette[i * base.n + k] ?? 0) / 255);
    const color =
      base.family === 'rgb'
        ? entry
        : base.family === 'gray'
          ? [entry[0], entry[0], entry[0]]
          : base.family === 'cmyk'
            ? entry.slice(0, 3).map((c) => (1 - c) * (1 - entry[3]))
            : null;
    if (!color) return 0;
    const d = color.reduce((sum, c, k) => sum + (c - rgb[k]) ** 2, 0);
    if (d < distance) [best, distance] = [i, d];
  }
  return best;
}

/**
 * Raw sample values that decode to `components` under the image's Decode array, so the
 * renderer paints the intended value whatever the encoding.
 */
function rawSamples(components, decode, bpc) {
  const max = 2 ** bpc - 1;
  return components.map((value, k) => {
    const low = decode[k * 2],
      high = decode[k * 2 + 1];
    const fraction = high === low ? 0 : (value - low) / (high - low);
    return Math.round(Math.max(0, Math.min(1, fraction)) * max);
  });
}

/**
 * For each pixel row, the column range whose pixel squares overlap an area. Areas map into the
 * image's unit square through the inverse of its placement matrix; pixel rows run top-down.
 */
export function pixelSpans(ctm, width, height, areas) {
  let back;
  try {
    back = inverse(ctm);
  } catch {
    return [];
  }
  const spans = [];
  for (const [x1, y1, x2, y2] of areas) {
    const polygon = [
      [x1, y1],
      [x2, y1],
      [x2, y2],
      [x1, y2],
    ].map(([x, y]) => {
      const u = back[0] * x + back[2] * y + back[4],
        v = back[1] * x + back[3] * y + back[5];
      return [u * width, (1 - v) * height];
    });
    // Rounding must not reach a neighbouring pixel the area only touches.
    const eps = 1e-6;
    const ys = polygon.map((p) => p[1]);
    const top = Math.max(0, Math.floor(Math.min(...ys) + eps)),
      bottom = Math.min(height, Math.ceil(Math.max(...ys) - eps));
    for (let row = top; row < bottom; row++) {
      const strip = clipStrip(polygon, row, row + 1);
      if (strip.length < 3) continue;
      const stripYs = strip.map((p) => p[1]);
      if (Math.max(...stripYs) - Math.min(...stripYs) <= eps) continue;
      const xs = strip.map((p) => p[0]);
      const from = Math.max(0, Math.floor(Math.min(...xs) + eps)),
        to = Math.min(width, Math.ceil(Math.max(...xs) - eps));
      if (to > from) spans.push([row, from, to]);
    }
  }
  return spans;
}
/** Sutherland–Hodgman clip of a convex polygon to a horizontal strip. */
function clipStrip(polygon, low, high) {
  const clip = (points, inside, cross) => {
    const out = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i],
        b = points[(i + 1) % points.length];
      if (inside(a)) out.push(a);
      if (inside(a) !== inside(b)) out.push(cross(a, b));
    }
    return out;
  };
  const at = (a, b, y) => [a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]), y];
  const above = clip(
    polygon,
    (p) => p[1] >= low,
    (a, b) => at(a, b, low),
  );
  return clip(
    above,
    (p) => p[1] <= high,
    (a, b) => at(a, b, high),
  );
}

function writeSample(bytes, rowBytes, bpc, n, row, column, component, value) {
  const bit = (column * n + component) * bpc;
  const offset = row * rowBytes;
  if (bpc === 8) bytes[offset + bit / 8] = value;
  else if (bpc === 16) {
    bytes[offset + bit / 8] = value >> 8;
    bytes[offset + bit / 8 + 1] = value & 255;
  } else {
    const index = offset + (bit >> 3),
      shift = 8 - bpc - (bit & 7),
      mask = ((1 << bpc) - 1) << shift;
    bytes[index] = (bytes[index] & ~mask) | ((value << shift) & mask);
  }
}

/** Overwrite the spans' samples with fixed raw values; returns how many pixels changed. */
function paint(bytes, { width, bpc, n }, spans, raw) {
  const rowBytes = Math.ceil((width * n * bpc) / 8);
  let count = 0;
  for (const [row, from, to] of spans)
    for (let column = from; column < to; column++) {
      for (let k = 0; k < n; k++) writeSample(bytes, rowBytes, bpc, n, row, column, k, raw[k]);
      count++;
    }
  return count;
}

const numbersOf = (array) => array?.asArray?.().map((_, i) => array.lookup(i)?.asNumber?.());

/** A new image dictionary for unfiltered samples, without data that describes the original. */
function plainDict(context, dict, overrides = {}) {
  const copy = dict.clone(context);
  for (const key of [
    'Filter',
    'DecodeParms',
    'Length',
    'Metadata',
    'PieceInfo',
    'Alternates',
    'OPI',
    'ID',
    'Name',
  ])
    copy.delete(PDFName.of(key));
  for (const [key, value] of Object.entries(overrides))
    if (value === undefined) copy.delete(PDFName.of(key));
    else copy.set(PDFName.of(key), value);
  return copy;
}

/**
 * Decode an image's samples. `dict` holds full key names (inline images are expanded first).
 * Returns null when no decoder here applies.
 */
async function samples(stream, dict, resources) {
  const width = get(dict, 'Width')?.asNumber?.(),
    height = get(dict, 'Height')?.asNumber?.();
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0))
    return null;
  const mask = get(dict, 'ImageMask')?.asBoolean?.() === true;
  const { bytes, imageFilter } = generalDecode(stream);
  let bpc = mask ? 1 : get(dict, 'BitsPerComponent')?.asNumber?.();
  let space = mask
    ? { family: 'mask', n: 1 }
    : describeColorSpace(get(dict, 'ColorSpace'), resources);
  let data = bytes;
  if (imageFilter?.name === 'DCTDecode') {
    const jpeg = await decodeJpeg(bytes, imageFilter.parms);
    if (jpeg.width !== width || jpeg.height !== height) return null;
    data = jpeg.bytes;
    bpc = 8;
    if (!space || space.n !== jpeg.components) {
      // A JPEG without a matching declared space is painted in its own component layout.
      if (space) return null;
      space = toSpace(jpeg.components);
    }
  } else if (imageFilter) return null;
  if (!space || ![1, 2, 4, 8, 16].includes(bpc)) return null;
  if (width * height * space.n > MAX_SAMPLES) return null;
  const rowBytes = Math.ceil((width * space.n * bpc) / 8);
  if (data.length < rowBytes * height) {
    // Truncated data reads as zero samples in viewers; pad so the whole raster is defined.
    const padded = new Uint8Array(rowBytes * height);
    padded.set(data);
    data = padded;
  } else data = new Uint8Array(data.subarray(0, rowBytes * height));
  return { data, width, height, bpc, space, dct: imageFilter?.name === 'DCTDecode' };
}
const toSpace = (n) =>
  n === 1
    ? { family: 'gray', n }
    : n === 3
      ? { family: 'rgb', n }
      : n === 4
        ? { family: 'cmyk', n }
        : null;

function defaultDecode(space, bpc) {
  if (space.family === 'indexed') return [0, 2 ** bpc - 1];
  if (space.family === 'lab') return space.decode;
  return Array.from({ length: space.n * 2 }, (_, i) => i % 2);
}

/**
 * Sample values meaning `rgb` for this image. `role` is 'color' for ordinary images, 'opaque'
 * for soft masks (fully opaque), and 'unpainted'/'painted' for stencil and explicit masks.
 */
function fillSamples(image, dict, rgb, role) {
  const decode = numbersOf(get(dict, 'Decode'))?.every(Number.isFinite)
    ? numbersOf(get(dict, 'Decode'))
    : defaultDecode(image.space, image.bpc);
  if (image.space.family === 'mask') return rawSamples([role === 'painted' ? 0 : 1], decode, 1);
  if (role === 'opaque') return rawSamples(Array(image.space.n).fill(1), decode, image.bpc);
  if (image.space.family === 'indexed') {
    const index = nearestIndex(rgb, image.space);
    return rawSamples([index], decode, image.bpc);
  }
  return rawSamples(toFamily(rgb, image.space), decode, image.bpc);
}

/** Redact one decoded image's samples and store them as a new Flate stream (not registered). */
function storeRedacted(context, source, dict, image, spans, raw, overrides = {}) {
  const changed = paint(
    image.data,
    { width: image.width, bpc: image.bpc, n: image.space.n },
    spans,
    raw,
  );
  if (!changed) return null;
  const next = context.flateStream(image.data);
  const copy = plainDict(context, dict, {
    ...(image.dct ? { BitsPerComponent: PDFNumber.of(8) } : {}),
    ...overrides,
  });
  for (const [key, value] of copy.entries())
    if (key !== PDFName.of('Length') && key !== PDFName.of('Filter')) next.dict.set(key, value);
  if (source instanceof PDFStream) retainCryptFilter(next.dict, [source.dict]);
  return { stream: next, pixels: changed };
}

/** A one-page PDF that shows the image at its pixel size, for rendering through PDF.js. */
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

/** Render through the caller's codec (PDF.js on a canvas) when no decoder here applies. */
async function redactRendered(doc, stream, resources, ctm, areas, rgb, codec) {
  const dict = stream.dict;
  const width = get(dict, 'Width')?.asNumber?.(),
    height = get(dict, 'Height')?.asNumber?.();
  if (!(width > 0 && height > 0) || width * height > MAX_SAMPLES / 4) return null;
  const pdf = await imageDocument(doc, stream, resources, width, height);
  const { data } = await codec.render(pdf, width, height);
  if (data?.length !== width * height * 4) return null;
  const spans = pixelSpans(ctm, width, height, areas);
  if (!spans.length) return { unchanged: true };
  const stencil = get(dict, 'ImageMask')?.asBoolean?.() === true;
  const context = doc.context;
  if (stencil) {
    // A stencil keeps painting in the current fill colour; rebuild it from the coverage.
    const rowBytes = Math.ceil(width / 8);
    const bits = new Uint8Array(rowBytes * height).fill(255);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        if (data[(y * width + x) * 4 + 3] >= 128)
          bits[y * rowBytes + (x >> 3)] &= ~(0x80 >> (x & 7));
    const image = { data: bits, width, height, bpc: 1, space: { family: 'mask', n: 1 } };
    const out = storeRedacted(
      context,
      stream,
      context.obj({
        Type: 'XObject',
        Subtype: 'Image',
        Width: width,
        Height: height,
        ImageMask: true,
      }),
      image,
      spans,
      [1],
    );
    return out ? { stream: out.stream } : { unchanged: true };
  }
  const rgbData = new Uint8Array(width * height * 3),
    alpha = new Uint8Array(width * height);
  let opaque = true;
  for (let i = 0; i < width * height; i++) {
    rgbData.set(data.subarray(i * 4, i * 4 + 3), i * 3);
    alpha[i] = data[i * 4 + 3];
    if (alpha[i] !== 255) opaque = false;
  }
  const color = { data: rgbData, width, height, bpc: 8, space: { family: 'rgb', n: 3 } };
  const raw = rgb.map((c) => Math.round(c * 255));
  paint(color.data, { width, bpc: 8, n: 3 }, spans, raw);
  const base = context.obj({
    Type: 'XObject',
    Subtype: 'Image',
    Width: width,
    Height: height,
    ColorSpace: 'DeviceRGB',
    BitsPerComponent: 8,
  });
  for (const key of ['Interpolate', 'Intent'])
    if (dict.has(PDFName.of(key))) base.set(PDFName.of(key), dict.get(PDFName.of(key)));
  const next = context.flateStream(color.data);
  for (const [key, value] of base.entries()) next.dict.set(key, value);
  retainCryptFilter(next.dict, [dict]);
  if (!opaque) {
    paint(alpha, { width, bpc: 8, n: 1 }, spans, [255]);
    const mask = context.flateStream(alpha, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: width,
      Height: height,
      ColorSpace: 'DeviceGray',
      BitsPerComponent: 8,
    });
    next.dict.set(PDFName.of('SMask'), context.register(mask));
  }
  return { stream: next };
}

/**
 * Redact an image XObject placed by `ctm` (its unit square in page space). Resolves to
 * `{ stream }` with a new, unregistered image stream; `{ unchanged: true }` when no pixel lies
 * under an area; or null when the image cannot be decoded and must be removed instead.
 */
export async function redactImageXObject(doc, stream, resources, ctm, areas, rgb, { codec } = {}) {
  const context = doc.context;
  let image;
  try {
    image = await samples(stream, stream.dict, resources);
  } catch {
    image = null;
  }
  if (!image) {
    if (!codec?.render) return null;
    try {
      return await redactRendered(doc, stream, resources, ctm, areas, rgb, codec);
    } catch {
      return null;
    }
  }
  const spans = pixelSpans(ctm, image.width, image.height, areas);
  if (!spans.length) return { unchanged: true };
  const stencil = image.space.family === 'mask';
  const raw = fillSamples(image, stream.dict, rgb, stencil ? 'unpainted' : 'color');
  const overrides = {};
  // Masks carry the same shape information as the picture, so they are redacted too.
  for (const key of ['SMask', 'Mask']) {
    const mask = get(stream.dict, key);
    if (!(mask instanceof PDFStream)) continue;
    let decoded;
    try {
      decoded = await samples(mask, mask.dict, resources);
    } catch {
      decoded = null;
    }
    if (!decoded) {
      // An undecodable mask would keep the redacted shape; drop it and paint the area opaque.
      overrides[key] = undefined;
      continue;
    }
    const maskSpans = pixelSpans(ctm, decoded.width, decoded.height, areas);
    const role = key === 'SMask' ? 'opaque' : 'painted';
    const out = storeRedacted(
      context,
      mask,
      mask.dict,
      decoded,
      maskSpans,
      fillSamples(decoded, mask.dict, rgb, role),
    );
    if (out) overrides[key] = context.register(out.stream);
  }
  const out = storeRedacted(context, stream, stream.dict, image, spans, raw, overrides);
  return out ? { stream: out.stream, pixels: out.pixels } : { unchanged: true };
}

/**
 * Redact an inline image. `header` is its dictionary (abbreviated keys allowed) as a PDFDict,
 * `data` its encoded bytes. Resolves to replacement inline-image source text, `''`-free
 * `{ unchanged: true }`, or null when it must be removed.
 */
export async function redactInlineImage(doc, header, data, resources, ctm, areas, rgb) {
  const context = doc.context;
  const dict = context.obj({});
  for (const [key, value] of header.entries()) {
    const full = expandInlineKey(key.decodeText());
    let expanded = value;
    if (value instanceof PDFName) expanded = PDFName.of(expandInlineValue(value.decodeText()));
    else if (value instanceof PDFArray && full === 'Filter')
      expanded = context.obj(
        value.asArray().map((v) => PDFName.of(expandInlineValue(v.decodeText()))),
      );
    else if (value instanceof PDFArray && full === 'ColorSpace')
      expanded = context.obj(
        value
          .asArray()
          .map((v, i) =>
            i === 0 && v instanceof PDFName ? PDFName.of(expandInlineValue(v.decodeText())) : v,
          ),
      );
    dict.set(PDFName.of(full), expanded);
  }
  let image;
  try {
    image = await samples(PDFRawStream.of(dict, data), dict, resources);
  } catch {
    image = null;
  }
  if (!image) return null;
  const spans = pixelSpans(ctm, image.width, image.height, areas);
  if (!spans.length) return { unchanged: true };
  const stencil = image.space.family === 'mask';
  const raw = fillSamples(image, dict, rgb, stencil ? 'unpainted' : 'color');
  if (!paint(image.data, { width: image.width, bpc: image.bpc, n: image.space.n }, spans, raw))
    return { unchanged: true };
  // Hex data cannot contain "EI", so the image ends unambiguously for every reader.
  const keys = [];
  for (const [key, value] of header.entries()) {
    const full = expandInlineKey(key.decodeText());
    if (['Filter', 'DecodeParms', 'Length'].includes(full)) continue;
    if (full === 'BitsPerComponent' && image.dct) continue;
    keys.push(`${key} ${value}`);
  }
  if (image.dct) keys.push('/BPC 8');
  let hex = '';
  for (let i = 0; i < image.data.length; i++) {
    hex += image.data[i].toString(16).padStart(2, '0');
    if (i % 64 === 63) hex += '\n';
  }
  return { source: `BI\n${keys.join('\n')}\n/F /AHx\nID\n${hex}>\nEI` };
}
