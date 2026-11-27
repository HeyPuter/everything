import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/700.css';
import './style.css';
import { aggregate, barChartSvg, createDashboard, sumField } from './engine/dashboard.js';

const dash = createDashboard();
const board = document.getElementById('board');

for (const w of dash.widgets) {
  const card = document.createElement('article');
  card.className = 'card';
  const h = document.createElement('h2');
  h.textContent = w.title;
  card.append(h);
  if (w.kind === 'kpi') {
    const kpi = document.createElement('p');
    kpi.className = 'kpi';
    kpi.textContent = String(sumField(dash, w.field));
    card.append(kpi);
  } else {
    const points = aggregate(dash, 'region', w.field);
    const wrap = document.createElement('div');
    wrap.innerHTML = barChartSvg(points);
    card.append(wrap.firstElementChild);
  }
  board.append(card);
}
