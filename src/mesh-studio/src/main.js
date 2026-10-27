import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/700.css';
import './style.css';
import { meshFromPrompt, toObj } from './engine/mesh.js';

const promptEl = /** @type {HTMLInputElement} */ (document.getElementById('prompt'));
const meta = document.getElementById('meta');
const pre = document.getElementById('obj');
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('view'));
const ctx = canvas.getContext('2d');

function project(v, rotY) {
  const c = Math.cos(rotY);
  const s = Math.sin(rotY);
  const x = v.x * c - v.z * s;
  const z = v.x * s + v.z * c;
  const y = v.y;
  const scale = 140;
  return {
    x: canvas.width / 2 + x * scale,
    y: canvas.height / 2 - y * scale - z * 0.35 * scale,
  };
}

function draw(mesh, t) {
  ctx.fillStyle = '#10161f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(120,200,255,0.55)';
  ctx.lineWidth = 1;
  const rot = t * 0.0004;
  for (const f of mesh.faces) {
    ctx.beginPath();
    f.forEach((idx, i) => {
      const p = project(mesh.vertices[idx - 1], rot);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
    ctx.stroke();
  }
}

let current = meshFromPrompt('box');
let raf = 0;
function tick(t) {
  draw(current.mesh, t);
  raf = requestAnimationFrame(tick);
}

function regenerate() {
  current = meshFromPrompt(promptEl.value);
  const obj = toObj(current.mesh);
  pre.textContent = obj.slice(0, 4000);
  meta.textContent = `${current.kind} · ${current.mesh.vertices.length} verts · ${current.mesh.faces.length} faces`;
}

document.getElementById('generate').addEventListener('click', regenerate);
document.getElementById('download').addEventListener('click', () => {
  const blob = new Blob([toObj(current.mesh)], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${current.kind}.obj`;
  a.click();
  URL.revokeObjectURL(a.href);
});

regenerate();
raf = requestAnimationFrame(tick);
void raf;
