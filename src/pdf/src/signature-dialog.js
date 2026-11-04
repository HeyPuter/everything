import { el, button, modal, toast } from './lib/ui.js';
import {
  smoothStroke,
  strokesBounds,
  fitSignature,
  PEN_WIDTH,
  DOT_LENGTH,
  MAX_SIGNATURE_TEXT,
  loadScriptFont,
  typedOutline,
} from './core/signature.js';
import { MAX_IMAGE_SIZE, isPng, isJpeg } from './core/document.js';
import { normalizeJpegPadding } from './core/jpeg.js';

const STORAGE_KEY = 'pdf-editor:signatures';
const FONT_FAMILY = 'Great Vibes';
/** Signatures made in this session; kept on the device only when the person asks. */
let saved = null;
let fontFace;

function loadSaved() {
  if (saved) return saved;
  saved = [];
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (Array.isArray(stored?.items))
      saved = stored.items.filter(
        (item) =>
          (item?.type === 'draw' &&
            Array.isArray(item.strokes) &&
            item.strokes.every(
              (stroke) =>
                Array.isArray(stroke) &&
                stroke.every(
                  (point) =>
                    Array.isArray(point) && point.length === 2 && point.every(Number.isFinite),
                ),
            ) &&
            item.strokes.some((stroke) => stroke.length)) ||
          (item?.type === 'type' && typeof item.text === 'string'),
      );
  } catch {
    /* Remembered signatures are optional. */
  }
  return saved;
}
export const remembersSignatures = () => {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
};
function persist(remember) {
  try {
    if (!remember) localStorage.removeItem(STORAGE_KEY);
    else
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ items: saved.filter((item) => item.type !== 'image').slice(-8) }),
      );
  } catch {
    /* Storage can be full or blocked; the session copy still works. */
  }
}
/** The script font for the typed preview, from the same file the PDF outlines come from. */
function ensureFontFace() {
  if (fontFace) return fontFace;
  fontFace = (async () => {
    const face = new FontFace(
      FONT_FAMILY,
      `url(${import.meta.env.BASE_URL}fonts/GreatVibes-Regular.ttf)`,
    );
    document.fonts.add(await face.load());
  })().catch(() => {
    fontFace = null;
  });
  return fontFace;
}

/** Decode a picture for the preview; an image element accepts what createImageBitmap may not. */
async function decodeImage(blob) {
  try {
    return await createImageBitmap(blob);
  } catch {
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      return image;
    } catch {
      throw new Error('This image could not be read. Choose a PNG or JPEG image.');
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
/** Paint a signature preview; `frame` preserves the drawing pad's coordinate space on resize. */
export function paintSignature(
  canvas,
  signature,
  { hex = '#111111', padding = 6, fit = true, frame } = {},
) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.width,
    height = canvas.clientHeight || canvas.height;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const target = {
    x: padding,
    y: padding,
    width: width - 2 * padding,
    height: height - 2 * padding,
  };
  if (signature.type === 'draw') {
    const strokes = signature.strokes.filter((s) => s.length);
    if (!strokes.length) return;
    const paths = strokes.map(smoothStroke);
    const box = fit ? strokesBounds(strokes, paths) : frame || { x: 0, y: 0, width, height };
    const placed = fitSignature(box, fit ? target : { x: 0, y: 0, width, height });
    const { scale, x: ox, y: oy } = placed;
    ctx.strokeStyle = hex;
    ctx.lineWidth = Math.max(0.75, PEN_WIDTH * scale);
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath();
    for (const { start, curves } of paths) {
      const at = ([x, y]) => [ox + (x - box.x) * scale, oy + (y - box.y) * scale];
      ctx.moveTo(...at(start));
      if (!curves.length) ctx.lineTo(...at([start[0] + DOT_LENGTH, start[1]]));
      for (const c of curves)
        ctx.bezierCurveTo(...at(c.slice(0, 2)), ...at(c.slice(2, 4)), ...at(c.slice(4, 6)));
    }
    ctx.stroke();
  } else if (signature.type === 'type') {
    ctx.fillStyle = hex;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.font = `${target.height * 0.62}px "${FONT_FAMILY}", cursive`;
    const measured = ctx.measureText(signature.text);
    const width = measured.actualBoundingBoxLeft + measured.actualBoundingBoxRight,
      height = measured.actualBoundingBoxAscent + measured.actualBoundingBoxDescent;
    if (!(width > 0 && height > 0)) return;
    // Script flourishes can extend past the advance width. Fit and center the whole ink,
    // including tall accents, while keeping short names at their usual maximum font size.
    const scale = Math.min(1, target.width / width, target.height / height);
    ctx.save();
    ctx.translate(target.x + target.width / 2, target.y + target.height / 2);
    ctx.scale(scale, scale);
    ctx.fillText(
      signature.text,
      (measured.actualBoundingBoxLeft - measured.actualBoundingBoxRight) / 2,
      (measured.actualBoundingBoxAscent - measured.actualBoundingBoxDescent) / 2,
    );
    ctx.restore();
  } else if (signature.type === 'image' && signature.image) {
    const image = signature.image;
    const scale = Math.min(target.width / image.width, target.height / image.height);
    ctx.drawImage(
      image,
      target.x + (target.width - image.width * scale) / 2,
      target.y + (target.height - image.height * scale) / 2,
      image.width * scale,
      image.height * scale,
    );
  }
}

/**
 * Ask for a signature: drawn, typed, uploaded, or one made earlier. Resolves with
 * `{ signature, hex, outline }` or null when dismissed. Typed outlines are prepared once,
 * before accepting the dialog, and are never stored with remembered signatures.
 */
export function signatureDialog({ signal } = {}) {
  return new Promise((resolve) => {
    const items = loadSaved();
    let result = null;
    let tab = 'draw';
    let strokes = [],
      current = null;
    let upload = null,
      uploadGeneration = 0;
    let pending = false;
    const color = el('input', {
      type: 'color',
      value: '#111111',
      'aria-label': 'Signature color',
      oninput: () => repaint(),
    });
    // Drawing
    const pad = el('canvas', {
      class: 'signature-pad',
      tabindex: '0',
      role: 'img',
      'aria-label': 'Signature drawing area. Draw with a mouse, pen, or finger.',
    });
    const padHint = el('p', { class: 'signature-hint muted' }, 'Draw your signature here');
    let drawingFrame,
      padWidth = 0,
      padHeight = 0;
    function updateDrawingFrame() {
      const width = pad.clientWidth,
        height = pad.clientHeight;
      if (!(width > 0 && height > 0)) return drawingFrame;
      if (width !== padWidth || height !== padHeight || !drawingFrame) {
        if (!drawingFrame || !strokes.length) drawingFrame = { x: 0, y: 0, width, height };
        else {
          // Include strokes added in the spare space after an earlier resize. Change the
          // frame only when the pad resizes, so drawing never moves the ink under the pen.
          const ink = strokesBounds(strokes);
          const left = Math.min(drawingFrame.x, ink.x),
            top = Math.min(drawingFrame.y, ink.y);
          drawingFrame = {
            x: left,
            y: top,
            width: Math.max(drawingFrame.x + drawingFrame.width, ink.x + ink.width) - left,
            height: Math.max(drawingFrame.y + drawingFrame.height, ink.y + ink.height) - top,
          };
        }
        padWidth = width;
        padHeight = height;
      }
      return drawingFrame;
    }
    const point = (e) => {
      const r = pad.getBoundingClientRect();
      const frame = updateDrawingFrame();
      const placed = fitSignature(frame, { x: 0, y: 0, width: padWidth, height: padHeight });
      return [
        frame.x + (e.clientX - r.left - placed.x) / placed.scale,
        frame.y + (e.clientY - r.top - placed.y) / placed.scale,
      ];
    };
    pad.addEventListener('pointerdown', (e) => {
      if (pending || current || !e.isPrimary || e.button !== 0) return;
      e.preventDefault();
      current = { id: e.pointerId, points: [point(e)] };
      strokes.push(current.points);
      pad.setPointerCapture(e.pointerId);
      padHint.hidden = true;
      repaint();
    });
    pad.addEventListener('pointermove', (e) => {
      // Touch contacts receive implicit capture, including ignored secondary fingers.
      if (pending || current?.id !== e.pointerId || !pad.hasPointerCapture(e.pointerId)) return;
      current.points.push(point(e));
      repaint();
    });
    const endStroke = (e) => {
      if (current?.id !== e.pointerId) return;
      // A quick stroke can end somewhere newer than its last move sample.
      // Cancellation and capture loss have no trustworthy final drawing position.
      if (e.type === 'pointerup') {
        const end = point(e),
          last = current.points.at(-1);
        if (end.some((value, i) => value !== last[i])) current.points.push(end);
      }
      current = null;
      if (pad.hasPointerCapture(e.pointerId)) pad.releasePointerCapture(e.pointerId);
      repaint();
    };
    pad.addEventListener('pointerup', endStroke);
    pad.addEventListener('pointercancel', endStroke);
    pad.addEventListener('lostpointercapture', endStroke);
    const clear = button(
      'Clear',
      'Trash2',
      () => {
        strokes = [];
        drawingFrame = null;
        padHint.hidden = false;
        repaint();
      },
      'btn',
    );
    // Typing
    const nameInput = el('input', {
      type: 'text',
      class: 'input',
      placeholder: 'Type your name',
      'aria-label': 'Signature text',
      maxlength: MAX_SIGNATURE_TEXT,
      autocomplete: 'name',
      oninput: () => repaint(),
      // Enter places the typed signature, as Enter confirms a name typed in other dialogs.
      onkeydown: (e) => {
        if (e.key !== 'Enter' || e.isComposing || e.repeat) return;
        e.preventDefault();
        place();
      },
    });
    const typePreview = el('canvas', {
      class: 'signature-preview',
      role: 'img',
      'aria-label': 'Typed signature preview',
    });
    // Uploading
    const file = el('input', {
      type: 'file',
      accept: 'image/png,image/jpeg',
      'aria-label': 'Signature image file',
    });
    const uploadPreview = el('canvas', {
      class: 'signature-preview',
      role: 'img',
      'aria-label': 'Uploaded signature preview',
      hidden: true,
    });
    file.addEventListener('change', async () => {
      const generation = ++uploadGeneration;
      const current = () => dialog.open && generation === uploadGeneration;
      const chosen = file.files[0];
      upload?.image.close?.();
      upload = null;
      uploadPreview.hidden = true;
      if (!chosen) return;
      try {
        if (chosen.size > MAX_IMAGE_SIZE) throw new Error('Choose an image smaller than 20 MB.');
        const bytes = new Uint8Array(await chosen.arrayBuffer());
        if (!current()) return;
        if (!isPng(bytes) && !isJpeg(bytes)) throw new Error('Choose a PNG or JPEG image.');
        // Native decoders may reject optional JPEG markers that PDF embedding already skips.
        const image = await decodeImage(
          new Blob([normalizeJpegPadding(bytes)], { type: chosen.type }),
        );
        if (!current()) {
          image.close?.();
          return;
        }
        upload = { type: 'image', bytes, image };
        uploadPreview.hidden = false;
        repaint();
      } catch (error) {
        if (!current()) return;
        file.value = '';
        toast(error.message, { error: true });
      }
    });
    // Saved signatures
    const savedList = el('div', { class: 'signature-saved', role: 'list' });
    const savedSection = el(
      'div',
      { class: 'signature-saved-wrap' },
      el('h3', {}, 'Saved signatures'),
      savedList,
    );
    function paintSaved() {
      if (!dialog.open) return;
      savedList.querySelectorAll('canvas').forEach((canvas, i) => {
        paintSignature(canvas, items[i], { padding: 4 });
      });
    }
    function renderSaved() {
      savedList.replaceChildren();
      savedSection.hidden = !items.length;
      items.forEach((item, i) => {
        const thumb = el('canvas', { class: 'signature-thumb', 'aria-hidden': 'true' });
        const use = el(
          'button',
          {
            type: 'button',
            class: 'signature-saved-item',
            'aria-label': `Use saved signature ${i + 1}${item.type === 'type' ? `: ${item.text}` : ''}`,
            onclick: () => accept(item),
          },
          thumb,
        );
        const remove = button(
          `Delete saved signature ${i + 1}`,
          'X',
          () => {
            const restoreFocus = savedList.contains(document.activeElement);
            items.splice(i, 1);
            persist(remember.checked && items.length > 0);
            renderSaved();
            // Rebuilding the list removes its focused control. Keep keyboard deletion
            // in the same row, or the preceding row when the last item was removed.
            if (restoreFocus)
              (
                savedList.querySelectorAll('.icon-btn')[Math.min(i, items.length - 1)] || remember
              ).focus();
          },
          'icon-btn',
        );
        remove.querySelector('span').remove();
        savedList.append(
          el('div', { class: 'signature-saved-row', role: 'listitem' }, use, remove),
        );
      });
      requestAnimationFrame(paintSaved);
    }
    const remember = el('input', {
      type: 'checkbox',
      id: 'remember-signature',
      checked: remembersSignatures(),
    });
    const tabs = [
      ['draw', 'Draw'],
      ['type', 'Type'],
      ['upload', 'Upload'],
    ];
    const panels = {
      draw: el(
        'div',
        {
          class: 'signature-panel',
          role: 'tabpanel',
          id: 'signature-panel-draw',
          'aria-labelledby': 'signature-tab-draw',
        },
        el('div', { class: 'signature-pad-wrap' }, pad, padHint),
        el('div', { class: 'signature-row' }, el('label', {}, 'Color ', color), clear),
      ),
      type: el(
        'div',
        {
          class: 'signature-panel',
          role: 'tabpanel',
          id: 'signature-panel-type',
          'aria-labelledby': 'signature-tab-type',
          hidden: true,
        },
        nameInput,
        typePreview,
      ),
      upload: el(
        'div',
        {
          class: 'signature-panel',
          role: 'tabpanel',
          id: 'signature-panel-upload',
          'aria-labelledby': 'signature-tab-upload',
          hidden: true,
        },
        el('p', { class: 'muted' }, 'A PNG with a transparent background works best.'),
        file,
        uploadPreview,
      ),
    };
    const tabButtons = new Map();
    const tablist = el(
      'div',
      { class: 'signature-tabs', role: 'tablist', 'aria-label': 'Signature source' },
      ...tabs.map(([id, label]) => {
        const b = el(
          'button',
          {
            type: 'button',
            role: 'tab',
            class: 'signature-tab',
            id: `signature-tab-${id}`,
            'aria-selected': String(id === tab),
            'aria-controls': `signature-panel-${id}`,
            tabindex: id === tab ? 0 : -1,
            onclick: () => selectTab(id),
            // Left and Right step through the sources, Home and End jump to the ends.
            onkeydown: (e) => {
              const order = tabs.map(([t]) => t),
                at = order.indexOf(tab);
              if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
              e.preventDefault();
              const next =
                e.key === 'Home'
                  ? order[0]
                  : e.key === 'End'
                    ? order.at(-1)
                    : order[(at + (e.key === 'ArrowRight' ? 1 : -1) + order.length) % order.length];
              selectTab(next);
              tabButtons.get(next).focus();
            },
          },
          label,
        );
        tabButtons.set(id, b);
        return b;
      }),
    );
    function selectTab(id, { focus = true } = {}) {
      tab = id;
      tabButtons.forEach((b, key) => {
        b.setAttribute('aria-selected', String(key === id));
        b.tabIndex = key === id ? 0 : -1;
      });
      Object.entries(panels).forEach(([key, panel]) => (panel.hidden = key !== id));
      if (id === 'type') ensureFontFace()?.then(() => repaint());
      repaint();
      if (focus && id === 'type') nameInput.focus();
    }
    function repaint() {
      if (!dialog.open) return;
      const hex = color.value;
      if (tab === 'draw')
        paintSignature(
          pad,
          { type: 'draw', strokes },
          { hex, fit: false, frame: updateDrawingFrame() },
        );
      else if (tab === 'type')
        paintSignature(typePreview, { type: 'type', text: nameInput.value.trim() || ' ' }, { hex });
      else if (upload) paintSignature(uploadPreview, upload, { hex });
    }
    const place = () => {
      let signature;
      if (tab === 'draw') {
        if (!strokes.some((s) => s.length)) {
          toast('Draw your signature first.', { error: true });
          return;
        }
        signature = {
          type: 'draw',
          strokes: strokes.map((s) =>
            s.map(([x, y]) => [Number(x.toFixed(2)), Number(y.toFixed(2))]),
          ),
        };
      } else if (tab === 'type') {
        const text = nameInput.value.trim();
        if (!text) {
          toast('Type your name for the signature.', { error: true });
          nameInput.focus();
          return;
        }
        signature = { type: 'type', text };
      } else {
        if (!upload) {
          toast('Choose a PNG or JPEG image of your signature.', { error: true });
          return;
        }
        signature = { type: 'image', bytes: upload.bytes };
      }
      accept(signature);
    };
    async function accept(signature) {
      if (pending || !dialog.open || signal?.aborted) return;
      const hex = color.value,
        keep = remember.checked;
      let outline;
      if (signature.type === 'type') {
        pending = true;
        const controls = [
          ...body.querySelectorAll('input:not(:disabled), button:not(:disabled)'),
          placeButton,
        ];
        controls.forEach((control) => (control.disabled = true));
        dialog.setAttribute('aria-busy', 'true');
        try {
          const [{ default: fontkit }, bytes] = await Promise.all([
            import('@pdf-lib/fontkit'),
            loadScriptFont(),
          ]);
          if (!dialog.open || signal?.aborted) return;
          outline = typedOutline(fontkit, bytes, signature.text);
        } catch (error) {
          if (!dialog.open || signal?.aborted) return;
          // Older saved signatures can contain text the PDF font cannot draw either.
          nameInput.value = signature.text;
          selectTab('type', { focus: false });
          toast(error.message, { error: true });
          return;
        } finally {
          pending = false;
          controls.forEach((control) => (control.disabled = false));
          dialog.removeAttribute('aria-busy');
          if (
            dialog.open &&
            !outline &&
            (document.activeElement === document.body ||
              document.activeElement === dialog ||
              controls.includes(document.activeElement))
          )
            nameInput.focus();
        }
      }
      const key = JSON.stringify({ ...signature, image: undefined, bytes: undefined });
      if (
        signature.type !== 'image' &&
        !items.some(
          (item) => JSON.stringify({ ...item, image: undefined, bytes: undefined }) === key,
        )
      )
        items.push(signature);
      persist(keep);
      result = { signature, hex, outline };
      dialog.close();
    }
    const body = el(
      'div',
      { class: 'signature-body' },
      tablist,
      panels.draw,
      panels.type,
      panels.upload,
      savedSection,
      el(
        'label',
        { class: 'checkbox-row signature-remember', for: 'remember-signature' },
        el('span', {}, 'Remember drawn and typed signatures on this device'),
        remember,
      ),
    );
    const placeButton = button('Place signature', 'Signature', place, 'btn primary');
    const dialog = modal(
      'Add signature',
      body,
      [button('Cancel', null, () => dialog.close()), placeButton],
      { signal },
    );
    dialog.classList.add('signature-dialog');
    const resize = new ResizeObserver(() => {
      if (!dialog.open) return;
      repaint();
      paintSaved();
    });
    resize.observe(body);
    dialog.addEventListener(
      'close',
      () => {
        resize.disconnect();
        uploadGeneration++;
        upload?.image.close?.();
        upload = null;
        resolve(result);
      },
      { once: true },
    );
    renderSaved();
    if (items.some((item) => item.type === 'type')) ensureFontFace().then(paintSaved);
    requestAnimationFrame(() => repaint());
  });
}
