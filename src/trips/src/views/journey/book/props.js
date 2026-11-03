// The properties panel: position and size in mm, photo crop, focal point, fit, filter, corners and frame, text
// style, colors, stacking and lock for the selected element; background and layout for the page otherwise.
import { el, uid } from '../../../ui/dom.js';
import { button } from '../../../ui/bits.js';
import { segmented } from '../../../ui/fields.js';
import { t, locale } from '../../../lib/i18n/index.js';
import { COUNTRY_CODES, countryName } from '../../../lib/atlas/countries.js';
import { ALIGNS, COLORS, FILTERS, FONTS, ICONS, SCOPES, SHAPES, STATS, TEXT_STYLES } from '../../../lib/book/constants.js';
import { DEFAULT_TEXT_SIZE } from '../../../lib/book/raster.js';
import { roleText } from '../../../lib/book/layouts.js';
import { elementLabel } from './elements.js';
import { icon, withIcon } from './icons.js';
import { paint } from './palette.js';

const TEXT_DEBOUNCE_MS = 600;
const mm = (value) => Math.round(value * 10) / 10;

function numberField(label, value, { min, max, step = 1, onCommit, disabled }) {
  const id = uid('bk-num');
  const input = el('input.input.bk-num', { id, type: 'number', inputMode: 'decimal', value: String(value), min, max, step, disabled,
    onchange: () => { const next = Number(input.value); if (Number.isFinite(next)) onCommit(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, next))); } });
  return el('div.bk-field', {}, el('label.field-label', { htmlFor: id }, label), input);
}

function rangeField(label, value, { min, max, step, format = (v) => String(v), onInput, onCommit, disabled }) {
  const id = uid('bk-range');
  const output = el('output.bk-out', { htmlFor: id }, format(value));
  const input = el('input.bk-range', { id, type: 'range', min, max, step, value: String(value), disabled,
    oninput: () => { output.textContent = format(Number(input.value)); onInput?.(Number(input.value)); },
    onchange: () => onCommit(Number(input.value)) });
  return el('div.bk-field', {}, el('div.bk-field-head', {}, el('label.field-label', { htmlFor: id }, label), output), input);
}

function selectField(label, value, options, { onCommit, disabled }) {
  const id = uid('bk-select');
  const select = el('select.select', { id, disabled, onchange: () => onCommit(select.value) }, options.map((option) => el('option', { value: option.value }, option.label)));
  select.value = value ?? options[0]?.value ?? '';
  return el('div.bk-field', {}, el('label.field-label', { htmlFor: id }, label), select);
}

function swatches(label, value, { onCommit, none = false, disabled }) {
  const id = uid('bk-sw');
  return el('div.bk-field', { role: 'group', 'aria-labelledby': id }, el('span.field-label', { id }, label),
    el('div.bk-swatches', {}, COLORS.filter((name) => none || name !== 'none').map((name) => el('button.bk-swatch', {
      type: 'button', disabled, 'aria-pressed': String(value === name), 'aria-label': t(`book.color.${name}`), title: t(`book.color.${name}`),
      dataset: { color: name }, style: { '--swatch': paint(name) }, onclick: () => onCommit(name),
    }))));
}

function toggle(label, glyph, pressed, onToggle, disabled) {
  return el('button.icon-btn.bk-toggle', { type: 'button', 'aria-pressed': String(Boolean(pressed)), 'aria-label': label, title: label, disabled, onclick: () => onToggle(!pressed) }, icon(glyph, 16));
}

/**
 * `opts`: `{canEdit(), state() → {book, page, selected, size}, change(id, fields, label), preview(id, fields), pageChange(fields, label),
 * duplicate(id), remove(id), restack(id, where), replacePhoto(id), caption(id), auto(), exportDesign(), importDesign(), layouts()}`.
 */
export function createProps(opts) {
  const element = el('section.bk-props', { 'aria-label': t('book.props.label') });
  let shown = null;
  let textTimer;
  let textInput = null;
  let stale = false;

  const commitText = () => {
    clearTimeout(textTimer);
    if (!textInput) return;
    const { id, value } = textInput;
    const node = textInput.node;
    textInput = { ...textInput, value: node.value };
    if (node.value !== value) opts.change(id, { text: node.value.slice(0, 4000) }, t('book.history.text'));
  };

  function elementPanel(item, state) {
    const disabled = !opts.canEdit();
    const { size } = state;
    const id = item.id;
    const change = (fields, label = t('book.history.edit')) => opts.change(id, fields, label);
    const groups = [];
    const head = el('div.bk-props-head', {}, el('h3', {}, elementLabel(item)),
      el('div.bk-props-tools', {}, opts.canEdit() ? [
        toggle(t(item.lock ? 'book.unlock' : 'book.lock'), item.lock ? 'lock' : 'unlock', item.lock, (lock) => change({ lock: lock || undefined }, t(lock ? 'book.history.lock' : 'book.history.unlock'))),
        el('button.icon-btn', { type: 'button', 'aria-label': t('book.duplicate'), title: t('book.duplicate'), onclick: () => opts.duplicate(id) }, icon('duplicate', 16)),
        el('button.icon-btn', { type: 'button', 'aria-label': t('book.delete'), title: t('book.delete'), onclick: () => opts.remove(id) }, icon('delete', 16)),
      ] : []));
    groups.push(head);
    const geometry = (key, total) => numberField(t(`book.geo.${key}`), mm(item[key] * total), { step: 1, min: key === 'w' || key === 'h' ? 1 : -total, max: total * 2, disabled: disabled || item.lock,
      onCommit: (value) => change({ [key]: Math.round((value / total) * 10_000) / 10_000 }, t('book.history.move')) });
    groups.push(el('fieldset.bk-group', {}, el('legend', {}, t('book.props.position')),
      el('div.bk-grid2', {}, geometry('x', size.w), geometry('y', size.h), geometry('w', size.w), geometry('h', size.h))));
    groups.push(el('div.bk-stack', { role: 'group', 'aria-label': t('book.props.order') },
      ['front', 'up', 'down', 'back'].map((where) => el('button.icon-btn', { type: 'button', disabled, 'aria-label': t(`book.order.${where}`), title: t(`book.order.${where}`),
        onclick: () => opts.restack(id, where) }, icon(where, 16)))));

    if (item.k === 'photo') {
      groups.push(el('fieldset.bk-group', {}, el('legend', {}, t('book.props.photo')),
        el('div.bk-rail-actions', {}, button(t(item.file ? 'book.replacePhoto' : 'book.choosePhoto'), { icon: 'plus', size: 'sm', variant: 'outline', disabled, onclick: () => opts.replacePhoto(id) }),
          item.file ? button(t('book.clearPhoto'), { size: 'sm', variant: 'ghost', disabled, onclick: () => change({ file: undefined }, t('book.history.photo')) }) : null,
          withIcon(button(t('book.addCaption'), { size: 'sm', variant: 'ghost', disabled, onclick: () => opts.caption(id) }), 'text')),
        segmentedField(t('book.fit'), [{ value: 'fill', label: t('book.fit.fill') }, { value: 'fit', label: t('book.fit.fit') }], item.fit ?? 'fill', (value) => change({ fit: value }), disabled),
        rangeField(t('book.zoom'), item.zoom ?? 1, { min: 1, max: 5, step: 0.05, format: (v) => `${Math.round(v * 100)}%`, disabled,
          onInput: (value) => opts.preview(id, { zoom: value }), onCommit: (value) => change({ zoom: value === 1 ? undefined : value }, t('book.history.crop')) }),
        rangeField(t('book.focusX'), item.fx ?? 0.5, { min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%`, disabled,
          onInput: (value) => opts.preview(id, { fx: value }), onCommit: (value) => change({ fx: value }, t('book.history.crop')) }),
        rangeField(t('book.focusY'), item.fy ?? 0.5, { min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%`, disabled,
          onInput: (value) => opts.preview(id, { fy: value }), onCommit: (value) => change({ fy: value }, t('book.history.crop')) }),
        selectField(t('book.filter'), item.filter ?? 'none', FILTERS.map((value) => ({ value, label: t(`book.filter.${value}`) })), { disabled, onCommit: (value) => change({ filter: value === 'none' ? undefined : value }) }),
        rangeField(t('book.radius'), item.radius ?? 0, { min: 0, max: 40, step: 0.5, format: (v) => t('book.mm', { value: v }), disabled,
          onInput: (value) => opts.preview(id, { radius: value }), onCommit: (value) => change({ radius: value || undefined }) }),
        rangeField(t('book.frame'), item.frame ?? 0, { min: 0, max: 15, step: 0.5, format: (v) => t('book.mm', { value: v }), disabled,
          onInput: (value) => opts.preview(id, { frame: value }), onCommit: (value) => change({ frame: value || undefined }) }),
        item.frame > 0 ? swatches(t('book.frameColor'), item.frameColor ?? 'surface', { disabled, onCommit: (value) => change({ frameColor: value }) }) : null));
    }

    if (item.k === 'text' || item.k === 'stats') {
      const fields = [];
      if (item.k === 'text') {
        const textId = uid('bk-text');
        const area = el('textarea.textarea.bk-textarea', { id: textId, dir: 'auto', rows: 5, maxLength: 4000, disabled, value: item.text ?? '',
          oninput: () => { clearTimeout(textTimer); textTimer = setTimeout(commitText, TEXT_DEBOUNCE_MS); },
          onblur: () => commitText() });
        area.value = item.text ?? '';
        textInput = { id, value: item.text ?? '', node: area };
        fields.push(el('div.bk-field', {}, el('label.field-label', { htmlFor: textId }, t('book.text')), area));
        fields.push(selectField(t('book.style'), item.style ?? 'body', TEXT_STYLES.map((value) => ({ value, label: t(`book.style.${value}`) })), { disabled,
          onCommit: (value) => { const role = { heading: 'title', title: 'title', subtitle: 'subtitle', caption: 'caption', quote: 'quote' }[value] ?? 'body';
            const base = roleText(role, state.page.kind);
            change({ style: value, size: value === 'heading' ? 16 : base.size, font: base.font, italic: base.italic }, t('book.history.style')); } }));
      } else {
        fields.push(selectField(t('book.statShown'), item.stat ?? '', [{ value: '', label: t('book.stat.summary') }, ...STATS.map((value) => ({ value, label: t(`book.statName.${value}`) }))],
          { disabled, onCommit: (value) => change({ stat: value || undefined }) }));
      }
      fields.push(selectField(t('book.font'), item.font ?? 'sans', FONTS.map((value) => ({ value, label: t(`book.font.${value}`) })), { disabled, onCommit: (value) => change({ font: value === 'sans' ? undefined : value }) }));
      fields.push(numberField(t('book.size'), item.size ?? DEFAULT_TEXT_SIZE, { min: 4, max: 400, step: 0.5, disabled, onCommit: (value) => change({ size: value }) }));
      fields.push(el('div.bk-row', {},
        toggle(t('book.bold'), 'bold', item.bold, (value) => change({ bold: value || undefined }), disabled),
        toggle(t('book.italic'), 'italic', item.italic, (value) => change({ italic: value || undefined }), disabled),
        el('div.bk-row', { role: 'group', 'aria-label': t('book.align') }, ALIGNS.map((value) => toggle(t(`book.align.${value}`), `align${value[0].toUpperCase()}${value.slice(1)}`,
          (item.align ?? 'start') === value, () => change({ align: value === 'start' ? undefined : value }), disabled)))));
      fields.push(swatches(t('book.color'), item.color ?? 'ink', { disabled, onCommit: (value) => change({ color: value }) }));
      groups.push(el('fieldset.bk-group', {}, el('legend', {}, t('book.props.text')), fields));
    }

    if (item.k === 'shape' || item.k === 'line') {
      groups.push(el('fieldset.bk-group', {}, el('legend', {}, t('book.props.shape')),
        item.k === 'shape' ? selectField(t('book.shapeKind'), item.shape ?? 'rect', SHAPES.map((value) => ({ value, label: t(`book.shape.${value}`) })), { disabled, onCommit: (value) => change({ shape: value }) }) : null,
        item.k === 'shape' ? swatches(t('book.fillColor'), item.fill ?? 'surface-2', { none: true, disabled, onCommit: (value) => change({ fill: value }) }) : null,
        rangeField(t('book.stroke'), item.stroke ?? (item.k === 'line' ? 0.5 : 0), { min: 0, max: 10, step: 0.1, format: (v) => t('book.mm', { value: v }), disabled,
          onInput: (value) => opts.preview(id, { stroke: value }), onCommit: (value) => change({ stroke: value || undefined }) }),
        swatches(t(item.k === 'line' ? 'book.color' : 'book.strokeColor'), item.color ?? 'ink', { disabled, onCommit: (value) => change({ color: value }) }),
        item.k === 'shape' && item.shape !== 'ellipse' ? rangeField(t('book.radius'), item.radius ?? 0, { min: 0, max: 40, step: 0.5, format: (v) => t('book.mm', { value: v }), disabled,
          onInput: (value) => opts.preview(id, { radius: value }), onCommit: (value) => change({ radius: value || undefined }) }) : null));
    }

    if (item.k === 'icon') {
      groups.push(el('fieldset.bk-group', {}, el('legend', {}, t('book.props.icon')),
        selectField(t('book.iconKind'), item.icon, ICONS.map((value) => ({ value, label: t(`book.icon.${value}`) })), { disabled, onCommit: (value) => change({ icon: value }) }),
        swatches(t('book.color'), item.color ?? 'ink', { disabled, onCommit: (value) => change({ color: value }) })));
    }

    if (item.k === 'flag' || item.k === 'country') {
      const options = [...COUNTRY_CODES].map((code) => ({ value: code, label: countryName(code, locale) })).sort((a, b) => a.label.localeCompare(b.label, locale));
      groups.push(el('fieldset.bk-group', {}, el('legend', {}, t('book.props.country')),
        selectField(t('book.country'), item.cc, options, { disabled, onCommit: (value) => change({ cc: value }) }),
        item.k === 'country' ? swatches(t('book.fillColor'), item.fill ?? 'day-1', { disabled, onCommit: (value) => change({ fill: value }) }) : null));
    }

    if (item.k === 'map' || item.k === 'route') {
      groups.push(el('fieldset.bk-group', {}, el('legend', {}, t('book.props.travel')),
        selectField(t('book.scope'), item.scope ?? 'book', SCOPES.map((value) => ({ value, label: t(`book.scope.${value}`) })), { disabled, onCommit: (value) => change({ scope: value }) }),
        item.k === 'map' ? swatches(t('book.mapBackground'), item.fill ?? 'surface-2', { disabled, onCommit: (value) => change({ fill: value }) }) : null,
        swatches(t('book.routeColor'), item.color ?? 'day-1', { disabled, onCommit: (value) => change({ color: value }) })));
    }

    groups.push(rangeField(t('book.opacity'), item.opacity ?? 1, { min: 0.1, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%`, disabled,
      onInput: (value) => opts.preview(id, { opacity: value }), onCommit: (value) => change({ opacity: value >= 1 ? undefined : value }) }));
    return groups;
  }

  function segmentedField(label, items, value, onCommit, disabled) {
    const control = segmented({ label, items: items.map((item) => ({ ...item, disabled })), value, onChange: onCommit });
    return el('div.bk-field', {}, el('span.field-label', { 'aria-hidden': 'true' }, label), control.element);
  }

  function pagePanel(state) {
    const { page } = state;
    const disabled = !opts.canEdit();
    return [
      el('div.bk-props-head', {}, el('h3', {}, t(`book.kind.${page.kind}`))),
      swatches(t('book.background'), page.bg ?? state.book.bg ?? 'surface', { disabled, onCommit: (value) => opts.pageChange({ bg: value }, t('book.history.background')) }),
      el('div.bk-rail-actions.bk-col', {},
        withIcon(button(t('book.chooseLayout'), { size: 'sm', variant: 'outline', onclick: () => opts.layouts() }), 'layouts'),
        withIcon(button(t('book.autoPage'), { size: 'sm', variant: 'outline', disabled, onclick: () => opts.auto() }), 'auto'),
        withIcon(button(t('book.exportDesign'), { size: 'sm', variant: 'ghost', onclick: () => opts.exportDesign() }), 'exportFile'),
        withIcon(button(t('book.importDesign'), { size: 'sm', variant: 'ghost', disabled, onclick: () => opts.importDesign() }), 'importFile')),
      el('p.bk-muted', {}, t(disabled ? 'book.props.viewOnly' : 'book.props.hint')),
    ];
  }

  function render({ force = false } = {}) {
    const state = opts.state();
    if (!state.page) { element.replaceChildren(); shown = null; return; }
    const item = state.selected && state.page.els?.[state.selected] ? { ...state.page.els[state.selected], id: state.selected } : null;
    const key = item ? `${state.page.id}:${item.id}` : `${state.page.id}:page`;
    // Typing keeps its field; the panel catches up when focus leaves it.
    if (!force && key === shown && element.contains(document.activeElement)) { stale = true; return; }
    if (textInput && key !== shown) commitText();
    textInput = null;
    shown = key;
    stale = false;
    element.replaceChildren(...(item ? elementPanel(item, state) : pagePanel(state)));
  }
  element.addEventListener('focusout', (event) => { if (stale && !element.contains(event.relatedTarget)) setTimeout(() => render({ force: true }), 0); });

  return {
    element,
    render,
    focusText() { textInput?.node?.focus(); textInput?.node?.select?.(); },
    flush: commitText,
    destroy() { commitText(); clearTimeout(textTimer); },
  };
}
