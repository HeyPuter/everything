import { el, uid } from '../../../ui/dom.js';
import { button, iconButton } from '../../../ui/bits.js';
import { t } from '../../../lib/i18n/index.js';
import { icon } from './icons.js';

/** 1–5 stars as a radio group: arrows move, choosing the current value again clears it. */
export function starRating({ value = 0, label, onChange, disabled = false }) {
  const stars = [];
  const clear = button(t('places.ratingClear'), { size: 'sm', variant: 'ghost', hidden: !value, disabled, onclick: () => choose(0) });
  const group = el('div.pl-stars', { role: 'radiogroup', 'aria-label': label });
  function render() {
    stars.forEach((star, index) => {
      const checked = index + 1 === value;
      star.setAttribute('aria-checked', String(checked));
      star.classList.toggle('on', index < value);
      star.tabIndex = checked || (!value && index === 0) ? 0 : -1;
    });
    clear.hidden = !value;
  }
  // A click on the current value clears it; keys only move.
  function choose(next, focus = false) {
    if (next === value && !focus) next = 0;
    if (next === value) return;
    value = next;
    render();
    if (focus) stars[Math.max(0, value - 1)].focus();
    onChange?.(value);
  }
  for (let n = 1; n <= 5; n++) {
    const star = el('button.pl-star', { type: 'button', role: 'radio', disabled, 'aria-label': t('places.ratingStars', { count: n }), title: t('places.ratingStars', { count: n }),
      onclick: () => choose(n) }, icon('star', 20, { fill: true }));
    star.addEventListener('keydown', (event) => {
      const rtl = getComputedStyle(group).direction === 'rtl';
      const step = { ArrowRight: rtl ? -1 : 1, ArrowUp: 1, ArrowLeft: rtl ? 1 : -1, ArrowDown: -1 }[event.key];
      if (step) { event.preventDefault(); choose(Math.min(5, Math.max(1, (value || n) + (value ? step : 0))), true); }
      else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); choose(event.key === 'Home' ? 1 : 5, true); }
    });
    stars.push(star); group.append(star);
  }
  render();
  return { element: el('div.pl-rating-control', {}, group, clear), setValue(next) { value = next; render(); } };
}

/** The caller's own tags as removable chips plus an input with suggestions. */
export function tagEditor({ tags = [], suggestions = [], label, onChange, disabled = false }) {
  let current = [...tags];
  const inputId = uid('pl-tag');
  const listId = uid('pl-tags');
  const chips = el('ul.pl-tag-chips', { 'aria-label': label });
  const datalist = el('datalist', { id: listId });
  const input = el('input.input', { id: inputId, list: listId, maxLength: 100, autocomplete: 'off', disabled, placeholder: t('places.tagPlaceholder') });
  function render() {
    chips.replaceChildren(...current.map((tag) => el('li.chip.pl-tag', {}, icon('tag', 14), el('span', {}, tag),
      iconButton('close', t('places.tagRemove', { name: tag }), { disabled, onclick: () => update(current.filter((entry) => entry !== tag)) }))));
    chips.hidden = !current.length;
    const have = new Set(current.map((tag) => tag.toLocaleLowerCase()));
    datalist.replaceChildren(...suggestions.filter((tag) => !have.has(tag.toLocaleLowerCase())).slice(0, 50).map((tag) => el('option', { value: tag })));
  }
  function update(next) { current = next; render(); onChange?.(current); }
  function add() {
    const names = input.value.split(',').map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (!names.length) return;
    const have = new Set(current.map((tag) => tag.toLocaleLowerCase()));
    const fresh = names.filter((name) => !have.has(name.toLocaleLowerCase()) && have.add(name.toLocaleLowerCase()));
    input.value = '';
    if (fresh.length) update([...current, ...fresh]);
  }
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); add(); } });
  render();
  return {
    element: el('div.pl-tags', {}, chips, el('div.pl-tag-add', {}, el('label.sr-only', { htmlFor: inputId }, t('places.tagAdd')), input, datalist,
      button(t('places.tagAddShort'), { size: 'sm', variant: 'outline', disabled, onclick: add }))),
    setTags(next) { current = [...next]; render(); },
    setSuggestions(next) { suggestions = next; render(); },
  };
}
