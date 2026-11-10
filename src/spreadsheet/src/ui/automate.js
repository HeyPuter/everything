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
import { addScript, updateScript, deleteScript, duplicateScript, scriptById, scriptByName, scriptNameProblem, uniqueScriptName, scriptFingerprint, sampleById, sampleName, NEW_SCRIPT_CODE } from '../core/scripts.js';
import { runScript } from '../core/script-run.js';
import { startRecorder } from '../core/script-recorder.js';
import { sandboxTransport } from '../lib/script-sandbox.js';
import * as Library from '../lib/script-library.js';
import { t, tRich, formatNumber } from '../i18n/index.js';

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
    label: t('automate.scriptCode'),
    onChange: (text) => { scheduleSave(text); },
    onRun: () => runOpen(),
    // Ctrl/Cmd+S in the code saves the workbook, the script with it.
    onSave: () => { flushSave(); ctx.run?.('save'); },
  });
  const pickerLabel = el('span.sp-picker-name');
  const picker = el('button.sp-picker', { type: 'button', 'aria-haspopup': 'menu', 'aria-label': t('automate.chooseScript'), onclick: () => openPicker() },
    el('span.sp-picker-icon', { html: icon('scriptFile', 16) }), pickerLabel, el('span.sp-picker-chev', { html: icon('chevD', 14) }));
  const more = el('button.icon-btn.sp-more', { type: 'button', 'aria-label': t('automate.moreScriptActions'), 'aria-haspopup': 'menu', title: t('automate.more'), html: icon('more', 18), onclick: () => openMore() });
  const runButton = el('button.btn.btn-primary.btn-sm.sp-run', { type: 'button', title: t('automate.runShortcut', { mod: MOD_KEY }), 'aria-keyshortcuts': 'Control+Enter Meta+Enter', onclick: () => runOpen() },
    el('span', { html: icon('runScript', 16) }), el('span', {}, t('automate.run')));
  const stopButton = el('button.btn.btn-sm.sp-stop', { type: 'button', hidden: true, onclick: () => stopRun() }, el('span', { html: icon('stopScript', 16) }), el('span', {}, t('automate.stop')));
  const status = el('span.sp-status', { role: 'status', 'aria-live': 'polite' });
  const output = el('div.sp-output', { role: 'log', 'aria-label': t('automate.output.label'), tabindex: 0 });
  const outputCount = el('span.sp-output-count');
  const clearOutput = el('button.icon-btn', { type: 'button', 'aria-label': t('automate.output.clear'), title: t('automate.output.clear'), html: icon('eraser', 15), onclick: () => { output.replaceChildren(); outputCount.textContent = ''; } });
  const outputSplit = el('div.sp-split', { role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': t('automate.output.resize'), tabindex: 0, 'aria-valuemin': 60, 'aria-valuemax': 600 });
  const outputBox = el('div.sp-output-box', {}, el('div.sp-output-head', {}, el('span.sp-output-title', {}, t('automate.output.title')), outputCount, clearOutput), output);
  const empty = el('div.sp-empty', { hidden: true },
    el('span.sp-empty-icon', { html: icon('codeEditor', 40) }),
    el('p.sp-empty-title', {}, t('automate.empty.title')),
    el('p.sp-empty-text', {}, t('automate.empty.text')),
    el('div.sp-empty-actions', {},
      el('button.btn.btn-primary.btn-sm', { type: 'button', onclick: () => newScript() }, t('automate.newScript')),
      el('button.btn.btn-sm', { type: 'button', onclick: () => toggleRecording() }, t('automate.recordActions')),
      el('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => gallery() }, t('automate.browseSamples'))));
  const work = el('div.sp-work', {},
    el('div.sp-bar', {}, picker, more),
    el('div.sp-actions', {}, runButton, stopButton, status),
    el('div.sp-code', {}, editor.el));
  const resizer = el('div.sp-resize', { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': t('automate.resizePane'), tabindex: 0, 'aria-valuemin': 320 });
  const pane = el('section.scripts-pane', { role: 'region', 'aria-label': t('automate.codeEditor'), hidden: true },
    resizer,
    el('div.sp-head', {},
      el('h2.sp-title', {}, t('automate.codeEditor')),
      el('button.icon-btn', { type: 'button', 'aria-label': t('automate.newScriptLower'), title: t('automate.newScriptLower'), html: icon('plus', 18), onclick: () => newScript() }),
      el('button.icon-btn', { type: 'button', 'aria-label': t('automate.allScriptsLower'), title: t('automate.allScriptsLower'), html: icon('allScripts', 18), onclick: () => gallery() }),
      el('button.icon-btn', { type: 'button', 'aria-label': t('automate.scriptReferenceLower'), title: t('automate.scriptReferenceLower'), html: icon('scriptReference', 18), onclick: () => openScriptReference() }),
      el('button.icon-btn', { type: 'button', 'aria-label': t('automate.closePane'), title: t('common.close'), html: icon('x', 18), onclick: () => hidePane() })),
    work, empty, outputSplit, outputBox);

  // Widths and heights the user chose, kept for next time.
  const stored = (key, fallback) => { try { const v = Number(localStorage.getItem(key)); return v > 0 ? v : fallback; } catch { return fallback; } };
  const keep = (key, v) => { try { localStorage.setItem(key, String(Math.round(v))); } catch { /* optional */ } };
  let width = stored(WIDTH_KEY, 440);
  let outputHeight = stored(OUTPUT_KEY, 150);
  // What is drawn: the pane between 320px and 70% of the window, the output between 60 and 600px. A drag or a key
  // starts from what is drawn and stops at its limits, so there is no stretch past a limit that moves nothing on the
  // way back; a saved width wider than this window allows is kept (a larger window shows it all).
  const widest = () => Math.max(320, window.innerWidth * 0.7);
  const shownWidth = () => Math.max(320, Math.min(width, widest()));
  const shownHeight = () => Math.max(60, Math.min(outputHeight, 600));
  const setWidth = (w) => { width = Math.round(Math.max(320, Math.min(w, widest()))); };
  const setHeight = (h) => { outputHeight = Math.round(Math.max(60, Math.min(h, 600))); };
  const applySizes = () => {
    pane.style.width = `${shownWidth()}px`;
    outputBox.style.height = `${shownHeight()}px`;
    resizer.setAttribute('aria-valuenow', String(Math.round(shownWidth())));
    resizer.setAttribute('aria-valuemax', String(Math.round(widest())));
    outputSplit.setAttribute('aria-valuenow', String(shownHeight()));
  };
  applySizes();
  const drag = (handle, onMove, onEnd) => handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture?.(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, width: shownWidth(), outputHeight: shownHeight() };
    const move = (ev) => { onMove(ev, start); applySizes(); };
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); onEnd(); };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  drag(resizer, (ev, start) => setWidth(start.width + (start.x - ev.clientX)), () => keep(WIDTH_KEY, width));
  drag(outputSplit, (ev, start) => setHeight(start.outputHeight + (start.y - ev.clientY)), () => keep(OUTPUT_KEY, outputHeight));
  resizer.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault(); setWidth(shownWidth() + (e.key === 'ArrowLeft' ? 24 : -24)); applySizes(); keep(WIDTH_KEY, width);
  });
  outputSplit.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault(); setHeight(shownHeight() + (e.key === 'ArrowUp' ? 20 : -20)); applySizes(); keep(OUTPUT_KEY, outputHeight);
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
    pickerLabel.textContent = current?.name || t('automate.noScript');
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
    openMenu({ anchor: picker, label: t('automate.scripts'), minWidth: 240, items: [
      ...(items.length ? items : [{ label: t('automate.noScriptsYet'), disabled: true }]),
      { separator: true },
      { label: t('automate.newScript'), icon: 'plus', onSelect: () => newScript() },
      { label: t('automate.allScriptsMenu'), icon: 'allScripts', onSelect: () => gallery() },
    ] });
  }

  function openMore() {
    const s = scriptById(wb, openId);
    if (!s) return;
    openMenu({ anchor: more, label: t('automate.scriptActions'), minWidth: 220, items: [
      { label: t('automate.renameMenu'), icon: 'pencil', onSelect: () => renameScript(s.id) },
      { label: t('automate.duplicate'), icon: 'duplicate', onSelect: () => { flushSave(); const copy = duplicateScript(wb, s.id); if (copy) { authored.add(scriptFingerprint(copy.code)); openScript(copy.id); } } },
      { label: t('automate.deleteMenu'), icon: 'trash', onSelect: () => removeScript(s.id) },
      { separator: true },
      library && { label: t('automate.saveToLibrary'), icon: 'scriptLibrary', onSelect: () => saveToLibrary(s.id) },
      { label: t('automate.downloadJs'), icon: 'download', onSelect: () => { flushSave(); const blob = new Blob([scriptById(wb, s.id).code], { type: 'text/javascript' }); const a = el('a', { href: URL.createObjectURL(blob), download: `${s.name}.js` }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); } },
      { separator: true },
      { label: t('automate.findReplace'), icon: 'find', shortcut: `${MOD_KEY}+F`, onSelect: () => editor.openFind(true) },
      { label: t('automate.scriptReference'), icon: 'scriptReference', onSelect: () => openScriptReference() },
    ].filter(Boolean) });
  }

  async function renameScript(id) {
    flushSave();
    const s = scriptById(wb, id);
    if (!s) return;
    const name = await promptDialog({ title: t('automate.renameTitle'), label: t('common.name'), value: s.name, confirmLabel: t('common.rename'), validate: (v) => scriptNameProblem(wb, v, id) });
    if (name && name !== s.name) updateScript(wb, id, { name });
    renderPane();
  }
  async function removeScript(id) {
    flushSave();
    const s = scriptById(wb, id);
    if (!s) return;
    if (!await confirmDialog({ title: t('automate.deleteTitle'), message: t('automate.deleteMessage', { name: s.name }), confirmLabel: t('common.delete') })) return;
    deleteScript(wb, id);
    if (openId === id) openId = wb.scripts?.[0]?.id || null;
    renderPane(true);
    toast(t('automate.deleted', { name: s.name }), { icon: 'trash' });
  }
  async function saveToLibrary(id) {
    flushSave();
    const s = scriptById(wb, id);
    if (!s || !library) return;
    try {
      await library.saveToLibrary(s.name, s.code);
      toast(t('automate.savedToLibrary', { name: s.name }), { icon: 'check' });
    } catch (e) {
      toast(t('automate.saveToLibraryFailed', { reason: String(e?.message || e) }), { icon: 'alert' });
    }
  }

  function newScript({ name = 'Script', code = NEW_SCRIPT_CODE, description = '' } = {}) {
    flushSave();
    const s = addScript(wb, { name, code, description });
    if (!s) { toast(t('automate.tooManyScripts'), { icon: 'alert' }); return null; }
    authored.add(scriptFingerprint(code));
    openScript(s.id);
    return s;
  }

  function gallery() {
    flushSave();
    openScriptGallery(wb, {
      open: (id) => openScript(id),
      run: (script) => runCode(script),
      add: (script) => { const s = newScript(script); if (s) toast(t('automate.added', { name: s.name })); },
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
      line && linkable ? el('button.sp-log-line', { type: 'button', title: t('automate.output.goToLine', { line }), onclick: () => { if (pane.hidden) showPane(); editor.goToLine(line); } }, t('automate.output.line', { line }))
        : line ? el('span.sp-log-line.sp-log-line-plain', {}, t('automate.output.line', { line })) : null);
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
        el('p.modal-text', {}, t('automate.trust.message', { name })),
        el('p.sp-trust-hint', {}, t('automate.trust.hint')),
        el('div.row.row-end', {},
          el('button.btn.btn-ghost', { type: 'button', onclick: () => { resolve('review'); modal.close(); } }, t('automate.trust.review')),
          el('button.btn.btn-ghost', { type: 'button', onclick: () => { resolve(false); modal.close(); } }, t('common.cancel')),
          el('button.btn.btn-primary', { type: 'button', onclick: () => { resolve(true); modal.close(); } }, t('automate.trust.run'))));
      const modal = openModal({ title: t('automate.trust.title'), content, onClose: () => resolve(false) });
    });
    if (answer === 'review') return 'review';
    if (answer) { authored.add(fingerprint); await library?.trustScript?.(code); }
    return !!answer;
  }

  /** Run a script: { name, code, source: 'workbook' | 'library' | 'sample' | 'recorded', id }. */
  async function runCode(script) {
    if (running) { toast(t('automate.alreadyRunning'), { icon: 'info' }); return null; }
    if (recorder) { toast(t('automate.stopRecordingFirst'), { icon: 'info' }); return null; }
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
    log({ level: 'info', text: t('automate.status.runningName', { name: script.name }), quiet: true });
    status.textContent = t('automate.status.running');
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
        wb, code: script.code, transport: runTransport, env: env(), label: t('automate.undoRun', { name: script.name }), signal: controller.signal,
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
    const seconds = formatNumber((performance.now() - started) / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false });
    if (result.ok) {
      status.textContent = t('automate.status.finished', { seconds });
      log({ level: 'info', text: result.changed ? t('automate.status.finishedUndo', { seconds }) : t('automate.status.finishedLog', { seconds }), quiet: true });
    } else {
      status.textContent = result.stopped ? t('automate.status.stopped') : result.timedOut ? t('automate.status.timedOut')
        : result.error.line ? t('automate.status.failedAt', { line: result.error.line }) : t('automate.status.failed');
      log({ level: 'error', text: result.error.message, line: result.error.line, linkable: !!script.id && script.id === openId });
      if (script.id && script.id === openId && result.error.line) editor.setErrorLine(result.error.line);
    }
    if (!visible) {
      // Run from the ribbon or the gallery with the pane closed: the outcome as a notice, the output a click away.
      const text = result.ok ? (lastLog ? t('automate.ranSaid', { name: script.name, text: lastLog.text }) : t('automate.ran', { name: script.name }))
        : result.error.line ? t('automate.failedAt', { name: script.name, line: result.error.line, message: result.error.message }) : t('automate.failed', { name: script.name, message: result.error.message });
      toast(text.length > 160 ? `${text.slice(0, 157)}…` : text, { icon: result.ok ? 'check' : 'alert', action: { label: t('automate.showOutput'), onClick: () => { showPane({ focus: false }); output.focus(); } } });
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
    el('span.notice-text', {}, ...tRich('automate.recording.bar', { strong: (c) => el('strong', {}, c), count: recCount })),
    el('span.notice-actions', {},
      el('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => stopRecording(false) }, t('automate.recording.discard')),
      el('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => stopRecording(true) }, t('automate.recording.stop'))));

  function toggleRecording(on = !recorder) {
    if (on && !recorder) {
      if (running) { toast(t('automate.waitForScript'), { icon: 'info' }); return; }
      if (ctx.grid?.editing && !ctx.grid.commitEdit?.()) return;
      recorder = startRecorder(wb, { startSheet: ctx.sheetId?.() ?? wb.activeSheetId, name: 'Recorded actions' });
      const update = () => { const n = recorder?.count() || 0; recCount.textContent = t('automate.recording.count', { count: n }); };
      recorder.onChange(update);
      update();
      recordBar.hidden = false;
      ctx.announce?.(t('automate.recording.announce'));
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
    if (!save) { toast(t('automate.recording.discarded'), { icon: 'info' }); keepFocus(); return; }
    if (!steps) { toast(t('automate.recording.nothing'), { icon: 'info' }); keepFocus(); return; }
    const s = newScript({ name: uniqueScriptName(wb, 'Recorded script'), code, description: `${steps} recorded step${steps === 1 ? '' : 's'}.` });
    if (s) toast(t('automate.recording.saved', { count: steps, name: s.name }));
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
        if (id) toast(t('automate.buttonAdded', { name: s.name }));
        else toast(t('automate.buttonProtected'), { icon: 'alert' });
        return;
      }
      case 'runScript': {
        if (arg?.sample) { const s = sampleById(arg.sample); if (s) await runCode({ name: sampleName(s), code: s.code, source: 'sample' }); return; }
        if (arg?.path && library) {
          let code;
          try { code = await library.readLibraryScript(arg.path); } catch (e) { toast(arg.name ? t('automate.libraryReadFailed', { name: arg.name, reason: String(e?.message || e) }) : t('automate.libraryReadFailedUnnamed', { reason: String(e?.message || e) }), { icon: 'alert' }); return; }
          await runCode({ name: arg.name || t('automate.untitledScript'), code, source: 'library' });
          return;
        }
        if (arg?.name != null) {
          // A script button names its script; a renamed or deleted script leaves the button with nothing to run.
          const named = scriptByName(wb, arg.name);
          if (named) await runCode({ name: named.name, code: named.code, source: 'workbook', id: named.id });
          else toast(t('automate.buttonOrphan', { name: arg.name }), { icon: 'alert' });
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
    /** Code typed in the last moment, still waiting to go into the workbook: it goes now (before a save, or leaving). */
    flush: () => flushSave(),
    /** The workbook's scripts and My Scripts, for the ribbon's Run Script menu. */
    menuItems() {
      const list = (wb.scripts || []).map((s) => ({ label: s.name, icon: 'scriptFile', cmd: 'runScript', arg: { id: s.id } }));
      return list.length ? list : [{ label: t('automate.noScriptsInWorkbook'), disabled: true }];
    },
    /** The scripts a button can be added for, for the ribbon's Script Button menu. */
    buttonItems() {
      const list = (wb.scripts || []).map((s) => ({ label: s.name, icon: 'scriptButton', cmd: 'insertScriptButton', arg: { id: s.id } }));
      return list.length ? [{ header: t('automate.addButtonHeader') }, ...list] : [{ label: t('automate.noScriptsToRun'), disabled: true }];
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
