import { el, uid } from '../../../ui/dom.js';
import { button } from '../../../ui/bits.js';
import { t } from '../../../lib/i18n/index.js';
import { prefs, setPrefs, displayLocale, TEXT_SIZE } from '../../../lib/prefs.js';
import { group, row, prefChoice, prefSwitch, keepInSync, statusLine } from '../ui.js';
import { accentControl, densityControl, tabOrderControl } from './appearance-extra.js';

const percent = (value) => new Intl.NumberFormat(displayLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(value);

function textSizeControl() {
  const id = uid('text-size');
  const output = el('output.pref-output', { htmlFor: id });
  const range = el('input.pref-range', { type: 'range', id, min: TEXT_SIZE.min, max: TEXT_SIZE.max, step: TEXT_SIZE.step });
  // Focus moves to the slider first: the button disables itself once the size is back to 100%.
  const reset = button(t('settings.textSizeReset'), { size: 'sm', variant: 'ghost', onclick: () => { range.focus(); show(1); setPrefs({ textSize: 1 }); } });
  function show(value) {
    range.value = String(value); output.textContent = percent(value);
    range.setAttribute('aria-valuetext', percent(value)); reset.disabled = value === 1;
  }
  range.addEventListener('input', () => { const value = Math.round(Number(range.value) * 10) / 10; show(value); setPrefs({ textSize: value }); });
  show(prefs().textSize);
  const parts = row({ label: t('settings.textSize'), hint: t('settings.textSizeHint'), labelFor: id, stacked: true,
    control: el('div.pref-range-row', {}, range, output, reset) });
  range.setAttribute('aria-describedby', parts.hintId);
  return { node: parts.node, update: (value) => { if (document.activeElement !== range) show(value.textSize); } };
}

export function render(container, { signal }) {
  const controls = [
    prefChoice('theme', t('settings.theme'), [
      { value: 'system', label: t('settings.themeSystem'), icon: 'monitor' },
      { value: 'light', label: t('settings.themeLight'), icon: 'sun' },
      { value: 'dark', label: t('settings.themeDark'), icon: 'moon' },
    ], { hint: t('settings.themeHint') }),
    textSizeControl(),
    prefSwitch('contrast', t('settings.contrast'), t('settings.contrastHint'), { on: 'more', off: 'normal' }),
    prefChoice('motion', t('settings.motion'), [
      { value: 'system', label: t('settings.motionSystem') },
      { value: 'reduce', label: t('settings.motionReduce') },
    ], { hint: t('settings.motionHint') }),
    densityControl(),
    accentControl(),
  ];
  const tabOrder = tabOrderControl();
  keepInSync([...controls, tabOrder], signal);
  signal?.addEventListener('abort', () => tabOrder.destroy(), { once: true });
  container.replaceChildren(el('div.settings-stack', {},
    group(null, ...controls.map((control) => control.node)),
    group(t('appearance.phoneTitle'), tabOrder.node),
    statusLine(signal)));
}
