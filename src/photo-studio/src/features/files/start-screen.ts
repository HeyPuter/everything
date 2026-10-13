// The start screen: quick presets for a new document and recent documents
// (thumbnails of files opened or saved recently, captured at that time and
// kept in browser storage).
import type { Editor } from '../../editor';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import { localStore } from '../../persistence/local-store';
import { relativeTime } from '../../persistence/versions';
import { documentThumbnail } from '../versions/thumbs';
import { onRecentChange, onRecentNoted, openRecent, recentEntries, thumbKey, type RecentEntry } from './recent';
import { PRESETS, defaultSpec, specFromPreset } from '../../model/document-presets';
import { createDocument } from './new-document';

// A few common starting points; File → New lists every preset.
const QUICK_PRESETS = ['web-large', 'web-post', 'print-a4', 'photo-4x6', 'mobile-standard'];

const SHOWN = 8;
let urls: string[] = [];

async function render(e: Editor) {
  const host = e.root.querySelector<HTMLElement>('#empty');
  if (!host) return;
  let section = host.querySelector<HTMLElement>('.start-recent');
  const list = recentEntries().slice(0, SHOWN);
  if (!list.length) {
    section?.remove();
    host.classList.remove('has-recent');
    return;
  }
  if (!section) {
    section = document.createElement('section');
    section.className = 'start-recent';
    section.setAttribute('aria-label', 'Recent documents');
    host.querySelector('.start-drop')?.before(section);
    section.addEventListener('click', (ev) => {
      const i = (ev.target as HTMLElement).closest<HTMLElement>('[data-recent]')?.dataset.recent;
      const entry = i !== undefined ? recentEntries()[Number(i)] : undefined;
      if (entry) void e.run(async () => openRecent(e, entry));
    });
  }
  host.classList.add('has-recent');
  const thumbs = await Promise.all(list.map((x) => (thumbKey(x.source) ? localStore().get<Blob>('thumbs', thumbKey(x.source)).catch(() => undefined) : undefined)));
  for (const u of urls) URL.revokeObjectURL(u);
  urls = thumbs.map((b) => (b ? URL.createObjectURL(b) : ''));
  const where = (x: RecentEntry) => (x.source.kind === 'puter' ? x.source.path.replace(/\/[^/]*$/, '') || '/' : 'This device');
  section.innerHTML = `<h2>Recent</h2><div class="start-recent-grid">${list
    .map(
      (x, i) =>
        `<button type="button" class="start-recent-item" data-recent="${i}" title="${escapeXML(x.source.kind === 'puter' ? x.source.path : x.name)}"><span class="start-recent-thumb">${urls[i] ? `<img src="${urls[i]}" alt="">` : svg(x.source.kind === 'puter' ? 'cloud' : 'image', 22)}</span><span class="start-recent-name">${escapeXML(x.name)}</span><span class="start-recent-where">${escapeXML(where(x))}${x.time ? ` · ${relativeTime(x.time)}` : ''}</span></button>`,
    )
    .join('')}</div>`;
}

function renderPresets(e: Editor) {
  const host = e.root.querySelector<HTMLElement>('#empty');
  if (!host || host.querySelector('.start-presets')) return;
  const section = document.createElement('section');
  section.className = 'start-presets';
  section.setAttribute('aria-label', 'New from a preset');
  const tiles = QUICK_PRESETS.map((id) => PRESETS.find((p) => p.id === id)!).filter(Boolean);
  const unit = (u: string) => (u === 'px' ? 'px' : u);
  section.innerHTML = `<h2>New from a preset</h2><div class="start-preset-row">${tiles
    .map((p) => {
      const r = p.width / p.height;
      const w = r >= 1 ? 30 : Math.round(30 * r),
        h = r >= 1 ? Math.round(30 / r) : 30;
      return `<button type="button" class="start-preset" data-preset="${p.id}" title="Create ${escapeXML(p.name)}"><span class="start-preset-shape"><span style="width:${w}px;height:${h}px"></span></span><span class="start-preset-name">${escapeXML(p.name)}</span><span class="start-preset-size">${p.width} × ${p.height} ${unit(p.unit)}</span></button>`;
    })
    .join('')}<button type="button" class="start-preset start-preset-more" data-command="file.new" title="All presets and custom sizes">${svg('ellipsis', 18)}<span class="start-preset-name">More presets…</span><span class="start-preset-size">Custom size</span></button></div>`;
  section.addEventListener('click', (ev) => {
    const id = (ev.target as HTMLElement).closest<HTMLElement>('[data-preset]')?.dataset.preset;
    const preset = PRESETS.find((p) => p.id === id);
    if (preset) void e.run(() => createDocument(e, { ...specFromPreset(preset, e.preferences, defaultSpec()), name: 'Untitled' }));
  });
  host.querySelector('.start-head')?.after(section);
}

/** Describe an edit: a prompt with an optional image. Submitting opens the
 * image (or creates a document) and hands the prompt to the Assistant. */
function renderDescribe(e: Editor) {
  const host = e.root.querySelector<HTMLElement>('#empty');
  if (!host || host.querySelector('.start-describe')) return;
  const section = document.createElement('section');
  section.className = 'start-describe';
  section.setAttribute('aria-label', 'Describe an edit');
  section.innerHTML = `<h2>Describe an edit</h2><form class="start-describe-form" novalidate>
<textarea name="prompt" rows="2" aria-label="Describe an edit" placeholder="For example: brighten this photo, crop it to a square and add a soft vignette"></textarea>
<div class="start-describe-bar"><button type="button" class="secondary" data-describe-pick>${svg('image-plus', 15)}Choose image…</button><span class="start-describe-file" aria-live="polite">Without an image, a new document is created</span><button type="button" class="icon-button" data-describe-clear aria-label="Remove the chosen image" title="Remove the image" hidden>${svg('x', 14)}</button><span class="start-describe-spacer"></span><button type="submit" class="primary">${svg('assistant', 15)}Start</button></div>
<input type="file" accept="image/*,.psd,.psb,.photo,.tif,.tiff,.tga,.bmp,.ico" hidden>
<p class="start-describe-note">The Assistant plans the edit with Photo Studio’s own commands for you to review before anything changes. Your request and a description of the image go to Puter’s AI service (needs a Puter account).</p></form>`;
  const form = section.querySelector('form')!;
  const text = form.querySelector('textarea')!;
  const input = form.querySelector<HTMLInputElement>('input[type=file]')!;
  const label = form.querySelector<HTMLElement>('.start-describe-file')!;
  const clear = form.querySelector<HTMLButtonElement>('[data-describe-clear]')!;
  let file: File | undefined;
  const show = () => {
    label.textContent = file ? file.name : 'Without an image, a new document is created';
    clear.hidden = !file;
  };
  form.querySelector('[data-describe-pick]')!.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    file = input.files?.[0] ?? file;
    input.value = '';
    show();
  });
  clear.addEventListener('click', () => {
    file = undefined;
    show();
    text.focus();
  });
  text.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      form.requestSubmit();
    }
    ev.stopPropagation();
  });
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const prompt = text.value.trim();
    if (!prompt) {
      e.message('Describe the edit first.');
      text.focus();
      return;
    }
    const chosen = file;
    void e.run(async () => {
      if (chosen) {
        const { openFile } = await import('./open');
        if (!(await openFile(e, chosen, chosen.name))) return;
      } else await createDocument(e, { ...defaultSpec(), name: 'Untitled' });
      text.value = '';
      file = undefined;
      show();
      const { openAssistant } = await import('../assistant');
      // The request runs after this task, so the workspace is not left busy.
      window.setTimeout(() => void openAssistant(e, prompt), 0);
    });
  });
  (host.querySelector('.start-presets') ?? host.querySelector('.start-head'))?.[host.querySelector('.start-presets') ? 'before' : 'after'](section);
}

export function installStartScreen(e: Editor) {
  renderPresets(e);
  renderDescribe(e);
  onRecentChange(() => void render(e));
  // Capture a thumbnail once the opened or saved document has drawn.
  onRecentNoted((entry) => {
    const s = e.session;
    window.setTimeout(async () => {
      const key = thumbKey(entry.source);
      if (!key || !s.hasDocument || !e.sessions.includes(s)) return;
      const thumb = await documentThumbnail(e, s, 240).catch(() => undefined);
      if (!thumb) return;
      await localStore().put('thumbs', key, thumb).catch(() => undefined);
      void render(e);
    }, 1500);
  });
  void render(e);
}
