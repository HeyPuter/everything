import {
  PDFArray,
  PDFContext,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  StandardFonts,
  decodePDFRawStream,
} from 'pdf-lib';
import { assertSupportedText, embedFont, textVariant } from './document.js';
import { readParagraphData } from './paragraph-data.js';
import { retainCryptFilter, withoutCryptFilter } from './stream-filters.js';

const identity = [1, 0, 0, 1, 0, 0];
export function matrix(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
const translation = (x, y) => [1, 0, 0, 1, x, y];
const whitespace = (c) => /[\x00\t\n\f\r ]/.test(c);
const delimiter = (c) => !c || whitespace(c) || '()<>[]{}/%'.includes(c);
const unsupported = () => new Error('This text uses a PDF structure that cannot yet be edited.');

// Every content stream operator, for checking that what follows a guessed inline image end reads
// as content; EI and ID are left out, as they only belong inside an inline image.
const OPERATORS = new Set(
  `b B b* B* BDC BI BMC BT BX c cm CS cs d d0 d1 Do DP EMC ET EX f F f* G g gs h i j J K k l m M MP
  n q Q re RG rg ri s S SC sc SCN scn sh T* Tc Td TD Tf Tj TJ TL Tm Tr Ts Tw Tz v w W W* y ' "`.split(
    /\s+/,
  ),
);
const INLINE_KEYS = {
  BPC: 'BitsPerComponent',
  CS: 'ColorSpace',
  D: 'Decode',
  DP: 'DecodeParms',
  F: 'Filter',
  H: 'Height',
  I: 'Interpolate',
  IM: 'ImageMask',
  L: 'Length',
  W: 'Width',
};
const INLINE_FILTERS = {
  AHx: 'ASCIIHexDecode',
  A85: 'ASCII85Decode',
  LZW: 'LZWDecode',
  Fl: 'FlateDecode',
  RL: 'RunLengthDecode',
  CCF: 'CCITTFaxDecode',
  DCT: 'DCTDecode',
};
const COMPONENTS = {
  G: 1,
  DeviceGray: 1,
  I: 1,
  Indexed: 1,
  RGB: 3,
  DeviceRGB: 3,
  CMYK: 4,
  DeviceCMYK: 4,
};
function inflatedLength(data) {
  try {
    const dict = PDFContext.create().obj({ Filter: 'FlateDecode' });
    return decodePDFRawStream(
      PDFRawStream.of(
        dict,
        Uint8Array.from(data, (c) => c.charCodeAt(0)),
      ),
    ).decode().length;
  } catch {
    return -1;
  }
}
/**
 * Where an inline image's data ends, and the EI after it. Only an end the image itself fixes is
 * taken: its stated length, the size of unfiltered samples, or a filter's own end of data. Data
 * that does not say where it stops is accepted only up to the first EI at which it is complete
 * and after which the rest of the stream reads as content (`rest`); anything else is refused.
 */
function inlineImageEnd(source, entries, dataStart, readRest) {
  const value = (key) => entries.get(key)?.value;
  const closing = (dataEnd) => {
    const match = /^[\x00\t\n\f\r ]*EI(?=$|[\x00\t\n\f\r ])/.exec(
      source.slice(dataEnd, dataEnd + 64),
    );
    if (dataEnd > source.length || !match) throw unsupported();
    return { dataEnd, end: dataEnd + match[0].length };
  };
  const length = value('Length');
  if (length !== undefined) {
    if (!Number.isInteger(length) || length < 0) throw unsupported();
    return closing(dataStart + length);
  }
  const filter = entries.get('Filter');
  const filters = (filter?.type === 'array' ? filter.value : filter ? [filter] : []).map((t) =>
    t.type === 'name' ? INLINE_FILTERS[t.value] || t.value : null,
  );
  const mask = value('ImageMask') === 'true';
  const space = entries.get('ColorSpace');
  const components = mask
    ? 1
    : COMPONENTS[space?.type === 'array' ? space.value[0]?.value : space?.value];
  const [width, height, bits] = ['Width', 'Height', 'BitsPerComponent'].map(value);
  const size =
    [width, height].every((n) => Number.isInteger(n) && n > 0) &&
    components &&
    [1, 2, 4, 8, 16].includes(mask ? 1 : bits)
      ? height * Math.ceil((width * components * (mask ? 1 : bits)) / 8)
      : null;
  const [first] = filters;
  if (!filters.length) {
    if (!size) throw unsupported();
    return closing(dataStart + size);
  }
  if (first === 'ASCIIHexDecode') {
    const end = source.indexOf('>', dataStart);
    if (end < 0 || !/^[0-9a-f\x00\t\n\f\r ]*$/i.test(source.slice(dataStart, end)))
      throw unsupported();
    return closing(end + 1);
  }
  if (first === 'ASCII85Decode') {
    const end = source.indexOf('~>', dataStart);
    if (end < 0 || !/^[!-uz\x00\t\n\f\r ]*$/.test(source.slice(dataStart, end)))
      throw unsupported();
    return closing(end + 2);
  }
  if (first === 'RunLengthDecode') {
    for (let at = dataStart; at < source.length;) {
      const n = source.charCodeAt(at);
      if (n === 128) return closing(at + 1);
      at += n < 128 ? n + 2 : 2;
    }
    throw unsupported();
  }
  // JPEG data ends with its end-of-image marker, which its coded data cannot contain; Flate data
  // stops short of the image's samples when it is cut early.
  const complete =
    first === 'DCTDecode'
      ? (data) => data.replace(/[\x00\t\n\f\r ]+$/, '').endsWith('\xff\xd9')
      : first === 'FlateDecode' && filters.length === 1 && !entries.has('DecodeParms') && size
        ? (data) => inflatedLength(data) >= size
        : null;
  if (!complete) throw unsupported();
  const candidates = /[\x00\t\n\f\r ]EI(?=$|[\x00\t\n\f\r ])/g;
  candidates.lastIndex = dataStart;
  for (let match = candidates.exec(source); match; match = candidates.exec(source)) {
    if (!complete(source.slice(dataStart, match.index))) continue;
    try {
      return { dataEnd: match.index, end: match.index + 3, rest: readRest(match.index + 3) };
    } catch {
      // The rest does not read as content, so this EI is part of the data.
    }
  }
  throw unsupported();
}

/**
 * Tokenize objects, not regular-expression matches: strings may contain PDF operators. With
 * `inlineImages`, each inline image is one BI command spanning its header, data and EI, whose
 * bytes are never read as commands; without it, a stream with one is refused.
 */
export function parseContent(
  source,
  { inlineImages = false, from = 0, strict: known = false } = {},
) {
  let strict = known;
  let pos = from;
  const skip = () => {
    while (pos < source.length) {
      if (whitespace(source[pos])) pos++;
      else if (source[pos] === '%') {
        while (pos < source.length && !'\r\n'.includes(source[pos])) pos++;
      } else break;
    }
  };
  const token = () => {
    skip();
    const start = pos;
    const c = source[pos++];
    let value;
    let type = 'word';
    if (c === '(') {
      type = 'string';
      value = '';
      let depth = 1;
      while (pos < source.length && depth) {
        let ch = source[pos++];
        if (ch === '\\') {
          ch = source[pos++];
          if (/[0-7]/.test(ch)) {
            let octal = ch;
            for (let i = 0; i < 2 && /[0-7]/.test(source[pos] || 'x'); i++) octal += source[pos++];
            value += String.fromCharCode(parseInt(octal, 8) & 255);
          } else if (ch === '\r' || ch === '\n') {
            if (ch === '\r' && source[pos] === '\n') pos++;
          } else value += { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[ch] ?? ch;
        } else if (ch === '(') {
          depth++;
          value += ch;
        } else if (ch === ')') {
          if (--depth) value += ch;
        } else if (ch === '\r') {
          if (source[pos] === '\n') pos++;
          value += '\n';
        } else value += ch;
      }
      if (depth) throw unsupported();
    } else if (c === '[' || (c === '<' && source[pos] === '<')) {
      type = c === '[' ? 'array' : 'dict';
      if (type === 'dict') pos++;
      value = [];
      while (true) {
        skip();
        if (pos >= source.length) throw unsupported();
        if (type === 'array' ? source[pos] === ']' : source.slice(pos, pos + 2) === '>>') {
          pos += type === 'array' ? 1 : 2;
          break;
        }
        value.push(token());
      }
    } else if (c === '<') {
      type = 'string';
      const end = source.indexOf('>', pos);
      if (end === -1) throw unsupported();
      let hex = source.slice(pos, end).replace(/[\x00\t\n\f\r ]/g, '');
      if (!/^[\da-f]*$/i.test(hex)) throw unsupported();
      if (hex.length % 2) hex += '0';
      value = hex.replace(/../g, (byte) => String.fromCharCode(parseInt(byte, 16)));
      pos = end + 1;
    } else {
      if (c === '/') type = 'name';
      while (pos < source.length && !delimiter(source[pos])) pos++;
      value = source.slice(start + (type === 'name' ? 1 : 0), pos);
      if (type === 'name')
        value = value.replace(/#([\da-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
      else if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
        type = 'number';
        value = Number(value);
      }
    }
    return { type, value, start, end: pos };
  };
  const operations = [];
  let args = [];
  while (true) {
    skip();
    if (pos >= source.length) break;
    const t = token();
    if (t.type === 'word' && !['true', 'false', 'null'].includes(t.value)) {
      if (strict && !OPERATORS.has(t.value)) throw unsupported();
      if (t.value === 'BI') {
        // Inline image data is binary and must never be interpreted as text commands.
        if (!inlineImages || args.length) throw unsupported();
        const entries = new Map();
        while (true) {
          skip();
          if (pos >= source.length) throw unsupported();
          const key = token();
          if (key.type === 'word' && key.value === 'ID') break;
          skip();
          const value = pos < source.length ? token() : null;
          if (
            key.type !== 'name' ||
            !value ||
            (value.type === 'word' && !['true', 'false', 'null'].includes(value.value))
          )
            throw unsupported();
          entries.set(INLINE_KEYS[key.value] || key.value, value);
        }
        // A single white-space character separates ID from the data.
        if (!whitespace(source[pos] || '')) throw unsupported();
        const dataStart = pos + 1;
        const image = inlineImageEnd(source, entries, dataStart, (at) =>
          parseContent(source, { inlineImages, from: at, strict: true }),
        );
        operations.push({
          op: 'BI',
          args: [],
          start: t.start,
          end: image.end,
          inline: { dataStart, dataEnd: image.dataEnd },
        });
        if (image.rest) return operations.concat(image.rest);
        pos = image.end;
        // A wrong end would leave picture bytes to read as commands. They seldom spell only
        // operators, and never a lone EI, so what follows must.
        strict = true;
        continue;
      }
      operations.push({ op: t.value, args, start: args[0]?.start ?? t.start, end: t.end });
      args = [];
    } else args.push(t);
  }
  if (args.length) throw unsupported();
  return operations;
}

export function decode(stream) {
  const dict = stream instanceof PDFRawStream ? withoutCryptFilter(stream.dict) : null;
  const bytes =
    stream instanceof PDFRawStream
      ? decodePDFRawStream(
          dict === stream.dict ? stream : PDFRawStream.of(dict, stream.getContents()),
        ).decode()
      : stream.getUnencodedContents();
  let source = '';
  for (let i = 0; i < bytes.length; i += 8192)
    source += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return source;
}
export function pageSource(page) {
  const contents = page.node.Contents();
  return (
    (contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [])
      .map((ref) => page.doc.context.lookup(ref))
      // A dangling reference or a non-stream entry draws nothing; readers pass over it too.
      .filter((stream) => stream instanceof PDFStream)
      .map(decode)
      .join('\n')
  );
}
const get = (dict, key) => dict?.lookup(PDFName.of(key));
const numbers = (array) => array?.asArray().map((n) => n.asNumber());
function descriptorStyle(dict, font) {
  const descendants = get(dict, 'DescendantFonts');
  const face = descendants instanceof PDFArray && descendants.size() ? descendants.lookup(0) : dict;
  const descriptor = get(face, 'FontDescriptor');
  const flags = get(descriptor, 'Flags')?.asNumber?.() || 0;
  const weight = get(descriptor, 'FontWeight')?.asNumber?.() || 0;
  const angle = get(descriptor, 'ItalicAngle')?.asNumber?.() || 0;
  return {
    fontWeight: font.black
      ? '900'
      : font.bold || flags & 262144 || weight >= 600
        ? 'bold'
        : 'normal',
    fontStyle:
      font.italic || flags & 64 || (Number.isFinite(angle) && angle !== 0) ? 'italic' : 'normal',
  };
}
const freshState = () => ({
  ctm: identity,
  tm: identity,
  x: 0,
  y: 0,
  lineX: 0,
  lineY: 0,
  size: 0,
  font: '',
  charSpacing: 0,
  wordSpacing: 0,
  hScale: 1,
  leading: 0,
  rise: 0,
  mode: 0,
  actualText: false,
  fillCommand: '0 g',
  paintTag: 0,
});

/** The color a text color control edits; stroke-only text does not paint its fill. */
export function textColor(run) {
  return run.state.mode === 1 ? (run.strokeColor ?? run.fillColor) : run.fillColor;
}

/** Pair source text commands with PDF.js's decoded glyphs, never with guessed string offsets. */
export async function inspectText(doc, index, pdfPage, OPS, layers) {
  const list = await pdfPage.getOperatorList({ annotationMode: 0 });
  const decoded = [];
  let fontId,
    fillColor = '#000000',
    strokeColor = '#000000',
    strokeWidth = 1;
  const states = [];
  const marked = [];
  let hiddenDepth = 0;
  for (let i = 0; i < list.fnArray.length; i++) {
    const op = list.fnArray[i],
      args = list.argsArray[i];
    // Keep every decoded text command for source/glyph alignment, but do not offer
    // invisible commands for editing. Optional-content scopes nest independently of q/Q.
    if (op === OPS.beginMarkedContent || op === OPS.beginMarkedContentProps) {
      const hidden =
        op === OPS.beginMarkedContentProps &&
        args[0] === 'OC' &&
        layers &&
        !layers.isVisible(args[1]);
      marked.push(hidden);
      if (hidden) hiddenDepth++;
    } else if (op === OPS.endMarkedContent) {
      if (marked.pop()) hiddenDepth--;
    } else if (op === OPS.save || op === OPS.paintFormXObjectBegin)
      states.push({ fontId, fillColor, strokeColor, strokeWidth });
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd)
      ({ fontId, fillColor, strokeColor, strokeWidth } = states.pop() || {});
    else if (op === OPS.setFillRGBColor) fillColor = args[0];
    else if (op === OPS.setStrokeRGBColor) strokeColor = args[0];
    else if (op === OPS.setLineWidth) strokeWidth = args[0];
    else if (op === OPS.setFont) fontId = args[0];
    else if (op === OPS.setGState) {
      for (const [key, value] of args[0]) {
        if (key === 'Font') fontId = value[0];
        else if (key === 'LW') strokeWidth = value;
      }
    } else if (op === OPS.showText)
      decoded.push({
        glyphs: args[0],
        font: pdfPage.commonObjs.get(fontId),
        fillColor,
        strokeColor,
        strokeWidth,
        visible: hiddenDepth === 0,
      });
  }
  const runs = [];
  const maps = new Map(),
    widths = new Map(),
    styles = new Map();
  // Fonts are keyed by reference so that shared fonts share one code map. The reference is
  // read from the Font dictionary's own entry and remembered per font: pdf-lib's reverse
  // lookup scans every object in the document, and this runs once per text-show command.
  const fontKeys = new Map();
  const fontKey = (fonts, fontDict, fontName) => {
    let key = fontKeys.get(fontDict);
    if (!key) {
      const entry = fonts?.get(PDFName.of(fontName));
      key =
        entry instanceof PDFRef
          ? entry.toString()
          : doc.context.getObjectRef(fontDict)?.toString() || fontDict.toString();
      fontKeys.set(fontDict, key);
    }
    return key;
  };
  let cursor = 0,
    barrier = 0;
  const walk = (source, resources, initial, path = [], ancestors = new Set()) => {
    if (path.length > 20) throw unsupported();
    let s = { ...initial },
      paragraphData = null,
      // The q … BDC … EMC Q block (plus the position-restoring trailer) that an earlier
      // paragraph edit wrote around the runs, so the next edit can replace it whole.
      wrapper = null;
    const stack = [],
      marked = [];
    const commands = parseContent(source, { inlineImages: true });
    for (const [at, command] of commands.entries()) {
      const { op, args } = command;
      const a = args.map((t) => t.value);
      if (
        ![
          'q',
          'Q',
          'cm',
          'BT',
          'ET',
          'Tf',
          'Tc',
          'Tw',
          'Tz',
          'TL',
          'Ts',
          'Tr',
          'Tm',
          'TD',
          'Td',
          'T*',
          'Tj',
          'TJ',
          "'",
          '"',
          'g',
          'rg',
          'k',
          'G',
          'RG',
          'K',
        ].includes(op)
      )
        barrier++;
      switch (op) {
        case 'q':
          stack.push({ ...s });
          break;
        case 'Q':
          if (!stack.length) throw unsupported();
          if (s.paintTag !== stack.at(-1).paintTag) barrier++;
          s = stack.pop();
          break;
        case 'g':
        case 'rg':
        case 'k':
          s.fillCommand = source.slice(command.start, command.end);
          s.customColor = false;
          break;
        case 'cs':
        case 'sc':
        case 'scn':
          s.customColor = true;
          break;
        case 'cm':
          s.ctm = matrix(s.ctm, a);
          break;
        case 'BT':
          Object.assign(s, { tm: identity, x: 0, y: 0, lineX: 0, lineY: 0 });
          break;
        case 'Tf':
          [s.font, s.size] = a;
          break;
        case 'Tc':
          s.charSpacing = a[0];
          break;
        case 'Tw':
          s.wordSpacing = a[0];
          break;
        case 'Tz':
          s.hScale = a[0] / 100;
          break;
        case 'TL':
          s.leading = a[0];
          break;
        case 'Ts':
          s.rise = a[0];
          break;
        case 'Tr':
          s.mode = a[0];
          break;
        case 'Tm':
          Object.assign(s, { tm: a, x: 0, y: 0, lineX: 0, lineY: 0 });
          break;
        case 'TD':
          s.leading = -a[1]; // falls through
        case 'Td':
          s.x = s.lineX += a[0];
          s.y = s.lineY += a[1];
          break;
        case 'T*':
          s.x = s.lineX;
          s.y = s.lineY -= s.leading;
          break;
        case 'BMC':
        case 'BDC': {
          marked.push({ actualText: s.actualText, paragraphData, wrapper });
          if (args[0]?.value === 'PuterParagraph') {
            paragraphData = readParagraphData(args);
            const opened = commands[at - 1];
            wrapper =
              paragraphData && opened?.op === 'q'
                ? {
                    start: opened.start,
                    end: null,
                    trailer: '',
                    textObject:
                      commands
                        .slice(at + 1)
                        .find((c) => ['BT', 'Tj', 'TJ', "'", '"'].includes(c.op))?.op === 'BT',
                  }
                : null;
          }
          const property = args[1];
          const dict =
            property?.type === 'name' ? get(get(resources, 'Properties'), property.value) : null;
          s.actualText ||= Boolean(
            dict?.has(PDFName.of('ActualText')) ||
            (property?.type === 'dict' &&
              property.value.some((t) => t.type === 'name' && t.value === 'ActualText')),
          );
          break;
        }
        case 'EMC': {
          const previous = marked.pop();
          s.actualText = previous?.actualText ?? false;
          paragraphData = previous?.paragraphData ?? null;
          if (wrapper && wrapper !== previous?.wrapper) {
            // The block ends with Q; the four commands after it put the text position back
            // where the content that follows expects it, and travel with the block.
            const [close, ...trailer] = commands.slice(at + 1, at + 6);
            if (close?.op === 'Q') {
              const restores =
                trailer.length === 4 &&
                ['Tm', 'Tc', 'TJ', 'Tc'].every((o, k) => trailer[k].op === o);
              wrapper.end = restores ? trailer[3].end : close.end;
              wrapper.trailer = restores ? source.slice(close.end, wrapper.end) : '';
            }
          }
          wrapper = previous?.wrapper ?? null;
          break;
        }
        case 'gs': {
          s.paintTag = barrier;
          const gs = get(get(resources, 'ExtGState'), a[0]);
          // A font set through ExtGState has no local Tf name to restore reliably.
          if (get(gs, 'Font')) throw unsupported();
          break;
        }
        case 'Do': {
          const form = get(get(resources, 'XObject'), a[0]);
          if (get(form?.dict, 'Subtype')?.toString() !== '/Form') break;
          if (ancestors.has(form)) throw unsupported();
          walk(
            decode(form),
            get(form.dict, 'Resources') || resources,
            { ...s, ctm: matrix(s.ctm, numbers(get(form.dict, 'Matrix')) || identity) },
            [...path, { start: command.start, end: command.end, name: a[0] }],
            new Set([...ancestors, form]),
          );
          break;
        }
        case 'Tj':
        case 'TJ':
        case "'":
        case '"': {
          if (op === '"') [s.wordSpacing, s.charSpacing] = a;
          if (op === "'" || op === '"') {
            s.x = s.lineX;
            s.y = s.lineY -= s.leading;
          }
          const data = decoded[cursor++];
          if (!data) throw unsupported();
          const { glyphs, font } = data;
          const fonts = get(resources, 'Font');
          const fontDict = get(fonts, s.font);
          if (!fontDict) throw unsupported();
          const key = fontKey(fonts, fontDict, s.font);
          if (!styles.has(key)) styles.set(key, descriptorStyle(fontDict, font));
          const map = maps.get(key) || new Map();
          maps.set(key, map);
          const metrics = widths.get(key) || new Map();
          widths.set(key, metrics);
          const strings =
            op === 'TJ' ? args[0].value.filter((t) => t.type === 'string') : [args.at(-1)];
          const raw = strings.map((t) => t.value).join('');
          const chars = glyphs.filter((g) => typeof g !== 'number');
          const codeLength = raw.length / chars.length;
          if (
            [1, 2, 3, 4].includes(codeLength) &&
            chars.every((g, i) => {
              let code = 0;
              for (let n = 0; n < codeLength; n++)
                code = code * 256 + raw.charCodeAt(i * codeLength + n);
              return code === g.originalCharCode;
            })
          )
            chars.forEach((g, i) => {
              if (g.unicode) {
                map.set(g.unicode, raw.slice(i * codeLength, (i + 1) * codeLength));
                metrics.set(g.unicode, {
                  width: g.width * (font.fontMatrix?.[0] || 0.001),
                  space: g.isSpace,
                });
              }
            });
          let advance = 0,
            text = '',
            gap = false;
          for (const g of glyphs) {
            if (typeof g === 'number') {
              advance -= (g * s.size) / 1000;
              // TJ uses large negative adjustments to represent word spaces, unless the next
              // string starts with a space of its own.
              if (g < -150 && text && !text.endsWith(' ')) gap = true;
            } else {
              if (gap && !/^\s/.test(g.unicode)) text += ' ';
              gap = false;
              text += g.unicode;
              advance +=
                g.width * s.size * (font.fontMatrix?.[0] || 0.001) +
                s.charSpacing +
                (g.isSpace ? s.wordSpacing : 0);
            }
          }
          if (gap) text += ' ';
          const transform = matrix(
            matrix(s.ctm, s.tm),
            matrix(translation(s.x, s.y + s.rise), [s.size * s.hScale, 0, 0, s.size, 0, 0]),
          );
          const editable =
            data.visible &&
            !font.vertical &&
            !font.isType3Font &&
            !s.actualText &&
            s.mode < 3 &&
            s.size > 0 &&
            s.hScale > 0 &&
            transform.every(Number.isFinite);
          runs.push({
            ...command,
            source: source.slice(command.start, command.end),
            barrier,
            paragraphData,
            underline: paragraphData?.underline || false,
            strikethrough: paragraphData?.strikethrough || false,
            wrapper,
            groupable: editable && s.mode === 0 && !s.customColor,
            widths: metrics,
            path,
            text,
            state: { ...s },
            advance,
            transform,
            fontKey: key,
            map,
            fillColor: data.fillColor,
            strokeColor: data.strokeColor,
            strokeWidth: data.strokeWidth,
            ...styles.get(key),
            fontName: font.name || get(fontDict, 'BaseFont')?.decodeText() || '',
            // Standard PDF encodings draw separate letters, even when a system face
            // would automatically replace them with an fi/ffi ligature in HTML.
            fontVariantLigatures: standardFont(font.name || '') ? 'none' : 'normal',
            // A non-embedded font is substituted by a system font that PDF.js registers under
            // its own face name and paints with `systemFontInfo.css`; drafts must use the same
            // list, or they fall back to the platform's default sans-serif and wrap differently.
            fontFamily:
              font.systemFontInfo?.css ||
              (font.loadedName
                ? `"${font.loadedName}", ${font.fallbackName || 'sans-serif'}`
                : 'sans-serif'),
            ascent: font.ascent || 0.85,
            descent: font.descent ?? -0.2,
            editable,
          });
          if (font.vertical) s.y -= advance;
          else s.x += advance * s.hScale;
          break;
        }
      }
    }
  };
  try {
    const page = doc.getPage(index);
    walk(pageSource(page), page.node.Resources(), freshState());
    if (cursor !== decoded.length) throw unsupported();
    return runs;
  } catch {
    // A mismatch means source-to-glyph identity is unproven; never edit a different text run.
    return [];
  }
}

const number = (n) => {
  if (!Number.isFinite(n)) throw unsupported();
  return PDFNumber.of(n).toString();
};
const hex = (s) => `<${[...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')}>`;
/** Match longest glyph sequences without searching unrelated characters in the font. */
export function originalGlyphs(map, text) {
  const initials = new Map();
  for (const key of map.keys()) {
    // Ordinary one-unit characters already have constant-time lookups in the source
    // map. Only ligatures and surrogate pairs need a longest-prefix search.
    if (key.length <= 1) continue;
    if (!initials.has(key[0])) initials.set(key[0], []);
    initials.get(key[0]).push(key);
  }
  for (const keys of initials.values()) keys.sort((a, b) => b.length - a.length);
  const glyphs = [];
  for (let i = 0; i < text.length;) {
    const key =
      initials.get(text[i])?.find((k) => text.startsWith(k, i)) ||
      (map.has(text[i]) ? text[i] : null);
    if (!key) return null;
    glyphs.push(key);
    i += key.length;
  }
  return glyphs;
}
function encodeOriginal(map, text) {
  const glyphs = originalGlyphs(map, text);
  return glyphs && hex(glyphs.map((key) => map.get(key)).join(''));
}
function standardFont(name) {
  name = name.replace(/^[A-Z]{6}\+/, '');
  if (Object.values(StandardFonts).includes(name)) return name;
  // PDFs commonly name the platform equivalents of the standard faces. Keep that
  // family when an edit needs characters absent from the observed source glyphs.
  const alias = name
    .replace(/[,_]/g, '-')
    .replace(/\s/g, '')
    .match(
      /^(Arial(?:MT)?|TimesNewRoman(?:PS)?(?:MT)?|CourierNew(?:PS)?(?:MT)?)(?:-(Regular|Bold|Italic|Oblique|BoldItalic|BoldOblique)(?:MT)?)?$/,
    );
  if (alias) {
    const family = alias[1].startsWith('Times')
      ? 'TimesRoman'
      : alias[1].startsWith('Courier')
        ? 'Courier'
        : 'Helvetica';
    const style = alias[2] || '';
    const bold = style.includes('Bold') ? 'Bold' : '';
    const italic = /Italic|Oblique/.test(style)
      ? family === 'TimesRoman'
        ? 'Italic'
        : 'Oblique'
      : '';
    return StandardFonts[family + bold + italic];
  }
  return null;
}
export function cloneResources(doc, resources) {
  const copy = resources?.clone(doc.context) || doc.context.obj({});
  for (const key of ['Font', 'XObject'])
    copy.set(PDFName.of(key), get(resources, key)?.clone(doc.context) || doc.context.obj({}));
  return copy;
}
export function uniqueName(dict, prefix) {
  let n = 1;
  while (dict.has(PDFName.of(`${prefix}${n}`))) n++;
  return PDFName.of(`${prefix}${n}`);
}
/**
 * Drop the fonts earlier edits added to `resources` (EditedFontN, LineFontN) that `source` no
 * longer selects. Every transaction embeds its own subset, so a line edited many times would
 * otherwise keep a font per edit reachable from the page, where Reduce file size cannot sweep
 * it. The font objects themselves stay for that sweep, since another page may still use one.
 */
export function pruneEditedFonts(resources, source) {
  const fonts = get(resources, 'Font');
  if (!fonts?.entries) return;
  const used = new Set();
  for (const match of source.matchAll(/\/([^\s/[\]<>(){}%]+)\s+[-\d.]+\s+Tf(?![^\s])/g))
    used.add(match[1]);
  for (const [key] of fonts.entries())
    if (/^(EditedFont|LineFont)\d+$/.test(key.decodeText()) && !used.has(key.toString().slice(1)))
      fonts.delete(key);
}
/**
 * Drop the Form XObjects an earlier edit wrote (EditedFormN, EditedImageFormN) that `source` no
 * longer draws, and delete their stream objects. Each edit inside a shared form writes a fresh
 * copy of it; without this the page would keep every copy any edit ever made, referenced from
 * its resources and so beyond the reach of the file-size sweep, and grow without bound.
 */
export function pruneEditedForms(doc, resources, source) {
  const objects = get(resources, 'XObject');
  if (!objects?.entries) return;
  const used = new Set();
  for (const match of source.matchAll(/\/([^\s/[\]<>(){}%]+)\s+Do\b/g)) used.add(match[1]);
  for (const [key, value] of objects.entries()) {
    const name = key.decodeText();
    if (used.has(name)) continue;
    if (/^Edited(Image)?Form\d+$/.test(name)) {
      objects.delete(key);
      if (value instanceof PDFRef) doc.context.delete(value);
    } else if (/^ReplacementImage\d+$/.test(name)) {
      // An earlier replacement that is no longer drawn here. The picture itself may still be
      // drawn by a copy of this page; the session's sweep drops it once nothing refers to it.
      objects.delete(key);
    }
  }
}
// Streams written by edits, per document context. pdf-lib serializes every indirect object,
// so a multi-step edit must overwrite its own earlier streams instead of orphaning full copies
// of the page content on each step.
const editedStreams = new WeakMap();
/** Store a rebuilt stream, reusing the slot when this operation already created it. */
export function storeStream(doc, currentRef, stream) {
  let edited = editedStreams.get(doc.context);
  if (!edited) editedStreams.set(doc.context, (edited = new Set()));
  if (currentRef instanceof PDFRef && edited.has(currentRef)) {
    doc.context.assign(currentRef, stream);
    return currentRef;
  }
  const ref = doc.context.register(stream);
  edited.add(ref);
  return ref;
}
/** Replace the page content with one flate stream, updating an edit's own stream in place. */
export function setPageSource(doc, page, source) {
  const contents = page.node.get(PDFName.of('Contents'));
  const original = page.node.Contents();
  const sources = (original instanceof PDFArray ? original.asArray() : original ? [original] : [])
    .map((ref) => doc.context.lookup(ref))
    .filter((stream) => stream instanceof PDFStream)
    .map((stream) => stream.dict);
  const stream = doc.context.flateStream(Uint8Array.from(source, (c) => c.charCodeAt(0)));
  retainCryptFilter(stream.dict, sources);
  const ref = storeStream(
    doc,
    contents instanceof PDFArray && contents.size() === 1 ? contents.get(0) : null,
    stream,
  );
  if (contents instanceof PDFArray && contents.size() === 1 && contents.get(0) === ref) return;
  page.node.set(PDFName.of('Contents'), doc.context.obj([ref]));
}

const standardFonts = new WeakMap();
async function embedStandardFont(doc, name) {
  let fonts = standardFonts.get(doc);
  if (!fonts) standardFonts.set(doc, (fonts = new Map()));
  if (!fonts.has(name)) fonts.set(name, await doc.embedFont(name));
  return fonts.get(name);
}
/** Match both descriptor styles and conventional face names when selecting a fallback. */
export const fallbackVariant = ({ fontName = '', fontWeight = '', fontStyle = '' }) =>
  textVariant(
    /bold|[6-9]00/.test(String(fontWeight)) || /bold|black|heavy|semibold/i.test(fontName),
    fontStyle === 'italic' || /italic|oblique/i.test(fontName),
  );
/**
 * Glyph codes for `text` in the run's own font when it has them, else in a standard or Noto
 * Sans font; `variant` (a Noto Sans face) forces that face, as a bold or italic change does.
 * With no forced face, the Noto fallback matches the run's own weight and slant so an edit to
 * bold or italic text is not silently set in the regular face.
 */
export async function prepareText(doc, run, text, variant) {
  const lines = text.split('\n');
  let encoded = lines.map((line) => (variant && line ? null : encodeOriginal(run.map, line)));
  let font;
  if (encoded.some((line) => line == null) && text) {
    const standard = variant ? null : standardFont(run.fontName);
    if (standard) {
      try {
        font = await embedStandardFont(doc, standard);
        encoded = lines.map((line) => font.encodeText(assertSupportedText(font, line)).toString());
      } catch {
        font = null;
      }
    }
    if (!font) {
      font = await embedFont(doc, variant || fallbackVariant(run), text);
      assertSupportedText(font, text);
      encoded = lines.map((line) => font.encodeText(line).toString());
    }
  }
  return { encoded, font };
}

/** Replace actual source glyphs and restore the old text advance, preserving following content. */
export function replaceText(doc, index, run, text, options = {}) {
  return editRuns(doc, index, [{ run, text, options }]);
}
/**
 * Remove several runs of one content stream at once: the other fragments of a line being
 * rewritten. One pass decodes, parses, and re-encodes the page, where a rewrite per fragment
 * would repeat all of that for every fragment.
 */
export function deleteRuns(doc, index, runs) {
  return editRuns(
    doc,
    index,
    runs.map((run) => ({ run, text: '', options: {} })),
  );
}
async function editRuns(doc, index, edits) {
  const prepared = [];
  for (const { run, text: raw, options } of edits) {
    const { size = run.state.size, hex: ink, offset = [0, 0], variant } = options;
    if (!run.editable) throw unsupported();
    const text = raw.replace(/\r\n?/g, '\n');
    if (!Number.isFinite(size) || size <= 0 || size > 10000)
      throw new Error('Choose a valid text size.');
    if (ink != null && !/^#[0-9a-f]{6}$/i.test(ink)) throw new Error('Choose a valid color.');
    const changedColor = ink != null && ink !== textColor(run);
    if (!Array.isArray(offset) || offset.length !== 2 || !offset.every(Number.isFinite))
      throw new Error('Choose a valid text position.');
    const ctm = run.state.ctm,
      determinant = ctm[0] * ctm[3] - ctm[1] * ctm[2];
    if (Math.abs(determinant) < 1e-12) throw unsupported();
    const shift = [
      (ctm[3] * offset[0] - ctm[2] * offset[1]) / determinant,
      (ctm[0] * offset[1] - ctm[1] * offset[0]) / determinant,
    ];
    const originalAppearance =
      text === run.text && Math.abs(size - run.state.size) < 1e-8 && !changedColor && !variant;
    if (originalAppearance && offset.every((n) => Math.abs(n) < 1e-8)) continue;
    if (text.length > 5000) throw new Error('Keep text edits under 5,000 characters.');
    // A new size or color alone keeps the run's own glyph commands, including the kerning that
    // stands in for the spaces a subset font often lacks; re-encoding would change the face.
    const sameGlyphs = text === run.text && !variant && !text.includes('\n');
    const { encoded, font } =
      originalAppearance || sameGlyphs
        ? { encoded: [], font: null }
        : await prepareText(doc, run, text, variant);
    prepared.push({
      run,
      text,
      size,
      ink,
      shift,
      changedColor,
      originalAppearance,
      sameGlyphs,
      encoded,
      font,
    });
  }
  if (!prepared.length) return false;
  // Every run edited together sits in the same content stream.
  const path = prepared[0].run.path;
  const key = (p) => p.map((step) => step.start).join(':');
  if (prepared.some(({ run }) => key(run.path) !== key(path))) throw unsupported();
  const rebuildLevel = (source, resources, depth) => {
    const copy = cloneResources(doc, resources);
    if (depth < path.length) {
      const call = parseContent(source, { inlineImages: true }).find(
        (c) => c.start === path[depth].start,
      );
      if (call?.op !== 'Do') throw unsupported();
      const form = get(get(resources, 'XObject'), call.args[0].value);
      if (!form) throw unsupported();
      const nested = rebuild(decode(form), get(form.dict, 'Resources') || resources, depth + 1);
      const dict = form.dict.clone(doc.context);
      dict.delete(PDFName.of('Filter'));
      dict.delete(PDFName.of('DecodeParms'));
      retainCryptFilter(dict, [form.dict]);
      dict.set(PDFName.of('Resources'), nested.resources);
      const stream = PDFRawStream.of(
        dict,
        Uint8Array.from(nested.source, (c) => c.charCodeAt(0)),
      );
      const objects = get(copy, 'XObject');
      const current = get(resources, 'XObject').get(PDFName.of(call.args[0].value));
      const ref = storeStream(doc, current, stream);
      if (ref === current) return { source, resources: copy };
      const name = uniqueName(objects, 'EditedForm');
      objects.set(name, ref);
      return {
        source: source.slice(0, call.start) + `${name} Do` + source.slice(call.end),
        resources: copy,
      };
    }
    const commands = parseContent(source, { inlineImages: true });
    // Later runs first, so the earlier ones keep their positions in the source.
    const changes = [...prepared]
      .sort((a, b) => b.run.start - a.run.start)
      .map((edit) => editAt(edit, source, commands, copy));
    let out = source;
    for (const change of changes)
      out = out.slice(0, change.from) + change.text + out.slice(change.end);
    return { source: out, resources: copy };
  };
  const rebuild = (source, resources, depth) => {
    const result = rebuildLevel(source, resources, depth);
    pruneEditedFonts(result.resources, result.source);
    pruneEditedForms(doc, result.resources, result.source);
    return result;
  };
  const page = doc.getPage(index);
  const result = rebuild(pageSource(page), page.node.Resources(), 0);
  page.node.set(PDFName.of('Resources'), result.resources);
  setPageSource(doc, page, result.source);
}
/** The text that replaces one run in `source`, and the range of the source it covers. */
function editAt(
  { run, text, size, ink, shift, changedColor, originalAppearance, sameGlyphs, encoded, font },
  source,
  commands,
  copy,
) {
  const at = commands.findIndex((c) => c.start === run.start && c.end === run.end);
  const original = commands[at];
  if (
    !original ||
    original.op !== run.op ||
    JSON.stringify(original.args) !== JSON.stringify(run.args)
  )
    throw unsupported();
  const s = run.state;
  // An earlier edit here selected its own font just before this command and restored the
  // original one just after it. Editing again takes that selection over, and restores the
  // font from before it, so the font of the earlier edit is no longer referenced and the
  // page does not keep a font per edit.
  let from = run.start,
    restoreFont = PDFName.of(s.font);
  if (!originalAppearance && /^(EditedFont|LineFont)\d+$/.test(s.font)) {
    // Between that selection and the text come only the matrix and leading it set, which
    // the replacement sets again.
    let i = at - 1;
    while (i >= 0 && (commands[i].op === 'Tm' || commands[i].op === 'TL')) i--;
    const selected = commands[i];
    if (selected?.op === 'Tf' && selected.args[0]?.value === s.font) {
      const earlier = commands.slice(0, i).findLast((c) => c.op === 'Tf');
      if (earlier?.args[0]?.value != null) {
        from = selected.start;
        restoreFont = PDFName.of(earlier.args[0].value);
      }
    }
  }
  const prefix =
    run.op === '"'
      ? `${number(s.wordSpacing)} Tw ${number(s.charSpacing)} Tc T*\n`
      : run.op === "'"
        ? 'T*\n'
        : '';
  const value = original.args.at(-1);
  const show =
    run.op === 'Tj' || run.op === 'TJ'
      ? source.slice(run.start, run.end)
      : `${source.slice(value.start, value.end)} Tj`;
  let replacement;
  if (originalAppearance) {
    const line = matrix(s.tm, translation(s.lineX, s.lineY));
    replacement = [
      `q\n1 0 0 1 ${shift.map(number).join(' ')} cm\n${show}\nQ`,
      `${line.map(number).join(' ')} Tm`,
      '0 Tc',
      `[${number((-((s.x - s.lineX) / s.hScale + run.advance) * 1000) / s.size)}] TJ`,
      `${number(s.charSpacing)} Tc`,
    ].join('\n');
  } else if (!text)
    replacement = [
      ...(from < run.start ? [`${restoreFont} ${number(s.size)} Tf`] : []),
      '0 Tc',
      `[${number((-run.advance * 1000) / s.size)}] TJ`,
      `${number(s.charSpacing)} Tc`,
    ].join('\n');
  else {
    let fontName = PDFName.of(s.font).toString();
    if (font) {
      const fonts = get(copy, 'Font');
      const key = uniqueName(fonts, 'EditedFont');
      fonts.set(key, font.ref);
      fontName = key.toString();
    }
    const start = matrix(s.tm, translation(s.x, s.y));
    start[4] += shift[0];
    start[5] += shift[1];
    const line = matrix(s.tm, translation(s.lineX, s.lineY));
    replacement = [
      ...(changedColor
        ? [
            'q',
            // Set the fill and the stroke colour, so text drawn in a stroke render mode takes
            // the new colour too, not only filled text.
            `${[1, 3, 5].map((i) => number(parseInt(ink.slice(i, i + 2), 16) / 255)).join(' ')} rg`,
            `${[1, 3, 5].map((i) => number(parseInt(ink.slice(i, i + 2), 16) / 255)).join(' ')} RG`,
          ]
        : []),
      `${fontName} ${number(size)} Tf`,
      `${start.map(number).join(' ')} Tm`,
      `${number(size * 1.35)} TL`,
      sameGlyphs ? show : encoded.map((value) => `${value} Tj`).join('\nT*\n'),
      ...(changedColor ? ['Q'] : []),
      `${restoreFont} ${number(s.size)} Tf`,
      `${number(s.leading)} TL`,
      `${line.map(number).join(' ')} Tm`,
      '0 Tc',
      `[${number((-((s.x - s.lineX) / s.hScale + run.advance) * 1000) / s.size)}] TJ`,
      `${number(s.charSpacing)} Tc`,
    ].join('\n');
  }
  return { from, end: run.end, text: prefix + replacement };
}
