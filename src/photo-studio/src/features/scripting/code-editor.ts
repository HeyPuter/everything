// The script editor: a text area over a highlighted copy of its text, with
// line numbers, indentation keys, save, run and the script's output.
import './scripting.css';
import type { Editor } from '../../editor';
import { escapeXML } from '../../model/assets';
import { svg } from '../../app/icons';
import { isMac } from '../../app/shortcuts';
import { askChoice } from '../preferences/warnings';
import { highlight } from './highlight';
import { findScript, newScriptRecord, saveScript, scriptMetadata, updateScript } from './store';
import { onScriptLog, runScript, scriptLog } from './run';

export const NEW_SCRIPT = `// @name My Script
// @description What this script does, in one line.
const doc = await studio.documents.active();
if (!doc) return studio.ui.alert('Open a document first.');

const layer = await doc.addLayer({ kind: 'text', text: 'Hello', size: 64, color: '#ff6600' });
console.log('Added', layer.name);
`;

const mod = isMac ? '⌘' : 'Ctrl+';
// The API at a glance (docs/scripting.md has the full reference).
const cheatSheet = `<details class="script-api"><summary>API at a glance</summary><dl>
<dt>studio.documents</dt><dd>active() · list() · get(id) · create({ width, height, name, background }) · open()</dd>
<dt>document</dt><dd>layers() · layer(idOrName) · selectedLayers() · selectLayers(list) · addLayer({ kind, name, … }) · composite() · selection() · select(shape, op) · selectAll() · deselect() · invertSelection() · run(commandId, arg) · export(options) · save() · close() · undo() · redo()</dd>
<dt>layer</dt><dd>set({ name, visible, opacity, blendMode, … }) · rename() · show() · hide() · move(dx, dy) · moveTo(x, y) · arrange(where) · duplicate() · remove() · pixels(rect) · setPixels(image, x, y) · getText() · setText(text) · setStyle(style) · export(options)</dd>
<dt>studio.ui</dt><dd>alert() · confirm() · prompt() · form(title, fields) · progress(fraction, message)</dd>
<dt>studio.files</dt><dd>open() · save(name, data) · saveAll(files, zipName)</dd>
<dt>studio</dt><dd>commands.run(id, arg) · commands.list() · history.checkpoint(label) · history.setGrouping(on) · image.create(w, h, fill) · image.encode(image, options) · checkCancelled() · sleep(ms)</dd>
</dl></details>`;

/** Edit an installed script, or start a new one (saving installs it). */
export function openScriptEditor(e: Editor, id?: string) {
  const record = id ? findScript(id) : undefined;
  let savedId = record?.id;
  let source = record?.source ?? NEW_SCRIPT;
  let saved = source;
  const dialog = document.createElement('dialog');
  dialog.className = 'files-dialog script-editor';
  dialog.setAttribute('aria-label', 'Script Editor');
  dialog.innerHTML = `<form method="dialog">
    <div class="script-editor-head"><h2>${record ? 'Edit Script' : 'New Script'}</h2><label class="script-name">Name<input name="name" value="${escapeXML(record?.name ?? scriptMetadata(source).name)}" autocomplete="off" title="Shown in File → Scripts and the Scripts panel"></label></div>
    <div class="code-editor" title="">
      <pre class="code-gutter" aria-hidden="true"></pre>
      <div class="code-area"><pre class="code-highlight" aria-hidden="true"></pre><textarea class="code-input" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off" aria-label="Script source" aria-describedby="script-tab-hint"></textarea><span id="script-tab-hint" class="sr-only">Tab indents. Press Escape, then Tab, to move on to the next control.</span></div>
    </div>
    ${cheatSheet}
    <div class="script-output" aria-live="polite" aria-label="Script output"></div>
    <div class="dialog-actions"><span class="script-editor-status muted"></span><button type="button" data-act="close" title="Close the editor">Close</button><button type="button" data-act="run" title="Run the text in the editor (${mod}Enter)">${svg('play', 13)} Run</button><button type="submit" class="primary" title="Save and keep the script in File → Scripts (${mod}S)">Save</button></div>
  </form>`;
  document.body.append(dialog);
  const input = dialog.querySelector<HTMLTextAreaElement>('.code-input')!;
  const view = dialog.querySelector<HTMLElement>('.code-highlight')!;
  const gutter = dialog.querySelector<HTMLElement>('.code-gutter')!;
  const status = dialog.querySelector<HTMLElement>('.script-editor-status')!;
  const nameField = dialog.querySelector<HTMLInputElement>('input[name="name"]')!;
  const output = dialog.querySelector<HTMLElement>('.script-output')!;
  input.value = source;
  const render = () => {
    source = input.value;
    // A trailing newline keeps the last line's height in the overlay.
    view.innerHTML = highlight(source) + '\n';
    const lines = source.split('\n').length;
    gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
    status.textContent = source === saved ? '' : 'Unsaved changes';
  };
  const sync = () => {
    view.scrollTop = input.scrollTop;
    view.scrollLeft = input.scrollLeft;
    gutter.scrollTop = input.scrollTop;
  };
  const showLog = () => {
    const name = nameField.value.trim();
    const lines = scriptLog.filter((l) => l.script === name).slice(-80);
    output.innerHTML = lines.length ? lines.map((l) => `<div class="log-${l.level}">${escapeXML(l.text)}</div>`).join('') : '<div class="muted">Output from console.log and errors appear here.</div>';
    output.scrollTop = output.scrollHeight;
  };
  let frame = 0;
  const stopLog = onScriptLog(() => {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      showLog();
    });
  });
  render();
  showLog();
  input.addEventListener('input', render);
  input.addEventListener('blur', () => {
    if (!tabLeaves) return;
    tabLeaves = false;
    status.textContent = source === saved ? '' : 'Unsaved changes';
  });
  input.addEventListener('scroll', sync);

  // Indentation: Tab and Shift+Tab indent lines, Enter keeps the indent.
  const replace = (from: number, to: number, text: string, select: [number, number]) => {
    input.setRangeText(text, from, to, 'end');
    input.setSelectionRange(...select);
    render();
  };
  // Tab indents, so Escape first lets the next Tab (or Shift+Tab) leave the
  // text, as keyboard users expect; Escape again closes the editor.
  let tabLeaves = false;
  input.addEventListener('keydown', (ev) => {
    const { selectionStart: a, selectionEnd: b, value } = input;
    const lineStart = value.lastIndexOf('\n', a - 1) + 1;
    if (ev.key === 'Escape' && !tabLeaves) {
      ev.preventDefault();
      tabLeaves = true;
      status.textContent = 'Tab moves to the next control; Escape again closes the editor.';
      return;
    }
    if (tabLeaves && !['Shift', 'Control', 'Alt', 'Meta'].includes(ev.key)) {
      tabLeaves = false;
      status.textContent = source === saved ? '' : 'Unsaved changes';
      if (ev.key === 'Tab') return;
    }
    if (ev.key === 'Tab') {
      ev.preventDefault();
      if (a === b && !ev.shiftKey) return replace(a, b, '  ', [a + 2, a + 2]);
      const end = value.indexOf('\n', b - (b > a && value[b - 1] === '\n' ? 1 : 0));
      const block = value.slice(lineStart, end < 0 ? value.length : end);
      const lines = block.split('\n');
      const next = lines.map((l) => (ev.shiftKey ? l.replace(/^ {1,2}/, '') : '  ' + l)).join('\n');
      const first = ev.shiftKey ? -(lines[0].length - lines[0].replace(/^ {1,2}/, '').length) : 2;
      return replace(lineStart, lineStart + block.length, next, [Math.max(lineStart, a + first), b + next.length - block.length]);
    }
    if (ev.key === 'Enter' && !ev.metaKey && !ev.ctrlKey) {
      ev.preventDefault();
      const indent = /^\s*/.exec(value.slice(lineStart, a))![0] + (/[{([]\s*$/.test(value.slice(lineStart, a)) ? '  ' : '');
      return replace(a, b, '\n' + indent, [a + 1 + indent.length, a + 1 + indent.length]);
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      ev.preventDefault();
      void run();
    } else if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      void save();
    }
  });

  const save = async () => {
    const name = nameField.value.trim() || scriptMetadata(source).name || 'Untitled Script';
    const description = scriptMetadata(source).description;
    // Text you wrote yourself does not need the first-run question.
    if (savedId && findScript(savedId)) await updateScript(savedId, { name, description, source, trusted: true });
    else {
      const r = newScriptRecord(source, name, { name, trusted: true });
      await saveScript(r);
      savedId = r.id;
    }
    saved = source;
    nameField.value = name;
    render();
    status.textContent = 'Saved';
    e.message(`Saved “${name}”.`);
  };
  const run = async () => {
    const name = nameField.value.trim() || 'Untitled Script';
    if (e.busy) return;
    dialog.close();
    await e.run(async () => void (await runScript(e, { id: savedId, name, source, trusted: true })));
    if (dialog.isConnected) dialog.showModal();
    showLog();
    input.focus();
  };
  const close = async () => {
    if (source !== saved && !(await askChoice('Discard Changes?', 'The script has changes that are not saved.', [['discard', 'Discard Changes']]))) return;
    stopLog();
    dialog.close();
    dialog.remove();
  };
  dialog.addEventListener('cancel', (ev) => {
    ev.preventDefault();
    void close();
  });
  dialog.querySelector('[data-act="close"]')!.addEventListener('click', () => void close());
  dialog.querySelector('[data-act="run"]')!.addEventListener('click', () => void run());
  dialog.querySelector('form')!.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void save();
  });
  dialog.showModal();
  input.setSelectionRange(0, 0);
  input.focus({ preventScroll: true });
  input.scrollTop = 0;
  sync();
}
