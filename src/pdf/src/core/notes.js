import { PDFArray, PDFDict, PDFName, PDFNumber, PDFHexString, PDFString, PDFStream } from 'pdf-lib';
import {
  annotationForEdit,
  annotationList,
  annotationsOf,
  pageRotation,
  pageUserUnit,
  removeAnnotationThread,
  sharedPageAnnotations,
} from './structure.js';

const name = PDFName.of;
const number = (value) => PDFNumber.of(value).toString();
const numbers = (array) => array?.asArray?.().map((_, i) => array.lookup(i)?.asNumber?.());
/** Sticky notes are drawn at this size in PDF points; readers keep them from zooming. */
export const NOTE_SIZE = 20;
export const MAX_NOTE_LENGTH = 5000;

function hexToRgb(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error('Choose a valid color.');
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}
function rgbToHex(rgb) {
  return (
    '#' +
    rgb
      .map((c) =>
        Math.round(Math.max(0, Math.min(1, c)) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}
/** PDF dates look like D:20260914120000Z. */
function pdfDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}
/** Read D:YYYYMMDDHHmmSS with an optional Z or +HH'mm' offset; a missing offset means UTC. */
export function parsePdfDate(value) {
  const m =
    /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([Zz+-])(\d{2})?'?(\d{2})?'?)?$/.exec(
      String(value || '').trim(),
    );
  if (!m) return null;
  const year = +m[1],
    month = +(m[2] ?? 1),
    day = +(m[3] ?? 1),
    hour = +(m[4] ?? 0),
    minute = +(m[5] ?? 0),
    second = +(m[6] ?? 0),
    offsetHour = +(m[8] ?? 0),
    offsetMinute = +(m[9] ?? 0);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  )
    return null;
  // Date.UTC treats years 0–99 as 1900–1999. Set the full year explicitly and reject
  // calendar overflow before applying the time zone, which may legitimately cross a day.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  const offset =
    m[7] === '+' || m[7] === '-' ? (m[7] === '+' ? 1 : -1) * (offsetHour * 60 + offsetMinute) : 0;
  date.setUTCMinutes(date.getUTCMinutes() - offset);
  return date;
}

/** Marks the icon streams this app draws, so a page turn can re-orient only those. */
const ICON_KEY = name('PuterNoteIcon');
/**
 * The matrix that keeps the icon upright on a page the reader turns by `rotation` degrees
 * clockwise: the drawing is turned the same amount the other way. Readers fit the turned
 * bounding box into the annotation rectangle, so no offset is needed.
 */
function uprightMatrix(rotation) {
  const turn = ((rotation % 360) + 360) % 360;
  return turn === 90
    ? [0, 1, -1, 0, 0, 0]
    : turn === 180
      ? [-1, 0, 0, -1, 0, 0]
      : turn === 270
        ? [0, -1, 1, 0, 0, 0]
        : [1, 0, 0, 1, 0, 0];
}
/**
 * The note icon: a folded sheet with three lines, filled in the note color, drawn so that
 * every reader shows the same mark on canvas and on paper. Readers disagree over the NoRotate
 * flag (PDF.js ignores it when drawing on canvas), so the icon carries its own turn instead
 * and stays upright in all of them.
 */
function appearance(doc, dict, rect, hex, rotation = 0) {
  const [r, g, b] = hexToRgb(hex);
  const savedOpacity = dict.lookup(name('CA'))?.asNumber?.();
  const opacity =
    Number.isFinite(savedOpacity) && savedOpacity >= 0 && savedOpacity <= 1 ? savedOpacity : 1;
  const s = NOTE_SIZE;
  const fold = s * 0.3;
  const stream = doc.context.flateStream(
    [
      'q',
      ...(opacity < 1 ? ['/GS gs'] : []),
      `${number(r)} ${number(g)} ${number(b)} rg`,
      '0.15 0.15 0.15 RG',
      '0.8 w',
      '1 j',
      // Sheet with the top-right corner folded.
      `1 1 m ${number(s - fold - 1)} 1 l ${number(s - 1)} ${number(fold + 1)} l ${number(s - 1)} ${number(s - 1)} l 1 ${number(s - 1)} l h B`,
      // The fold.
      `${number(s - fold - 1)} 1 m ${number(s - fold - 1)} ${number(fold + 1)} l ${number(s - 1)} ${number(fold + 1)} l S`,
      // Three text lines.
      `4 ${number(s * 0.36)} m ${number(s - 4)} ${number(s * 0.36)} l S`,
      `4 ${number(s * 0.52)} m ${number(s - 4)} ${number(s * 0.52)} l S`,
      `4 ${number(s * 0.68)} m ${number(s - 7)} ${number(s * 0.68)} l S`,
      'Q',
    ].join('\n'),
    {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, s, s],
      Matrix: uprightMatrix(rotation),
      ...(opacity < 1 && {
        Resources: {
          ExtGState: { GS: { Type: 'ExtGState', ca: opacity, CA: opacity } },
        },
      }),
      [ICON_KEY.decodeText()]: 1,
    },
  );
  dict.set(name('Rect'), doc.context.obj(rect));
  dict.set(name('C'), doc.context.obj([r, g, b]));
  dict.set(name('AP'), doc.context.obj({ N: doc.context.register(stream) }));
}

/** Supply this editor's note icon for the standard legacy notes that omit an appearance. */
export function ensureNoteAppearance(doc, page, dict) {
  if (dict.has(name('AP')) || dict.lookup(name('Subtype')) !== name('Text')) return false;
  const icon = dict.lookup(name('Name'));
  if (icon && icon !== name('Note') && icon !== name('Comment')) return false;
  // Custom opacity needs its own appearance; keep that note intact.
  if ((dict.lookup(name('CA'))?.asNumber?.() ?? 1) !== 1) return false;
  const rect = numbers(dict.lookup(name('Rect')));
  if (rect?.length !== 4 || !rect.every(Number.isFinite)) return false;
  if (rect[0] === rect[2] || rect[1] === rect[3]) return false;
  const color = numbers(dict.lookup(name('C'))) || [1, 0.85, 0.3];
  if (![1, 3, 4].includes(color.length) || !color.every(Number.isFinite)) return false;
  const rgb =
    color.length === 1
      ? [color[0], color[0], color[0]]
      : color.length === 4
        ? color.slice(0, 3).map((c) => 1 - Math.min(1, c + color[3]))
        : color;
  appearance(doc, dict, rect, rgbToHex(rgb), pageRotation(page));
  return true;
}

/** Add a sticky note whose icon's top-left corner sits at (x, y) in PDF points. */
export function addNote(doc, index, { x, y, text, hex = '#f2c438', author = '' }) {
  const body = String(text ?? '').trim();
  if (!body) throw new Error('Write something in the note.');
  if (body.length > MAX_NOTE_LENGTH) throw new Error('Keep notes under 5,000 characters.');
  if (![x, y].every(Number.isFinite)) throw new Error('Choose where the note goes.');
  const page = doc.getPage(index);
  // The icon is NOTE_SIZE points across, however large the page's units.
  const unit = pageUserUnit(page),
    size = NOTE_SIZE / unit;
  const rect = [x, y - size, x + size, y];
  const date = pdfDate();
  const dict = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Text',
    P: page.ref,
    // Print and NoZoom: the icon keeps its size at every zoom. Its orientation comes from
    // the appearance's own matrix rather than NoRotate, which readers treat differently.
    F: 4 | 8,
    Name: 'Comment',
    Contents: PDFHexString.fromText(body),
    T: PDFHexString.fromText(author),
    NM: PDFHexString.fromText(
      `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    ),
    M: PDFString.of(date),
    CreationDate: PDFString.of(date),
    CA: 1,
    Open: false,
  });
  appearance(doc, dict, rect, hex, pageRotation(page));
  const ref = doc.context.register(dict);
  // A popup lets other readers open the note beside its icon.
  const popup = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Popup',
      Parent: ref,
      Rect: [x + size + 4 / unit, y - 120 / unit, x + size + 184 / unit, y],
      Open: false,
      F: 0,
    }),
  );
  dict.set(name('Popup'), popup);
  const annots = annotationList(page);
  annots.push(ref);
  annots.push(popup);
  return ref.toString();
}

/** Every sticky note on the page that a person may edit. */
export function listNotes(doc, index) {
  return (annotationsOf(doc.getPage(index))?.asArray() || []).flatMap((ref) => {
    const dict = doc.context.lookup(ref);
    if (!(dict instanceof PDFDict) || dict.lookup(name('Subtype')) !== name('Text')) return [];
    const flags = dict.lookup(name('F'))?.asNumber?.() || 0;
    if (flags & (2 | 32)) return []; // hidden or NoView
    const propertiesLocked = !!(flags & 128),
      contentsLocked = !!(flags & 512);
    const rect = numbers(dict.lookup(name('Rect')));
    if (rect?.length !== 4 || !rect.every(Number.isFinite)) return [];
    const color = numbers(dict.lookup(name('C'))) || [1, 0.85, 0.3];
    const rgb =
      color.length === 1
        ? [color[0], color[0], color[0]]
        : color.length === 4
          ? color.slice(0, 3).map((c) => 1 - Math.min(1, c + color[3]))
          : color.length === 3
            ? color
            : [1, 0.85, 0.3];
    return [
      {
        id: ref.toString(),
        x: Math.min(rect[0], rect[2]),
        y: Math.max(rect[1], rect[3]),
        width: Math.abs(rect[2] - rect[0]),
        height: Math.abs(rect[3] - rect[1]),
        // The editor saves trimmed text; trimming here too keeps an untouched note from
        // other writers (which may end in a newline) from reading as an edit.
        text: (dict.lookup(name('Contents'))?.decodeText?.() || '').trim(),
        author: dict.lookup(name('T'))?.decodeText?.() || '',
        modified: parsePdfDate(
          dict.lookup(name('M'))?.decodeText?.() ?? dict.lookup(name('M'))?.asString?.(),
        ),
        hex: rgbToHex(rgb),
        readOnly: !!(flags & 64) || (propertiesLocked && contentsLocked),
        propertiesLocked,
        contentsLocked,
        // Notes from editors that rely on the reader's own icons have no appearance stream.
        hasAppearance: !!dict.get(name('AP')),
      },
    ];
  });
}

/** Change a note's text, color, or position, or remove it together with its popup. */
export function editNote(doc, index, id, { text, hex, x, y, remove = false } = {}) {
  const entry = listNotes(doc, index).find((note) => note.id === id);
  if (!entry || entry.readOnly) throw new Error('This note cannot be edited.');
  const page = doc.getPage(index),
    annots = annotationsOf(page);
  const position = annots.asArray().findIndex((ref) => ref.toString() === id);
  let dict = doc.context.lookup(annots.get(position));
  if (remove) {
    if (entry.propertiesLocked) throw new Error('Properties are locked for this note.');
    removeAnnotationThread(page, id);
    return;
  }
  const body = text === undefined ? entry.text : String(text).trim();
  const textChanged = body !== entry.text;
  if (textChanged) {
    if (entry.contentsLocked) throw new Error('Text is locked for this note.');
    if (!body) throw new Error('Write something in the note.');
    if (body.length > MAX_NOTE_LENGTH) throw new Error('Keep notes under 5,000 characters.');
  }
  const nextHex = hex ?? entry.hex;
  const nextX = x ?? entry.x,
    nextY = y ?? entry.y;
  if (![nextX, nextY].every(Number.isFinite)) throw new Error('Choose where the note goes.');
  if (
    entry.propertiesLocked &&
    (nextHex.toLowerCase() !== entry.hex || nextX !== entry.x || nextY !== entry.y)
  )
    throw new Error('Properties are locked for this note.');
  const dx = nextX - entry.x,
    dy = nextY - entry.y;
  const moved = Math.abs(dx) >= 1e-6 || Math.abs(dy) >= 1e-6;
  const propertiesChanged = nextHex.toLowerCase() !== entry.hex || moved;
  if (!textChanged && !propertiesChanged) return false;
  dict = annotationForEdit(page, dict);
  if (textChanged) {
    dict.set(name('Contents'), PDFHexString.fromText(body));
    // Acrobat shows a note's rich-text copy (RC) in preference to Contents; a stale one would
    // keep showing the old words there. Unchanged text retains both representations exactly.
    dict.delete(name('RC'));
  }
  dict.set(name('M'), PDFString.of(pdfDate()));
  // Editing the words must not replace a custom icon, resize it or reposition its popup.
  // Standard legacy notes can still acquire an icon, fitted to their existing bounds.
  if (!propertiesChanged) {
    if (!entry.propertiesLocked) ensureNoteAppearance(doc, page, dict);
    return;
  }
  appearance(
    doc,
    dict,
    [nextX, nextY - entry.height, nextX + entry.width, nextY],
    nextHex,
    pageRotation(page),
  );
  const popupDict = dict.lookup(name('Popup'));
  if (moved && popupDict instanceof PDFDict) {
    const rect = numbers(popupDict.lookup(name('Rect')));
    // Move the existing popup with its note, retaining its size and relative position.
    const nextRect =
      rect?.length === 4 && rect.every(Number.isFinite)
        ? rect.map((value, i) => value + (i % 2 ? dy : dx))
        : [nextX + entry.width + 4, nextY - 120, nextX + entry.width + 184, nextY];
    popupDict.set(name('Rect'), doc.context.obj(nextRect));
  }
}

/**
 * Keep the icons this app drew upright after a page is turned. Icons from other writers are
 * left as they are, since only ours are known to be drawn this way.
 */
export function reorientNotes(doc, indices) {
  const plans = [];
  for (const index of Array.isArray(indices) ? indices : [indices]) {
    const page = doc.getPage(index);
    const matrix = uprightMatrix(pageRotation(page));
    const annots = annotationsOf(page);
    for (let position = 0; position < (annots?.size() || 0); position++) {
      const dict = doc.context.lookup(annots.get(position));
      if (!(dict instanceof PDFDict) || dict.lookup(name('Subtype')) !== name('Text')) continue;
      const ap = dict.lookup(name('AP'));
      const normal = ap instanceof PDFDict ? ap.lookup(name('N')) : null;
      if (!(normal instanceof PDFStream) || !normal.dict.get(ICON_KEY)) continue;
      const before = numbers(normal.dict.lookup(name('Matrix'))) ?? [1, 0, 0, 1, 0, 0];
      if (before.length === 6 && before.every((value, i) => value === matrix[i])) continue;
      plans.push({ page, position, matrix });
    }
  }
  if (!plans.length) return;
  // Detach page dictionaries first, then count appearance sharing once for the whole turn.
  const shared = sharedPageAnnotations(doc);
  for (const { page, position } of plans)
    annotationForEdit(page, doc.context.lookup(annotationsOf(page).get(position)), {
      shared,
      wholePage: true,
    });
  const uses = objectUses(doc.context);
  for (const { page, position, matrix } of plans) {
    const dict = doc.context.lookup(annotationsOf(page).get(position));
    const ap = dict.lookup(name('AP'));
    let normal = ap.lookup(name('N'));
    // Appearance dictionaries and streams may be shared by notes or ordinary page content.
    // Isolate only shared objects; further turns can reuse the private appearance.
    if (uses.get(ap) > 1 || uses.get(normal) > 1 || uses.get(normal.dict) > 1) {
      normal = normal.clone(doc.context);
      const own = ap.clone(doc.context);
      own.set(name('N'), doc.context.register(normal));
      dict.set(name('AP'), own);
    }
    normal.dict.set(name('Matrix'), doc.context.obj(matrix));
  }
}

/** Count container references once per rotation operation, without decoding stream data. */
function objectUses(context) {
  const pending = context.enumerateIndirectObjects().map(([, object]) => object);
  const seen = new Set();
  const uses = new Map();
  const visit = (entry) => {
    const value = context.lookup(entry);
    if (!(value instanceof PDFDict || value instanceof PDFArray || value instanceof PDFStream))
      return;
    uses.set(value, (uses.get(value) ?? 0) + 1);
    pending.push(value);
  };
  while (pending.length) {
    const value = pending.pop();
    if (seen.has(value)) continue;
    seen.add(value);
    if (value instanceof PDFStream) visit(value.dict);
    else if (value instanceof PDFDict) for (const [, entry] of value.entries()) visit(entry);
    else if (value instanceof PDFArray) for (const entry of value.asArray()) visit(entry);
  }
  return uses;
}
