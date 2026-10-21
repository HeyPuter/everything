/**
 * Sun settings: project location, north angle, date and time. Changes
 * preview live in views that cast shadows; OK keeps them as one undo step.
 */
import { h } from './dom.js';
import { openDialog } from './dialog.js';
import { PLACES, DEFAULT_LOCATION, DEFAULT_SUN, solarPosition } from '../core/sun.js';

const pad = (n) => String(n).padStart(2, '0');
const toTime = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const toMin = (t) => {
  const [hh, mm] = String(t).split(':').map(Number);
  return (hh || 0) * 60 + (mm || 0);
};

export function sunSettingsDialog(app) {
  const doc = app.doc;
  const p = doc.get('project') || {};
  const state = {
    location: { ...DEFAULT_LOCATION, ...(p.location || {}) },
    sun: { ...DEFAULT_SUN, ...(p.sun || {}) },
    trueNorth: +p.trueNorth || 0,
  };
  if (doc.inTransaction) return;
  doc.begin('Sun settings');
  if (!doc.has('project')) doc.add({ id: 'project', kind: 'project' });
  const preview = () => {
    doc.update('project', { location: { ...state.location }, sun: { ...state.sun }, trueNorth: state.trueNorth });
    doc.flush();
    app.requestRender();
    readout();
  };

  const place = h('select.input', { 'aria-label': 'Place' }, h('option', { value: '' }, 'Custom'), PLACES.map((pl, i) => h('option', { value: String(i) }, pl.name)));
  const num = (label, value, step, onSet) => {
    const inp = h('input.input', { type: 'number', step, value: String(value), 'aria-label': label });
    inp.addEventListener('change', () => {
      const v = parseFloat(inp.value);
      if (Number.isFinite(v)) onSet(v);
      place.value = '';
      preview();
    });
    return { inp, field: h('label.field', h('span.field-label', label), inp) };
  };
  const lat = num('Latitude (degrees, north positive)', state.location.lat, '0.01', (v) => (state.location = { ...state.location, name: 'Custom', lat: Math.max(-90, Math.min(90, v)) }));
  const lon = num('Longitude (degrees, east positive)', state.location.lon, '0.01', (v) => (state.location = { ...state.location, name: 'Custom', lon: Math.max(-180, Math.min(180, v)) }));
  const utc = num('Time zone (hours from UTC)', state.location.utcOffset, '0.5', (v) => (state.location = { ...state.location, name: 'Custom', utcOffset: v }));
  const idx = PLACES.findIndex((pl) => pl.name === state.location.name);
  place.value = idx >= 0 ? String(idx) : '';
  place.addEventListener('change', () => {
    const pl = PLACES[+place.value];
    if (!pl) return;
    state.location = { ...pl };
    lat.inp.value = String(pl.lat);
    lon.inp.value = String(pl.lon);
    utc.inp.value = String(pl.utcOffset);
    preview();
  });
  const north = num('Project north to true north (degrees, counterclockwise)', state.trueNorth, '1', (v) => (state.trueNorth = v));
  const date = h('input.input', { type: 'date', value: state.sun.date, 'aria-label': 'Date' });
  date.addEventListener('change', () => {
    if (date.value) state.sun = { ...state.sun, date: date.value };
    preview();
  });
  const time = h('input', { type: 'range', min: '0', max: '1435', step: '5', value: String(toMin(state.sun.time)), 'aria-label': 'Time of day', class: 'sun-slider' });
  const timeLabel = h('output.sun-time');
  time.addEventListener('input', () => {
    state.sun = { ...state.sun, time: toTime(+time.value) };
    preview();
  });
  const info = h('p.field-hint', { role: 'status' });
  const dial = h('div.sun-dial', { 'aria-hidden': 'true' });
  function readout() {
    const { altitude, azimuth } = solarPosition(state.location, state.sun.date, state.sun.time);
    timeLabel.textContent = state.sun.time;
    info.textContent = altitude > 0 ? `Sun ${altitude.toFixed(1)}° above the horizon, ${azimuth.toFixed(0)}° from north.` : 'The sun is below the horizon: no shadows at this time.';
    // Plan dial: where the sun is seen from above, relative to project north.
    const a = ((azimuth - state.trueNorth) * Math.PI) / 180;
    const r = 44 * (1 - Math.max(0, altitude) / 90);
    dial.style.setProperty('--sx', `${50 + Math.sin(a) * r}%`);
    dial.style.setProperty('--sy', `${50 - Math.cos(a) * r}%`);
    dial.classList.toggle('night', altitude <= 0);
  }
  readout();

  const body = h(
    'div.sun-layout',
    h('div.sun-fields',
      h('label.field', h('span.field-label', 'Location'), place),
      h('div.sun-row', lat.field, lon.field),
      utc.field,
      north.field,
      h('label.field', h('span.field-label', 'Date'), date),
      h('label.field', h('span.field-label', 'Time'), h('div.sun-row', time, timeLabel)),
      info),
    h('div', dial, h('p.field-hint', { style: { textAlign: 'center' } }, 'Seen from above; up is project north.')),
  );
  return openDialog({
    title: 'Sun Settings',
    size: 'md',
    body,
    actions: [
      { label: 'Cancel', value: null },
      { label: 'OK', primary: true, value: true },
    ],
  }).then((ok) => {
    if (!doc.inTransaction) return;
    if (ok) doc.commit();
    else doc.rollback();
    app.requestRender();
  });
}
