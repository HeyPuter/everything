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

type Lang = 'python' | 'javascript';

const history: string[] = [];
let bannerShown = false;

function banner() {
  if (bannerShown) return;
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
      menu('View', () => [
        { label: 'Zoom In', shortcut: 'Ctrl Wheel', action: () => this.zoom(1) },
        { label: 'Zoom Out', action: () => this.zoom(-1) },
        { separator: true },
        { label: 'Scroll to Bottom', action: () => this.scrollBottom() },
      ]),
      menu('Console', () => [
        { label: 'Clear All', op: 'console.clear', props: { scrollback: true, history: false } },
        { label: 'Clear Line', shortcut: 'Shift Enter', op: 'console.clear_line' },
        { separator: true },
        { label: 'Copy as Script', shortcut: 'Shift Ctrl C', op: 'console.copy_as_script' },
        { label: 'Copy', shortcut: 'Ctrl C', action: () => void navigator.clipboard?.writeText(String(getSelection() ?? '')) },
        { label: 'Paste', shortcut: 'Ctrl V', action: () => void navigator.clipboard?.readText().then((t) => this.pasteText(t)).catch(() => app.report('WARNING', 'Clipboard access was denied')) },
        { separator: true },
        { label: 'Indent', shortcut: 'Tab', action: () => this.insertAtCaret('    ') },
        { label: 'Autocomplete', shortcut: 'Ctrl Space', op: 'console.autocomplete' },
        { separator: true },
        { label: 'Python', active: this.lang === 'python', action: () => this.setLang('python') },
        { label: 'JavaScript', active: this.lang === 'javascript', action: () => this.setLang('javascript') },
      ]),
      h('div', { class: 'hdr-spacer' }),
      h(
        'div',
        { class: 'enum-row pc-lang', role: 'radiogroup', 'aria-label': 'Console language' },
        h('button', { class: { on: this.lang === 'python' }, 'data-tip': 'Python\nRun console input as Python (Pyodide, loads on first use)', onclick: () => this.setLang('python') }, 'Python'),
        h('button', { class: { on: this.lang === 'javascript' }, 'data-tip': 'JavaScript\nRun console input as JavaScript (works offline)', onclick: () => this.setLang('javascript') }, 'JavaScript'),
      ),
    );
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
      const v = this.input.value;
      this.input.value = '';
      void this.submit(v);
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      this.historyStep(e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const before = this.input.value.slice(0, this.input.selectionStart ?? 0);
      if (!before.trim() || e.shiftKey) {
        if (e.shiftKey) this.input.value = this.input.value.replace(/^ {1,4}/, '');
        else this.insertAtCaret('    ');
      } else this.autocomplete();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      output.clear();
    }
  }

  private historyStep(d: number) {
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

  private insertAtCaret(text: string) {
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
    idname: 'console.language_set',
    label: 'Set Console Language',
    description: 'Switch the console between Python and JavaScript',
    undo: false,
    props: [{ id: 'language', label: 'Language', type: 'enum', default: 'PYTHON', items: [['PYTHON', 'Python'], ['JAVASCRIPT', 'JavaScript']] }],
    poll: (ctx) => !!consoleOf(ctx),
    exec: (ctx, p) => consoleOf(ctx)!.setLang(p.language === 'JAVASCRIPT' ? 'javascript' : 'python'),
  },
]);

addKeys('Console', [
  { key: 'SPACE', ctrl: true, op: 'console.autocomplete' },
  { key: 'RET', shift: true, op: 'console.clear_line' },
  { key: 'C', shift: true, ctrl: true, op: 'console.copy_as_script' },
]);

registerEditor({ id: 'CONSOLE', label: 'Python Console', icon: 'console', group: 'Scripting', create: (a, s) => new PythonConsole(a, s) });

export { formatValue };
