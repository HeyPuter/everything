import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/700.css';
import './style.css';
import { evalCommand, sample } from './engine/matrix.js';

/** @type {{ last?: number[][], b?: number[] }} */
const ctx = {};
const out = document.getElementById('out');
const cmd = /** @type {HTMLInputElement} */ (document.getElementById('cmd'));
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('plot'));
const pctx = canvas.getContext('2d');

function drawPlot(pts) {
  pctx.fillStyle = '#0c1218';
  pctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!pts?.length) return;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const pad = 20;
  pctx.strokeStyle = '#3ecfbf';
  pctx.lineWidth = 2;
  pctx.beginPath();
  pts.forEach((p, i) => {
    const x = pad + ((p.x - minX) / (maxX - minX || 1)) * (canvas.width - pad * 2);
    const y =
      canvas.height - pad - ((p.y - minY) / (maxY - minY || 1)) * (canvas.height - pad * 2);
    if (i === 0) pctx.moveTo(x, y);
    else pctx.lineTo(x, y);
  });
  pctx.stroke();
}

function run() {
  const result = evalCommand(cmd.value, ctx);
  if (result.matrix) {
    ctx.last = result.matrix;
    out.textContent = `${result.message}\n${result.matrix.map((r) => r.map((n) => n.toFixed(3)).join('\t')).join('\n')}`;
  } else if (result.vector) {
    out.textContent = `${result.message}\n[${result.vector.map((n) => n.toFixed(6)).join(', ')}]`;
  } else if (result.plot) {
    out.textContent = result.message;
    drawPlot(result.plot);
  } else {
    out.textContent = result.message;
  }
}

document.getElementById('run').addEventListener('click', run);
cmd.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') run();
});
drawPlot(sample(Math.sin, 0, Math.PI * 2, 48));
run();
