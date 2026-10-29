import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/700.css';
import './style.css';
import { listTables, runQuery, seedCatalog } from './engine/sql.js';

const catalog = seedCatalog();
const tablesEl = document.getElementById('tables');
const grid = document.getElementById('grid');
const status = document.getElementById('status');
const sqlEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('sql'));

tablesEl.replaceChildren(
  ...listTables(catalog).map((name) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = name;
    btn.addEventListener('click', () => {
      sqlEl.value = `SELECT * FROM ${name}`;
      run();
    });
    li.append(btn);
    return li;
  }),
);

function run() {
  try {
    const result = runQuery(catalog, sqlEl.value);
    status.textContent = `${result.rows.length} row(s)`;
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const c of result.columns) {
      const th = document.createElement('th');
      th.textContent = c;
      hr.append(th);
    }
    thead.append(hr);
    const tbody = document.createElement('tbody');
    for (const row of result.rows) {
      const tr = document.createElement('tr');
      for (const c of result.columns) {
        const td = document.createElement('td');
        td.textContent = String(row[c]);
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(thead, tbody);
    grid.replaceChildren(table);
  } catch (err) {
    status.textContent = err instanceof Error ? err.message : String(err);
    grid.replaceChildren();
  }
}

document.getElementById('run').addEventListener('click', run);
run();
