import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/700.css';
import './style.css';
import { deg, forwardKinematics, inverseKinematics, rad } from './engine/arm.js';

const L1 = 120;
const L2 = 90;
let theta1 = rad(35);
let theta2 = rad(40);
let target = null;

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('stage'));
const ctx = canvas.getContext('2d');
const el = {
  j1: /** @type {HTMLInputElement} */ (document.getElementById('j1')),
  j2: /** @type {HTMLInputElement} */ (document.getElementById('j2')),
  status: document.getElementById('status'),
};

function worldFromEvent(ev) {
  const rect = canvas.getBoundingClientRect();
  const scale = canvas.width / rect.width;
  const x = (ev.clientX - rect.left) * scale - canvas.width / 2;
  const y = canvas.height / 2 - (ev.clientY - rect.top) * scale;
  return { x, y };
}

function draw() {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0d1a24';
  ctx.fillRect(0, 0, w, h);

  // grid
  ctx.strokeStyle = 'rgba(120,180,220,0.12)';
  ctx.beginPath();
  for (let x = 0; x <= w; x += 40) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let y = 0; y <= h; y += 40) {
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();

  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.scale(1, -1);

  if (target) {
    ctx.fillStyle = '#ff6b6b';
    ctx.beginPath();
    ctx.arc(target.x, target.y, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  const { joints } = forwardKinematics(L1, L2, theta1, theta2);
  ctx.strokeStyle = '#5ad0ff';
  ctx.lineWidth = 10;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(joints[0].x, joints[0].y);
  ctx.lineTo(joints[1].x, joints[1].y);
  ctx.lineTo(joints[2].x, joints[2].y);
  ctx.stroke();

  for (const j of joints) {
    ctx.fillStyle = '#e8f6ff';
    ctx.beginPath();
    ctx.arc(j.x, j.y, 8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  el.j1.value = String(Math.round(deg(theta1)));
  el.j2.value = String(Math.round(deg(theta2)));
  const tip = joints[2];
  el.status.textContent = `θ1=${deg(theta1).toFixed(1)}°  θ2=${deg(theta2).toFixed(1)}°  tip=(${tip.x.toFixed(1)}, ${tip.y.toFixed(1)})`;
}

el.j1.addEventListener('input', () => {
  theta1 = rad(Number(el.j1.value));
  draw();
});
el.j2.addEventListener('input', () => {
  theta2 = rad(Number(el.j2.value));
  draw();
});

canvas.addEventListener('click', (ev) => {
  target = worldFromEvent(ev);
  const ik = inverseKinematics(L1, L2, target.x, target.y);
  if (!ik) {
    el.status.textContent = 'Target unreachable';
    draw();
    return;
  }
  theta1 = ik.theta1;
  theta2 = ik.theta2;
  draw();
});

draw();
