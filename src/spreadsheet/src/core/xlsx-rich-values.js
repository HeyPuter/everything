/** Excel rich values (in-cell pictures and modern errors), with a legacy #VALUE! fallback. */
import { xlsxAttr as attr, xlsxElements as elements, xlsxText } from './xlsx-styles.js';
import { xmlTag as tag, xmlText } from './xlsx-export-styles.js';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RICH = 'http://schemas.microsoft.com/office/spreadsheetml/2017/richdata';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const body = xml => xlsxText(xml?.replace(/^<[^>]+>|<\/[^>]+>$/g, '')) || '';
const indexAttr = (xml, name) => /^\d+$/.test(attr(xml, name) || '') ? Number(attr(xml, name)) : NaN;
// MS-XLSX 2.3.6.1.3: these are rich-value type IDs, not BIFF error codes
// or ERROR.TYPE results. Excel also saves standalone SPILL/FIELD values with
// only errorType, without inventing spill dimensions or a missing field name.
const ERROR_TYPES = new Map([[8, '#SPILL!'], [9, '#CONNECT!'], [10, '#BLOCKED!'], [11, '#UNKNOWN!'], [12, '#FIELD!'], [13, '#CALC!']]);
const ERROR_IDS = new Map([...ERROR_TYPES].map(([id, error]) => [error, id]));

function resolve(owner, target) {
  if (!target || /[?#]|^[a-z][\w+.-]*:|^\/\//i.test(target)) return null;
  const parts = target.startsWith('/') ? [] : owner.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return parts.join('/');
}

export function readXlsxRichValues(book) {
  const files = book.files || {}, decoder = new TextDecoder();
  const xml = part => files[part]?.content ? decoder.decode(files[part].content).replace(/<!--[\s\S]*?-->/g, '') : '';
  const related = (owner, kind, id) => {
    if (!owner) return null;
    const slash = owner.lastIndexOf('/');
    const rels = xml(`${owner.slice(0, slash + 1)}_rels/${owner.slice(slash + 1)}.rels`);
    const rel = elements(rels, 'Relationship').find(r => attr(r, 'Type')?.endsWith(`/${kind}`)
      && (!id || attr(r, 'Id') === id) && attr(r, 'TargetMode') !== 'External');
    return rel ? resolve(owner, attr(rel, 'Target')) : null;
  };
  const metadata = xml(related('xl/workbook.xml', 'sheetMetadata'));
  const types = elements(elements(metadata, 'metadataTypes')[0], 'metadataType');
  const type = types.findIndex(t => attr(t, 'name') === 'XLRICHVALUE') + 1;
  if (!type) return new Map();
  const future = elements(metadata, 'futureMetadata').find(t => attr(t, 'name') === 'XLRICHVALUE');
  const indices = elements(future, 'bk').map(b => indexAttr(elements(b, 'rvb')[0], 'i'));
  const structures = elements(xml(related('xl/workbook.xml', 'rdRichValueStructure')), 's');
  const records = elements(xml(related('xl/workbook.xml', 'rdRichValue')), 'rv');
  const linksPart = related('xl/workbook.xml', 'richValueRel');
  const links = elements(xml(linksPart), 'rel');
  const values = new Map(), cached = new Map();
  for (const [index, block] of elements(elements(metadata, 'valueMetadata')[0], 'bk').entries()) {
    const rc = elements(block, 'rc').find(r => indexAttr(r, 't') === type);
    const record = rc && records[indices[indexAttr(rc, 'v')]];
    const structure = record && structures[indexAttr(record, 's')];
    if (attr(structure, 't') === '_error') {
      // The optional subType selects help text, not the error value.
      const key = elements(structure, 'k').findIndex(k => attr(k, 'n') === 'errorType' && attr(k, 't') === 'i');
      const raw = key >= 0 ? body(elements(record, 'v')[key]).trim() : '';
      const error = /^\+?\d+$/.test(raw) && ERROR_TYPES.get(Number(raw));
      if (error) values.set(index + 1, { error });
      continue;
    }
    if (attr(structure, 't') !== '_localImage') continue;
    const keys = elements(structure, 'k'), key = keys.findIndex(k => attr(k, 'n') === '_rvRel:LocalImageIdentifier');
    if (key < 0) continue;
    // The picture's alt text (Alt Text on the cell), when the structure carries one.
    const textKey = keys.findIndex(k => attr(k, 'n') === 'Text');
    const alt = textKey >= 0 ? body(elements(record, 'v')[textKey]).trim().slice(0, 2000) : '';
    const imageIndex = body(elements(record, 'v')[key]);
    if (!/^\d+$/.test(imageIndex)) continue;
    const link = links[Number(imageIndex)];
    if (!link || !attr(link, 'r:id')) continue;
    const part = related(linksPart, 'image', attr(link, 'r:id'));
    const bytes = files[part]?.content;
    const mime = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp' }[part?.split('.').pop().toLowerCase()];
    if (!bytes?.length || bytes.length > 16 * 1024 * 1024 || !mime) continue;
    if (!cached.has(part)) {
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      cached.set(part, { image: `data:image/${mime};base64,${btoa(binary)}`, fit: 'contain' });
    }
    values.set(index + 1, alt ? { ...cached.get(part), alt } : cached.get(part));
  }
  return values;
}

/**
 * Share one metadata/value index across pictures and modern errors. A picture held in the file is a
 * local image; a picture IMAGE() reads from the web is a web image, kept by its address. Either can
 * carry alt text. `value.origin` says where a computed picture came from: 1 an IMAGE formula, 4 a
 * reference to another cell's picture.
 */
export function richValueWriter({ get, set, binary, contentType }) {
  const recordsByValue = new Map(), media = new Map(), addresses = new Map(), structures = new Map();
  const structure = (type, keys) => {
    const key = `${type}|${keys.map(([n, t]) => `${n}:${t}`).join(',')}`;
    if (!structures.has(key)) structures.set(key, { index: structures.size, xml: tag('s', { t: type }, keys.map(([n, t]) => tag('k', { n, t })).join('')) });
    return structures.get(key).index;
  };
  const mark = (cell, index, typed) => cell.replace(/^<c\b[^>]*>/, head => head.replace(typed ? /\s(?:t|vm)="[^"]*"/g : /\svm="[^"]*"/g, '').replace(/>$/, `${typed ? ' t="e"' : ''} vm="${index + 1}">`));
  const sheet = (xml, values) => xml.replace(/<c\b[^>]*>[\s\S]*?<\/c>/g, cell => {
    const value = values.get(attr(cell, 'r'));
    const match = /^data:image\/(png|jpeg|gif|webp);base64,([a-z\d+/=]+)$/i.exec(value?.image || '');
    const web = !match && /^https?:\/\/[^\s"<>]{1,2000}$/i.test(value?.image || '') ? value.image : null;
    const errorType = attr(cell, 't') === 'e' && ERROR_IDS.get(body(elements(cell, 'v')[0]));
    if (errorType) {
      const key = `error:${errorType}`;
      if (!recordsByValue.has(key)) recordsByValue.set(key, { index: recordsByValue.size, structure: structure('_error', [['errorType', 'i']]), values: [String(errorType)] });
      return mark(cell, recordsByValue.get(key).index, false).replace(/<v\b[^>]*>[\s\S]*?<\/v>/, '<v>#VALUE!</v>');
    }
    if ((!match || match[2].length > 22400000) && !web) return cell;
    const alt = typeof value.alt === 'string' ? value.alt.slice(0, 2000) : '';
    const origin = value.computed ? value.origin || 4 : 5;
    let record;
    if (web) {
      if (!addresses.has(web)) addresses.set(web, addresses.size);
      const sizing = { contain: 0, stretch: 1, original: 2 }[value.fit] ?? 0;
      const keys = [['WebImageIdentifier', 'i'], ['CalcOrigin', 'i'], ['ComputedImage', 'b'], ['ImageSizing', 'i'], ...(alt ? [['Text', 's']] : [])];
      record = { structure: structure('_webimage', keys), values: [String(addresses.get(web)), String(origin), value.computed ? '1' : '0', String(sizing), ...(alt ? [alt] : [])] };
    } else {
      if (!media.has(value.image)) media.set(value.image, { index: media.size, mime: match[1], data: match[2] });
      const keys = [['_rvRel:LocalImageIdentifier', 'i'], ['CalcOrigin', 'i'], ...(alt ? [['Text', 's']] : [])];
      record = { structure: structure('_localImage', keys), values: [String(media.get(value.image).index), String(origin), ...(alt ? [alt] : [])] };
    }
    const key = `${record.structure}:${JSON.stringify(record.values)}`;
    if (!recordsByValue.has(key)) recordsByValue.set(key, { index: recordsByValue.size, ...record });
    const index = recordsByValue.get(key).index;
    return mark(cell, index, true)
      .replace(/<v\b[^>]*>[\s\S]*?<\/v>|<is\b[^>]*>[\s\S]*?<\/is>/g, '').replace('</c>', '<v>#VALUE!</v></c>');
  });
  const finish = () => {
    if (!recordsByValue.size) return;
    const base = '/xl/richData/';
    const records = [], links = [], rels = [], webImages = [], webRels = [];
    for (const { index, mime, data } of media.values()) {
      const part = `/xl/media/cellImage${index + 1}.${mime === 'jpeg' ? 'jpg' : mime}`;
      binary(part, Uint8Array.from(atob(data), c => c.charCodeAt(0)));
      contentType(part, `image/${mime}`);
      links.push(tag('rel', { 'r:id': `rId${index + 1}` }));
      rels.push(tag('Relationship', { Id: `rId${index + 1}`, Type: `${REL}image`, Target: `../media/${part.split('/').pop()}` }));
    }
    for (const [address, index] of addresses) {
      webImages.push(tag('webImageSrd', {}, tag('address', { 'r:id': `rId${index + 1}` })));
      webRels.push(tag('Relationship', { Id: `rId${index + 1}`, Type: `${REL}hyperlink`, Target: address, TargetMode: 'External' }));
    }
    for (const { structure: s, values } of recordsByValue.values()) records.push(tag('rv', { s }, values.map(v => tag('v', {}, xmlText(v))).join('')));
    const structureXml = [...structures.values()].sort((a, b) => a.index - b.index).map(s => s.xml);
    const parts = [
      ['rdrichvalue.xml', 'rdRichValue', 'application/vnd.ms-excel.rdrichvalue+xml', tag('rvData', { xmlns: RICH, count: recordsByValue.size }, records.join(''))],
      ['rdrichvaluestructure.xml', 'rdRichValueStructure', 'application/vnd.ms-excel.rdrichvaluestructure+xml', tag('rvStructures', { xmlns: RICH, count: structureXml.length }, structureXml.join(''))],
      ['richValueRel.xml', 'richValueRel', 'application/vnd.ms-excel.richvaluerel+xml', tag('richValueRels', { xmlns: 'http://schemas.microsoft.com/office/spreadsheetml/2022/richvaluerel', 'xmlns:r': REL.slice(0, -1) }, links.join(''))],
      ['rdRichValueWebImage.xml', 'rdRichValueWebImage', 'application/vnd.ms-excel.rdrichvaluewebimage+xml', tag('webImagesSrd', { xmlns: 'http://schemas.microsoft.com/office/spreadsheetml/2020/richdatawebimage', 'xmlns:r': REL.slice(0, -1) }, webImages.join(''))],
      ['rdRichValueTypes.xml', 'rdRichValueTypes', 'application/vnd.ms-excel.rdrichvaluetypes+xml', tag('rvTypesInfo', { xmlns: 'http://schemas.microsoft.com/office/spreadsheetml/2017/richdata2' },
        tag('global', {}, tag('keyFlags', {}, ['_Self', '_DisplayString', '_Flags', '_Format', '_SubLabel', '_Attribution', '_Icon', '_Display', '_CanonicalPropertyNames', '_ClassificationId']
          .map(name => tag('key', { name }, (name === '_Self' ? tag('flag', { name: 'ExcludeFromFile', value: 1 }) : '') + tag('flag', { name: 'ExcludeFromCalcComparison', value: 1 }))).join(''))))],
    ];
    let workbookRels = get('/xl/_rels/workbook.xml.rels');
    for (const [name, kind, type, xml] of parts) {
      if (kind === 'richValueRel' && !media.size) continue;
      if (kind === 'rdRichValueWebImage' && !addresses.size) continue;
      set(base + name, HEADER + xml); contentType(base + name, type);
      const year = kind === 'richValueRel' ? '2022/10' : kind === 'rdRichValueWebImage' ? '2020/07' : '2017/06';
      workbookRels = workbookRels.replace('</Relationships>', tag('Relationship', { Id: `puter_${kind}`, Type: `http://schemas.microsoft.com/office/${year}/relationships/${kind}`, Target: `richData/${name}` }) + '</Relationships>');
    }
    if (media.size) set(base + '_rels/richValueRel.xml.rels', HEADER + tag('Relationships', { xmlns: 'http://schemas.openxmlformats.org/package/2006/relationships' }, rels.join('')));
    if (addresses.size) set(base + '_rels/rdRichValueWebImage.xml.rels', HEADER + tag('Relationships', { xmlns: 'http://schemas.openxmlformats.org/package/2006/relationships' }, webRels.join('')));
    let metadata = get('/xl/metadata.xml');
    if (!metadata) {
      metadata = HEADER + tag('metadata', { xmlns: MAIN }, tag('metadataTypes', { count: 0 }, ''));
      workbookRels = workbookRels.replace('</Relationships>', tag('Relationship', { Id: 'puter_metadata', Type: `${REL}sheetMetadata`, Target: 'metadata.xml' }) + '</Relationships>');
      contentType('/xl/metadata.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml');
    }
    const count = elements(elements(metadata, 'metadataTypes')[0], 'metadataType').length + 1;
    metadata = metadata.replace(/(<metadataTypes\b[^>]*count=")[^"]*(")/, `$1${count}$2`).replace('</metadataTypes>', tag('metadataType', { name: 'XLRICHVALUE', minSupportedVersion: 120000, copy: 1, pasteAll: 1, pasteValues: 1, merge: 1, splitFirst: 1, rowColShift: 1, clearFormats: 1, clearComments: 1, assign: 1, coerce: 1 }) + '</metadataTypes>');
    const future = tag('futureMetadata', { name: 'XLRICHVALUE', count: recordsByValue.size }, [...recordsByValue.values()].map(({ index }) => tag('bk', {}, tag('extLst', {}, tag('ext', { uri: '{3e2802c4-a4d2-4d8b-9148-e3be6c30e623}' }, tag('xlrd:rvb', { 'xmlns:xlrd': RICH, i: index }))))).join(''));
    metadata = metadata.replace(/(<cellMetadata\b|<\/metadata>)/, `${future}$1`).replace('</metadata>', tag('valueMetadata', { count: recordsByValue.size }, [...recordsByValue.values()].map(({ index }) => tag('bk', {}, tag('rc', { t: count, v: index }))).join('')) + '</metadata>');
    set('/xl/metadata.xml', metadata); set('/xl/_rels/workbook.xml.rels', workbookRels);
  };
  return { sheet, finish };
}
