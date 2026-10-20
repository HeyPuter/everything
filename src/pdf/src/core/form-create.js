/**
 * Form authoring, as Acrobat's Prepare Form tool offers it: add fields of every kind, list and
 * edit them (including fields other tools made), move, resize and delete widgets, and set the
 * tab order. Fields are written the way Acrobat writes them (a DR font named by the DA, MK
 * colors and rotation, ZapfDingbats check marks), and text, choice and button drawings come
 * from the same appearance code the fill tools use, so PDF.js, Acrobat and our own flattening
 * show identical fields. Automatic detection on flat forms lives in form-detect.js.
 *
 * Every rectangle is `{ x, y, width, height }` in the user space of the unrotated page.
 */
import {
  PDFArray,
  PDFButton,
  PDFCheckBox,
  PDFDict,
  PDFDropdown,
  PDFFont,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFSignature,
  PDFStream,
  PDFString,
  PDFTextField,
  StandardFontEmbedder,
  beginText,
  componentsToColor,
  drawEllipse,
  drawRectangle,
  endText,
  moveText,
  popGraphicsState,
  pushGraphicsState,
  reduceRotation,
  adjustDimsForRotation,
  rotateInPlace,
  setFillingColor,
  setFontAndSize,
  showText,
} from 'pdf-lib';
import { embedFont } from './document.js';
import { updateFieldAppearance } from './form-appearance.js';
import { readAppearanceDefaults } from './form-style.js';
import { choiceOptions, choiceValues, textValue } from './form-values.js';
import {
  DAMAGED_FORM,
  annotationList,
  annotationsOf,
  formFields,
  pageRotation,
} from './structure.js';
import { parseContent } from './text-edit.js';
export { detectFormFields } from './form-detect.js';

const name = PDFName.of;
const KIDS = name('Kids'),
  PARENT = name('Parent'),
  OFF = name('Off');

// Field flags, ISO 32000-1 Tables 221, 226, 228 and 230 (bit n is 1 << (n - 1)).
const READ_ONLY = 1 << 0,
  REQUIRED = 1 << 1,
  MULTILINE = 1 << 12,
  PASSWORD = 1 << 13,
  NO_TOGGLE_TO_OFF = 1 << 14,
  RADIO = 1 << 15,
  PUSH_BUTTON = 1 << 16,
  COMBO = 1 << 17,
  EDIT = 1 << 18,
  SORT = 1 << 19,
  MULTI_SELECT = 1 << 21,
  DO_NOT_SPELL_CHECK = 1 << 22,
  DO_NOT_SCROLL = 1 << 23,
  COMB = 1 << 24;
const PRINT_FLAG = 4;

/** The standard text faces a field can use, under the resource names Acrobat gives them. */
export const FORM_FONTS = {
  Helvetica: 'Helv',
  'Helvetica-Bold': 'HeBo',
  'Helvetica-Oblique': 'HeOb',
  'Helvetica-BoldOblique': 'HeBO',
  'Times-Roman': 'TiRo',
  'Times-Bold': 'TiBo',
  'Times-Italic': 'TiIt',
  'Times-BoldItalic': 'TiBI',
  Courier: 'Cour',
  'Courier-Bold': 'CoBo',
  'Courier-Oblique': 'CoOb',
  'Courier-BoldOblique': 'CoBO',
};
/** Check box and radio button marks: Acrobat's MK /CA characters in ZapfDingbats. */
export const BUTTON_STYLES = {
  check: { char: '4', width: 846 },
  cross: { char: '8', width: 677 },
  star: { char: 'H', width: 816 },
  circle: { char: 'l', width: 791 },
  square: { char: 'n', width: 761 },
  diamond: { char: 'u', width: 788 },
};
const DEFAULT_NAMES = {
  text: 'Text',
  date: 'Date',
  checkbox: 'Check Box',
  radio: 'Group',
  dropdown: 'Dropdown',
  listbox: 'List Box',
  button: 'Button',
  signature: 'Signature',
};
const ALIGNMENTS = ['left', 'center', 'right'];
const MIN_SIZE = 4;

/* ---------- Small readers and writers ---------- */

const PRINTABLE = /^[\x20-\x7e]*$/;
/** A PDF text string: an escaped literal for plain ASCII, UTF-16BE hex otherwise. */
const textObject = (text) =>
  PRINTABLE.test(text)
    ? PDFString.of(text.replace(/[\\()]/g, (c) => `\\${c}`))
    : PDFHexString.fromText(text);
const textOf = (value) =>
  value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined;
/** Appearance state names hold export values directly when they survive as plain names. */
const nameSafe = (value) => /^[\x20-\x7e]+$/.test(value) && !value.includes('#');
const round = (n) => Math.round(n * 1000) / 1000;
const pick = (object, keys) =>
  Object.fromEntries(
    keys.filter((key) => object[key] !== undefined).map((key) => [key, object[key]]),
  );

function inherited(dict, key) {
  for (let node = dict, depth = 0; node instanceof PDFDict && depth < 64; depth++) {
    const value = node.lookup(name(key));
    if (value !== undefined) return value;
    node = node.lookup(PARENT);
  }
}
const flagsOf = (dict) => inherited(dict, 'Ff')?.asNumber?.() ?? 0;
function setFlag(dict, flag, on) {
  const flags = flagsOf(dict);
  dict.set(name('Ff'), PDFNumber.of(on ? flags | flag : flags & ~flag));
}

/** Accept '#rgb', '#rrggbb', 0-1 component arrays and pdf-lib colors; null means none. */
export function colorComponents(value) {
  if (value === undefined) return undefined;
  if (value === null || value === 'none' || value === 'transparent') return null;
  if (typeof value === 'string') {
    let hex = value.trim().replace(/^#/, '');
    if (/^[\da-f]{3}$/i.test(hex)) hex = [...hex].map((c) => c + c).join('');
    if (!/^[\da-f]{6}$/i.test(hex)) throw new Error('Choose a valid color.');
    return [0, 2, 4].map((i) => round(parseInt(hex.slice(i, i + 2), 16) / 255));
  }
  if (Array.isArray(value) && [1, 3, 4].includes(value.length))
    return value.map((v) => {
      if (!Number.isFinite(v)) throw new Error('Choose a valid color.');
      return Math.max(0, Math.min(1, v));
    });
  if (value?.type === 'RGB') return [value.red, value.green, value.blue];
  if (value?.type === 'Grayscale') return [value.gray];
  if (value?.type === 'CMYK') return [value.cyan, value.magenta, value.yellow, value.key];
  throw new Error('Choose a valid color.');
}
/** '#rrggbb' for gray, RGB and CMYK components; null for none (an empty array). */
export function componentsHex(components) {
  if (!components?.length) return null;
  const [a, b, c, k] = components;
  const rgb =
    components.length === 1
      ? [a, a, a]
      : components.length === 4
        ? [a, b, c].map((v) => 1 - Math.min(1, v + k))
        : [a, b, c];
  return `#${rgb
    .map((v) =>
      Math.round(Math.max(0, Math.min(1, v || 0)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}
const colorOperator = (components) =>
  `${components.map(round).join(' ')} ${{ 1: 'g', 3: 'rg', 4: 'k' }[components.length]}`;

function normalizeBox(rect) {
  const { x, y, width, height } = rect || {};
  if (![x, y, width, height].every(Number.isFinite))
    throw new Error('Give the field a position and size.');
  const box = {
    x: Math.min(x, x + width),
    y: Math.min(y, y + height),
    width: Math.abs(width),
    height: Math.abs(height),
  };
  if (box.width < MIN_SIZE || box.height < MIN_SIZE)
    throw new Error('Make the field at least 4 points wide and tall.');
  return box;
}
function rectOf(dict) {
  const rect = dict.lookup(name('Rect'));
  const values =
    rect instanceof PDFArray && rect.size() === 4
      ? rect.asArray().map((v) => dict.context.lookup(v)?.asNumber?.())
      : [];
  if (values.length !== 4 || !values.every(Number.isFinite)) return null;
  const [x0, y0, x1, y1] = values;
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}

/* ---------- Fields, names and widgets ---------- */

function requireFields(doc) {
  const fields = formFields(doc);
  if (!fields) throw new Error(DAMAGED_FORM);
  return fields;
}
/** Viewer names: an unnamed ancestor contributes no part (as document.js reads them). */
function fullName(dict) {
  const parts = [];
  for (let node = dict, depth = 0; node instanceof PDFDict && depth < 64; depth++) {
    const part = textOf(node.lookup(name('T')));
    if (part !== undefined) parts.push(part);
    node = node.lookup(PARENT);
  }
  return parts.reverse().join('.');
}
function findField(doc, fieldName) {
  const field = requireFields(doc).find((f) => fullName(f.acroField.dict) === fieldName);
  if (!field) throw new Error(`There is no form field named "${fieldName}".`);
  return field;
}
/** Trimmed, dot-separated name parts; Acrobat treats each dot as a level of the hierarchy. */
function cleanName(value) {
  return String(value ?? '')
    .split('.')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('.');
}
/** Names that a new field can take: free of every field and of every group above them. */
function nameTaken(fields, except) {
  const terminals = new Set(),
    groups = new Set();
  for (const field of fields) {
    if (field === except) continue;
    const full = fullName(field.acroField.dict);
    terminals.add(full);
    const parts = full.split('.');
    for (let i = 1; i < parts.length; i++) groups.add(parts.slice(0, i).join('.'));
  }
  // The number of leading parts that name an existing field, which cannot hold others.
  const blocked = (parts) => {
    for (let i = 1; i < parts.length; i++) if (terminals.has(parts.slice(0, i).join('.'))) return i;
    return 0;
  };
  const taken = (candidate) =>
    terminals.has(candidate) || groups.has(candidate) || blocked(candidate.split('.')) > 0;
  taken.blocked = blocked;
  return taken;
}
/** `base`, or with _2, _3... on the last part (or on the part that names another field). */
function uniqueName(taken, base) {
  if (!taken(base)) return base;
  const parts = base.split('.');
  const at = (taken.blocked?.(parts) || parts.length) - 1;
  for (let n = 2; ; n++) {
    const next = parts.slice();
    next[at] = `${parts[at]}_${n}`;
    if (!taken(next.join('.'))) return next.join('.');
  }
}
function defaultName(type, fields) {
  const base = DEFAULT_NAMES[type];
  const taken = nameTaken(fields);
  for (let n = 1; ; n++) if (!taken(`${base}${n}`)) return `${base}${n}`;
}
/** Place a terminal field dictionary under its (possibly new) groups. */
function attachField(form, ref, dict, fieldName) {
  const parts = fieldName.split('.');
  const terminal = parts.pop();
  const [parent, parentRef] = form.findOrCreateNonTerminals(parts);
  dict.set(name('T'), textObject(terminal));
  if (parentRef) dict.set(PARENT, parentRef);
  else dict.delete(PARENT);
  parent.addField(ref);
}
/** Take a field (or emptied group) out of its parent's Kids, pruning groups left empty. */
function detachField(doc, ref, dict) {
  const acroForm = doc.catalog.lookup(name('AcroForm'));
  for (let depth = 0; depth < 64; depth++) {
    const parentRef = dict.get(PARENT);
    const parent = dict.lookup(PARENT);
    const owner = parent instanceof PDFDict ? parent : acroForm;
    const kids =
      owner instanceof PDFDict
        ? owner.lookup(parent instanceof PDFDict ? KIDS : name('Fields'))
        : undefined;
    const matches = (entry) => entry === ref || doc.context.lookup(entry) === dict;
    if (kids instanceof PDFArray)
      for (let i = kids.size() - 1; i >= 0; i--) if (matches(kids.get(i))) kids.remove(i);
    // Calculation order lists fields that compute values; a removed one must leave it too.
    const order = acroForm instanceof PDFDict ? acroForm.lookup(name('CO')) : undefined;
    if (order instanceof PDFArray)
      for (let i = order.size() - 1; i >= 0; i--) if (matches(order.get(i))) order.remove(i);
    dict.delete(PARENT);
    // A group left without fields goes too, as Acrobat leaves no empty groups behind.
    if (!(parent instanceof PDFDict) || (kids instanceof PDFArray && kids.size())) return;
    ref = parentRef;
    dict = parent;
  }
}
/** The page index of each annotation, by reference and by dictionary. */
function annotationPages(doc) {
  const pages = new Map();
  doc.getPages().forEach((page, index) => {
    for (const ref of annotationsOf(page)?.asArray() || [])
      for (const key of [ref, doc.context.lookup(ref)])
        if (key && !pages.has(key)) pages.set(key, index);
  });
  return pages;
}
/** Widgets of a field with the reference each is stored under. */
function widgetEntries(field) {
  const dict = field.acroField.dict;
  const kids = dict.lookup(KIDS);
  if (!(kids instanceof PDFArray)) return [{ dict, ref: field.ref, merged: true }];
  return kids
    .asArray()
    .map((ref) => ({ dict: dict.context.lookup(ref), ref }))
    .filter(({ dict }) => dict instanceof PDFDict);
}
function widgetPage(doc, entry, pages = annotationPages(doc)) {
  const page = pages.get(entry.ref) ?? pages.get(entry.dict);
  if (page !== undefined) return page;
  const p = entry.dict.get(name('P'));
  const index = p ? doc.getPages().findIndex((candidate) => candidate.ref === p) : -1;
  return index >= 0 ? index : null;
}
function fieldType(field) {
  if (field instanceof PDFTextField) return dateFormat(field.acroField.dict) ? 'date' : 'text';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFRadioGroup) return 'radio';
  if (field instanceof PDFDropdown) return 'dropdown';
  if (field instanceof PDFOptionList) return 'listbox';
  if (field instanceof PDFButton) return 'button';
  if (field instanceof PDFSignature) return 'signature';
  return 'unknown';
}

/* ---------- Fonts ---------- */

/** The AcroForm's default resources font dictionary, created on demand. */
function resourceFonts(doc) {
  const form = doc.getForm().acroForm.dict;
  let resources = form.lookup(name('DR'));
  if (!(resources instanceof PDFDict)) {
    resources = doc.context.obj({});
    form.set(name('DR'), resources);
  }
  let fonts = resources.lookup(name('Font'));
  if (!(fonts instanceof PDFDict)) {
    fonts = doc.context.obj({});
    resources.set(name('Font'), fonts);
  }
  return fonts;
}
const standardFonts = new WeakMap();
/**
 * A standard font registered in the form's DR under Acrobat's name (Helv, ZaDb...), usable
 * by pdf-lib's appearance code. An existing entry is reused only when it is the same
 * unembedded face and encoding, so other fields' drawings and DA keep their meaning.
 */
function formFont(doc, baseFont = 'Helvetica') {
  let cache = standardFonts.get(doc);
  if (!cache) standardFonts.set(doc, (cache = new Map()));
  if (cache.has(baseFont)) return cache.get(baseFont);
  const zapf = baseFont === 'ZapfDingbats';
  const fonts = resourceFonts(doc);
  const preferred = zapf ? 'ZaDb' : FORM_FONTS[baseFont];
  let key = preferred,
    ref;
  for (let n = 0; !ref; key = `${preferred}${++n}`) {
    const existing = fonts.lookup(name(key));
    if (existing === undefined) {
      ref = doc.context.register(
        doc.context.obj({
          Type: 'Font',
          Subtype: 'Type1',
          BaseFont: baseFont,
          ...(zapf ? {} : { Encoding: 'WinAnsiEncoding' }),
        }),
      );
      fonts.set(name(key), ref);
    } else if (
      existing instanceof PDFDict &&
      existing.lookup(name('Subtype')) === name('Type1') &&
      existing.lookup(name('BaseFont')) === name(baseFont) &&
      !existing.has(name('FontFile')) &&
      (zapf || existing.lookup(name('Encoding')) === name('WinAnsiEncoding'))
    ) {
      ref = fonts.get(name(key));
      if (!(ref instanceof PDFRef)) fonts.set(name(key), (ref = doc.context.register(existing)));
    }
    if (ref) break;
  }
  const font = PDFFont.of(ref, doc, StandardFontEmbedder.for(baseFont));
  // pdf-lib names DA and appearance resources after `font.name`.
  font.name = key;
  cache.set(baseFont, font);
  return font;
}
const encodable = (font, text) => {
  try {
    font.encodeText(text.replace(/[\r\n]/g, ''));
    return true;
  } catch {
    return false;
  }
};
/** The DA's font operand and size, resolving the DR entry to its base font. */
function daFont(doc, dict) {
  const acroForm = doc.catalog.lookup(name('AcroForm'));
  const da =
    textOf(inherited(dict, 'DA')) ??
    (acroForm instanceof PDFDict ? textOf(acroForm.lookup(name('DA'))) : undefined);
  let key, size;
  try {
    for (const { op, args } of parseContent(da || ''))
      if (op === 'Tf' && args[0]?.type === 'name') {
        key = args[0].value;
        size = args[1]?.value;
      }
  } catch {
    // An unreadable DA falls back to Helvetica at automatic size.
  }
  const resources = acroForm instanceof PDFDict ? acroForm.lookup(name('DR')) : undefined;
  const fonts = resources instanceof PDFDict ? resources.lookup(name('Font')) : undefined;
  const entry = key && fonts instanceof PDFDict ? fonts.lookup(name(key)) : undefined;
  const base =
    entry instanceof PDFDict ? entry.lookup(name('BaseFont'))?.decodeText?.() : undefined;
  const standard = Object.entries(FORM_FONTS).find(([, abbreviation]) => abbreviation === key)?.[0];
  return {
    key,
    size: Number.isFinite(size) ? size : 0,
    font: base in FORM_FONTS ? base : (standard ?? (base === 'ZapfDingbats' ? base : undefined)),
  };
}
/** Write a DA naming `font` (a PDFFont or DR key), keeping the parts not given. */
function writeDA(doc, dict, { font, size, color }) {
  const current = daFont(doc, dict);
  const defaults = readAppearanceDefaults({
    getDefaultAppearance: () => textOf(inherited(dict, 'DA')),
  });
  const components =
    color ?? (defaults.color ? colorComponents(componentsFromColor(defaults.color)) : [0]);
  const key = typeof font === 'string' ? font : (font?.name ?? current.key ?? 'Helv');
  const fontSize = size ?? current.size ?? 0;
  dict.set(name('DA'), PDFString.of(`/${key} ${round(fontSize)} Tf ${colorOperator(components)}`));
}
function componentsFromColor(color) {
  if (color.type === 'Grayscale') return [color.gray];
  if (color.type === 'CMYK') return [color.cyan, color.magenta, color.yellow, color.key];
  return [color.red, color.green, color.blue];
}
/** The texts a field's drawing must encode, to choose between the standard font and Noto. */
function appearanceTexts(field) {
  if (field instanceof PDFTextField) return [textValue(field)];
  if (field instanceof PDFOptionList) return choiceOptions(field).map((o) => o.label);
  if (field instanceof PDFDropdown) {
    const options = choiceOptions(field);
    return choiceValues(field).map((v) => options.find((o) => o.value === v)?.label ?? v);
  }
  if (field instanceof PDFButton)
    return field.acroField
      .getWidgets()
      .map((w) => Object.values(w.getAppearanceCharacteristics()?.getCaptions() ?? {}).join(''));
  return [];
}

/* ---------- Appearances ---------- */

function appearanceStream(doc, operators, width, height, resources) {
  return doc.context.register(
    doc.context.formXObject(operators, {
      BBox: doc.context.obj([0, 0, width, height]),
      Matrix: doc.context.obj([1, 0, 0, 1, 0, 0]),
      ...(resources ? { Resources: resources } : {}),
    }),
  );
}
function widgetGeometry(widget) {
  const rectangle = widget.getRectangle();
  const rect = rectOf(widget.dict) ?? rectangle;
  const characteristics = widget.getAppearanceCharacteristics();
  const rotation = reduceRotation(characteristics?.getRotation());
  const { width, height } = adjustDimsForRotation(rect, rotation);
  return {
    rect,
    rotate: rotateInPlace({ ...rect, rotation }),
    width,
    height,
    borderWidth: widget.getBorderStyle()?.getWidth() ?? 0,
    borderColor: componentsToColor(characteristics?.getBorderColor()),
    background: characteristics?.getBackgroundColor(),
    caption: characteristics?.getCaptions()?.normal,
  };
}
/** The on-state of a check box or radio widget, also before it has any drawing. */
function onState(widget, fallback = 'Yes') {
  const on = widget.getOnValue();
  if (on) return on;
  const state = widget.dict.lookup(name('AS'));
  return state instanceof PDFName && state !== OFF ? state : name(fallback);
}
/**
 * Draw check boxes and radio buttons as Acrobat does: the border and background, and in the
 * on state the style's ZapfDingbats character in the DA color (auto size fits the box).
 */
function drawToggleField(doc, field) {
  const radio = field instanceof PDFRadioGroup;
  const acro = field.acroField;
  const zapf = formFont(doc, 'ZapfDingbats');
  const value = inherited(acro.dict, 'V') ?? inherited(acro.dict, 'DV');
  for (const widget of acro.getWidgets()) {
    const g = widgetGeometry(widget);
    const style = readAppearanceDefaults(widget).color
      ? readAppearanceDefaults(widget)
      : readAppearanceDefaults(acro);
    const markColor = style.color ?? componentsToColor([0]);
    const glyph =
      Object.values(BUTTON_STYLES).find(({ char }) => char === g.caption) ??
      BUTTON_STYLES[radio ? 'circle' : 'check'];
    const inner = Math.max(1, Math.min(g.width, g.height) - 2 * g.borderWidth);
    const auto = radio && glyph.char === 'l' ? inner * 0.55 : inner * (radio ? 0.6 : 0.8);
    const size = style.fontSize > 0 ? style.fontSize : auto;
    const glyphWidth = (glyph.width / 1000) * size;
    // ZapfDingbats marks sit between about -0.014 and 0.705 em; center that box.
    const mark = [
      pushGraphicsState(),
      setFillingColor(markColor),
      beginText(),
      setFontAndSize(zapf.name, size),
      moveText(round((g.width - glyphWidth) / 2), round(g.height / 2 - 0.345 * size)),
      showText(PDFString.of(glyph.char)),
      endText(),
      popGraphicsState(),
    ];
    const frame = (background) => {
      const color = componentsToColor(background);
      if (radio) {
        const radius = Math.max(0, (Math.min(g.width, g.height) - g.borderWidth) / 2);
        return drawEllipse({
          x: g.width / 2,
          y: g.height / 2,
          xScale: radius,
          yScale: radius,
          color,
          borderColor: g.borderWidth ? g.borderColor : undefined,
          borderWidth: g.borderWidth,
        });
      }
      return drawRectangle({
        x: g.borderWidth / 2,
        y: g.borderWidth / 2,
        width: g.width - g.borderWidth,
        height: g.height - g.borderWidth,
        borderWidth: g.borderWidth,
        color,
        borderColor: g.borderWidth ? g.borderColor : undefined,
        rotate: { type: 'degrees', angle: 0 },
        xSkew: { type: 'degrees', angle: 0 },
        ySkew: { type: 'degrees', angle: 0 },
      });
    };
    // Pressed buttons darken their background, or show Acrobat's gray when they have none.
    const down = g.background?.length ? g.background.map((v) => v * 0.8) : [0.75];
    const fonts = doc.context.obj({ Font: { [zapf.name]: zapf.ref } });
    const on = onState(widget, radio ? '0' : 'Yes');
    const states = (background) => {
      const dict = doc.context.obj({});
      dict.set(
        on,
        appearanceStream(
          doc,
          [...g.rotate, ...frame(background), ...mark],
          g.rect.width,
          g.rect.height,
          fonts,
        ),
      );
      dict.set(
        OFF,
        appearanceStream(doc, [...g.rotate, ...frame(background)], g.rect.width, g.rect.height),
      );
      return dict;
    };
    widget.dict.set(name('AP'), doc.context.obj({ N: states(g.background), D: states(down) }));
    widget.setAppearanceState(value === on ? on : OFF);
  }
}
/** An unsigned signature field shows its border and background, as Acrobat draws it. */
function drawSignatureField(doc, field) {
  for (const widget of field.acroField.getWidgets()) {
    const g = widgetGeometry(widget);
    const operators = [
      ...g.rotate,
      ...drawRectangle({
        x: g.borderWidth / 2,
        y: g.borderWidth / 2,
        width: g.width - g.borderWidth,
        height: g.height - g.borderWidth,
        borderWidth: g.borderWidth,
        color: componentsToColor(g.background),
        borderColor: g.borderWidth ? g.borderColor : undefined,
        rotate: { type: 'degrees', angle: 0 },
        xSkew: { type: 'degrees', angle: 0 },
        ySkew: { type: 'degrees', angle: 0 },
      }),
    ];
    widget.dict.set(
      name('AP'),
      doc.context.obj({
        N: appearanceStream(doc, operators, g.rect.width, g.rect.height),
      }),
    );
  }
}
/**
 * Regenerate every widget's drawing. Text, choice and push button fields use the fill tools'
 * appearance code with the DA's standard font, or the bundled Noto face when the content needs
 * characters a standard font lacks (that face is then also added to DR for later editing).
 */
async function refreshAppearances(doc, field) {
  if (field instanceof PDFCheckBox || field instanceof PDFRadioGroup)
    return drawToggleField(doc, field);
  if (field instanceof PDFSignature) return drawSignatureField(doc, field);
  const current = daFont(doc, field.acroField.dict);
  let font = formFont(doc, FORM_FONTS[current.font] ? current.font : 'Helvetica');
  const text = appearanceTexts(field).join('\n');
  if (!encodable(font, text)) {
    font = await embedFont(doc, 'regular', text);
    resourceFonts(doc).set(name(font.name), font.ref);
  }
  writeDA(doc, field.acroField.dict, { font });
  updateFieldAppearance(field, doc.getForm(), font);
}

/* ---------- Actions ---------- */

const javascript = (doc, script) => doc.context.obj({ S: 'JavaScript', JS: textObject(script) });
const EMAIL_CHECK =
  'if (event.value && !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(event.value)) ' +
  '{ app.alert("Enter a valid email address."); event.rc = false; }';
const SPECIAL = { zip: 0, zip4: 1, phone: 2, ssn: 3 };
/**
 * Acrobat's own format scripts (AFNumber_, AFPercent_, AFDate_, AFSpecial_), which Acrobat
 * shows in its Format tab. Readers without JavaScript simply accept any text.
 */
function setFormat(doc, dict, { format, decimals = 2, dateFormat: pattern = 'mm/dd/yyyy' }) {
  // A script written by hand elsewhere stays as it is unless a format replaces it.
  if (format === 'custom' || format === 'special') return;
  const actions =
    dict.lookup(name('AA')) instanceof PDFDict ? dict.lookup(name('AA')) : doc.context.obj({});
  for (const key of ['F', 'K', 'V']) actions.delete(name(key));
  const quoted = JSON.stringify(String(pattern));
  const places = Math.max(0, Math.min(10, Math.trunc(decimals)));
  const scripts = {
    number: [
      `AFNumber_Format(${places}, 0, 0, 0, "", true);`,
      `AFNumber_Keystroke(${places}, 0, 0, 0, "", true);`,
    ],
    percent: [`AFPercent_Format(${places}, 0);`, `AFPercent_Keystroke(${places}, 0);`],
    date: [`AFDate_FormatEx(${quoted});`, `AFDate_KeystrokeEx(${quoted});`],
  }[format];
  if (scripts) {
    actions.set(name('F'), javascript(doc, scripts[0]));
    actions.set(name('K'), javascript(doc, scripts[1]));
  } else if (format in SPECIAL) {
    actions.set(name('F'), javascript(doc, `AFSpecial_Format(${SPECIAL[format]});`));
    actions.set(name('K'), javascript(doc, `AFSpecial_Keystroke(${SPECIAL[format]});`));
  } else if (format === 'email') actions.set(name('V'), javascript(doc, EMAIL_CHECK));
  else if (format && format !== 'none') throw new Error('Choose a supported field format.');
  if (actions.entries().length) dict.set(name('AA'), actions);
  else dict.delete(name('AA'));
}
function actionScript(dict, key) {
  const action = dict.lookup(name('AA'))?.lookup?.(name(key));
  const script = action instanceof PDFDict ? action.lookup(name('JS')) : undefined;
  if (script instanceof PDFStream) {
    try {
      return new TextDecoder().decode(script.getContents?.() ?? new Uint8Array());
    } catch {
      return undefined;
    }
  }
  return textOf(script);
}
function dateFormat(dict) {
  return actionScript(dict, 'F')?.match(/AFDate_Format(?:Ex)?\(\s*"([^"]*)"/)?.[1];
}
function readFormat(dict) {
  const script = actionScript(dict, 'F') ?? '';
  const date = dateFormat(dict);
  if (date !== undefined) return { format: 'date', dateFormat: date };
  let match = script.match(/AFNumber_Format\(\s*(\d+)/);
  if (match) return { format: 'number', decimals: Number(match[1]) };
  match = script.match(/AFPercent_Format\(\s*(\d+)/);
  if (match) return { format: 'percent', decimals: Number(match[1]) };
  match = script.match(/AFSpecial_Format\(\s*(\d)/);
  if (match) return { format: Object.keys(SPECIAL)[Number(match[1])] ?? 'special' };
  if (actionScript(dict, 'V')?.includes('valid email')) return { format: 'email' };
  return { format: script ? 'custom' : 'none' };
}
function setButtonAction(doc, widget, action) {
  if (action === 'reset') widget.set(name('A'), doc.context.obj({ S: 'ResetForm' }));
  else if (action === 'print') widget.set(name('A'), doc.context.obj({ S: 'Named', N: 'Print' }));
  else if (!action || action === 'none') widget.delete(name('A'));
  else throw new Error('Choose a supported button action.');
}
function readButtonAction(widget, field) {
  const action = widget.lookup(name('A')) ?? field.lookup(name('A'));
  if (!(action instanceof PDFDict)) return 'none';
  const type = action.lookup(name('S'));
  if (type === name('ResetForm')) return 'reset';
  if (type === name('Named') && action.lookup(name('N')) === name('Print')) return 'print';
  if (type === name('JavaScript') && /\bprint\s*\(/.test(textOf(action.lookup(name('JS'))) ?? ''))
    return 'print';
  return 'other';
}

/* ---------- Choice options ---------- */

function normalizeOptions(options) {
  if (!Array.isArray(options)) throw new Error('Give the list its options.');
  const list = options.map((option) => {
    const value = String(typeof option === 'object' && option ? option.value : option);
    const label = String(
      typeof option === 'object' && option ? (option.label ?? option.value) : option,
    );
    return { value, label };
  });
  if (list.some(({ value }) => !value)) throw new Error('Options cannot be empty.');
  if (new Set(list.map(({ value }) => value)).size !== list.length)
    throw new Error('Each option needs a different export value.');
  return list;
}
function writeOptions(doc, dict, options, sorted) {
  const rows = sorted
    ? options.slice().sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    : options;
  dict.set(
    name('Opt'),
    doc.context.obj(
      rows.map(({ value, label }) =>
        value === label
          ? textObject(value)
          : doc.context.obj([textObject(value), textObject(label)]),
      ),
    ),
  );
  dict.delete(name('TI'));
}
/** Store a choice selection as V (and DV), with I for several selected rows. */
function writeChoiceValue(doc, dict, values, { initial = true } = {}) {
  const options = choiceOptionsOf(dict);
  for (const value of values)
    if (!options.some((o) => o.value === value) && !(flagsOf(dict) & EDIT))
      throw new Error('Choose one of the available options.');
  const object = values.length
    ? values.length === 1
      ? textObject(values[0])
      : doc.context.obj(values.map(textObject))
    : undefined;
  for (const key of initial ? ['V', 'DV'] : ['V']) {
    if (object) dict.set(name(key), object);
    else dict.delete(name(key));
  }
  const indices = values.map((v) => options.findIndex((o) => o.value === v)).sort((a, b) => a - b);
  if (indices.length > 1 && indices.every((i) => i >= 0))
    dict.set(name('I'), doc.context.obj(indices));
  else dict.delete(name('I'));
}
function choiceOptionsOf(dict) {
  const opt = inherited(dict, 'Opt');
  if (!(opt instanceof PDFArray)) return [];
  return opt.asArray().flatMap((entry) => {
    const item = dict.context.lookup(entry);
    if (item instanceof PDFArray) {
      const value = textOf(item.lookup(0)),
        label = textOf(item.lookup(1));
      return value === undefined ? [] : [{ value, label: label ?? value }];
    }
    const value = textOf(item);
    return value === undefined ? [] : [{ value, label: value }];
  });
}

/* ---------- Check box and radio exports ---------- */

/** Export values of a button field's widgets, in widget order. */
function buttonExports(field) {
  const opt = inherited(field.acroField.dict, 'Opt');
  return field.acroField.getWidgets().map((widget, index) => {
    const exported = opt instanceof PDFArray ? textOf(opt.lookup(index)) : undefined;
    return exported ?? onState(widget).decodeText();
  });
}
/**
 * Give one widget of a check box or radio field an export value. Plain names serve as the
 * on-state directly; other text goes through Opt with index states, which pdf-lib, PDF.js and
 * Acrobat all read. Returns the widget's on-state name.
 */
function setWidgetExport(doc, field, index, value) {
  if (value === 'Off') throw new Error('Choose an export value other than Off.');
  const dict = field.acroField.dict;
  const widgets = field.acroField.getWidgets();
  const exports = buttonExports(field);
  exports[index] = value;
  let opt = inherited(dict, 'Opt');
  if (!(opt instanceof PDFArray) && !nameSafe(value)) opt = doc.context.obj([]);
  if (opt instanceof PDFArray) {
    // Own the export list before changing it, then fill it for every widget.
    dict.set(name('Opt'), doc.context.obj(exports.map(textObject)));
    const used = new Set(widgets.map((w, i) => (i === index ? null : onState(w).decodeText())));
    // Widgets with equal exports share their state, so they switch on together.
    const twin = exports.findIndex((other, i) => i !== index && other === value);
    if (twin >= 0) return onState(widgets[twin]);
    let state = String(index);
    for (let n = index + 1; used.has(state); n++) state = String(n);
    return name(state);
  }
  return name(value);
}
/** Rename a widget's on state, keeping the field's value and the widget's state in step. */
function renameState(doc, field, widget, next) {
  const previous = onState(widget, field instanceof PDFRadioGroup ? '0' : 'Yes');
  if (previous === next) return;
  const dict = field.acroField.dict;
  const shared = field.acroField
    .getWidgets()
    .filter((w) => w.dict !== widget.dict && onState(w) === previous);
  for (const key of ['V', 'DV'])
    if (dict.lookup(name(key)) === previous && !shared.length) dict.set(name(key), next);
  const appearances = widget.dict.lookup(name('AP'));
  if (appearances instanceof PDFDict)
    for (const kind of ['N', 'D', 'R']) {
      const states = appearances.lookup(name(kind));
      if (states instanceof PDFDict && states.has(previous)) {
        states.set(next, states.get(previous));
        states.delete(previous);
      }
    }
  else widget.dict.set(name('AP'), doc.context.obj({ N: { [next.decodeText()]: null } }));
  if (widget.dict.lookup(name('AS')) === previous) widget.dict.set(name('AS'), next);
}

/* ---------- Widgets ---------- */

const DEFAULT_STYLE = {
  borderColor: [0],
  backgroundColor: null,
  borderWidth: 1,
};
/** MK (colors, rotation, caption) and BS (border) for a widget, keeping what is not given. */
function styleWidget(doc, widget, props, page) {
  let mk = widget.lookup(name('MK'));
  if (!(mk instanceof PDFDict)) widget.set(name('MK'), (mk = doc.context.obj({})));
  const border = colorComponents(props.borderColor);
  const background = colorComponents(props.backgroundColor);
  // An empty color array is "transparent" (ISO 32000-1 Table 189); deleting keeps it absent.
  if (border !== undefined)
    border ? mk.set(name('BC'), doc.context.obj(border)) : mk.delete(name('BC'));
  if (background !== undefined)
    background ? mk.set(name('BG'), doc.context.obj(background)) : mk.delete(name('BG'));
  // Fields read upright on a turned page when the widget turns with it, as Acrobat sets R.
  if (page) mk.set(name('R'), PDFNumber.of(pageRotation(page)));
  if (props.caption !== undefined) mk.set(name('CA'), textObject(String(props.caption)));
  if (props.borderWidth !== undefined) {
    const width = Number(props.borderWidth);
    if (!(width >= 0 && width <= 12)) throw new Error('Choose a border width from 0 to 12.');
    let bs = widget.lookup(name('BS'));
    if (!(bs instanceof PDFDict)) widget.set(name('BS'), (bs = doc.context.obj({})));
    bs.set(name('W'), PDFNumber.of(width));
    bs.set(name('S'), name('S'));
  }
}
/** Make `widget` a printable widget annotation on `page`, styled with the defaults. */
function initWidget(doc, widget, page, rect, props) {
  widget.set(name('Type'), name('Annot'));
  widget.set(name('Subtype'), name('Widget'));
  widget.set(
    name('Rect'),
    doc.context.obj([rect.x, rect.y, rect.x + rect.width, rect.y + rect.height].map(round)),
  );
  widget.set(name('P'), page.ref);
  widget.set(name('F'), PDFNumber.of(PRINT_FLAG));
  styleWidget(doc, widget, { ...DEFAULT_STYLE, ...props }, page);
}
/** A separate widget (a radio button) under `fieldRef`, listed on its page. */
function createWidget(doc, page, fieldRef, rect, props) {
  const widget = doc.context.obj({ Parent: fieldRef });
  initWidget(doc, widget, page, rect, props);
  const ref = doc.context.register(widget);
  annotationList(page).push(ref);
  return ref;
}
function wrapField(doc, ref) {
  const field = requireFields(doc).find((f) => f.ref === ref);
  if (!field) throw new Error(DAMAGED_FORM);
  return field;
}
function glyphFor(style, radio) {
  const chosen = style ?? (radio ? 'circle' : 'check');
  if (!BUTTON_STYLES[chosen]) throw new Error('Choose a supported button style.');
  return BUTTON_STYLES[chosen].char;
}

/* ---------- Field properties ---------- */

function validateText(props) {
  if (props.maxLength !== undefined && props.maxLength !== null) {
    if (!Number.isInteger(props.maxLength) || props.maxLength < 1 || props.maxLength > 32767)
      throw new Error('Choose a character limit of at least 1.');
  }
  if (props.alignment !== undefined && !ALIGNMENTS.includes(props.alignment))
    throw new Error('Choose left, center or right alignment.');
  if (props.fontSize !== undefined && props.fontSize !== 'auto')
    if (!(Number(props.fontSize) >= 0 && Number(props.fontSize) <= 300))
      throw new Error('Choose a font size from 0 (auto) to 300.');
  if (props.font !== undefined && !FORM_FONTS[props.font])
    throw new Error('Choose one of the standard form fonts.');
}
/** Apply field-level properties shared by every widget of a field. */
function applyFieldProps(doc, field, props) {
  const dict = field.acroField.dict;
  validateText(props);
  if (props.tooltip !== undefined)
    props.tooltip
      ? dict.set(name('TU'), textObject(String(props.tooltip)))
      : dict.delete(name('TU'));
  if (props.required !== undefined) setFlag(dict, REQUIRED, !!props.required);
  if (props.readOnly !== undefined) setFlag(dict, READ_ONLY, !!props.readOnly);
  if (props.font !== undefined || props.fontSize !== undefined || props.textColor !== undefined) {
    const size = props.fontSize === 'auto' ? 0 : props.fontSize;
    const font = props.font
      ? formFont(doc, props.font)
      : field instanceof PDFCheckBox || field instanceof PDFRadioGroup
        ? formFont(doc, 'ZapfDingbats')
        : undefined;
    writeDA(doc, dict, {
      font,
      size: size === undefined ? undefined : Number(size),
      color: colorComponents(props.textColor) ?? undefined,
    });
  }
  if (field instanceof PDFTextField) {
    if (props.multiline !== undefined) setFlag(dict, MULTILINE, !!props.multiline);
    if (props.password !== undefined) setFlag(dict, PASSWORD, !!props.password);
    if (props.spellcheck !== undefined) setFlag(dict, DO_NOT_SPELL_CHECK, !props.spellcheck);
    if (props.scroll !== undefined) setFlag(dict, DO_NOT_SCROLL, !props.scroll);
    if (props.maxLength !== undefined)
      props.maxLength === null
        ? dict.delete(name('MaxLen'))
        : dict.set(name('MaxLen'), PDFNumber.of(props.maxLength));
    if (props.comb !== undefined) setFlag(dict, COMB, !!props.comb);
    const flags = flagsOf(dict);
    if (flags & COMB) {
      // Comb fields divide the box into MaxLen cells; viewers ignore Comb with these flags.
      if (!(inherited(dict, 'MaxLen')?.asNumber?.() > 0))
        throw new Error('Set a character limit to divide the field into boxes.');
      if (flags & (MULTILINE | PASSWORD))
        throw new Error('A field divided into boxes cannot be multi-line or a password.');
      setFlag(dict, DO_NOT_SCROLL, true);
    }
    if (props.alignment !== undefined)
      dict.set(name('Q'), PDFNumber.of(ALIGNMENTS.indexOf(props.alignment)));
    if (
      props.format !== undefined ||
      props.dateFormat !== undefined ||
      props.decimals !== undefined
    )
      setFormat(doc, dict, {
        ...readFormat(dict),
        ...pick(props, ['format', 'decimals', 'dateFormat']),
      });
    if (props.defaultValue !== undefined) {
      const text = String(props.defaultValue ?? '');
      const limit = inherited(dict, 'MaxLen')?.asNumber?.();
      if (limit && Array.from(text).length > limit)
        throw new Error('The default value is longer than the character limit.');
      for (const key of ['V', 'DV'])
        text ? dict.set(name(key), textObject(text)) : dict.delete(name(key));
      dict.delete(name('RV'));
    }
  }
  if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    if (props.editable !== undefined && field instanceof PDFDropdown)
      setFlag(dict, EDIT, !!props.editable);
    if (props.multiSelect !== undefined && field instanceof PDFOptionList)
      setFlag(dict, MULTI_SELECT, !!props.multiSelect);
    if (props.spellcheck !== undefined) setFlag(dict, DO_NOT_SPELL_CHECK, !props.spellcheck);
    if (props.sorted !== undefined) setFlag(dict, SORT, !!props.sorted);
    const listChanged = props.options !== undefined || props.sorted !== undefined;
    if (listChanged) {
      const options =
        props.options !== undefined ? normalizeOptions(props.options) : choiceOptionsOf(dict);
      // Acrobat keeps a sorted list's items in order in Opt itself.
      writeOptions(doc, dict, options, !!(flagsOf(dict) & SORT));
    }
    if (props.defaultValue !== undefined) {
      const values = [props.defaultValue]
        .flat()
        .filter((v) => v != null && v !== '')
        .map(String);
      if (values.length > 1 && !(flagsOf(dict) & MULTI_SELECT))
        throw new Error('This list accepts one selection.');
      writeChoiceValue(doc, dict, values);
    } else if (listChanged) {
      // Keep the selection that is still on the list, with indices into the new order.
      const value = inherited(dict, 'V');
      const current = (
        value instanceof PDFArray
          ? value.asArray().map((e) => textOf(dict.context.lookup(e)))
          : [textOf(value)]
      ).filter((v) => v !== undefined);
      const options = choiceOptionsOf(dict);
      writeChoiceValue(
        doc,
        dict,
        current.filter((v) => flagsOf(dict) & EDIT || options.some((o) => o.value === v)),
      );
    }
  }
}

/* ---------- Public API ---------- */

/**
 * Add a form field with one widget on page `pageIndex`, and return its full name.
 *
 * `type`: text | date | checkbox | radio | dropdown | listbox | button | signature.
 * Common props: tooltip, required, readOnly, borderColor, backgroundColor (hex or null),
 * borderWidth, textColor, font (a FORM_FONTS name), fontSize (0 or 'auto' fits the box).
 * text/date: multiline, password, comb + maxLength, alignment, defaultValue, spellcheck,
 *   scroll, format (number | percent | date | zip | zip4 | phone | ssn | email | none),
 *   decimals, dateFormat (date fields default to "mm/dd/yyyy").
 * checkbox: exportValue ('Yes'), checked, style (check | cross | circle | square | star |
 *   diamond). radio: the same; an existing radio group name adds this button to the group.
 * dropdown/listbox: options (strings or { value, label }), defaultValue (array for multiple),
 *   editable, sorted, multiSelect (listbox).
 * button: label, action (reset | print | none). signature: an empty Acrobat signature field.
 * A name already in use gets _2, _3... (radio groups join instead).
 */
export async function addFormField(doc, pageIndex, { type, name: requested, rect, ...props } = {}) {
  if (!DEFAULT_NAMES[type]) throw new Error('Choose a supported field type.');
  // Check everything that can fail before the document changes.
  validateText(props);
  if (props.comb && !props.maxLength)
    throw new Error('Set a character limit to divide the field into boxes.');
  if (props.comb && (props.multiline || props.password))
    throw new Error('A field divided into boxes cannot be multi-line or a password.');
  if (type === 'dropdown' || type === 'listbox') {
    const options = normalizeOptions(props.options ?? []);
    const values = [props.defaultValue ?? []].flat().map(String);
    if (!props.editable && values.some((v) => v && !options.some((o) => o.value === v)))
      throw new Error('Choose one of the available options.');
  }
  if (props.style !== undefined) glyphFor(props.style, type === 'radio');
  if (['checkbox', 'radio'].includes(type) && props.exportValue === 'Off')
    throw new Error('Choose an export value other than Off.');
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= doc.getPageCount())
    throw new Error('That page does not exist.');
  const page = doc.getPage(pageIndex);
  const box = normalizeBox(rect);
  const fields = requireFields(doc);
  const form = doc.getForm();
  const wanted = cleanName(requested);
  const radio = type === 'radio';
  if (radio && wanted) {
    const group = fields.find(
      (f) => f instanceof PDFRadioGroup && fullName(f.acroField.dict) === wanted,
    );
    if (group) {
      await addRadioButton(doc, page, group, box, props);
      return wanted;
    }
  }
  const fieldName = wanted ? uniqueName(nameTaken(fields), wanted) : defaultName(type, fields);
  const context = doc.context;
  const dict = context.obj({});
  const ref = context.register(dict);
  const helv = formFont(doc, props.font ?? 'Helvetica');
  const daColor = colorComponents(props.textColor) ?? [0];
  const size =
    props.fontSize === 'auto' || props.fontSize === undefined ? 0 : Number(props.fontSize);
  if (type === 'text' || type === 'date') {
    dict.set(name('FT'), name('Tx'));
    dict.set(name('Ff'), PDFNumber.of(0));
    // Comb cells size their characters to the cells; other text starts at Acrobat's 12 pt.
    const initial = props.fontSize === undefined && !props.comb ? 12 : size;
    writeDA(doc, dict, { font: helv, size: initial, color: daColor });
    if (type === 'date') props = { format: 'date', ...props };
  } else if (type === 'checkbox' || radio) {
    dict.set(name('FT'), name('Btn'));
    dict.set(name('Ff'), PDFNumber.of(radio ? RADIO | NO_TOGGLE_TO_OFF : 0));
    writeDA(doc, dict, {
      font: formFont(doc, 'ZapfDingbats'),
      size,
      color: daColor,
    });
    dict.set(name('V'), OFF);
  } else if (type === 'dropdown' || type === 'listbox') {
    dict.set(name('FT'), name('Ch'));
    dict.set(name('Ff'), PDFNumber.of(type === 'dropdown' ? COMBO : 0));
    writeDA(doc, dict, {
      font: helv,
      size: props.fontSize === undefined ? 12 : size,
      color: daColor,
    });
    props = { options: [], ...props };
  } else if (type === 'button') {
    dict.set(name('FT'), name('Btn'));
    dict.set(name('Ff'), PDFNumber.of(PUSH_BUTTON));
    writeDA(doc, dict, { font: helv, size, color: daColor });
  } else dict.set(name('FT'), name('Sig'));
  const widgetProps = {
    ...(type === 'button' ? { backgroundColor: [0.75], caption: props.label ?? '' } : {}),
    ...(type === 'checkbox' ? { caption: glyphFor(props.style, false) } : {}),
    ...pick(props, ['borderColor', 'backgroundColor', 'borderWidth']),
  };
  // Like Acrobat, a field with one widget is one dictionary: viewers such as PDF.js read the
  // tooltip (TU) and actions from the widget itself. Radio groups keep their buttons as Kids.
  if (radio) dict.set(KIDS, context.obj([]));
  else initWidget(doc, dict, page, box, widgetProps);
  attachField(form, ref, dict, fieldName);
  if (!radio) annotationList(page).push(ref);
  const field = wrapField(doc, ref);
  applyFieldProps(doc, field, {
    ...props,
    font: undefined,
    fontSize: undefined,
    textColor: undefined,
  });
  if (radio) {
    await addRadioButton(doc, page, field, box, props);
    return fieldName;
  }
  if (type === 'button') setButtonAction(doc, dict, props.action);
  if (type === 'checkbox') {
    const widget = field.acroField.getWidgets()[0];
    const state = setWidgetExport(doc, field, 0, String(props.exportValue || 'Yes'));
    widget.dict.set(name('AP'), context.obj({ N: { [state.decodeText()]: null } }));
    widget.dict.set(name('AS'), OFF);
    if (props.checked) for (const key of ['V', 'DV']) dict.set(name(key), state);
  }
  await refreshAppearances(doc, field);
  return fieldName;
}

async function addRadioButton(doc, page, group, box, props) {
  const dict = group.acroField.dict;
  if (!(dict.lookup(KIDS) instanceof PDFArray)) {
    // A single merged field/widget dictionary cannot gain a sibling; split it first.
    throw new Error('This radio group cannot take more buttons.');
  }
  const index = group.acroField.getWidgets().length;
  const widgetRef = createWidget(doc, page, group.ref, box, {
    caption: glyphFor(props.style, true),
    ...pick(props, ['borderColor', 'backgroundColor', 'borderWidth']),
  });
  dict.lookup(KIDS).push(widgetRef);
  const value = String(props.exportValue || `Choice${index + 1}`);
  const state = setWidgetExport(doc, group, index, value);
  const widget = doc.context.lookup(widgetRef);
  widget.set(name('AP'), doc.context.obj({ N: { [state.decodeText()]: null } }));
  widget.set(name('AS'), OFF);
  if (props.checked) for (const key of ['V', 'DV']) dict.set(name(key), state);
  await refreshAppearances(doc, group);
}

function widgetProps(doc, field, widget, index) {
  const dict = field.acroField.dict;
  const flags = flagsOf(dict);
  const mk = widget.getAppearanceCharacteristics();
  const da = daFont(doc, widget.dict.has(name('DA')) ? widget.dict : dict);
  const style = readAppearanceDefaults(widget.dict.has(name('DA')) ? widget : field.acroField);
  const props = {
    tooltip: textOf(dict.lookup(name('TU'))) ?? '',
    required: !!(flags & REQUIRED),
    readOnly: !!(flags & READ_ONLY),
    borderColor: componentsHex(mk?.getBorderColor()),
    backgroundColor: componentsHex(mk?.getBackgroundColor()),
    borderWidth: widget.getBorderStyle()?.getWidth() ?? (mk?.getBorderColor()?.length ? 1 : 0),
    textColor: style.color ? componentsHex(componentsFromColor(style.color)) : '#000000',
    fontSize: style.fontSize ?? 0,
    font: da.font ?? null,
    rotation: reduceRotation(mk?.getRotation() ?? 0),
    hidden: !!((widget.dict.lookup(name('F'))?.asNumber?.() ?? 0) & 2),
  };
  if (field instanceof PDFTextField) {
    const value = textValue(field);
    const defaultValue = textOf(inherited(dict, 'DV'));
    const q = inherited(dict, 'Q')?.asNumber?.() ?? 0;
    return Object.assign(props, {
      value,
      defaultValue: defaultValue ?? '',
      multiline: !!(flags & MULTILINE),
      password: !!(flags & PASSWORD),
      comb: !!(flags & COMB),
      maxLength: inherited(dict, 'MaxLen')?.asNumber?.() ?? null,
      alignment: ALIGNMENTS[q] ?? 'left',
      spellcheck: !(flags & DO_NOT_SPELL_CHECK),
      scroll: !(flags & DO_NOT_SCROLL),
      ...readFormat(dict),
    });
  }
  if (field instanceof PDFCheckBox || field instanceof PDFRadioGroup) {
    const on = onState(widget, field instanceof PDFRadioGroup ? '0' : 'Yes');
    const value = inherited(dict, 'V');
    const caption = mk?.getCaptions()?.normal;
    return Object.assign(props, {
      exportValue: buttonExports(field)[index],
      checked: value === on,
      checkedByDefault: inherited(dict, 'DV') === on,
      style:
        Object.entries(BUTTON_STYLES).find(([, { char }]) => char === caption)?.[0] ??
        (field instanceof PDFRadioGroup ? 'circle' : 'check'),
    });
  }
  if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    const selected = choiceValues(field);
    const defaults = inherited(dict, 'DV');
    return Object.assign(props, {
      options: choiceOptions(field),
      value: selected,
      defaultValue:
        defaults instanceof PDFArray
          ? defaults.asArray().map((e) => textOf(dict.context.lookup(e)))
          : [textOf(defaults)].filter((v) => v !== undefined),
      editable: field instanceof PDFDropdown && !!(flags & EDIT),
      sorted: !!(flags & SORT),
      multiSelect: !!(flags & MULTI_SELECT),
      spellcheck: !(flags & DO_NOT_SPELL_CHECK),
    });
  }
  if (field instanceof PDFButton)
    return Object.assign(props, {
      label: mk?.getCaptions()?.normal ?? '',
      action: readButtonAction(widget.dict, dict),
    });
  if (field instanceof PDFSignature)
    return Object.assign(props, {
      signed: dict.lookup(name('V')) instanceof PDFDict,
    });
  return props;
}

/**
 * Every widget of every form field, in field order: `{ name, type, page, rect, widgetIndex,
 * props }`. `page` is a 0-based index (null when no page lists the widget), `rect` is in
 * unrotated user space. Radio button widgets report their own export value.
 */
export function listFormFields(doc) {
  const fields = requireFields(doc);
  if (!fields.length) return [];
  const pages = annotationPages(doc);
  return fields.flatMap((field) => {
    const type = fieldType(field);
    const fieldName = fullName(field.acroField.dict);
    const entries = widgetEntries(field);
    const widgets = field.acroField.getWidgets();
    return widgets.map((widget, widgetIndex) => {
      const entry = entries.find((e) => e.dict === widget.dict) ?? {
        dict: widget.dict,
      };
      return {
        name: fieldName,
        type,
        page: widgetPage(doc, entry, pages),
        rect: rectOf(widget.dict),
        widgetIndex,
        props: widgetProps(doc, field, widget, widgetIndex),
      };
    });
  });
}

/**
 * Change a field's properties and redraw it. Accepts the props addFormField takes, plus
 * `name` (rename: dots move the field to that group; a taken name gets _2...), `label`
 * (button caption) and `widgetIndex` for per-widget changes (a radio button's exportValue
 * and checked state; colors, border and style apply to every widget unless it is given).
 * Returns the field's (possibly new) full name.
 */
export async function updateFormField(doc, fieldName, props = {}) {
  const field = findField(doc, fieldName);
  const dict = field.acroField.dict;
  const widgets = field.acroField.getWidgets();
  const { widgetIndex } = props;
  if (widgetIndex !== undefined && !widgets[widgetIndex])
    throw new Error('That widget does not exist.');
  const targets = widgetIndex === undefined ? widgets : [widgets[widgetIndex]];
  let result = fieldName;
  if (props.name !== undefined && cleanName(props.name) !== fieldName) {
    const wanted = cleanName(props.name);
    if (!wanted) throw new Error('Give the field a name.');
    result = uniqueName(nameTaken(requireFields(doc), field), wanted);
    const parts = result.split('.');
    const parent = dict.lookup(PARENT);
    const group = parent instanceof PDFDict ? fullName(parent) : '';
    if (parts.slice(0, -1).join('.') === group) dict.set(name('T'), textObject(parts.at(-1)));
    else {
      // Moving to another group must not lose what the field inherited from the old one.
      for (const key of ['FT', 'Ff', 'V', 'DV', 'DA', 'Q', 'MaxLen', 'Opt']) {
        const value = inherited(dict, key);
        if (!dict.has(name(key)) && value !== undefined) dict.set(name(key), value);
      }
      detachField(doc, field.ref, dict);
      attachField(doc.getForm(), field.ref, dict, result);
    }
  }
  applyFieldProps(doc, field, props);
  const radio = field instanceof PDFRadioGroup;
  for (const widget of targets) {
    const style = pick(props, ['borderColor', 'backgroundColor', 'borderWidth']);
    if ((field instanceof PDFCheckBox || radio) && props.style !== undefined)
      style.caption = glyphFor(props.style, radio);
    if (field instanceof PDFButton && props.label !== undefined) style.caption = props.label;
    styleWidget(doc, widget.dict, style);
    if (field instanceof PDFButton && props.action !== undefined)
      setButtonAction(doc, widget.dict, props.action);
  }
  if (field instanceof PDFCheckBox || radio) {
    if (props.exportValue !== undefined) {
      if (radio && widgetIndex === undefined && widgets.length > 1)
        throw new Error('Choose which radio button gets this export value.');
      for (const widget of targets) {
        const index = widgets.indexOf(widget);
        renameState(
          doc,
          field,
          widget,
          setWidgetExport(doc, field, index, String(props.exportValue)),
        );
      }
    }
    if (props.checked !== undefined) {
      const widget = radio ? targets[0] : widgets[0];
      if (radio && widgetIndex === undefined && props.checked && widgets.length > 1)
        throw new Error('Choose which radio button is checked by default.');
      const state = props.checked ? onState(widget) : OFF;
      for (const key of ['V', 'DV']) dict.set(name(key), state);
      if (!props.checked) dict.delete(name('DV'));
    }
  }
  await refreshAppearances(doc, wrapField(doc, field.ref));
  return result;
}

/** Move or resize one widget (rect in unrotated user space) and redraw the field. */
export async function moveFormWidget(doc, fieldName, widgetIndex = 0, rect) {
  const field = findField(doc, fieldName);
  const widget = field.acroField.getWidgets()[widgetIndex];
  if (!widget) throw new Error('That widget does not exist.');
  const box = normalizeBox(rect);
  const before = rectOf(widget.dict);
  if (
    before &&
    ['x', 'y', 'width', 'height'].every((key) => Math.abs(before[key] - box[key]) < 1e-6)
  )
    return false;
  widget.dict.set(
    name('Rect'),
    doc.context.obj([box.x, box.y, box.x + box.width, box.y + box.height].map(round)),
  );
  await refreshAppearances(doc, field);
}

/**
 * Remove the annotation's logical structure: OBJR references to it, structure elements that
 * held nothing else, and its parent tree entry. Untagged documents are left as they are.
 */
function removeAnnotationStructure(doc, ref, dict) {
  const root = doc.catalog.lookup(name('StructTreeRoot'));
  if (!(root instanceof PDFDict)) return;
  const K = name('K'),
    TYPE = name('Type');
  const seen = new Set();
  // Prune a node's kids; returns whether anything is left.
  const prune = (node, depth) => {
    const kids = node.get(K);
    const list = node.lookup(K) instanceof PDFArray ? node.lookup(K).asArray() : kids ? [kids] : [];
    const kept = list.filter((kid) => {
      const value = doc.context.lookup(kid);
      if (!(value instanceof PDFDict)) return true;
      if (value.lookup(TYPE) === name('OBJR')) {
        const target = value.get(name('Obj'));
        return !(target === ref || doc.context.lookup(target) === dict);
      }
      if (seen.has(value) || depth > 256) return true;
      seen.add(value);
      return prune(value, depth + 1);
    });
    if (kept.length === list.length) return true;
    if (!kept.length) node.delete(K);
    else
      node.set(
        K,
        kept.length === 1 && !(node.lookup(K) instanceof PDFArray)
          ? kept[0]
          : doc.context.obj(kept),
      );
    return kept.length > 0;
  };
  prune(root, 0);
  const key = dict.lookup(name('StructParent'));
  if (!(key instanceof PDFNumber)) return;
  const pending = [root.lookup(name('ParentTree'))];
  const visited = new Set();
  while (pending.length) {
    const node = pending.pop();
    if (!(node instanceof PDFDict) || visited.has(node)) continue;
    visited.add(node);
    const nums = node.lookup(name('Nums'));
    if (nums instanceof PDFArray)
      for (let i = nums.size() - 2; i >= 0; i -= 2)
        if (nums.lookup(i)?.asNumber?.() === key.asNumber()) {
          nums.remove(i + 1);
          nums.remove(i);
        }
    const kids = node.lookup(KIDS);
    if (kids instanceof PDFArray)
      for (const kid of kids.asArray()) pending.push(doc.context.lookup(kid));
  }
}
function removeFromPages(doc, entry) {
  for (const page of doc.getPages()) {
    const annots = annotationsOf(page);
    if (!annots?.asArray().some((a) => a === entry.ref || doc.context.lookup(a) === entry.dict))
      continue;
    const list = annotationList(page);
    for (let i = list.size() - 1; i >= 0; i--)
      if (list.get(i) === entry.ref || doc.context.lookup(list.get(i)) === entry.dict)
        list.remove(i);
  }
  removeAnnotationStructure(doc, entry.ref, entry.dict);
}

/**
 * Delete a whole field, or with `widgetIndex` one of its widgets (deleting the last widget
 * deletes the field). Page annotations, the field tree, calculation order, button exports and
 * values, and tagged structure references are all updated. Unreferenced objects are swept by
 * the session's save.
 */
export function deleteFormField(doc, fieldName, widgetIndex) {
  const field = findField(doc, fieldName);
  const dict = field.acroField.dict;
  const entries = widgetEntries(field);
  if (widgetIndex !== undefined && !entries[widgetIndex])
    throw new Error('That widget does not exist.');
  if (widgetIndex === undefined || entries.length <= 1 || entries[widgetIndex].merged) {
    for (const entry of entries) removeFromPages(doc, entry);
    detachField(doc, field.ref, dict);
    return;
  }
  const entry = entries[widgetIndex];
  const widgets = field.acroField.getWidgets();
  const removedState =
    field instanceof PDFCheckBox || field instanceof PDFRadioGroup
      ? onState(widgets[widgetIndex])
      : null;
  removeFromPages(doc, entry);
  const kids = dict.lookup(KIDS).clone();
  const found = kids.asArray().findIndex((kid) => kid === entry.ref);
  const slot = found >= 0 ? found : widgetIndex;
  kids.remove(slot);
  dict.set(KIDS, kids);
  const opt = inherited(dict, 'Opt');
  if (removedState && opt instanceof PDFArray) {
    // Exports pair with widgets by index: own the list, then drop this widget's entry.
    const exports = opt.clone();
    if (slot < exports.size()) exports.remove(slot);
    dict.set(name('Opt'), exports);
  }
  if (removedState) {
    const remaining = field.acroField.getWidgets();
    if (!remaining.some((w) => onState(w) === removedState))
      for (const key of ['V', 'DV'])
        if (dict.lookup(name(key)) === removedState) {
          if (key === 'V') dict.set(name('V'), OFF);
          else dict.delete(name('DV'));
          for (const w of remaining) w.setAppearanceState(OFF);
        }
  }
}

/** A rectangle as shown on a page turned by `rotation`: right and down from the top left. */
function shownBox(rect, rotation) {
  const { x, y, width: w, height: h } = rect;
  return {
    0: { left: x, top: -(y + h), width: w, height: h },
    90: { left: y, top: x, width: h, height: w },
    180: { left: -(x + w), top: y, width: w, height: h },
    270: { left: -(y + h), top: -(x + w), width: h, height: w },
  }[rotation];
}
/**
 * The page's widgets in reading rows (left to right, rows top to bottom) or columns (top to
 * bottom, columns left to right) as the page is shown; boxes whose middles fall within the
 * first box of a row or column share it.
 */
function spatialOrder(doc, page, order) {
  const rotation = pageRotation(page);
  const across = order === 'row' ? 'left' : 'top',
    along = order === 'row' ? 'top' : 'left';
  const extent = { left: 'width', top: 'height' };
  const boxes = (annotationsOf(page)?.asArray() ?? [])
    .map((ref) => doc.context.lookup(ref))
    .filter((dict) => dict instanceof PDFDict && dict.lookup(name('Subtype')) === name('Widget'))
    .map((dict) => ({ dict, rect: rectOf(dict) }))
    .filter(({ rect }) => rect)
    .map(({ dict, rect }) => ({ dict, box: shownBox(rect, rotation) }))
    .sort((a, b) => a.box[along] - b.box[along] || a.box[across] - b.box[across]);
  const lines = [];
  for (const entry of boxes) {
    const middle = entry.box[along] + entry.box[extent[along]] / 2;
    const line = lines.find(
      ([first]) =>
        middle >= first.box[along] && middle <= first.box[along] + first.box[extent[along]],
    );
    if (line) line.push(entry);
    else lines.push([entry]);
  }
  return lines.flatMap((line) =>
    line.sort((a, b) => a.box[across] - b.box[across]).map(({ dict }) => dict),
  );
}
/** Rearrange a page's widget annotations: `wanted` first, in order, the others after them. */
function reorderWidgets(doc, page, wanted) {
  const entries = (annotationsOf(page)?.asArray() ?? []).map((ref) => ({
    ref,
    dict: doc.context.lookup(ref),
  }));
  const isWidget = ({ dict }) =>
    dict instanceof PDFDict && dict.lookup(name('Subtype')) === name('Widget');
  const slots = entries.filter(isWidget);
  const ordered = [
    ...wanted.flatMap((dict) => slots.filter((slot) => slot.dict === dict)),
    ...slots.filter((slot) => !wanted.includes(slot.dict)),
  ].filter((slot, i, all) => all.indexOf(slot) === i);
  let next = 0;
  const result = entries.map((entry) => (isWidget(entry) ? ordered[next++] : entry));
  if (!result.some((entry, i) => entry !== entries[i])) return false;
  // Pages sharing one array get their own before it changes.
  const annots = annotationList(page);
  result.forEach((entry, i) => annots.set(i, entry.ref));
  return true;
}

/**
 * Set a page's tab order: 'row' (/Tabs /R), 'column' (/C), 'structure' (/S), or an explicit
 * list of field names (or `{ name, widgetIndex }`). An explicit order rearranges the page's
 * widget annotations in that order (others keep their slots, unlisted widgets follow in their
 * current order) and removes /Tabs, so readers use the annotation order, as Acrobat's
 * "Order Tabs Manually" does. Rows and columns also put the widgets in that order, for
 * viewers that follow the annotation order and not /Tabs.
 */
export function setFieldTabOrder(doc, pageIndex, order) {
  const page = doc.getPage(pageIndex);
  const tabs = { row: 'R', column: 'C', structure: 'S' }[order];
  if (tabs) {
    const reordered = tabs !== 'S' && reorderWidgets(doc, page, spatialOrder(doc, page, order));
    if (page.node.lookup(name('Tabs')) === name(tabs)) return reordered ? undefined : false;
    page.node.set(name('Tabs'), name(tabs));
    return;
  }
  if (!Array.isArray(order)) throw new Error('Choose a tab order.');
  const fields = requireFields(doc);
  const wanted = [];
  for (const item of order) {
    const itemName = typeof item === 'string' ? item : item?.name;
    const field = fields.find((f) => fullName(f.acroField.dict) === itemName);
    if (!field) throw new Error(`There is no form field named "${itemName}".`);
    const widgets = field.acroField.getWidgets().map((w) => w.dict);
    if (typeof item === 'object' && item.widgetIndex !== undefined) {
      if (!widgets[item.widgetIndex]) throw new Error('That widget does not exist.');
      wanted.push(widgets[item.widgetIndex]);
    } else wanted.push(...widgets);
  }
  const changed = reorderWidgets(doc, page, wanted) || page.node.has(name('Tabs'));
  if (!changed) return false;
  page.node.delete(name('Tabs'));
}
