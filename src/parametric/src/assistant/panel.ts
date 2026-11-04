// The assistant sidebar: conversation, the steps the assistant takes on the
// part, and the message box. Each message's changes become one undo step
// ("Assistant: …") that the turn's Undo button reverts.

import type { App } from '../app/app';
import { appHost } from '../app/assistant-host';
import { doSignIn } from '../app/start';
import { type ChatFn, puterChat } from '../platform/ai';
import { cloudAvailable, env, puter } from '../platform/puter';
import { h, nextDomId } from '../ui/dom';
import { icon } from '../ui/icons';
import { toast } from '../ui/overlay';
import { type Agent, type ExchangeResult, type Step, createAgent } from './agent';
import type { AssistantHost } from './host';
import { renderMarkdown } from './markdown';
import { ATTACH_ACCEPT, type Attachment, MAX_ATTACHMENTS, MAX_TEXT_CHARS, attachmentKind, attachmentProblem, attachmentsTooLarge, formatSize } from './attach';
import { readAttachment } from './attachments';
import { SYSTEM_PROMPT, partSnapshot } from './prompt';
import { runTool, toolSpecs } from './tools';

export const ASSISTANT_MODEL = 'claude-opus-5-5';

/** Development builds and browser tests may stand in for Puter AI with window.__assistantChat. */
const devChat = (): ChatFn | null => (import.meta.env.DEV ? (window as unknown as { __assistantChat?: ChatFn }).__assistantChat ?? null : null);

const short = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** A short label for a step, in the user's words. */
export function stepLabel(name: string, a: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
  const featureNames: Record<string, string> = {
    add_extrude: a.cut ? 'Extruded cut' : 'Extrude', add_revolve: a.cut ? 'Revolved cut' : 'Revolve', add_fillet: 'Fillet', add_chamfer: 'Chamfer',
    add_shell: 'Shell', add_hole: 'Hole', add_linear_pattern: 'Linear pattern', add_circular_pattern: 'Circular pattern', add_mirror: 'Mirror',
    add_plane: 'Reference plane', add_loft: a.cut ? 'Lofted cut' : 'Loft', add_sweep: a.cut ? 'Swept cut' : 'Sweep', add_draft: 'Draft',
  };
  if (featureNames[name]) return `Add ${featureNames[name].toLowerCase()}${a.name ? ` "${s(a.name)}"` : ''}`;
  switch (name) {
    case 'get_model': return 'Read the part';
    case 'get_sketch': return `Read sketch ${s(a.sketch)}`;
    case 'find_geometry': return `Find ${a.kind === 'edges' ? 'edges' : 'faces'}`;
    case 'measure': return 'Measure';
    case 'mass_properties': return 'Mass properties';
    case 'calculate': return 'Calculate';
    case 'capture_view': return `Look at the model${a.orientation ? ` (${s(a.orientation)})` : ''}`;
    case 'create_sketch': return `Sketch on ${s(a.plane)}`;
    case 'edit_sketch': return `Edit sketch ${s(a.sketch)}`;
    case 'edit_feature': return `Edit ${s(a.feature)}`;
    case 'delete_features': return `Delete ${Array.isArray(a.features) ? a.features.join(', ') : s(a.features)}`;
    case 'set_rollback': return 'Move the rollback bar';
    case 'set_variables': return 'Set variables';
    case 'set_part': return 'Part properties';
    case 'set_view': return 'Change the view';
    case 'drawing': return 'Drawing';
    case 'run_command': return `Run ${s(a.command).replace(/_/g, ' ')}`;
    default: return name;
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
  return h('ul', { class: 'as-user-files', 'aria-label': 'Files sent with this message' }, ...items.map((it) =>
    h('li', { class: 'as-user-file', title: it.name },
      it.url ? h('img', { class: 'as-user-thumb', src: it.url, alt: it.name })
        : h('span', { class: 'as-user-chip' }, icon(it.kind === 'pdf' || it.kind === 'text' ? 'file' : 'image', 14), h('span', {}, it.name)))));
}

/**
 * Whether a paste is text that came with a picture of itself (text copied from
 * a document or spreadsheet): then the text is what was meant.
 */
function copiedText(data: DataTransfer, files: File[]): boolean {
  if (!files.every((f) => String(f.type).startsWith('image/'))) return false;
  const read = (type: string) => { try { return data.getData(type) || ''; } catch { return ''; } };
  if (!read('text/plain').trim()) return false;
  if ([...(data.types ?? [])].includes('text/rtf')) return true;
  return !!read('text/html').replace(/<(style|script|title)\b[\s\S]*?<\/\1>|<[^>]*>|&nbsp;/gi, ' ').trim();
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
  private log: HTMLElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private status: HTMLElement;
  /** Says why the typed message cannot go (too long). */
  private limit: HTMLElement;
  private agent: Agent;
  private host: AssistantHost;
  private renderQueued = false;
  private turn: Turn | null = null;
  /** Set by tests and the dev mock to answer without Puter. */
  chat: ChatFn | null = null;
  /** Files waiting to go with the next message. */
  private pending: PendingFile[] = [];
  private tray: HTMLElement;
  private fileInput: HTMLInputElement;
  /** The pending files are being read before a message goes. */
  private sending = false;
  private readQueue: { item: PendingFile; resolve: (a: Attachment) => void; reject: (e: unknown) => void }[] = [];
  private reading = 0;
  /** Where the message being answered started in the undo history, and its undo step's name. */
  private undoRun: { mark: number; label: string } | null = null;

  constructor(private app: App) {
    this.host = appHost(app);
    this.agent = createAgent({
      chat: (m, o) => (this.chat ?? devChat() ?? puterChat)(m, o),
      tools: toolSpecs,
      runTool: async (name, args) => {
        const r = await runTool(this.host, name, args);
        // The message's changes are folded into one undo step as they come: a long
        // build would otherwise push older history, and its own start, off the
        // bottom of the undo stack before the message ends.
        const run = this.undoRun;
        if (run && this.app.store.undoMark > run.mark + 1) this.app.store.squash(run.mark, run.label);
        return r;
      },
      system: SYSTEM_PROMPT,
      snapshot: () => partSnapshot(this.host),
      model: () => ASSISTANT_MODEL,
    });

    const newChat = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'New chat', title: 'New chat' }, icon('newChat', 16));
    newChat.addEventListener('click', () => this.reset());

    this.log = h('div', { class: 'as-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation' });
    // Follow new content only while the user is at the bottom; scrolling up to read stops it.
    this.log.addEventListener('scroll', () => { const l = this.log; this.stick = l.scrollHeight - l.scrollTop - l.clientHeight < 40; }, { passive: true });
    this.input = h('textarea', { class: 'as-input', rows: 1, placeholder: 'Describe a part or a change…', 'aria-label': 'Message the assistant' }) as HTMLTextAreaElement;
    this.sendBtn = h('button', { class: 'as-send', type: 'button', 'aria-label': 'Send' }, icon('send', 16)) as HTMLButtonElement;
    this.status = h('div', { class: 'as-status', role: 'status' });
    this.limit = h('div', { class: 'as-limit', id: nextDomId('as-limit'), 'aria-live': 'polite' });
    this.input.setAttribute('aria-describedby', this.limit.id);
    this.input.addEventListener('input', () => { this.grow(); this.checkLength(); });
    this.input.addEventListener('keydown', (e) => {
      // keyCode 229: Safari's Enter that commits an IME composition comes with isComposing false.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); void this.submit(); }
      else if (e.key === 'Escape' && this.agent.busy) { e.preventDefault(); this.stop(); }
    });
    this.sendBtn.addEventListener('click', () => (this.agent.busy ? this.stop() : void this.submit()));
    // Files go with a message: picked with the paperclip, pasted into the box, or dropped on the panel.
    this.fileInput = h('input', { type: 'file', multiple: true, accept: ATTACH_ACCEPT, hidden: true, tabindex: '-1', 'aria-hidden': 'true' }) as HTMLInputElement;
    this.fileInput.addEventListener('change', () => {
      const files = [...(this.fileInput.files ?? [])];
      this.fileInput.value = '';
      this.attach(files);
      this.input.focus();
    });
    const attachBtn = h('button', { class: 'icon-btn as-attach', type: 'button', 'aria-label': 'Attach files', title: 'Attach images, PDFs or text files (DXF, CSV…)' }, icon('attach', 17));
    attachBtn.addEventListener('click', () => this.fileInput.click());
    this.tray = h('ul', { class: 'as-tray', 'aria-label': 'Attached files', hidden: true });
    this.input.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length || copiedText(e.clipboardData!, files)) return;
      e.preventDefault();
      this.attach(files);
    });
    const composer = h('div', { class: 'as-composer' }, this.tray, h('div', { class: 'as-row' }, attachBtn, this.input, this.sendBtn), this.fileInput);

    this.el = h('div', { class: 'assistant' },
      h('div', { class: 'as-bar' }, newChat),
      this.log,
      h('div', { class: 'as-bottom' }, this.status, composer, this.limit,
        h('div', { class: 'as-note' }, 'Sends your messages and a description of the part to Puter AI. Check designs before relying on them.')));
    this.bindDrop();
    this.renderEmpty();
    app.store.on((reason) => {
      if (reason !== 'load') return;
      // Another part was opened: the reply in progress was about the one that was closed.
      if (this.agent.busy) this.stop('Stopped: another part was opened.');
      else if (!this.agent.messages.length) this.renderEmpty();
    });
  }

  focus() {
    requestAnimationFrame(() => this.input.focus());
  }

  /**
   * A button pressed from the keyboard that goes away with the press (idea, Try
   * again, Undo changes) hands focus to the message box, not to the page.
   * Tapped or clicked ones do not: on a phone that would open the keyboard.
   */
  private keepFocus(e: MouseEvent) {
    if (e.detail === 0) this.input.focus({ preventScroll: true });
  }

  /**
   * A message longer than the assistant takes (megabytes pasted by mistake)
   * would fail, and stay in the conversation failing every later message.
   * Returns false, saying so under the box, when the text is too long.
   */
  private checkLength(): boolean {
    const n = this.input.value.trim().length;
    const over = n > MAX_TEXT_CHARS;
    const text = over ? `This message has ${n.toLocaleString('en-US')} characters; the assistant takes at most ${MAX_TEXT_CHARS.toLocaleString('en-US')}. Shorten it, or attach long text as a file.` : '';
    if (this.limit.textContent !== text) this.limit.textContent = text;
    if (over) this.input.setAttribute('aria-invalid', 'true');
    else this.input.removeAttribute('aria-invalid');
    return !over;
  }

  private grow() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(200, this.input.scrollHeight)}px`;
  }

  private reset() {
    for (const it of [...this.pending]) this.removePending(it);
    for (const img of this.log.querySelectorAll<HTMLImageElement>('img.as-user-thumb')) URL.revokeObjectURL(img.src);
    this.agent.reset();
    this.turn = null;
    // A step still running finishes first; its message's run then squashes and clears busy.
    this.setBusy(this.agent.busy);
    if (this.agent.busy) this.status.textContent = 'Stopping…';
    this.renderEmpty();
    this.input.focus();
  }

  private renderEmpty() {
    const hasFeatures = this.app.store.doc.features.length > 0;
    const ideas = hasFeatures
      ? ['Explain how this part is built', 'Round all the outer edges with 1 mm fillets', 'Make the main sizes parametric with global variables', 'What does it weigh in aluminium?']
      : ['A 100 × 60 × 8 mm mounting plate with four M5 holes and rounded corners', 'A flanged bushing: 40 mm flange, 20 mm shaft, 10 mm bore', 'An enclosure box 80 × 50 × 30 mm with 2 mm walls, open on top', 'A spur-gear-like disc: 60 mm across with 12 teeth and a 8 mm bore'];
    const chips = h('div', { class: 'as-ideas' }, ...ideas.map((t) => {
      const b = h('button', { class: 'as-idea', type: 'button' }, t);
      b.addEventListener('click', (e) => { this.input.value = t; this.grow(); this.keepFocus(e); void this.submit(); });
      return b;
    }));
    this.log.replaceChildren(h('div', { class: 'as-empty' },
      h('div', { class: 'as-empty-icon' }, icon('assistant', 22)),
      h('div', { class: 'as-empty-title' }, hasFeatures ? 'Change or ask about this part' : 'Describe a part to design'),
      h('p', {}, 'The assistant sketches, adds features, edits dimensions, measures and checks its work in the model. Everything it changes in one message is a single undo step.'),
      chips));
  }

  private setBusy(on: boolean) {
    this.sendBtn.replaceChildren(icon(on ? 'stop' : 'send', 16));
    this.sendBtn.setAttribute('aria-label', on ? 'Stop' : 'Send');
    this.sendBtn.classList.toggle('stop', on);
    this.el.classList.toggle('busy', on);
    if (!on) this.status.textContent = '';
  }

  /** The status line is a live region: it is only written when what it says changes. */
  private setStatus(text: string) {
    if (this.status.textContent !== text) this.status.textContent = text;
  }

  /** Stops the reply; a step already running finishes first (it cannot be interrupted). */
  private stop(reason = 'Stopped.') {
    this.agent.stop();
    this.stopReason = reason;
    if (this.turn) this.status.textContent = 'Stopping…';
  }

  /** What the footer of a stopped reply says. */
  private stopReason = 'Stopped.';

  /** Whether Puter AI can be used. Signs in to Puter first when needed. */
  private async ready(): Promise<boolean> {
    if (this.chat || devChat()) return true;
    const sdk = puter() as unknown as { ai?: unknown } | null;
    if (!sdk?.ai) {
      this.notice('The assistant needs Puter, which is not available right now. Check your connection and reload the page.');
      return false;
    }
    if (env() === 'app' || cloudAvailable()) return true;
    // Sending is a click or Enter press, so the sign-in window opens without being blocked.
    this.sending = true;
    this.status.textContent = 'Signing in to Puter…';
    try { return await doSignIn(this.app); } finally { this.sending = false; this.status.textContent = ''; }
  }

  private notice(text: string, action?: HTMLElement) {
    this.log.querySelector('.as-empty')?.remove();
    this.log.append(h('div', { class: 'as-msg as-notice' }, h('p', {}, text), action ?? null));
    this.scroll(true);
  }

  /** Whether the conversation follows new content (the user has not scrolled up from the bottom). */
  private stick = true;

  private scroll(force = false) {
    // Judged by where the user left it, not by the distance now: one piece of text
    // or a screenshot can add more than a screenful at once.
    if (force) this.stick = true;
    if (this.stick) this.log.scrollTop = this.log.scrollHeight;
  }

  async submit() {
    let text = this.input.value.trim();
    if ((!text && !this.pending.length) || this.agent.busy || this.sending) return;
    if (!this.checkLength()) { this.input.focus(); return; }
    if (!(await this.ready()) || this.agent.busy) return;
    // What the box holds now goes: it may have been edited while signing in.
    text = this.input.value.trim();
    if (!text && !this.pending.length) return;
    if (!this.checkLength()) return;
    let items: PendingFile[] = [];
    let files: Attachment[] = [];
    if (this.pending.length) {
      const waiting = this.pending;
      this.sending = true;
      this.status.textContent = 'Reading attached files…';
      let read: (Attachment | null)[];
      try { read = await Promise.all(waiting.map((it) => it.ready)); } finally { this.sending = false; this.status.textContent = ''; }
      if (this.agent.busy) return;
      items = waiting.filter((it, i) => read[i] && this.pending.includes(it));
      files = items.map((it) => read[waiting.indexOf(it)]!);
      // Too much for one request: nothing goes, and the tray and the text stay.
      const tooLarge = attachmentsTooLarge(files);
      if (tooLarge) { toast({ kind: 'warning', message: tooLarge, timeout: 6000 }); return; }
      if (!this.checkLength()) return;
      this.pending = this.pending.filter((it) => !waiting.includes(it));
      for (const it of items) it.node.remove();
      this.syncTray();
      // What was typed while the files were read is part of the message.
      text = this.input.value.trim();
      if (!text && !files.length) return;
    }
    this.input.value = '';
    this.grow();
    this.checkLength();
    this.log.querySelector('.as-empty')?.remove();
    const bubble = h('div', { class: 'as-msg as-user' });
    if (items.length) bubble.append(sentFiles(items));
    if (text) bubble.append(h('div', { class: 'as-user-text' }, text));
    this.log.append(bubble);
    const label = text || items.map((it) => it.name).join(', ');
    void this.run(label, (on) => this.agent.send(text, on, { attachments: files }));
  }

  // ---------- attachments ----------

  /** Takes files for the next message. Each is read as it comes, so Send rarely waits. */
  attach(files: File[]) {
    let over = 0;
    for (const file of files) {
      if (this.pending.length >= MAX_ATTACHMENTS) { over++; continue; }
      const problem = attachmentProblem(file, this.pending.length);
      if (problem) { toast({ kind: 'warning', message: problem, timeout: 5000 }); continue; }
      const kind = attachmentKind(file)!;
      const item = { file, kind, name: file.name || (kind === 'image' ? 'Pasted image' : 'File') } as PendingFile;
      item.ready = new Promise<Attachment>((resolve, reject) => this.readQueue.push({ item, resolve, reject })).catch((e) => {
        if (this.pending.includes(item)) {
          toast({ kind: 'warning', message: (e as Error)?.message || `${item.name} could not be read`, timeout: 5000 });
          this.removePending(item);
        }
        return null;
      });
      this.pending.push(item);
      this.tray.append(this.trayItem(item));
    }
    if (over) toast({ kind: 'info', message: `Up to ${MAX_ATTACHMENTS} files can go with one message, so ${over === 1 ? '1 was' : `${over} were`} left out.` });
    this.readNext();
    this.syncTray();
  }

  // Read a couple at a time: a photo decodes to full size before it is fitted.
  private readNext() {
    while (this.reading < 2 && this.readQueue.length) {
      const { item, resolve, reject } = this.readQueue.shift()!;
      if (!this.pending.includes(item)) { reject(null); continue; }
      this.reading++;
      readAttachment(item.file).then(resolve, reject).finally(() => { this.reading--; this.readNext(); });
    }
  }

  private trayItem(item: PendingFile): HTMLElement {
    const remove = h('button', { class: 'as-tray-remove', type: 'button', 'aria-label': `Remove ${item.name}`, title: 'Remove' }, icon('close', 12));
    remove.addEventListener('click', () => { this.removePending(item); this.input.focus(); });
    const preview = h('span', { class: 'as-tray-icon', 'aria-hidden': 'true' }, icon(item.kind === 'image' ? 'image' : 'file', 16));
    const spinner = h('span', { class: 'spinner', 'aria-hidden': 'true' });
    item.node = h('li', { class: 'as-tray-item reading', title: `${item.name} · ${formatSize(item.file.size)}`, 'aria-busy': 'true' },
      preview, spinner, h('span', { class: 'as-tray-name' }, item.name), remove);
    void item.ready.then((read) => {
      item.node.classList.remove('reading');
      item.node.removeAttribute('aria-busy');
      spinner.remove();
      if (!read || read.kind !== 'image' || !this.pending.includes(item)) return;
      try { item.url = URL.createObjectURL(read.thumb || item.file); } catch { return; }
      preview.replaceWith(h('img', { class: 'as-tray-thumb', src: item.url, alt: '' }));
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
    this.el.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; this.el.classList.add('as-drop'); });
    this.el.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
    this.el.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; this.el.classList.remove('as-drop'); } });
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

  private newTurn(): Turn {
    const body = h('div', { class: 'as-body' });
    const foot = h('div', { class: 'as-foot' });
    const el = h('div', { class: 'as-msg as-bot' }, body, foot);
    this.log.append(el);
    return { el, body, text: null, steps: null, stepEls: new Map(), foot };
  }

  private async run(request: string, go: (on: Parameters<Agent['send']>[1]) => Promise<ExchangeResult>) {
    const store = this.app.store;
    const mark = store.undoMark;
    const label = `Assistant: ${short(request, 40)}`;
    const undoRun = { mark, label };
    this.undoRun = undoRun;
    // Only the latest reply can be asked again: a later message has moved the conversation on.
    for (const b of this.log.querySelectorAll('.as-retry')) b.remove();
    this.stopReason = 'Stopped.';
    const turn = this.newTurn();
    // The conversation is a live region: the reply is announced once it is complete,
    // not again on every streamed piece (the status line tells what is happening meanwhile).
    turn.el.setAttribute('aria-busy', 'true');
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
            turn.text = { el: h('div', { class: 'as-text' }), src: '' };
            turn.body.append(turn.text.el);
            turn.steps = null;
          }
          turn.text.src += e.text;
          this.queueText(turn.text);
          this.setStatus('Writing…');
        } else if (e.type === 'step') {
          if (!turn.steps) {
            if (turn.text) this.renderText(turn.text);
            turn.steps = h('ol', { class: 'as-steps', 'aria-label': 'Steps' });
            turn.body.append(turn.steps);
            turn.text = null;
          }
          this.renderStep(turn, turn.steps, e.step);
          if (this.status.textContent !== 'Stopping…') this.setStatus(e.step.status === 'running' ? `${stepLabel(e.step.name, e.step.args)}…` : 'Thinking…');
        } else if (e.type === 'round') {
          this.setStatus('Thinking…');
        }
      });
    } catch (e) {
      res = { stopped: false, error: e as Error, steps: [] };
    }
    if (this.undoRun === undoRun) this.undoRun = null;
    // Everything this message changed becomes one undo step, even when New chat cut it off.
    let changed = false;
    if (store.undoMark > mark) {
      store.squash(mark, label);
      changed = true;
    }
    if (this.turn !== turn) {
      if (!this.turn) this.setBusy(false);
      return;
    }
    if (turn.text) this.renderText(turn.text);
    turn.el.removeAttribute('aria-busy');
    const after = store.undoMark;
    if (res.stopped) turn.foot.append(h('span', { class: 'as-meta' }, this.stopReason));
    if (res.error) {
      const retry = h('button', { class: 'btn small as-retry', type: 'button' }, 'Try again');
      const error = h('div', { class: 'as-error', role: 'alert' }, `The assistant could not answer: ${res.error.message}`);
      retry.addEventListener('click', (e) => {
        if (this.agent.busy) return;
        this.keepFocus(e);
        // Undo changes stays: what this reply did before it failed is still its own undo step.
        error.remove();
        retry.remove();
        void this.run(request, (on) => this.agent.retry(on));
      });
      turn.foot.append(error, retry);
    }
    if (changed) {
      const undo = h('button', { class: 'btn small', type: 'button' }, icon('undo', 14), 'Undo changes');
      undo.addEventListener('click', (e) => {
        if (store.undoMark !== after || store.undoLabel !== label) {
          toast({ kind: 'info', message: 'The part changed since; use Edit > Undo to step back.' });
          return;
        }
        this.keepFocus(e);
        this.app.commands.run('undo');
        undo.replaceWith(h('span', { class: 'as-meta' }, 'Changes undone.'));
      });
      turn.foot.prepend(undo);
    }
    this.turn = null;
    this.setBusy(false);
    this.scroll();
  }

  private pendingText: Segment | null = null;

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
    let el = turn.stepEls.get(step.id);
    if (!el) {
      el = h('li', { class: 'as-step' });
      turn.stepEls.set(step.id, el);
      list.append(el);
    }
    const mark = step.status === 'running' ? h('span', { class: 'spinner', 'aria-hidden': 'true' })
      : icon(step.status === 'done' ? 'check' : step.status === 'error' ? 'error' : 'close', 14);
    el.className = `as-step ${step.status}`;
    const label = h('span', { class: 'as-step-label' }, stepLabel(step.name, step.args));
    const children: (HTMLElement | SVGElement)[] = [h('span', { class: 'as-step-mark' }, mark), label];
    el.replaceChildren(...children);
    if (step.summary && step.status !== 'running') {
      el.title = step.summary;
      if (step.status === 'error') el.append(h('div', { class: 'as-step-detail' }, short(step.summary, 220)));
    }
    if (step.image) {
      const img = h('img', { class: 'as-shot', src: step.image, alt: 'What the assistant saw' }) as HTMLImageElement;
      img.addEventListener('load', () => this.scroll(), { once: true });
      el.append(img);
    }
    this.scroll();
  }
}
