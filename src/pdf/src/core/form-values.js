import { PDFArray, PDFName } from 'pdf-lib';

export function defaultFieldValue(field) {
  const acro = field.acroField;
  const raw = acro.dict.context.lookup(acro.getInheritableAttribute(PDFName.of('DV')));
  return raw instanceof PDFArray
    ? raw
        .asArray()
        .map((item) => acro.dict.context.lookup(item)?.decodeText?.())
        .filter((item) => typeof item === 'string')
    : raw?.decodeText?.();
}

export function textValue(field) {
  if (field.acroField.V() !== undefined) return field.getText() || '';
  const value = defaultFieldValue(field);
  return typeof value === 'string' ? value : '';
}

export function choiceValues(field) {
  if (field.acroField.V() !== undefined) return field.getSelected();
  const value = defaultFieldValue(field);
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

export function choiceOptions(field) {
  // PDF.js resolves options through the field's parents. Give pdf-lib's option parser
  // the same read-only view, without copying or changing shared parent dictionaries.
  const source = Object.create(field.acroField);
  source.Opt = () => source.dict.context.lookup(source.getInheritableAttribute(PDFName.of('Opt')));
  return source.getOptions().map(({ value, display }) => ({
    value: value.decodeText(),
    label: (display || value).decodeText(),
  }));
}

/** Separates an export value shared by several options from the option's position. */
export const CHOICE_INDEX = '\uE000';
/**
 * The value each option stands for in a selection: its export value, or, when other options
 * export the same value, that value with its position (PDF records which one in /I).
 */
export function choiceKeys(options) {
  const counts = new Map();
  for (const { value } of options) counts.set(value, (counts.get(value) ?? 0) + 1);
  return options.map(({ value }, index) =>
    counts.get(value) > 1 ? `${value}${CHOICE_INDEX}${index}` : value,
  );
}
/** Split selection keys into export values and option positions (-1 for typed values). */
export function readChoiceKeys(keys, options) {
  return keys.map((key) => {
    const [value, position] = String(key).split(CHOICE_INDEX);
    const index =
      position !== undefined && options[Number(position)]?.value === value
        ? Number(position)
        : options.findIndex((option) => option.value === value);
    return { value, index };
  });
}
/**
 * The selected options, as keys (see choiceKeys) and positions. /I tells apart options that
 * share an export value; otherwise each selected value is its first option.
 */
export function selectedChoices(field, options = choiceOptions(field)) {
  const values = choiceValues(field);
  const keys = choiceKeys(options);
  const raw = field.acroField.dict.lookup(PDFName.of('I'));
  const listed =
    raw instanceof PDFArray
      ? raw
          .asArray()
          .map((entry) => field.acroField.dict.context.lookup(entry)?.asNumber?.())
          .filter((index) => Number.isInteger(index) && options[index])
      : [];
  // In the order of /V: each value takes a listed position holding it, else its first option.
  const used = new Set();
  return values.map((value) => {
    let index = listed.find((i) => !used.has(i) && options[i].value === value);
    index ??= options.findIndex((option) => option.value === value);
    used.add(index);
    return { key: index >= 0 ? keys[index] : value, index };
  });
}
