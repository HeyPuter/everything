import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/700.css';
import './style.css';
import {
  adjustPhoto,
  createCatalog,
  previewFilter,
  setFilter,
  setFlag,
  setRating,
  visiblePhotos,
} from './engine/catalog.js';

let cat = createCatalog();
let selected = cat.photos[0].id;
const grid = document.getElementById('grid');
const preview = document.getElementById('preview');
const meta = document.getElementById('meta');

const hues = {
  p1: 'linear-gradient(135deg,#3a6ea5,#9ec9e8)',
  p2: 'linear-gradient(135deg,#2f5d3a,#8fbf7a)',
  p3: 'linear-gradient(135deg,#1a1a40,#6a5acd)',
  p4: 'linear-gradient(135deg,#5a4638,#d2b48c)',
  p5: 'linear-gradient(135deg,#c4a35a,#f0e0b0)',
};

function photo() {
  return cat.photos.find((p) => p.id === selected);
}

function render() {
  const vis = visiblePhotos(cat);
  grid.replaceChildren(
    ...vis.map((p) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = p.id === selected ? 'thumb active' : 'thumb';
      btn.style.background = hues[p.id] || '#333';
      btn.textContent = `${'★'.repeat(p.rating)}${'☆'.repeat(5 - p.rating)}\n${p.name}`;
      btn.addEventListener('click', () => {
        selected = p.id;
        syncSliders();
        render();
      });
      return btn;
    }),
  );
  const p = photo();
  preview.style.background = hues[p.id] || '#333';
  preview.style.filter = previewFilter(p.adjustments);
  meta.textContent = `${p.name} · ${p.flag || 'unflagged'} · ${p.tags.join(', ')}`;
}

function syncSliders() {
  const a = photo().adjustments;
  for (const k of ['exposure', 'contrast', 'saturation', 'temperature']) {
    /** @type {HTMLInputElement} */ (document.getElementById(k)).value = String(a[k]);
  }
}

function bindAdjust(id) {
  document.getElementById(id).addEventListener('input', (ev) => {
    const v = Number(/** @type {HTMLInputElement} */ (ev.target).value);
    cat = adjustPhoto(cat, selected, { [id]: v });
    render();
  });
}
for (const k of ['exposure', 'contrast', 'saturation', 'temperature']) bindAdjust(k);

document.getElementById('min-rating').addEventListener('input', (ev) => {
  cat = setFilter(cat, { minRating: Number(/** @type {HTMLInputElement} */ (ev.target).value) });
  render();
});
document.getElementById('tag').addEventListener('input', (ev) => {
  cat = setFilter(cat, { tag: /** @type {HTMLInputElement} */ (ev.target).value });
  render();
});
document.getElementById('rate-up').addEventListener('click', () => {
  cat = setRating(cat, selected, photo().rating + 1);
  render();
});
document.getElementById('pick').addEventListener('click', () => {
  cat = setFlag(cat, selected, 'pick');
  render();
});

syncSliders();
render();
