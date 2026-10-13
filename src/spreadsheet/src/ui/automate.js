/**
 * The Automate tab's working parts: the Code Editor pane beside the sheet (the workbook's scripts, a code editor,
 * Run and Stop, and the output), running scripts (asking first about one that came inside a file), recording
 * actions into a new script, and the All Scripts gallery. The editor view hands its Automate commands to run().
 *
 * While a script runs the sheet waits: the grid takes no input and other commands are refused until it ends, so
 * everything that changes in the meantime is the script's own, and one Undo takes it all back.
 */
import { el, isComposing, MOD_KEY } from './dom.js';
import { icon } from './icons.js';
import { openMenu } from './menu.js';
import { openModal, confirmDialog, promptDialog } from './modal.js';
import { toast } from './toast.js';
import { createCodeEditor } from './code-editor.js';
import { openScriptGallery, openScriptReference } from './script-gallery.js';
import { addScript, updateScript, deleteScript, duplicateScript, scriptById, scriptByName, scriptNameProblem, uniqueScriptName, scriptFingerprint, sampleById, NEW_SCRIPT_CODE } from '../core/scripts.js';
import { runScript } from '../core/script-run.js';
import { startRecorder } from '../core/script-recorder.js';
import { sandboxTransport } from '../lib/script-sandbox.js';
import * as Library from '../lib/script-library.js';

const WIDTH_KEY = 'spreadsheet:scripts-pane-width';
const OUTPUT_KEY = 'spreadsheet:scripts-output-height';
const SAVE_DELAY = 500;
const MAX_LOG_ENTRIES = 2000;

/** The commands this module answers. */
export const AUTOMATE_COMMANDS = new Set(['scriptsPane', 'newScript', 'recordActions', 'stopRecording', 'scriptGallery', 'runScript', 'stopScript', 'scriptReference', 'openScript', 'insertScriptButton']);

/** The link a script button carries: a place in the workbook that names the script it runs. */
export const SCRIPT_LINK = '#script:';
export const scriptLink = (name) => `${SCRIPT_LINK}${encodeURIComponent(name)}`;
export const scriptOfLink = (url) => (typeof url === 'string' && url.startsWith(SCRIPT_LINK) ? decodeURIComponent(url.slice(SCRIPT_LINK.length)) : null);

/**
 * A button on the sheet that runs a script: a text box styled as a button, linked to the script by name, so a click
 * runs it (Shift+click selects it to move, resize or delete) and it travels in any file a text box and its link do.
 */
export function addScriptButton(wb, sheetId, anchor, name) {
  const w = Math.min(260, Math.max(120, Math.round(name.length * 8.5) + 40));
  return wb.addChart(sheetId, {
    type: 'text', text: name, anchor: { r: anchor.r, c: anchor.c }, dx: 4, dy: 4, w, h: 40,
    style: { size: 13, bold: true, color: '#ffffff', bg: '#356d49', align: 'center', valign: 'middle', border: false },
    hyperlink: scriptLink(name), hyperlinkTooltip: `Run the script “${name}”`, description: `Button that runs the script ${name}`,
  });
}

/**
 * ctx: the editor context (wb, grid, subscribe, run). options: { env() → ScriptHost env, notify(), transport,
 * library (lib/script-library.js or null), keepFocus(), busy(on): hold the sheet still while a script runs }.
 */
export function createAutomate(ctx, { env = () => ({}), notify = () => {}, transport = null, library = Library, keepFocus = () => ctx.grid?.focus?.(),
  busy = (on) => { if (ctx.grid?.el) ctx.grid.el.inert = on; } } = {}) {
  const { wb } = ctx;
  const runTransport = transport || sandboxTransport();
  let openId = null; // the workbook script in the editor
  let saveTimer = null;
  let running = null; // { controller, name }
  let recorder = null;
  const authored = new Set(); // fingerprints of code the user wrote or chose in this session

  /* ---------- The pane ---------- */

  const editor = createCodeEditor({
    label: 'Script code',
    onChange: (text) => { scheduleSave(text); },
    onRun: () => runOpen(),
    // Ctrl/Cmd+S in the code saves the workbook, the script with it.
    onSave: () => { flushSave(); ctx.run?.('save'); },
  });
  const pickerLabel = el('span.sp-picker-name');
  const picker = el('button.sp-picker', { type: 'button', 'aria-haspopup': 'menu', 'aria-label': 'Choose a script', onclick: () => openPicker() },
    el('span.sp-picker-icon', { html: icon('scriptFile', 16) }), pickerLabel, el('span.sp-picker-chev', { html: icon('chevD', 14) }));
  const more = el('button.icon-btn.sp-more', { type: 'button', 'aria-label': 'More script actions', 'aria-haspopup': 'menu', title: 'More', html: icon('more', 18), onclick: () => openMore() });
  const runButton = el('button.btn.btn-primary.btn-sm.sp-run', { type: 'button', title: `Run (${MOD_KEY}+Enter)`, 'aria-keyshortcuts': 'Control+Enter Meta+Enter', onclick: () => runOpen() },
    el('span', { html: icon('runScript', 16) }), el('span', {}, 'Run'));
  const stopButton = el('button.btn.btn-sm.sp-stop', { type: 'button', hidden: true, onclick: () => stopRun() }, el('span', { html: icon('stopScript', 16) }), el('span', {}, 'Stop'));
  const status = el('span.sp-status', { role: 'status', 'aria-live': 'polite' });
  const output = el('div.sp-output', { role: 'log', 'aria-label': 'Script output', tabindex: 0 });
  const outputCount = el('span.sp-output-count');
  const clearOutput = el('button.icon-btn', { type: 'button', 'aria-label': 'Clear output', title: 'Clear output', html: icon('eraser', 15), onclick: () => { output.replaceChildren(); outputCount.textContent = ''; } });
  const outputSplit = el('div.sp-split', { role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Resize output', tabindex: 0 });
  const outputBox = el('div.sp-output-box', {}, el('div.sp-output-head', {}, el('span.sp-output-title', {}, 'Output'), outputCount, clearOutput), output);
  const empty = el('div.sp-empty', { hidden: true },
    el('span.sp-empty-icon', { html: icon('codeEditor', 40) }),
    el('p.sp-empty-title', {}, 'No scripts in this workbook yet'),
    el('p.sp-empty-text', {}, 'Write a script, record what you do, or start from a sample. Scripts are saved with the workbook.'),
    el('div.sp-empty-actions', {},
      el('button.btn.btn-primary.btn-sm', { type: 'button', onclick: () => newScript() }, 'New Script'),
      el('button.btn.btn-sm', { type: 'button', onclick: () => toggleRecording() }, 'Record Actions'),
      el('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => gallery() }, 'Browse Samples')));
  const work = el('div.sp-work', {},
    el('div.sp-bar', {}, picker, more),
    el('div.sp-actions', {}, runButton, stopButton, status),
    el('div.sp-code', {}, editor.el));
  const resizer = el('div.sp-resize', { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize Code Editor', tabindex: 0 });
  const pane = el('section.scripts-pane', { role: 'region', 'aria-label': 'Code Editor', hidden: true },
    resizer,
    el('div.sp-head', {},
      el('h2.sp-title', {}, 'Code Editor'),
      el('button.icon-btn', { type: 'button', 'aria-label': 'New script', title: 'New script', html: icon('plus', 18), onclick: () => newScript() }),
      el('button.icon-btn', { type: 'button', 'aria-label': 'All scripts', title: 'All scripts', html: icon('allScripts', 18), onclick: () => gallery() }),
      el('button.icon-btn', { type: 'button', 'aria-label': 'Script reference', title: 'Script reference', html: icon('scriptReference', 18), onclick: () => openScriptReference() }),
      el('button.icon-btn', { type: 'button', 'aria-label': 'Close Code Editor', title: 'Close', html: icon('x', 18), onclick: () => hidePane() })),
    work, empty, outputSplit, outputBox);

  // Widths and heights the user chose, kept for next time.
  const stored = (key, fallback) => { try { const v = Number(localStorage.getItem(key)); return v > 0 ? v : fallback; } catch { return fallback; } };
  const keep = (key, v) => { try { localStorage.setItem(key, String(Math.round(v))); } catch { /* optional */ } };
  let width = stored(WIDTH_KEY, 440);
  let outputHeight = stored(OUTPUT_KEY, 150);
  const applySizes = () => {
    pane.style.width = `${Math.max(320, Math.min(width, Math.max(320, window.innerWidth * 0.7)))}px`;
    outputBox.style.height = `${Math.max(60, Math.min(outputHeight, 600))}px`;
  };
  applySizes();
  const drag = (handle, onMove, onEnd) => handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture?.(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, width, outputHeight };
    const move = (ev) => { onMove(ev, start); applySizes(); };
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); onEnd(); };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  drag(resizer, (ev, start) => { width = start.width + (start.x - ev.clientX); }, () => keep(WIDTH_KEY, width));
  drag(outputSplit, (ev, start) => { outputHeight = start.outputHeight + (start.y - ev.clientY); }, () => keep(OUTPUT_KEY, outputHeight));
  resizer.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault(); width += e.key === 'ArrowLeft' ? 24 : -24; applySizes(); keep(WIDTH_KEY, width);
  });
  outputSplit.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault(); outputHeight += e.key === 'ArrowUp' ? 20 : -20; applySizes(); keep(OUTPUT_KEY, outputHeight);
  });
  pane.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !isComposing(e) && !e.defaultPrevented && e.target !== editor.textarea) { e.preventDefault(); hidePane(); }
  });

  function showPane({ focus = true } = {}) {
    pane.hidden = false;
    if (!openId || !scriptById(wb, openId)) openId = wb.scripts?.[0]?.id || null;
    renderPane(true);
    notify();
    if (focus) (openId ? editor : empty.querySelector('button'))?.focus();
  }
  function hidePane() {
    flushSave();
    pane.hidden = true;
    notify();
    keepFocus();
  }

  /** The pane as the workbook now has it; `reload` puts the open script's code back in the editor. */
  function renderPane(reload = false) {
    const script = openId ? scriptById(wb, openId) : null;
    if (openId && !script) { openId = wb.scripts?.[0]?.id || null; reload = true; }
    const current = openId ? scriptById(wb, openId) : null;
    work.hidden = !current;
    empty.hidden = !!current;
    // Without a script of the workbook's open, the output still shows what a sample or one of My Scripts said.
    outputBox.hidden = outputSplit.hidden = !current && !output.childElementCount;
    pickerLabel.textContent = current?.name || 'No script';
    if (current && (reload || (editor.getValue() !== current.code && !saveTimer))) editor.setValue(current.code);
    runButton.disabled = !!running || !current;
    more.disabled = !current;
  }

  function scheduleSave(text) {
    clearTimeout(saveTimer);
    const id = openId;
    authored.add(scriptFingerprint(text));
    saveTimer = setTimeout(() => { saveTimer = null; if (id && scriptById(wb, id)) updateScript(wb, id, { code: text }); }, SAVE_DELAY);
  }
  function flushSave() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    if (openId && scriptById(wb, openId)) updateScript(wb, openId, { code: editor.getValue() });
  }

  function openScript(id, { focus = true } = {}) {
    flushSave();
    if (!scriptById(wb, id)) return;
    openId = id;
    if (pane.hidden) showPane({ focus });
    else { renderPane(true); if (focus) editor.focus(); }
  }

  function openPicker() {
    flushSave();
    const items = (wb.scripts || []).map((s) => ({ label: s.name, radio: true, checked: s.id === openId, onSelect: () => openScript(s.id) }));
    openMenu({ anchor: picker, label: 'Scripts', minWidth: 240, items: [
      ...(items.length ? items : [{ label: 'No scripts yet', disabled: true }]),
      { separator: true },
      { label: 'New Script', icon: 'plus', onSelect: () => newScript() },
      { label: 'All Scripts…', icon: 'allScripts', onSelect: () => gallery() },
    ] });
  }

  function openMore() {
    const s = scriptById(wb, openId);
    if (!s) return;
    openMenu({ anchor: more, label: 'Script actions', minWidth: 220, items: [
      { label: 'Rename…', icon: 'pencil', onSelect: () => renameScript(s.id) },
      { label: 'Duplicate', icon: 'duplicate', onSelect: () => { flushSave(); const copy = duplicateScript(wb, s.id); if (copy) { authored.add(scriptFingerprint(copy.code)); openScript(copy.id); } } },
      { label: 'Delete…', icon: 'trash', onSelect: () => removeScript(s.id) },
      { separator: true },
      library && { label: 'Save to My Scripts', icon: 'scriptLibrary', onSelect: () => saveToLibrary(s.id) },
      { label: 'Download as .js', icon: 'download', onSelect: () => { flushSave(); const blob = new Blob([scriptById(wb, s.id).code], { type: 'text/javascript' }); const a = el('a', { href: URL.createObjectURL(blob), download: `${s.name}.js` }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); } },
      { separator: true },
      { label: 'Find and Replace', icon: 'find', shortcut: `${MOD_KEY}+F`, onSelect: () => editor.openFind(true) },
      { label: 'Script Reference', icon: 'scriptReference', onSelect: () => openScriptReference() },
    ].filter(Boolean) });
  }

  async function renameScript(id) {
    flushSave();
    const s = scriptById(wb, id);
    if (!s) return;
    const name = await promptDialog({ title: 'Rename Script', label: 'Name', value: s.name, confirmLabel: 'Rename', validate: (v) => scriptNameProblem(wb, v, id) });
    if (name && name !== s.name) updateScript(wb, id, { name });
    renderPane();
  }
  async function removeScript(id) {
    flushSave();
    const s = scriptById(wb, id);
    if (!s) return;
    if (!await confirmDialog({ title: 'Delete Script', message: `Delete “${s.name}” from this workbook?`, confirmLabel: 'Delete' })) return;
    deleteScript(wb, id);
    if (openId === id) openId = wb.scripts?.[0]?.id || null;
    renderPane(true);
    toast(`Deleted ${s.name}`, { icon: 'trash' });
  }
  async function saveToLibrary(id) {
    flushSave();
    const s = scriptById(wb, id);
    if (!s || !library) return;
    try {
      await library.saveToLibrary(s.name, s.code);
      toast(`Saved “${s.name}” to My Scripts`, { icon: 'check' });
    } catch (e) {
      toast(`Could not save to My Scripts: ${e?.message || e}`, { icon: 'alert' });
    }
  }

  function newScript({ name = 'Script', code = NEW_SCRIPT_CODE, description = '' } = {}) {
    flushSave();
    const s = addScript(wb, { name, code, description });
    if (!s) { toast('This workbook holds as many scripts as it can', { icon: 'alert' }); return null; }
    authored.add(scriptFingerprint(code));
    openScript(s.id);
    return s;
  }

  function gallery() {
    flushSave();
    openScriptGallery(wb, {
      open: (id) => openScript(id),
      run: (script) => runCode(script),
      add: (script) => { const s = newScript(script); if (s) toast(`Added “${s.name}” to this workbook`); },
      newScript: () => newScript(),
      record: () => toggleRecording(true),
      library: library && { list: () => library.listLibrary(), read: (path) => library.readLibraryScript(path), remove: (path) => library.deleteFromLibrary(path) },
    });
  }

  /* ---------- Output ---------- */

  function log({ level = 'log', text = '', line = 0, quiet = false, linkable = true }) {
    while (output.childElementCount >= MAX_LOG_ENTRIES) output.firstElementChild.remove();
    const glyph = level === 'error' ? 'alert' : level === 'warn' ? 'alert' : level === 'info' ? 'info' : quiet ? 'check' : 'chevR';
    const entry = el(`div.sp-log.sp-log-${level}${quiet ? '.sp-log-quiet' : ''}`, {},
      el('span.sp-log-icon', { html: icon(glyph, 13) }),
      el('span.sp-log-text', {}, text),
      // A line of the script in the editor is a link to it; of another (a sample, one of My Scripts), just its number.
      line && linkable ? el('button.sp-log-line', { type: 'button', title: `Go to line ${line}`, onclick: () => { if (pane.hidden) showPane(); editor.goToLine(line); } }, `Line ${line}`)
        : line ? el('span.sp-log-line.sp-log-line-plain', {}, `Line ${line}`) : null);
    output.append(entry);
    outputBox.hidden = outputSplit.hidden = false;
    outputCount.textContent = `${output.childElementCount}`;
    output.scrollTop = output.scrollHeight;
  }

  /* ---------- Running ---------- */

  /**
   * Whether the user stands behind this code: written or chosen here, or trusted before. A script that came inside
   * a file is shown for what it is and runs only on a yes.
   */
  async function allowed({ name, code, source }) {
    if (source === 'sample' || source === 'library' || source === 'recorded') return true;
    const fingerprint = scriptFingerprint(code);
    if (authored.has(fingerprint)) { library?.trustScript?.(code); return true; }
    if (await library?.isScriptTrusted?.(code)) return true;
    const answer = await new Promise((resolve) => {
      const content = el('div.sp-trust', {},
        el('p.modal-text', {}, `“${name}” came with this workbook and has not been run on your account before. It can change anything in the workbook, but it runs apart from the app and cannot reach your files, your account or the internet.`),
        el('p.sp-trust-hint', {}, 'Run it only if you trust where the workbook came from. You can read its code first.'),
        el('div.row.row-end', {},
          el('button.btn.btn-ghost', { type: 'button', onclick: () => { resolve('review'); modal.close(); } }, 'Review Code'),
          el('button.btn.btn-ghost', { type: 'button', onclick: () => { resolve(false); modal.close(); } }, 'Cancel'),
          el('button.btn.btn-primary', { type: 'button', onclick: () => { resolve(true); modal.close(); } }, 'Run Script')));
      const modal = openModal({ title: 'Run a Script From This File?', content, onClose: () => resolve(false) });
    });
    if (answer === 'review') return 'review';
    if (answer) { authored.add(fingerprint); await library?.trustScript?.(code); }
    return !!answer;
  }

  /** Run a script: { name, code, source: 'workbook' | 'library' | 'sample' | 'recorded', id }. */
  async function runCode(script) {
    if (running) { toast('A script is already running', { icon: 'info' }); return null; }
    if (recorder) { toast('Stop recording before running a script', { icon: 'info' }); return null; }
    if (ctx.grid?.editing && !ctx.grid.commitEdit?.()) return null;
    const ok = await allowed(script);
    if (ok === 'review') { if (script.id) openScript(script.id); return null; }
    if (!ok) return null;
    const controller = new AbortController();
    running = { controller, name: script.name };
    const started = performance.now();
    const visible = !pane.hidden;
    output.replaceChildren();
    outputCount.textContent = '';
    log({ level: 'info', text: `Running “${script.name}”…`, quiet: true });
    status.textContent = 'Running…';
    runButton.disabled = true;
    stopButton.hidden = false;
    editor.setErrorLine(null);
    editor.setReadOnly(true);
    busy(true);
    pane.classList.add('sp-running');
    notify();
    let lastLog = null;
    let result;
    try {
      result = await runScript({
        wb, code: script.code, transport: runTransport, env: env(), label: `Run script: ${script.name}`, signal: controller.signal,
        onLog: (entry) => { if (entry.clear) { output.replaceChildren(); return; } lastLog = entry; log({ ...entry, linkable: !!script.id && script.id === openId }); },
      });
    } finally {
      running = null;
      busy(false);
      editor.setReadOnly(false);
      pane.classList.remove('sp-running');
      stopButton.hidden = true;
      runButton.disabled = false;
      renderPane();
      notify();
    }
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    if (result.ok) {
      status.textContent = `Finished in ${seconds} s`;
      log({ level: 'info', text: `Finished in ${seconds} s.${result.changed ? ' Undo takes back everything it changed.' : ''}`, quiet: true });
    } else {
      const where = result.error.line ? ` (line ${result.error.line})` : '';
      status.textContent = result.stopped ? 'Stopped' : result.timedOut ? 'Timed out' : `Failed${where}`;
      log({ level: 'error', text: result.error.message, line: result.error.line, linkable: !!script.id && script.id === openId });
      if (script.id && script.id === openId && result.error.line) editor.setErrorLine(result.error.line);
    }
    if (!visible) {
      // Run from the ribbon or the gallery with the pane closed: the outcome as a notice, the output a click away.
      const text = result.ok ? `Ran “${script.name}”${lastLog ? `: ${lastLog.text}` : ''}` : `“${script.name}” failed${result.error.line ? ` at line ${result.error.line}` : ''}: ${result.error.message}`;
      toast(text.length > 160 ? `${text.slice(0, 157)}…` : text, { icon: result.ok ? 'check' : 'alert', action: { label: 'Show Output', onClick: () => { showPane({ focus: false }); output.focus(); } } });
      keepFocus();
    }
    return result;
  }

  function runOpen() {
    flushSave();
    const s = scriptById(wb, openId);
    if (s) runCode({ name: s.name, code: s.code, source: 'workbook', id: s.id });
  }
  function stopRun() { running?.controller.abort(); }

  /* ---------- Recording ---------- */

  const recCount = el('span.rec-count');
  const recordBar = el('div.notice-bar.rec-bar', { role: 'status', hidden: true },
    el('span.rec-dot', { 'aria-hidden': 'true' }),
    el('span.notice-text', {}, el('strong', {}, 'Recording actions. '), 'Your edits are being written as a script. ', recCount),
    el('span.notice-actions', {},
      el('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => stopRecording(false) }, 'Discard'),
      el('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => stopRecording(true) }, 'Stop Recording')));

  function toggleRecording(on = !recorder) {
    if (on && !recorder) {
      if (running) { toast('Wait for the script to finish', { icon: 'info' }); return; }
      if (ctx.grid?.editing && !ctx.grid.commitEdit?.()) return;
      recorder = startRecorder(wb, { startSheet: ctx.sheetId?.() ?? wb.activeSheetId, name: 'Recorded actions' });
      const update = () => { const n = recorder?.count() || 0; recCount.textContent = `${n} step${n === 1 ? '' : 's'} so far.`; };
      recorder.onChange(update);
      update();
      recordBar.hidden = false;
      ctx.announce?.('Recording actions');
      notify();
      keepFocus();
    } else if (!on && recorder) stopRecording(true);
  }

  function stopRecording(save) {
    if (!recorder) return;
    const steps = recorder.count();
    const code = recorder.stop();
    recorder = null;
    recordBar.hidden = true;
    notify();
    if (!save) { toast('Recording discarded', { icon: 'info' }); keepFocus(); return; }
    if (!steps) { toast('Nothing was recorded', { icon: 'info' }); keepFocus(); return; }
    const s = newScript({ name: uniqueScriptName(wb, 'Recorded script'), code, description: `${steps} recorded step${steps === 1 ? '' : 's'}.` });
    if (s) toast(`Recorded ${steps} step${steps === 1 ? '' : 's'} as “${s.name}”`);
  }

  /* ---------- Commands ---------- */

  async function run(cmd, arg) {
    switch (cmd) {
      case 'scriptsPane':
        if (arg === false || (arg == null && !pane.hidden)) hidePane(); else showPane();
        return;
      case 'newScript': newScript(); return;
      case 'openScript': if (arg) openScript(arg); else showPane(); return;
      case 'recordActions': toggleRecording(typeof arg === 'boolean' ? arg : undefined); return;
      case 'stopRecording': stopRecording(arg !== false); return;
      case 'scriptGallery': gallery(); return;
      case 'scriptReference': openScriptReference(); return;
      case 'stopScript': stopRun(); return;
      case 'insertScriptButton': {
        const s = scriptById(wb, arg?.id);
        const sheetId = ctx.sheetId?.() ?? wb.activeSheetId;
        if (!s || wb.sheet(sheetId)?.kind === 'chart') return;
        if (ctx.grid?.editing && !ctx.grid.commitEdit?.()) return;
        const id = addScriptButton(wb, sheetId, ctx.active?.() || { r: 0, c: 0 }, s.name);
        // Left unselected, so it reads as the button it is; Shift+click selects it to move or resize.
        if (id) toast(`Added a button for “${s.name}”. Click it to run the script; Shift+click selects it`);
        else toast('A button cannot be added here: the sheet is protected', { icon: 'alert' });
        return;
      }
      case 'runScript': {
        if (arg?.sample) { const s = sampleById(arg.sample); if (s) await runCode({ name: s.name, code: s.code, source: 'sample' }); return; }
        if (arg?.path && library) { const code = await library.readLibraryScript(arg.path); await runCode({ name: arg.name || 'Script', code, source: 'library' }); return; }
        if (arg?.name != null) {
          // A script button names its script; a renamed or deleted script leaves the button with nothing to run.
          const named = scriptByName(wb, arg.name);
          if (named) await runCode({ name: named.name, code: named.code, source: 'workbook', id: named.id });
          else toast(`This button runs “${arg.name}”, which is not in this workbook any more`, { icon: 'alert' });
          return;
        }
        const s = scriptById(wb, arg?.id ?? openId) || (wb.scripts?.length === 1 ? wb.scripts[0] : null);
        if (s) await runCode({ name: s.name, code: s.code, source: 'workbook', id: s.id });
        else gallery();
        return;
      }
      default:
    }
  }

  // A script edited elsewhere (the gallery, a restored draft that replaced the whole book) shows here as it now is.
  const onChange = (e) => {
    if (pane.hidden) return;
    if (e.detail?.type === 'load') { clearTimeout(saveTimer); saveTimer = null; renderPane(true); } else if (e.detail?.type === 'scripts') renderPane();
  };
  wb.addEventListener('change', onChange);

  return {
    pane,
    notice: recordBar,
    run,
    get paneOpen() { return !pane.hidden; },
    get recording() { return !!recorder; },
    get running() { return !!running; },
    /** The workbook's scripts and My Scripts, for the ribbon's Run Script menu. */
    menuItems() {
      const list = (wb.scripts || []).map((s) => ({ label: s.name, icon: 'scriptFile', cmd: 'runScript', arg: { id: s.id } }));
      return list.length ? list : [{ label: 'No scripts in this workbook', disabled: true }];
    },
    /** The scripts a button can be added for, for the ribbon's Script Button menu. */
    buttonItems() {
      const list = (wb.scripts || []).map((s) => ({ label: s.name, icon: 'scriptButton', cmd: 'insertScriptButton', arg: { id: s.id } }));
      return list.length ? [{ header: 'Add a button that runs' }, ...list] : [{ label: 'No scripts in this workbook to run', disabled: true }];
    },
    destroy() {
      flushSave();
      running?.controller.abort();
      recorder?.stop();
      recorder = null;
      wb.removeEventListener('change', onChange);
      editor.destroy();
      pane.remove();
      recordBar.remove();
    },
  };
}
