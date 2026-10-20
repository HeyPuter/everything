import { el } from './lib/ui.js';
import { FormDraft, formWidgets, formWidgetLayout } from './core/form-draft.js';

const rgb = (value, fallback) => (value?.length === 3 ? `rgb(${[...value].join(' ')})` : fallback);

export function createFormLayer({ onChange, onCommit }) {
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
  let widgets = [],
    controls = new Map(),
    key,
    pendingFocus = null;

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
      if (!control) continue;
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
      control.closest('.form-widget').classList.toggle('has-draft', draft.changes.has(widget.name));
      control.setAttribute('aria-invalid', String(!error.hidden && draft.changes.has(widget.name)));
    }
  }
  function changed(widget, value, editingControl) {
    if (widget.readOnly || !draft.set(widget.name, value)) return;
    clearError();
    sync(editingControl);
    onChange();
  }
  function clearError() {
    error.hidden = true;
    error.textContent = '';
    for (const control of controls.values()) control.removeAttribute('aria-errormessage');
  }
  function showError(message, { focus = true } = {}) {
    error.hidden = false;
    error.textContent = message;
    sync();
    const widget = widgets.find((widget) => draft.changes.has(widget.name));
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
      title: `${label}${widget.readOnly ? ' (read only)' : ''}`,
      disabled: widget.readOnly,
    };
    let control;
    if (widget.type === 'checkbox' || widget.type === 'radio') {
      control = el('input', { ...attrs, type: widget.type, name: `page-widget-${widget.id}` });
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
  ) {
    rememberFocus();
    if (key !== pageKey) {
      draft.reset();
      key = pageKey;
      clearError();
    }
    widgets = formWidgets(
      annotations,
      layers,
      buttonSelections,
      tooltips,
      radioChoices,
      listSelections,
    );
    draft.register(widgets);
    controls = new Map();
    const fragment = document.createDocumentFragment();
    for (const widget of widgets) {
      const layout = formWidgetLayout(widget, viewport.transform);
      if (!layout) continue;
      const control = makeControl(widget);
      const container = el('div', { class: `form-widget form-${widget.type}` }, control);
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
