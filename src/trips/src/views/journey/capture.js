// Quick capture on the go: a note, photos from the camera, the current position and the weather there, saved as
// a moment dated now.
import { el, uid } from '../../ui/dom.js';
import { button } from '../../ui/bits.js';
import { openSheet } from '../../ui/sheet.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { formatTemperature, formatTime } from '../../lib/format.js';
import { browserTimeZone, zonedParts } from '../../shared/dates.js';
import { orderBetween } from '../../shared/order.js';
import { ENTRY_LIMITS } from './constants.js';
import { icon } from './icons.js';
import { lastOrders } from './model.js';
import { currentWeather, devicePosition, placeName } from './location.js';
import { uploadMedia } from './media.js';
import { errorText } from './spaces.js';

export function openCapture({ space, context, onSaved }) {
  const services = context.session?.services ?? null;
  const now = zonedParts(Date.now(), browserTimeZone());
  const controller = new AbortController();
  let loc = null;
  let weather = null;
  let photos = [];
  const titleId = uid('jr-cap');
  const title = el('input.input', { id: titleId, maxLength: ENTRY_LIMITS.title, autocomplete: 'off', value: t('journey.captureTitle', { time: formatTime(now.time) }) });
  const noteId = uid('jr-cap-note');
  const note = el('textarea.textarea', { id: noteId, rows: 4, maxLength: 100_000, placeholder: t('journey.capturePlaceholder') });
  const where = el('p.jr-hint', { role: 'status' }, t('journey.locFinding'));
  const sky = el('p.jr-hint', { role: 'status' });
  const shots = el('ul.jr-capture-shots', { 'aria-label': t('journey.media') });
  const camera = button(t('journey.takePhoto'), { variant: 'outline', onclick: () => takePhoto() });
  camera.prepend(icon('camera', 16));
  camera.hidden = !space.can('files.upload');
  const save = button(t('journey.captureSave'), { variant: 'primary', onclick: () => void submit() });

  function takePhoto() {
    const input = el('input', { type: 'file', accept: 'image/*', capture: 'environment', multiple: true, hidden: true });
    input.addEventListener('change', () => {
      photos = [...photos, ...(input.files ?? [])];
      input.remove();
      shots.replaceChildren(...photos.map((file) => el('li.chip', {}, icon('camera', 14), file.name)));
    }, { once: true });
    input.addEventListener('cancel', () => input.remove(), { once: true });
    document.body.append(input);
    input.click();
  }
  async function locate() {
    try {
      const position = await devicePosition();
      if (controller.signal.aborted) return;
      loc = { ...position, ...(await placeName(services, position, { signal: controller.signal })) };
      where.replaceChildren(icon('map-pin', 14), loc.name ?? t('journey.locPinnedOnly'));
      sky.textContent = t('journey.weatherLoading');
      weather = await currentWeather(services, position, { signal: controller.signal });
      sky.textContent = weather ? t('journey.captureWeather', { weather: t(`journey.weather.${weather.weather}`), temp: Number.isFinite(weather.temperatureC) ? formatTemperature(weather.temperatureC) : '' }).trim() : t('journey.weatherUnavailable');
    } catch (error) {
      if (error?.name === 'AbortError') return;
      where.textContent = t(error?.code === 'denied' ? 'journey.locDenied' : error?.code === 'unsupported' ? 'journey.locUnsupported' : 'journey.locUnavailable');
      sky.textContent = '';
    }
  }
  async function submit() {
    const text = title.value.trim();
    if (!text) { title.focus(); return; }
    save.setAttribute('aria-busy', 'true');
    try {
      const orders = lastOrders(space.select.entry.all());
      const fields = { type: 'moment', date: now.date, time: now.time, title: text, order: orderBetween(orders.get(now.date) ?? null, null) };
      if (note.value.trim()) fields.story = note.value.trim();
      if (loc) fields.loc = loc;
      if (weather) fields.weather = weather.weather;
      const op = space.ops.create('entry', fields);
      await space.apply([op], { history: t('journey.historyAdd') });
      sheet.close('saved');
      onSaved?.(op.id);
      if (photos.length) {
        const { failed } = await uploadMedia(space, op.id, photos);
        if (failed.length) toast(t('journey.uploadFailed', { name: failed[0].name, reason: failed[0].message }));
      }
      space.flush?.();
    } catch (error) { toast(errorText(error)); } finally { save.setAttribute('aria-busy', 'false'); }
  }
  const sheet = openSheet({
    title: t('journey.captureTitleDialog'),
    content: el('div.jr-capture', {},
      el('div.field', {}, el('label.field-label', { htmlFor: titleId }, t('journey.fieldTitle')), title),
      el('div.field', {}, el('label.field-label', { htmlFor: noteId }, t('journey.fieldStory')), note),
      camera, shots, where, sky),
    actions: [button(t('journey.cancel'), { onclick: () => sheet.close('cancel') }), save],
    onClose: () => controller.abort(),
  });
  void locate();
  return sheet;
}
