import { UnsupportedDocumentError } from './errors.js';
import { serializeFragment } from './docx-compatibility.js';
import { formatPageNumber } from './page-numbering.js';
import { numericFieldFormat, formatNumericField } from './numeric-field-format.js';

const GENERAL_NUMBER_FORMATS = new Map([['Arabic', 'decimal'], ['ArabicDash', 'numberInDash'],
  ['ROMAN', 'upperRoman'], ['roman', 'lowerRoman'], ['ALPHABETIC', 'upperLetter'], ['alphabetic', 'lowerLetter']]);

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const fail = message => { throw new UnsupportedDocumentError(message); };
const is = (node, name) => node.namespaceURI === W && node.localName === name;
function boolean(node, name) {
  const value = node.getAttributeNS(W, name);
  if (value === null || ['0', 'false', 'off'].includes(value)) return false;
  if (['1', 'true', 'on'].includes(value)) return true;
  fail(`invalid field ${name}`);
}

export function fieldInstructionTokens(instruction, positions = false) {
  const tokens = [];
  const pattern = /\s*(?:"((?:\\["\\]|[^"\\]|\\(?!["\\]))*)"|(\S+))/gy;
  let at = 0;
  while (at < instruction.trimEnd().length) {
    pattern.lastIndex = at;
    const match = pattern.exec(instruction);
    if (!match || (match[2]?.includes('"')) || (pattern.lastIndex < instruction.length && !/\s/.test(instruction[pattern.lastIndex]))) fail('an invalid page field instruction argument');
    const value=match[1] !== undefined ? match[1].replace(/\\(["\\])/g, '$1') : match[2];
    tokens.push(positions?{value,start:at+match[0].search(/\S/),end:pattern.lastIndex}:value);
    at = pattern.lastIndex;
  }
  return tokens;
}

// Fields whose cached result is shown and saved unchanged (ECMA-376 Part 1
// §17.16.5). They are not evaluated here; their envelopes round-trip intact.
export const RETAINED_FIELDS = new Set(['SEQ', 'REF', 'NOTEREF', 'STYLEREF', 'DATE', 'TIME', 'CREATEDATE', 'SAVEDATE', 'PRINTDATE', 'EDITTIME',
  'AUTHOR', 'LASTSAVEDBY', 'TITLE', 'SUBJECT', 'KEYWORDS', 'COMMENTS', 'FILENAME', 'FILESIZE', 'DOCPROPERTY', 'DOCVARIABLE', 'INFO', 'NUMWORDS', 'NUMCHARS',
  'REVNUM', 'SECTION', 'TEMPLATE', 'USERNAME', 'USERINITIALS', 'USERADDRESS', 'QUOTE', 'LISTNUM', 'AUTONUM', 'AUTONUMLGL', 'AUTONUMOUT', 'MERGEFIELD',
  'MERGEREC', 'MERGESEQ', 'ADDIN', 'CITATION', 'BIBLIOGRAPHY', 'GREETINGLINE', 'ADDRESSBLOCK', 'FILLIN', 'GOTOBUTTON', 'SYMBOL', 'TA', 'TOA', 'TC', 'RD', 'SET', 'ASK', 'PRIVATE', 'BARCODE', 'DISPLAYBARCODE', 'ADVANCE', 'EQ',
  // Mail merge rules (§17.16.5.26 IF, .38 NEXT, .39 NEXTIF, .58 SKIPIF), evaluated by merge-fields.js.
  'IF', 'NEXT', 'NEXTIF', 'SKIPIF']);

export function pageFieldInstruction(instruction) {
  // Retained instructions can carry arbitrary data (citation add-ins embed JSON), so they are not tokenized.
  const keyword = /^\s*([A-Za-z]+)(?=\s|$)/.exec(instruction || '')?.[1]?.toUpperCase();
  if (RETAINED_FIELDS.has(keyword)) return { type: keyword, instruction, retained: true, mergeFormat: /\\\*\s*MERGEFORMAT\b/i.test(instruction) };
  const tokens = fieldInstructionTokens(instruction);
  const type = tokens.shift()?.toUpperCase();
  if (!['PAGE', 'NUMPAGES', 'SECTIONPAGES'].includes(type)) fail('an unsupported page field instruction');
  let mergeFormat = false;
  let numericFormat, generalFormat;
  for (let i = 0; i < tokens.length; i += 2) {
    if (tokens[i] === '\\#' && numericFormat === undefined && tokens[i + 1] !== undefined) numericFormat = numericFieldFormat(tokens[i + 1]);
    else if (tokens[i] === '\\*' && tokens[i + 1]?.toUpperCase() === 'MERGEFORMAT' && !mergeFormat) mergeFormat = true;
    else if (tokens[i] === '\\*' && GENERAL_NUMBER_FORMATS.has(tokens[i + 1])) generalFormat = GENERAL_NUMBER_FORMATS.get(tokens[i + 1]);
    else fail('an unsupported page field switch');
  }
  return { type, mergeFormat, instruction, ...(numericFormat === undefined ? {} : { numericFormat }), ...(generalFormat === undefined ? {} : { generalFormat }) };
}

// Return ordinary inline nodes and atomic page fields without mutating the XML.
// Split runs at field boundaries: producers can place text and delimiters in one run.
export function pageFieldSegments(paragraph, readInstruction = pageFieldInstruction) {
  const segments = [];
  let active = null;
  const finish = () => {
    const field = { ...readInstruction(active.instruction), locked: active.locked, dirty: active.dirty,
      source: active.source.map(serializeFragment).join('') };
    segments.push({ field, resultNodes: active.result, instructionProperties: active.instructionProperties }); active = null;
  };
  for (const node of paragraph.children) {
    if (is(node, 'pPr')) continue;
    if (is(node, 'fldSimple')) {
      if (active) fail('nested page fields');
      const instruction = node.getAttributeNS(W, 'instr');
      if (instruction === null) fail('a page field without an instruction');
      if ([...node.getElementsByTagNameNS(W, 'fldChar'), ...node.getElementsByTagNameNS(W, 'fldSimple')].length) fail('nested page fields');
      segments.push({ field: { ...readInstruction(instruction), locked: boolean(node, 'fldLock'), dirty: boolean(node, 'dirty'), source: serializeFragment(node) }, resultNodes: [...node.children] });
      continue;
    }
    if (!is(node, 'r')) {
      if (active) fail('non-run content inside a complex page field');
      segments.push({ node }); continue;
    }
    const properties = [...node.children].find(n => is(n, 'rPr'));
    const contents = [...node.children].filter(n => n !== properties);
    if (active && !contents.length) {
      active.source.push(node); if (active.phase === 'result') active.result.push(node);
      continue;
    }
    if (!active && !contents.some(n => is(n, 'fldChar') || is(n, 'instrText'))) { segments.push({ node }); continue; }
    for (const content of contents) {
      const run = node.cloneNode(false);
      if (properties) run.appendChild(properties.cloneNode(true));
      run.appendChild(content.cloneNode(true));
      if (is(content, 'fldChar')) {
        const kind = content.getAttributeNS(W, 'fldCharType');
        if (content.children.length) fail('field delimiter child content');
        if (kind === 'begin') {
          // A field nested in another field's instruction (IF "{ MERGEFIELD City }" = …) is part of that
          // instruction: it is kept in the envelope and shown in braces in the instruction text.
          if (active?.phase === 'code') { active.nested.push('code'); active.instruction += '{'; active.source.push(run); continue; }
          if (active) fail('nested page fields');
          active = { instruction: '', locked: boolean(content, 'fldLock'), dirty: boolean(content, 'dirty'), phase: 'code', source: [run], result: [], nested: [] };
        } else {
          if (!active) fail('an unmatched page field delimiter');
          active.source.push(run);
          if (active.nested.length) {
            if (kind === 'separate' && active.nested.at(-1) === 'code') active.nested[active.nested.length - 1] = 'result';
            else if (kind === 'end') { active.nested.pop(); active.instruction += '}'; }
            else fail('an invalid page field delimiter sequence');
          }
          else if (kind === 'separate' && active.phase === 'code') active.phase = 'result';
          else if (kind === 'end') finish();
          else fail('an invalid page field delimiter sequence');
        }
      } else if (is(content, 'instrText')) {
        if (!active || active.phase !== 'code' || active.nested.at(-1) === 'result') fail('a page instruction outside its field code');
        if (!active.instruction.trim() && content.textContent.trim()) active.instructionProperties = properties;
        active.source.push(run); active.instruction += content.textContent;
      } else if (active) {
        // A nested field's cached result inside an instruction stays in the envelope only.
        if (active.phase === 'code' && active.nested.at(-1) === 'result') { active.source.push(run); continue; }
        if (active.phase !== 'result') fail('visible content inside a page field instruction');
        active.source.push(run); active.result.push(run);
      } else segments.push({ node: run });
    }
  }
  if (active) fail('an unterminated page field');
  return segments;
}

export function pageFieldValue(field, { pageNumber, pageCount, sectionPageCount, pageNumbering, pageStory = false }) {
  if (field.retained) return null;
  // Automatic PAGE/NUMPAGES refresh in page stories even when locked.
  // Other locked results, including SECTIONPAGES, retain their stored text.
  if (field.locked && !(pageStory && ['PAGE', 'NUMPAGES'].includes(field.type))) return null;
  const value = { PAGE: pageNumber, NUMPAGES: pageCount, SECTIONPAGES: sectionPageCount }[field.type];
  if (!Number.isInteger(value) || value < 0) throw new Error('Invalid page field value.');
  if (field.type === 'PAGE' && pageNumbering?.chapterStyle !== undefined) throw new Error('Chapter-prefixed page numbers are not supported yet.');
  if (field.numericFormat) return formatNumericField(value, field.numericFormat);
  if (field.generalFormat) return field.generalFormat === 'numberInDash' ? `- ${value} -` : formatPageNumber(value, field.generalFormat);
  if (field.type === 'PAGE') {
    return formatPageNumber(value, pageNumbering?.format);
  }
  return String(value);
}

// Replace only a same-paragraph field's cached result. The retained envelope
// owns its instruction, switches, delimiter properties and lock/dirty flags.
// Body editing must never serialize a generated result as ordinary text while
// silently discarding this envelope. Callers supply already-serialized runs.
export function writePageFieldResult(field, resultNodes, doc, readInstruction = pageFieldInstruction) {
  const root = new DOMParser().parseFromString(`<w:p xmlns:w="${W}">${field.source}</w:p>`, 'application/xml').documentElement;
  const segments = pageFieldSegments(root, readInstruction);
  if (segments.length !== 1 || !segments[0].field || segments[0].field.instruction !== field.instruction) throw new Error('Invalid retained page field envelope.');
  if (resultNodes.some(n => !is(n, 'r'))) throw new Error('A paragraph page field result requires run elements.');
  const source = [...root.children];
  if (source.length === 1 && is(source[0], 'fldSimple')) {
    const wrapper = doc.importNode(source[0], true);
    wrapper.replaceChildren(...resultNodes.map(n => doc.importNode(n, true)));
    return [wrapper];
  }
  // The parser stores each delimiter in its own run, even if the producer originally
  // shared that run with instruction/result text or outside paragraph text.
  // Delimiters of fields nested in the instruction are skipped by depth.
  let depth = 0, separate = -1, end = -1;
  source.forEach((n, i) => {
    for (const c of n.children) {
      if (!is(c, 'fldChar')) continue;
      const kind = c.getAttributeNS(W, 'fldCharType');
      if (kind === 'begin') depth++;
      else if (kind === 'separate' && depth === 1 && separate < 0) separate = i;
      else if (kind === 'end' && --depth === 0 && end < 0) end = i;
    }
  });
  if (end !== source.length - 1 || end < 0) throw new Error('Invalid retained page field end.');
  const opening = source.slice(0, separate < 0 ? end : separate + 1).map(n => doc.importNode(n, true));
  if (separate < 0 && field.type !== 'XE') {
    const run = doc.createElementNS(W, 'w:r'), marker = doc.createElementNS(W, 'w:fldChar');
    marker.setAttributeNS(W, 'w:fldCharType', 'separate'); run.append(marker); opening.push(run);
  }
  return [...opening, ...resultNodes.map(n => doc.importNode(n, true)), doc.importNode(source[end], true)];
}
