import { el, uid } from './dom.js';
import { icon } from './icons.js';

export function field({ label, hint, error = '', type = 'text', value = '', options, prefix, ...attrs }) {
  const id = attrs.id ?? uid('field');
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const tag = type === 'textarea' ? 'textarea.textarea' : type === 'select' ? 'select.select' : 'input.input';
  const input = el(tag, { ...attrs, id, ...(type !== 'textarea' && type !== 'select' ? { type } : {}) });
  if (options) for (const option of options) input.append(el('option', { value: option.value, disabled: option.disabled }, option.label));
  input.value = value;
  const errorNode = el('span.field-error', { id: errorId, hidden: !error, 'aria-live': 'polite' }, error);
  const element = el('div.field', {}, el('label.field-label', { htmlFor: id }, label),
    prefix ? el('div.input-prefix', {}, icon(prefix), input) : input,
    hint && el('span.field-hint', { id: hintId }, hint), errorNode);
  function setError(message = '') {
    input.setCustomValidity(message);
    input.setAttribute('aria-invalid', String(Boolean(message)));
    errorNode.textContent = message; errorNode.hidden = !message;
    const descriptions = [hint && hintId, message && errorId].filter(Boolean).join(' ');
    if (descriptions) input.setAttribute('aria-describedby', descriptions); else input.removeAttribute('aria-describedby');
  }
  setError(error);
  return { element, input, setError };
}
export function switchField(label, { checked = false, onChange, disabled = false } = {}) {
  const node = el('button.switch', { type: 'button', role: 'switch', 'aria-label': label, 'aria-checked': checked, disabled,
    onclick: () => { checked = !checked; node.setAttribute('aria-checked', String(checked)); onChange?.(checked); },
  }, el('span.switch-thumb'));
  return el('div.setting-row', {}, el('span', {}, label), node);
}
export function checkbox(label, { checked = false, onChange, ...attrs } = {}) {
  return el('label.check-field', {}, el('input', { type: 'checkbox', checked, ...attrs, onchange: (event) => onChange?.(event.target.checked) }), el('span', {}, label));
}
export function segmented({ label, items, value = items[0]?.value, onChange, radio = false }) {
  const nodes = [];
  // With every item disabled the requested value still shows as the checked one.
  if (!items.some((item) => item.value === value && !item.disabled)) value = items.find((item) => !item.disabled)?.value ?? value;
  function paint() {
    for (const [index, node] of nodes.entries()) {
      const selected = items[index].value === value;
      node.setAttribute(radio ? 'aria-checked' : 'aria-pressed', String(selected)); node.tabIndex = selected ? 0 : -1;
    }
  }
  function select(next, notify = true) {
    if (!items.some((item) => item.value === next && !item.disabled)) return;
    value = next;
    paint();
    if (notify) onChange?.(value);
  }
  const element = el('div.seg', { role: radio ? 'radiogroup' : 'group', 'aria-label': label });
  for (const item of items) {
    const node = el('button', { type: 'button', role: radio ? 'radio' : null, disabled: item.disabled, onclick: () => select(item.value) }, item.icon && icon(item.icon, 16), item.label);
    nodes.push(node); element.append(node);
    node.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', ...(radio ? ['ArrowUp', 'ArrowDown'] : []), 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const enabled = nodes.filter((entry) => !entry.disabled);
      const rtl = getComputedStyle(element).direction === 'rtl';
      const delta = ['ArrowUp', 'ArrowDown'].includes(event.key) ? (event.key === 'ArrowDown' ? 1 : -1) : (event.key === 'ArrowRight' ? 1 : -1) * (rtl ? -1 : 1);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (enabled.indexOf(node) + delta + enabled.length) % enabled.length;
      const target = enabled[index]; target.focus(); select(items[nodes.indexOf(target)].value);
    });
  }
  paint();
  return { element, setValue: (next) => select(next, false), get value() { return value; } };
}

/** Radio cards use the same arrow-key interaction as segmented controls. */
export function choiceGroup(options) {
  const control = segmented({ ...options, radio: true });
  control.element.className = 'choices';
  [...control.element.children].forEach((node, index) => {
    node.className = 'choice';
    if (options.items[index].hint) node.append(el('span.field-hint', {}, options.items[index].hint));
  });
  return control;
}
