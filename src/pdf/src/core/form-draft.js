import { matrix } from './text-edit.js';
import { annotationLayerVisible } from './optional-content.js';

const clone = (value) => (Array.isArray(value) ? [...value] : value);
export const equalFieldValue = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b)) return a === b;
  if (a.length !== b.length) return false;
  const other = [...b].sort();
  return [...a].sort().every((value, i) => value === other[i]);
};

/** Text suggestions must distinguish different exports even when their display labels match. */
export function choiceInputOptions(choices) {
  const singleLine = (text) => text.replace(/\r\n?|\n/g, ' ');
  const labels = new Map();
  const entries = choices.map(({ value, label }) => {
    label = singleLine(label || value || '(Empty option)');
    if (!labels.has(label)) labels.set(label, new Set());
    labels.get(label).add(value);
    return { value, label };
  });
  const used = new Map();
  return entries.map(({ value, label }) => {
    if (labels.get(label).size > 1) label += ` (${singleLine(value) || 'empty'})`;
    let unique = label;
    let suffix = 2;
    while (used.has(unique) && used.get(unique) !== value) unique = `${label} (${suffix++})`;
    used.set(unique, value);
    return { value, label: unique };
  });
}

/** Values are field-level, so every widget for the same field shares one draft. */
export class FormDraft {
  constructor() {
    this.reset();
  }
  reset() {
    this.base = new Map();
    this.changes = new Map();
    this.past = [];
    this.future = [];
  }
  register(widgets) {
    for (const widget of widgets)
      if (!this.base.has(widget.name)) this.base.set(widget.name, clone(widget.value));
  }
  value(name) {
    return clone(this.changes.has(name) ? this.changes.get(name) : this.base.get(name));
  }
  get dirty() {
    return this.changes.size > 0;
  }
  assign(name, value) {
    if (equalFieldValue(value, this.base.get(name))) this.changes.delete(name);
    else this.changes.set(name, clone(value));
  }
  set(name, value) {
    if (!this.base.has(name) || equalFieldValue(value, this.value(name))) return false;
    this.past.push({ name, before: this.value(name), after: clone(value) });
    if (this.past.length > 25) this.past.shift();
    this.future = [];
    this.assign(name, value);
    return true;
  }
  undo() {
    const edit = this.past.pop();
    if (!edit) return false;
    this.assign(edit.name, edit.before);
    this.future.push(edit);
    return true;
  }
  redo() {
    const edit = this.future.pop();
    if (!edit) return false;
    this.assign(edit.name, edit.after);
    this.past.push(edit);
    return true;
  }
  snapshot() {
    return {
      base: new Map(this.base),
      changes: new Map(this.changes),
      past: [...this.past],
      future: [...this.future],
    };
  }
  restore(snapshot) {
    // Copies, so that later edits leave the snapshot as it was taken.
    this.base = new Map(snapshot.base);
    this.changes = new Map(snapshot.changes);
    this.past = [...snapshot.past];
    this.future = [...snapshot.future];
  }
  get values() {
    return Object.fromEntries(this.changes);
  }
}

/**
 * Checkbox fields whose widgets carry export values of their own (Acrobat's "checkbox
 * group") have one box on at most, so their widgets are drafted as one selection, the way a
 * radio group is; each widget reports whether its own value is the one that is on.
 */
function checkBoxGroups(annotations) {
  const groups = new Map();
  for (const a of annotations) {
    if (!(a.fieldType === 'Btn' && a.checkBox && a.fieldName)) continue;
    const group = groups.get(a.fieldName) ?? { states: new Set(), selected: null };
    group.states.add(a.exportValue);
    if (a.fieldValue != null && a.fieldValue !== 'Off' && a.fieldValue === a.exportValue)
      group.selected = a.exportValue;
    groups.set(a.fieldName, group);
  }
  return groups;
}

/** Only actual, visible form widgets are interactive. No document actions are executed. */
export function formWidgets(annotations, layers, buttonSelections, tooltips) {
  const groups = checkBoxGroups(annotations);
  return annotations.flatMap((a) => {
    if (
      !a.fieldName ||
      a.hidden ||
      a.annotationFlags & 35 ||
      !a.rect?.every(Number.isFinite) ||
      !annotationLayerVisible(a, layers)
    )
      return [];
    let type,
      value,
      buttonValue = a.radioButton ? a.buttonValue : undefined;
    if (a.fieldType === 'Tx') {
      type = 'text';
      value = a.fieldValue ?? '';
    } else if (a.fieldType === 'Ch') {
      type = 'choice';
      value = Array.isArray(a.fieldValue)
        ? a.fieldValue
        : a.fieldValue == null
          ? []
          : [a.fieldValue];
    } else if (a.fieldType === 'Btn' && a.checkBox) {
      type = 'checkbox';
      const group = groups.get(a.fieldName);
      if (group.states.size > 1) buttonValue = a.exportValue;
      // Other choices can live on another page. Keep the export value even when this
      // page alone looks like a plain checkbox; an empty list means no selection.
      value = group.selected == null ? [] : [group.selected];
    } else if (a.fieldType === 'Btn' && a.radioButton && a.buttonValue != null) {
      type = 'radio';
      value = a.fieldValue === 'Off' || a.fieldValue == null ? [] : [a.fieldValue];
    } else return [];
    if (a.fieldType === 'Btn' && buttonSelections?.has(a.fieldName))
      value = buttonSelections.get(a.fieldName);
    if (type === 'text' && typeof value !== 'string') return [];
    const [x0, y0, x1, y1] = a.rect;
    if (x1 <= x0 || y1 <= y0) return [];
    const options = (a.options || []).map((option) => ({
      value: option.exportValue,
      label: option.displayValue,
    }));
    if (type === 'choice')
      for (const selected of value)
        if (!options.some((o) => o.value === selected))
          options.push({ value: selected, label: selected });
    const editableChoice =
      type === 'choice' && !!a.combo && !a.multiSelect && !!(a.fieldFlags & (1 << 18));
    return [
      {
        id: a.id,
        name: a.fieldName,
        // The tooltip (TU) is the field's description for people and assistive technology.
        tooltip:
          (typeof a.alternativeText === 'string' && a.alternativeText.trim()) ||
          tooltips?.get(a.fieldName) ||
          '',
        type,
        value,
        rect: a.rect,
        rotation: a.rotation || 0,
        readOnly: !!a.readOnly,
        required: !!a.required,
        maxLength: a.maxLen > 0 ? a.maxLen : null,
        multiline: !!a.multiLine,
        password: !!a.password,
        spellcheck: !a.password && !(a.fieldFlags & (1 << 22)),
        comb: !!a.comb,
        combo: !!a.combo,
        multiple: !!a.multiSelect,
        options: editableChoice ? choiceInputOptions(options) : options,
        buttonValue,
        exportValue: a.checkBox ? a.exportValue : undefined,
        editableChoice,
        alignment: ['left', 'center', 'right'][a.textAlignment] || 'left',
        fontSize: a.defaultAppearanceData?.fontSize || 0,
        fontColor: a.defaultAppearanceData?.fontColor,
        backgroundColor: a.backgroundColor,
      },
    ];
  });
}

/** Compose widget rotation with page rotation, cropping, zoom, and UserUnit. */
export function formWidgetLayout(widget, viewportTransform) {
  const [left, bottom, right, top] = widget.rect;
  const width = right - left,
    height = top - bottom;
  const angle = ((widget.rotation % 360) + 360) % 360;
  const local = {
    0: [1, 0, 0, -1, left, top],
    90: [0, 1, 1, 0, left, bottom],
    180: [-1, 0, 0, 1, right, bottom],
    270: [0, -1, -1, 0, right, top],
  }[angle];
  if (!local) return null;
  return {
    width: angle % 180 ? height : width,
    height: angle % 180 ? width : height,
    transform: matrix(viewportTransform, local),
  };
}
