import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/700.css';
import './style.css';
import {
  compositeLayers,
  createShow,
  cutToProgram,
  previewScene,
  programScene,
  setPreview,
} from './engine/scenes.js';

let show = createShow();
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('program'));
const ctx = canvas.getContext('2d');
const scenesEl = document.getElementById('scenes');
const air = document.getElementById('air');
const status = document.getElementById('status');

const colors = { camera: '#3a6ea5', screen: '#2f5d3a', image: '#8a5a2a', text: '#e03030' };

function draw() {
  const scene = programScene(show) || previewScene(show);
  ctx.fillStyle = '#0a0a0c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const layer of compositeLayers(show, scene)) {
    ctx.fillStyle = colors[layer.kind] || '#444';
    ctx.globalAlpha = 0.9;
    ctx.fillRect(layer.x, layer.y, layer.w, layer.h);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#fff';
    ctx.font = '14px DM Sans, sans-serif';
    ctx.fillText(layer.label, layer.x + 8, layer.y + 22);
  }
  air.textContent = show.programId ? 'ON AIR' : 'PREVIEW';
  air.className = show.programId ? 'air live' : 'air';
  status.textContent = `Preview: ${previewScene(show)?.name || '—'} · Program: ${programScene(show)?.name || 'none'}`;
  scenesEl.replaceChildren(
    ...show.scenes.map((s) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = s.id === show.activeId ? 'scene active' : 'scene';
      btn.textContent = s.name;
      btn.addEventListener('click', () => {
        show = setPreview(show, s.id);
        draw();
      });
      return btn;
    }),
  );
}

document.getElementById('cut').addEventListener('click', () => {
  show = cutToProgram(show);
  draw();
});

draw();
