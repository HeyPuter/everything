// The start screen (home): a rail with New / Open and the Home, Learn and
// Recent files views; Home offers Describe an edit, quick presets, recent
// documents (thumbnails captured when a file is opened or saved, kept in
// browser storage) and tutorials.
import './start-screen.css';
import type { Editor } from '../../editor';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import { localStore } from '../../persistence/local-store';
import { relativeTime } from '../../persistence/versions';
import { documentThumbnail } from '../versions/thumbs';
import {
  clearRecent,
  onRecentChange,
  onRecentNoted,
  openRecent,
  recentEntries,
  thumbKey,
  type RecentEntry,
} from './recent';
import { PRESETS, defaultSpec, specFromPreset } from '../../model/document-presets';
import { sentNote } from '../assistant/settings';

// A few common starting points; File → New lists every preset.
const QUICK_PRESETS = ['web-large', 'web-post', 'print-a4', 'photo-4x6', 'mobile-standard'];

export type StartView = 'home' | 'learn' | 'files';
export type RecentLayout = 'grid' | 'list';
const LAYOUT_KEY = 'photo-studio-start-recent-layout';

/** Recent documents shown on Home; the Recent files view lists them all. */
export const HOME_RECENT = 6;
let urls: string[] = [];
let renderRevision = 0;

/** A slot of the start screen that a feature fills. */
export function startSlot(e: Editor, name: string) {
  return e.root.querySelector<HTMLElement>(`#empty [data-slot="${name}"]`);
}

export function recentLayout(): RecentLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}
function setRecentLayout(e: Editor, layout: RecentLayout) {
  try {
    localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    /* Optional. */
  }
  void render(e);
}

/** Switch the start screen between Home, Learn and Recent files. */
export function showStartView(e: Editor, view: StartView) {
  const host = e.root.querySelector<HTMLElement>('#empty');
  if (!host) return;
  host.dataset.start = view;
  for (const b of host.querySelectorAll<HTMLElement>('[data-start-view]')) {
    if (b.dataset.startView === view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  host.querySelector<HTMLElement>('.start-main')?.scrollTo({ top: 0 });
  void render(e);
}

const where = (x: RecentEntry) =>
  x.source.kind === 'puter' ? x.source.path.replace(/\/[^/]*$/, '') || '/' : 'This device';
const kindLabel = (name: string) => {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1];
  return ext ? ext.toUpperCase() : 'Image';
};

async function render(e: Editor) {
  const revision = ++renderRevision;
  const host = e.root.querySelector<HTMLElement>('#empty');
  const slot = startSlot(e, 'recent');
  if (!host || !slot) return;
  const all = recentEntries();
  const files = host.dataset.start === 'files';
  const list = files ? all : all.slice(0, HOME_RECENT);
  host.classList.toggle('has-recent', all.length > 0);
  const layout = recentLayout();
  const thumbs = await Promise.all(
    list.map((x) =>
      thumbKey(x.source)
        ? localStore()
            .get<Blob>('thumbs', thumbKey(x.source))
            .catch(() => undefined)
        : undefined,
    ),
  );
  if (revision !== renderRevision) return;
  for (const u of urls) URL.revokeObjectURL(u);
  urls = thumbs.map((b) => (b ? URL.createObjectURL(b) : ''));
  const toggle = (value: RecentLayout, icon: string, label: string) =>
    `<button type="button" class="icon-button" data-recent-layout="${value}" aria-pressed="${layout === value}" aria-label="${label}" title="${label}">${svg(icon, 15)}</button>`;
  const head = `<div class="start-section-head"><h2>${files ? 'Recent files' : 'Recent'}</h2><span class="start-section-tools">${
    !files && all.length > HOME_RECENT
      ? `<button type="button" class="link-button" data-start-view="files">View all ${all.length}</button>`
      : ''
  }${files && all.length ? `<button type="button" class="link-button" data-recent-clear>Clear list</button>` : ''}${
    all.length
      ? `<span class="segmented start-layout" role="group" aria-label="Recent files layout">${toggle('grid', 'layout-grid', 'Show as grid')}${toggle('list', 'list', 'Show as list')}</span>`
      : ''
  }</span></div>`;
  const items = list
    .map((x, i) => {
      const title = escapeXML(x.source.kind === 'puter' ? x.source.path : x.name);
      const thumb = `<span class="start-recent-thumb">${urls[i] ? `<img src="${urls[i]}" alt="">` : svg(x.source.kind === 'puter' ? 'cloud' : 'image', 22)}</span>`;
      const time = x.time ? relativeTime(x.time) : '';
      return layout === 'list'
        ? `<button type="button" class="start-recent-item" data-recent="${i}" title="${title}" role="listitem">${thumb}<span class="start-recent-name">${escapeXML(x.name)}</span><span class="start-recent-kind">${kindLabel(x.name)}</span><span class="start-recent-where">${escapeXML(where(x))}</span><span class="start-recent-time">${time}</span></button>`
        : `<button type="button" class="start-recent-item" data-recent="${i}" title="${title}" role="listitem">${thumb}<span class="start-recent-name">${escapeXML(x.name)}</span><span class="start-recent-where">${escapeXML(where(x))}${time ? ` · ${time}` : ''}</span></button>`;
    })
    .join('');
  const empty = `<div class="start-recent-empty">${svg('file-clock', 28)}<strong>No recent files</strong><span>Files you open or save show up here.</span></div>`;
  slot.innerHTML = `<section class="start-recent" aria-label="Recent documents">${head}${
    list.length
      ? `<div class="start-recent-grid${layout === 'list' ? ' as-list' : ''}" role="list">${items}</div>`
      : empty
  }</section>`;
  // Bind actions to the displayed snapshot while the next list loads.
  slot.onclick = (ev) => {
    const target = ev.target as HTMLElement;
    const lay = target.closest<HTMLElement>('[data-recent-layout]')?.dataset.recentLayout as
      RecentLayout | undefined;
    if (lay) return setRecentLayout(e, lay);
    if (target.closest('[data-recent-clear]')) return clearRecent(e);
    const i = target.closest<HTMLElement>('[data-recent]')?.dataset.recent;
    const entry = i !== undefined ? list[Number(i)] : undefined;
    if (entry) void e.run(async () => openRecent(e, entry));
  };
}

function renderPresets(e: Editor) {
  const slot = startSlot(e, 'presets');
  if (!slot || slot.querySelector('.start-presets')) return;
  const section = document.createElement('section');
  section.className = 'start-presets';
  section.setAttribute('aria-label', 'New from a preset');
  const tiles = QUICK_PRESETS.map((id) => PRESETS.find((p) => p.id === id)!).filter(Boolean);
  section.innerHTML = `<div class="start-section-head"><h2>New from a preset</h2></div><div class="start-preset-row">${tiles
    .map((p) => {
      const r = p.width / p.height;
      const w = r >= 1 ? 26 : Math.round(26 * r),
        h = r >= 1 ? Math.round(26 / r) : 26;
      return `<button type="button" class="start-preset" data-preset="${p.id}" title="Create ${escapeXML(p.name)}"><span class="start-preset-shape"><span style="width:${w}px;height:${h}px"></span></span><span class="start-preset-text"><span class="start-preset-name">${escapeXML(p.name)}</span><span class="start-preset-size">${p.width} × ${p.height} ${p.unit}</span></span></button>`;
    })
    .join(
      '',
    )}<button type="button" class="start-preset start-preset-more" data-command="file.new" title="All presets and custom sizes"><span class="start-preset-shape">${svg('ellipsis', 18)}</span><span class="start-preset-text"><span class="start-preset-name">More presets…</span><span class="start-preset-size">Custom size</span></span></button></div>`;
  section.addEventListener('click', (ev) => {
    const id = (ev.target as HTMLElement).closest<HTMLElement>('[data-preset]')?.dataset.preset;
    const preset = PRESETS.find((p) => p.id === id);
    if (preset)
      void e.run(async () => {
        // The New Document module loads on demand (prefetched when idle).
        const { createDocument } = await import('./new-document');
        await createDocument(e, {
          ...specFromPreset(preset, e.preferences, defaultSpec()),
          name: 'Untitled',
        });
      });
  });
  slot.append(section);
}

/** Describe an edit: a prompt with an optional image. Submitting opens the
 * image (or creates a document) and hands the prompt to the Assistant. */
function renderDescribe(e: Editor) {
  const slot = startSlot(e, 'describe');
  if (!slot || slot.querySelector('.start-describe')) return;
  const section = document.createElement('section');
  section.className = 'start-describe';
  section.setAttribute('aria-label', 'Describe an edit');
  section.innerHTML = `<form class="start-describe-form" novalidate>
<div class="start-describe-title">${svg('assistant', 15)}<h2>Describe an edit</h2></div>
<textarea name="prompt" rows="2" aria-label="Describe an edit" placeholder="For example: brighten this photo, crop it to a square and add a soft vignette"></textarea>
<div class="start-describe-bar"><button type="button" class="secondary" data-describe-pick>${svg('image-plus', 15)}Choose image…</button><span class="start-describe-file" aria-live="polite">Without an image, a new document is created</span><button type="button" class="icon-button" data-describe-clear aria-label="Remove the chosen image" title="Remove the image" hidden>${svg('x', 14)}</button><span class="start-describe-spacer"></span><button type="submit" class="primary">${svg('assistant', 15)}Start</button></div>
<input type="file" accept="image/*,.psd,.psb,.photo,.tif,.tiff,.tga,.bmp,.ico" hidden>
<p class="start-describe-note">The Assistant plans the edit with Photo Studio’s own commands for you to review before anything changes. <span class="start-describe-sent"></span></p></form>`;
  const form = section.querySelector('form')!;
  // The request runs with a document, so it says what the Assistant panel
  // says then (the preview follows the Share Image Preview setting).
  const sent = form.querySelector<HTMLElement>('.start-describe-sent')!;
  const note = () => (sent.textContent = sentNote(true));
  note();
  for (const type of ['focusin', 'pointerenter']) form.addEventListener(type, note);
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
      } else {
        const { createDocument } = await import('./new-document');
        await createDocument(e, { ...defaultSpec(), name: 'Untitled' });
      }
      text.value = '';
      file = undefined;
      show();
      const { openAssistant } = await import('../assistant');
      // The request runs after this task, so the workspace is not left busy.
      window.setTimeout(() => void openAssistant(e, prompt), 0);
    });
  });
  slot.append(section);
}

export function installStartScreen(e: Editor) {
  renderDescribe(e);
  renderPresets(e);
  const host = e.root.querySelector<HTMLElement>('#empty');
  host?.addEventListener('click', (ev) => {
    const view = (ev.target as HTMLElement).closest<HTMLElement>('[data-start-view]')?.dataset
      .startView as StartView | undefined;
    if (view) showStartView(e, view);
  });
  onRecentChange(() => void render(e));
  // Capture a thumbnail once the opened or saved document has drawn.
  onRecentNoted((entry) => {
    const s = e.session;
    window.setTimeout(async () => {
      const key = thumbKey(entry.source);
      if (!key || !s.hasDocument || !e.sessions.includes(s)) return;
      const thumb = await documentThumbnail(e, s, 240).catch(() => undefined);
      if (!thumb) return;
      await localStore()
        .put('thumbs', key, thumb)
        .catch(() => undefined);
      void render(e);
    }, 1500);
  });
  void render(e);
}
