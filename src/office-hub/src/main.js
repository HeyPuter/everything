import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/700.css';
import './style.css';
import { OFFICE_APPS, routeFile } from './engine/routing.js';

const grid = document.getElementById('apps');
const status = document.getElementById('status');
const fileInput = /** @type {HTMLInputElement} */ (document.getElementById('file'));

for (const app of OFFICE_APPS) {
  const a = document.createElement('a');
  a.className = 'card';
  a.href = app.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.innerHTML = `<h2>${app.title}</h2><p>${app.blurb}</p><span>${app.extensions.join(' ')}</span>`;
  grid.appendChild(a);
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  const app = routeFile(file.name);
  if (!app) {
    status.textContent = `No office app mapped for “${file.name}”.`;
    return;
  }
  status.textContent = `Open “${file.name}” in ${app.title}…`;
  window.open(app.url, '_blank', 'noopener,noreferrer');
});

if ('serviceWorker' in navigator) {
  // optional: no SW required for installability if manifest + https; skip registering missing sw
}
