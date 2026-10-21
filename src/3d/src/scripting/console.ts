// Python Console: interactive REPL (Python via Pyodide, or JavaScript for offline use),
// history (Up/Down), autocompletion (Tab / Ctrl+Space), scrollback shared with script output.
import { h, type Child } from '../ui/h';
import { app, registerOperators, type ChangeKind, type OpContext } from '../app/app';
import { registerEditor, type Area, type Editor } from '../ui/screen';
import { openMenu, type MenuItem } from '../ui/menu';
import { addKeys } from '../app/keymap';
import { dispatchEditorKeys, redirectIfElsewhere } from './editkeys';
import { output, evalConsoleJS, jsConsoleNames, jsResolvePath, formatValue } from './runner';
import { loadPython, python, pythonConsolePush, pythonComplete, pythonConsoleReset, PYODIDE_VERSION } from './python';
import { bridge } from './python';
import { wordLeft, wordRight } from './textnav';

type Lang = 'python' | 'javascript';

const history: string[] = [];
let bannerShown = false;

function banner(force = false) {
  if (bannerShown && !force) return;
  bannerShown = true;
  output.push(`PYTHON INTERACTIVE CONSOLE (Pyodide ${PYODIDE_VERSION}; the runtime loads on first use and needs a network connection)`, 'INFO');
  output.push('', 'INFO');
  output.push('Builtin Modules:       bpy, bpy.data, bpy.ops, bpy.props, bpy.types, bpy.context, bpy.utils, bpy.app, mathutils', 'INFO');
  output.push('Convenience Imports:   from mathutils import *; from math import *', 'INFO');
  output.push('Convenience Variables: C = bpy.context, D = bpy.data', 'INFO');
  output.push('JavaScript mode (header toggle) offers the same API offline.', 'INFO');
  output.push('', 'INFO');
}

const common = (list: string[]) => list.reduce((a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
});

export class PythonConsole implements Editor {
  el: HTMLElement;
  keymaps = ['Console', 'Window', 'Screen'];
  lang: Lang = 'python';
  private scrollEl: HTMLElement;
  private linesEl: HTMLElement;
  private inputRow: HTMLElement;
  private prompt: HTMLElement;
  private input: HTMLInputElement;
  private histIndex = -1;
  private draft = '';
  private more = false;
  private jsBuffer: string[] = [];
  private busy = false;
  private queue: string[] = [];
  private fontSize = 12;
  private renderedCount = -1;
  private lastLine: unknown = null;
  private unsub: () => void;

  constructor(
    public area: Area,
    state?: unknown,
  ) {
    const st = (state ?? {}) as { lang?: Lang; fontSize?: number };
    if (st.lang === 'javascript' || st.lang === 'python') this.lang = st.lang;
    if (st.fontSize) this.fontSize = st.fontSize;
    this.el = document.createElement('div');
    this.el.className = 'py-console';
    this.scrollEl = document.createElement('div');
    this.scrollEl.className = 'pc-scroll';
    this.linesEl = document.createElement('div');
    this.linesEl.className = 'pc-lines';
    this.inputRow = document.createElement('div');
    this.inputRow.className = 'pc-input-row';
    this.prompt = document.createElement('span');
    this.prompt.className = 'pc-prompt';
    this.input = document.createElement('input');
    this.input.className = 'pc-input text-editor-input';
    this.input.spellcheck = false;
    this.input.setAttribute('autocomplete', 'off');
    this.input.setAttribute('aria-label', 'Console input');
    this.inputRow.append(this.prompt, this.input);
    this.scrollEl.append(this.linesEl, this.inputRow);
    this.el.append(this.scrollEl);
    this.el.style.setProperty('--pc-fs', `${this.fontSize}px`);
    this.input.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.input.addEventListener('paste', (e) => this.onPaste(e));
    this.el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu(this.consoleMenu(), { x: e.clientX, y: e.clientY }, { title: 'Console' });
    });
    this.scrollEl.addEventListener('pointerup', () => {
      if (!String(getSelection() ?? '')) this.input.focus({ preventScroll: true });
    });
    this.scrollEl.addEventListener(
      'wheel',
      (e) => {
        if (e.ctrlKey) {
          e.preventDefault();
          this.zoom(e.deltaY < 0 ? 1 : -1);
        }
      },
      { passive: false },
    );
    banner();
    const fn = () => this.renderLines();
    output.listeners.add(fn);
    const pfn = () => this.updatePrompt();
    python.listeners.add(pfn);
    this.unsub = () => {
      output.listeners.delete(fn);
      python.listeners.delete(pfn);
    };
    this.renderLines();
    this.updatePrompt();
  }

  header(): Child {
    const menu = (label: string, items: () => MenuItem[]) =>
      h('button', { key: label, class: 'hdr-menu', onpointerdown: (e: PointerEvent) => (e.preventDefault(), openMenu(items(), e.currentTarget as HTMLElement)) }, label);
    return h(
      'div',
      { class: 'hdr-row' },
      menu('View', () => this.viewMenu()),
      menu('Console', () => this.consoleMenu()),
      h('div', { class: 'hdr-spacer' }),
      h(
        'div',
        { class: 'enum-row pc-lang', role: 'radiogroup', 'aria-label': 'Console language' },
        h('button', { class: { on: this.lang === 'python' }, 'data-tip': 'Python\nRun console input as Python (Pyodide, loads on first use)', onclick: () => this.setLang('python') }, 'Python'),
        h('button', { class: { on: this.lang === 'javascript' }, 'data-tip': 'JavaScript\nRun console input as JavaScript (works offline)', onclick: () => this.setLang('javascript') }, 'JavaScript'),
      ),
    );
  }

  private viewMenu(): MenuItem[] {
    const mv = (label: string, type: string, shortcut: string): MenuItem => ({ label, op: 'console.move', props: { type }, shortcut });
    return [
      { label: 'Zoom In', shortcut: 'Ctrl Wheel Up', op: 'wm.context_cycle_int', props: { data_path: 'space_data.font_size', reverse: false } },
      { label: 'Zoom Out', shortcut: 'Ctrl Wheel Down', op: 'wm.context_cycle_int', props: { data_path: 'space_data.font_size', reverse: true } },
      { separator: true },
      mv('Move to Previous Word', 'PREVIOUS_WORD', 'Ctrl ←'),
      mv('Move to Next Word', 'NEXT_WORD', 'Ctrl →'),
      mv('Move to Line Begin', 'LINE_BEGIN', 'Home'),
      mv('Move to Line End', 'LINE_END', 'End'),
      { separator: true },
      {
        label: 'Languages',
        submenu: () => [
          { label: 'Python', active: this.lang === 'python', op: 'console.language_set', props: { language: 'PYTHON' } },
          { label: 'JavaScript', active: this.lang === 'javascript', op: 'console.language_set', props: { language: 'JAVASCRIPT' } },
        ],
      },
      { label: 'Scroll to Bottom', action: () => this.scrollBottom() },
      { separator: true },
      { label: 'Area', submenu: () => this.area.areaMenu() },
    ];
  }

  /** Console menu (also the right-click menu). */
  consoleMenu(): MenuItem[] {
    return [
      { label: 'Clear All', op: 'console.clear', props: { scrollback: true, history: false } },
      { label: 'Clear Line', shortcut: 'Shift Enter', op: 'console.clear_line' },
      { label: 'Delete Previous Word', shortcut: 'Ctrl Backspace', op: 'console.delete', props: { type: 'PREVIOUS_WORD' } },
      { label: 'Delete Next Word', shortcut: 'Ctrl Delete', op: 'console.delete', props: { type: 'NEXT_WORD' } },
      { separator: true },
      { label: 'Copy as Script', shortcut: 'Shift Ctrl C', op: 'console.copy_as_script' },
      { label: 'Cut', shortcut: 'Ctrl X', op: 'console.copy', props: { delete: true } },
      { label: 'Copy', shortcut: 'Ctrl C', op: 'console.copy' },
      { label: 'Paste', shortcut: 'Ctrl V', op: 'console.paste' },
      { separator: true },
      { label: 'Indent', shortcut: 'Tab', op: 'console.indent' },
      { label: 'Unindent', shortcut: 'Shift Tab', op: 'console.unindent' },
      { separator: true },
      { label: 'Backward in History', shortcut: '↑', op: 'console.history_cycle', props: { reverse: true } },
      { label: 'Forward in History', shortcut: '↓', op: 'console.history_cycle', props: { reverse: false } },
      { separator: true },
      { label: 'Autocomplete', shortcut: 'Tab', op: 'console.autocomplete' },
    ];
  }

  /** Font size step (Ctrl wheel, Ctrl numpad +/-). */
  cycleFontSize(d: number) {
    this.zoom(d);
  }

  /** Move the caret in the input line (optionally extending the selection). */
  moveCaret(type: string, select = false) {
    const inp = this.input;
    const v = inp.value;
    const back = inp.selectionDirection === 'backward';
    const s0 = inp.selectionStart ?? 0,
      e0 = inp.selectionEnd ?? s0;
    const focus = back ? s0 : e0,
      anchor = back ? e0 : s0;
    const to = type === 'LINE_BEGIN' ? 0 : type === 'LINE_END' ? v.length : type === 'PREVIOUS_WORD' ? wordLeft(v, focus) : type === 'NEXT_WORD' ? wordRight(v, focus) : type === 'PREVIOUS_CHARACTER' ? Math.max(0, focus - 1) : Math.min(v.length, focus + 1);
    inp.focus();
    if (select) inp.setSelectionRange(Math.min(anchor, to), Math.max(anchor, to), to < anchor ? 'backward' : 'forward');
    else inp.setSelectionRange(to, to);
  }

  /** Delete a character or a word before / after the caret (or the selection). */
  deleteText(type: string) {
    const inp = this.input;
    const v = inp.value;
    let s0 = inp.selectionStart ?? 0,
      e0 = inp.selectionEnd ?? s0;
    if (s0 === e0) {
      if (type === 'PREVIOUS_WORD') s0 = wordLeft(v, s0);
      else if (type === 'NEXT_WORD') e0 = wordRight(v, e0);
      else if (type === 'PREVIOUS_CHARACTER') s0 = Math.max(0, s0 - 1);
      else e0 = Math.min(v.length, e0 + 1);
    }
    inp.focus();
    inp.setRangeText('', s0, e0, 'end');
  }

  /** Copy the selected scrollback text, or the input selection (Cut removes it from the input). */
  copy(del = false) {
    const page = String(getSelection() ?? '');
    const inp = this.input;
    const s0 = inp.selectionStart ?? 0,
      e0 = inp.selectionEnd ?? s0;
    const text = document.activeElement === inp && e0 > s0 ? inp.value.slice(s0, e0) : page || inp.value.slice(s0, e0);
    if (!text) return;
    void navigator.clipboard?.writeText(text).catch(() => app.report('WARNING', 'Clipboard access was denied'));
    if (del && e0 > s0) inp.setRangeText('', s0, e0, 'end');
  }

  paste() {
    void navigator.clipboard
      ?.readText()
      .then((t) => (t.includes('\n') ? this.pasteText(t) : this.insertAtCaret(t)))
      .catch(() => app.report('WARNING', 'Clipboard access was denied'));
  }

  indent() {
    const inp = this.input;
    const p = inp.selectionStart ?? 0;
    inp.value = `    ${inp.value}`;
    inp.setSelectionRange(p + 4, p + 4);
  }

  unindent() {
    const inp = this.input;
    const p = inp.selectionStart ?? 0;
    const n = /^ {1,4}|^\t/.exec(inp.value)?.[0].length ?? 0;
    if (!n) return;
    inp.value = inp.value.slice(n);
    inp.setSelectionRange(Math.max(0, p - n), Math.max(0, p - n));
  }

  /** Run the input line (Enter). */
  execute() {
    const v = this.input.value;
    this.input.value = '';
    void this.submit(v);
  }

  /** Tab: complete the name before the caret, or indent an empty line start. */
  indentOrAutocomplete() {
    const before = this.input.value.slice(0, this.input.selectionStart ?? 0);
    if (!before.trim()) this.insertAtCaret('    ');
    else this.autocomplete();
  }

  /** Put `text` in the input line (adding it to the history) with the caret at `caret`. */
  historyAppend(text: string, caret: number, removeDuplicates: boolean) {
    if (removeDuplicates) for (let i = history.indexOf(text); i >= 0; i = history.indexOf(text)) history.splice(i, 1);
    if (text.trim()) history.push(text);
    this.histIndex = -1;
    this.input.value = text;
    const c = caret < 0 ? text.length : Math.min(text.length, caret);
    this.input.focus();
    this.input.setSelectionRange(c, c);
  }

  /** Select the whole input line, or (with nothing typed) all scrollback text. */
  selectAll() {
    if (this.input.value) {
      this.input.focus();
      this.input.select();
      return;
    }
    const r = document.createRange();
    r.selectNodeContents(this.linesEl);
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  }

  /** Select the word at the caret in the input line. */
  selectWord() {
    const inp = this.input;
    const v = inp.value;
    const p = inp.selectionStart ?? 0;
    let s0 = p,
      e0 = p;
    while (s0 > 0 && /[\w$]/.test(v[s0 - 1])) s0--;
    while (e0 < v.length && /[\w$]/.test(v[e0])) e0++;
    inp.focus();
    inp.setSelectionRange(s0, e0);
  }

  historyCycle(reverse: boolean) {
    this.historyStep(reverse ? -1 : 1);
  }

  setLang(l: Lang) {
    if (this.lang === l) return;
    this.lang = l;
    this.more = false;
    this.jsBuffer = [];
    if (l === 'python') pythonConsoleReset();
    output.push(`# console language: ${l === 'python' ? 'Python' : 'JavaScript'}`, 'INFO');
    this.updatePrompt();
    this.area.drawHeader();
  }

  private zoom(d: number) {
    this.fontSize = Math.max(8, Math.min(32, this.fontSize + d));
    this.el.style.setProperty('--pc-fs', `${this.fontSize}px`);
  }

  private updatePrompt() {
    const loading = this.lang === 'python' && python.state === 'loading';
    this.prompt.textContent = loading ? '…  ' : this.more ? '... ' : this.lang === 'python' ? '>>> ' : 'js> ';
    this.el.classList.toggle('loading', loading || this.busy);
  }

  private renderLines() {
    const lines = output.lines;
    if (lines.length < this.renderedCount || (this.renderedCount > 0 && lines[this.renderedCount - 1] !== this.lastLine)) this.renderedCount = -1;
    const atBottom = this.scrollEl.scrollHeight - this.scrollEl.scrollTop - this.scrollEl.clientHeight < 30;
    if (this.renderedCount < 0) {
      this.linesEl.textContent = '';
      this.renderedCount = 0;
    }
    const frag = document.createDocumentFragment();
    for (let i = this.renderedCount; i < lines.length; i++) {
      const d = document.createElement('div');
      d.className = `pc-line ${lines[i].type.toLowerCase()}`;
      d.textContent = lines[i].text || '​';
      frag.append(d);
    }
    this.linesEl.append(frag);
    // keep the DOM bounded like the scrollback
    while (this.linesEl.childElementCount > lines.length) this.linesEl.firstElementChild?.remove();
    this.renderedCount = lines.length;
    this.lastLine = lines[lines.length - 1] ?? null;
    if (atBottom || this.renderedCount < 50) this.scrollBottom();
  }

  private scrollBottom() {
    requestAnimationFrame(() => (this.scrollEl.scrollTop = this.scrollEl.scrollHeight));
  }

  // ---------------------------------------------------------------- execution

  async submit(line: string) {
    if (this.busy) {
      this.queue.push(line);
      return;
    }
    output.push(`${this.prompt.textContent}${line}`, 'INPUT');
    if (line.trim() && history[history.length - 1] !== line) history.push(line);
    this.histIndex = -1;
    this.draft = '';
    if (this.lang === 'javascript') this.runJS(line);
    else await this.runPython(line);
    this.updatePrompt();
    const next = this.queue.shift();
    if (next !== undefined) await this.submit(next);
  }

  private runJS(line: string) {
    // multi-line blocks: keep reading while brackets are open or the line ends with a backslash
    this.jsBuffer.push(line);
    const src = this.jsBuffer.join('\n');
    if (line.trim() !== '' && openBrackets(src) > 0) {
      this.more = true;
      return;
    }
    this.more = false;
    this.jsBuffer = [];
    if (src.trim()) evalConsoleJS(src);
  }

  private async runPython(line: string) {
    if (python.state !== 'ready') {
      this.busy = true;
      this.updatePrompt();
      try {
        await loadPython();
      } catch {
        this.busy = false;
        output.push('Switch the console to JavaScript (header) to keep working offline.', 'INFO');
        this.updatePrompt();
        return;
      }
      this.busy = false;
    }
    try {
      this.more = pythonConsolePush(line) === 'more';
    } catch (e) {
      output.push(String((e as Error).message ?? e), 'ERROR');
      this.more = false;
    }
  }

  // ---------------------------------------------------------------- input handling

  private onKeyDown(e: KeyboardEvent) {
    e.stopPropagation();
    if (redirectIfElsewhere(e, this.area, this.input)) return;
    if (dispatchEditorKeys(e, this.area, ['Console'])) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.execute();
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      this.historyStep(e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (e.shiftKey) this.unindent();
      else this.indentOrAutocomplete();
      return;
    }
    if (e.key === 'Tab' && e.ctrlKey && !e.altKey) {
      e.preventDefault();
      this.insertAtCaret('\t');
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      output.clear();
    }
  }

  historyStep(d: number) {
    if (!history.length) return;
    if (this.histIndex === -1) {
      if (d > 0) return;
      this.draft = this.input.value;
      this.histIndex = history.length - 1;
    } else {
      this.histIndex += d;
      if (this.histIndex >= history.length) {
        this.histIndex = -1;
        this.input.value = this.draft;
        return;
      }
      this.histIndex = Math.max(0, this.histIndex);
    }
    this.input.value = history[this.histIndex];
    const n = this.input.value.length;
    this.input.setSelectionRange(n, n);
  }

  insertAtCaret(text: string) {
    this.input.focus();
    const s = this.input.selectionStart ?? this.input.value.length;
    const e = this.input.selectionEnd ?? s;
    this.input.setRangeText(text, s, e, 'end');
  }

  clearLine() {
    this.input.value = '';
    this.more = false;
    this.jsBuffer = [];
    if (this.lang === 'python') pythonConsoleReset();
    this.updatePrompt();
  }

  private onPaste(e: ClipboardEvent) {
    const t = e.clipboardData?.getData('text') ?? '';
    if (!t.includes('\n')) return;
    e.preventDefault();
    this.pasteText(t);
  }

  private pasteText(t: string) {
    const lines = t.replace(/\r\n?/g, '\n').split('\n');
    const first = this.input.value + lines.shift();
    this.input.value = '';
    void (async () => {
      await this.submit(first);
      for (const l of lines.slice(0, lines[lines.length - 1] === '' ? -1 : undefined)) await this.submit(l);
    })();
  }

  autocomplete() {
    const pos = this.input.selectionStart ?? this.input.value.length;
    const before = this.input.value.slice(0, pos);
    let word: string, matches: string[];
    if (this.lang === 'python') {
      if (python.state !== 'ready') {
        app.report('INFO', 'Autocomplete is available once the Python runtime has loaded (run any command)');
        return;
      }
      ({ word, matches } = pythonComplete(before));
    } else ({ word, matches } = jsComplete(before));
    if (!matches.length) return;
    const prefix = matches.length === 1 ? matches[0] : common(matches);
    if (prefix.length > word.length) {
      this.input.setRangeText(prefix, pos - word.length, pos, 'end');
    }
    if (matches.length > 1) {
      output.push(`${this.prompt.textContent}${this.input.value}`, 'INPUT');
      const short = matches.map((m) => m.slice(m.lastIndexOf('.', m.length - 2) + 1));
      output.push(short.join('  '), 'OUTPUT');
    }
  }

  copyAsScript() {
    const out: string[] = this.lang === 'python' ? ['import bpy', 'from bpy import data as D', 'from bpy import context as C', 'from mathutils import *', 'from math import *', ''] : [];
    for (const l of output.lines) if (l.type === 'INPUT') out.push(l.text.replace(/^(>>> |\.\.\. |js> )/, ''));
    void navigator.clipboard?.writeText(out.join('\n')).then(
      () => app.report('INFO', 'Copied console input as a script'),
      () => app.report('WARNING', 'Clipboard access was denied'),
    );
  }

  update(kinds: Set<ChangeKind>) {
    void kinds;
  }

  onKey(e: KeyboardEvent): boolean {
    // typing anywhere over the console focuses the input
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && document.activeElement !== this.input) {
      this.input.focus();
      return false;
    }
    return false;
  }

  serialize() {
    return { lang: this.lang, fontSize: this.fontSize };
  }

  dispose() {
    this.unsub();
  }
}

function openBrackets(src: string) {
  let depth = 0;
  let q: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '\\') i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      if (nl < 0) break;
      i = nl;
    } else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
  }
  return depth;
}

/** Completion of `a.b.c` chains in the JavaScript console. */
export function jsComplete(before: string): { word: string; matches: string[] } {
  const m = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.?)$/.exec(before);
  const word = m?.[1] ?? '';
  const dot = word.lastIndexOf('.');
  if (dot < 0) {
    const names = [...jsConsoleNames(), 'Math', 'Array', 'Object', 'JSON', 'Number', 'String', 'console'];
    return { word, matches: [...new Set(names)].filter((n) => n.startsWith(word)).sort() };
  }
  const base = word.slice(0, dot);
  const stem = word.slice(dot + 1);
  const obj = jsResolvePath(base);
  if (obj === null || obj === undefined || (typeof obj !== 'object' && typeof obj !== 'function')) return { word, matches: [] };
  let keys: string[] = [];
  try {
    keys = bridge.dir(obj);
    if (obj && typeof obj === 'object' && (obj as { __kind?: string }).__kind === 'ops') keys = Object.keys(obj as object);
    if (typeof obj === 'object' && (obj as { __kind?: string }).__kind === 'opmodule') keys = Reflect.ownKeys(obj as object).map(String);
  } catch {
    keys = [];
  }
  return { word, matches: keys.filter((k) => k.startsWith(stem)).map((k) => `${base}.${k}`) };
}

// ---------------------------------------------------------------------------
// operators & keymap

const consoleOf = (ctx: OpContext) => (ctx.area?.type === 'CONSOLE' ? (ctx.area.editor as PythonConsole) : null);

registerOperators([
  {
    idname: 'console.clear',
    label: 'Clear All',
    description: 'Clear the console scrollback and/or history',
    undo: false,
    props: [
      { id: 'scrollback', label: 'Scrollback', type: 'bool', default: true },
      { id: 'history', label: 'History', type: 'bool', default: false },
    ],
    exec: (_ctx, p) => {
      if (p.scrollback) output.clear();
      if (p.history) history.length = 0;
    },
  },
  { idname: 'console.clear_line', label: 'Clear Line', description: 'Clear the console input line', undo: false, poll: (ctx) => !!consoleOf(ctx), exec: (ctx) => consoleOf(ctx)!.clearLine() },
  { idname: 'console.autocomplete', label: 'Console Autocomplete', description: 'Complete the name under the cursor', undo: false, poll: (ctx) => !!consoleOf(ctx), exec: (ctx) => consoleOf(ctx)!.autocomplete() },
  { idname: 'console.copy_as_script', label: 'Copy as Script', description: 'Copy the console input to the clipboard as a script', undo: false, poll: (ctx) => !!consoleOf(ctx), exec: (ctx) => consoleOf(ctx)!.copyAsScript() },
  {
    idname: 'console.move',
    label: 'Move Cursor',
    description: 'Move the caret in the input line',
    undo: false,
    props: [
      { id: 'type', label: 'Type', type: 'enum', default: 'LINE_BEGIN', items: [['LINE_BEGIN', 'Line Begin'], ['LINE_END', 'Line End'], ['PREVIOUS_CHARACTER', 'Previous Character'], ['NEXT_CHARACTER', 'Next Character'], ['PREVIOUS_WORD', 'Previous Word'], ['NEXT_WORD', 'Next Word']] },
      { id: 'select', label: 'Select', type: 'bool', default: false },
    ],
    poll: (ctx) => !!consoleOf(ctx),
    exec: (ctx, p) => consoleOf(ctx)!.moveCaret(p.type as string, !!p.select),
  },
  {
    idname: 'console.delete',
    label: 'Delete',
    description: 'Delete text by character or word',
    undo: false,
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'NEXT_CHARACTER', items: [['NEXT_CHARACTER', 'Next Character'], ['PREVIOUS_CHARACTER', 'Previous Character'], ['NEXT_WORD', 'Next Word'], ['PREVIOUS_WORD', 'Previous Word']] }],
    poll: (ctx) => !!consoleOf(ctx),
    exec: (ctx, p) => consoleOf(ctx)!.deleteText(p.type as string),
  },
  {
    idname: 'console.copy',
    label: 'Copy to Clipboard',
    description: 'Copy the selected text (Cut also removes it from the input line)',
    undo: false,
    props: [{ id: 'delete', label: 'Delete Selection', type: 'bool', default: false }],
    poll: (ctx) => !!consoleOf(ctx),
    exec: (ctx, p) => consoleOf(ctx)!.copy(!!p.delete),
  },
  { idname: 'console.paste', label: 'Paste from Clipboard', description: 'Paste text; several lines run one after another', undo: false, poll: (ctx) => !!consoleOf(ctx), exec: (ctx) => consoleOf(ctx)!.paste() },
  { idname: 'console.indent', label: 'Indent', description: 'Add one level of indentation to the input line', undo: false, poll: (ctx) => !!consoleOf(ctx), exec: (ctx) => consoleOf(ctx)!.indent() },
  { idname: 'console.unindent', label: 'Unindent', description: 'Remove one level of indentation from the input line', undo: false, poll: (ctx) => !!consoleOf(ctx), exec: (ctx) => consoleOf(ctx)!.unindent() },
  {
    idname: 'console.history_cycle',
    label: 'History Cycle',
    description: 'Step backward or forward through the lines entered before',
    undo: false,
    props: [{ id: 'reverse', label: 'Reverse', type: 'bool', default: false }],
    poll: (ctx) => !!consoleOf(ctx),
    exec: (ctx, p) => consoleOf(ctx)!.historyCycle(!!p.reverse),
  },
  {
    idname: 'console.insert',
    label: 'Insert',
    description: 'Insert text at the caret',
    undo: false,
    props: [{ id: 'text', label: 'Text', type: 'string', default: '' }],
    poll: (ctx) => !!consoleOf(ctx),
    exec: (ctx, p) => consoleOf(ctx)!.insertAtCaret(String(p.text)),
  },
  {
    idname: 'console.language_set',
    label: 'Set Console Language',
    description: 'Switch the console between Python and JavaScript',
    undo: false,
    props: [{ id: 'language', label: 'Language', type: 'enum', default: 'PYTHON', items: [['PYTHON', 'Python'], ['JAVASCRIPT', 'JavaScript']] }],
    poll: (ctx) => !!consoleOf(ctx),
    exec: (ctx, p) => consoleOf(ctx)!.setLang(p.language === 'JAVASCRIPT' ? 'javascript' : 'python'),
  },
]);

registerOperators([
  {
    idname: 'console.execute',
    label: 'Console Execute',
    description: 'Run the input line',
    undo: false,
    props: [{ id: 'interactive', label: 'Interactive', type: 'bool', default: false, hidden: true }],
    poll: (ctx) => !!consoleOf(ctx),
    exec: (ctx) => consoleOf(ctx)!.execute(),
  },
  { idname: 'console.indent_or_autocomplete', label: 'Indent or Autocomplete', description: 'Complete the name before the caret, or indent at the start of the line', undo: false, poll: (ctx) => !!consoleOf(ctx), exec: (ctx) => consoleOf(ctx)!.indentOrAutocomplete() },
  { idname: 'console.banner', label: 'Console Banner', description: 'Print the welcome text of the console', undo: false, poll: (ctx) => !!consoleOf(ctx), exec: () => banner(true) },
  {
    idname: 'console.history_append',
    label: 'History Append',
    description: 'Add a line to the input history and show it in the input line',
    undo: false,
    props: [
      { id: 'text', label: 'Text', type: 'string', default: '' },
      { id: 'current_character', label: 'Cursor', type: 'int', default: 0, min: 0 },
      { id: 'remove_duplicates', label: 'Remove Duplicates', type: 'bool', default: false },
    ],
    poll: (ctx) => !!consoleOf(ctx),
    exec: (ctx, p) => consoleOf(ctx)!.historyAppend(String(p.text), Number(p.current_character), !!p.remove_duplicates),
  },
  {
    idname: 'console.scrollback_append',
    label: 'Scrollback Append',
    description: 'Add a line to the console output',
    undo: false,
    props: [
      { id: 'text', label: 'Text', type: 'string', default: '' },
      { id: 'type', label: 'Type', type: 'enum', default: 'OUTPUT', items: [['OUTPUT', 'Output'], ['INPUT', 'Input'], ['INFO', 'Information'], ['ERROR', 'Error']] },
    ],
    exec: (_ctx, p) => output.push(String(p.text), p.type as 'OUTPUT'),
  },
  { idname: 'console.select_all', label: 'Select All', description: 'Select the input line, or all console text when the line is empty', undo: false, poll: (ctx) => !!consoleOf(ctx), exec: (ctx) => consoleOf(ctx)!.selectAll() },
  { idname: 'console.select_word', label: 'Select Word', description: 'Select the word at the caret', undo: false, poll: (ctx) => !!consoleOf(ctx), exec: (ctx) => consoleOf(ctx)!.selectWord() },
  {
    idname: 'console.language',
    label: 'Console Language',
    description: 'Set the language of the console (python or javascript)',
    undo: false,
    props: [{ id: 'language', label: 'Language', type: 'string', default: 'python' }],
    poll: (ctx) => !!consoleOf(ctx),
    exec: (ctx, p) => {
      const l = String(p.language).toLowerCase();
      if (l !== 'python' && l !== 'javascript') {
        app.report('ERROR', `Unknown console language "${p.language}"`);
        return 'CANCELLED';
      }
      consoleOf(ctx)!.setLang(l);
    },
  },
]);

addKeys('Console', [
  { key: 'SPACE', ctrl: true, op: 'console.autocomplete' },
  { key: 'HOME', op: 'console.move', props: { type: 'LINE_BEGIN' } },
  { key: 'END', op: 'console.move', props: { type: 'LINE_END' } },
  { key: 'HOME', shift: true, op: 'console.move', props: { type: 'LINE_BEGIN', select: true } },
  { key: 'END', shift: true, op: 'console.move', props: { type: 'LINE_END', select: true } },
  { key: 'NUMPAD_PLUS', ctrl: true, op: 'wm.context_cycle_int', props: { data_path: 'space_data.font_size', reverse: false } },
  { key: 'NUMPAD_MINUS', ctrl: true, op: 'wm.context_cycle_int', props: { data_path: 'space_data.font_size', reverse: true } },
  { key: 'RET', shift: true, op: 'console.clear_line' },
  { key: 'C', shift: true, ctrl: true, op: 'console.copy_as_script' },
  { key: 'A', ctrl: true, op: 'console.select_all' },
]);

registerEditor({ id: 'CONSOLE', label: 'Python Console', icon: 'console', group: 'Scripting', create: (a, s) => new PythonConsole(a, s) });

export { formatValue };
