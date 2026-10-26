import { t } from '../../../lib/i18n/index.js';
import { prefersReducedMotion } from '../../../lib/prefs.js';
import { toast } from '../../../ui/toast.js';
import { pointAt, project, slice } from '../../../lib/road/index.js';
import { collection, dayTone } from '../map/features.js';
import { roadState } from './state.js';
import { createRoadOps } from './ops.js';

const LAYERS = Object.freeze({
  'road-legs': ['setRoutes'], 'road-selected': ['setRoutes', { width: 6 }], 'road-bands': ['setArcs', { width: 7 }], 'road-areas': ['setAreas'],
  'road-breaks': ['setPois', { radius: 5 }], 'road-pois': ['setPois', { radius: 6 }], 'road-hazards': ['setMarkers', { cluster: false, radius: 9 }],
  'road-nights': ['setMarkers', { cluster: false, radius: 10 }], 'road-focus': ['setMarkers', { cluster: false, radius: 8 }],
});
const KEYS = Object.keys(LAYERS);
const LEVEL_TONE = { red: 'danger', orange: 'warn', green: 'success' };
const storageKey = (spaceId) => `trips:road:map:${spaceId}`;
const point = (coordinates, properties) => ({ type: 'Feature', properties, geometry: { type: 'Point', coordinates } });
const line = (coordinates, properties) => ({ type: 'Feature', properties, geometry: { type: 'LineString', coordinates } });
const drawable = (coordinates) => Array.isArray(coordinates) && coordinates.length >= 2 && coordinates.some((item) => item[0] !== coordinates[0][0] || item[1] !== coordinates[0][1]);

/**
 * Road-trip layers on the planner map: the drive legs (replacing the day routes while shown), night pauses (drag one
 * along its leg to move the night), breaks, range bands, hazards and search results. `tripMap` is the map wrapper.
 */
export function createRoadOverlay({ context, tripMap }) {
  const { space, session } = context;
  const state = roadState(space, session);
  const ops = createRoadOps(space);
  const release = state.retain();
  const spaceId = space.ref?.s ?? 'trip';
  let always = false;
  try { always = localStorage.getItem(storageKey(spaceId)) === 'on'; } catch { /* Off by default. */ }
  const drawn = new Map();
  let hidRoutes = false; let frame = 0; let destroyed = false; let dragging = null; let lastSelected = null;
  const map = tripMap.map;

  const visible = () => state.enabled() && (state.active || always);
  function draw(key, features) {
    const [method, options] = LAYERS[key];
    const data = collection(features);
    const signature = JSON.stringify(data);
    if (drawn.get(key) === signature) return;
    drawn.set(key, signature);
    try { tripMap[method](key, data, options); } catch { drawn.delete(key); }
  }
  function setDayRoutes(show) {
    if (show === !hidRoutes) return;
    try { tripMap.setVisible('day-routes', show); hidRoutes = !show; } catch { /* Not drawn yet; tried again on the next render. */ }
  }

  function render() {
    frame = 0;
    if (destroyed) return;
    if (!visible()) {
      for (const key of KEYS) draw(key, []);
      setDayRoutes(true);
      return;
    }
    const view = state.view();
    const selected = state.selected;
    const lines = new Map([...view.info].map(([key, value]) => [key, value.line]));
    const legs = []; const nights = []; const breaks = []; const bands = [];
    for (const leg of view.chain.legs) {
      if (leg.kind !== 'drive') continue;
      const info = view.info.get(leg.key);
      if (!drawable(info?.line)) continue;
      const day = view.days[Math.min(leg.dayIndex, view.days.length - 1)];
      legs.push(line(info.line, { id: leg.key, tone: dayTone(day, leg.dayIndex), estimated: info.estimated }));
      const drive = view.schedule.drives.get(leg.key);
      (drive?.nights ?? []).forEach((night, index) => {
        const at = dragging?.leg === leg.key && index === 0 ? dragging.fraction : night.at;
        // The badge is the number of the day that starts after the night.
        nights.push(point(pointAt(info.line, at), { id: `${leg.key}#${index}`, leg: leg.key, tone: night.source === 'manual' ? 'accent' : 'ink-2', order: Math.floor(night.resume / 1440) + 1 }));
      });
      for (const pause of drive?.breaks ?? []) breaks.push(point(pointAt(info.line, pause.at), { id: `${leg.key}@${pause.at}`, tone: 'warn' }));
    }
    for (const band of view.fuel.bands) {
      for (const piece of band.pieces) {
        const part = slice(lines.get(piece.leg) ?? [], piece.from, piece.to);
        if (drawable(part)) bands.push(line(part, { id: `${band.id}:${piece.leg}`, tone: 'warn' }));
      }
    }
    const hazardPoints = []; const areas = [];
    for (const { event } of view.hazards) {
      if (event.point) hazardPoints.push(point(event.point, { id: event.id, tone: LEVEL_TONE[event.level] ?? 'warn', order: '!' }));
      for (const rings of event.polygons ?? []) if (rings[0]?.length >= 4) areas.push({ type: 'Feature', properties: { id: event.id, tone: LEVEL_TONE[event.level] ?? 'warn', opacity: 0.18 }, geometry: { type: 'Polygon', coordinates: rings } });
    }
    const pois = state.corridor.results.slice(0, 300).map((item) => point([item.lng, item.lat], { id: item.id, tone: 'accent' }));
    const selectedLeg = selected?.kind === 'leg' ? view.info.get(selected.key)?.line : null;
    draw('road-legs', legs);
    draw('road-selected', drawable(selectedLeg) ? [line(selectedLeg, { id: 'selected', tone: 'accent' })] : []);
    draw('road-bands', bands);
    draw('road-areas', areas);
    draw('road-breaks', breaks);
    draw('road-pois', pois);
    draw('road-hazards', hazardPoints);
    draw('road-nights', nights);
    draw('road-focus', selected?.kind === 'point' && selected.point ? [point(selected.point, { id: 'focus', tone: 'accent' })] : []);
    setDayRoutes(false);
    if (selected !== lastSelected) { lastSelected = selected; focus(selected, view); }
  }
  const schedule = () => { if (!frame && !destroyed) frame = requestAnimationFrame(render); };

  function focus(selected, view) {
    if (!selected) return;
    const duration = prefersReducedMotion() ? 0 : 400;
    if (selected.kind === 'point' && selected.point) map.easeTo({ center: selected.point, zoom: Math.max(map.getZoom(), 12), duration });
    else if (selected.kind === 'leg') {
      const coordinates = view.info.get(selected.key)?.line ?? [];
      if (coordinates.length) tripMap.fit(coordinates, { padding: 60, duration });
    }
  }

  // Night markers drag along their leg; the drop places (or moves) that leg's day end.
  const nightAt = (event) => map.queryRenderedFeatures?.(event.point, { layers: ['trips-road-nights'] })?.[0] ?? null;
  function begin(event) {
    if (!visible() || !state.canEdit() || (event.originalEvent?.touches && event.originalEvent.touches.length !== 1)) return;
    const feature = nightAt(event);
    const legKey = feature?.properties?.leg;
    if (!legKey) return;
    const view = state.view();
    const leg = view.chain.legs.find((item) => item.key === legKey);
    if (!leg) return;
    event.preventDefault?.();
    map.dragPan?.disable();
    dragging = { leg: legKey, chainLeg: leg, chain: view.chain, line: view.info.get(legKey).line, fraction: 0, existing: (view.dayEnds.get(legKey) ?? [])[0]?.id ?? null, moved: false };
    map.on('mousemove', drag); map.on('touchmove', drag);
    map.once('mouseup', end); map.once('touchend', end);
  }
  function drag(event) {
    if (!dragging) return;
    const near = project(dragging.line, [event.lngLat.lng, event.lngLat.lat]);
    if (!near) return;
    dragging.fraction = near.fraction; dragging.moved = true;
    drawn.delete('road-nights');
    schedule();
  }
  async function end() {
    const current = dragging;
    dragging = null;
    map.off('mousemove', drag); map.off('touchmove', drag);
    map.dragPan?.enable();
    if (!current?.moved) { schedule(); return; }
    try { await ops.placeNight(current.chain, current.chainLeg, current.fraction, current.existing); } catch { toast(t('road.saveFailed')); }
    drawn.delete('road-nights');
    schedule();
  }
  map.on('mousedown', begin);
  map.on('touchstart', begin);
  const offs = [
    state.subscribe(schedule),
    tripMap.onHover('road-nights', (feature) => { if (map.getCanvas) map.getCanvas().style.cursor = feature && state.canEdit() ? 'grab' : ''; }),
  ];
  schedule();

  return {
    menuItems() {
      if (!state.enabled()) return [];
      return [{ label: t('road.map.layer'), checked: always, onSelect: (on) => {
        always = on;
        try { localStorage.setItem(storageKey(spaceId), on ? 'on' : 'off'); } catch { /* A convenience only. */ }
        schedule();
      } }];
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frame);
      for (const off of offs) off();
      map.off('mousedown', begin); map.off('touchstart', begin);
      map.off('mousemove', drag); map.off('touchmove', drag);
      for (const key of KEYS) { try { tripMap.removeLayer(key); } catch { /* The map may be gone already. */ } }
      setDayRoutes(true);
      release();
    },
  };
}
