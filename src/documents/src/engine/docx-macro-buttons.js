const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const is = (node, name) => node?.namespaceURI === W && node.localName === name;
const children = node => node?.children ? elementChildren(node) : [];

// The button shows the complete instruction tail, including literal quotes and
// trailing spaces. The macro name is never exposed as a button or executed.
export function macroButtonLabelStart(instruction) {
  const prefix = /^\s*MACROBUTTON\s+(?:"[^"\r\n]+"|[^\s"]+)\s+/i.exec(instruction);
  return prefix && prefix[0].length < instruction.length ? prefix[0].length : null;
}

// A MACROBUTTON's visible label belongs to its code, not its cached result.
// Retain the complete envelope so formatting a label cannot discard stale
// results, locks, delimiter properties, or the command's original spelling.
export function readMacroButtonField(container) {
  const simple = children(container).find(n => is(n, 'fldSimple'));
  if (simple && (children(simple).some(n => !is(n, 'r')) || [...simple.attributes].some(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && !(a.namespaceURI === W && ['instr', 'fldLock', 'dirty'].includes(a.localName))))) {
    throw new UnsupportedDocumentError('unsupported simple MACROBUTTON metadata');
  }
  const segments = pageFieldSegments(container, instruction => {
    const labelStart = macroButtonLabelStart(instruction);
    if (labelStart === null) throw new UnsupportedDocumentError('an invalid MACROBUTTON instruction');
    return { type: 'MACROBUTTON', instruction, labelStart };
  });
  if (segments.length !== 1 || !segments[0].field) throw new UnsupportedDocumentError('a MACROBUTTON with outside content');
  const field = segments[0].field;
  const label = previewMacroButtons(container);
  const labelNodes = children(label).filter(n => !is(n, 'pPr'));
  if (label === container || labelNodes.some(n => !is(n, 'r') || children(n).some(c => !is(c, 'rPr') && !is(c, 't')))) {
    throw new UnsupportedDocumentError('a non-text MACROBUTTON label');
  }
  return { field, labelNodes };
}

export function writeMacroButtonLabel(field, labelNodes, document) {
  const root = new DOMParser().parseFromString(`<w:p xmlns:w="${W}">${field.source}</w:p>`, 'application/xml').documentElement;
  const retained = readMacroButtonField(root);
  if (retained.field.instruction !== field.instruction) throw new Error('Invalid retained MACROBUTTON instruction.');
  if (!labelNodes.length || labelNodes.some(n => !is(n, 'r') || children(n).some(c => !is(c, 'rPr') && !is(c, 't')))) {
    throw new Error('A MACROBUTTON label requires text runs.');
  }
  const text = nodes => nodes.flatMap(n => children(n).filter(c => is(c, 't'))).map(n => n.textContent).join('');
  // Replacement is a model operation which removes the entire field. This
  // codec formats retained prompts; it must not silently edit hidden code.
  if (text(labelNodes) !== field.instruction.slice(retained.field.labelStart)) throw new Error('Replacing a MACROBUTTON label requires removing its field.');
  const copy = nodes => nodes.map(n => document.importNode(n, true));
  if (labelNodes.map(serializeFragment).join('') === retained.labelNodes.map(serializeFragment).join('')) return copy(children(root));

  const instructionRuns = () => labelNodes.map(node => {
    const run = document.importNode(node, true);
    for (const value of children(run).filter(n => is(n, 't'))) {
      const code = document.createElementNS(W, 'w:instrText');
      code.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
      code.textContent = value.textContent; value.replaceWith(code);
    }
    return run;
  });
  const source = children(root);
  if (source.length === 1 && is(source[0], 'fldSimple')) {
    // Complex instructions can represent split label formatting independently
    // of the saved result. fldSimple is also normalized when edited.
    const make = name => document.createElementNS(W, `w:${name}`);
    const delimiter = kind => { const run = make('r'), value = make('fldChar'); value.setAttributeNS(W, 'w:fldCharType', kind); run.append(value); return run; };
    const begin = delimiter('begin');
    for (const name of ['fldLock', 'dirty']) if (source[0].hasAttributeNS(W, name)) begin.firstElementChild.setAttributeNS(W, `w:${name}`, source[0].getAttributeNS(W, name));
    const prefix = make('r'), code = make('instrText');
    code.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
    code.textContent = field.instruction.slice(0, retained.field.labelStart); prefix.append(code);
    return [begin, prefix, ...instructionRuns(), delimiter('separate'), ...copy(children(source[0])), delimiter('end')];
  }
  const output = []; let at = 0, inserted = false;
  for (const original of source) {
    const instruction = children(original).find(n => is(n, 'instrText'));
    if (!instruction) { output.push(document.importNode(original, true)); continue; }
    const value = instruction.textContent;
    const prefix = value.slice(0, Math.max(0, retained.field.labelStart - at));
    if (prefix) {
      const run = document.importNode(original, true);
      children(run).find(n => is(n, 'instrText')).textContent = prefix;
      output.push(run);
    }
    at += value.length;
    if (!inserted && at >= retained.field.labelStart) {
      output.push(...instructionRuns());
      inserted = true;
    }
  }
  return output;
}

function textRun(source, text, document) {
  const run = source?.cloneNode(false) || document.createElementNS(W, 'w:r');
  const properties = children(source).find(n => is(n, 'rPr'));
  if (properties) run.appendChild(properties.cloneNode(true));
  const value = document.createElementNS(W, 'w:t');
  value.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
  value.textContent = text; run.appendChild(value); return run;
}

// Display-only projection of complete fields within one inline container.
// Unknown, nested or incomplete fields keep their existing cached-result path.
// Return the original node when nothing is projected; never mutate package XML.
export function previewMacroButtons(container, project = labels => labels) {
  const nodes = children(container);
  if (!nodes.some(n => is(n, 'fldSimple') || is(n, 'r') && children(n).some(c => is(c, 'fldChar')))) return container;
  const output = []; let active = null, changed = false;
  const emit = node => { if (active) active.nodes.push(node); else output.push(node); };
  for (const node of nodes) {
    if (is(node, 'fldSimple') && !active) {
      const instruction = node.getAttributeNS(W, 'instr') || '', start = macroButtonLabelStart(instruction);
      if (start !== null) {
        output.push(...project([textRun(children(node).find(n => is(n, 'r')), instruction.slice(start), node.ownerDocument)], [node])); changed = true;
      } else output.push(node);
      continue;
    }
    if (!is(node, 'r')) { emit(node); if (active) active.unsupported = true; continue; }
    const properties = children(node).find(n => is(n, 'rPr'));
    for (const item of children(node).filter(n => n !== properties)) {
      const run = node.cloneNode(false);
      if (properties) run.appendChild(properties.cloneNode(true));
      run.appendChild(item.cloneNode(true));
      if (is(item, 'fldChar')) {
        const type = item.getAttributeNS(W, 'fldCharType');
        if (type === 'begin') {
          if (!active) active = { nodes: [], instructions: [], depth: 0, result: false, unsupported: false };
          else active.unsupported = true;
          active.depth++;
        }
        emit(run);
        if (active && type === 'separate') {
          if (active.result) active.unsupported = true;
          active.result = true;
        }
        if (active && type === 'end' && --active.depth === 0) {
          const instruction = active.instructions.map(part => part.text).join('');
          const start = active.unsupported ? null : macroButtonLabelStart(instruction);
          if (start === null) output.push(...active.nodes);
          else {
            let offset = 0; const labels = [];
            for (const part of active.instructions) {
              const text = part.text.slice(Math.max(0, start - offset));
              if (text) labels.push(textRun(part.run, text, container.ownerDocument));
              offset += part.text.length;
            }
            output.push(...project(labels, active.nodes)); changed = true;
          }
          active = null;
        }
      } else {
        emit(run);
        if (active && !active.result) {
          if (is(item, 'instrText')) active.instructions.push({ text: item.textContent, run: node });
          else active.unsupported = true;
        }
      }
    }
  }
  if (active) output.push(...active.nodes);
  if (!changed) return container;
  const projected = container.cloneNode(false);
  for (const node of output) projected.appendChild(node.parentNode ? node.cloneNode(true) : node);
  // Keep inherited MC/namespace context for neighboring retained drawings.
  let top = projected;
  for (let parent = container.parentElement; parent; parent = parent.parentElement) {
    const shell = parent.cloneNode(false); shell.appendChild(top); top = shell;
  }
  return projected;
}
import { pageFieldSegments } from './docx-page-fields.js';
import { serializeFragment } from './docx-compatibility.js';
import { UnsupportedDocumentError } from './errors.js';
import { elementChildren } from './docx-xml.js';
