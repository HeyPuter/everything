/**
 * Script Editor (File > Scripts > Script Editor...): type or paste a
 * script, run it, keep it in the Scripts menu and download it as a .js
 * file; and the Scripting Reference dialog. Both are made for touch as
 * well as mouse and keyboard: every action is a full-size button.
 */
import { h } from '../../lib/dom.js';
import { openDialog } from '../../ui/dialogs/dialog.js';
import { downloadBlob } from '../io/deliver.js';
import { runScript, API_REFERENCE } from './runner.js';
import { BUILT_IN_SCRIPTS } from './built-ins.js';

export const RECENT_KEY = 'recentScripts';
const DRAFT_KEY = 'scriptDraft';
/** Scripts the menu remembers (newest first). */
const RECENT_LIMIT = 8;
/** Larger scripts are not kept in preferences. */
export const RECENT_MAX_SIZE = 64 * 1024;

const STARTER = `// Runs on the open document. See File > Scripts > Scripting Reference...
const shapes = await vs.objects({ type: 'path', fill: true, fields: ['name'] });
return 'This document has ' + shapes.length + ' filled paths.';
`;

/** Remember a script in the recent list (File > Scripts); false when too big. */
export function rememberScript(app, name, source) {
  if (source.length >= RECENT_MAX_SIZE) return false;
  const recent = (app.prefs.get(RECENT_KEY) || []).filter((r) => r.name !== name);
  app.prefs.set(RECENT_KEY, [{ name, source }, ...recent].slice(0, RECENT_LIMIT));
  return true;
}

/** "Line 3: x is not defined" for a failed run. */
export function errorText(result) {
  return result.line ? `Line ${result.line}: ${result.error}` : result.error;
}

/** Select line `n` (1-based) of a textarea. */
function selectLine(textarea, n) {
  const lines = textarea.value.split('\n');
  if (n < 1 || n > lines.length) return;
  let start = 0;
  for (let i = 0; i < n - 1; i++) start += lines[i].length + 1;
  textarea.focus();
  textarea.setSelectionRange(start, start + lines[n - 1].length);
}

/** The Script Editor dialog. Resolves when it closes. */
export function openScriptEditor(app, { name = '', source = null } = {}) {
  const draft = app.prefs.get(DRAFT_KEY) || {};
  const nameInput = h('input.script-editor-name', {
    type: 'text',
    value: name || draft.name || 'My Script',
    spellcheck: false,
    autocomplete: 'off',
    'aria-label': 'Script name',
  });
  const code = h('textarea.script-editor-code', {
    rows: 16,
    spellcheck: false,
    autocomplete: 'off',
    autocapitalize: 'off',
    autocorrect: 'off',
    wrap: 'off',
    'aria-label': 'Script',
  });
  code.value = source ?? draft.source ?? STARTER;
  const where = h('span.script-editor-pos', { 'aria-hidden': 'true' });
  const output = h('p.script-editor-output', { role: 'status', 'aria-live': 'polite' });
  const progress = h('progress.script-editor-progress', { max: 1, hidden: true });
  let controller = null;

  let draftTimer = 0;
  const saveDraft = () => {
    clearTimeout(draftTimer);
    app.prefs.set(DRAFT_KEY, { name: nameInput.value, source: code.value });
  };
  // Typing keeps the draft too, a moment after each pause.
  const saveSoon = () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 500);
  };
  const showPos = () => {
    const before = code.value.slice(0, code.selectionStart);
    const line = before.split('\n').length;
    where.textContent = `Line ${line}`;
  };
  code.addEventListener('input', () => {
    saveSoon();
    showPos();
  });
  code.addEventListener('keyup', showPos);
  code.addEventListener('click', showPos);
  nameInput.addEventListener('input', saveSoon);

  const say = (text, error = false) => {
    output.textContent = text;
    output.classList.toggle('error', error);
  };
  const scriptName = () => nameInput.value.trim().replace(/\.m?js$/i, '') || 'Script';

  const runBtn = h(
    'button.btn.primary',
    { type: 'button', onclick: () => (controller ? controller.abort() : run()) },
    'Run',
  );
  const run = async () => {
    if (!app.editor) {
      say('Open a document to run a script.', true);
      return;
    }
    controller = new AbortController();
    runBtn.textContent = 'Stop';
    runBtn.classList.remove('primary');
    runBtn.classList.add('danger');
    progress.hidden = false;
    progress.removeAttribute('value');
    say('Running...');
    const r = await runScript(app, code.value, {
      name: scriptName(),
      signal: controller.signal,
      onProgress: (value, message) => {
        if (value == null) progress.removeAttribute('value');
        else progress.value = value;
        say(message ? `Running: ${message}` : 'Running...');
      },
    });
    controller = null;
    runBtn.textContent = 'Run';
    runBtn.classList.add('primary');
    runBtn.classList.remove('danger');
    progress.hidden = true;
    if (r.ok) say(r.value ? String(r.value) : r.changes ? 'Done.' : 'Finished without changes.');
    else {
      say(
        r.stopped ? 'Stopped. Edit > Undo takes back what it changed.' : errorText(r),
        !r.stopped,
      );
      if (r.line) selectLine(code, r.line);
    }
  };
  const save = () => {
    const n = scriptName();
    if (rememberScript(app, n, code.value)) say(`Saved "${n}" to File > Scripts.`);
    else say('This script is too big to keep in the Scripts menu. Download it instead.', true);
  };
  const download = () => {
    downloadBlob(new Blob([code.value], { type: 'text/javascript' }), `${scriptName()}.js`);
    say(`Downloaded ${scriptName()}.js.`);
  };
  const openFile = () =>
    pickScriptFile((file, text) => {
      nameInput.value = file.name.replace(/\.m?js$/i, '');
      code.value = text;
      saveDraft();
      say(`Opened ${file.name}.`);
    });
  // Built-in and saved scripts open as a starting point.
  const examples = [
    ...BUILT_IN_SCRIPTS.map((s) => ({ name: s.name, source: s.source.replace(/^\n/, '') })),
    ...(app.prefs.get(RECENT_KEY) || []),
  ];
  const picker = h(
    'select.script-editor-open',
    {
      'aria-label': 'Open a built-in or saved script',
      onchange: () => {
        const ex = examples[Number(picker.value)];
        picker.value = '';
        if (!ex) return;
        nameInput.value = ex.name.replace(/\.m?js$/i, '');
        code.value = ex.source;
        saveDraft();
        say(`Opened "${ex.name}".`);
      },
    },
    h('option', { value: '' }, 'Open script...'),
    examples.map((ex, i) => h('option', { value: String(i) }, ex.name)),
  );

  const body = h(
    'div.script-editor',
    h('div.script-editor-row', h('label.script-editor-label', 'Name', nameInput), picker),
    code,
    h('div.script-editor-status', progress, output, where),
    h(
      'div.script-editor-actions',
      runBtn,
      h('button.btn', { type: 'button', onclick: save }, 'Save to Menu'),
      h('button.btn', { type: 'button', onclick: download }, 'Download .js'),
      h('button.btn', { type: 'button', onclick: openFile }, 'Open File...'),
      h('button.btn', { type: 'button', onclick: () => openScriptReference() }, 'Reference'),
    ),
  );
  showPos();
  return openDialog({
    title: 'Script Editor',
    className: 'wide script-editor-dialog',
    body,
    buttons: [{ label: 'Close', value: true }],
    initialFocus: () => code,
    onClose: () => {
      controller?.abort();
      saveDraft();
    },
  });
}

/** Pick a .js file from the device: onFile(file, text). */
export function pickScriptFile(onFile) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.js,.mjs,text/javascript,application/javascript';
  input.hidden = true;
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (file) onFile(file, await file.text());
  });
  document.body.append(input);
  input.click();
}

/** The Scripting Reference dialog: every `vs` call with what it does. */
export function openScriptReference() {
  const sections = API_REFERENCE.map((sec) =>
    h(
      'section.script-ref-section',
      h('h3.script-ref-title', sec.title),
      h(
        'dl.script-ref-list',
        sec.items.map(([sig, text]) => [h('dt', h('code', sig)), h('dd', text)]),
      ),
    ),
  );
  const intro = h(
    'p.script-ref-intro',
    'Scripts are JavaScript that run in a sandbox and change the open document only through the vs calls below. Use await with them; return a message to show it when the script ends. All the changes of one run undo as one step. Coordinates and lengths are in points (vs.doc.pointsPerUnit converts to the document units).',
  );
  const example = h(
    'pre.script-ref-example',
    h(
      'code',
      [
        '// Number every red shape at its label point',
        "const reds = await vs.objects({ type: ['path', 'compound'], fill: '#ff0000', fields: [] });",
        'const spots = await vs.labelPoint(reds.map((n) => n.id));',
        'await vs.createMany(spots.filter(Boolean).map((p) => ({',
        "  type: 'text', text: '1', x: p.x, y: p.y, char: { fontSize: Math.max(4, p.radius) },",
        '})));',
        "return 'Numbered ' + reds.length + ' shapes.';",
      ].join('\n'),
    ),
  );
  return openDialog({
    title: 'Scripting Reference',
    className: 'wide script-ref-dialog',
    body: h('div.script-ref', intro, example, sections),
    buttons: [{ label: 'Close', value: true, primary: true }],
  });
}
