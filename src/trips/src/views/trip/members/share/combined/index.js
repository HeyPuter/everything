// Public-link settings that reach past the trip (spec §9 and §22 [3]): include the road trip, attach a journey.
import { el, uid } from '../../../../../ui/dom.js';
import { button } from '../../../../../ui/bits.js';
import { t } from '../../../../../lib/i18n/index.js';
import { tokenKey } from '../logic.js';

const TOKEN = /^[0-9a-f]{32}$/;

/**
 * Journeys from `me:spaces` whose public link this device minted (only its hash is on the worker, so others cannot be
 * attached from here): `[{ref, title, token}]`.
 */
export async function journeyChoices({ personal, db }) {
  let spaces = [];
  try { spaces = (await personal?.spaces?.list()) ?? []; } catch { spaces = []; }
  const out = [];
  for (const entry of spaces) {
    if (entry?.ref?.k !== 'journey') continue;
    let record = null;
    try { record = await db?.get(tokenKey(entry.ref)); } catch { record = null; }
    if (TOKEN.test(record?.token ?? '')) out.push({ ref: entry.ref, title: entry.title ?? '', token: record.token });
  }
  return out;
}

/**
 * The extra toggles inside the share section's fieldset. `share` is the raw share settings with pending edits;
 * `change(patch)` queues a `share.set` field (`road`, or `journey: {w, s, token} | null`).
 */
export function combinedFields({ space, share, disabled, change, session }) {
  const box = el('div.share-combined');
  const roadOn = space.get('meta', 'meta')?.settings?.addons?.roadtrip === true;
  if (roadOn) {
    const hintId = uid('share-hint');
    const needs = share.plan !== true;
    box.append(el('label.check-field.share-toggle', {},
      el('input', { type: 'checkbox', checked: share.road === true && !needs, disabled: disabled || needs, 'aria-describedby': hintId, dataset: { focus: 'share:road' },
        onchange: (event) => change({ road: event.target.checked }) }),
      el('span.share-toggle-text', {}, el('span', {}, t('publicLink.road')), el('span.field-hint', { id: hintId }, t('publicLink.roadHint')))));
  }
  const id = uid('share-journey');
  const select = el('select.select', { id, disabled: true, dataset: { focus: 'share:journey' } }, el('option', { value: '' }, share.journey ? t('publicLink.journeyAttached') : t('publicLink.journeyNone')));
  const hint = el('span.field-hint', {}, t('publicLink.journeyHint'));
  const remove = share.journey ? button(t('publicLink.journeyRemove'), { size: 'sm', variant: 'ghost', disabled, dataset: { focus: 'share:journeyOff' }, onclick: () => change({ journey: null }) }) : null;
  box.append(el('div.field.share-journey', {}, el('label.field-label', { htmlFor: id }, t('publicLink.journeyPick')), select, hint, remove));
  void journeyChoices({ personal: session?.personal, db: session?.db }).then((choices) => {
    if (!select.isConnected && !box.isConnected) return;
    select.append(...choices.map((choice, index) => el('option', { value: String(index) }, choice.title || t('publicLink.journeyUntitled'))));
    select.disabled = disabled || !choices.length;
    hint.textContent = choices.length ? `${t('publicLink.journeyHint')} ${t('publicLink.journeyOnlyHere')}` : t('publicLink.journeyEmpty');
    select.addEventListener('change', () => {
      const choice = choices[Number(select.value)];
      if (choice) change({ journey: { w: choice.ref.w, s: choice.ref.s, token: choice.token } });
    });
  });
  return box;
}
