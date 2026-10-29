import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/700.css';
import './style.css';
import { createFlow, orderNodes, runFlow } from './engine/flow.js';

const flow = createFlow();
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('graph'));
const ctx = canvas.getContext('2d');
const log = document.getElementById('log');
const status = document.getElementById('status');

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#12101c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const nodes = orderNodes(flow);
  const positions = new Map();
  nodes.forEach((n, i) => {
    positions.set(n.id, { x: 60 + i * 180, y: 110 });
  });
  ctx.strokeStyle = 'rgba(255,255,255,.25)';
  ctx.lineWidth = 2;
  for (const e of flow.edges) {
    const a = positions.get(e.from);
    const b = positions.get(e.to);
    if (!a || !b) continue;
    ctx.beginPath();
    ctx.moveTo(a.x + 50, a.y);
    ctx.lineTo(b.x - 50, b.y);
    ctx.stroke();
  }
  for (const n of nodes) {
    const p = positions.get(n.id);
    ctx.fillStyle = n.type === 'trigger' ? '#6b5cff' : n.type === 'filter' ? '#ff8a3d' : '#3ecfbf';
    roundRect(p.x - 50, p.y - 28, 100, 56, 12);
    ctx.fillStyle = '#0b0a12';
    ctx.font = '700 12px DM Sans, sans-serif';
    ctx.fillText(n.kind, p.x - 36, p.y + 4);
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

document.getElementById('run').addEventListener('click', () => {
  const result = runFlow(flow);
  status.textContent = result.ok ? `${result.steps.length} steps` : result.error;
  log.textContent = JSON.stringify(result.steps, null, 2);
});

draw();
