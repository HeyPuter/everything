import { el } from './lib/ui.js';
import { FormDraft, formWidgets, formWidgetLayout, tabOrderedWidgets } from './core/form-draft.js';
import { formattedText, specialFormatOf } from './core/form-format.js';

/** Buttons and signature fields hold no value to fill in. */
const hasValue = (widget) => widget.type !== 'button' && widget.type !== 'signature';
/**
 * The keyboard a phone shows for a field: digits for a ZIP Code or Social Security number, the
 * phone pad for a phone number (formats that take digits alone); the usual one otherwise.
 */
const inputMode = (widget) =>
  ({ 0: 'numeric', 1: 'numeric', 2: 'tel', 3: 'numeric' })[
    widget.format && specialFormatOf(widget.format)?.style
  ] ?? null;
const rgb = (value, fallback) => (value?.length === 3 ? `rgb(${[...value].join(' ')})` : fallback);

/**
 * The page's fields as native controls. `onTabOut(direction)` is asked when Tab or Shift Tab
 * would leave the page's last or first field; it returns true when it takes the focus on.
 * `onAction(action)` runs the form's own Print and Reset buttons (pushButtonAction), and
 * signs or shows a signature field ({ kind: 'signature', name }).
 */
export function createFormLayer({ onChange, onCommit, onTabOut, onAction }) {
  const draft = new FormDraft();
  const root = el('div', { class: 'form-layer', role: 'group', 'aria-label': 'Page form fields' });
  const error = el('p', {
    class: 'form-edit-error',
    id: 'form-edit-error',
    role: 'alert',
    hidden: true,
  });
  // Comb controls realign their boxes when their value changes.
  const combs = new WeakMap();
  // A formatted field's value as its format shows it, while another field has the focus; or a
  // calculated field's value as the fields filled in so far work it out.
  const shownValues = new WeakMap();
  let calculatedValues = new Map();
  let widgets = [],
    radioGroups = new Set(),
    controls = new Map(),
    key,
    pendingFocus = null,
    // The field an error is about, when it names one; otherwise every changed field.
    invalidField = null;

  function rememberFocus() {
    const active = document.activeElement;
    if (!root.contains(active) || !active.dataset.widgetId) return;
    pendingFocus = {
      id: active.dataset.widgetId,
      start: active.selectionStart,
      end: active.selectionEnd,
      direction: active.selectionDirection,
      top: active.scrollTop,
      left: active.scrollLeft,
    };
  }
  function setEnabled(enabled) {
    root.hidden = !enabled;
  }
  function setBusy(busy) {
    if (busy) rememberFocus();
    for (const widget of widgets) {
      const control = controls.get(widget.id);
      if (control) control.disabled = busy || widget.readOnly;
    }
    if (!busy && pendingFocus && !root.hidden) {
      const control = controls.get(pendingFocus.id);
      if (control && !control.disabled && document.activeElement === document.body) {
        control.focus({ preventScroll: true });
        if (
          pendingFocus.start != null &&
          (['text', 'password'].includes(control.type) || control.tagName === 'TEXTAREA')
        ) {
          try {
            control.setSelectionRange(pendingFocus.start, pendingFocus.end, pendingFocus.direction);
          } catch {
            /* non-text controls have no selection */
          }
        }
        control.scrollTop = pendingFocus.top;
        control.scrollLeft = pendingFocus.left;
      }
      pendingFocus = null;
    }
  }
  function sync(editingControl) {
    for (const widget of widgets) {
      const control = controls.get(widget.id);
      if (!control || !hasValue(widget)) continue;
      const value = draft.value(widget.name);
      if (widget.type === 'checkbox') control.checked = value.includes(widget.exportValue);
      else if (widget.type === 'radio') control.checked = value.includes(widget.buttonValue);
      else if (control.tagName === 'SELECT') {
        for (const option of control.options)
          option.selected = option.hasAttribute('data-placeholder')
            ? !value.length
            : value.includes(option.value);
      } else if (control !== editingControl) {
        const text =
          widget.type === 'choice'
            ? value.length
              ? widget.options.find((option) => option.value === value[0])?.label ||
                value[0] ||
                '(Empty option)'
              : ''
            : value;
        if (control.value !== text) {
          control.value = text;
          combs.get(control)?.();
        }
      }
      const shown = shownValues.get(control);
      if (shown) {
        const text = formattedText(value, widget.format ?? '');
        shown.textContent = text === value ? '' : text;
        shown.parentElement.classList.toggle('is-formatted', text !== value);
        // A total the fields filled in so far change, until the form is saved and works it out.
        const calculated =
          calculatedValues.has(widget.name) && !draft.changes.has(widget.name)
            ? calculatedValues.get(widget.name)
            : null;
        if (calculated !== null) shown.textContent = formattedText(calculated, widget.format ?? '');
        shown.parentElement.classList.toggle('is-calculated', calculated !== null);
      }
      control.closest('.form-widget').classList.toggle('has-draft', draft.changes.has(widget.name));
      control.setAttribute('aria-invalid', String(!error.hidden && isInvalid(widget)));
    }
  }
  const isInvalid = (widget) =>
    invalidField ? widget.name === invalidField : draft.changes.has(widget.name);
  function changed(widget, value, editingControl) {
    if (widget.readOnly || !draft.set(widget.name, value)) return;
    clearError();
    sync(editingControl);
    onChange();
  }
  function clearError() {
    error.hidden = true;
    error.textContent = '';
    invalidField = null;
    for (const control of controls.values()) control.removeAttribute('aria-errormessage');
  }
  function showError(message, { focus = true, field = null } = {}) {
    error.hidden = false;
    error.textContent = message;
    invalidField = widgets.some((widget) => widget.name === field) ? field : null;
    sync();
    const widget = widgets.find(isInvalid);
    const control = widget && controls.get(widget.id);
    if (control) {
      control.setAttribute('aria-errormessage', error.id);
      if (focus) control.focus();
    }
  }
  function makeControl(widget) {
    // A tooltip names the field the way the form's author wrote it for readers; field names
    // are often internal identifiers.
    const label = widget.tooltip || widget.name;
    const attrs = {
      class: 'form-control',
      'data-widget-id': widget.id,
      'aria-label': `${label}${widget.buttonValue != null ? `: ${widget.buttonLabel ?? widget.buttonValue}` : ''} (on page)${widget.readOnly ? ' (read only)' : ''}`,
      'aria-required': widget.required,
      title: `${label}${widget.readOnly ? ' (read only)' : widget.required ? ' (required)' : ''}`,
      disabled: widget.readOnly,
    };
    let control;
    if (!hasValue(widget)) {
      // The PDF draws the button or signature; this one takes its clicks and keys.
      control = el('button', {
        ...attrs,
        type: 'button',
        'aria-required': null,
        ...(widget.type === 'signature' && {
          'aria-label': `${label}: signature field (on page)`,
          title: `${label}: signature field`,
        }),
      });
      control.addEventListener('click', () => onAction?.(widget.action));
    } else if (widget.type === 'checkbox' || widget.type === 'radio') {
      // A radio group's buttons share a name, so Tab stops at the group once and screen
      // readers count its buttons (2 of 3).
      const group = radioGroups.has(widget.name) ? `page-group-${widget.name}` : null;
      control = el('input', {
        ...attrs,
        type: widget.type,
        name: group ?? `page-widget-${widget.id}`,
      });
      control.addEventListener('change', () =>
        changed(
          widget,
          widget.type === 'radio'
            ? [widget.buttonValue]
            : // One box of a checkbox group is on at most; unticking it leaves none on.
              control.checked
              ? [widget.exportValue]
              : [],
        ),
      );
      if (widget.type === 'radio')
        control.addEventListener('keydown', (event) => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault();
          const group = widgets.filter(
            (w) => w.type === 'radio' && w.name === widget.name && !w.readOnly,
          );
          const direction = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
          const next = group[(group.indexOf(widget) + direction + group.length) % group.length];
          controls.get(next.id)?.focus();
          changed(next, [next.buttonValue]);
        });
    } else if (widget.type === 'choice' && !widget.editableChoice) {
      control = el(
        'select',
        {
          ...attrs,
          multiple: widget.multiple,
          size: !widget.combo ? Math.max(2, Math.min(6, widget.options.length)) : null,
        },
        // A list box shows its own rows, where the PDF draws them; an extra first row would
        // put each option one row below its drawing, under the next option's.
        widget.combo &&
          !widget.multiple &&
          el('option', { value: '', 'data-placeholder': true }, 'Choose an option'),
        ...widget.options.map((option) =>
          el('option', { value: option.value }, option.label || '(Empty option)'),
        ),
      );
      control.addEventListener('change', () =>
        changed(
          widget,
          [...control.selectedOptions]
            .filter((o) => !o.hasAttribute('data-placeholder'))
            .map((o) => o.value),
        ),
      );
    } else {
      control = el(widget.multiline ? 'textarea' : 'input', {
        ...attrs,
        type: widget.multiline ? null : widget.password ? 'password' : 'text',
        maxlength: widget.maxLength,
        placeholder: widget.placeholder,
        inputmode: widget.type === 'text' ? inputMode(widget) : null,
        autocomplete: 'off',
        spellcheck: String(widget.spellcheck),
      });
      control.addEventListener('input', () =>
        changed(
          widget,
          widget.type === 'choice'
            ? control.value
              ? [
                  widget.options.find(
                    (option) => (option.label || '(Empty option)') === control.value,
                  )?.value ?? control.value,
                ]
              : []
            : control.value,
          // A partial custom value can equal an export; keep the user's text and caret.
          widget.type === 'choice' ? control : undefined,
        ),
      );
      if (widget.type === 'choice') control.addEventListener('blur', () => sync());
      control.addEventListener('keydown', (event) => {
        if (
          event.key === 'Enter' &&
          (!widget.multiline || event.ctrlKey || event.metaKey) &&
          !event.isComposing
        ) {
          event.preventDefault();
          if (widget.type === 'choice') sync();
          onCommit();
        }
      });
    }
    control.addEventListener('keydown', (event) => {
      // Escape cancels the input method's candidate before it can cancel the field draft.
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        changed(widget, draft.base.get(widget.name));
        clearError();
        sync();
      } else if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey) {
        const stops = [...root.querySelectorAll('.form-control')].filter((c) => !c.disabled);
        const direction = event.shiftKey ? -1 : 1;
        // The other buttons of a radio group are no stops of their own.
        const here = stops.indexOf(control);
        const beyond = (direction > 0 ? stops.slice(here + 1) : stops.slice(0, here)).filter(
          (other) =>
            !(control.type === 'radio' && other.type === 'radio' && other.name === control.name),
        );
        if (here >= 0 && !beyond.length && onTabOut?.(direction)) event.preventDefault();
      }
    });
    return control;
  }
  function render(
    annotations,
    viewport,
    pageKey,
    layers,
    buttonSelections,
    tooltips,
    radioChoices,
    listSelections,
    tabs,
    structureOrder,
  ) {
    rememberFocus();
    if (key !== pageKey) {
      draft.reset();
      key = pageKey;
      clearError();
    }
    // The controls follow the page's tab order (/Tabs), so Tab visits them in that order.
    widgets = tabOrderedWidgets(
      formWidgets(annotations, layers, buttonSelections, tooltips, radioChoices, listSelections),
      viewport.transform,
      tabs,
      structureOrder,
    );
    draft.register(widgets.filter(hasValue));
    // Buttons sharing a name are on one at a time; groups whose buttons can be on together
    // (in unison, or two buttons for one choice) keep a name per button.
    const choices = new Map();
    for (const widget of widgets.filter((w) => w.type === 'radio')) {
      if (!choices.has(widget.name)) choices.set(widget.name, []);
      choices.get(widget.name).push(widget);
    }
    radioGroups = new Set(
      [...choices]
        .filter(
          ([, group]) =>
            !group.some((w) => w.unison) &&
            new Set(group.map((w) => w.buttonValue)).size === group.length,
        )
        .map(([name]) => name),
    );
    calculatedValues = new Map();
    controls = new Map();
    const fragment = document.createDocumentFragment();
    for (const widget of widgets) {
      const layout = formWidgetLayout(widget, viewport.transform);
      if (!layout) continue;
      const control = makeControl(widget);
      const container = el(
        'div',
        { class: `form-widget form-${widget.type}${widget.required ? ' is-required' : ''}` },
        control,
      );
      Object.assign(container.style, {
        width: `${layout.width}px`,
        height: `${layout.height}px`,
        transform: `matrix(${layout.transform.join(',')})`,
      });
      const size = widget.fontSize || Math.min(widget.multiline ? 12 : 18, layout.height * 0.65);
      container.style.setProperty('--field-font-size', `${size}px`);
      container.style.setProperty('--field-ink', rgb(widget.fontColor, '#111'));
      container.style.setProperty('--field-background', rgb(widget.backgroundColor, '#fff'));
      control.style.textAlign = widget.alignment;
      if (widget.comb && widget.maxLength) {
        control.style.fontFamily = 'monospace';
        const cell = layout.width / widget.maxLength;
        const inset = Math.max(0, (cell - size * 0.6) / 2);
        control.style.letterSpacing = `${2 * inset}px`;
        // The spacing after the last character must not scroll a full field sideways: the
        // control reaches past the box by that much, and the box clips it without scrolling.
        control.style.width = `calc(100% + ${inset + 2}px)`;
        control.style.paddingRight = '0';
        control.style.textAlign = 'left';
        container.style.overflow = 'clip';
        // Centered and right-aligned combs start whole boxes in, as their saved drawing does.
        const align = () => {
          const free = widget.maxLength - control.value.length;
          const skip =
            widget.alignment === 'right'
              ? free
              : widget.alignment === 'center'
                ? Math.floor(free / 2)
                : 0;
          control.style.paddingLeft = `${inset + Math.max(0, skip) * cell}px`;
        };
        align();
        control.addEventListener('input', align);
        combs.set(control, align);
      }
      if (
        (widget.format || widget.calculated) &&
        !widget.comb &&
        !widget.multiline &&
        !widget.password
      ) {
        const shown = el('span', { class: 'form-shown', 'aria-hidden': 'true' });
        shown.style.justifyContent =
          { center: 'center', right: 'flex-end' }[widget.alignment] ?? '';
        container.append(shown);
        shownValues.set(control, shown);
      }
      if (widget.type === 'choice' && widget.editableChoice) {
        const id = `form-options-${widget.id}`;
        control.setAttribute('list', id);
        container.append(
          el(
            'datalist',
            { id },
            ...widget.options.map((o) => el('option', { value: o.label || '(Empty option)' })),
          ),
        );
      }
      controls.set(widget.id, control);
      fragment.append(container);
    }
    root.replaceChildren(fragment);
    sync();
  }
  function undo() {
    if (!draft.undo()) return false;
    clearError();
    sync();
    onChange();
    return true;
  }
  function redo() {
    if (!draft.redo()) return false;
    clearError();
    sync();
    onChange();
    return true;
  }
  return {
    root,
    error,
    draft,
    render,
    setEnabled,
    setBusy,
    rememberFocus,
    sync,
    showError,
    clearError,
    undo,
    redo,
    owns: (element) => root.contains(element),
    /** Whether the page has fields worked out from others, for showCalculated. */
    get calculates() {
      return widgets.some((widget) => widget.calculated);
    },
    /** Show calculated fields' values as the drafts work them out (field name to value). */
    showCalculated(values) {
      calculatedValues = values;
      sync();
    },
    /** Focus the page's first field (`last`: its last one); false when it has none to fill. */
    focusEdge(last = false) {
      const stops = [...root.querySelectorAll('.form-control')].filter((c) => !c.disabled);
      const target = last ? stops.at(-1) : stops[0];
      target?.focus();
      return !!target;
    },
    clearHistory: () => {
      draft.past = [];
      draft.future = [];
    },
    restore: (snapshot) => {
      draft.restore(snapshot);
      sync();
    },
  };
}
