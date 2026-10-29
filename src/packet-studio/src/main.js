import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/700.css';
import './style.css';
import { bytesToHex, decodeSummary, demoCapture, filterFrames } from './engine/packets.js';

const frames = demoCapture();
const tbody = document.querySelector('#list tbody');
const hexEl = document.getElementById('hex');
const protoEl = /** @type {HTMLSelectElement} */ (document.getElementById('proto'));
const textEl = /** @type {HTMLInputElement} */ (document.getElementById('text'));
let selected = frames[0];

function render() {
  const filtered = filterFrames(frames, { proto: protoEl.value, text: textEl.value });
  tbody.replaceChildren(
    ...filtered.map((f) => {
      const tr = document.createElement('tr');
      tr.className = selected?.id === f.id ? 'active' : '';
      tr.innerHTML = `<td>${f.id}</td><td>${f.timeMs}</td><td>${f.proto}</td><td>${f.src}</td><td>${f.dst}</td><td>${f.summary}</td>`;
      tr.addEventListener('click', () => {
        selected = f;
        render();
      });
      return tr;
    }),
  );
  if (selected) {
    hexEl.textContent = `${decodeSummary(selected.bytes)}\n\n${bytesToHex(selected.bytes)}`;
  }
}

protoEl.addEventListener('change', render);
textEl.addEventListener('input', render);
render();
