// The Scripts panel: installed scripts with their File → Scripts toggle,
// shortcut, run and edit buttons, and the output of recent runs.
import './scripting.css';
import type { Editor } from '../../editor';
import { escapeXML } from '../../model/assets';
import { svg } from '../../app/icons';
import { formatShortcut } from '../../app/shortcuts';
import { listScripts, scriptSelection, updateScript } from './store';
import { clearScriptLog, onScriptLog, scriptLog } from './run';
import { openScriptEditor } from './code-editor';

export function mount(e: Editor, el: HTMLElement) {
  el.classList.add('scripts-panel');
  el.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    if (t.closest('[data-clear-log]')) return clearScriptLog();
    const row = t.closest<HTMLElement>('[data-script]');
    if (!row) return;
    const id = row.dataset.script!;
    scriptSelection.id = id;
    // Run Script works for every installed script; File → Scripts lists only those turned on.
    if (t.closest('[data-run]')) void e.runCommand('scripts.run-selected');
    else if (t.closest('[data-edit]')) openScriptEditor(e, id);
    update(e, el);
  });
  el.addEventListener('dblclick', (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-script]');
    if (row && !(ev.target as HTMLElement).closest('button,input')) openScriptEditor(e, row.dataset.script!);
  });
  el.addEventListener('change', (ev) => {
    const box = (ev.target as HTMLElement).closest<HTMLInputElement>('[data-enable]');
    if (box) void updateScript(box.dataset.enable!, { enabled: box.checked });
  });
  // Output arrives while the panel is open (drawn once per frame); a detached
  // panel stops listening.
  let frame = 0;
  const stop = onScriptLog(() => {
    if (!el.isConnected) return stop();
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      renderLog(el);
    });
  });
}

function renderLog(el: HTMLElement) {
  const log = el.querySelector<HTMLElement>('.scripts-log-lines');
  if (!log) return;
  const lines = scriptLog.slice(-60);
  log.innerHTML = lines.length
    ? lines.map((l) => `<div class="log-${l.level}"><span class="muted">${escapeXML(l.script)}:</span> ${escapeXML(l.text)}</div>`).join('')
    : '<div class="muted">Script output and errors appear here.</div>';
  log.scrollTop = log.scrollHeight;
}

// Edits refresh visible panels; the list only changes with the scripts.
const shown = new WeakMap<HTMLElement, string>();
export function update(e: Editor, el: HTMLElement) {
  const scripts = listScripts();
  const key = JSON.stringify([scriptSelection.id, scripts.map((s) => [s.id, s.name, s.description, s.enabled, s.shortcut])]);
  if (shown.get(el) === key && el.querySelector('.scripts-list')) return;
  shown.set(el, key);
  void e;
  const rows = scripts
    .map(
      (s) => `<div class="script-row ${s.id === scriptSelection.id ? 'selected' : ''} ${s.enabled ? '' : 'off'}" data-script="${s.id}" role="option" aria-selected="${s.id === scriptSelection.id}" title="${escapeXML(s.description || s.name)}">
        <input type="checkbox" data-enable="${s.id}" ${s.enabled ? 'checked' : ''} aria-label="List ${escapeXML(s.name)} in File → Scripts" title="List in File → Scripts (with its shortcut) and offer it to script events">
        <span class="script-text"><span class="script-title">${escapeXML(s.name)}</span>${s.description ? `<small>${escapeXML(s.description)}</small>` : ''}</span>
        ${s.shortcut ? `<kbd>${escapeXML(formatShortcut(s.shortcut))}</kbd>` : ''}
        <button class="icon-button" data-run aria-label="Run ${escapeXML(s.name)}" title="Run">${svg('play', 13)}</button>
        <button class="icon-button" data-edit aria-label="Edit ${escapeXML(s.name)}" title="Edit the script">${svg('pen-line', 13)}</button>
      </div>`,
    )
    .join('');
  el.innerHTML = `<div class="scripts-list" role="listbox" aria-label="Installed scripts">${rows || '<p class="scripts-empty muted">No scripts installed. Create one, or install a .js file.</p>'}</div>
    <div class="scripts-log"><div class="scripts-log-head"><span>Output</span><button class="icon-button" data-clear-log aria-label="Clear output" title="Clear the output">${svg('trash-2', 12)}</button></div><div class="scripts-log-lines" aria-live="polite"></div></div>
    <div class="layer-footer"><button data-command="scripts.run-selected" aria-label="Run selected script" title="Run the selected script" ${scriptSelection.id ? '' : 'disabled'}>${svg('play', 14)}</button><button data-command="scripts.new" aria-label="New script" title="Write a new script">${svg('plus', 14)}</button><button data-command="scripts.install" aria-label="Install script from file" title="Install a script from a .js file">${svg('upload', 14)}</button><button data-command="file.script-events" aria-label="Script events" title="Run scripts or actions on events (Script Events Manager)">${svg('zap', 14)}</button><button data-command="scripts.delete" aria-label="Delete script" title="Delete the selected script" ${scriptSelection.id ? '' : 'disabled'}>${svg('trash-2', 14)}</button></div>`;
  renderLog(el);
}
