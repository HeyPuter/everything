/**
 * Write with AI: ask Puter AI for titles, hooks, captions or calls to action
 * (from a description or from the project's transcript) and add the one you
 * like as a text clip.
 */
import { h, announce } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { emptyState } from './common.js';
import { toast } from '../dialog.js';
import { aiAvailable } from '../../media/tts.js';
import { parseJsonArray, transcriptText, transcriptWords } from '../../media/transcript.js';
import { errorMessage } from '../../media/transcribe.js';

export const WRITE_KINDS = [
  { id: 'title', label: 'Titles', ask: 'short video titles (at most 7 words each)', preset: 'title-bold' },
  { id: 'hook', label: 'Opening hooks', ask: 'one-line opening hooks that make people keep watching (at most 12 words)', preset: 'title-bold' },
  { id: 'caption', label: 'On-screen captions', ask: 'short on-screen caption lines (at most 10 words)', preset: 'subtitle' },
  { id: 'cta', label: 'Calls to action', ask: 'short end-screen calls to action (at most 8 words), without platform names', preset: 'plain' },
  { id: 'chapters', label: 'Chapter titles', ask: 'chapter titles for sections of the video (at most 5 words)', preset: 'minimal' },
];

const TONES = ['Friendly', 'Bold', 'Funny', 'Professional', 'Calm', 'Dramatic'];

/** The chat prompt for a request. */
export function writePrompt({ kind, tone, topic, transcript, count = 6 }) {
  const k = WRITE_KINDS.find((x) => x.id === kind) || WRITE_KINDS[0];
  return [
    `Write ${count} ${k.ask} for a video.`,
    tone ? `Tone: ${tone.toLowerCase()}.` : '',
    topic ? `The video is about: ${topic}` : '',
    transcript ? `Here is what is said in the video:\n"""${transcript.slice(0, 6000)}"""` : '',
    'No hashtags, no quotes around lines, no numbering, no emoji unless it really helps.',
    'Reply with only a JSON array of strings.',
  ].filter(Boolean).join('\n');
}

export function textAiPanel(ctx, { chat = (p) => puter.ai.chat(p) } = {}) {
  const { store, actions } = ctx;
  let kind = 'title';
  let tone = 'Friendly';
  let results = [];
  let busy = false;
  const topic = h('textarea.input.ai-topic', { rows: 3, maxlength: 600, placeholder: 'What is the video about? For example: a weekend food tour in Lisbon', 'aria-label': 'What is the video about' });
  const kindSel = h('select.select', { 'aria-label': 'What to write' }, WRITE_KINDS.map((k) => h('option', { value: k.id }, k.label)));
  kindSel.addEventListener('change', () => (kind = kindSel.value));
  const toneSel = h('select.select', { 'aria-label': 'Tone' }, TONES.map((t) => h('option', { value: t }, t)));
  toneSel.addEventListener('change', () => (tone = toneSel.value));
  const useTranscript = h('input', { type: 'checkbox' });
  const transcriptRow = h('label.check-row', useTranscript, h('span', 'Use the transcript'));
  const go = h('button.btn.primary.block', { type: 'button' }, icon('magic', 16), 'Write');
  const list = h('div.ai-results', { role: 'list', 'aria-label': 'Suggestions', 'aria-live': 'polite' });

  async function run() {
    if (busy) return;
    const transcript = useTranscript.checked ? transcriptText(transcriptWords(store.project)) : '';
    if (!topic.value.trim() && !transcript) {
      toast('Describe the video first, or use its transcript.', { kind: 'info' });
      topic.focus();
      return;
    }
    busy = true;
    go.disabled = true;
    list.replaceChildren(h('p.asset-hint', 'Writing...'));
    try {
      const reply = await chat(writePrompt({ kind, tone, topic: topic.value.trim(), transcript }));
      results = parseJsonArray(reply).map((x) => x.trim()).filter(Boolean).slice(0, 12);
      render();
      announce(`${results.length} suggestions`);
    } catch (err) {
      console.error(err);
      list.replaceChildren(h('p.asset-hint', errorMessage(err, 'Could not write suggestions.')));
    } finally {
      busy = false;
      go.disabled = false;
    }
  }
  go.addEventListener('click', run);

  function render() {
    const k = WRITE_KINDS.find((x) => x.id === kind) || WRITE_KINDS[0];
    list.replaceChildren(...results.map((line) => {
      const b = h('button.ai-line', { type: 'button', role: 'listitem', 'aria-label': `Add "${line}" as text` }, h('span', line), icon('plus', 14));
      b.addEventListener('click', () => {
        actions.addText(k.preset, { text: line });
        announce('Text added');
      });
      return b;
    }));
  }

  const form = h('div.cap-form.ai-form',
    h('p.asset-hint', 'Get ideas for text from Puter AI, then click one to add it at the playhead.'),
    h('div.field', h('span.field-label', 'Write'), kindSel),
    h('div.field', h('span.field-label', 'Tone'), toneSel),
    topic,
    transcriptRow,
    go,
    list,
  );
  return {
    get el() {
      transcriptRow.hidden = !transcriptWords(store.project).length;
      if (!aiAvailable(ctx) && !ctx.textAiChat) {
        const btn = ctx.account?.onSignIn ? h('button.btn.primary', { type: 'button', onclick: () => ctx.account.onSignIn() }, icon('cloud', 16), 'Sign in to Puter') : null;
        return emptyState('user', 'Sign in to write with AI', 'Writing suggestions come from Puter AI, so they need a Puter account.', btn);
      }
      return form;
    },
  };
}
