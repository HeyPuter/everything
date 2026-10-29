import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/700.css';
import './style.css';
import { addLayer, addMarker, createMap, project, toGeoJSON } from './engine/geo.js';

let doc = createMap();
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('map'));
const ctx = canvas.getContext('2d');
const status = document.getElementById('status');
const layersEl = document.getElementById('layers');

function draw() {
  const { width, height } = canvas;
  ctx.fillStyle = '#0d2a2e';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(120, 200, 190, 0.18)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 12; i += 1) {
    const y = ((i + 1) / 13) * height;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y + Math.sin(i) * 8);
    ctx.stroke();
  }
  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    for (const m of layer.markers) {
      const p = project(m.lat, m.lng, doc.center, doc.zoom, width, height);
      ctx.fillStyle = '#f0c14a';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e8f6f4';
      ctx.font = '12px DM Sans, sans-serif';
      ctx.fillText(m.name, p.x + 10, p.y + 4);
    }
  }
  layersEl.replaceChildren(
    ...doc.layers.map((layer) => {
      const li = document.createElement('li');
      li.textContent = `${layer.name} (${layer.markers.length})`;
      return li;
    }),
  );
  const n = doc.layers.reduce((a, l) => a + l.markers.length, 0);
  status.textContent = `${n} marker(s) · zoom ${doc.zoom} · offline canvas map`;
}

document.getElementById('add').addEventListener('click', () => {
  const lat = Number(/** @type {HTMLInputElement} */ (document.getElementById('lat')).value);
  const lng = Number(/** @type {HTMLInputElement} */ (document.getElementById('lng')).value);
  const name = /** @type {HTMLInputElement} */ (document.getElementById('name')).value || 'Marker';
  const layerId = doc.layers[doc.layers.length - 1].id;
  doc = addMarker(doc, layerId, { name, lat, lng });
  doc = { ...doc, center: { lat, lng } };
  draw();
});

document.getElementById('layer').addEventListener('click', () => {
  doc = addLayer(doc, `Layer ${doc.layers.length + 1}`);
  draw();
});

document.getElementById('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(toGeoJSON(doc), null, 2)], { type: 'application/geo+json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'map.geojson';
  a.click();
});

draw();
