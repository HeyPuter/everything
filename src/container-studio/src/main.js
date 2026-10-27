import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/700.css';
import './style.css';
import {
  createDemoEngine,
  requestLocalBridge,
  startContainer,
  stopContainer,
} from './engine/docker.js';

let engine = createDemoEngine();
const notice = document.getElementById('notice');
const mode = document.getElementById('mode');
const containersEl = document.getElementById('containers');
const imagesEl = document.getElementById('images');
const volumesEl = document.getElementById('volumes');
const composeEl = document.getElementById('compose');

function render() {
  notice.textContent = engine.notice;
  mode.textContent = engine.mode === 'demo' ? 'DEMO' : 'LOCAL BRIDGE';
  mode.className = engine.mode === 'demo' ? 'badge' : 'badge live';
  containersEl.replaceChildren(
    ...engine.containers.map((c) => {
      const row = document.createElement('div');
      row.className = 'crow';
      row.innerHTML = `<strong>${c.name}</strong> <span>${c.image}</span> <em>${c.status}</em>`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn mini';
      btn.textContent = c.status === 'running' ? 'Stop' : 'Start';
      btn.addEventListener('click', () => {
        engine = c.status === 'running' ? stopContainer(engine, c.id) : startContainer(engine, c.id);
        render();
      });
      row.append(btn);
      return row;
    }),
  );
  imagesEl.replaceChildren(
    ...engine.images.map((i) => {
      const li = document.createElement('li');
      li.textContent = `${i.repo}:${i.tag} · ${i.sizeMb} MB`;
      return li;
    }),
  );
  volumesEl.replaceChildren(
    ...engine.volumes.map((v) => {
      const li = document.createElement('li');
      li.textContent = `${v.name} (${v.driver}) · ${v.sizeMb} MB`;
      return li;
    }),
  );
  composeEl.replaceChildren(
    ...engine.compose.map((p) => {
      const li = document.createElement('li');
      li.textContent = `${p.name}: ${p.services.join(', ')}`;
      return li;
    }),
  );
}

document.getElementById('bridge').addEventListener('click', () => {
  engine = requestLocalBridge(engine);
  render();
});

render();
