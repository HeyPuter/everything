/**
 * A worksheet's background picture (Page Layout ▸ Background) in .xlsx: CT_Worksheet's <picture r:id>,
 * naming an image relationship of the worksheet part. The picture is tiled behind the cells on screen
 * and is never printed.
 */
import { xlsxAttr } from './xlsx-styles.js';
import { xmlTag } from './xlsx-export-styles.js';
import { normalizeBackground, MAX_BACKGROUND_BYTES } from './sheet-background.js';

export { normalizeBackground };

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const TYPES = { png: 'png', jpeg: 'jpeg', jpg: 'jpeg', gif: 'gif', bmp: 'bmp' };

const base64 = (bytes) => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};

/** The relationships part beside a part path ("xl/worksheets/sheet1.xml" → "xl/worksheets/_rels/sheet1.xml.rels"). */
const relsOf = (path) => path.replace(/(^|\/)([^/]+)$/, '$1_rels/$2.rels');
/** A relationship target resolved against the folder of the part that names it. */
function resolve(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

/** The worksheet part's path in the package for a sheet of the book, from the workbook's relationships. */
export function worksheetPath(book, name) {
  const rels = book.files?.['xl/_rels/workbook.xml.rels']?.content;
  const id = book.Workbook?.Sheets?.[book.SheetNames.indexOf(name)]?.id;
  if (!rels || !id) return null;
  for (const m of new TextDecoder().decode(rels).matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
    if (xlsxAttr(m[0], 'Id') === id) return resolve('xl/workbook.xml', xlsxAttr(m[0], 'Target') || '');
  }
  return null;
}

/** The background picture another program (or this one) saved with a worksheet, or null. */
export function readXlsxBackground(book, name, partXml) {
  const picture = partXml?.replace(/<(?:\w+:)?sheetData\b[^]*?<\/(?:\w+:)?sheetData\s*>/, '').match(/<(?:\w+:)?picture\b[^>]*>/)?.[0];
  const id = picture && (xlsxAttr(picture, 'r:id') ?? picture.match(/\s[\w]+:id="([^"]*)"/)?.[1]);
  const path = id && worksheetPath(book, name);
  const rels = path && book.files?.[relsOf(path)]?.content;
  if (!rels) return null;
  for (const m of new TextDecoder().decode(rels).matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
    if (xlsxAttr(m[0], 'Id') !== id || xlsxAttr(m[0], 'TargetMode') === 'External') continue;
    const target = resolve(path, xlsxAttr(m[0], 'Target') || '');
    const bytes = book.files?.[target]?.content;
    const type = TYPES[target.split('.').pop().toLowerCase()];
    if (!bytes || !type || bytes.length > MAX_BACKGROUND_BYTES) return null;
    return normalizeBackground(`data:image/${type};base64,${base64(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))}`);
  }
  return null;
}

/**
 * Write a sheet's background: the picture into xl/media, an image relationship of the worksheet, and
 * <picture r:id> where the schema puts it (after the drawings, before OLE objects, controls and tables).
 * Returns the worksheet XML and its relationships.
 */
export function writeXlsxBackground(xml, rels, background, index, { binary, contentType }) {
  xml = xml.replace(/<picture\b[^>]*\/>/g, '');
  const bg = normalizeBackground(background);
  if (!bg) return { xml, rels };
  const [, type, data] = /^data:image\/([a-z]+);base64,(.*)$/is.exec(bg.src);
  const extension = type === 'jpeg' ? 'jpg' : type;
  const path = `/xl/media/background${index}.${extension}`;
  binary(path, Uint8Array.from(atob(data.replace(/\s+/g, '')), (c) => c.charCodeAt(0)));
  contentType(path, `image/${type}`);
  rels = rels.replace('</Relationships>', `${xmlTag('Relationship', { Id: 'puterBackground', Type: `${REL}image`, Target: `../media/background${index}.${extension}` })}</Relationships>`);
  xml = xml.replace(/<oleObjects\b|<controls\b|<webPublishItems\b|<tableParts\b|<extLst\b|<\/worksheet>/, (match) => `${xmlTag('picture', { 'r:id': 'puterBackground' })}${match}`);
  return { xml, rels };
}
