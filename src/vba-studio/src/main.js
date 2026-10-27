import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/700.css';
import '@fontsource/dm-mono/400.css';
import './style.css';

import { runMacro } from './engine/interpreter.js';
import { colToLetters, createWorksheet } from './engine/worksheet.js';

const SETTINGS_KEY = 'vba-studio.settings.v1';
const SAMPLE = `Sub HelloOffice()
  ' VBA-inspired macro — original interpreter, not Microsoft VBA
  Range("A1").Value = "Hello"
  Range("B1").Value = "Everything"
  Range("A2").Value = 21
  Range("B2").Value = Range("A2").Value * 2
  Dim total
  total = 0
  Dim i
  For i = 1 To 5
    total = total + i
  Next
  Range("C1").Value = total
  If Range("B2").Value = 42 Then
    MsgBox "Answer is 42"
  Else
    MsgBox "Keep going"
  End If
End Sub
`;

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {
      theme: raw.theme === 'light' || raw.theme === 'dark' || raw.theme === 'system' ? raw.theme : 'system',
      source: typeof raw.source === 'string' ? raw.source : SAMPLE,
    };
  } catch {
    return { theme: 'system', source: SAMPLE };
  }
}

function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

function resolveTheme(theme) {
  if (theme === 'light' || theme === 'dark') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const settings = loadSettings();
const worksheet = createWorksheet(12, 8);

const el = {
  editor: /** @type {HTMLTextAreaElement} */ (document.getElementById('editor')),
  sheet: document.getElementById('sheet'),
  output: document.getElementById('output'),
  run: document.getElementById('run'),
  reset: document.getElementById('reset'),
};

function applyTheme() {
  document.documentElement.dataset.theme = resolveTheme(settings.theme);
  document.querySelectorAll('[data-theme]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.theme === settings.theme));
  });
}

function renderSheet() {
  const table = document.createElement('table');
  table.className = 'sheet';
  const head = document.createElement('tr');
  head.appendChild(document.createElement('th'));
  for (let c = 0; c < worksheet.cols; c += 1) {
    const th = document.createElement('th');
    th.textContent = colToLetters(c);
    head.appendChild(th);
  }
  table.appendChild(head);
  for (let r = 0; r < worksheet.rows; r += 1) {
    const tr = document.createElement('tr');
    const rh = document.createElement('th');
    rh.textContent = String(r + 1);
    tr.appendChild(rh);
    for (let c = 0; c < worksheet.cols; c += 1) {
      const td = document.createElement('td');
      const input = document.createElement('input');
      const addr = `${colToLetters(c)}${r + 1}`;
      input.value = String(worksheet.get(addr) ?? '');
      input.addEventListener('change', () => {
        const v = input.value;
        const num = Number(v);
        worksheet.set(addr, v !== '' && !Number.isNaN(num) && v.trim() !== '' ? num : v);
      });
      td.appendChild(input);
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  el.sheet.replaceChildren(table);
}

function run() {
  settings.source = el.editor.value;
  saveSettings(settings);
  const host = { worksheet, messages: [] };
  try {
    runMacro(el.editor.value, host);
    el.output.textContent = host.messages.length
      ? host.messages.map((m) => `MsgBox: ${m}`).join('\n')
      : 'Macro finished.';
  } catch (err) {
    el.output.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
  renderSheet();
}

el.editor.value = settings.source;
el.run.addEventListener('click', run);
el.reset.addEventListener('click', () => {
  worksheet.clear();
  el.editor.value = SAMPLE;
  settings.source = SAMPLE;
  saveSettings(settings);
  el.output.textContent = '';
  renderSheet();
});

document.querySelectorAll('[data-theme]').forEach((btn) => {
  btn.addEventListener('click', () => {
    settings.theme = btn.dataset.theme;
    saveSettings(settings);
    applyTheme();
  });
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (settings.theme === 'system') applyTheme();
});

document.addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
    ev.preventDefault();
    run();
  }
});

applyTheme();
renderSheet();
