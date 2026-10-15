// Text Editor: text data-block selector, line-numbered editing with syntax highlighting,
// find & replace sidebar, indentation / comment tools, templates, Run Script (Alt+P).
import { h, patch, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, registerOperators, type ChangeKind, type OpContext } from '../app/app';
import { registerEditor, type Area, type Editor } from '../ui/screen';
import { openMenu, promptText, type MenuItem } from '../ui/menu';
import { textField, checkbox, panel, numberField } from '../ui/widgets';
import { addKeys } from '../app/keymap';
import { dispatchEditorKeys, redirectIfElsewhere } from './editkeys';
import { newText } from '../data/defaults';
import type { TextData } from '../data/types';
import { download, pickFile } from '../io/native';
import { highlightLines } from './highlight';
import { templates } from './templates';
import { runJavaScript, output, type RunResult } from './runner';
import { loadPython, runPythonText } from './python';
import { uniqueName } from './api';
import { movePos, wordAt, lineStart, completionPrefix, wordCandidates, MOVE_TYPES, type MoveType } from './textnav';
import { jsComplete } from './console';
import { newCurve, newObject } from '../data/defaults';
import { addObjectToScene, uniqueName as uniqueDataName } from '../ops/object';
import './textedit.css';

type Lang = TextData['language'];

const settings = {
  tabWidth: 4,
  useSpaces: true,
  fontSize: 12,
  matchCase: false,
  wrapAround: true,
  /** Find Next continues into the other texts */
  findAll: false,
  /** vertical guide at a column */
  showMargin: false,
  marginColumn: 80,
  /** typing an opening bracket or quote adds the closing one (Preferences ▸ Editing ▸ Text Editor) */
  autoClose: false,
};
/** Text editor defaults that Preferences change. */
export const textEditorSettings = settings;

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };

function langOf(t: TextData | null): Lang {
  return t?.language ?? 'python';
}
const JS_EXT = /\.(mjs|js|ts)$/i;
const PY_EXT = /\.py$/i;
const TXT_EXT = /\.(txt|md|json|csv|glsl)$/i;
function langFromName(name: string): Lang {
  if (JS_EXT.test(name)) return 'javascript';
  if (PY_EXT.test(name)) return 'python';
  if (TXT_EXT.test(name)) return 'text';
  return 'python';
}

/** File handles from the File System Access API (when available) for Save and Reload. */
const fileHandles = new Map<string, FileSystemFileHandle>();
/** Last-modified time of the linked file when it was last read or written (conflict detection). */
const fileTimes = new Map<string, number>();

/** Navigation entries (Top, Bottom, Line Begin/End, Previous/Next Line and Word). */
function navItems(op: 'text.move' | 'text.move_select'): MenuItem[] {
  const sel = op === 'text.move_select';
  const k = (s: string) => (sel ? `Shift ${s}` : s);
  const it = (label: string, type: MoveType, sc: string): MenuItem => ({ label, op, props: { type }, shortcut: k(sc) });
  return [
    { separator: true },
    it('Top', 'FILE_TOP', 'Ctrl Home'),
    it('Bottom', 'FILE_BOTTOM', 'Ctrl End'),
    { separator: true },
    it('Line Begin', 'LINE_BEGIN', 'Home'),
    it('Line End', 'LINE_END', 'End'),
    { separator: true },
    it('Previous Line', 'PREVIOUS_LINE', '↑'),
    it('Next Line', 'NEXT_LINE', '↓'),
    { separator: true },
    it('Previous Word', 'PREVIOUS_WORD', 'Ctrl ←'),
    it('Next Word', 'NEXT_WORD', 'Ctrl →'),
  ].slice(sel ? 0 : 1);
}

export class TextEditor implements Editor {
  el: HTMLElement;
  keymaps = ['Text', 'Window', 'Screen'];
  textId: string | null = null;
  showLineNumbers = true;
  wordWrap = false;
  syntax = true;
  highlightLine = true;
  showSidebar = false;
  findText = '';
  replaceText = '';
  /** typing replaces the character after the caret (Insert) */
  overwrite = false;
  /** the file on disk changed since it was opened or saved */
  conflict = false;
  private acEl: HTMLElement;
  private acItems: string[] = [];
  private acIndex = 0;
  private acStart = -1;
  private conflictEl: HTMLElement;
  private marginEl: HTMLElement;
  errorLine: number | null = null;
  private main: HTMLElement;
  private scroll: HTMLElement;
  private gutter: HTMLElement;
  private content: HTMLElement;
  private pre: HTMLElement;
  private curLine: HTMLElement;
  private ta: HTMLTextAreaElement;
  private empty: HTMLElement;
  private sidebarEl: HTMLElement;
  private footer: HTMLElement;
  private lineHeight = 17;
  private charWidth = 7.2;
  private lastBody = '';
  private dirtySincePush = false;
  private renderQueued = false;
  private findFocus = false;
  private resizeObs: ResizeObserver;

  constructor(
    public area: Area,
    state?: unknown,
  ) {
    const st = (state ?? {}) as Partial<{ text: string; lineNumbers: boolean; wrap: boolean; syntax: boolean; sidebar: boolean }>;
    this.textId = st.text ?? null;
    if (st.lineNumbers !== undefined) this.showLineNumbers = st.lineNumbers;
    if (st.wrap !== undefined) this.wordWrap = st.wrap;
    if (st.syntax !== undefined) this.syntax = st.syntax;
    if (st.sidebar !== undefined) this.showSidebar = st.sidebar;
    this.el = document.createElement('div');
    this.el.className = 'text-editor';
    this.main = div('te-main');
    this.scroll = div('te-scroll');
    this.gutter = div('te-gutter');
    this.content = div('te-content');
    this.pre = document.createElement('div');
    this.pre.className = 'te-highlight';
    this.pre.setAttribute('aria-hidden', 'true');
    this.curLine = div('te-curline');
    this.ta = document.createElement('textarea');
    this.ta.className = 'te-input text-editor-input';
    this.ta.spellcheck = false;
    this.ta.setAttribute('autocapitalize', 'off');
    this.ta.setAttribute('autocomplete', 'off');
    this.ta.setAttribute('wrap', 'off');
    this.ta.setAttribute('aria-label', 'Text editor');
    this.marginEl = div('te-margin');
    this.content.append(this.curLine, this.marginEl, this.pre, this.ta);
    this.scroll.append(this.gutter, this.content);
    this.empty = div('te-empty');
    this.acEl = div('te-autocomplete');
    this.acEl.setAttribute('role', 'listbox');
    this.conflictEl = div('te-conflict');
    this.main.append(this.scroll, this.empty, this.acEl, this.conflictEl);
    this.sidebarEl = div('te-sidebar');
    this.footer = div('te-footer');
    const body = div('te-body');
    body.append(this.main, this.sidebarEl);
    this.el.append(body, this.footer);

    this.ta.addEventListener('input', () => this.onInput());
    this.ta.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.ta.addEventListener('select', () => this.updateCaret());
    this.ta.addEventListener('click', () => this.updateCaret());
    this.ta.addEventListener('keyup', () => this.updateCaret());
    this.ta.addEventListener('focus', () => this.updateCaret());
    this.ta.addEventListener('blur', () => {
      this.commitUndo();
      setTimeout(() => document.activeElement !== this.ta && this.closeAutocomplete(), 150);
    });
    this.ta.addEventListener('focus', () => void this.checkConflict());
    this.ta.addEventListener('beforeinput', (e) => {
      // overwrite mode: typed characters replace the one after the caret (never a line break)
      if (!this.overwrite || e.inputType !== 'insertText' || this.ta.selectionStart !== this.ta.selectionEnd) return;
      const p = this.ta.selectionStart;
      if (p < this.ta.value.length && this.ta.value[p] !== '\n') this.ta.setSelectionRange(p, p + 1);
    });
    this.scroll.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!this.text) return;
      openMenu(this.contextMenu(), { x: e.clientX, y: e.clientY });
    });
    this.el.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        this.zoom(e.deltaY < 0 ? 1 : -1);
      },
      { passive: false },
    );
    this.scroll.addEventListener('scroll', () => this.closeAutocomplete());
    this.el.addEventListener('pointerenter', () => void this.checkConflict());
    document.addEventListener('selectionchange', this.onSelectionChange);
    addEventListener('focus', this.onWindowFocus);
    this.scroll.addEventListener('pointerdown', (e) => {
      if (e.button === 0 && this.text && (e.target === this.gutter || this.gutter.contains(e.target as Node))) {
        // line numbers: click selects the line, drag selects a range of lines
        e.preventDefault();
        this.ta.focus();
        const first = this.lineAtY(e.clientY);
        const sel = (to: number) => {
          const v = this.ta.value;
          const a = Math.min(first, to),
            b = Math.max(first, to);
          const start = this.lineStartPos(a);
          let end = this.lineStartPos(b + 1);
          if (end > v.length) end = v.length;
          this.ta.setSelectionRange(start, end, to < first ? 'backward' : 'forward');
          this.updateCaret();
        };
        sel(first);
        const move = (ev: PointerEvent) => sel(this.lineAtY(ev.clientY));
        const up = () => {
          removeEventListener('pointermove', move);
          removeEventListener('pointerup', up);
        };
        addEventListener('pointermove', move);
        addEventListener('pointerup', up);
        return;
      }
      if (e.target === this.scroll || e.target === this.gutter || this.gutter.contains(e.target as Node)) {
        e.preventDefault();
        this.ta.focus();
      }
    });
    this.resizeObs = new ResizeObserver(() => this.layout());
    this.resizeObs.observe(this.scroll);
    this.measure();
    this.load();
  }

  private onWindowFocus = () => void this.checkConflict();

  private onSelectionChange = () => {
    if (document.activeElement === this.ta) this.updateCaret();
  };

  get text(): TextData | null {
    return this.textId ? app.doc.texts[this.textId] ?? null : null;
  }

  // ---------------------------------------------------------------- header

  header(): Child {
    const t = this.text;
    const menu = (label: string, items: () => MenuItem[]) =>
      h('button', { key: label, class: 'hdr-menu', onpointerdown: (e: PointerEvent) => (e.preventDefault(), openMenu(items(), e.currentTarget as HTMLElement)) }, label);
    return h(
      'div',
      { class: 'hdr-row te-header' },
      menu('View', () => this.viewMenu()),
      menu('Text', () => this.textMenu()),
      menu('Edit', () => this.editMenu()),
      menu('Select', () => this.selectMenu()),
      menu('Format', () => this.formatMenu()),
      menu('Templates', () => templateMenu((tpl) => this.openTemplate(tpl))),
      h('div', { class: 'te-sep' }),
      this.idSelector(t),
      h('div', { class: 'hdr-spacer' }),
      t
        ? h(
            'button',
            { class: 'hdr-toggle te-run', 'data-tip': 'Run Script (Alt P)\nExecute this script in the application', onclick: () => app.run('text.run_script', {}, { area: this.area }), 'aria-label': 'Run Script' },
            icon('play'),
          )
        : null,
      h(
        'div',
        { class: 'hdr-group' },
        h('button', { class: { 'hdr-toggle': true, on: this.showLineNumbers }, 'data-tip': 'Line Numbers\nShow line numbers next to the text', 'aria-label': 'Line Numbers', onclick: () => ((this.showLineNumbers = !this.showLineNumbers), this.render(), this.area.drawHeader()) }, icon('te_linenumbers')),
        h('button', { class: { 'hdr-toggle': true, on: this.wordWrap }, 'data-tip': 'Word Wrap\nWrap words if there is not enough horizontal space', 'aria-label': 'Word Wrap', onclick: () => ((this.wordWrap = !this.wordWrap), this.render(), this.area.drawHeader()) }, icon('te_wordwrap')),
        h('button', { class: { 'hdr-toggle': true, on: this.syntax }, 'data-tip': 'Syntax Highlight\nSyntax highlight for scripting', 'aria-label': 'Syntax Highlight', onclick: () => ((this.syntax = !this.syntax), this.render(), this.area.drawHeader()) }, icon('te_syntax')),
      ),
    );
  }

  private idSelector(t: TextData | null): Child {
    const browse = h(
      'button',
      {
        class: 'hdr-toggle te-browse',
        'data-tip': 'Browse Text to be linked',
        'aria-label': 'Browse Text',
        onpointerdown: (e: PointerEvent) => {
          e.preventDefault();
          const texts = Object.values(app.doc.texts).sort((a, b) => a.name.localeCompare(b.name));
          openMenu(texts.length ? texts.map((x) => ({ label: x.name, icon: 'text', active: x.id === this.textId, action: () => this.setText(x.id) })) : [{ label: 'No texts', disabled: true }], e.currentTarget as HTMLElement);
        },
      },
      icon('text'),
      icon('down_arrow_hlt', 'tiny'),
    );
    if (!t)
      return h(
        'div',
        { class: 'te-id' },
        browse,
        h('button', { class: 'btn te-new', onclick: () => app.run('text.new', {}, { area: this.area }) }, icon('add'), 'New'),
        h('button', { class: 'btn te-open', onclick: () => app.run('text.open', {}, { area: this.area }) }, icon('file_folder'), 'Open'),
      );
    return h(
      'div',
      { class: 'te-id' },
      browse,
      textField('te-name', t.name, (v) => {
        const cur = this.text;
        if (!cur || !v.trim()) return;
        cur.name = uniqueName(app.doc.texts, v.trim(), cur.id);
        app.pushUndo('Rename Text');
        app.changed('doc');
      }),
      h('button', { class: 'hdr-toggle', 'data-tip': 'New Text\nCreate a new text data-block', 'aria-label': 'New Text', onclick: () => app.run('text.new', {}, { area: this.area }) }, icon('duplicate')),
      h('button', { class: 'hdr-toggle', 'data-tip': 'Unlink Text\nRemove this text data-block', 'aria-label': 'Unlink Text', onclick: () => app.run('text.unlink', {}, { area: this.area }) }, icon('x')),
    );
  }

  private viewMenu(): MenuItem[] {
    return [
      { label: 'Sidebar', shortcut: 'Ctrl T', checked: this.showSidebar, action: () => this.toggleSidebar() },
      { separator: true },
      { label: 'Line Numbers', checked: this.showLineNumbers, action: () => ((this.showLineNumbers = !this.showLineNumbers), this.render()) },
      { label: 'Word Wrap', checked: this.wordWrap, action: () => ((this.wordWrap = !this.wordWrap), this.render()) },
      { label: 'Syntax Highlight', checked: this.syntax, action: () => ((this.syntax = !this.syntax), this.render()) },
      { label: 'Highlight Line', checked: this.highlightLine, action: () => ((this.highlightLine = !this.highlightLine), this.updateCaret()) },
      { separator: true },
      { label: 'Zoom In', shortcut: 'Ctrl Wheel Up', op: 'wm.context_cycle_int', props: { data_path: 'space_data.font_size', reverse: false } },
      { label: 'Zoom Out', shortcut: 'Ctrl Wheel Down', op: 'wm.context_cycle_int', props: { data_path: 'space_data.font_size', reverse: true } },
      { separator: true },
      { label: 'Navigation', submenu: () => navItems('text.move') },
      { separator: true },
      { label: 'Area', submenu: () => this.area.areaMenu() },
    ];
  }

  private textMenu(): MenuItem[] {
    const t = this.text;
    const external = !!t && fileHandles.has(t.id);
    return [
      { label: 'New', icon: 'file_blank', shortcut: 'Alt N', op: 'text.new' },
      { label: 'Open…', icon: 'file_folder', shortcut: 'Alt O', op: 'text.open' },
      { label: 'Reload', shortcut: 'Alt R', op: 'text.reload' },
      { separator: true },
      { label: 'Save', shortcut: 'Alt S', op: 'text.save', disabled: !t },
      { label: 'Save As…', shortcut: 'Shift Ctrl Alt S', op: 'text.save_as', disabled: !t },
      ...(external ? [{ label: 'Make Internal', op: 'text.make_internal' } as MenuItem] : []),
      { separator: true },
      {
        label: 'Language',
        disabled: !t,
        submenu: () =>
          (['python', 'javascript', 'text'] as Lang[]).map((l) => ({
            label: l === 'python' ? 'Python' : l === 'javascript' ? 'JavaScript' : 'Plain Text',
            active: langOf(this.text) === l,
            action: () => this.setLanguage(l),
          })),
      },
      { separator: true },
      { label: 'Run Script', icon: 'play', shortcut: 'Alt P', op: 'text.run_script', disabled: !t },
      {
        label: 'Register',
        checked: !!t?.use_module,
        disabled: !t,
        description: 'Run this script when the project is opened (Preferences ▸ Save & Load ▸ Auto Run Scripts)',
        action: () => {
          if (!t) return;
          t.use_module = !t.use_module;
          app.pushUndo('Register Text');
          app.changed('ui');
        },
      },
      { separator: true },
      { label: 'Unlink', icon: 'x', op: 'text.unlink', disabled: !t },
    ];
  }

  private editMenu(): MenuItem[] {
    const t = !!this.text;
    return [
      { label: 'Undo', shortcut: 'Ctrl Z', disabled: !t, action: () => this.exec('undo') },
      { label: 'Redo', shortcut: 'Shift Ctrl Z', disabled: !t, action: () => this.exec('redo') },
      { separator: true },
      { label: 'Cut', shortcut: 'Ctrl X', op: 'text.cut' },
      { label: 'Copy', shortcut: 'Ctrl C', op: 'text.copy' },
      { label: 'Paste', shortcut: 'Ctrl V', op: 'text.paste' },
      { label: 'Duplicate Line', shortcut: 'Ctrl D', op: 'text.duplicate_line' },
      { separator: true },
      { label: 'Move Line(s) Up', shortcut: 'Shift Ctrl ↑', op: 'text.move_lines', props: { direction: 'UP' } },
      { label: 'Move Line(s) Down', shortcut: 'Shift Ctrl ↓', op: 'text.move_lines', props: { direction: 'DOWN' } },
      { separator: true },
      { label: 'Find & Replace…', shortcut: 'Ctrl F', op: 'text.start_find' },
      { label: 'Find Set Selected', shortcut: 'Ctrl G', op: 'text.find_set_selected' },
      { label: 'Find Next', op: 'text.find' },
      { label: 'Jump To…', shortcut: 'Ctrl J', op: 'text.jump' },
      { separator: true },
      { label: 'Text Autocomplete', shortcut: 'Tab', op: 'text.autocomplete' },
      { separator: true },
      {
        label: 'Text to 3D Object',
        disabled: !t,
        submenu: () => [
          { label: 'One Object', op: 'text.to_3d_object', props: { split_lines: false } },
          { label: 'One Object Per Line', op: 'text.to_3d_object', props: { split_lines: true } },
        ],
      },
    ];
  }

  private selectMenu(): MenuItem[] {
    return [
      { label: 'All', shortcut: 'Ctrl A', op: 'text.select_all' },
      { label: 'Line', shortcut: 'Shift Ctrl A', op: 'text.select_line' },
      { label: 'Word', shortcut: 'Double Click', op: 'text.select_word' },
      ...navItems('text.move_select'),
    ];
  }

  /** Right-click menu in the text. */
  contextMenu(): MenuItem[] {
    return [
      { label: 'Cut', shortcut: 'Ctrl X', op: 'text.cut' },
      { label: 'Copy', shortcut: 'Ctrl C', op: 'text.copy' },
      { label: 'Paste', shortcut: 'Ctrl V', op: 'text.paste' },
      { label: 'Duplicate Line', shortcut: 'Ctrl D', op: 'text.duplicate_line' },
      { separator: true },
      { label: 'Move Line(s) Up', shortcut: 'Shift Ctrl ↑', op: 'text.move_lines', props: { direction: 'UP' } },
      { label: 'Move Line(s) Down', shortcut: 'Shift Ctrl ↓', op: 'text.move_lines', props: { direction: 'DOWN' } },
      { separator: true },
      { label: 'Indent', shortcut: 'Tab', op: 'text.indent' },
      { label: 'Unindent', shortcut: 'Shift Tab', op: 'text.unindent' },
      { separator: true },
      { label: 'Toggle Comments', shortcut: 'Ctrl /', op: 'text.comment_toggle' },
      { separator: true },
      { label: 'Text Autocomplete', shortcut: 'Tab', op: 'text.autocomplete' },
    ];
  }

  private formatMenu(): MenuItem[] {
    const t = !!this.text;
    return [
      { label: 'Indent', shortcut: 'Tab', disabled: !t, op: 'text.indent' },
      { label: 'Unindent', shortcut: 'Shift Tab', disabled: !t, op: 'text.unindent' },
      { separator: true },
      { label: 'Toggle Comments', shortcut: 'Ctrl /', disabled: !t, op: 'text.comment_toggle' },
      { separator: true },
      {
        label: 'Convert Whitespace',
        disabled: !t,
        submenu: () => [
          { label: 'To Spaces', op: 'text.convert_whitespace', props: { type: 'SPACES' } },
          { label: 'To Tabs', op: 'text.convert_whitespace', props: { type: 'TABS' } },
        ],
      },
    ];
  }

  // ---------------------------------------------------------------- state

  private load() {
    if (this.textId && !app.doc.texts[this.textId]) this.textId = null;
    if (!this.textId) {
      const first = Object.values(app.doc.texts).sort((a, b) => a.name.localeCompare(b.name))[0];
      this.textId = first?.id ?? null;
    }
    const t = this.text;
    this.ta.value = t?.body ?? '';
    this.lastBody = this.ta.value;
    this.errorLine = null;
    this.conflict = false;
    this.closeAutocomplete();
    this.render();
    this.renderConflict();
  }

  setText(id: string | null) {
    this.commitUndo();
    this.textId = id;
    this.load();
    this.area.drawHeader();
    if (id) requestAnimationFrame(() => this.ta.focus());
  }

  private setLanguage(l: Lang) {
    const t = this.text;
    if (!t) return;
    t.language = l;
    app.pushUndo('Text Language');
    this.render();
    app.changed('ui');
  }

  update(kinds: Set<ChangeKind>) {
    if (!kinds.has('doc') && !kinds.has('ui')) return;
    if (this.textId && !app.doc.texts[this.textId]) {
      this.textId = null;
      this.load();
      return;
    }
    if (!this.textId && Object.keys(app.doc.texts).length) {
      this.load();
      return;
    }
    const t = this.text;
    const body = t?.body ?? '';
    if (body !== this.ta.value && body !== this.lastBody) {
      // changed outside the editor (undo, scripts, file load)
      const pos = this.ta.selectionStart;
      this.ta.value = body;
      this.lastBody = body;
      this.ta.selectionStart = this.ta.selectionEnd = Math.min(pos, body.length);
      this.render();
    } else if (kinds.has('ui')) this.renderSidebar();
  }

  private onInput() {
    const t = this.text;
    if (!t) return;
    this.refreshAutocomplete();
    t.body = this.ta.value;
    this.lastBody = t.body;
    this.dirtySincePush = true;
    this.errorLine = null;
    app.dirty = true;
    this.queueRender();
  }

  /** Push one global undo step for typing done since the last push (on blur / before runs). */
  commitUndo() {
    if (!this.dirtySincePush) return;
    this.dirtySincePush = false;
    app.pushUndo('Edit Text');
    app.changed('doc');
  }

  private queueRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  // ---------------------------------------------------------------- rendering

  private measure() {
    const c = document.createElement('canvas').getContext('2d');
    if (c) {
      c.font = `${settings.fontSize}px 'JetBrains Mono', ui-monospace, Menlo, monospace`;
      this.charWidth = c.measureText('0000000000').width / 10 || 7.2;
    }
    this.lineHeight = Math.round(settings.fontSize * 1.42);
    this.el.style.setProperty('--te-fs', `${settings.fontSize}px`);
    this.el.style.setProperty('--te-lh', `${this.lineHeight}px`);
    this.el.style.setProperty('--te-tab', String(settings.tabWidth));
  }

  /** Font size step (Ctrl wheel, Ctrl numpad +/-); shared by all Text Editors. */
  cycleFontSize(d: number) {
    this.zoom(d);
  }

  private zoom(d: number) {
    settings.fontSize = Math.max(8, Math.min(32, settings.fontSize + d));
    this.measure();
    this.render();
  }

  render() {
    const t = this.text;
    this.el.classList.toggle('no-text', !t);
    this.el.classList.toggle('wrap', this.wordWrap);
    this.el.classList.toggle('no-gutter', !this.showLineNumbers);
    this.ta.setAttribute('wrap', this.wordWrap ? 'soft' : 'off');
    if (!t) {
      patch(this.empty, h('div', { class: 'te-empty-msg' }, h('div', null, 'No text data-block'), h('div', { class: 'te-empty-btns' }, h('button', { class: 'btn', onclick: () => app.run('text.new', {}, { area: this.area }) }, icon('add'), 'New'), h('button', { class: 'btn', onclick: () => app.run('text.open', {}, { area: this.area }) }, icon('file_folder'), 'Open'))));
      this.renderFooter();
      this.renderSidebar();
      return;
    }
    const lines = highlightLines(this.ta.value, langOf(t), this.syntax);
    this.pre.innerHTML = lines.map((l, i) => `<div class="te-line${i + 1 === this.errorLine ? ' err' : ''}">${l || ' '}</div>`).join('');
    this.layout();
    this.renderSidebar();
  }

  private layout() {
    const t = this.text;
    if (!t) return;
    const lines = this.ta.value.split('\n');
    const lh = this.lineHeight;
    // size the textarea to its content so the outer container does the scrolling
    if (this.wordWrap) {
      this.content.style.width = '';
      this.ta.style.height = '0px';
      this.ta.style.height = `${Math.max(this.pre.scrollHeight, this.ta.scrollHeight)}px`;
    } else {
      const longest = lines.reduce((m, l) => Math.max(m, l.replace(/\t/g, ' '.repeat(settings.tabWidth)).length), 0);
      this.content.style.width = `max(100%, ${Math.ceil(longest * this.charWidth) + 40}px)`;
      this.ta.style.height = `${lines.length * lh + 8}px`;
    }
    // column guide
    this.marginEl.style.display = settings.showMargin ? '' : 'none';
    this.marginEl.style.left = `${6 + settings.marginColumn * this.charWidth}px`;
    // gutter numbers (match wrapped line heights)
    if (this.showLineNumbers) {
      const rows = this.pre.children;
      const digits = Math.max(2, String(lines.length).length);
      this.gutter.style.width = `${digits * this.charWidth + 16}px`;
      let html = '';
      for (let i = 0; i < lines.length; i++) {
        const hgt = this.wordWrap ? (rows[i] as HTMLElement | undefined)?.offsetHeight ?? lh : lh;
        html += `<div class="te-ln${i + 1 === this.errorLine ? ' err' : ''}" style="height:${hgt}px">${i + 1}</div>`;
      }
      this.gutter.innerHTML = html;
    } else this.gutter.innerHTML = '';
    this.updateCaret();
  }

  private caretLine() {
    const v = this.ta.value;
    const pos = this.ta.selectionStart;
    let line = 0;
    for (let i = 0; i < pos; i++) if (v.charCodeAt(i) === 10) line++;
    const col = pos - (v.lastIndexOf('\n', pos - 1) + 1);
    return { line, col };
  }

  updateCaret() {
    const { line, col } = this.caretLine();
    const row = this.pre.children[line] as HTMLElement | undefined;
    const show = this.highlightLine && !!row && this.ta.selectionStart === this.ta.selectionEnd;
    this.curLine.style.display = show ? '' : 'none';
    if (row) {
      this.curLine.style.top = `${row.offsetTop}px`;
      this.curLine.style.height = `${row.offsetHeight}px`;
    }
    this.gutter.querySelectorAll('.te-ln.cur').forEach((e) => e.classList.remove('cur'));
    (this.gutter.children[line] as HTMLElement | undefined)?.classList.add('cur');
    this.renderFooter(line, col);
  }

  private renderFooter(line?: number, col?: number) {
    const t = this.text;
    const fh = t ? fileHandles.get(t.id) : undefined;
    patch(this.footer, [
      h('span', { class: 'te-foot-file' }, t ? (fh ? `File: ${fh.name}` : 'Text: Internal') : ''),
      h('span', { class: 'hdr-spacer' }),
      t && this.overwrite ? h('span', { class: 'te-foot-ovr', 'data-tip': 'Overwrite\nTyping replaces characters (Insert toggles)' }, 'OVR') : null,
      t ? h('span', { class: 'te-foot-pos' }, `Ln ${(line ?? 0) + 1}, Col ${(col ?? 0) + 1}`) : null,
      t ? h('span', { class: 'te-foot-lang' }, langOf(t) === 'python' ? 'Python' : langOf(t) === 'javascript' ? 'JavaScript' : 'Plain Text') : null,
    ]);
  }

  // ---------------------------------------------------------------- sidebar (find & replace)

  toggleSidebar(force?: boolean) {
    this.showSidebar = force ?? !this.showSidebar;
    this.renderSidebar();
  }

  private renderSidebar() {
    this.el.classList.toggle('sidebar', this.showSidebar);
    if (!this.showSidebar) {
      patch(this.sidebarEl, []);
      return;
    }
    patch(this.sidebarEl, [
      h('div', { class: 'te-sb-tabs' }, h('button', { class: 'sb-tab on' }, 'Text')),
      h(
        'div',
        { class: 'te-sb-body' },
        panel('te-find', 'Find & Replace', () => [
          h(
            'div',
            { class: 'te-find-row' },
            h('label', { class: 'text-field te-find-field' }, icon('search'), h('input', { value: this.findText, placeholder: 'Find', spellcheck: 'false', 'aria-label': 'Find', ref: (el: HTMLInputElement) => this.findFocus && (requestAnimationFrame(() => (el.focus(), el.select())), (this.findFocus = false)), oninput: (e: Event) => (this.findText = (e.target as HTMLInputElement).value), onkeydown: (e: KeyboardEvent) => this.fieldKey(e, () => this.findNext()) })),
            h('button', { class: 'btn', onclick: () => this.findNext() }, 'Find Next'),
          ),
          h(
            'div',
            { class: 'te-find-row' },
            h('label', { class: 'text-field te-find-field' }, h('input', { value: this.replaceText, placeholder: 'Replace', spellcheck: 'false', 'aria-label': 'Replace', oninput: (e: Event) => (this.replaceText = (e.target as HTMLInputElement).value), onkeydown: (e: KeyboardEvent) => this.fieldKey(e, () => this.replaceOne()) })),
            h('button', { class: 'btn', onclick: () => this.replaceOne() }, 'Replace'),
          ),
          h('div', { class: 'te-find-row' }, h('button', { class: 'btn grow', onclick: () => this.replaceAll() }, 'Replace All')),
          h('div', { class: 'te-find-opts' }, checkbox('te-case', 'Match Case', settings.matchCase, (v) => ((settings.matchCase = v), this.renderSidebar())), checkbox('te-wrap', 'Wrap Around', settings.wrapAround, (v) => ((settings.wrapAround = v), this.renderSidebar())), checkbox('te-all', 'All Data-Blocks', settings.findAll, (v) => ((settings.findAll = v), this.renderSidebar()), { tip: 'All Data-Blocks\nFind Next continues in the other texts' })),
        ]),
        panel('te-props', 'Properties', () => [
          h('div', { class: 'te-prop' }, numberField({ id: 'te-tabw', label: 'Tab Width', value: settings.tabWidth, int: true, min: 1, max: 8, set: (v) => ((settings.tabWidth = Math.round(v)), this.measure(), this.render()) })),
          h('div', { class: 'te-prop' }, numberField({ id: 'te-fs', label: 'Font Size', value: settings.fontSize, int: true, min: 8, max: 32, set: (v) => ((settings.fontSize = Math.round(v)), this.measure(), this.render()) })),
          h('div', { class: 'te-prop' }, checkbox('te-margin', 'Margin', settings.showMargin, (v) => ((settings.showMargin = v), this.layout(), this.renderSidebar()))),
          h('div', { class: 'te-prop' }, numberField({ id: 'te-margin-col', label: 'Margin Column', value: settings.marginColumn, int: true, min: 1, max: 1024, disabled: !settings.showMargin, set: (v) => ((settings.marginColumn = Math.round(v)), this.layout()) })),
          h('div', { class: 'te-sb-label' }, 'Indentation'),
          h(
            'div',
            { class: 'enum-row' },
            h('button', { class: { on: !settings.useSpaces }, onclick: () => ((settings.useSpaces = false), this.renderSidebar()) }, 'Tabs'),
            h('button', { class: { on: settings.useSpaces }, onclick: () => ((settings.useSpaces = true), this.renderSidebar()) }, 'Spaces'),
          ),
        ]),
      ),
    ]);
  }

  /** Enter runs the action, Escape returns to the text; default handling is suppressed so focus changes don't leak keys. */
  private fieldKey(e: KeyboardEvent, onEnter: () => void) {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      onEnter();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.ta.focus();
    }
  }

  startFind() {
    const sel = this.ta.value.slice(this.ta.selectionStart, this.ta.selectionEnd);
    if (sel && !sel.includes('\n')) this.findText = sel;
    this.findFocus = true;
    this.toggleSidebar(true);
  }

  private matchAt(from: number, backwards = false): [number, number] | null {
    const q = this.findText;
    if (!q) return null;
    const hay = settings.matchCase ? this.ta.value : this.ta.value.toLowerCase();
    const needle = settings.matchCase ? q : q.toLowerCase();
    let i = backwards ? hay.lastIndexOf(needle, from) : hay.indexOf(needle, from);
    if (i < 0 && settings.wrapAround && !settings.findAll) i = backwards ? hay.lastIndexOf(needle) : hay.indexOf(needle);
    return i < 0 ? null : [i, i + q.length];
  }

  findNext() {
    if (!this.text) return;
    const m = this.matchAt(this.ta.selectionEnd);
    if (!m && settings.findAll && this.findInOtherTexts()) return;
    if (!m) {
      app.report('WARNING', `Text not found: ${this.findText}`);
      return;
    }
    this.ta.focus();
    this.ta.setSelectionRange(m[0], m[1]);
    this.revealCaret();
  }

  /** All Data-Blocks: open the next text (in name order, wrapping) that contains the search text. */
  private findInOtherTexts(): boolean {
    const q = settings.matchCase ? this.findText : this.findText.toLowerCase();
    if (!q) return false;
    const texts = Object.values(app.doc.texts).sort((a, b) => a.name.localeCompare(b.name));
    const cur = texts.findIndex((t) => t.id === this.textId);
    for (let k = 1; k <= texts.length; k++) {
      const t = texts[(cur + k) % texts.length];
      const body = settings.matchCase ? t.body : t.body.toLowerCase();
      const i = body.indexOf(q);
      if (i < 0) continue;
      if (t.id !== this.textId) this.setText(t.id);
      requestAnimationFrame(() => this.setCaret(i, i + q.length));
      return true;
    }
    return false;
  }

  private selectionMatches() {
    const sel = this.ta.value.slice(this.ta.selectionStart, this.ta.selectionEnd);
    return !!this.findText && (settings.matchCase ? sel === this.findText : sel.toLowerCase() === this.findText.toLowerCase());
  }

  replaceOne() {
    if (!this.text || !this.findText) return;
    if (this.selectionMatches()) this.insert(this.replaceText);
    this.findNext();
  }

  replaceAll() {
    const t = this.text;
    if (!t || !this.findText) return;
    const flags = settings.matchCase ? 'g' : 'gi';
    const re = new RegExp(this.findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    const count = (this.ta.value.match(re) ?? []).length;
    if (!count) {
      app.report('WARNING', `Text not found: ${this.findText}`);
      return;
    }
    this.ta.focus();
    this.ta.setSelectionRange(0, this.ta.value.length);
    this.insert(this.ta.value.replace(re, () => this.replaceText));
    app.report('INFO', `Replaced ${count} occurrence${count === 1 ? '' : 's'}`);
  }

  // ---------------------------------------------------------------- editing helpers

  private exec(cmd: 'undo' | 'redo') {
    this.ta.focus();
    document.execCommand(cmd);
  }

  /** Replace the selection keeping the browser's undo stack intact. */
  insert(text: string) {
    this.ta.focus();
    if (!document.execCommand('insertText', false, text)) {
      this.ta.setRangeText(text, this.ta.selectionStart, this.ta.selectionEnd, 'end');
      this.onInput();
    }
  }

  private async copy() {
    const s = this.ta.value.slice(this.ta.selectionStart, this.ta.selectionEnd);
    if (s) await navigator.clipboard?.writeText(s).catch(() => document.execCommand('copy'));
  }
  private async cut() {
    await this.copy();
    this.insert('');
  }
  private async paste() {
    try {
      const s = await navigator.clipboard.readText();
      this.insert(s);
    } catch {
      app.report('WARNING', 'Clipboard access was denied; use Ctrl V in the editor');
    }
  }

  setCaret(pos: number, end = pos) {
    this.ta.focus();
    this.ta.setSelectionRange(pos, end);
    this.revealCaret();
  }

  private revealCaret() {
    requestAnimationFrame(() => {
      const { line } = this.caretLine();
      const row = this.pre.children[line] as HTMLElement | undefined;
      if (!row) return;
      const top = row.offsetTop,
        bottom = top + row.offsetHeight;
      const sc = this.scroll;
      if (top < sc.scrollTop) sc.scrollTop = top - 4;
      else if (bottom > sc.scrollTop + sc.clientHeight) sc.scrollTop = bottom - sc.clientHeight + 4;
      this.updateCaret();
    });
  }

  private typedLine = { digits: '', t: 0 };

  /** Digits typed while the pointer is over the line numbers jump to that line. */
  private lineNumberKey(e: KeyboardEvent): boolean {
    if (!/^[0-9]$/.test(e.key) || e.ctrlKey || e.metaKey || e.altKey || !this.showLineNumbers) return false;
    const over = document.elementFromPoint(app.pointer.x, app.pointer.y);
    if (!over || !this.gutter.contains(over)) return false;
    e.preventDefault();
    const now = performance.now();
    this.typedLine.digits = (now - this.typedLine.t < 1000 ? this.typedLine.digits : '') + e.key;
    this.typedLine.t = now;
    this.goToLine(parseInt(this.typedLine.digits, 10));
    return true;
  }

  /** 0-based line index under a client y coordinate. */
  private lineAtY(y: number) {
    const rows = this.pre.children;
    const top = this.pre.getBoundingClientRect().top;
    const rel = y - top;
    let lo = 0,
      hi = rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((rows[mid] as HTMLElement).offsetTop <= rel) lo = mid;
      else hi = mid - 1;
    }
    return Math.max(0, lo);
  }

  /** Character offset where 0-based line `n` starts (past the end for n beyond the last line). */
  private lineStartPos(n: number) {
    const v = this.ta.value;
    let pos = 0;
    for (let i = 0; i < n; i++) {
      const nl = v.indexOf('\n', pos);
      if (nl < 0) return v.length + 1;
      pos = nl + 1;
    }
    return pos;
  }

  goToLine(n: number) {
    const lines = this.ta.value.split('\n');
    const ln = Math.max(1, Math.min(lines.length, Math.round(n)));
    let pos = 0;
    for (let i = 0; i < ln - 1; i++) pos += lines[i].length + 1;
    this.setCaret(pos);
  }

  /** Line range [start, end) covering the selection. */
  private lineRange() {
    const v = this.ta.value;
    const s = this.ta.selectionStart,
      e = this.ta.selectionEnd;
    const start = v.lastIndexOf('\n', s - 1) + 1;
    let endPos = e > s && v[e - 1] === '\n' ? e - 1 : e;
    let end = v.indexOf('\n', endPos);
    if (end < 0) end = v.length;
    return { start, end, text: v.slice(start, end) };
  }

  private indentUnit() {
    return settings.useSpaces ? ' '.repeat(settings.tabWidth) : '\t';
  }

  indent() {
    const s = this.ta.selectionStart,
      e = this.ta.selectionEnd;
    const v = this.ta.value;
    if (s === e || !v.slice(s, e).includes('\n')) {
      if (s === e) {
        const col = s - (v.lastIndexOf('\n', s - 1) + 1);
        this.insert(settings.useSpaces ? ' '.repeat(settings.tabWidth - (col % settings.tabWidth)) : '\t');
        return;
      }
    }
    const r = this.lineRange();
    const unit = this.indentUnit();
    const out = r.text
      .split('\n')
      .map((l) => (l.length ? unit + l : l))
      .join('\n');
    this.ta.setSelectionRange(r.start, r.end);
    this.insert(out);
    this.ta.setSelectionRange(r.start, r.start + out.length);
  }

  unindent() {
    const r = this.lineRange();
    const out = r.text
      .split('\n')
      .map((l) => {
        if (l.startsWith('\t')) return l.slice(1);
        const m = /^ +/.exec(l);
        return m ? l.slice(Math.min(m[0].length, settings.tabWidth)) : l;
      })
      .join('\n');
    if (out === r.text) return;
    this.ta.setSelectionRange(r.start, r.end);
    this.insert(out);
    this.ta.setSelectionRange(r.start, r.start + out.length);
  }

  toggleComment() {
    const lang = langOf(this.text);
    const mark = lang === 'javascript' ? '//' : '#';
    const r = this.lineRange();
    const lines = r.text.split('\n');
    const nonEmpty = lines.filter((l) => l.trim());
    const allCommented = nonEmpty.length > 0 && nonEmpty.every((l) => l.trimStart().startsWith(mark));
    const minIndent = Math.min(...nonEmpty.map((l) => /^\s*/.exec(l)![0].length), Infinity);
    const out = lines
      .map((l) => {
        if (!l.trim()) return l;
        if (allCommented) {
          const i = l.indexOf(mark);
          return l.slice(0, i) + l.slice(i + mark.length).replace(/^ /, '');
        }
        const k = Number.isFinite(minIndent) ? minIndent : 0;
        return `${l.slice(0, k)}${mark} ${l.slice(k)}`;
      })
      .join('\n');
    this.ta.setSelectionRange(r.start, r.end);
    this.insert(out);
    this.ta.setSelectionRange(r.start, r.start + out.length);
  }

  duplicateLine() {
    const r = this.lineRange();
    const caret = this.ta.selectionStart;
    this.ta.setSelectionRange(r.end, r.end);
    this.insert(`\n${r.text}`);
    this.ta.setSelectionRange(caret + r.text.length + 1, caret + r.text.length + 1);
  }

  moveLines(dir: 'UP' | 'DOWN') {
    const v = this.ta.value;
    const r = this.lineRange();
    const s = this.ta.selectionStart - r.start,
      e = this.ta.selectionEnd - r.start;
    if (dir === 'UP') {
      if (r.start === 0) return;
      const prevStart = v.lastIndexOf('\n', r.start - 2) + 1;
      const prev = v.slice(prevStart, r.start - 1);
      this.ta.setSelectionRange(prevStart, r.end);
      this.insert(`${r.text}\n${prev}`);
      this.ta.setSelectionRange(prevStart + s, prevStart + e);
    } else {
      if (r.end >= v.length) return;
      let nextEnd = v.indexOf('\n', r.end + 1);
      if (nextEnd < 0) nextEnd = v.length;
      const next = v.slice(r.end + 1, nextEnd);
      this.ta.setSelectionRange(r.start, nextEnd);
      this.insert(`${next}\n${r.text}`);
      const ns = r.start + next.length + 1;
      this.ta.setSelectionRange(ns + s, ns + e);
    }
  }

  convertWhitespace(type: 'SPACES' | 'TABS') {
    const unit = ' '.repeat(settings.tabWidth);
    const out = this.ta.value
      .split('\n')
      .map((l) => {
        const m = /^[ \t]*/.exec(l)![0];
        const width = [...m].reduce((w, c) => (c === '\t' ? w + settings.tabWidth - (w % settings.tabWidth) : w + 1), 0);
        const lead = type === 'SPACES' ? ' '.repeat(width) : '\t'.repeat(Math.floor(width / settings.tabWidth)) + ' '.repeat(width % settings.tabWidth);
        return lead + l.slice(m.length);
      })
      .join('\n');
    if (out === this.ta.value) return;
    const caret = this.ta.selectionStart;
    this.ta.focus();
    this.ta.setSelectionRange(0, this.ta.value.length);
    this.insert(out);
    this.ta.setSelectionRange(Math.min(caret, out.length), Math.min(caret, out.length));
    void unit;
  }

  selectAll() {
    this.setCaret(0, this.ta.value.length);
  }
  selectLine() {
    const r = this.lineRange();
    this.setCaret(r.start, r.end);
  }
  selectWord() {
    const v = this.ta.value;
    let s = this.ta.selectionStart,
      e = s;
    while (s > 0 && /\w/.test(v[s - 1])) s--;
    while (e < v.length && /\w/.test(v[e])) e++;
    this.setCaret(s, e);
  }

  /** Move the caret (or extend the selection) like the navigation keys. */
  moveCaret(type: MoveType, select: boolean) {
    const v = this.ta.value;
    const back = this.ta.selectionDirection === 'backward';
    const focus = back ? this.ta.selectionStart : this.ta.selectionEnd;
    const anchor = back ? this.ta.selectionEnd : this.ta.selectionStart;
    const page = Math.max(1, Math.floor(this.scroll.clientHeight / this.lineHeight) - 1);
    let from = focus;
    if (!select && this.ta.selectionStart !== this.ta.selectionEnd && (type === 'PREVIOUS_CHARACTER' || type === 'NEXT_CHARACTER')) {
      // collapsing a selection with left/right lands on its edge
      const p = type === 'PREVIOUS_CHARACTER' ? this.ta.selectionStart : this.ta.selectionEnd;
      return this.setCaret(p);
    }
    const to = movePos(v, from, type, page);
    from = to;
    this.ta.focus();
    if (select) this.ta.setSelectionRange(Math.min(anchor, to), Math.max(anchor, to), to < anchor ? 'backward' : 'forward');
    else this.ta.setSelectionRange(to, to);
    this.revealCaret();
  }

  /** Set the find text to the selection (or the word at the caret) and find the next match. */
  findSetSelected() {
    const v = this.ta.value;
    let sel = v.slice(this.ta.selectionStart, this.ta.selectionEnd);
    if (!sel) {
      const [s, e] = wordAt(v, this.ta.selectionStart);
      sel = v.slice(s, e);
    }
    if (sel && !sel.includes('\n')) this.findText = sel;
    this.renderSidebar();
    this.findNext();
  }

  toggleOverwrite() {
    this.overwrite = !this.overwrite;
    this.el.classList.toggle('overwrite', this.overwrite);
    this.updateCaret();
  }

  async cutSel() {
    await this.cut();
  }
  async copySel() {
    await this.copy();
  }
  async pasteClip() {
    await this.paste();
  }

  // ---------------------------------------------------------------- autocomplete

  /** Completion candidates for the identifier before the caret. */
  completions(): { word: string; items: string[] } {
    const before = this.ta.value.slice(0, this.ta.selectionStart);
    const prefix = completionPrefix(before);
    if (prefix.includes('.')) {
      try {
        const { word, matches } = jsComplete(before);
        const stem = word.slice(word.lastIndexOf('.') + 1);
        return { word: stem, items: matches.map((m) => m.slice(m.lastIndexOf('.') + 1)).filter((m) => m !== stem && !m.startsWith('_')) };
      } catch {
        return { word: '', items: [] };
      }
    }
    return { word: prefix, items: wordCandidates(this.ta.value, prefix, langOf(this.text)) };
  }

  /** Complete the word before the caret: insert a unique match, or show the choices. */
  autocomplete(): boolean {
    if (!this.text || this.ta.selectionStart !== this.ta.selectionEnd) return false;
    const { word, items } = this.completions();
    if (!items.length) {
      this.closeAutocomplete();
      return false;
    }
    if (items.length === 1) {
      this.ta.focus();
      this.insert(items[0].slice(word.length));
      this.closeAutocomplete();
      return true;
    }
    // extend to the common prefix, then list the choices
    let common = items[0];
    for (const it of items) while (!it.startsWith(common)) common = common.slice(0, -1);
    if (common.length > word.length) this.insert(common.slice(word.length));
    this.openAutocomplete(items, this.ta.selectionStart - Math.max(word.length, common.length));
    return true;
  }

  private openAutocomplete(items: string[], start: number) {
    this.acItems = items;
    this.acIndex = 0;
    this.acStart = start;
    this.drawAutocomplete();
  }

  closeAutocomplete() {
    if (this.acStart < 0) return;
    this.acStart = -1;
    this.acItems = [];
    this.acEl.style.display = 'none';
  }

  /** Narrow the open list as the user keeps typing. */
  private refreshAutocomplete() {
    if (this.acStart < 0) return;
    const pos = this.ta.selectionStart;
    const typed = this.ta.value.slice(this.acStart, pos);
    if (pos < this.acStart || !/^[\w$]*$/.test(typed)) return this.closeAutocomplete();
    const { items } = this.completions();
    if (!items.length) return this.closeAutocomplete();
    this.acItems = items;
    this.acIndex = Math.min(this.acIndex, items.length - 1);
    this.drawAutocomplete();
  }

  private acceptAutocomplete() {
    const it = this.acItems[this.acIndex];
    if (!it) return this.closeAutocomplete();
    const pos = this.ta.selectionStart;
    this.ta.setSelectionRange(this.acStart, pos);
    this.insert(it);
    this.closeAutocomplete();
  }

  private drawAutocomplete() {
    const v = this.ta.value;
    const pos = this.acStart;
    const line = v.slice(0, pos).split('\n').length - 1;
    const col = pos - lineStart(v, pos);
    const row = this.pre.children[line] as HTMLElement | undefined;
    const mainR = this.main.getBoundingClientRect();
    const contR = this.content.getBoundingClientRect();
    const x = contR.left - mainR.left + 6 + col * this.charWidth;
    const y = (row ? row.offsetTop + row.offsetHeight : (line + 1) * this.lineHeight) + contR.top - mainR.top + 2;
    this.acEl.style.display = 'block';
    this.acEl.style.left = `${Math.max(0, Math.min(this.main.clientWidth - 220, x))}px`;
    this.acEl.style.top = `${Math.min(y, this.main.clientHeight - 40)}px`;
    patch(
      this.acEl,
      this.acItems.slice(0, 40).map((it, i) =>
        h(
          'div',
          {
            key: it,
            class: { 'te-ac-item': true, hl: i === this.acIndex },
            role: 'option',
            'aria-selected': i === this.acIndex ? 'true' : 'false',
            onpointerdown: (e: PointerEvent) => {
              e.preventDefault();
              this.acIndex = i;
              this.acceptAutocomplete();
            },
          },
          it,
        ),
      ),
    );
    (this.acEl.children[this.acIndex] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }

  private acKey(e: KeyboardEvent): boolean {
    if (this.acStart < 0) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const n = Math.min(40, this.acItems.length);
      this.acIndex = (this.acIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      this.drawAutocomplete();
    } else if (e.key === 'Enter' || e.key === 'Tab') this.acceptAutocomplete();
    else if (e.key === 'Escape') this.closeAutocomplete();
    else return false;
    e.preventDefault();
    return true;
  }

  // ---------------------------------------------------------------- external file

  /** Reload the text from its file on disk. */
  async reload(): Promise<boolean> {
    const t = this.text;
    const fh = t ? fileHandles.get(t.id) : undefined;
    if (!t || !fh) {
      app.report('WARNING', 'This text is not linked to a file on disk');
      return false;
    }
    try {
      const file = await fh.getFile();
      const body = (await file.text()).replace(/\r\n?/g, '\n');
      fileTimes.set(t.id, file.lastModified);
      this.conflict = false;
      this.ta.focus();
      this.ta.setSelectionRange(0, this.ta.value.length);
      this.insert(body);
      this.ta.setSelectionRange(0, 0);
      this.commitUndo();
      this.renderConflict();
      app.report('INFO', `Reloaded "${fh.name}"`);
      return true;
    } catch (e) {
      app.report('ERROR', `Could not reload: ${(e as Error)?.message ?? e}`);
      return false;
    }
  }

  /** Detect a change of the linked file on disk (on focus). */
  async checkConflict() {
    const t = this.text;
    const fh = t ? fileHandles.get(t.id) : undefined;
    if (!t || !fh) return;
    try {
      const f = await fh.getFile();
      const known = fileTimes.get(t.id) ?? f.lastModified;
      const changed = f.lastModified > known;
      if (changed !== this.conflict) {
        this.conflict = changed;
        this.renderConflict();
      }
    } catch {
      // permission revoked or file gone: nothing to compare against
    }
  }

  resolveConflict(how: 'RELOAD' | 'SAVE' | 'MAKE_INTERNAL' | 'IGNORE') {
    const t = this.text;
    if (!t) return;
    if (how === 'RELOAD') void this.reload();
    else if (how === 'SAVE') void saveText(this, false);
    else if (how === 'MAKE_INTERNAL') {
      fileHandles.delete(t.id);
      fileTimes.delete(t.id);
      this.renderFooter();
    } else void fileHandles.get(t.id)?.getFile().then((f) => fileTimes.set(t.id, f.lastModified));
    this.conflict = false;
    this.renderConflict();
  }

  private renderConflict() {
    const t = this.text;
    const fh = t ? fileHandles.get(t.id) : undefined;
    this.conflictEl.style.display = this.conflict && fh ? 'flex' : 'none';
    if (!this.conflict || !fh) return patch(this.conflictEl, []);
    patch(this.conflictEl, [
      icon('error'),
      h('span', { class: 'grow' }, `"${fh.name}" was changed on disk`),
      h('button', { class: 'btn', onclick: () => this.resolveConflict('RELOAD') }, 'Reload from Disk'),
      h('button', { class: 'btn', onclick: () => this.resolveConflict('SAVE') }, 'Save over It'),
      h('button', { class: 'btn', onclick: () => this.resolveConflict('MAKE_INTERNAL') }, 'Make Internal'),
      h('button', { class: 'btn', onclick: () => this.resolveConflict('IGNORE') }, 'Ignore'),
    ]);
  }

  private newlineWithIndent() {
    const v = this.ta.value;
    const s = this.ta.selectionStart;
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    const before = v.slice(lineStart, s);
    let lead = /^[ \t]*/.exec(before)![0];
    const trimmed = before.trimEnd();
    const lang = langOf(this.text);
    if ((lang === 'python' && trimmed.endsWith(':')) || (lang === 'javascript' && /[{([]$/.test(trimmed))) lead += this.indentUnit();
    if (lang === 'python' && /^\s*(return|pass|break|continue|raise)\b/.test(before) && lead.length) lead = lead.slice(0, Math.max(0, lead.length - this.indentUnit().length));
    this.insert(`\n${lead}`);
  }

  private smartBackspace(): boolean {
    if (!settings.useSpaces || this.ta.selectionStart !== this.ta.selectionEnd) return false;
    const v = this.ta.value;
    const s = this.ta.selectionStart;
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    const before = v.slice(lineStart, s);
    if (!before.length || /[^ ]/.test(before)) return false;
    const n = before.length % settings.tabWidth || settings.tabWidth;
    this.ta.setSelectionRange(s - n, s);
    this.insert('');
    return true;
  }

  /** Auto-close: insert the closing character, wrap a selection, or step over a closing character. */
  private autoClosePair(key: string): boolean {
    const ta = this.ta;
    const s = ta.selectionStart,
      e = ta.selectionEnd;
    const next = ta.value[e] ?? '';
    const closers = new Set(Object.values(PAIRS));
    if (closers.has(key) && s === e && next === key) {
      ta.setSelectionRange(s + 1, s + 1);
      this.updateCaret();
      return true;
    }
    const close = PAIRS[key];
    if (!close) return false;
    const sel = ta.value.slice(s, e);
    // quotes only pair up at word boundaries (not inside words like it's)
    if ((key === '"' || key === "'") && !sel && /[\w]/.test(ta.value[s - 1] ?? '')) return false;
    if (!sel && next && /[\w]/.test(next)) return false;
    this.insert(key + sel + close);
    ta.setSelectionRange(s + 1, s + 1 + sel.length);
    this.updateCaret();
    return true;
  }

  // ---------------------------------------------------------------- keys

  private onKeyDown(e: KeyboardEvent) {
    e.stopPropagation();
    if (redirectIfElsewhere(e, this.area, this.ta)) return;
    if (this.acKey(e)) return;
    if (this.lineNumberKey(e)) return;
    // Text keymap (editable in Preferences ▸ Keymap) and window shortcuts
    if (dispatchEditorKeys(e, this.area, ['Text'], () => this.commitUndo())) return;
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (e.shiftKey) this.unindent();
      else {
        // Tab right after a word completes it; elsewhere it indents
        const p = this.ta.selectionStart;
        const prev = this.ta.value[p - 1];
        if (p === this.ta.selectionEnd && prev && /[\w$.]/.test(prev) && this.autocomplete()) return;
        this.indent();
      }
      return;
    }
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      this.newlineWithIndent();
      return;
    }
    if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey && this.smartBackspace()) {
      e.preventDefault();
      return;
    }
    if (settings.autoClose && !e.ctrlKey && !e.metaKey && !e.altKey && this.autoClosePair(e.key)) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      this.ta.blur();
      return;
    }
  }

  onKey(e: KeyboardEvent): boolean {
    // keys while hovering the editor without focus in the text area
    if (e.key === 'Escape' && this.showSidebar && document.activeElement?.closest('.te-sidebar')) {
      this.ta.focus();
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- templates / run

  openTemplate(tpl: (typeof templates)[number]) {
    const t = newText(uniqueName(app.doc.texts, tpl.file), tpl.body, tpl.language);
    app.doc.texts[t.id] = t;
    app.pushUndo('New Text from Template');
    this.setText(t.id);
    app.changed('doc');
  }

  async run(): Promise<RunResult | null> {
    const t = this.text;
    if (!t) return null;
    t.body = this.ta.value;
    this.commitUndo();
    const res = await runText(t);
    this.errorLine = res.ok ? null : res.line ?? null;
    this.render();
    if (!res.ok && res.line) this.goToLine(res.line);
    return res;
  }

  serialize() {
    return { text: this.textId, lineNumbers: this.showLineNumbers, wrap: this.wordWrap, syntax: this.syntax, sidebar: this.showSidebar };
  }

  resize() {
    this.layout();
  }

  dispose() {
    this.commitUndo();
    this.resizeObs.disconnect();
    document.removeEventListener('selectionchange', this.onSelectionChange);
    removeEventListener('focus', this.onWindowFocus);
  }
}

function div(cls: string) {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

export function templateMenu(open: (t: (typeof templates)[number]) => void): MenuItem[] {
  return [
    { heading: 'Python' },
    ...templates.filter((t) => t.language === 'python').map((t) => ({ label: t.name, icon: 'file_script', action: () => open(t) })),
    { separator: true },
    { heading: 'JavaScript' },
    ...templates.filter((t) => t.language === 'javascript').map((t) => ({ label: t.name, icon: 'file_script', action: () => open(t) })),
  ];
}

/** Run a text data-block in its language; reports errors (with line numbers) to Info and the status bar. */
export async function runText(t: TextData): Promise<RunResult> {
  let res: RunResult;
  if (t.language === 'javascript') res = runJavaScript(t.body, t.name);
  else if (t.language === 'text') {
    app.report('WARNING', `"${t.name}" is plain text; set Text ▸ Language to Python or JavaScript to run it`);
    return { ok: false, error: 'not a script' };
  } else {
    try {
      if (!python.ready) app.report('INFO', 'Loading Python runtime…');
      await loadPython();
    } catch (e) {
      app.report('ERROR', (e as Error).message);
      return { ok: false, error: (e as Error).message };
    }
    res = runPythonText(t.body, t.name);
  }
  if (!res.ok) {
    const where = res.line ? ` line ${res.line}` : '';
    app.report('ERROR', `${t.name}${where}: ${res.error}`);
    if (res.traceback && t.language === 'python') output.push(res.traceback, 'ERROR');
    else output.push(`${t.name}${where}: ${res.error}`, 'ERROR');
  }
  return res;
}

const python = {
  get ready() {
    return pythonLoaded();
  },
};
import { pythonReady as pythonLoaded } from './python';

// ---------------------------------------------------------------------------
// operators & keymap

const textArea = (ctx: OpContext) => (ctx.area?.type === 'TEXT' ? (ctx.area.editor as TextEditor) : null);
const withText = (ctx: OpContext) => {
  const ed = textArea(ctx);
  return ed && ed.text ? ed : null;
};

registerOperators([
  {
    idname: 'text.new',
    label: 'New Text',
    description: 'Create a new text data-block',
    exec: (ctx) => {
      const t = newText(uniqueName(app.doc.texts, 'Text'), '', 'python');
      app.doc.texts[t.id] = t;
      const ed = textArea(ctx);
      if (ed) {
        ed.textId = t.id;
        requestAnimationFrame(() => ed.setText(t.id));
      }
    },
  },
  {
    idname: 'text.open',
    label: 'Open Text',
    description: 'Open a text file from disk',
    undo: false,
    exec: (ctx) => {
      const ed = textArea(ctx);
      const picker = (window as unknown as { showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]> }).showOpenFilePicker;
      let handle: FileSystemFileHandle | undefined;
      const pick: Promise<File | null> = picker
        ? picker({ types: [{ description: 'Text', accept: { 'text/plain': ['.py', '.js', '.mjs', '.txt', '.json', '.md', '.glsl', '.osl'] } }] }).then(
            async ([h]) => ((handle = h), await h.getFile()),
            (e) => (e?.name === 'AbortError' ? null : pickFile('.py,.js,.mjs,.txt,.json,.md,.glsl,text/*')),
          )
        : pickFile('.py,.js,.mjs,.txt,.json,.md,.glsl,text/*');
      void pick.then(async (file) => {
        if (!file) return;
        if (file.size > 8 * 1024 * 1024) {
          app.report('ERROR', `${file.name} is too large to open as text`);
          return;
        }
        const body = (await file.text()).replace(/\r\n?/g, '\n');
        const t = newText(uniqueName(app.doc.texts, file.name), body, langFromName(file.name));
        app.doc.texts[t.id] = t;
        if (handle) {
          fileHandles.set(t.id, handle);
          fileTimes.set(t.id, file.lastModified);
        }
        app.pushUndo('Open Text');
        ed?.setText(t.id);
        app.changed('doc');
      });
    },
  },
  {
    idname: 'text.save',
    label: 'Save Text',
    description: 'Save the active text to a file on disk',
    undo: false,
    poll: (ctx) => !!withText(ctx),
    exec: (ctx) => void saveText(withText(ctx)!, false),
  },
  {
    idname: 'text.save_as',
    label: 'Save Text As',
    description: 'Save the active text to a new file on disk',
    undo: false,
    poll: (ctx) => !!withText(ctx),
    exec: (ctx) => void saveText(withText(ctx)!, true),
  },
  {
    idname: 'text.unlink',
    label: 'Unlink Text',
    description: 'Remove the active text data-block',
    poll: (ctx) => !!withText(ctx),
    exec: (ctx) => {
      const ed = withText(ctx)!;
      const id = ed.textId!;
      delete app.doc.texts[id];
      fileHandles.delete(id);
      ed.setText(Object.values(app.doc.texts)[0]?.id ?? null);
    },
  },
  {
    idname: 'text.run_script',
    label: 'Run Script',
    description: 'Run the active text as a Python or JavaScript script',
    undo: false,
    poll: (ctx) => !!withText(ctx),
    exec: (ctx) => void withText(ctx)!.run(),
  },
  { idname: 'text.start_find', label: 'Find & Replace', description: 'Open the Find & Replace panel', undo: false, poll: (ctx) => !!withText(ctx), exec: (ctx) => withText(ctx)!.startFind() },
  { idname: 'text.find', label: 'Find Next', description: 'Find the next occurrence of the search text', undo: false, poll: (ctx) => !!withText(ctx), exec: (ctx) => withText(ctx)!.findNext() },
  { idname: 'text.replace', label: 'Replace', description: 'Replace the current match and find the next one', undo: false, poll: (ctx) => !!withText(ctx), exec: (ctx) => withText(ctx)!.replaceOne() },
  {
    idname: 'text.jump',
    label: 'Jump To Line',
    description: 'Jump to a line number',
    undo: false,
    poll: (ctx) => !!withText(ctx),
    exec: (ctx) => {
      const ed = withText(ctx)!;
      promptText('Jump to Line', '', (v) => {
        const n = parseInt(v, 10);
        if (Number.isFinite(n)) requestAnimationFrame(() => ed.goToLine(n));
      });
    },
  },
  { idname: 'text.indent', label: 'Indent', description: 'Indent the selected lines', undo: false, poll: (ctx) => !!withText(ctx), exec: (ctx) => withText(ctx)!.indent() },
  { idname: 'text.unindent', label: 'Unindent', description: 'Unindent the selected lines', undo: false, poll: (ctx) => !!withText(ctx), exec: (ctx) => withText(ctx)!.unindent() },
  { idname: 'text.comment_toggle', label: 'Toggle Comments', description: 'Comment or uncomment the selected lines', undo: false, poll: (ctx) => !!withText(ctx), exec: (ctx) => withText(ctx)!.toggleComment() },
  { idname: 'text.duplicate_line', label: 'Duplicate Line', description: 'Duplicate the current line', undo: false, poll: (ctx) => !!withText(ctx), exec: (ctx) => withText(ctx)!.duplicateLine() },
  {
    idname: 'text.move_lines',
    label: 'Move Lines',
    description: 'Move the selected lines up or down',
    undo: false,
    props: [{ id: 'direction', label: 'Direction', type: 'enum', default: 'DOWN', items: [['UP', 'Up'], ['DOWN', 'Down']] }],
    poll: (ctx) => !!withText(ctx),
    exec: (ctx, p) => withText(ctx)!.moveLines(p.direction as 'UP' | 'DOWN'),
  },
  {
    idname: 'text.convert_whitespace',
    label: 'Convert Whitespace',
    description: 'Convert indentation to spaces or tabs',
    undo: false,
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'SPACES', items: [['SPACES', 'To Spaces'], ['TABS', 'To Tabs']] }],
    poll: (ctx) => !!withText(ctx),
    exec: (ctx, p) => withText(ctx)!.convertWhitespace(p.type as 'SPACES'),
  },
  { idname: 'text.toggle_sidebar', label: 'Toggle Sidebar', description: 'Show or hide the Text Editor sidebar', undo: false, poll: (ctx) => !!textArea(ctx), exec: (ctx) => textArea(ctx)!.toggleSidebar() },
  { idname: 'text.find_set_selected', label: 'Find Set Selected', description: 'Search for the selected text (or the word at the caret) and find its next occurrence', undo: false, poll: (ctx) => !!withText(ctx), exec: (ctx) => withText(ctx)!.findSetSelected() },
  { idname: 'text.cut', label: 'Cut', description: 'Cut the selected text to the clipboard', undo: false, poll: (ctx) => !!withText(ctx), exec: (ctx) => void withText(ctx)!.cutSel() },
  { idname: 'text.copy', label: 'Copy', description: 'Copy the selected text to the clipboard', undo: false, poll: (ctx) => !!withText(ctx), exec: (ctx) => void withText(ctx)!.copySel() },
  { idname: 'text.paste', label: 'Paste', description: 'Paste text from the clipboard', undo: false, poll: (ctx) => !!withText(ctx), exec: (ctx) => void withText(ctx)!.pasteClip() },
  { idname: 'text.select_all', label: 'Select All', description: 'Select all text', undo: false, poll: (ctx) => !!withText(ctx), exec: (ctx) => withText(ctx)!.selectAll() },
  { idname: 'text.select_line', label: 'Select Line', description: 'Select the lines of the caret or selection', undo: false, poll: (ctx) => !!withText(ctx), exec: (ctx) => withText(ctx)!.selectLine() },
  { idname: 'text.select_word', label: 'Select Word', description: 'Select the word at the caret', undo: false, poll: (ctx) => !!withText(ctx), exec: (ctx) => withText(ctx)!.selectWord() },
  {
    idname: 'text.move',
    label: 'Move Cursor',
    description: 'Move the caret to a position (line begin/end, word, line, page, file top/bottom)',
    undo: false,
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'LINE_BEGIN', items: MOVE_TYPES }],
    poll: (ctx) => !!withText(ctx),
    exec: (ctx, p) => withText(ctx)!.moveCaret(p.type as MoveType, false),
  },
  {
    idname: 'text.move_select',
    label: 'Move Select',
    description: 'Extend the selection to a position (line begin/end, word, line, page, file top/bottom)',
    undo: false,
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'LINE_BEGIN', items: MOVE_TYPES }],
    poll: (ctx) => !!withText(ctx),
    exec: (ctx, p) => withText(ctx)!.moveCaret(p.type as MoveType, true),
  },
  { idname: 'text.overwrite_toggle', label: 'Toggle Overwrite', description: 'Typing replaces the characters after the caret instead of inserting', undo: false, poll: (ctx) => !!withText(ctx), exec: (ctx) => withText(ctx)!.toggleOverwrite() },
  { idname: 'text.autocomplete', label: 'Text Autocomplete', description: 'Complete the word before the caret from the text, keywords and the scripting API', undo: false, poll: (ctx) => !!withText(ctx), exec: (ctx) => void withText(ctx)!.autocomplete() },
  {
    idname: 'text.reload',
    label: 'Reload',
    description: 'Reload the text from its file on disk',
    undo: false,
    poll: (ctx) => !!withText(ctx) && fileHandles.has(withText(ctx)!.textId!),
    exec: (ctx) => void withText(ctx)!.reload(),
  },
  {
    idname: 'text.make_internal',
    label: 'Make Internal',
    description: 'Keep the text only in the project, no longer linked to its file on disk',
    undo: false,
    poll: (ctx) => !!withText(ctx) && fileHandles.has(withText(ctx)!.textId!),
    exec: (ctx) => withText(ctx)!.resolveConflict('MAKE_INTERNAL'),
  },
  {
    idname: 'text.resolve_conflict',
    label: 'Resolve Conflict',
    description: 'When the file changed on disk: reload it, save over it, or make the text internal',
    undo: false,
    props: [{ id: 'resolution', label: 'Resolution', type: 'enum', default: 'IGNORE', items: [['IGNORE', 'Ignore'], ['RELOAD', 'Reload'], ['SAVE', 'Save'], ['MAKE_INTERNAL', 'Make Internal']] }],
    poll: (ctx) => !!withText(ctx) && fileHandles.has(withText(ctx)!.textId!),
    exec: (ctx, p) => withText(ctx)!.resolveConflict(p.resolution as 'IGNORE'),
  },
  {
    idname: 'text.to_3d_object',
    label: 'Text to 3D Object',
    description: 'Create a text object from the active text, or one per line',
    props: [
      { id: 'split_lines', label: 'Split Lines', type: 'bool', default: false },
      { id: 'text', label: 'Text', type: 'string', default: '', hidden: true },
    ],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && (!!withText(ctx) || Object.keys(ctx.doc.texts).length > 0),
    invoke: (ctx, p) => {
      // remember the text so Adjust Last Operation can run again from any editor
      p.text = withText(ctx)?.textId ?? p.text;
      return textTo3D(ctx, p);
    },
    exec: (ctx, p) => textTo3D(ctx, p),
  },
  {
    idname: 'wm.context_cycle_int',
    label: 'Context Int Cycle',
    description: 'Step an integer setting of the editor under the pointer (e.g. the font size)',
    undo: false,
    internal: true,
    props: [
      { id: 'data_path', label: 'Data Path', type: 'string', default: 'space_data.font_size' },
      { id: 'reverse', label: 'Reverse', type: 'bool', default: false },
    ],
    poll: (ctx) => !!(ctx.area?.editor as { cycleFontSize?: unknown } | undefined)?.cycleFontSize,
    exec: (ctx, p) => {
      if (p.data_path !== 'space_data.font_size') return 'CANCELLED';
      (ctx.area!.editor as { cycleFontSize(d: number): void }).cycleFontSize(p.reverse ? -1 : 1);
    },
  },
]);

addKeys('Text', [
  { key: 'P', alt: true, op: 'text.run_script' },
  { key: 'N', alt: true, op: 'text.new' },
  { key: 'O', alt: true, op: 'text.open' },
  { key: 'S', alt: true, op: 'text.save' },
  { key: 'S', shift: true, ctrl: true, alt: true, op: 'text.save_as' },
  { key: 'F', ctrl: true, op: 'text.start_find' },
  { key: 'H', ctrl: true, op: 'text.replace' },
  { key: 'J', ctrl: true, op: 'text.jump' },
  { key: 'SLASH', ctrl: true, op: 'text.comment_toggle' },
  { key: 'D', ctrl: true, op: 'text.duplicate_line' },
  { key: 'G', ctrl: true, op: 'text.find_set_selected' },
  { key: 'R', alt: true, op: 'text.reload' },
  { key: 'INSERT', op: 'text.overwrite_toggle' },
  { key: 'HOME', op: 'text.move', props: { type: 'LINE_BEGIN' } },
  { key: 'END', op: 'text.move', props: { type: 'LINE_END' } },
  { key: 'HOME', shift: true, op: 'text.move_select', props: { type: 'LINE_BEGIN' } },
  { key: 'END', shift: true, op: 'text.move_select', props: { type: 'LINE_END' } },
  { key: 'HOME', ctrl: true, op: 'text.move', props: { type: 'FILE_TOP' } },
  { key: 'END', ctrl: true, op: 'text.move', props: { type: 'FILE_BOTTOM' } },
  { key: 'HOME', shift: true, ctrl: true, op: 'text.move_select', props: { type: 'FILE_TOP' } },
  { key: 'END', shift: true, ctrl: true, op: 'text.move_select', props: { type: 'FILE_BOTTOM' } },
  { key: 'A', shift: true, ctrl: true, op: 'text.select_line' },
  { key: 'NUMPAD_PLUS', ctrl: true, op: 'wm.context_cycle_int', props: { data_path: 'space_data.font_size', reverse: false } },
  { key: 'NUMPAD_MINUS', ctrl: true, op: 'wm.context_cycle_int', props: { data_path: 'space_data.font_size', reverse: true } },
  { key: 'UP_ARROW', shift: true, ctrl: true, op: 'text.move_lines', props: { direction: 'UP' } },
  { key: 'DOWN_ARROW', shift: true, ctrl: true, op: 'text.move_lines', props: { direction: 'DOWN' } },
  { key: 'T', ctrl: true, op: 'text.toggle_sidebar' },
]);

/** Text to 3D Object: one text object, or one per non-empty line, at the 3D cursor. */
function textTo3D(ctx: OpContext, p: Record<string, unknown>): 'FINISHED' | 'CANCELLED' {
  const t = ctx.doc.texts[String(p.text)] ?? withText(ctx)?.text;
  if (!t) return 'CANCELLED';
  const lines = p.split_lines ? t.body.split('\n') : [t.body];
  const cursor = ctx.doc.scene.cursor.location;
  for (const ob of Object.values(ctx.doc.objects)) ob.select = false;
  let made = 0;
  lines.forEach((line, i) => {
    if (p.split_lines && !line.trim()) return;
    const cu = newCurve(uniqueDataName(ctx.doc, t.name.replace(/\.[a-z0-9]+$/i, ''), 'curves'));
    cu.dimensions = '2D';
    cu.body = line;
    cu.size = 1;
    cu.fill_mode = 'BOTH';
    cu.align_x = 'LEFT';
    cu.align_y = 'TOP_BASELINE' as never;
    cu.space_line = 1;
    cu.space_character = 1;
    ctx.doc.curves[cu.id] = cu;
    const ob = newObject(cu.name, 'FONT', cu.id);
    addObjectToScene(ctx.doc, ob, { location: [cursor[0], cursor[1] - i * 1.2, cursor[2]] });
    made++;
  });
  if (!made) return 'CANCELLED';
  return 'FINISHED';
}

async function saveText(ed: TextEditor, saveAs: boolean) {
  const t = ed.text;
  if (!t) return;
  const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  const ext = t.language === 'javascript' ? '.js' : t.language === 'python' ? '.py' : '.txt';
  const name = /\.[a-z0-9]+$/i.test(t.name) ? t.name : `${t.name}${ext}`;
  try {
    if (picker) {
      let handle = saveAs ? undefined : fileHandles.get(t.id);
      if (!handle) {
        handle = await picker({ suggestedName: name, types: [{ description: 'Script', accept: { 'text/plain': ['.py', '.js', '.txt'] } }] });
        fileHandles.set(t.id, handle);
      }
      const w = await (handle as unknown as { createWritable(): Promise<{ write(s: string): Promise<void>; close(): Promise<void> }> }).createWritable();
      await w.write(t.body);
      await w.close();
      fileTimes.set(t.id, (await handle.getFile()).lastModified);
      ed.conflict = false;
      app.report('INFO', `Saved "${handle.name}"`);
    } else {
      download(t.body, name, 'text/plain');
      app.report('INFO', `Saved "${name}" to downloads`);
    }
    ed.render();
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') return;
    app.report('ERROR', `Could not save text: ${(e as Error)?.message ?? e}`);
  }
}

registerEditor({ id: 'TEXT', label: 'Text Editor', icon: 'text', group: 'Scripting', create: (a, s) => new TextEditor(a, s) });
