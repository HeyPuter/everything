import { readUnderline } from './docx-underlines.js';
import { underlinePattern } from './underlines.js';
import { checkedCapitalization } from './capitalization.js';
import { readCapitalization } from './docx-capitalization.js';
import { checkedStrike, strikeDeclarations } from './strikethrough.js';
import { readStrike } from './docx-strikethrough.js';
import { readKerning } from './docx-kerning.js';
import { checkedKerning } from './kerning.js';
import { readTextScale } from './docx-text-scale.js';
import { checkedTextScale } from './text-scale.js';
import { checkedCharacterSpacing } from './character-spacing.js';
import { readRunSpacing } from './docx-run-spacing.js';
import { checkedBaselineShift } from './vertical-align.js';
import { readRunVertical } from './docx-vertical-align.js';
import { readRunBackground } from './docx-backgrounds.js';
import { parseXml as xml, setContentTypeOverride } from './docx-xml.js';
import { strToU8 } from 'fflate';
import { emptyNumbering, READ_NUMBER_FORMATS } from './numbering.js';
import { relatedPartPath } from './docx-relationships.js';
import { writeFontProperties } from './docx-fonts.js';
import { LEVEL_PARAGRAPH_ELEMENTS } from './numbering-paragraph.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const W16CID = 'http://schemas.microsoft.com/office/word/2016/wordml/cid';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering';
const TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml';
const children = node => [...(node?.children || [])];
const child = (node, name) => children(node).find(n => n.namespaceURI === W && n.localName === name);
const val = node => node?.getAttributeNS(W, 'val');

const serialize = node => new XMLSerializer().serializeToString(node).replace(/^(<\?xml[^?]*encoding=)["'][^"']*["']/i, '$1"UTF-8"');
const integer = (value, fallback, maximum = 2147483647) => {
  if (value === null || value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) throw new Error('Invalid numbering integer.');
  return Number(value);
};
const on = node => node && !['0', 'false', 'off'].includes(val(node));
// Level run properties that state no effect on the number (§17.3.2): switched off, or none. Word's
// Font dialog for a list level writes each option it shows this way. They are ignored and kept.
const OFF_PROPERTIES = ['vanish', 'outline', 'shadow', 'emboss', 'imprint', 'webHidden', 'specVanish', 'rtl', 'cs', 'oMath'];
const inertMarkerProperty = n => n.namespaceURI === W && (n.localName === 'noProof'
  || OFF_PROPERTIES.includes(n.localName) && ['0', 'false', 'off'].includes(val(n))
  || ['em', 'effect', 'highlight'].includes(n.localName) && val(n) === 'none'
  || n.localName === 'bdr' && ['none', 'nil'].includes(val(n)));
// CT_PPrBase order (Part 4 §A.1) of the properties a numbering level's pPr may carry here.
const LEVEL_PPR_ORDER = ['keepNext', 'keepLines', 'pageBreakBefore', 'widowControl', 'suppressLineNumbers', 'pBdr', 'shd', 'tabs', 'suppressAutoHyphens', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents', 'jc'];
const LEVEL_PPR = ['ind', 'tabs', 'contextualSpacing', ...LEVEL_PARAGRAPH_ELEMENTS];
const guarded = fn => { try { return fn(); } catch (error) { return { error: error.message }; } };

function readLegacy(level) {
  const nodes = children(level).filter(n => n.namespaceURI === W && n.localName === 'legacy');
  if (!nodes.length) return undefined;
  const node = nodes[0];
  if (nodes.length !== 1 || children(node).length || [...node.attributes].some(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && (a.namespaceURI !== W || !['legacy', 'legacyIndent', 'legacySpace'].includes(a.localName)))) throw new Error('Invalid legacy numbering properties.');
  const enabled = node.getAttributeNS(W, 'legacy');
  if (enabled !== null && !['0', '1', 'false', 'true', 'off', 'on'].includes(enabled)) throw new Error('Invalid legacy numbering flag.');
  const distance = (name, signed) => {
    const raw = node.getAttributeNS(W, name);
    if (raw === null) return undefined;
    const units = /^([+-]?\d+(?:\.\d+)?)(mm|cm|in|pt|pc|pi)$/.exec(raw);
    const value = units ? Math.round(Number(units[1]) * { mm: 1440 / 25.4, cm: 1440 / 2.54, in: 1440, pt: 20, pc: 240, pi: 240 }[units[2]]) : /^[+-]?\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(value) || Math.abs(value) > 31680 || !signed && value < 0) throw new Error('Invalid legacy numbering distance.');
    return value;
  };
  const indent = distance('legacyIndent', true), space = distance('legacySpace', false);
  // An absent flag is off, as existing documents expect, contrary to Part 4 §14.6.2's default.
  return ['1', 'true', 'on'].includes(enabled) ? { ...(indent !== undefined ? { indent } : {}), space: space ?? 0 } : undefined;
}

export function readNumbering(parts, readGeometry, readColor, readFonts, onError = null, readParagraph = null) {
  const result = emptyNumbering();
  const path = relatedPartPath(parts, 'numbering');
  if (!path) return result;
  const root = xml(parts[path]).documentElement;
  if (root.namespaceURI !== W || root.localName !== 'numbering') throw new Error('Unsupported numbering namespace.');
  const readLevel = (node, emptyIndex) => guarded(() => {
    const index = node ? integer(node.getAttributeNS(W, 'ilvl'), undefined, 8) : emptyIndex;
    if (index === undefined) throw new Error('Missing numbering level index.');
    for (const n of children(node)) if (n.namespaceURI !== W || !['start', 'numFmt', 'lvlRestart', 'pStyle', 'isLgl', 'suff', 'lvlText', 'legacy', 'lvlJc', 'pPr', 'rPr'].includes(n.localName)) throw new Error(`Unsupported numbering property: ${n.localName}.`);
    const format = val(child(node, 'numFmt')) || 'decimal', textNode = child(node, 'lvlText');
    let text = val(textNode) || '';
    if (!READ_NUMBER_FORMATS.includes(format) || child(node, 'numFmt')?.hasAttributeNS(W, 'format')) throw new Error(`Unsupported numbering format: ${format}.`);
    if (['1', 'true', 'on'].includes(textNode?.getAttributeNS(W, 'null')) && !text) throw new Error('Null numbering symbols are not supported.');
    if (text.length > 128 || /[\u0000-\u001f]/u.test(text)) throw new Error('Unsupported numbering label text.');
    const alignment = { start: 'left', end: 'right' }[val(child(node, 'lvlJc'))] || val(child(node, 'lvlJc')) || 'left';
    const suffix = val(child(node, 'suff')) || 'tab';
    if (!['left', 'center', 'right'].includes(alignment) || !['tab', 'space', 'nothing'].includes(suffix)) throw new Error('Unsupported numbering alignment or suffix.');
    let pPr = child(node, 'pPr');
    // An explicit left-to-right direction (w:bidi off) is the default and needs no support.
    const defaultDirection = n => n.namespaceURI === W && n.localName === 'bidi' && ['0', 'false', 'off'].includes(n.getAttributeNS(W, 'val'));
    const unsupported = children(pPr).filter(n => (n.namespaceURI !== W || !LEVEL_PPR.includes(n.localName)) && !defaultDirection(n));
    if (unsupported.length) {
      const messages = [...new Set(unsupported.map(n => `Unsupported numbering paragraph property: ${n.localName}.`))];
      if (!onError) throw new Error(messages[0]);
      // The read-only preview keeps the list and its other properties; only these are ignored.
      for (const message of messages) onError(new Error(message));
      pPr = pPr.cloneNode(true);
      for (const n of children(pPr)) if (n.namespaceURI !== W || !LEVEL_PPR.includes(n.localName)) n.remove();
    }
    // Spacing, alignment, borders… (§17.9.23 pPr) join the list paragraphs' cascade.
    const paragraph = pPr && readParagraph ? readParagraph(pPr) : {};
    const rPr = child(node, 'rPr'), markerStyle = { ...readFonts?.(rPr) };
    for (const n of children(rPr)) {
      if (inertMarkerProperty(n)) continue;
      if (n.namespaceURI !== W || !['rFonts', 'lang', 'b', 'i', 'bCs', 'iCs', 'szCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'color', 'sz', 'u', 'shd', 'vertAlign', 'position', 'spacing', 'w', 'kern'].includes(n.localName)) throw new Error(`Unsupported numbering symbol formatting: ${n.localName}.`);
      if (['bCs', 'iCs', 'szCs'].includes(n.localName)) {
        // Private-use glyphs in symbol fonts retain the ordinary run properties;
        // a separate complex-script size/bold/italic declaration is inactive.
        if (/[^\x20-\x7e\u2022\u25cf\ue000-\uf8ff]/u.test(text)) throw new Error('Complex-script numbering symbols are not supported.');
        if (n.localName === 'szCs') integer(val(n), NaN, 400);
        else if (val(n) !== null && !['0', '1', 'false', 'true', 'off', 'on'].includes(val(n))) throw new Error('Invalid complex-script numbering flag.');
      }
      if (['b', 'i'].includes(n.localName)) markerStyle[n.localName === 'b' ? 'bold' : 'italic'] = on(n);
      if (n.localName === 'sz') {
        markerStyle.fontSize = integer(val(n), NaN, 400) / 2;
        if (!(markerStyle.fontSize >= 1)) throw new Error('Unsupported numbering symbol size.');
      }
    }
    if (readColor) {
      const color = readColor(rPr);
      if (color !== undefined) markerStyle.color = color;
    }
    Object.assign(markerStyle, readRunBackground(rPr, readColor), readRunVertical(rPr), readRunSpacing(rPr), readTextScale(rPr), readKerning(rPr), readStrike(rPr), readCapitalization(rPr), readUnderline(rPr, readColor));
    if ('kerning' in markerStyle) markerStyle.kerning = checkedKerning(markerStyle.kerning);
    if ('textScale' in markerStyle) markerStyle.textScale = checkedTextScale(markerStyle.textScale);
    if ('characterSpacing' in markerStyle) markerStyle.characterSpacing = checkedCharacterSpacing(markerStyle.characterSpacing);
    if ('baselineShift' in markerStyle) markerStyle.baselineShift = checkedBaselineShift(markerStyle.baselineShift);
    // Keep the source glyph as well as its readable fallback. Replacing the
    // Symbol encoding with Unicode unconditionally selects a different glyph.
    const fonts = child(rPr, 'rFonts');
    let symbol;
    if (format === 'bullet' && text === '\uf0b7' && fonts?.getAttributeNS(W, 'ascii') === 'Symbol') {
      symbol = { font: 'Symbol', text, fallback: '•' }; text = symbol.fallback;
    }
    // Private-use label characters are interpreted by the selected font, just
    // like ordinary label text. Preserve them rather than guessing a Unicode
    // substitute: Wingdings, Webdings and custom fonts assign different glyphs
    // to the same code point. Missing fonts use the existing font fallback.
    const legacy = readLegacy(node);
    return { index, start: integer(val(child(node, 'start')), 0, 1000000), format, text, alignment, suffix,
      restart: integer(val(child(node, 'lvlRestart')), undefined, 9), legal: !!on(child(node, 'isLgl')),
      styleId: val(child(node, 'pStyle')), geometry: readGeometry(pPr), ...(Object.keys(paragraph).length ? { paragraph, paragraphXml: serialize(pPr) } : {}), markerStyle, ...(symbol ? { symbol } : {}), ...(legacy ? { legacy } : {}) };
  });
  // An ambiguous ID invalidates that identity, not every unrelated list. Keep
  // all source nodes for style-link ambiguity checks; never pick a duplicate.
  const identified = (tag, attribute, records) => {
    const nodes = new Map(), identities = [];
    for (const node of children(root).filter(n => n.namespaceURI === W && n.localName === tag)) {
      let id = null;
      try {
        id = String(integer(node.getAttributeNS(W, attribute), NaN));
        if (id === 'NaN' || tag === 'num' && id === '0') throw new Error(`Invalid ${attribute}.`);
      } catch (error) {
        if (!onError) throw error;
        onError(new Error(`${path}: ${attribute} is missing or invalid; this numbering record is omitted from the preview.`));
        identities.push([null, node]);
        continue;
      }
      identities.push([id, node]);
      if (nodes.has(id)) {
        const message = `${path}: duplicate ${attribute} ${id}; this ambiguous numbering identity is unavailable in the preview.`;
        if (!onError) throw new Error(message);
        onError(new Error(message));
        records[id] = { error: message };
      } else nodes.set(id, node);
    }
    return { nodes, identities };
  };
  // A malformed level must not invalidate healthy levels in the same list.
  // Never select a first/last declaration for an ambiguous numeric index.
  const indexed = (node, tag, owner, records, read) => {
    for (const n of children(node).filter(n => n.namespaceURI === W && n.localName === tag)) {
      let index;
      try {
        index = integer(n.getAttributeNS(W, 'ilvl'), undefined, 8);
        if (index === undefined) throw new Error('Missing numbering level index.');
      } catch (error) {
        if (!onError) throw error;
        onError(new Error(`${path}: ${owner} ${tag} has a missing or invalid ilvl; only this unidentifiable record is omitted from the preview.`));
        continue;
      }
      try {
        if (Object.hasOwn(records, index)) throw new Error(`Duplicate ${tag} index ${index}.`);
        records[index] = read(n, index);
      } catch (error) {
        if (!onError) throw error;
        const message = `${path}: ${owner} ${tag} index ${index}: ${error.message} Only this level is unavailable in the preview.`;
        onError(new Error(message));
        // An invalid override must not fall through to its abstract level.
        records[index] = tag === 'lvlOverride' ? { level: { error: message } } : { error: message };
      }
    }
    return records;
  };
  const { nodes: abstractNodes, identities: abstractIdentities } = identified('abstractNum', 'abstractNumId', result.abstracts);
  for (const [id, node] of abstractNodes) {
    if (result.abstracts[id]?.error) continue;
    result.abstracts[id] = guarded(() => {
      const levels = indexed(node, 'lvl', `abstractNum ${id}`, [], n => readLevel(n));
      return { levels };
    });
  }
  const { nodes: instanceNodes } = identified('num', 'numId', result.instances);
  for (const [id, node] of instanceNodes) {
    if (result.instances[id]?.error) continue;
    result.instances[id] = guarded(() => {
      const abstractId = String(integer(val(child(node, 'abstractNumId')), NaN)), overrides = {};
      indexed(node, 'lvlOverride', `num ${id}`, overrides, (n, index) => {
        const level = child(n, 'lvl');
        const start = integer(val(child(n, 'startOverride')), undefined, 1000000);
        if (!level) return { start };
        const childIndex = integer(level.getAttributeNS(W, 'ilvl'), undefined, 8);
        if (childIndex === undefined) throw new Error('Missing numbering override level index.');
        // Conflicting child indexes become an empty replacement level,
        // rather than applying the child properties at the parent's index.
        const parsed = childIndex === index ? readLevel(level) : readLevel(null, index);
        if (!parsed.error && [...parsed.text.matchAll(/%([1-9])/g)].some(m => Number(m[1]) - 1 > index)) {
          // Unlike a deeper reference in an abstract level, this discards the
          // whole override, including its startOverride, as the native reference does.
          return { ignored: true };
        }
        const ownStart = childIndex === index ? integer(val(child(level, 'start')), undefined, 1000000) : undefined;
        return { level: parsed, start: start === undefined ? undefined : ownStart ?? start };
      });
      return { abstractId, overrides, sourceXml: serialize(node) };
    });
  }
  if ([...abstractNodes.values()].some(n => child(n, 'numStyleLink'))) {
    // Part 1 §§17.9.21,17.9.27: styleLink identifies the underlying abstract.
    // The numbering style's numId/instance overrides are not used here.
    // Keep the caller's abstract ID so separate aliases keep separate counters.
    const stylesPath = relatedPartPath(parts, 'styles');
    const stylesRoot = stylesPath ? xml(parts[stylesPath]).documentElement : null;
    const styles = new Map(), backlinks = new Map(), resolved = new Set();
    for (const style of children(stylesRoot).filter(n => n.namespaceURI === W && n.localName === 'style')) {
      const id = style.getAttributeNS(W, 'styleId');
      if (!styles.has(id)) styles.set(id, []);
      styles.get(id).push(style);
    }
    for (const [id,node] of abstractIdentities) {
      const name = val(child(node, 'styleLink'));
      if (name !== null && name !== undefined) {
        if (!backlinks.has(name)) backlinks.set(name, []);
        backlinks.get(name).push(id);
      }
    }
    const backing = name => {
      const seen = new Set();
      while (name) {
        if (seen.has(name)) throw new Error('Cyclic numbering style inheritance.');
        seen.add(name);
        const matches = styles.get(name);
        if (matches?.length !== 1 || matches[0].getAttributeNS(W, 'type') !== 'numbering') throw new Error('Missing or ambiguous linked numbering style.');
        const definitions = backlinks.get(name);
        if (definitions?.length > 1) throw new Error('Ambiguous numbering style definition.');
        if (definitions?.length) {
          if (definitions[0] === null) throw new Error('Linked numbering style has an invalid definition identity.');
          return definitions[0];
        }
        name = val(child(matches[0], 'basedOn'));
      }
      return null;
    };
    const resolve = (id, chain = new Set()) => {
      if (resolved.has(id)) return result.abstracts[id];
      if (chain.has(id)) throw new Error('Cyclic linked numbering definitions.');
      const initial = result.abstracts[id], node = abstractNodes.get(id), link = child(node, 'numStyleLink');
      if (!link || initial.error) return initial;
      const next = new Set(chain); next.add(id);
      const value = guarded(() => {
        const links = children(node).filter(n => n.namespaceURI === W && n.localName === 'numStyleLink');
        if (links.length !== 1 || children(link).length || !val(link)) throw new Error('Invalid numbering style link.');
        const target = backing(val(link));
        if (target === null) {
          // Local levels are retained when no underlying definition exists.
          // Empty unresolved aliases remain guarded rather than invented lists.
          if (initial.levels.some(Boolean)) return initial;
          throw new Error('Linked numbering style has no underlying definition.');
        }
        const definition = resolve(target, next);
        if (definition.error) throw new Error(definition.error);
        return { ...initial, levels: structuredClone(definition.levels) };
      });
      result.abstracts[id] = value; resolved.add(id); return value;
    };
    for (const id of abstractNodes.keys()) resolve(id);
  }
  // Full overrides replace formatting, but their ordinary initial count comes
  // from the resolved abstract level. A declared startOverride activates the
  // child start (when present), handled above. Resolve aliases before this step.
  for (const instance of Object.values(result.instances)) {
    const abstract = result.abstracts[instance.abstractId];
    for (const [index, override] of Object.entries(instance.overrides || {})) {
      if (override.level && !override.level.error) {
        override.level.restartStart = override.level.start;
        override.level.start = abstract?.levels?.[index]?.start ?? 0;
      }
    }
  }
  return result;
}

export function writeNumbering(parts, numbering) {
  const abstracts = Object.entries(numbering.abstracts).filter(([, v]) => v.generated);
  const instances = Object.entries(numbering.instances).filter(([, v]) => v.generated);
  if (!abstracts.length && !instances.length) return;
  const existingPath = relatedPartPath(parts, 'numbering');
  let path = existingPath || 'word/numbering.xml';
  if (!existingPath) for (let i = 1; Object.hasOwn(parts, path); i++) path = `word/numbering${i}.xml`;
  const doc = existingPath ? xml(parts[path]) : xml(`<w:numbering xmlns:w="${W}"/>`), root = doc.documentElement;
  const make = (name, value) => { const node = doc.createElementNS(W, `w:${name}`); if (value !== undefined) node.setAttributeNS(W, 'w:val', String(value)); return node; };
  const writeLevel = (level, index) => {
    const node = make('lvl'); node.setAttributeNS(W, 'w:ilvl', String(index));
    node.append(make('start', level.start), make('numFmt', level.format));
    if (level.restart !== undefined) node.append(make('lvlRestart', level.restart));
    if (level.styleId) node.append(make('pStyle', level.styleId));
    if (level.legal) node.append(make('isLgl', '1'));
    node.append(make('suff', level.suffix), make('lvlText', level.symbol?.fallback === level.text ? level.symbol.text : level.text));
    if (level.legacy) {
      const legacy = make('legacy'); legacy.setAttributeNS(W, 'w:legacy', '1');
      if (level.legacy.indent !== undefined) legacy.setAttributeNS(W, 'w:legacyIndent', String(level.legacy.indent));
      legacy.setAttributeNS(W, 'w:legacySpace', String(level.legacy.space)); node.append(legacy);
    }
    node.append(make('lvlJc', level.alignment));
    const pPr = make('pPr'), g = level.geometry;
    // A level derived from an imported one keeps its other paragraph properties
    // as declared; the dialogs edit only its geometry, written below.
    if (level.paragraph && level.paragraphXml) {
      const source = xml(level.paragraphXml).documentElement;
      if (source.namespaceURI === W && source.localName === 'pPr') for (const n of children(source)) if (n.namespaceURI === W && LEVEL_PARAGRAPH_ELEMENTS.includes(n.localName)) pPr.append(doc.importNode(n, true));
    }
    const place = property => pPr.insertBefore(property, children(pPr).find(n => LEVEL_PPR_ORDER.indexOf(n.localName) > LEVEL_PPR_ORDER.indexOf(property.localName)) || null);
    if (g.tabs?.length) {
      const tabs = make('tabs');
      for (const t of g.tabs) { const tab = make('tab', t.numberingOnly ? 'num' : t.alignment); tab.setAttributeNS(W, 'w:pos', String(t.position)); tabs.append(tab); }
      place(tabs);
    }
    if (['indentLeft', 'indentRight', 'firstLine'].some(k => k in g)) {
      const ind = make('ind');
      for (const [key, attr] of [['indentLeft', 'left'], ['indentRight', 'right']]) if (key in g) ind.setAttributeNS(W, `w:${attr}`, String(g[key]));
      if ('firstLine' in g) ind.setAttributeNS(W, g.firstLine < 0 ? 'w:hanging' : 'w:firstLine', String(Math.abs(g.firstLine)));
      place(ind);
    }
    if ('contextualSpacing' in level.geometry) place(make('contextualSpacing', level.geometry.contextualSpacing ? '1' : '0'));
    if (pPr.children.length) node.append(pPr);
    const rPr = make('rPr');
    for (const [key, tag] of [['bold', 'b'], ['italic', 'i'], ['capitalization', 'caps'], ['strikethrough', 'strike'], ['color', 'color'], ['characterSpacing', 'spacing'], ['textScale', 'w'], ['kerning', 'kern'], ['baselineShift', 'position'], ['fontSize', 'sz'], ['underline', 'u'], ['shading', 'shd'], ['verticalAlign', 'vertAlign']]) if (key in level.markerStyle || key === 'underline' && ('underlineStyle' in level.markerStyle || 'underlineColor' in level.markerStyle)) {
      const v = level.markerStyle[key];
      if (key === 'capitalization') { checkedCapitalization(v, true); rPr.append(make(v.startsWith('smallCaps') ? 'smallCaps' : 'caps', ['caps', 'smallCaps'].includes(v) ? '1' : '0')); continue; }
      if (key === 'strikethrough') { checkedStrike(v, true); for (const value of strikeDeclarations(v)) rPr.append(make(value.startsWith('double') ? 'dstrike' : 'strike', ['single', 'double'].includes(value) ? '1' : '0')); continue; }
      if (key === 'underline') { const node = make('u'); if ('underline' in level.markerStyle || 'underlineStyle' in level.markerStyle) node.setAttributeNS(W, 'w:val', underlinePattern(level.markerStyle)); rPr.append(node); continue; }
      rPr.append(make(tag, key === 'shading' ? v === 'foreground' ? 'solid' : 'clear' : ['color', 'verticalAlign', 'textScale'].includes(key) ? v : key === 'characterSpacing' ? Math.round(v * 20) : ['fontSize', 'baselineShift', 'kerning'].includes(key) ? v * 2 : v ? '1' : '0'));
    }
    if (child(rPr, 'shd')) { child(rPr, 'shd').setAttributeNS(W, 'w:color', 'auto'); child(rPr, 'shd').setAttributeNS(W, 'w:fill', level.markerStyle.shading === 'foreground' ? 'auto' : level.markerStyle.shading); }
    if (level.markerStyle.underlineColor && child(rPr, 'u')) child(rPr, 'u').setAttributeNS(W, 'w:color', level.markerStyle.underlineColor);
    writeFontProperties(level.markerStyle, tag => {
      let node = child(rPr, tag);
      if (!node) { node = make(tag); if (tag === 'rFonts') rPr.prepend(node); else rPr.append(node); }
      return node;
    });
    if (rPr.children.length) node.append(rPr);
    return node;
  };
  for (const [id, abstract] of abstracts) {
    const node = make('abstractNum'); node.setAttributeNS(W, 'w:abstractNumId', id); node.append(make('multiLevelType', 'multilevel'));
    abstract.levels.forEach((level, index) => { if (level) node.append(writeLevel(level, index)); });
    root.insertBefore(node, children(root).find(n => ['num', 'numIdMacAtCleanup'].includes(n.localName)) || null);
  }
  for (const [id, instance] of instances) {
    // Restart imported instances by cloning their XML. Unused level overrides and
    // extension metadata must survive even when this preview cannot render them.
    const node = instance.sourceXml ? doc.importNode(xml(instance.sourceXml).documentElement, true) : make('num');
    node.setAttributeNS(W, 'w:numId', id);
    // A clone is a new instance: the source's durable identifier ([MS-DOCX] w16cid:durableId) must stay unique.
    for (const attribute of [...node.attributes]) if (attribute.namespaceURI === W16CID && attribute.localName === 'durableId') node.removeAttributeNode(attribute);
    if (!instance.sourceXml) node.append(make('abstractNumId', instance.abstractId));
    const overrides = instance.sourceXml ? Object.entries(instance.startChanges || {}).map(([index, start]) => [index, { start }]) : Object.entries(instance.overrides);
    for (const [index, override] of overrides) {
      let item = children(node).find(n => n.namespaceURI === W && n.localName === 'lvlOverride' && integer(n.getAttributeNS(W, 'ilvl'), undefined, 8) === Number(index));
      if (!item) { item = make('lvlOverride'); item.setAttributeNS(W, 'w:ilvl', index); node.append(item); }
      if (override.start !== undefined) {
        let start = child(item, 'startOverride');
        if (!start) { start = make('startOverride'); item.prepend(start); }
        start.setAttributeNS(W, 'w:val', String(override.start));
        const original = instance.overrides[index];
        const fullLevel = child(item, 'lvl');
        // A user-requested restart must survive full-level precedence.
        // Discard only the ignored child for this edited level; otherwise update
        // a matching child's explicit start without changing unrelated XML.
        if (fullLevel && original?.ignored) fullLevel.remove();
        else if (fullLevel && integer(fullLevel.getAttributeNS(W, 'ilvl'), undefined, 8) === Number(index)) {
          const childStart = child(fullLevel, 'start');
          if (childStart) childStart.setAttributeNS(W, 'w:val', String(override.start));
        }
      }
      if (override.level && !instance.sourceXml) item.append(writeLevel({ ...override.level, start: override.start ?? override.level.start }, index));
    }
    root.insertBefore(node, child(root, 'numIdMacAtCleanup') || null);
  }
  if (!parts[path]) {
    const relPath = 'word/_rels/document.xml.rels';
    const rels = parts[relPath] ? xml(parts[relPath]) : xml(`<Relationships xmlns="${REL}"/>`);
    const ids = new Set(children(rels.documentElement).map(n => n.getAttribute('Id')));
    let id = 'rNumbering'; while (ids.has(id)) id += '_';
    const relationship = rels.createElementNS(REL, 'Relationship');
    relationship.setAttribute('Id', id); relationship.setAttribute('Type', OFFICE_REL); relationship.setAttribute('Target', path.slice(5));
    rels.documentElement.append(relationship); parts[relPath] = strToU8(serialize(rels));
    const types = xml(parts['[Content_Types].xml']); setContentTypeOverride(types, '/' + path, TYPE);
    parts['[Content_Types].xml'] = strToU8(serialize(types));
  }
  parts[path] = strToU8(serialize(doc));
}
