import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/700.css';
import './style.css';
import {
  addPage,
  addPageFrame,
  columnize,
  createDocument,
  exportPdf,
  resolvedFrames,
} from './engine/layout.js';

let doc = createDocument();
let pageId = doc.pages[0].id;
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('page'));
const ctx = canvas.getContext('2d');
const pagesEl = document.getElementById('pages');

function draw() {
  ctx.fillStyle = '#f7f1e8';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#d0c4b0';
  ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
  for (const f of resolvedFrames(doc, pageId)) {
    ctx.strokeStyle = '#c45c26';
    ctx.strokeRect(f.x, f.y, f.w, f.h);
    const cols = columnize(f.text, f.columns);
    const colW = f.w / cols.length;
    ctx.fillStyle = '#1a1a1a';
    ctx.font = '13px DM Sans, sans-serif';
    cols.forEach((text, i) => {
      const x = f.x + 6 + i * colW;
      wrap(text, x, f.y + 16, colW - 12, 16);
    });
  }
  pagesEl.replaceChildren(
    ...doc.pages.map((p) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = p.id + (p.id === pageId ? ' · active' : '');
      btn.addEventListener('click', () => {
        pageId = p.id;
        draw();
      });
      li.append(btn);
      return li;
    }),
  );
}

function wrap(text, x, y, maxW, lineH) {
  const words = text.split(/\s+/);
  let line = '';
  let yy = y;
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, yy);
      line = w;
      yy += lineH;
    } else line = test;
  }
  if (line) ctx.fillText(line, x, yy);
}

document.getElementById('add-frame').addEventListener('click', () => {
  const columns = Number(/** @type {HTMLInputElement} */ (document.getElementById('columns')).value) || 1;
  const text = /** @type {HTMLTextAreaElement} */ (document.getElementById('copy')).value;
  doc = addPageFrame(doc, pageId, {
    x: 54,
    y: 90 + resolvedFrames(doc, pageId).length * 24,
    w: 504,
    h: 160,
    text,
    columns,
  });
  draw();
});

document.getElementById('add-page').addEventListener('click', () => {
  doc = addPage(doc, 'master-a');
  pageId = doc.pages[doc.pages.length - 1].id;
  draw();
});

document.getElementById('export-pdf').addEventListener('click', () => {
  const blob = new Blob([exportPdf(doc, pageId)], { type: 'application/pdf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'layout.pdf';
  a.click();
});

draw();
