/**
 * Flattening turns form fields and comments into fixed page content, so every reader shows
 * them the same way and nobody can change them. Links stay as they are.
 */
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFTextField,
  PDFDropdown,
  PDFOptionList,
  concatTransformationMatrix,
  drawObject,
  endMarkedContent,
  popGraphicsState,
  pushGraphicsState,
  decodePDFRawStream,
} from 'pdf-lib';
import { uniqueName } from './text-edit.js';
import { withoutCryptFilter } from './stream-filters.js';
import {
  appearanceRollback,
  preserveFieldAppearance,
  updateFieldAppearance,
} from './form-appearance.js';
import { annotationList, annotationsOf, formFields, pageRotation } from './structure.js';
import { ensureNoteAppearance } from './notes.js';
import { ensureMarkupAppearance } from './highlight.js';
import { addAnnotationVisibilityLayer } from './optional-content.js';
import { choiceOptions, selectedChoices, textValue } from './form-values.js';

const name = PDFName.of;
const numbers = (value) =>
  value instanceof PDFArray
    ? value.asArray().map((entry) => {
        const n = value.context.lookup(entry);
        return n instanceof PDFNumber ? n.asNumber() : NaN;
      })
    : null;
/** Annotations that flattening leaves alone: links, and widgets when fields are kept. */
const KEEP = new Set(['Link', 'Popup', 'Widget']);
const HIDDEN = 2,
  PRINT = 4,
  NO_VIEW = 32;
/** Replies and review states belong to their comment's thread and are not counted apart. */
const isReply = (dict) => dict.has(name('IRT'));
const invisible = (flags) => !!(flags & HIDDEN) || !!(flags & NO_VIEW && !(flags & PRINT));
/** Reuse at most two visibility groups for an entire flatten operation. */
function visibilityLayer(doc, flags, layers) {
  const view = !(flags & NO_VIEW),
    print = !!(flags & PRINT);
  if (view && print) return undefined;
  const key = view ? 'view' : 'print';
  if (!layers.has(key)) layers.set(key, addAnnotationVisibilityLayer(doc, { view, print }));
  return layers.get(key);
}
/** Every indirect object by identity, built once so appearance streams are found in one step. */
const refIndex = (doc) =>
  new Map(doc.context.enumerateIndirectObjects().map(([ref, object]) => [object, ref]));

/** The normal appearance stream of an annotation, following its appearance state. */
function appearance(doc, dict, refs) {
  const ap = dict.lookup(name('AP'));
  if (!(ap instanceof PDFDict)) return null;
  let ref = ap.get(name('N'));
  let normal = doc.context.lookup(ref);
  if (normal instanceof PDFDict && !(normal instanceof PDFStream)) {
    const state = dict.lookup(name('AS'));
    ref = state instanceof PDFName ? normal.get(state) : undefined;
    normal = doc.context.lookup(ref);
    if (!state) {
      const entries = ap.lookup(name('N')).entries();
      ref = entries.length === 1 ? entries[0][1] : undefined;
      normal = doc.context.lookup(ref);
    }
  }
  if (!(normal instanceof PDFStream)) return null;
  // Generated appearances can be newer than the initial index. Preserve any prepared drawing
  // already cached for a shared appearance, which may differ from its original stream.
  if (ref instanceof PDFRef && !refs.has(normal)) refs.set(normal, ref);
  return normal;
}

/** Generate missing drawings without giving a shared note another page's orientation. */
function preparedAnnotation(doc, page, dict, generated) {
  if (dict.has(name('AP'))) return dict;
  let variants = generated.get(dict);
  if (!variants) generated.set(dict, (variants = new Map()));
  // Markup drawings follow the page; sticky note icons are kept upright in the reader.
  const rotation = dict.lookup(name('Subtype')) === name('Text') ? pageRotation(page) : 0;
  if (variants.has(rotation)) return variants.get(rotation);
  const drawing = dict.clone(doc.context);
  try {
    ensureNoteAppearance(doc, page, drawing) || ensureMarkupAppearance(doc, drawing);
  } catch {
    // Unsupported or malformed annotation data stays available to other readers.
  }
  variants.set(rotation, drawing);
  return drawing;
}

/** Preflight without painting: a field is removed only if every visible widget can be drawn. */
function appearanceMatrix(dict, stream, readable) {
  if (!stream) return null;
  if (!readable.has(stream)) {
    let valid = true;
    try {
      const subtype = stream.dict.lookup(name('Subtype'));
      valid = !subtype || subtype === name('Form');
      if (valid && stream instanceof PDFRawStream) {
        // Unlocking handled Crypt already. Validate the remaining encodings without
        // changing the appearance's selector, which protected exports still need.
        const dict = withoutCryptFilter(stream.dict);
        decodePDFRawStream(
          dict === stream.dict ? stream : PDFRawStream.of(dict, stream.getContents()),
        ).decode();
      }
    } catch {
      valid = false;
    }
    readable.set(stream, valid);
  }
  if (!readable.get(stream)) return null;
  const rect = numbers(dict.lookup(name('Rect')));
  const bbox = numbers(stream.dict.lookup(name('BBox')));
  if (rect?.length !== 4 || bbox?.length !== 4 || ![...rect, ...bbox].every(Number.isFinite))
    return null;
  const rawMatrix = stream.dict.lookup(name('Matrix'));
  const m = rawMatrix === undefined ? [1, 0, 0, 1, 0, 0] : numbers(rawMatrix);
  if (m?.length !== 6 || !m.every(Number.isFinite) || m[0] * m[3] === m[1] * m[2]) return null;
  const corners = [
    [bbox[0], bbox[1]],
    [bbox[2], bbox[1]],
    [bbox[2], bbox[3]],
    [bbox[0], bbox[3]],
  ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const xs = corners.map((c) => c[0]),
    ys = corners.map((c) => c[1]);
  const boxWidth = Math.max(...xs) - Math.min(...xs),
    boxHeight = Math.max(...ys) - Math.min(...ys);
  const rx0 = Math.min(rect[0], rect[2]),
    ry0 = Math.min(rect[1], rect[3]),
    rectWidth = Math.abs(rect[2] - rect[0]),
    rectHeight = Math.abs(rect[3] - rect[1]);
  if (!(boxWidth > 1e-9 && boxHeight > 1e-9 && rectWidth > 0 && rectHeight > 0)) return null;
  const sx = rectWidth / boxWidth,
    sy = rectHeight / boxHeight;
  const matrix = [sx, 0, 0, sy, rx0 - sx * Math.min(...xs), ry0 - sy * Math.min(...ys)];
  return matrix.every(Number.isFinite) && sx > 0 && sy > 0 ? matrix : null;
}

/** Draw a preflighted appearance (PDF 32000-1, 12.5.5). */
function paintAppearance(doc, page, stream, matrix, refs, layers) {
  let xobject = refs.get(stream);
  if (stream.dict.has(name('OC')) && (!xobject || doc.context.lookup(xobject) === stream)) {
    // Readers use the annotation's OC when drawing its appearance. Invoking the same stream
    // with Do would additionally apply its XObject-only OC entry and can hide visible content.
    // Prepare one copy for the annotation placements; ordinary uses retain the original OC.
    const drawing = stream.clone(doc.context);
    drawing.dict.delete(name('OC'));
    refs.set(stream, (xobject = doc.context.register(drawing)));
  }
  if (!xobject) refs.set(stream, (xobject = doc.context.register(stream)));
  const resources = page.node.Resources() ?? doc.context.obj({});
  if (!page.node.Resources()) page.node.set(name('Resources'), resources);
  let xobjects = resources.lookup(name('XObject'));
  if (!(xobjects instanceof PDFDict)) {
    xobjects = doc.context.obj({});
    resources.set(name('XObject'), xobjects);
  }
  const key = uniqueName(xobjects, 'Flat');
  xobjects.set(key, xobject);
  const drawing = doc.context.lookup(xobject);
  if (!(drawing.dict.get(name('Subtype')) instanceof PDFName))
    drawing.dict.set(name('Subtype'), name('Form'));
  const operators = [
    pushGraphicsState(),
    concatTransformationMatrix(...matrix),
    drawObject(key.decodeText()),
    popGraphicsState(),
  ];
  for (const layer of layers) {
    const optional = doc.context.lookup(layer);
    if (
      !(optional instanceof PDFDict) ||
      ![name('OCG'), name('OCMD')].includes(optional.lookup(name('Type')))
    )
      continue;
    // Both the original layer condition and the annotation flags apply to the placement.
    // Nested optional content keeps their visibility conditions independent.
    let properties = resources.lookup(name('Properties'));
    if (!(properties instanceof PDFDict)) {
      properties = doc.context.obj({});
      resources.set(name('Properties'), properties);
    }
    const layerName =
      properties.entries().find(([, value]) => value === layer)?.[0] ||
      uniqueName(properties, 'FlatOC');
    properties.set(layerName, layer);
    operators.unshift(
      PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [name('OC'), layerName]),
    );
    operators.push(endMarkedContent());
  }
  page.pushOperators(...operators);
  return true;
}

/** The page each annotation reference sits on, for widgets that do not name their page. */
function annotationPages(doc) {
  const pages = new Map();
  for (const page of doc.getPages()) {
    const annots = annotationsOf(page);
    if (annots)
      for (const ref of annots.asArray())
        for (const key of [ref, doc.context.lookup(ref)]) {
          if (!pages.has(key)) pages.set(key, new Set());
          pages.get(key).add(page);
        }
  }
  return pages;
}

/** Whether flattening draws the field anew, instead of painting the drawing it has. */
function redrawn(field, widgets, regenerate) {
  return (
    widgets.some((widget) => !invisible(widget.dict.lookup(name('F'))?.asNumber?.() ?? 0)) &&
    // NeedAppearances asks viewers to redraw variable text. Buttons keep their own
    // drawings (icons, check styles), as viewers show them, unless they have none.
    ((regenerate &&
      (field instanceof PDFTextField ||
        field instanceof PDFDropdown ||
        field instanceof PDFOptionList)) ||
      field.needsAppearancesUpdate() ||
      (field instanceof PDFTextField && field.isPassword()))
  );
}

/**
 * The texts flattening draws anew, field by field: values of fields that leave their drawing
 * to the viewer or have none. A face that can write them is passed to flattenDocument.
 */
export function redrawnFieldTexts(doc) {
  const fields = formFields(doc);
  if (!fields?.length) return [];
  const regenerate = doc.getForm().acroForm.dict.lookup(name('NeedAppearances')) === PDFBool.True;
  return fields.flatMap((field) => {
    try {
      return redrawn(field, field.acroField.getWidgets(), regenerate) ? drawnFieldTexts(field) : [];
    } catch {
      // A field that cannot be read is kept as it is.
      return [];
    }
  });
}

/** The texts a field's drawing shows: its value, or a list's options (passwords are masked). */
export function drawnFieldTexts(field) {
  if (field instanceof PDFTextField) return field.isPassword() ? [] : [textValue(field)];
  if (field instanceof PDFOptionList) return choiceOptions(field).map(({ label }) => label);
  if (field instanceof PDFDropdown) {
    const options = choiceOptions(field);
    return selectedChoices(field, options).map(({ key, index }) => options[index]?.label ?? key);
  }
  return [];
}

/**
 * Flatten every form field into its pages: each widget's normal appearance is drawn where the
 * widget sat, then the widget and the field are removed. Keep the entire field when any
 * visible widget cannot be painted, so shared widgets never become partially flattened.
 * Returns the number flattened; `unflattened.fields` counts fields left intact.
 */
export function flattenFields(
  doc,
  { refs = refIndex(doc), unflattened = { fields: 0 }, layers = new Map(), fonts = [] } = {},
) {
  const form = doc.getForm();
  const fields = formFields(doc);
  if (!fields?.length) return 0;
  const byAnnot = annotationPages(doc);
  const regenerate = form.acroForm.dict.lookup(name('NeedAppearances')) === PDFBool.True;
  const readable = new WeakMap();
  let flattened = 0;
  let font;
  for (const field of fields) {
    let widgets, restore;
    // Fields that left their drawing to the viewer get an appearance first, as pdf-lib does.
    try {
      widgets = field.acroField.getWidgets();
      if (redrawn(field, widgets, regenerate)) {
        restore = appearanceRollback(field, widgets);
        // Text the standard font cannot write is drawn with a face the caller supplied.
        const faces = [(font ??= form.getDefaultFont()), ...fonts];
        for (const [i, face] of faces.entries())
          try {
            updateFieldAppearance(field, form, face);
            break;
          } catch (error) {
            restore();
            if (i === faces.length - 1) throw error;
          }
      }
    } catch {
      // An old appearance may spell a different value from /V. Keep the field, never bake it.
      restore?.();
      preserveFieldAppearance(field, form);
      unflattened.fields++;
      continue;
    }
    const plans = widgets.map((widget) => {
      const pages = byAnnot.get(widget.dict);
      const flags = widget.dict.lookup(name('F'))?.asNumber?.() ?? 0;
      const hidden = invisible(flags);
      const stream = appearance(doc, widget.dict, refs);
      const matrix = hidden ? null : appearanceMatrix(widget.dict, stream, readable);
      return { widget, pages, stream, matrix, hidden, flags };
    });
    if (!plans.length || plans.some((p) => !p.hidden && (!p.pages?.size || !p.matrix))) {
      restore?.();
      preserveFieldAppearance(field, form);
      unflattened.fields++;
      continue;
    }
    for (const { widget, pages, stream, matrix, hidden, flags } of plans) {
      for (const page of pages || []) {
        if (!hidden)
          paintAppearance(doc, page, stream, matrix, refs, [
            widget.dict.get(name('OC')),
            visibilityLayer(doc, flags, layers),
          ]);
        const ref = refs.get(widget.dict);
        if (ref) page.node.removeAnnot(ref);
        page.node.removeAnnot(widget.dict);
        page.node.removeAnnot(field.ref);
      }
    }
    form.acroForm.removeField(field.acroField);
    for (const widget of widgets) {
      const ref = refs.get(widget.dict);
      if (ref instanceof PDFRef && ref !== field.ref) doc.context.delete(ref);
    }
    doc.context.delete(field.ref);
    flattened++;
  }
  return flattened;
}

/**
 * Flatten `doc` in place: form fields, then every other annotation except links, drawing each
 * visible appearance into its page and removing the annotation and its popup. Returns the
 * counts (including unflattened items), or false when there was nothing to flatten. Annotations
 * hidden both on screen and in print are removed without painting their appearances.
 */
export function flattenDocument(doc, { fields = true, annotations = true, fonts } = {}) {
  const counts = { fields: 0, annotations: 0 };
  const unflattened = { fields: 0, annotations: 0 };
  const refs = refIndex(doc);
  const readable = new WeakMap();
  const generated = new WeakMap();
  const layers = new Map();
  if (fields) counts.fields = flattenFields(doc, { refs, unflattened, layers, fonts });
  if (annotations)
    for (const page of doc.getPages()) {
      let annots = annotationsOf(page);
      if (!annots) continue;
      const remove = new Set();
      for (let i = 0; i < annots.size(); i++) {
        const ref = annots.get(i);
        const dict = doc.context.lookup(ref);
        // pdf-lib's field flattening deletes widget objects but leaves their entries behind.
        if (dict === undefined) {
          remove.add(ref);
          continue;
        }
        if (!(dict instanceof PDFDict)) continue;
        const subtype = dict.lookup(name('Subtype'));
        if (!(subtype instanceof PDFName) || KEEP.has(subtype.decodeText())) continue;
        const flags = dict.lookup(name('F'))?.asNumber?.() ?? 0;
        if (!invisible(flags)) {
          const drawing = preparedAnnotation(doc, page, dict, generated);
          const stream = appearance(doc, drawing, refs);
          const matrix = appearanceMatrix(drawing, stream, readable);
          if (!matrix) {
            unflattened.annotations++;
            continue;
          }
          paintAppearance(doc, page, stream, matrix, refs, [
            dict.get(name('OC')),
            visibilityLayer(doc, flags, layers),
          ]);
        }
        remove.add(ref);
        const popup = dict.get(name('Popup'));
        if (popup) remove.add(popup);
        if (!isReply(dict)) counts.annotations++;
      }
      if (remove.size) annots = annotationList(page);
      for (let i = annots.size() - 1; i >= 0; i--) {
        const ref = annots.get(i);
        const dict = doc.context.lookup(ref);
        if (
          remove.has(ref) ||
          (dict instanceof PDFDict &&
            dict.lookup(name('Subtype')) === name('Popup') &&
            remove.has(dict.get(name('Parent'))))
        )
          annots.remove(i);
      }
    }
  if (unflattened.fields || unflattened.annotations) counts.unflattened = unflattened;
  return counts.fields || counts.annotations || counts.unflattened ? counts : false;
}

/** Page copying cannot carry an unflattened form without orphaning its widgets. */
export function requireFlattenedPages(doc, indices) {
  for (const index of indices)
    for (const ref of annotationsOf(doc.getPage(index))?.asArray() || []) {
      const dict = doc.context.lookup(ref);
      if (dict instanceof PDFDict && dict.lookup(name('Subtype')) === name('Widget'))
        throw new Error(
          'A form field on the selected pages could not be flattened safely. The original PDF has been kept.',
        );
    }
}

/** What flattening would touch, for the dialog. */
export function flattenCounts(doc) {
  let annotations = 0;
  for (const page of doc.getPages()) {
    const annots = annotationsOf(page);
    if (!annots) continue;
    for (const ref of annots.asArray()) {
      const dict = doc.context.lookup(ref);
      const subtype = dict instanceof PDFDict ? dict.lookup(name('Subtype')) : null;
      if (subtype instanceof PDFName && !KEEP.has(subtype.decodeText()) && !isReply(dict))
        annotations++;
    }
  }
  return { fields: formFields(doc)?.length ?? 0, annotations };
}
