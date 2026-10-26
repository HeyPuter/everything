import { el, uid, safeURL, append, clear } from '../../../ui/dom.js';
import { button } from '../../../ui/bits.js';
import { field } from '../../../ui/fields.js';
import { openModal } from '../../../ui/modal.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { displayLocale } from '../../../lib/prefs.js';
import { isCurrency, toMinor, fromMinor } from '../../../shared/money.js';
import { dedupeResults } from '../../../services/geocode.js';
import { BUILTIN_CATEGORIES, adoptPersonalCategory, categoryOf, guessCategory, isBuiltin, tripCategories } from '../../../lib/categories.js';
import { openCategoryEditor } from './catmanager.js';
import { followShortLink, parseLocation } from './parse.js';
import { placeFields, placePatch } from './actions.js';
import { coordText } from './filter.js';
import { icon } from './icons.js';
import { IMAGE_ACCEPT, chooseLocalFiles, coverUrl, errorKey, fileLinkOp, fileType, uploadImage } from '../../../lib/files/index.js';

const NEW_CATEGORY = '__new';
// Saving waits this long for a boundary lookup that started when the coordinates were entered.
const LOCATE_WAIT = 1500;
const language = () => { try { return displayLocale(); } catch { return 'en'; } };
const isAbort = (error) => error?.name === 'AbortError';
const spot = (lat, lng) => (Number.isFinite(lat) && Number.isFinite(lng) ? `${Math.round(lat * 1e6)},${Math.round(lng * 1e6)}` : null);

/** Country and ISO region from the bundled boundaries (offline once cached), or null. */
async function regionAt(lat, lng) {
  try { return await (await import('../../../lib/atlas/boundaries.js')).locatePlace(lat, lng); } catch { return null; }
}
async function within(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); })]); } finally { clearTimeout(timer); }
}

function osmId(osm) {
  if (typeof osm === 'string') return osm.slice(0, 64);
  return osm?.type && osm?.id ? `${osm.type}/${osm.id}` : undefined;
}
function idsOf(result) {
  const ids = { ...(osmId(result.osm) ? { osm: osmId(result.osm) } : {}), ...(result.wikidata ? { wikidata: result.wikidata } : {}), ...(result.source === 'photon' && result.id ? { photon: String(result.id).slice(0, 120) } : {}) };
  return Object.keys(ids).length ? ids : undefined;
}

/**
 * The place photo as a trip file (collection file for saved places): pick one to upload on save, keep the current
 * one, or remove it. A web image link in the form takes precedence.
 */
function imagePicker(space, place) {
  const current = place?.img?.fileId ?? null;
  let kept = Boolean(current);
  let file = null;
  let objectUrl = null;
  let running = null;
  const canUpload = space.can('files.upload') && space.can('files.edit');
  const preview = el('img.pl-image-preview', { alt: '', hidden: true });
  const status = el('p.field-hint', { role: 'status', 'aria-live': 'polite' });
  const show = (src) => { preview.src = src; preview.hidden = !src; };
  const pick = button(t(current ? 'places.imageReplace' : 'places.imageUpload'), { size: 'sm', variant: 'outline', onclick: async () => {
    const [chosen] = await chooseLocalFiles({ accept: IMAGE_ACCEPT, multiple: false });
    if (!chosen) return;
    if (fileType(chosen.name)?.group !== 'image') { status.textContent = t('files.error.image_type'); return; }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    file = chosen; kept = false;
    objectUrl = URL.createObjectURL(chosen);
    show(objectUrl);
    status.textContent = t('places.imagePicked', { name: chosen.name });
    remove.hidden = false;
  } });
  const remove = button(t('places.imageRemove'), { size: 'sm', variant: 'ghost', onclick: () => {
    file = null; kept = false; show(''); remove.hidden = true;
    status.textContent = current ? t('places.imageRemoved') : '';
    pick.focus();
  } });
  remove.hidden = !current;
  pick.hidden = !canUpload;
  if (current) {
    coverUrl(space, current, { thumb: true }).then((src) => { if (src && kept) show(src); }).catch(() => {});
  }
  const element = (current || canUpload) ? el('div.field.pl-image-field', {}, el('span.field-label', {}, t('places.fieldPhoto')), preview, el('div.pl-image-actions', {}, pick, remove), status) : null;
  return {
    element,
    file: () => file,
    kept: () => (kept && current ? place.img : undefined),
    async upload() {
      running ??= uploadImage(space, file, { onProgress: (state) => {
        status.textContent = state.status === 'uploading' && state.total ? t('places.imageUploadingPercent', { percent: Math.round((state.loaded / state.total) * 100) }) : t('places.imageUploading');
      } }).then(({ id }) => id).finally(() => { running = null; });
      return running;
    },
    /** Links the new photo file to the place and unlinks a replaced one. */
    linkOps(type, id, img) {
      const next = img?.fileId ?? null;
      const ops = [];
      if (next && next !== current) ops.push(fileLinkOp(space, next, { add: [{ t: type, id }] }));
      if (current && current !== next && space.get('file', current)) ops.push(fileLinkOp(space, current, { remove: [{ t: type, id }] }));
      return ops.filter(Boolean);
    },
    destroy() { if (objectUrl) URL.revokeObjectURL(objectUrl); },
  };
}

/** Search box with a listbox of geocoder results, pasted coordinates and map links. */
function searchBox({ geocode, bias, puter, onChoose, status }) {
  const inputId = uid('pl-search');
  const listId = `${inputId}-list`;
  const input = el('input.input', { id: inputId, type: 'search', role: 'combobox', autocomplete: 'off', spellcheck: false,
    'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listId, placeholder: t('places.formSearchPlaceholder') });
  const list = el('ul.pl-suggest', { id: listId, role: 'listbox', 'aria-label': t('places.formSearchResults'), hidden: true });
  const credit = el('p.pl-credit', { hidden: true });
  let options = [];
  let active = -1;
  let controller = null;
  let sequence = 0;

  function show(next) {
    options = next; active = -1;
    list.replaceChildren(...options.map((option, index) => el('li.pl-option', { id: `${listId}-${index}`, role: 'option', 'aria-selected': 'false',
      onmousedown: (event) => event.preventDefault(), onclick: () => choose(index) },
    icon(option.icon ?? 'pin', 16), el('span.pl-option-text', {}, el('span', {}, option.label), option.detail && el('span.pl-muted', {}, option.detail)),
    option.source && el('span.pl-source', {}, option.source))));
    list.hidden = !options.length;
    input.setAttribute('aria-expanded', String(!list.hidden));
    input.removeAttribute('aria-activedescendant');
  }
  function highlight(index) {
    active = index;
    [...list.children].forEach((node, i) => node.setAttribute('aria-selected', String(i === index)));
    if (index >= 0) { input.setAttribute('aria-activedescendant', `${listId}-${index}`); list.children[index]?.scrollIntoView?.({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  }
  function close() { show([]); credit.hidden = true; }
  async function search(query, full) {
    controller?.abort(); controller = new AbortController();
    const run = ++sequence;
    status(t('places.searching'));
    try {
      const options = { lang: language(), signal: controller.signal, ...(bias ? { bias } : {}) };
      const result = full ? await geocode.search(query, options) : await geocode.autocomplete(query, options);
      if (run !== sequence) return;
      if (!result) { close(); status(t(navigator.onLine === false ? 'places.searchOffline' : 'places.searchNone')); return; }
      const found = dedupeResults(result.data ?? []).slice(0, 8);
      show(found.map((entry) => ({ kind: 'result', value: entry, label: entry.name || entry.address, detail: entry.name ? entry.address : '', source: entry.source })));
      credit.textContent = (result.attribution ?? []).filter((item) => typeof item === 'string').join(' · ');
      credit.hidden = !credit.textContent || !found.length;
      status(found.length ? t('places.searchCount', { count: found.length }) : t('places.searchNone'));
    } catch (error) {
      if (isAbort(error) || run !== sequence) return;
      close(); status(t('places.searchFailed'));
    }
  }
  async function follow(url) {
    if (typeof puter?.net?.fetch !== 'function') { status(t('places.linkNoFetch')); return; }
    status(t('places.linkReading'));
    try {
      const found = await followShortLink(url, (target, init) => puter.net.fetch(target, init));
      if (found?.lat !== undefined) { close(); status(''); onChoose({ kind: 'coords', value: found }); }
      else if (found?.query) { input.value = found.query; void search(found.query, true); }
      else status(t('places.linkUnreadable'));
    } catch { status(t('places.linkFailed')); }
  }
  function choose(index) {
    const option = options[index];
    if (!option) return;
    if (option.kind === 'short') { void follow(option.value); return; }
    close(); status('');
    onChoose(option);
  }
  function changed() {
    const text = input.value.trim();
    const parsed = parseLocation(text);
    controller?.abort(); sequence++;
    if (parsed?.lat !== undefined) {
      show([{ kind: 'coords', value: parsed, icon: 'locate', label: parsed.name || t('places.useCoordinates'), detail: coordText(parsed) }]);
      status('');
    } else if (parsed?.short) {
      show([{ kind: 'short', value: parsed.short, icon: 'paste', label: t('places.readLink') }]);
      status('');
    } else if (parsed?.query) void search(parsed.query, true);
    else if (text.length >= 3) void search(text, false);
    else { close(); status(''); }
  }
  input.addEventListener('input', changed);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!options.length) return;
      event.preventDefault();
      highlight(event.key === 'ArrowDown' ? (active + 1) % options.length : (active - 1 + options.length) % options.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (active >= 0) choose(active);
      else if (input.value.trim() && !parseLocation(input.value.trim())) void search(input.value.trim(), true);
      else if (options.length === 1) choose(0);
    } else if (event.key === 'Escape' && !list.hidden) {
      event.preventDefault(); event.stopPropagation(); close();
    }
  });
  input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) { list.hidden = true; input.setAttribute('aria-expanded', 'false'); } }, 150));
  input.addEventListener('focus', () => { if (options.length) { list.hidden = false; input.setAttribute('aria-expanded', 'true'); } });
  return { input, list, credit, set(value) { input.value = value; changed(); }, abort() { controller?.abort(); sequence++; } };
}

/**
 * Create or edit a place. `prefill` is `{lat, lng, name?, address?, osm?, wikidata?, cat?}` (map pick or pasted link), `query` starts a
 * search. Resolves the saved place id, or null when cancelled. Collections pass `type: 'saved'` and `extra: {element, values(before)}`
 * for their own fields (`undefined` values are unset on edit); other types offer built-in categories only.
 */
export function openPlaceForm({ space, services, puter, catalog, place = null, prefill = null, query = '', bias = null, src = 'manual', track, type = 'place', extra = null }) {
  return new Promise((resolve) => {
    const editing = Boolean(place);
    const geocode = services?.geocode ?? null;
    const meta = space.get('meta', 'meta');
    const state = {
      cc: place?.cc, admin1: place?.admin1, tz: place?.tz, ids: place?.ids ? structuredClone(place.ids) : undefined, src: place ? place.src : src,
      autoName: !editing, autoAddress: !editing, catTouched: editing && Boolean(place.cat),
      // The coordinates `cc` was found for; a country from elsewhere is replaced at save.
      ccFor: place?.cc ? spot(place.lat, place.lng) : null,
    };
    let savedId = null;
    let personal = [];
    const statusLine = el('p.pl-search-status', { role: 'status', 'aria-live': 'polite' });
    const setStatus = (text) => { statusLine.textContent = text; };

    const name = field({ label: t('places.fieldName'), value: place?.name ?? '', maxLength: 500, required: true, autocomplete: 'off' });
    const address = field({ label: t('places.fieldAddress'), value: place?.address ?? '', maxLength: 2000, autocomplete: 'off' });
    const lat = field({ label: t('places.fieldLat'), value: place?.lat ?? '', inputMode: 'decimal', autocomplete: 'off' });
    const lng = field({ label: t('places.fieldLng'), value: place?.lng ?? '', inputMode: 'decimal', autocomplete: 'off' });
    const desc = field({ label: t('places.fieldDesc'), type: 'textarea', value: place?.desc ?? '', hint: t('places.markdownHint'), rows: 3 });
    const notes = field({ label: t('places.fieldNotes'), type: 'textarea', value: place?.notes ?? '', hint: t('places.markdownHint'), rows: 3 });
    const web = field({ label: t('places.fieldWeb'), type: 'url', value: place?.web ?? '', inputMode: 'url', autocomplete: 'off', maxLength: 2048 });
    const phone = field({ label: t('places.fieldPhone'), type: 'tel', value: place?.phone ?? '', maxLength: 100, autocomplete: 'off' });
    const priceCurrency = place?.price?.currency ?? meta?.currency ?? 'EUR';
    let priceText = '';
    try { priceText = place?.price ? fromMinor(place.price.amount, place.price.currency) : ''; } catch { /* unknown currency: leave it blank */ }
    const price = field({ label: t('places.fieldPrice'), value: priceText, inputMode: 'decimal', autocomplete: 'off' });
    const currency = field({ label: t('places.fieldCurrency'), value: priceCurrency, maxLength: 3, autocomplete: 'off', spellcheck: false });
    const imageUrl = field({ label: t('places.fieldImage'), type: 'url', value: place?.img?.url ?? '', inputMode: 'url', autocomplete: 'off', hint: t('places.fieldImageHint') });
    const imageCredit = field({ label: t('places.fieldImageCredit'), value: place?.img?.credit ?? '', maxLength: 500, autocomplete: 'off' });
    const image = imagePicker(space, place);
    const catId = uid('pl-cat');
    const cat = el('select.select', { id: catId });
    const catField = el('div.field', {}, el('label.field-label', { htmlFor: catId }, t('places.fieldCategory')), cat);
    let catValue = place?.cat ?? '';

    function fillCategories() {
      const trip = tripCategories(space);
      const tripNames = new Set(trip.map((entry) => entry.name.trim().toLocaleLowerCase()));
      const mine = personal.filter((entry) => !tripNames.has(entry.name.trim().toLocaleLowerCase()));
      const missing = catValue && !isBuiltin(catValue) && !catValue.startsWith('me:') && (type !== 'place' || !space.get('cat', catValue));
      append(clear(cat), [
        el('option', { value: '' }, t('places.catNone')),
        el('optgroup', { label: t('places.catBuiltin') }, BUILTIN_CATEGORIES.map((entry) => el('option', { value: entry.id }, categoryOf(space, entry.id).name))),
        trip.length > 0 && el('optgroup', { label: t('places.catTrip') }, trip.map((entry) => el('option', { value: entry.id }, entry.name))),
        type === 'place' && mine.length > 0 && el('optgroup', { label: t('places.catMine') }, mine.map((entry) => el('option', { value: `me:${entry.id}` }, entry.name))),
        missing && el('option', { value: catValue }, t('places.catMissing')),
        type === 'place' && space.can('plan.edit') && el('option', { value: NEW_CATEGORY }, t('places.catNewOption')),
      ]);
      cat.value = catValue;
    }
    cat.addEventListener('change', async () => {
      if (cat.value !== NEW_CATEGORY) { catValue = cat.value; state.catTouched = true; return; }
      cat.value = catValue;
      const created = await openCategoryEditor({ space, track });
      if (created) { catValue = created; state.catTouched = true; }
      fillCategories();
      cat.focus();
    });

    // One boundary lookup per coordinate pair, started as soon as it is entered so saving rarely waits.
    let region = null;
    function regionSoon(latValue, lngValue) {
      const key = spot(latValue, lngValue);
      if (!key) return null;
      if (region?.key !== key) region = { key, promise: regionAt(latValue, lngValue) };
      return region.promise;
    }
    function applyLocation(value, { source, nameHint } = {}) {
      lat.input.value = String(value.lat); lng.input.value = String(value.lng);
      lat.setError(''); lng.setError('');
      void regionSoon(Number(lat.input.value), Number(lng.input.value));
      if (source) state.src = source;
      const label = nameHint ?? value.name;
      if (label && (state.autoName || !name.input.value.trim())) { name.input.value = label; state.autoName = true; name.setError(''); }
      if (value.address && (state.autoAddress || !address.input.value.trim())) { address.input.value = value.address; state.autoAddress = true; }
    }
    function applyResult(result) {
      state.keepName = false; state.keepAddress = false;
      applyLocation(result, { source: result.source ?? 'search' });
      state.cc = /^[A-Z]{2}$/.test(result.country ?? '') ? result.country : undefined;
      state.ccFor = spot(Number(lat.input.value), Number(lng.input.value));
      state.ids = idsOf(result);
      const guess = guessCategory(result.kind);
      if (guess && !state.catTouched) { catValue = guess; fillCategories(); }
    }
    // Fills the name, address and country from a reverse lookup, keeping anything the user typed.
    async function lookup(value) {
      if (!geocode) return;
      setStatus(t('places.lookingUp'));
      try {
        const result = await geocode.reverse(value.lat, value.lng, { lang: language() });
        const found = result?.data?.[0];
        if (!found) { setStatus(result ? '' : t('places.lookupOffline')); return; }
        if (Number(lat.input.value) !== value.lat || Number(lng.input.value) !== value.lng) return;
        state.cc = /^[A-Z]{2}$/.test(found.country ?? '') ? found.country : undefined;
        state.ccFor = spot(value.lat, value.lng);
        if (!state.ids) state.ids = idsOf(found);
        if (found.name && !state.keepName && (state.autoName || !name.input.value.trim())) { name.input.value = found.name; state.autoName = true; }
        if (found.address && !state.keepAddress && (state.autoAddress || !address.input.value.trim())) { address.input.value = found.address; state.autoAddress = true; }
        setStatus('');
      } catch { setStatus(t('places.lookupFailed')); }
    }

    const search = geocode ? searchBox({ geocode, bias, puter, status: setStatus, onChoose: (option) => {
      if (option.kind === 'result') applyResult(option.value);
      else { applyLocation(option.value, { source: 'link' }); state.cc = undefined; state.ids = undefined; void lookup(option.value); }
      name.input.focus();
    } }) : null;

    name.input.addEventListener('input', () => { state.autoName = false; name.setError(''); });
    address.input.addEventListener('input', () => { state.autoAddress = false; });
    for (const input of [lat.input, lng.input]) {
      input.addEventListener('input', () => { state.cc = undefined; state.ids = undefined; lat.setError(''); lng.setError(''); });
      // Pasting "lat, lng" or a map link into either box fills both.
      input.addEventListener('paste', (event) => {
        const text = event.clipboardData?.getData('text') ?? '';
        const parsed = parseLocation(text);
        if (parsed?.lat === undefined) return;
        event.preventDefault();
        applyLocation(parsed, { source: 'link' });
        void lookup(parsed);
      });
      input.addEventListener('change', () => {
        const value = { lat: number(lat.input, -90, 90), lng: number(lng.input, -180, 180) };
        if (Number.isFinite(value.lat) && Number.isFinite(value.lng)) void regionSoon(value.lat, value.lng);
        if (Number.isFinite(value.lat) && Number.isFinite(value.lng) && !state.cc) void lookup(value);
      });
    }

    const error = el('p.pl-alert', { role: 'alert', hidden: true });
    const showError = (message) => { error.textContent = message; error.hidden = !message; };
    function number(input, min, max) {
      const text = input.value.trim().replace(',', '.');
      if (!text) return undefined;
      const value = Number(text);
      return Number.isFinite(value) && value >= min && value <= max ? Math.round(value * 1e6) / 1e6 : NaN;
    }
    function webValue(input) {
      const text = input.value.trim();
      if (!text) return undefined;
      return safeURL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`) ?? NaN;
    }

    function collect() {
      let invalid = null;
      const flag = (control, message) => { control.setError(message); invalid ??= control.input; };
      for (const control of [name, lat, lng, web, price, currency, imageUrl]) control.setError('');
      const values = { name: name.input.value.replace(/\s+/g, ' ').trim() };
      if (!values.name) flag(name, t('places.nameRequired'));
      const latValue = number(lat.input, -90, 90);
      const lngValue = number(lng.input, -180, 180);
      if (Number.isNaN(latValue)) flag(lat, t('places.latInvalid'));
      if (Number.isNaN(lngValue)) flag(lng, t('places.lngInvalid'));
      if ((latValue === undefined) !== (lngValue === undefined) && !Number.isNaN(latValue) && !Number.isNaN(lngValue)) flag(latValue === undefined ? lat : lng, t('places.locationPair'));
      const webUrl = webValue(web.input);
      if (Number.isNaN(webUrl)) flag(web, t('places.urlInvalid'));
      const imageLink = webValue(imageUrl.input);
      if (Number.isNaN(imageLink)) flag(imageUrl, t('places.urlInvalid'));
      const code = currency.input.value.trim().toUpperCase();
      let priceValue;
      if (price.input.value.trim()) {
        if (!isCurrency(code)) flag(currency, t('places.currencyInvalid'));
        else {
          try {
            const amount = toMinor(price.input.value.trim().replace(',', '.'), code);
            if (amount < 0) flag(price, t('places.priceInvalid')); else priceValue = { amount, currency: code };
          } catch { flag(price, t('places.priceInvalid')); }
        }
      }
      if (invalid) { invalid.focus(); return null; }
      const located = latValue !== undefined && lngValue !== undefined;
      Object.assign(values, {
        desc: desc.input.value.trim() || undefined, notes: notes.input.value.trim() || undefined,
        address: address.input.value.trim() || undefined,
        lat: located ? latValue : undefined, lng: located ? lngValue : undefined,
        cc: located ? state.cc : undefined, admin1: located ? state.admin1 : undefined, tz: located ? state.tz : undefined,
        price: priceValue, web: webUrl, phone: phone.input.value.trim() || undefined,
        img: imageLink ? { url: imageLink, ...(imageCredit.input.value.trim() ? { credit: imageCredit.input.value.trim() } : {}), ...(place?.img?.url === imageLink && place.img.license ? { license: place.img.license } : {}) }
          : image.kept(),
        ids: state.ids, src: state.src,
      });
      if (type !== 'place') delete values.src;
      return values;
    }

    const save = button(t(editing ? 'places.save' : 'places.add'), { type: 'submit', variant: 'primary' });
    const form = el('form.pl-form', { noValidate: true, onsubmit: async (event) => {
      event.preventDefault();
      showError('');
      const values = collect();
      if (!values) return;
      save.setAttribute('aria-busy', 'true');
      try {
        const ops = [];
        if (catValue.startsWith('me:')) {
          const entry = personal.find((item) => `me:${item.id}` === catValue);
          if (entry) { const adopted = adoptPersonalCategory(space, entry); ops.push(...adopted.ops); values.cat = adopted.id; }
        } else values.cat = catValue || undefined;
        // A picked photo goes up first, so the place is saved with it or not at all.
        if (!values.img && image.file()) {
          try { values.img = { fileId: await image.upload() }; } catch (failure) { showError(t(errorKey(failure))); return; }
        }
        if (values.lat !== undefined) {
          const here = spot(values.lat, values.lng);
          const changed = here !== spot(place?.lat, place?.lng);
          if (state.ccFor !== here) values.cc = undefined;
          if (changed || !values.cc || !values.admin1) {
            const found = await within(regionSoon(values.lat, values.lng), LOCATE_WAIT);
            if (found?.cc) { values.cc ??= found.cc; values.admin1 = found.admin1 ?? undefined; }
            else if (changed) values.admin1 = undefined;
          }
        }
        const moved = values.lat !== undefined && (values.lat !== place?.lat || values.lng !== place?.lng || !values.tz);
        if (moved && services?.tz) {
          try { values.tz = await services.tz.zoneAt(values.lat, values.lng); } catch { values.tz = undefined; }
        }
        if (editing) {
          const before = space.get(type, place.id);
          if (!before) { showError(t('places.goneWhileEditing')); return; }
          const { set, unset } = placePatch(before, values);
          for (const [key, value] of Object.entries(extra?.values(before) ?? {})) {
            if (value === undefined) { if (before[key] !== undefined) unset.push(key); } else if (JSON.stringify(value) !== JSON.stringify(before[key])) set[key] = value;
          }
          if (Object.keys(set).length || unset.length) ops.push(space.ops.patch(type, place.id, { set, unset }));
          ops.push(...image.linkOps(type, place.id, values.img));
          if (ops.length) await space.apply(ops, { history: t('places.historyEdit') });
          savedId = place.id;
          toast(t('places.saved', { name: values.name }));
        } else {
          const more = Object.fromEntries(Object.entries(extra?.values(null) ?? {}).filter(([, value]) => value !== undefined));
          const op = space.ops.create(type, { ...placeFields(values), ...more });
          await space.apply([...ops, op, ...image.linkOps(type, op.id, values.img)], { history: t('places.historyAdd') });
          savedId = op.id;
          toast(t('places.added', { name: values.name }));
        }
        dialog.close('saved');
      } catch (failure) {
        showError(failure?.code === 'gone' ? t('places.goneWhileEditing') : failure?.code === 'entity_too_large' ? t('places.tooLarge') : t('places.saveFailed'));
      } finally { save.removeAttribute('aria-busy'); }
    } },
    error,
    search && el('div.field.pl-search-field', {}, el('label.field-label', { htmlFor: search.input.id }, t(editing ? 'places.formSearchEdit' : 'places.formSearch')),
      el('div.input-prefix', {}, icon('search'), search.input), search.list, search.credit, statusLine),
    !search && statusLine,
    name.element, catField, extra?.element, address.element,
    el('div.field-row', {}, lat.element, lng.element),
    el('p.field-hint.pl-hint', {}, t('places.locationHint')),
    desc.element, notes.element,
    el('details.pl-more', { open: Boolean(place?.web || place?.phone || place?.price || place?.img) },
      el('summary', {}, t('places.moreDetails')),
      web.element, phone.element, el('div.field-row', {}, price.element, currency.element), image.element, imageUrl.element, imageCredit.element),
    el('div.modal-actions', {}, button(t('places.cancel'), { onclick: () => dialog.close('cancel') }), save));

    fillCategories();
    if (catalog) {
      catalog.categories().then((list) => { personal = list; fillCategories(); }).catch(() => {});
    }
    const dialog = openModal({ title: t(editing ? 'places.editTitle' : 'places.newTitle'), content: form, wide: true,
      initialFocus: window.innerWidth >= 640 ? search?.input ?? name.input : undefined, onClose: () => { search?.abort(); image.destroy(); resolve(savedId); } });
    track?.(dialog);
    if (place && (!place.cc || !place.admin1)) void regionSoon(place.lat, place.lng);
    if (prefill && Number.isFinite(prefill.lat) && Number.isFinite(prefill.lng)) {
      applyLocation(prefill, { source: src, nameHint: prefill.name });
      // A name or address that came with the link or map pick stays; the reverse lookup fills only what is missing.
      state.keepName = Boolean(prefill.name); state.keepAddress = Boolean(prefill.address);
      if (prefill.osm || prefill.wikidata) state.ids = idsOf({ osm: prefill.osm, wikidata: prefill.wikidata });
      if (prefill.cat && (isBuiltin(prefill.cat) || space.get('cat', prefill.cat))) { catValue = prefill.cat; fillCategories(); }
      if (!prefill.name || !prefill.address) void lookup(prefill);
    } else if (prefill?.name) name.input.value = prefill.name;
    if (query && search) search.set(query);
  });
}

