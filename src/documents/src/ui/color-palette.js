import { el, fieldId } from './dom.js';
import { iconEl } from './icons.js';
import { openMenu, closeMenu } from './menu.js';

// Values belong to the caller: RGB text colors and OOXML named highlights
// share a UI, without converting highlight names through a CSS color palette.
export function openColorPalette({ anchor, label, value, choices, reset, onPick, custom = false, recent = [], focusFirst = true, extra = [], customLabel = 'text color' }) {
  let popup;
  const pick = chosen => {
    if (!popup?.menu?.isConnected) return;
    closeMenu();
    onPick(chosen);
  };
  const swatch = choice => el('button.swatch', {
    type: 'button', role: 'menuitemradio', tabindex: -1,
    'aria-label': choice.label, 'aria-checked': String(value === choice.value), title: choice.label,
    style: { background: choice.color }, onclick: () => pick(choice.value),
  }, value === choice.value && el('span.palette-check', { 'aria-hidden': 'true' }, iconEl('check', 13, 3)));
  const grid = (entries, name) => el('div.menu-custom-grid', {
    role: 'group', 'aria-label': name, dataset: { columns: '8' },
  }, entries.map(swatch));
  const selected = value === null ? 'Mixed' : value === reset.value ? reset.label
    : [...choices, ...extra].find(choice => choice.value === value)?.label || `#${value}`;
  const items = [
    { custom: el('div.palette-heading', { 'aria-hidden': 'true' }, el('span', {}, label), el('span.palette-value', {}, selected)) },
    { custom: el('button.menu-item.palette-reset', {
      type: 'button', role: 'menuitemradio', tabindex: -1, 'aria-checked': String(value === reset.value),
      onclick: () => pick(reset.value),
    }, el(reset.indicator ? 'span.swatch.palette-auto' : 'span.swatch.swatch-none', { 'aria-hidden': 'true' }, reset.indicator), el('span.menu-label', {}, reset.label),
    value === reset.value && iconEl('check', 16)) },
    { separator: true },
    { custom: grid(choices, `${label} colors`) },
  ];
  // After the reset item, in the order given.
  items.splice(2, 0, ...extra.map(choice => ({ label: choice.label, checked: value === choice.value, radio: true, onSelect: () => onPick(choice.value) })));
  if (recent.length) items.push({ header: 'Recent' }, { custom: grid(recent, 'Recent text colors') });
  if (custom) {
    const normalize = text => {
      const hex = text.trim().replace(/^#/, '');
      if (/^[\da-f]{6}$/i.test(hex)) return hex.toUpperCase();
      if (/^[\da-f]{3}$/i.test(hex)) return [...hex].map(c => c + c).join('').toUpperCase();
      return null;
    };
    const initial = normalize(value || '') || '000000';
    const inputId = fieldId('palette-hex');
    const hex = el('input.input.color-hex', {
      id: inputId, type: 'text', value: `#${initial}`, 'aria-label': `Custom ${customLabel} hex value`,
      spellcheck: false, autocomplete: 'off', maxLength: 7,
      oninput: () => {
        const color = normalize(hex.value);
        hex.setCustomValidity(color ? '' : 'Enter a hex color, such as #123456.');
        hex.setAttribute('aria-invalid', String(!color));
        if (color) native.value = `#${color}`;
      },
    });
    const updateDraft = () => { hex.value = native.value.toUpperCase(); hex.setCustomValidity(''); hex.removeAttribute('aria-invalid'); };
    const native = el('input.color-input', {
      type: 'color', value: `#${initial}`, 'aria-label': `Custom ${customLabel}`,
      oninput: updateDraft, onchange: updateDraft,
    });
    items.push({ separator: true }, { custom: el('form.menu-custom-color', {
      'aria-label': `Custom ${customLabel}`, onsubmit: e => {
        e.preventDefault();
        const color = normalize(hex.value);
        if (color) pick(color);
      },
    }, el('label.menu-label', { htmlFor: inputId }, 'Custom'), native, hex,
    el('button.btn.btn-outline.btn-sm', { type: 'submit', 'aria-label': `Apply custom ${customLabel}` }, 'Apply')) });
  }
  if (value === null) items.push({ note: `The selection has mixed ${custom ? 'colors' : 'highlights'}.` });
  popup = openMenu({ anchor, label, items, className: 'color-palette',
    closeOnWindowBlur: !custom, focusFirst: false });
  if (focusFirst && popup.menu) {
    // Let a height-capped palette scroll its selected swatch into view.
    (popup.menu.querySelector('[aria-checked="true"]') || popup.menu.querySelector('button.swatch')).focus();
  }
  return popup;
}
