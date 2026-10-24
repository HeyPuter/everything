// The assistant sidebar: the conversation, the steps the assistant takes in
// the scene, and the message box. Each message's changes become one undo step
// ("Assistant: …") that the reply's Undo button reverts. Ported from
// Parametric's assistant panel.

import { app } from '../app/app';
import { prefs } from '../app/prefs';
import { clearScriptFiles } from '../scripting/files';
import { iconEl } from '../ui/icons';
import { type Agent, type ExchangeResult, type Step, createAgent } from './agent';
import { type ChatFn } from './ai';
import { ATTACH_ACCEPT, type Attachment, MAX_ATTACHMENTS, attachmentKind, attachmentProblem, attachmentsTooLarge, formatSize, offerImages } from './attach';
import { readAttachment } from './attachments';
import { viewportUI } from './capture';
import { copilotChat, copilotStatus } from './copilot';
import { renderMarkdown } from './markdown';
import { SYSTEM_PROMPT, sceneSnapshot } from './prompt';
import { type AssistantHost, runTool, toolSpecs } from './tools';

export const ASSISTANT_MODELS: { id: string; label: string; title: string }[] = [
  { id: 'auto', label: 'Copilot Auto', title: 'Use the model selected automatically by Copilot' },
];
const DEFAULT_MODEL = 'auto';
const SETTINGS_KEY = 'p3d:assistant';

/** Development builds and browser tests may stand in for Copilot with window.__assistantChat. */
const devChat = (): ChatFn | null => (import.meta.env.DEV ? ((window as unknown as { __assistantChat?: ChatFn }).__assistantChat ?? null) : null);

function loadModel(): string {
  try {
    const v = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as { model?: string };
    if (v.model && ASSISTANT_MODELS.some((m) => m.id === v.model)) return v.model;
  } catch {
    /* settings are optional */
  }
  return DEFAULT_MODEL;
}

function saveModel(model: string) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ model }));
  } catch {
    /* settings are optional */
  }
}

type Attrs = Record<string, string | number | boolean | null | undefined>;
type Kid = Node | string | null | undefined | false;

/** A DOM element (never HTML text). */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = String(v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, String(v));
  }
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
}

const ic = (name: string) => {
  const e = iconEl(name);
  e.classList.add('as-ic');
  return e;
};

const short = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** A short label for a step, in the user's words. */
export function stepLabel(name: string, a: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
  switch (name) {
    case 'get_scene':
      return 'Read the scene';
    case 'get_object':
      return `Look at ${s(a.name)}`;
    case 'get_material':
      return `Look at material ${s(a.name)}`;
    case 'run_script': {
      const d = s(a.description).trim();
      const label = d ? d.charAt(0).toUpperCase() + d.slice(1) : 'Run a script';
      return a.dry_run === true ? `Try out: ${label.charAt(0).toLowerCase()}${label.slice(1)}` : label;
    }
    case 'api_help':
      return `Check the API: ${short(s(a.topic), 48)}`;
    case 'capture_view':
      return `Look at the scene${a.view && a.view !== 'CURRENT' ? ` (${s(a.view).toLowerCase()})` : ''}`;
    case 'set_view':
      return 'Change the view';
    default:
      return name;
  }
}

interface PendingFile {
  file: File;
  kind: 'image' | 'pdf' | 'text';
  name: string;
  ready: Promise<Attachment | null>;
  node: HTMLElement;
  /** An image's preview, once read. */
  url?: string;
}

/** The files a sent message carried: thumbnails for images, names for the rest. */
function sentFiles(items: PendingFile[]): HTMLElement {
  return el(
    'ul',
    { class: 'as-user-files', 'aria-label': 'Files sent with this message' },
    ...items.map((it) => el('li', { class: 'as-user-file', title: it.name }, it.url ? el('img', { class: 'as-user-thumb', src: it.url, alt: it.name }) : el('span', { class: 'as-user-chip' }, ic(it.kind === 'image' ? 'file_image' : 'file_blank'), el('span', {}, it.name)))),
  );
}

/** Whether a paste is text that came with a picture of itself (text copied from a document): then the text is what was meant. */
function copiedText(data: DataTransfer, files: File[]): boolean {
  if (!files.every((f) => String(f.type).startsWith('image/'))) return false;
  const read = (type: string) => {
    try {
      return data.getData(type) || '';
    } catch {
      return '';
    }
  };
  if (!read('text/plain').trim()) return false;
  if ([...(data.types ?? [])].includes('text/rtf')) return true;
  return !!read('text/html')
    .replace(/<(style|script|title)\b[\s\S]*?<\/\1>|<[^>]*>|&nbsp;/gi, ' ')
    .trim();
}

interface Segment {
  el: HTMLElement;
  src: string;
}

/** One reply: text and step lists in the order they arrived, then a footer. */
interface Turn {
  el: HTMLElement;
  body: HTMLElement;
  text: Segment | null;
  steps: HTMLElement | null;
  stepEls: Map<string, HTMLElement>;
  foot: HTMLElement;
}

export class AssistantPanel {
  readonly el: HTMLElement;
  /** Set by tests to answer without Puter. */
  chat: ChatFn | null = null;
  private log: HTMLElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private status: HTMLElement;
  private agent: Agent;
  private host: AssistantHost = { app, ui: viewportUI };
  private model = loadModel();
  private renderQueued = false;
  private turn: Turn | null = null;
  private pendingText: Segment | null = null;
  /** Files waiting to go with the next message. */
  private pending: PendingFile[] = [];
  private tray: HTMLElement;
  private fileInput: HTMLInputElement;
  /** The pending files are being read before a message goes. */
  private sending = false;
  private readQueue: { item: PendingFile; resolve: (a: Attachment) => void; reject: (e: unknown) => void }[] = [];
  private reading = 0;
  private flashTimer = 0;

  constructor(private onClose: () => void) {
    this.agent = createAgent({
      chat: (m, o) => (this.chat ?? devChat() ?? copilotChat)(m, o),
      tools: () => toolSpecs(this.host),
      runTool: (name, args) => runTool(this.host, name, args),
      system: SYSTEM_PROMPT,
      snapshot: () => sceneSnapshot(this.host),
      model: () => this.model,
    });

    const modelSel = el('select', { class: 'as-model', 'aria-label': 'AI model', title: 'AI model' });
    for (const m of ASSISTANT_MODELS) {
      const o = el('option', { value: m.id, title: m.title }, m.label);
      o.selected = m.id === this.model;
      modelSel.append(o);
    }
    modelSel.addEventListener('change', () => {
      this.model = modelSel.value;
      saveModel(this.model);
    });
    const newChat = el('button', { class: 'as-icon-btn', type: 'button', 'aria-label': 'New chat', 'data-tip': 'New Chat' }, ic('new_chat'));
    newChat.addEventListener('click', () => this.reset());
    const close = el('button', { class: 'as-icon-btn', type: 'button', 'aria-label': 'Close the assistant', 'data-tip': 'Close' }, ic('x'));
    close.addEventListener('click', () => this.onClose());

    this.log = el('div', { class: 'as-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation' });
    this.input = el('textarea', { class: 'as-input', rows: 1, placeholder: 'Describe something to build or change…', 'aria-label': 'Message the assistant' });
    this.sendBtn = el('button', { class: 'as-send', type: 'button', 'aria-label': 'Send' }, ic('send'));
    this.status = el('div', { class: 'as-status', role: 'status' });
    this.input.addEventListener('input', () => this.grow());
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.submit();
      } else if (e.key === 'Escape' && this.agent.busy) {
        e.preventDefault();
        this.agent.stop();
      }
    });
    this.sendBtn.addEventListener('click', () => (this.agent.busy ? this.agent.stop() : void this.submit()));
    // Files go with a message: picked with the paperclip, pasted into the box, or dropped on the panel.
    this.fileInput = el('input', { type: 'file', multiple: true, accept: ATTACH_ACCEPT, hidden: true, tabindex: '-1', 'aria-hidden': 'true' });
    this.fileInput.addEventListener('change', () => {
      const files = [...(this.fileInput.files ?? [])];
      this.fileInput.value = '';
      this.attach(files);
      this.input.focus();
    });
    const attachBtn = el('button', { class: 'as-icon-btn as-attach', type: 'button', 'aria-label': 'Attach files', 'data-tip': 'Attach images, PDFs or text files' }, ic('attach'));
    attachBtn.addEventListener('click', () => this.fileInput.click());
    this.tray = el('ul', { class: 'as-tray', 'aria-label': 'Attached files', hidden: true });
    this.input.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length || copiedText(e.clipboardData!, files)) return;
      e.preventDefault();
      this.attach(files);
    });
    const composer = el('div', { class: 'as-composer' }, this.tray, el('div', { class: 'as-row' }, attachBtn, this.input, this.sendBtn), this.fileInput);

    this.el = el(
      'aside',
      { class: 'assistant', 'aria-label': 'AI Assistant' },
      el('div', { class: 'as-bar' }, el('span', { class: 'as-title' }, ic('assistant'), 'Assistant'), modelSel, newChat, close),
      this.log,
    el('div', { class: 'as-bottom' }, this.status, composer, el('div', { class: 'as-note' }, 'Uses your locally signed-in Copilot CLI. Prompts, scene details, screenshots and attached files are sent to GitHub Copilot.')),
    );
    this.bindDrop();
    this.renderEmpty();
  }

  get busy() {
    return this.agent.busy;
  }

  focus() {
    requestAnimationFrame(() => this.input.focus());
  }

  private grow() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(200, this.input.scrollHeight)}px`;
  }

  private flash(message: string) {
    clearTimeout(this.flashTimer);
    this.status.textContent = message;
    this.status.classList.add('warn');
    this.flashTimer = window.setTimeout(() => {
      this.status.classList.remove('warn');
      if (!this.agent.busy) this.status.textContent = '';
    }, 6000);
  }

  private reset() {
    for (const it of [...this.pending]) this.removePending(it);
    for (const img of this.log.querySelectorAll<HTMLImageElement>('img.as-user-thumb')) URL.revokeObjectURL(img.src);
    this.agent.reset();
    clearScriptFiles();
    this.turn = null;
    this.setBusy(false);
    this.renderEmpty();
    this.input.focus();
  }

  /** Whether the scene is the untouched startup scene. */
  private startupScene() {
    const names = Object.values(app.doc.objects)
      .map((o) => o.name)
      .sort()
      .join(',');
    return names === 'Camera,Cube,Light' || names === '';
  }

  private renderEmpty() {
    const fresh = this.startupScene();
    const ideas = fresh
      ? ['A low-poly tree with a brown trunk and green canopy', 'A wooden dining table with four chairs', 'A cozy room: floor, two walls, a sofa and a lamp', 'A snowman with a carrot nose and a scarf']
      : ['Explain how this scene is built', 'Give every object a fitting material', 'Add soft three-point lighting and aim the camera at the model', 'Animate the selected object spinning once over 120 frames'];
    const chips = el(
      'div',
      { class: 'as-ideas' },
      ...ideas.map((t) => {
        const b = el('button', { class: 'as-idea', type: 'button' }, t);
        b.addEventListener('click', () => {
          this.input.value = t;
          this.grow();
          void this.submit();
        });
        return b;
      }),
    );
    this.log.replaceChildren(
      el(
        'div',
        { class: 'as-empty' },
        el('div', { class: 'as-empty-icon' }, ic('assistant')),
        el('div', { class: 'as-empty-title' }, fresh ? 'Describe something to build' : 'Change or ask about this scene'),
        el('p', {}, 'The assistant models objects, adds materials, lights, cameras and animation, and checks its work in the viewport. Everything it changes in one message is a single undo step.'),
        chips,
      ),
    );
  }

  private setBusy(on: boolean) {
    this.sendBtn.replaceChildren(ic(on ? 'stop' : 'send'));
    this.sendBtn.setAttribute('aria-label', on ? 'Stop' : 'Send');
    this.sendBtn.classList.toggle('stop', on);
    this.el.classList.toggle('busy', on);
    if (!on) this.status.textContent = '';
  }

  /** Whether the local Copilot bridge is available; otherwise explains how to connect. */
  private async ready(): Promise<boolean> {
    if (this.chat || devChat()) return true;
    if (!prefs.use_online_access) {
      this.notice('Copilot needs internet access. Turn on Allow Online Access in Preferences ▸ System ▸ Network.');
      return false;
    }
    this.status.textContent = 'Checking local Copilot…';
    const status = await copilotStatus();
    this.status.textContent = '';
    if (!status.available) {
      this.notice('The local Copilot bridge is not running. Start it with `npm run copilot:bridge` in the 3D project directory.', this.retryConnectionButton());
      return false;
    }
    if (!status.authenticated) {
      this.notice('Copilot CLI is not signed in. Run `copilot auth login` in a terminal, then restart the local bridge.', this.retryConnectionButton());
      return false;
    }
    return true;
  }

  private retryConnectionButton() {
    const btn = el('button', { class: 'as-btn primary', type: 'button' }, 'Retry connection');
    btn.addEventListener('click', () => {
      btn.closest('.as-msg')?.remove();
      void this.submit();
    });
    return btn;
  }

  private notice(text: string, action?: HTMLElement) {
    this.log.querySelector('.as-empty')?.remove();
    this.log.append(el('div', { class: 'as-msg as-notice' }, el('p', {}, text), action));
    this.scroll(true);
  }

  private scroll(force = false) {
    const l = this.log;
    if (force || l.scrollHeight - l.scrollTop - l.clientHeight < 120) l.scrollTop = l.scrollHeight;
  }

  async submit() {
    if ((!this.input.value.trim() && !this.pending.length) || this.agent.busy || this.sending) return;
    this.sending = true;
    let ok: boolean;
    try {
      ok = await this.ready();
    } finally {
      this.sending = false;
    }
    if (!ok || this.agent.busy) return;
    let text = this.input.value.trim();
    let items: PendingFile[] = [];
    let files: Attachment[] = [];
    if (this.pending.length) {
      const waiting = this.pending;
      this.sending = true;
      this.status.textContent = 'Reading attached files…';
      let read: (Attachment | null)[];
      try {
        read = await Promise.all(waiting.map((it) => it.ready));
      } finally {
        this.sending = false;
        this.status.textContent = '';
      }
      if (this.agent.busy) return;
      items = waiting.filter((it, i) => read[i] && this.pending.includes(it));
      files = items.map((it) => read[waiting.indexOf(it)]!);
      // Too much for one request: nothing goes, and the tray and the text stay.
      const tooLarge = attachmentsTooLarge(files);
      if (tooLarge) {
        this.flash(tooLarge);
        return;
      }
      this.pending = this.pending.filter((it) => !waiting.includes(it));
      for (const it of items) it.node.remove();
      this.syncTray();
      // What was typed while the files were read is part of the message.
      text = this.input.value.trim();
      if (!text && !files.length) return;
    }
    this.input.value = '';
    this.grow();
    this.log.querySelector('.as-empty')?.remove();
    const bubble = el('div', { class: 'as-msg as-user' });
    if (items.length) bubble.append(sentFiles(items));
    if (text) bubble.append(el('div', { class: 'as-user-text' }, text));
    this.log.append(bubble);
    const label = text || items.map((it) => it.name).join(', ');
    offerImages(files);
    void this.run(label, (on) => this.agent.send(text, on, { attachments: files }));
  }

  // ---------- attachments ----------

  /** Takes files for the next message. Each is read as it comes, so Send rarely waits. */
  attach(files: File[]) {
    let over = 0;
    for (const file of files) {
      if (this.pending.length >= MAX_ATTACHMENTS) {
        over++;
        continue;
      }
      const problem = attachmentProblem(file, this.pending.length);
      if (problem) {
        this.flash(problem);
        continue;
      }
      const kind = attachmentKind(file)!;
      const item = { file, kind, name: file.name || (kind === 'image' ? 'Pasted image' : 'File') } as PendingFile;
      item.ready = new Promise<Attachment>((resolve, reject) => this.readQueue.push({ item, resolve, reject })).catch((e) => {
        if (this.pending.includes(item)) {
          this.flash((e as Error)?.message || `${item.name} could not be read`);
          this.removePending(item);
        }
        return null;
      });
      this.pending.push(item);
      this.tray.append(this.trayItem(item));
    }
    if (over) this.flash(`Up to ${MAX_ATTACHMENTS} files can go with one message, so ${over === 1 ? '1 was' : `${over} were`} left out.`);
    this.readNext();
    this.syncTray();
  }

  // Read a couple at a time: a photo decodes to full size before it is fitted.
  private readNext() {
    while (this.reading < 2 && this.readQueue.length) {
      const { item, resolve, reject } = this.readQueue.shift()!;
      if (!this.pending.includes(item)) {
        reject(null);
        continue;
      }
      this.reading++;
      readAttachment(item.file)
        .then(resolve, reject)
        .finally(() => {
          this.reading--;
          this.readNext();
        });
    }
  }

  private trayItem(item: PendingFile): HTMLElement {
    const remove = el('button', { class: 'as-tray-remove', type: 'button', 'aria-label': `Remove ${item.name}`, title: 'Remove' }, ic('x'));
    remove.addEventListener('click', () => {
      this.removePending(item);
      this.input.focus();
    });
    const preview = el('span', { class: 'as-tray-icon', 'aria-hidden': 'true' }, ic(item.kind === 'image' ? 'file_image' : 'file_blank'));
    const spinner = el('span', { class: 'as-spinner', 'aria-hidden': 'true' });
    item.node = el('li', { class: 'as-tray-item reading', title: `${item.name} · ${formatSize(item.file.size)}`, 'aria-busy': 'true' }, preview, spinner, el('span', { class: 'as-tray-name' }, item.name), remove);
    void item.ready.then((read) => {
      item.node.classList.remove('reading');
      item.node.removeAttribute('aria-busy');
      spinner.remove();
      if (!read || read.kind !== 'image' || !this.pending.includes(item)) return;
      try {
        item.url = URL.createObjectURL(read.thumb || item.file);
      } catch {
        return;
      }
      preview.replaceWith(el('img', { class: 'as-tray-thumb', src: item.url, alt: '' }));
    });
    return item.node;
  }

  private removePending(item: PendingFile) {
    this.pending = this.pending.filter((p) => p !== item);
    item.node?.remove();
    if (item.url) URL.revokeObjectURL(item.url);
    this.syncTray();
  }

  private syncTray() {
    this.tray.hidden = !this.pending.length;
  }

  /** Files dropped anywhere on the panel are attached. */
  private bindDrop() {
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    let depth = 0;
    this.el.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      this.el.classList.add('as-drop');
    });
    this.el.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    this.el.addEventListener('dragleave', () => {
      if (--depth <= 0) {
        depth = 0;
        this.el.classList.remove('as-drop');
      }
    });
    this.el.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth = 0;
      this.el.classList.remove('as-drop');
      this.attach([...(e.dataTransfer?.files ?? [])]);
      this.input.focus();
    });
  }

  // ---------- replies ----------

  private newTurn(): Turn {
    const body = el('div', { class: 'as-body' });
    const foot = el('div', { class: 'as-foot' });
    const node = el('div', { class: 'as-msg as-bot' }, body, foot);
    this.log.append(node);
    return { el: node, body, text: null, steps: null, stepEls: new Map(), foot };
  }

  private async run(request: string, go: (on: Parameters<Agent['send']>[1]) => Promise<ExchangeResult>) {
    const mark = app.undo.mark();
    const turn = this.newTurn();
    this.turn = turn;
    this.setBusy(true);
    this.status.textContent = 'Thinking…';
    this.scroll(true);
    let res: ExchangeResult;
    try {
      res = await go((e) => {
        if (this.turn !== turn) return;
        if (e.type === 'text') {
          if (!turn.text) {
            turn.text = { el: el('div', { class: 'as-text' }), src: '' };
            turn.body.append(turn.text.el);
            turn.steps = null;
          }
          turn.text.src += e.text;
          this.queueText(turn.text);
          this.status.textContent = 'Writing…';
        } else if (e.type === 'step') {
          if (!turn.steps) {
            if (turn.text) this.renderText(turn.text);
            turn.steps = el('ol', { class: 'as-steps', 'aria-label': 'Steps' });
            turn.body.append(turn.steps);
            turn.text = null;
          }
          this.renderStep(turn, turn.steps, e.step);
          this.status.textContent = e.step.status === 'running' ? `${stepLabel(e.step.name, e.step.args)}…` : 'Thinking…';
        } else if (e.type === 'round') {
          this.status.textContent = 'Thinking…';
        }
      });
    } catch (e) {
      res = { stopped: false, error: e as Error, steps: [] };
    }
    if (this.turn !== turn) return;
    if (turn.text) this.renderText(turn.text);
    // Everything this message changed becomes one undo step.
    const label = `Assistant: ${short(request, 40)}`;
    const changed = !!mark && !app.undo.isCurrent(mark) && app.undo.squash(mark, label);
    const after = app.undo.mark();
    if (res.stopped) turn.foot.append(el('span', { class: 'as-meta' }, 'Stopped.'));
    if (res.error) {
      const retry = el('button', { class: 'as-btn', type: 'button' }, 'Try again');
      retry.addEventListener('click', () => {
        if (this.agent.busy) return;
        turn.foot.replaceChildren();
        void this.run(request, (on) => this.agent.retry(on));
      });
      turn.foot.append(el('div', { class: 'as-error', role: 'alert' }, `The assistant could not answer: ${res.error.message}`), retry);
    }
    if (changed) {
      const undo = el('button', { class: 'as-btn', type: 'button' }, ic('undo'), 'Undo changes');
      undo.addEventListener('click', () => {
        if (!app.undo.isCurrent(after)) {
          this.flash('The scene changed since; use Edit › Undo History to step back.');
          return;
        }
        app.undoStep();
        undo.replaceWith(el('span', { class: 'as-meta' }, 'Changes undone.'));
      });
      turn.foot.prepend(undo);
    }
    this.turn = null;
    this.setBusy(false);
    this.scroll();
  }

  private queueText(seg: Segment) {
    if (this.pendingText && this.pendingText !== seg) this.renderText(this.pendingText);
    this.pendingText = seg;
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      if (this.pendingText) this.renderText(this.pendingText);
      this.pendingText = null;
      this.scroll();
    });
  }

  private renderText(seg: Segment) {
    seg.el.replaceChildren(renderMarkdown(seg.src));
  }

  private renderStep(turn: Turn, list: HTMLElement, step: Step) {
    let node = turn.stepEls.get(step.id);
    if (!node) {
      node = el('li', { class: 'as-step' });
      turn.stepEls.set(step.id, node);
      list.append(node);
    }
    const mark = step.status === 'running' ? el('span', { class: 'as-spinner', 'aria-hidden': 'true' }) : ic(step.status === 'done' ? 'check' : step.status === 'error' ? 'error' : 'x');
    node.className = `as-step ${step.status}`;
    node.replaceChildren(el('span', { class: 'as-step-mark' }, mark), el('span', { class: 'as-step-label' }, stepLabel(step.name, step.args)));
    if (step.summary && step.status !== 'running') {
      node.title = step.summary;
      if (step.status === 'error') node.append(el('div', { class: 'as-step-detail' }, short(step.summary, 220)));
    }
    if (step.image) node.append(el('img', { class: 'as-shot', src: step.image, alt: 'What the assistant saw' }));
    this.scroll();
  }
}
