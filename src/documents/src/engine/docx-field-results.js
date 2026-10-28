import { MC, alternateBranch } from './docx-compatibility.js';
import { macroButtonLabelStart } from './docx-macro-buttons.js';
import { elementChildren } from './docx-xml.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const is = (node, name) => node.namespaceURI === W && node.localName === name;
const children = node => elementChildren(node);
const metadata = new Set(['pPr', 'rPr', 'sectPr', 'tblPr', 'trPr', 'tcPr', 'sdtPr', 'del', 'moveFrom']);

// Read one story in document order, including fields spanning paragraphs and
// nested fields inside hyperlinks. Nodes remain attached to the original tree.
// Drawing text belongs to a different story and retains its existing reader.
export function cachedFieldTree(root) {
  const fields = [], stack = [], tokens = [];
  const token = node => tokens.push({ node, owners: stack.map(field => ({ field, phase: field.phase })) });
  const start = (node, simple = false) => {
    const field = { begin: node, parent: stack.at(-1) || null, instructionParents: stack.filter(field => field.phase === 'instruction'), instruction: simple ? node.getAttributeNS(W, 'instr') || '' : '', phase: simple ? 'result' : 'instruction', simple, complete: simple };
    fields.push(field); stack.push(field); return field;
  };
  const walk = node => {
    if (node.namespaceURI === MC && node.localName === 'AlternateContent') {
      let branch;
      try { branch = alternateBranch(node); }
      catch { branch = children(node).find(n => n.localName === 'Fallback') || children(node).find(n => n.localName === 'Choice'); }
      if (branch) walk(branch); return;
    }
    if (node.namespaceURI === W && metadata.has(node.localName)) return;
    if (is(node, 'fldSimple')) {
      const field = start(node, true);
      for (const child of children(node)) walk(child);
      // An unterminated complex field cannot consume the enclosing simple field.
      stack.splice(stack.indexOf(field)); return;
    }
    if (is(node, 'fldChar')) {
      const type = node.getAttributeNS(W, 'fldCharType');
      if (type === 'begin') start(node);
      token(node);
      const active = stack.at(-1);
      if (active && !active.simple) {
        if (type === 'separate' && active.phase === 'instruction') { active.separator = node; active.phase = 'result'; }
        if (type === 'end') { active.end = node; active.complete = true; stack.pop(); }
      }
      return;
    }
    if (is(node, 'instrText')) {
      const active = stack.at(-1);
      if (active?.phase === 'instruction') active.instruction += node.textContent;
      token(node); return;
    }
    if (is(node.parentElement || {}, 'r') || is(node, 'bookmarkStart') || is(node, 'bookmarkEnd')) { token(node); return; }
    if (is(node, 'drawing') || is(node, 'pict') || is(node, 'txbxContent')) return;
    for (const child of children(node)) walk(child);
  };
  walk(root);
  return { fields, tokens };
}

// Display-only projection on the private parsed DOM. The package bytes remain
// authoritative for export. Retain result runs/wrappers so normal style, image,
// bookmark and hyperlink readers can process them instead of a text-only fallback.
export function projectCachedFieldResults(root, styles, selectField = null) {
  const { fields, tokens } = cachedFieldTree(root);
  const selected = selectField ? new Set(fields.filter(field => field.complete && selectField(field))) : null;
  const projects = field => !selected || selected.has(field);
  const containers = new Set();
  const tocHyperlinkRuns = new WeakSet();
  const macro = field => field.complete && macroButtonLabelStart(field.instruction) !== null;
  for (const { node, owners } of tokens) {
    const hidden = owners.some(({ field, phase }) => projects(field) && field.complete && phase === 'instruction' && !macro(field));
    const run = node.parentElement;
    if (!hidden && is(run || {}, 'r') && owners.some(({ field, phase }) => field.complete && phase === 'result' && /^\s*TOC(?:\s|$)/i.test(field.instruction))) {
      const properties = children(run).find(n => is(n, 'rPr'));
      const id = properties && children(properties).find(n => is(n, 'rStyle'))?.getAttributeNS(W, 'val');
      const style = styles?.definitions?.[id];
      if (style?.type === 'character' && style.name.toLowerCase() === 'hyperlink') tocHyperlinkRuns.add(run);
    }
    // MACROBUTTON uses an instruction label, not its cached result. Its existing
    // dedicated preview reader must still see its full source delimiters.
    if (!hidden && owners.some(({ field }) => macro(field))) continue;
    // Delimiters belong to the innermost field. An unsupported outer field's
    // cached result can still contain a supported, live page-number field.
    if ((is(node, 'fldChar') || is(node, 'instrText')) && projects(owners.at(-1)?.field) || hidden) {
      for (let parent = node.parentElement; parent && !is(parent, 'p'); parent = parent.parentElement) if (is(parent, 'r') || is(parent, 'hyperlink')) containers.add(parent);
      node.remove();
    }
  }
  for (const field of fields.reverse()) if (field.simple) {
    // A live nested field inside discarded instruction code must not escape
    // as an empty wrapper that the page-field reader would evaluate visibly.
    if (field.instructionParents.some(parent => projects(parent) && parent.complete && !macro(parent))) field.begin.remove();
    else if (projects(field) && !macro(field)) field.begin.replaceWith(...children(field.begin));
  }
  for (const run of containers) if (is(run, 'r') && children(run).every(n => is(n, 'rPr'))) run.remove();
  for (const link of containers) if (is(link, 'hyperlink') && !link.firstElementChild) link.remove();
  return tocHyperlinkRuns;
}
