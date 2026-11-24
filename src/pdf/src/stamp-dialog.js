import { el, button, modal, toast } from './lib/ui.js';
import { MAX_STAMP_TEXT, STAMP_PRESETS, loadStampFont, stampOutline } from './core/stamp.js';
import { fitSignature } from './core/signature.js';

/** Choose and prepare a stamp. Resolves to { text, hex, outline }, or null when dismissed. */
export function stampDialog({ signal, size = { width: 260, height: 117 } } = {}) {
  return new Promise((resolve) => {
    let result = null;
    let pending = false;
    let fontReady,
      preparedText,
      preparedOutline,
      previewGeneration = 0;
    const font = () => {
      fontReady ||= Promise.all([import('@pdf-lib/fontkit'), loadStampFont()]).catch((error) => {
        fontReady = null;
        throw error;
      });
      return fontReady;
    };
    const prepare = (fontkit, bytes, value) => {
      if (value !== preparedText) {
        const outline = stampOutline(fontkit, bytes, value);
        preparedText = value;
        preparedOutline = outline;
      }
      return preparedOutline;
    };
    const text = el('input', {
      class: 'input',
      id: 'stamp-text',
      value: STAMP_PRESETS[0].text,
      maxlength: MAX_STAMP_TEXT,
      autocomplete: 'off',
      required: true,
    });
    const colorPick = el('input', {
      type: 'color',
      id: 'stamp-color',
      value: STAMP_PRESETS[0].hex,
    });
    // The preview is drawn, not typed: a stamp's color need not read as text on the dialog.
    const preview = el('canvas', { class: 'stamp-preview', 'aria-hidden': 'true' });
    const previewStatus = el('p', { class: 'stamp-preview-status', role: 'status' });
    const chips = STAMP_PRESETS.map((preset) =>
      el(
        'button',
        {
          type: 'button',
          class: 'stamp-chip',
          style: `--stamp-color: ${preset.hex}`,
          'aria-pressed': 'false',
          onclick: () => {
            text.value = preset.text;
            colorPick.value = preset.hex;
            sync();
          },
        },
        preset.text,
      ),
    );
    const paintPreview = async () => {
      const generation = ++previewGeneration;
      const current = () => dialog.open && !signal?.aborted && generation === previewGeneration;
      if (!current()) return;
      const ratio = window.devicePixelRatio || 1;
      const width = preview.clientWidth || 400,
        height = preview.clientHeight || 84;
      preview.width = Math.round(width * ratio);
      preview.height = Math.round(height * ratio);
      const ctx = preview.getContext('2d');
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const value = text.value.trim();
      previewStatus.hidden = false;
      previewStatus.textContent = value ? 'Loading preview…' : 'Enter text to preview the stamp.';
      if (!value) return;
      try {
        const [{ default: fontkit }, bytes] = await font();
        if (!current()) return;
        const { commands, box, stroke } = prepare(fontkit, bytes, value);
        const placed = fitSignature(box, { x: 8, y: 8, width: width - 16, height: height - 16 });
        const pdfScale = fitSignature(box, { x: 0, y: 0, ...size }).scale;
        const map = (x, y) => [
          placed.x + (x - box.x) * placed.scale,
          placed.y + placed.height - (y - box.y) * placed.scale,
        ];
        ctx.strokeStyle = ctx.fillStyle = colorPick.value;
        // Match the PDF's minimum pen width, including when a long label is scaled down.
        ctx.lineWidth = (Math.max(0.3, stroke * pdfScale) / pdfScale) * placed.scale;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        for (const [op, ...args] of commands) {
          if (op === 'm') ctx.moveTo(...map(...args));
          else if (op === 'l') ctx.lineTo(...map(...args));
          else if (op === 'c')
            ctx.bezierCurveTo(
              ...map(args[0], args[1]),
              ...map(args[2], args[3]),
              ...map(args[4], args[5]),
            );
          else ctx.closePath();
        }
        ctx.fill();
        ctx.stroke();
        previewStatus.hidden = true;
      } catch (error) {
        if (current()) previewStatus.textContent = error.message;
      }
    };
    const sync = () => {
      for (const chip of chips)
        chip.setAttribute(
          'aria-pressed',
          String(
            chip.textContent === text.value.trim() &&
              chip.style.getPropertyValue('--stamp-color').trim() === colorPick.value,
          ),
        );
      paintPreview();
    };
    text.oninput = () => {
      text.removeAttribute('aria-invalid');
      sync();
    };
    colorPick.oninput = sync;
    const form = el(
      'form',
      { class: 'stack' },
      el(
        'p',
        { class: 'muted' },
        'The stamp lands in the middle of the page, selected, ready to drag, resize, or recolor.',
      ),
      el('div', { class: 'stamp-presets', role: 'group', 'aria-label': 'Preset stamps' }, ...chips),
      el(
        'div',
        { class: 'field-grid' },
        el('div', { class: 'field' }, el('label', { for: 'stamp-text' }, 'Text'), text),
        el('div', { class: 'field' }, el('label', { for: 'stamp-color' }, 'Color'), colorPick),
      ),
      el('div', { class: 'stamp-preview-wrap' }, preview, previewStatus),
    );
    const place = async () => {
      if (pending || !dialog.open || signal?.aborted) return;
      if (!text.value.trim()) {
        toast('Enter the stamp text.', { error: true });
        // Marked as refused, for screen readers too, until it is typed in.
        text.setAttribute('aria-invalid', 'true');
        text.focus();
        return;
      }
      const choice = { text: text.value.trim(), hex: colorPick.value };
      pending = true;
      const controls = [
        ...form.querySelectorAll('input:not(:disabled), button:not(:disabled)'),
        placeButton,
      ];
      controls.forEach((control) => (control.disabled = true));
      dialog.setAttribute('aria-busy', 'true');
      try {
        const [{ default: fontkit }, bytes] = await font();
        if (!dialog.open || signal?.aborted) return;
        const outline = prepare(fontkit, bytes, choice.text);
        result = { ...choice, outline };
        dialog.close();
      } catch (error) {
        if (!dialog.open || signal?.aborted) return;
        toast(error.message, { error: true });
      } finally {
        pending = false;
        controls.forEach((control) => (control.disabled = false));
        dialog.removeAttribute('aria-busy');
        if (
          dialog.open &&
          (document.activeElement === document.body ||
            document.activeElement === dialog ||
            controls.includes(document.activeElement))
        )
          text.focus();
      }
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      place();
    };
    const placeButton = button('Place stamp', 'Stamp', place, 'btn primary');
    const dialog = modal(
      'Add stamp',
      form,
      [button('Cancel', null, () => dialog.close()), placeButton],
      { signal },
    );
    const resize = new ResizeObserver(paintPreview);
    resize.observe(preview);
    dialog.addEventListener(
      'close',
      () => {
        resize.disconnect();
        resolve(result);
      },
      { once: true },
    );
    sync();
    text.focus();
    text.select();
  });
}
