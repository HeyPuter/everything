/**
 * System integration: the OS clipboard and drag and drop.
 *
 * Copy/Cut also write the copied artwork as SVG text (text/plain, plus
 * image/svg+xml where the browser allows) so it pastes into other apps.
 * The SVG carries a marker comment with the internal clipboard stamp, so a
 * paste can tell our own copy (handled by the core with full fidelity) from
 * artwork or images copied elsewhere.
 *
 * Paste: Cmd/Ctrl+V on the canvas lets the browser fire a real `paste`
 * event (no permission prompt) and reads its data; Edit > Paste from the
 * menu falls back to navigator.clipboard.read() when nothing was copied
 * here. Dropping SVG or image files on the canvas places them at the drop
 * point; dropping documents or SVGs on the home screen opens them.
 */
import { clipboard } from '../../ops/clipboard.js';
import { IS_MAC } from '../../commands/registry.js';
import { fileKind } from './kinds.js';

const MARK = 'vector-studio-clip:';

function isTypingTarget(t) {
  if (!t || !t.tagName) return false;
  if (t.isContentEditable) return true;
  if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  if (t.tagName === 'INPUT') return !['checkbox', 'radio', 'button', 'range'].includes(t.type);
  return false;
}

function extractSVG(s) {
  if (!s) return null;
  const i = s.search(/<svg[\s>]/i);
  if (i < 0) return null;
  const j = s.lastIndexOf('</svg>');
  if (j < i) return null;
  // Keep namespace declarations made on an XML prolog-less fragment.
  return s.slice(i, j + 6);
}

export function installSystemIO(app, loadIO) {
  const state = { lastWrite: null, pendingPaste: 0 };
  let io = null; // the loaded on-demand module, once available
  const load = async () => (io = await loadIO());

  app.clipboardToSystem = async () => {
    const data = clipboard.data;
    if (!data || !navigator.clipboard) return;
    state.lastWrite = { stamp: data.stamp, ok: false };
    const make = (m) => {
      try {
        return m.clipboardSVG(data, MARK);
      } catch {
        return null;
      }
    };
    // The write must start while the copy shortcut is being handled, so the
    // SVG is passed as a promise when the export code is not loaded yet.
    const svgNow = io ? make(io) : null;
    if (io && !svgNow) return;
    const svgText = svgNow != null ? Promise.resolve(svgNow) : load().then(make);
    const blobOf = (type) => svgText.then((t) => {
      if (!t) throw new Error('Nothing to copy');
      return new Blob([t], { type });
    });
    const attempts = [];
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
      const svgOk = typeof ClipboardItem.supports === 'function' ? ClipboardItem.supports('image/svg+xml') : false;
      if (svgOk) attempts.push(() => navigator.clipboard.write([new ClipboardItem({ 'text/plain': blobOf('text/plain'), 'image/svg+xml': blobOf('image/svg+xml') })]));
      attempts.push(() => navigator.clipboard.write([new ClipboardItem({ 'text/plain': blobOf('text/plain') })]));
    }
    if (navigator.clipboard.writeText) attempts.push(async () => navigator.clipboard.writeText(await svgText));
    for (const attempt of attempts) {
      try {
        await attempt();
        state.lastWrite.ok = true;
        return;
      } catch {
        // Permission or format refused: try the next, simpler option.
      }
    }
  };

  const internalPaste = () => app.commands.run('edit.paste', { internal: true });

  const isOwn = (text) => Boolean(clipboard.data && text && text.includes(`${MARK}${clipboard.data.stamp}`));
  // When our last system write failed, the system clipboard may be stale: prefer the internal copy.
  const systemIsNewer = () => !clipboard.data || state.lastWrite?.ok;

  /** Handle pasted data. Returns true when something was pasted. */
  async function pasteData({ text = '', html = '', files = [] }) {
    const editor = app.editor;
    if (!editor) return false;
    if (isOwn(text) || isOwn(html)) {
      await internalPaste();
      return true;
    }
    if (!systemIsNewer()) {
      await internalPaste();
      return true;
    }
    const placeable = files.filter((f) => fileKind(f) && fileKind(f) !== 'document');
    const svgText = extractSVG(text) || extractSVG(html);
    if (svgText) {
      try {
        return Boolean(await (await load()).placeSVG(app, editor, svgText, { name: '' }));
      } catch {
        // Not valid SVG after all: fall through to files or plain text.
      }
    }
    if (placeable.length) {
      let ok = false;
      const m = await load();
      for (const f of placeable) ok = Boolean(await m.placeFile(app, editor, f)) || ok;
      return ok;
    }
    if (text && text.trim()) return Boolean((await load()).placeText(app, editor, text));
    if (clipboard.data) {
      await internalPaste();
      return true;
    }
    return false;
  }

  // Edit > Paste from the menu: read the system clipboard when allowed.
  const core = app.commands.get('edit.paste');
  if (core) {
    app.commands.register({
      ...core,
      run: async (a, args) => {
        if (args?.internal || !navigator.clipboard?.read) return core.run(a, args);
        if (clipboard.data && !state.lastWrite?.ok) return core.run(a, args);
        let data = null;
        try {
          const items = await navigator.clipboard.read();
          data = { text: '', html: '', files: [] };
          for (const item of items) {
            for (const type of item.types) {
              const blob = await item.getType(type);
              if (type === 'text/plain') data.text = await blob.text();
              else if (type === 'text/html') data.html = await blob.text();
              else if (type === 'image/svg+xml') data.files.push(new File([blob], 'clipboard.svg', { type }));
              else if (/^image\//.test(type)) data.files.push(new File([blob], `clipboard.${type.split('/')[1]}`, { type }));
            }
          }
        } catch {
          data = null;
        }
        if (data && (await pasteData(data))) return true;
        return core.run(a, args);
      },
    });
  }

  // Cmd/Ctrl+V on the canvas: let the browser deliver a paste event with the clipboard contents.
  window.addEventListener(
    'keydown',
    (e) => {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      if (!mod || e.shiftKey || e.altKey || (e.code !== 'KeyV' && e.key?.toLowerCase() !== 'v')) return;
      if (!app.editor || document.querySelector('dialog[open]') || isTypingTarget(e.target) || app.editor.textEdit) return;
      if (app.home && !app.home.hidden) return;
      e.stopImmediatePropagation();
      clearTimeout(state.pendingPaste);
      // Browsers that do not fire paste events on non-editable elements fall back to the internal copy.
      state.pendingPaste = setTimeout(() => {
        state.pendingPaste = 0;
        internalPaste();
      }, 250);
    },
    true,
  );

  document.addEventListener('paste', (e) => {
    if (isTypingTarget(e.target) || !app.editor || app.editor.textEdit || document.querySelector('dialog[open]')) return;
    if (app.home && !app.home.hidden) return;
    clearTimeout(state.pendingPaste);
    state.pendingPaste = 0;
    const dt = e.clipboardData;
    if (!dt) return;
    e.preventDefault();
    const files = [];
    for (const item of dt.items || []) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    pasteData({ text: dt.getData('text/plain'), html: dt.getData('text/html'), files }).catch((err) => app.notify(err?.message || 'Could not paste.', { error: true }));
  });

  app.on('started', () => installDrop(app, load));
  return { pasteData, state };
}

function hasFiles(e) {
  return [...(e.dataTransfer?.types || [])].includes('Files');
}

async function openDropped(app, file, load) {
  const kind = fileKind(file);
  if (kind === 'document' || ((kind === 'svg' || kind === 'pdf' || kind === 'eps' || kind === 'dxf') && app.openFileBlob)) {
    if (app.openFileBlob) return app.openFileBlob(file);
    app.notify('Opening documents is not available.', { error: true });
    return null;
  }
  if (kind === 'svg') return (await load()).openSVGFile(app, file);
  if (kind === 'image') return (await load()).openImageFile(app, file);
  app.notify(`${file.name} is not a file Vector Studio can open.`, { error: true });
  return null;
}

function installDrop(app, load) {
  const host = app.canvasHost;
  const home = app.home;
  const over = (el) => (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    el.classList.add('io-drop-target');
  };
  const leave = (el) => (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('io-drop-target');
  };
  if (host) {
    host.addEventListener('dragover', over(host));
    host.addEventListener('dragleave', leave(host));
    host.addEventListener('drop', async (e) => {
      host.classList.remove('io-drop-target');
      if (!hasFiles(e)) return;
      e.preventDefault();
      const files = [...e.dataTransfer.files];
      const editor = app.editor;
      if (!editor) {
        for (const f of files) await openDropped(app, f, load).catch((err) => app.notify(err?.message || 'Could not open the file.', { error: true }));
        return;
      }
      const r = host.getBoundingClientRect();
      let p = editor.view.toDoc(e.clientX - r.left, e.clientY - r.top);
      const placed = [];
      for (const f of files) {
        if (fileKind(f) === 'document') {
          await openDropped(app, f, load);
          continue;
        }
        const id = await (await load()).placeFile(app, editor, f, { point: p, select: false });
        if (id) placed.push(id);
        p = { x: p.x + 10, y: p.y + 10 };
      }
      if (placed.length && app.editor === editor) editor.select(placed);
    });
  }
  if (home) {
    home.addEventListener('dragover', over(home));
    home.addEventListener('dragleave', leave(home));
    home.addEventListener('drop', async (e) => {
      home.classList.remove('io-drop-target');
      if (!hasFiles(e)) return;
      e.preventDefault();
      for (const f of e.dataTransfer.files) await openDropped(app, f, load).catch((err) => app.notify(err?.message || 'Could not open the file.', { error: true }));
    });
  }
}

