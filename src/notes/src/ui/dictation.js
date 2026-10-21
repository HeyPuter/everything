import { announce } from '../lib/dom.js';
import { toast } from './toast.js';
import { insertText } from '../editor/format.js';
import { editableRoot, currentRange } from '../editor/selection.js';

/** Home > Dictate: speech to text at the caret, where the browser supports it. */
export class Dictation {
  constructor(app) {
    this.app = app;
    this.Recognition = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
    this.supported = Boolean(this.Recognition);
    this.active = false;
    this.rec = null;
  }

  toggle() {
    if (this.active) this.stop();
    else this.start();
  }

  start() {
    if (!this.supported) {
      toast('Dictation is not available in this browser.');
      return;
    }
    this.app.editor.ensureCaret();
    const rec = new this.Recognition();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = navigator.language || 'en-US';
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (!e.results[i].isFinal) continue;
        const text = e.results[i][0].transcript.trim();
        if (text) this.insert(`${text} `);
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Allow microphone access to dictate.', { kind: 'error' });
      else if (e.error !== 'no-speech' && e.error !== 'aborted') toast(`Dictation stopped: ${e.error}`, { kind: 'error' });
    };
    rec.onend = () => {
      if (this.rec === rec) {
        this.active = false;
        this.rec = null;
        this.app.ribbon.refresh();
      }
    };
    try {
      rec.start();
    } catch {
      return;
    }
    this.rec = rec;
    this.active = true;
    this.app.ribbon.refresh();
    announce('Dictation on. Start speaking.');
  }

  /**
   * Puts recognized words in the note. With focus in the note they go at
   * the caret. With focus elsewhere (search box, a dialog, the ribbon)
   * they go at the note's saved caret without taking focus away; if that
   * caret is gone (another page is open), dictation stops instead of
   * typing into whatever has focus.
   */
  insert(text) {
    const ed = this.app.editor;
    const active = document.activeElement;
    if (active?.isContentEditable && ed.scroller.contains(active)) {
      insertText(text);
      // Remember where the words ended, for results that arrive after focus moves on.
      const range = currentRange();
      if (range) ed.lastRange = range.cloneRange();
      ed.markActiveDirty();
      return;
    }
    const saved = ed.lastRange;
    const body = saved?.startContainer.isConnected && editableRoot(saved.startContainer);
    if (!body?.classList.contains('outline-body') || !ed.scroller.contains(body)) {
      this.stop();
      toast('Dictation stopped. Click in a note to dictate there.');
      return;
    }
    const range = saved.cloneRange();
    range.collapse(false);
    const node = document.createTextNode(text);
    range.insertNode(node);
    const after = document.createRange();
    after.setStartAfter(node);
    after.collapse(true);
    ed.lastRange = after;
    ed.dirty.add(body.closest('.outline'));
    ed.commit();
    ed.layoutSoon();
  }

  stop() {
    const rec = this.rec;
    this.rec = null;
    this.active = false;
    rec?.stop();
    this.app.ribbon.refresh();
    announce('Dictation off');
  }
}
