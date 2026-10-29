import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/700.css';
import './style.css';
import {
  createHistory,
  floodFillAt,
  linePoints,
  parseHex,
  TOOLS,
} from './engine/drawing.js';

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('canvas'));
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const history = createHistory(40);
let tool = 'pencil';
let color = '#1a1a1a';
let size = 3;
let drawing = false;
let start = null;
let snapshot = null;

function blank() {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function pushUndo() {
  history.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
}

function pos(ev) {
  const r = canvas.getBoundingClientRect();
  const x = ((ev.clientX - r.left) / r.width) * canvas.width;
  const y = ((ev.clientY - r.top) / r.height) * canvas.height;
  return { x, y };
}

function strokeDisc(x, y, erase = false) {
  ctx.fillStyle = erase ? '#ffffff' : color;
  ctx.beginPath();
  ctx.arc(x, y, tool === 'brush' || erase ? size * 1.6 : size / 2, 0, Math.PI * 2);
  ctx.fill();
}

function drawShape(a, b, preview = false) {
  if (preview && snapshot) ctx.putImageData(snapshot, 0, 0);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = size;
  if (tool === 'line') {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  } else if (tool === 'rect') {
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  } else if (tool === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(
      (a.x + b.x) / 2,
      (a.y + b.y) / 2,
      Math.abs(b.x - a.x) / 2,
      Math.abs(b.y - a.y) / 2,
      0,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
  }
}

canvas.addEventListener('pointerdown', (ev) => {
  canvas.setPointerCapture(ev.pointerId);
  const p = pos(ev);
  if (tool === 'fill') {
    pushUndo();
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    floodFillAt(img, Math.floor(p.x), Math.floor(p.y), parseHex(color));
    ctx.putImageData(img, 0, 0);
    return;
  }
  pushUndo();
  drawing = true;
  start = p;
  if (tool === 'line' || tool === 'rect' || tool === 'ellipse') {
    snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
  } else {
    strokeDisc(p.x, p.y, tool === 'eraser');
  }
});

canvas.addEventListener('pointermove', (ev) => {
  if (!drawing || !start) return;
  const p = pos(ev);
  if (tool === 'pencil' || tool === 'brush' || tool === 'eraser') {
    const pts = linePoints(start.x, start.y, p.x, p.y);
    for (const [x, y] of pts) strokeDisc(x, y, tool === 'eraser');
    start = p;
  } else {
    drawShape(start, p, true);
  }
});

function endStroke(ev) {
  if (!drawing) return;
  const p = pos(ev);
  if (tool === 'line' || tool === 'rect' || tool === 'ellipse') {
    drawShape(start, p, true);
  }
  drawing = false;
  start = null;
  snapshot = null;
}

canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);

document.querySelectorAll('[data-tool]').forEach((btn) => {
  btn.addEventListener('click', () => {
    tool = btn.getAttribute('data-tool');
    document.querySelectorAll('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  });
});

document.getElementById('color').addEventListener('input', (ev) => {
  color = /** @type {HTMLInputElement} */ (ev.target).value;
});
document.getElementById('size').addEventListener('input', (ev) => {
  size = Number(/** @type {HTMLInputElement} */ (ev.target).value);
});
document.getElementById('undo').addEventListener('click', () => {
  const snap = history.pop();
  if (snap) ctx.putImageData(snap, 0, 0);
});
document.getElementById('clear').addEventListener('click', () => {
  pushUndo();
  blank();
});
document.getElementById('export').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = 'painting.png';
  a.click();
});

blank();
document.querySelector(`[data-tool="pencil"]`)?.setAttribute('aria-pressed', 'true');
void TOOLS;
