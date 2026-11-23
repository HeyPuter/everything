/**
 * Tolerant readers of the structures a PDF's pages and form are built from. Writers leave
 * junk in them now and then (an Annots entry that is not an array, a page without a MediaBox,
 * a rotation that is not a quarter turn, a field tree that loops back on itself), and readers
 * pass over it; the editor has to as well.
 */
import {
  AcroTextFlags,
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFPageLeaf,
  PDFPageTree,
  createPDFAcroField,
  PDFAcroPushButton,
  PDFAcroCheckBox,
  PDFAcroComboBox,
  PDFAcroListBox,
  PDFAcroText,
  PDFAcroRadioButton,
  PDFAcroSignature,
  PDFButton,
  PDFCheckBox,
  PDFDropdown,
  PDFOptionList,
  PDFTextField,
  PDFRadioGroup,
  PDFSignature,
} from 'pdf-lib';
import { updateFormAppearances } from './form-appearance.js';

/** Count actual page occurrences before pdf-lib expands them into its page cache. */
export function boundedPageCount(doc, limit) {
  const active = new Set(),
    seen = new Set(),
    stack = [];
  let count = 0,
    steps = 0,
    budget = 100000;
  const enter = (node) => {
    if (active.has(node)) throw new Error('The PDF page tree contains a cycle.');
    const kids = node.Kids();
    // Ordinary trees add work and budget together. A compact graph that repeats empty
    // branches can expand exponentially even without ever reaching the page limit.
    if (!seen.has(node)) {
      seen.add(node);
      budget += 8 * kids.size();
    }
    active.add(node);
    stack.push({ node, kids, next: 0 });
  };
  enter(doc.catalog.Pages());
  while (stack.length) {
    if (++steps > budget) throw new Error('The PDF page tree is too complex to open safely.');
    const frame = stack.at(-1);
    if (frame.next === frame.kids.size()) {
      active.delete(frame.node);
      stack.pop();
      continue;
    }
    const child = doc.context.lookup(frame.kids.get(frame.next++));
    if (child instanceof PDFPageTree) enter(child);
    else if (child instanceof PDFPageLeaf && ++count > limit) return count;
  }
  return count;
}

/** A page's annotation array, or null when the page has none or the entry is not an array. */
export function annotationsOf(page) {
  const value = page.node.lookup(PDFName.of('Annots'));
  return value instanceof PDFArray ? value : null;
}
/** A page-owned annotation array to mutate, detached from other pages when shared. */
export function annotationList(page) {
  const existing = annotationsOf(page);
  if (
    existing &&
    !page.doc.getPages().some((other) => other !== page && annotationsOf(other) === existing)
  )
    return existing;
  const array = existing ? existing.clone() : page.doc.context.obj([]);
  page.node.set(PDFName.of('Annots'), array);
  return array;
}
/**
 * An annotation's ID: its reference, or, for a dictionary some writers put in Annots itself
 * instead of a reference to one, its place there. The dictionary as written is no ID: it
 * changed with every edit, and could not be used in a selector.
 */
export const annotationKey = (entry, position) =>
  entry instanceof PDFRef ? entry.toString() : `direct:${position}`;
/** Where the annotation with ID `id` is in the page's annotation array, or -1. */
export const annotationPosition = (annots, id) =>
  annots
    ? annots.asArray().findIndex((entry, position) => annotationKey(entry, position) === id)
    : -1;
/**
 * The editor's IDs for annotations PDF.js reports that are written into Annots directly. PDF.js
 * names those after no object, with an ID of its own making; the two are paired by kind and
 * rectangle, in page order. Empty (and nothing read) when every reported one is an object.
 */
export function directAnnotationIds(page, annotations) {
  const ids = new Map();
  const loose = annotations.filter((annotation) => !/^\d+R\d*$/.test(annotation.id));
  const annots = loose.length ? annotationsOf(page) : null;
  annots?.asArray().forEach((entry, position) => {
    if (!(entry instanceof PDFDict)) return;
    const subtype = entry.lookup(PDFName.of('Subtype'))?.decodeText?.();
    const box = entry.lookup(PDFName.of('Rect'));
    const values =
      box instanceof PDFArray ? box.asArray().map((_, i) => box.lookup(i)?.asNumber?.()) : [];
    if (values.length !== 4 || !values.every(Number.isFinite)) return;
    const [x0, y0, x1, y1] = values;
    const rect = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
    // A note without an appearance is reported at PDF.js's icon size, from its top-left corner.
    const sides = subtype === 'Text' ? [0, 3] : [0, 1, 2, 3];
    const match = loose.find(
      (annotation) =>
        !ids.has(annotation.id) &&
        annotation.subtype === subtype &&
        annotation.rect?.length === 4 &&
        sides.every((i) => Math.abs(rect[i] - annotation.rect[i]) < 0.01),
    );
    if (match) ids.set(match.id, annotationKey(entry, position));
  });
  return ids;
}
/**
 * Remove an annotation from its page together with its popups and its replies, which point at
 * it (or at another reply) through /IRT. Replies left behind were still drawn on the page but
 * listed nowhere, since the comment list shows replies only under their thread.
 */
export function removeAnnotationThread(page, id) {
  const { context } = page.doc;
  const annots = annotationList(page);
  const entries = annots
    .asArray()
    .map((ref, position) => [annotationKey(ref, position), context.lookup(ref)]);
  // Callers that walk Annots themselves (redaction) name a direct dictionary as written.
  if (!entries.some(([key]) => key === id)) {
    const position = annots
      .asArray()
      .findIndex((entry) => !(entry instanceof PDFRef) && entry.toString() === id);
    if (position >= 0) id = entries[position][0];
  }
  const ids = new Set([id]);
  for (let grown = true; grown;) {
    grown = false;
    for (const [key, dict] of entries) {
      const parent = dict instanceof PDFDict ? dict.get(PDFName.of('IRT')) : undefined;
      if (!ids.has(key) && parent && ids.has(parent.toString())) {
        ids.add(key);
        grown = true;
      }
    }
  }
  // Popups and their parents by object, which a direct one has instead of a reference.
  const removed = new Set(entries.filter(([key]) => ids.has(key)).map(([, dict]) => dict));
  const popups = new Set();
  for (const dict of removed)
    if (dict instanceof PDFDict) {
      const popup = dict.lookup(PDFName.of('Popup'));
      if (popup) popups.add(popup);
    }
  for (let i = annots.size() - 1; i >= 0; i--) {
    const [key, dict] = entries[i];
    if (
      ids.has(key) ||
      (dict instanceof PDFDict &&
        dict.lookup(PDFName.of('Subtype')) === PDFName.of('Popup') &&
        (popups.has(dict) || removed.has(dict.lookup(PDFName.of('Parent')))))
    )
      annots.remove(i);
  }
}
/**
 * Imported pages can reuse an annotation dictionary. Before editing it, give this page its
 * own popup/reply group and remap its relationships. Appearance resources stay shared;
 * widgets stay attached to the form and are never copied as ordinary page comments.
 */
export function annotationForEdit(page, annotation, { shared, wholePage = false } = {}) {
  const { context } = page.doc;
  const isShared = shared
    ? shared.has(annotation)
    : page.doc.getPages().some(
        (other) =>
          other !== page &&
          annotationsOf(other)
            ?.asArray()
            .some((ref) => context.lookup(ref) === annotation),
      );
  if (!isShared) return annotation;
  const annots = annotationList(page);
  const entries = annots.asArray().map((ref) => context.lookup(ref));
  const related = new Map();
  const include = (entry) => {
    if (
      entry instanceof PDFDict &&
      entry.lookup(PDFName.of('Subtype')) !== PDFName.of('Widget') &&
      !related.has(entry)
    )
      related.set(entry, new Set());
  };
  for (const entry of entries) {
    include(entry);
    // Some writers omit the popup's separate Annots entry but still attach it to its note.
    if (related.has(entry)) {
      const popup = entry.lookup(PDFName.of('Popup'));
      if (popup instanceof PDFDict && popup.lookup(PDFName.of('Subtype')) === PDFName.of('Popup'))
        include(popup);
    }
  }
  if (!related.has(annotation)) return annotation;
  for (const [entry, neighbors] of related)
    for (const key of ['Popup', 'Parent', 'IRT']) {
      const target = entry.lookup(PDFName.of(key));
      if (related.has(target)) {
        neighbors.add(target);
        related.get(target).add(entry);
      }
    }
  // Individual edits keep unrelated IDs intact. Bulk rotation detaches the whole page once,
  // avoiding a new graph walk for every note. Walk threads without recursive traversal.
  const copies = new Map(),
    pending = wholePage ? [...related.keys()] : [annotation];
  while (pending.length) {
    const entry = pending.pop();
    if (copies.has(entry)) continue;
    copies.set(entry, context.register(entry.clone(context)));
    for (const neighbor of related.get(entry)) pending.push(neighbor);
  }
  for (let i = 0; i < entries.length; i++)
    if (copies.has(entries[i])) annots.set(i, copies.get(entries[i]));
  for (const ref of copies.values()) {
    const copy = context.lookup(ref);
    copy.set(PDFName.of('P'), page.ref);
    for (const key of ['Popup', 'Parent', 'IRT']) {
      const name = PDFName.of(key);
      const related = copies.get(context.lookup(copy.get(name)));
      if (related) copy.set(name, related);
    }
  }
  return context.lookup(copies.get(annotation));
}
/** Snapshot sharing once for bulk edits; newly detached dictionaries are absent from it. */
export function sharedPageAnnotations(doc) {
  const owners = new Map(),
    shared = new Set();
  for (const page of doc.getPages())
    for (const ref of annotationsOf(page)?.asArray() || []) {
      const dict = doc.context.lookup(ref);
      if (!(dict instanceof PDFDict)) continue;
      if (owners.has(dict) && owners.get(dict) !== page) shared.add(dict);
      owners.set(dict, page);
    }
  return shared;
}
/** A page's rotation as readers apply it: a quarter turn within [0, 360), anything else 0. */
export function pageRotation(page) {
  let angle;
  try {
    angle = page.getRotation().angle;
  } catch {
    return 0;
  }
  return Number.isFinite(angle) && angle % 90 === 0 ? ((angle % 360) + 360) % 360 : 0;
}
/** Physical points per PDF user-space unit, matching the page renderer's default. */
export function pageUserUnit(page) {
  const unit = page.node.lookup(PDFName.of('UserUnit'))?.asNumber?.();
  return Number.isFinite(unit) && unit > 0 ? unit : 1;
}
export const DAMAGED_FORM = 'The form in this PDF is damaged, so its fields cannot be read.';
const KIDS = PDFName.of('Kids'),
  PARENT = PDFName.of('Parent'),
  FIELDS = PDFName.of('Fields'),
  FIELD_NAME = PDFName.of('T'),
  FIELD_TYPE = PDFName.of('FT'),
  SUBTYPE = PDFName.of('Subtype'),
  WIDGET = PDFName.of('Widget');
/** Inspect repeated child references and inconsistent Parent links in one bounded walk. */
function fieldTree(doc, collectFields = false) {
  const acroForm = doc.context.lookup(doc.catalog.get(PDFName.of('AcroForm')));
  const fields = acroForm instanceof PDFDict ? acroForm.lookup(FIELDS) : null;
  const remove = new Map(),
    parents = new Map(),
    duplicates = new Set(),
    terminals = [];
  if (!(fields instanceof PDFArray)) return { remove, parents: [], duplicates, terminals };
  const detach = (owner, index, duplicate = false) => {
    if (!remove.has(owner)) remove.set(owner, new Set());
    remove.get(owner).add(index);
    if (duplicate) duplicates.add(owner);
  };
  const seen = new Map();
  const root = { kids: fields, index: 0, form: acroForm };
  const pending = [root];
  while (pending.length) {
    const frame = pending[pending.length - 1];
    if (frame.index === frame.kids.size()) {
      if (frame.isField && !frame.fieldChildren && frame.ref instanceof PDFRef)
        terminals.push([frame.dict, frame.ref]);
      if (frame.dict) seen.set(frame.dict, 2);
      pending.pop();
      continue;
    }
    const index = frame.index++,
      ref = frame.kids.get(index);
    const dict = doc.context.lookup(ref);
    if (!(dict instanceof PDFDict)) continue;
    const state = seen.get(dict);
    if (state === 1) {
      detach(frame, index);
      continue;
    }
    if (state === 2) {
      // A field/widget has at most one parent (ISO 32000-1 Tables 188 and 220).
      // Prefer the declared Parent when another branch lists its child first.
      const first = parents.get(dict);
      if (first && dict.get(PARENT) === frame.ref) {
        detach(first.owner, first.index, true);
        parents.delete(dict);
      } else detach(frame, index, true);
      continue;
    }
    // Matching Parent/Kids links cannot introduce a separate parent cycle. Only
    // inconsistent links need the extra ancestry check, keeping valid forms fast.
    if (dict.get(PARENT) !== frame.ref)
      parents.set(dict, { dict, parent: frame.dict ? frame : null, owner: frame, index });
    const value = dict.get(KIDS);
    const kids = value instanceof PDFRef ? doc.context.lookup(value) : value;
    // A field name is optional. A non-widget child is a field even without /T.
    const isField =
      collectFields &&
      (!frame.dict ||
        dict.has(FIELD_NAME) ||
        dict.has(FIELD_TYPE) ||
        dict.lookup(SUBTYPE) !== WIDGET);
    if (isField) frame.fieldChildren = true;
    seen.set(dict, kids instanceof PDFArray ? 1 : 2);
    if (!(kids instanceof PDFArray)) {
      if (isField && ref instanceof PDFRef) terminals.push([dict, ref]);
      continue;
    }
    pending.push({ kids, index: 0, dict, ref, isField });
  }
  return { remove, parents: [...parents.values()], duplicates, root, terminals };
}

/** Replace only this owner's array; another field may share the original indirect array. */
function detachChildren(doc, frame, indices) {
  frame.kids = doc.context.obj(frame.kids.asArray().filter((_, index) => !indices.has(index)));
  (frame.dict || frame.form).set(frame.dict ? KIDS : FIELDS, frame.kids);
}

/** Drop containers emptied by moving their children back to the declared parent. */
function pruneEmptyGroups(doc, root, emptied) {
  if (!emptied.size) return;
  const pending = [{ ...root, index: 0 }];
  while (pending.length) {
    const frame = pending[pending.length - 1];
    if (frame.index === frame.kids.size()) {
      pending.pop();
      if (frame.drop) detachChildren(doc, frame, frame.drop);
      if (pending.length && !frame.kids.size() && (frame.drop || emptied.has(frame.dict))) {
        const parent = pending[pending.length - 1];
        (parent.drop ??= new Set()).add(parent.index - 1);
      }
      continue;
    }
    const dict = doc.context.lookup(frame.kids.get(frame.index++));
    if (!(dict instanceof PDFDict)) continue;
    const kids = dict.lookup(KIDS);
    if (kids instanceof PDFArray) pending.push({ kids, index: 0, dict });
  }
}
/**
 * Parent links are a separate graph: a valid Kids tree can still contain a looping Parent
 * chain. Find those chains without recursion, retaining the actual child hierarchy for repair.
 * A shared ancestor is examined once, including ancestors outside the AcroForm's Fields tree.
 */
function cyclicParents(parents) {
  const cyclic = new Map();
  for (const { dict: start } of parents) {
    const path = new Set();
    let dict = start;
    while (dict instanceof PDFDict && !cyclic.has(dict) && !path.has(dict)) {
      path.add(dict);
      dict = dict.lookup(PARENT);
    }
    const loops = path.has(dict) || cyclic.get(dict) === true;
    for (const entry of path) cyclic.set(entry, loops);
  }
  const repairs = new Map();
  for (const { dict, parent } of parents)
    if (cyclic.get(dict) && dict.lookup(PARENT) !== parent?.dict) repairs.set(dict, parent);
  return repairs;
}
/**
 * Remove repeated children and restore cyclic Parent chains to the surviving hierarchy, so
 * pdf-lib can walk and save the form without overflowing its stack. Returns whether it changed.
 */
export function repairForm(doc) {
  const tree = fieldTree(doc);
  const emptied = new Set();
  // Plan removals per owner, not per array, because different fields can share Kids.
  for (const [frame, indices] of tree.remove) {
    const { kids, dict } = frame;
    if (
      dict &&
      tree.duplicates.has(frame) &&
      indices.size === kids.size() &&
      kids.asArray().some((ref) => {
        const child = doc.context.lookup(ref);
        return child instanceof PDFDict && child.has(PDFName.of('T'));
      })
    )
      emptied.add(dict);
    detachChildren(doc, frame, indices);
  }
  pruneEmptyGroups(doc, tree.root, emptied);
  const parents = cyclicParents(tree.parents);
  // ISO 32000-1 Table 220: Parent names the field whose Kids contains this field;
  // top-level fields have no Parent. Restore only links whose ancestry loops.
  for (const [dict, parent] of parents) {
    if (!parent) dict.delete(PARENT);
    else {
      if (!(parent.ref instanceof PDFRef)) parent.ref = doc.context.register(parent.dict);
      dict.set(PARENT, parent.ref);
    }
  }
  return tree.remove.size > 0 || parents.size > 0;
}
const fieldTypes = new Map([
  [PDFAcroPushButton, PDFButton],
  [PDFAcroCheckBox, PDFCheckBox],
  [PDFAcroComboBox, PDFDropdown],
  [PDFAcroListBox, PDFOptionList],
  [PDFAcroText, PDFTextField],
  [PDFAcroRadioButton, PDFRadioGroup],
  [PDFAcroSignature, PDFSignature],
]);
const preparedForms = new WeakSet();
/** Keep pdf-lib's implicit save/appearance updates on the same reader as explicit edits. */
function prepareFormReader(doc) {
  const form = doc.getForm();
  if (!preparedForms.has(form)) {
    form.getFields = () => {
      const fields = formFields(doc);
      if (!fields) throw new Error(DAMAGED_FORM);
      return fields;
    };
    form.updateFieldAppearances = (font) => updateFormAppearances(form, font);
    preparedForms.add(form);
  }
}
/** The form's fields, or null when the field tree loops back on itself and cannot be walked. */
export function formFields(doc) {
  const tree = fieldTree(doc, true);
  if (tree.remove.size || cyclicParents(tree.parents).size) return null;
  prepareFormReader(doc);
  const fields = [];
  for (const [dict, ref] of tree.terminals) {
    const field = createPDFAcroField(dict, ref);
    const type = fieldTypes.get(field.constructor);
    if (type) fields.push(type.of(field, ref, doc));
  }
  return fields;
}
/** Read only password fields on import; a damaged neighboring field must not block viewing. */
export function passwordFields(doc) {
  const tree = fieldTree(doc, true);
  if (tree.remove.size || cyclicParents(tree.parents).size) return null;
  const inherited = (dict, key) => {
    while (dict instanceof PDFDict) {
      const value = dict.lookup(key);
      if (value !== undefined) return value;
      dict = dict.lookup(PARENT);
    }
  };
  const fields = [];
  for (const [dict, ref] of tree.terminals) {
    if (inherited(dict, FIELD_TYPE) !== PDFName.of('Tx')) continue;
    const flags = inherited(dict, PDFName.of('Ff'));
    if (flags instanceof PDFNumber && flags.asNumber() & AcroTextFlags.Password)
      fields.push(PDFTextField.of(PDFAcroText.fromDict(dict, ref), ref, doc));
  }
  return fields;
}
/** Make a document safe for pdf-lib to save: page sizes filled in, form cycles broken. */
export function repairDocument(doc) {
  repairPageParents(doc);
  repairPages(doc);
  repairForm(doc);
}

/**
 * Break loops in the page tree's Parent links. pdf-lib follows them without a guard to inherit
 * a page's resources and boxes, so a loop overflowed the stack in most edits, while viewers
 * stop at the repeat. When one exists, every node takes the node whose Kids hold it as its
 * Parent; files without a loop keep their links, so inheritance matches what viewers show.
 */
export function repairPageParents(doc) {
  const PARENT = PDFName.of('Parent');
  const rootRef = doc.catalog.get(PDFName.of('Pages'));
  const root = doc.context.lookup(rootRef);
  if (!(rootRef instanceof PDFRef) || !(root instanceof PDFDict)) return;
  // The reference of the node whose Kids hold each node; the root has none.
  const owners = new Map([[root, null]]);
  const pending = [[root, rootRef]];
  while (pending.length) {
    const [node, nodeRef] = pending.pop();
    const kids = node.lookup(PDFName.of('Kids'));
    if (!(kids instanceof PDFArray)) continue;
    for (const ref of kids.asArray()) {
      const kid = doc.context.lookup(ref);
      if (!(ref instanceof PDFRef) || !(kid instanceof PDFDict) || owners.has(kid)) continue;
      owners.set(kid, nodeRef);
      if (kid.has(PDFName.of('Kids'))) pending.push([kid, ref]);
    }
  }
  const settled = new Set();
  let loop = false;
  for (const node of owners.keys()) {
    const path = new Set();
    let current = node;
    while (current instanceof PDFDict && !settled.has(current)) {
      if (path.has(current)) {
        loop = true;
        break;
      }
      path.add(current);
      current = current.lookup(PARENT);
    }
    if (loop) break;
    for (const visited of path) settled.add(visited);
  }
  if (!loop) return;
  for (const [node, owner] of owners)
    if (owner) node.set(PARENT, owner);
    else node.delete(PARENT);
}

/** Read a nonempty page rectangle as viewers do, normalizing reversed corners. */
export function pageBox(page, key) {
  let box;
  try {
    box = page.doc.context.lookup(page.node.getInheritableAttribute(PDFName.of(key)));
  } catch {
    return null;
  }
  if (!(box instanceof PDFArray) || box.size() !== 4) return null;
  const values = box.asArray().map((entry) => page.doc.context.lookup(entry));
  if (!values.every((value) => value instanceof PDFNumber && Number.isFinite(value.asNumber())))
    return null;
  const [x0, y0, x1, y1] = values.map((value) => value.asNumber());
  if (x0 === x1 || y0 === y1) return null;
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}

/** Give pages without a usable MediaBox the Letter size readers assume for them. */
export function repairPages(doc) {
  const key = PDFName.of('MediaBox');
  for (const page of doc.getPages())
    if (!pageBox(page, 'MediaBox')) page.node.set(key, doc.context.obj([0, 0, 612, 792]));
}
