// A collection drawn over a trip map as hollow points (from the layers menu). The choice is kept per trip on this device.
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { spaceRoute } from '../../shared/protocol.js';
import { STATUS_TONES } from './model.js';
import { errorText, listCollections, peekMeta, withSpace } from './spaces.js';
import { pickSpace } from './transfer.js';

const KEY = 'trips:overlay:';
const LAYER = 'collection-overlay';
const read = (tripId) => { try { return JSON.parse(localStorage.getItem(KEY + tripId) ?? 'null'); } catch { return null; } };
const write = (tripId, value) => { try { if (value) localStorage.setItem(KEY + tripId, JSON.stringify(value)); else localStorage.removeItem(KEY + tripId); } catch { /* storage may be off */ } };

/** `createCollectionOverlay({context, tripMap, tripId})` → `{menuItems(), destroy()}`. */
export function createCollectionOverlay({ context, tripMap, tripId }) {
  let active = read(tripId);
  let items = new Map();
  let destroyed = false;
  const offClick = tripMap.onClick(LAYER, (feature) => {
    const item = items.get(String(feature.id));
    if (!item || !active) return;
    toast(t('collections.overlayPlace', { name: item.name, list: active.title || t('collections.untitled') }), { action: context.app ? { label: t('collections.open'), onClick: () => context.app.navigate(`${spaceRoute(active.ref)}/places`) } : undefined });
  });

  function clear() { items = new Map(); try { tripMap.removeLayer(LAYER); } catch { /* map gone */ } }
  async function draw({ quiet = false } = {}) {
    if (!active) { clear(); return; }
    try {
      const { value } = await withSpace(context, active.ref, (space) => space.select.saved.all().filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lng)));
      if (destroyed) return;
      items = new Map(value.map((item) => [item.id, item]));
      tripMap.setPois(LAYER, { type: 'FeatureCollection', features: value.map((item) => ({ type: 'Feature', id: item.id,
        properties: { id: item.id, tone: STATUS_TONES[item.status] ?? 'accent', title: item.name }, geometry: { type: 'Point', coordinates: [item.lng, item.lat] } })) }, { radius: 7 });
    } catch (error) {
      if (destroyed) return;
      // A collection the member left or lost: forget it instead of warning on every map open.
      if (quiet) { active = null; write(tripId, null); } else toast(errorText(error));
    }
  }
  async function choose() {
    let entries;
    try { entries = await listCollections(context); } catch (error) { toast(errorText(error)); return; }
    const info = await peekMeta(context, entries);
    const picked = await pickSpace({ title: t('collections.overlayTitle'), entries: entries.map((entry) => ({ ...entry, meta: info.get(entry.ref.s)?.meta ?? null })), emptyText: t('collections.emptyTitle') });
    if (!picked || destroyed) return;
    active = { ref: picked.ref, title: picked.title };
    write(tripId, active);
    await draw();
  }
  void draw({ quiet: true });
  return {
    menuItems: () => [
      { label: active ? t('collections.overlayOn', { name: active.title || t('collections.untitled') }) : t('collections.overlay'), checked: Boolean(active), onSelect: () => void choose() },
      ...(active ? [{ label: t('collections.overlayHide'), onSelect: () => { active = null; write(tripId, null); clear(); } }] : []),
    ],
    destroy() { destroyed = true; offClick(); },
  };
}
