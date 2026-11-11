import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/700.css';
import './style.css';
import { defaultGraph, evaluate } from './engine/graph.js';

const graph = defaultGraph();
const list = document.getElementById('nodes');
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('view'));
const ctx = canvas.getContext('2d');
const meta = document.getElementById('meta');

function renderList() {
  list.replaceChildren();
  for (const n of graph.nodes) {
    const li = document.createElement('li');
    li.innerHTML = `<strong>${n.type}</strong> <code>${n.id}</code> ← ${(n.inputs || []).join(', ') || '—'}`;
    list.appendChild(li);
  }
}

function draw() {
  const pts = evaluate(graph);
  meta.textContent = `${pts.length} points`;
  ctx.fillStyle = '#0e141c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#7ad0ff';
  for (const p of pts) {
    const x = canvas.width / 2 + p.x * 160;
    const y = canvas.height / 2 - p.z * 160 - p.y * 120;
    ctx.fillRect(x, y, 3, 3);
  }
}

document.getElementById('amp').addEventListener('input', (ev) => {
  const noise = graph.nodes.find((n) => n.id === 'noise1');
  noise.params.amp = Number(/** @type {HTMLInputElement} */ (ev.target).value);
  draw();
});

renderList();
draw();
