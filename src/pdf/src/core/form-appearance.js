import {
  PDFDropdown,
  PDFCheckBox,
  PDFRadioGroup,
  PDFButton,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOptionList,
  PDFString,
  PDFStream,
  PDFTextField,
  TextAlignment,
} from 'pdf-lib';
import {
  defaultTextFieldAppearanceProvider,
  defaultDropdownAppearanceProvider,
  defaultCheckBoxAppearanceProvider,
  defaultRadioGroupAppearanceProvider,
  defaultButtonAppearanceProvider,
} from './appearance-providers.js';
import { choiceOptions, selectedChoices, textValue } from './form-values.js';
import { listAppearance } from './list-appearance.js';
import { formattedNumber, numberFormat } from './form-format.js';
import { retainCryptFilter, withoutCryptFilter } from './stream-filters.js';

const preservedAppearances = new WeakMap();

/** This field kept its existing appearance. Saving must not retry its failed drawing. */
export function preserveFieldAppearance(field, form) {
  let refs = preservedAppearances.get(form);
  if (!refs) preservedAppearances.set(form, (refs = new Set()));
  refs.add(field.ref);
  // A later explicit edit marks the field dirty again and resumes normal regeneration.
  field.markAsClean();
}

/** Appearance text uses display labels; the PDF's stored values remain export codes. */
export function choiceAppearanceProvider(field, options = choiceOptions(field), labels) {
  // Options sharing an export value are highlighted or shown by the one /I names.
  const selected = selectedChoices(field, options);
  if (field instanceof PDFOptionList) {
    const rows = new Set(selected.map(({ index }) => index));
    return (source, widget, font) => listAppearance(source, widget, font, options, rows);
  }
  labels ??= selected.map(({ key, index }) => options[index]?.label ?? key);
  return (source, widget, font) => {
    const display = Object.create(source);
    display.getSelected = () => labels;
    return defaultDropdownAppearanceProvider(display, widget, font);
  };
}

/** Paint the same effective value as the controls, masking password text. */
function textAppearanceProvider(source, widget, font) {
  const display = Object.create(source);
  const value = textValue(source);
  // A number or percent field shows its value as its format does (1,234.50, 25.0%).
  let text = source.isPassword()
    ? '*'.repeat(Array.from(value).length)
    : formattedNumber(value, numberFormat(source));
  if (source.isCombed()) {
    // pdf-lib fills comb cells from the first one. Centered and right-aligned combs start
    // further along by whole cells, as Acrobat and PDF.js draw them; blank cells stay empty.
    const free = (source.getMaxLength() ?? 0) - text.length;
    const alignment = source.getAlignment();
    const skip =
      alignment === TextAlignment.Right
        ? free
        : alignment === TextAlignment.Center
          ? Math.floor(free / 2)
          : 0;
    if (skip > 0) text = ' '.repeat(skip) + text;
  }
  display.getText = () => text;
  return defaultTextFieldAppearanceProvider(display, widget, font);
}

export function textMaxLength(field) {
  const acro = field.acroField;
  const value = acro.dict.context.lookup(acro.getInheritableAttribute(PDFName.of('MaxLen')));
  return value instanceof PDFNumber ? value : undefined;
}

/** Materialize inherited styling for pdf-lib's local-only appearance readers. */
export function prepareFieldAppearance(field, form) {
  const acro = field.acroField;
  if (field instanceof PDFTextField) {
    // MaxLen also controls validation and the number of cells in comb fields.
    for (const entry of ['MaxLen', 'Q']) {
      const key = PDFName.of(entry);
      if (acro.dict.has(key)) continue;
      const value = acro.dict.context.lookup(acro.getInheritableAttribute(key));
      if (value instanceof PDFNumber) acro.dict.set(key, value);
    }
  } else if (!(field instanceof PDFDropdown || field instanceof PDFOptionList)) return;
  if (acro.getDefaultAppearance()) return;
  const key = PDFName.of('DA');
  let appearance = acro.dict.context.lookup(acro.getInheritableAttribute(key));
  if (
    !appearance ||
    ((appearance instanceof PDFString || appearance instanceof PDFHexString) &&
      !appearance.decodeText())
  )
    appearance = form.acroForm.dict.lookup(key);
  if (appearance instanceof PDFString || appearance instanceof PDFHexString)
    acro.dict.set(key, appearance);
}

/** pdf-lib mutates AP in place. Give each widget its own dictionary, keeping streams shared. */
export function detachFieldAppearances(field) {
  for (const widget of field.acroField.getWidgets()) {
    const appearances = widget.dict.lookup(PDFName.of('AP'));
    if (appearances instanceof PDFDict) widget.setAppearances(appearances.clone());
  }
}

/** Regeneration can change styling and several widgets before a later widget fails. */
export function appearanceRollback(field, widgets) {
  const dictionaries = new Set([field.acroField.dict, ...widgets.map((widget) => widget.dict)]);
  for (const widget of widgets) {
    const appearances = widget.dict.lookup(PDFName.of('AP'));
    if (appearances instanceof PDFDict) dictionaries.add(appearances);
  }
  const originals = [...dictionaries].map((dict) => [dict, dict.entries()]);
  return () => {
    for (const [dict, entries] of originals) {
      for (const key of dict.keys()) dict.delete(key);
      for (const [key, value] of entries) dict.set(key, value);
    }
  };
}

function appearanceStreams(widget) {
  const appearances = widget.dict.lookup(PDFName.of('AP'));
  if (!(appearances instanceof PDFDict)) return [];
  return ['N', 'R', 'D'].flatMap((kind) => {
    const value = appearances.lookup(PDFName.of(kind));
    if (value instanceof PDFStream) return [{ kind, state: null, stream: value }];
    if (!(value instanceof PDFDict)) return [];
    return value.entries().flatMap(([state, ref]) => {
      const stream = value.context.lookup(ref);
      return stream instanceof PDFStream ? [{ kind, state, stream }] : [];
    });
  });
}

/** All regeneration paths, including pdf-lib's implicit save, use the same form semantics. */
export function updateFieldAppearance(field, form, font, provider) {
  preservedAppearances.get(form)?.delete(field.ref);
  // pdf-lib's drawing code renames the default appearance's font after the font it drew with
  // (an embedded face, or a placeholder for check boxes), which the form's resources do not
  // list. Other viewers redraw edits from DA, so it keeps naming the field's own font.
  const DA = PDFName.of('DA');
  const defaults = [field.acroField.dict, ...field.acroField.getWidgets().map((w) => w.dict)].map(
    (dict) => [dict, dict.get(DA)],
  );
  prepareFieldAppearance(field, form);
  const protectedWidgets = field.acroField.getWidgets().flatMap((widget) => {
    const sources = appearanceStreams(widget);
    return sources.some(({ stream }) => withoutCryptFilter(stream.dict) !== stream.dict)
      ? [{ widget, sources }]
      : [];
  });
  detachFieldAppearances(field);
  if (field instanceof PDFTextField) field.updateAppearances(font, textAppearanceProvider);
  else if (field instanceof PDFDropdown || field instanceof PDFOptionList)
    field.updateAppearances(font, provider ?? choiceAppearanceProvider(field));
  else if (field instanceof PDFCheckBox) field.updateAppearances(defaultCheckBoxAppearanceProvider);
  else if (field instanceof PDFRadioGroup)
    field.updateAppearances(defaultRadioGroupAppearanceProvider);
  else if (field instanceof PDFButton)
    field.updateAppearances(font, defaultButtonAppearanceProvider);
  else field.defaultUpdateAppearances(font);
  for (const [dict, value] of defaults) value ? dict.set(DA, value) : dict.delete(DA);
  for (const { widget, sources } of protectedWidgets) {
    for (const { kind, state, stream } of appearanceStreams(widget)) {
      // Retained rollover/down drawings may still share the old stream with another field.
      if (sources.some((source) => source.stream === stream)) continue;
      let matching = sources.filter((source) => source.kind === kind && source.state === state);
      if (!matching.length) matching = sources.filter((source) => source.kind === kind);
      if (!matching.length) matching = sources;
      retainCryptFilter(
        stream.dict,
        matching.map(({ stream }) => stream.dict),
      );
    }
  }
}

export function updateFormAppearances(form, font) {
  // Supplying a font is an explicit regeneration request and may resolve an encoding failure.
  const explicit = !!font;
  const preserved = explicit ? undefined : preservedAppearances.get(form);
  for (const field of form.getFields()) {
    if (preserved?.has(field.ref) && !form.fieldIsDirty(field.ref)) continue;
    const dirty = form.fieldIsDirty(field.ref);
    let restore;
    try {
      if (!field.needsAppearancesUpdate()) continue;
      if (!explicit && !dirty) restore = appearanceRollback(field, field.acroField.getWidgets());
      updateFieldAppearance(field, form, (font ??= form.getDefaultFont()));
    } catch (error) {
      // An untouched imported field must not prevent an unrelated edit from saving.
      // Explicit field edits and regeneration requests still report their failures.
      if (explicit || dirty) throw error;
      restore?.();
      preserveFieldAppearance(field, form);
    }
  }
}
