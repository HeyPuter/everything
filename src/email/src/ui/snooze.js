import { el } from './dom.js';
import { openModal } from './modal.js';
import { snoozePresets, snoozeTime, localDateTime } from '../lib/snooze.js';

export function openSnooze(onSelect, until = null) {
  const body = el('div.snooze-picker');
  let modal;
  const choose = (at) => {
    if (!Number.isFinite(at) || at <= Date.now()) {
      error.textContent = 'Choose a future date and time.';
      return;
    }
    modal.close();
    onSelect(at);
  };
  const error = el('p.center-note', { role: 'alert' });
  const input = el('input', {
    type: 'datetime-local', 'aria-label': 'Wake date and time', required: true,
    value: localDateTime(until ?? snoozePresets()[0]?.until ?? Date.now() + 3600000),
    min: localDateTime(Date.now() + 60000),
  });
  const custom = el('form.snooze-custom', {
    hidden: true,
    onsubmit: (event) => { event.preventDefault(); choose(+new Date(input.value)); },
  }, el('label', {}, 'Date and time', input), error,
  el('button.btn.btn-primary', { type: 'submit' }, 'Snooze'));
  body.append(...snoozePresets().map((preset) => el('button.btn.snooze-preset', {
    type: 'button', onclick: () => choose(preset.until),
  }, el('span', {}, preset.label), el('span.center-note', {}, snoozeTime(preset.until)))),
  el('button.btn', {
    type: 'button', onclick: () => { custom.hidden = false; input.focus(); },
  }, 'Pick date & time'), custom);
  modal = openModal({ title: until ? 'Change snooze time' : 'Snooze until', content: body });
  return modal;
}
