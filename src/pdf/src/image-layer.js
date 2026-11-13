import { el, button, iconButton } from './lib/ui.js';
import { matrix } from './core/text-edit.js';
import { pathColorHex } from './core/path-edit.js';
import {
  imageCorners,
  constrainImage,
  inverse,
  point,
  rotateAroundCenter,
  MAX_IMAGE_SIZE,
} from './core/image-edit.js';

const same = (a, b) => a.every((n, i) => Math.abs(n - b[i]) < 1e-7);
const minimumPathTarget = (node) => {
  node.setAttribute('stroke-width', '8');
  node.setAttribute('vector-effect', 'non-scaling-stroke');
};

export function createImageLayer({
  beforeSelect,
  beginSelection = () => () => {},
  canFocusSelection = (previous) =>
    document.activeElement === document.body || document.activeElement === previous,
  onCommit,
  onChange,
  preparePreview,
  onProperties = () => {},
}) {
  const targets = el('div', { class: 'image-targets' });
  const controls = el('div', { class: 'image-controls', hidden: true });
  const properties = el('div');
  const ownsFocus = (node) => controls.contains(node) || properties.contains(node);
  const preview = el('div', { class: 'image-preview', hidden: true, 'aria-hidden': 'true' });
  let entries = [],
    viewport,
    selected = null,
    draft = null,
    gesture = null,
    busy = true,
    enabled = true,
    committing = null,
    settlingFocus = false,
    keepCommitProperties = false,
    selecting = null,
    selectionGeneration = 0,
    replacementGeneration = 0,
    choosing = null,
    keyboardTimer,
    previewController,
    preservingInputSelection = false,
    bitmap,
    background,
    previewKey;
  const heldArrows = new Set();
  let renderKey, pageKey;
  let keepRatio = true;
  const dirty = () => !!(selected && draft && !same(selected.transform, draft));
  const pendingInputs = () =>
    [...properties.querySelectorAll('input[type="number"]')].filter(
      (input) =>
        input.value !== input.defaultValue &&
        (!input.validity.valid || input.valueAsNumber !== Number(input.defaultValue)),
    );
  const current = () => draft || selected.transform;
  const rotation = () => {
    const m = matrix(viewport.transform, current());
    return ((Math.atan2(m[1], m[0]) * 180) / Math.PI + 360) % 360;
  };
  const kind = (entry = selected) => entry?.kind || 'image';
  const title = () => kind()[0].toUpperCase() + kind().slice(1);
  const pointAt = (e) => {
    const r = targets.getBoundingClientRect();
    return [
      ((e.clientX - r.left) * viewport.width) / r.width,
      ((e.clientY - r.top) * viewport.height) / r.height,
    ];
  };
  const pdfPoint = (p) => viewport.convertToPdfPoint(...p);
  function setBusy(value) {
    busy = value;
    for (const control of [
      ...targets.querySelectorAll('button'),
      ...controls.querySelectorAll('button'),
      ...properties.querySelectorAll('button, input'),
    ]) {
      const blocked = busy || !!committing;
      // During a native blur/focus sequence, semantic disablement blocks
      // actions without removing the destination from the browser's tab order.
      control.disabled = blocked && !settlingFocus;
      if (blocked && settlingFocus) control.setAttribute('aria-disabled', 'true');
      else control.removeAttribute('aria-disabled');
    }
  }
  function stopPreview() {
    previewController?.abort();
    previewController = null;
    bitmap = background = null;
    previewKey = null;
    preview.hidden = true;
    preview.replaceChildren();
  }
  function cancel(preserveSelection = false, preservePreview = false, preserveControls = false) {
    heldArrows.clear();
    if (!preserveSelection) {
      selectionGeneration++;
      choosing = null;
      selecting = null;
    }
    clearTimeout(keyboardTimer);
    gesture = null;
    draft = null;
    if (!preservePreview) stopPreview();
    for (const input of pendingInputs()) input.value = input.defaultValue;
    if (!preservePreview && !preserveControls) layout(true);
    onChange();
  }
  function close(
    preserveSelection = false,
    { preservePreview = false, preserveControls = false } = {},
  ) {
    const keepControls = preserveControls && !!committing && keepCommitProperties && enabled;
    cancel(
      preserveSelection && choosing !== null,
      preservePreview && !!committing && keepCommitProperties,
      keepControls,
    );
    selected = null;
    // Leave the frame at the released transform until the new selection replaces it.
    if (!keepControls) controls.hidden = true;
    // Reloading a committed object must not collapse the dock between the old
    // and new selection. On small screens that changes the viewport height and
    // clamps its scroll position, making a completed drag or resize jump.
    if (!committing || !keepCommitProperties) {
      properties.replaceChildren();
      onProperties(null);
    }
    targets.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  }
  function selectOrdinal(ordinal, focus = false) {
    const entry = entries.find((entry) => entry.ordinal === ordinal && entry.editable);
    if (!entry) return;
    selected = entry;
    draft = null;
    buildControls();
    targets
      .querySelectorAll('button')
      .forEach((b) =>
        b.setAttribute('aria-pressed', String(Number(b.dataset.ordinal) === ordinal)),
      );
    if (focus) controls.querySelector('.image-move')?.focus({ preventScroll: true });
  }
  async function choose(entry, focus = false) {
    const focusFrom = document.activeElement;
    const generation = ++selectionGeneration;
    choosing = generation;
    const releaseLayout = beginSelection();
    try {
      if (dirty() || pendingInputs().length) await finishInputs(true);
      if (generation !== selectionGeneration) return false;
      await beforeSelect();
      // Cancellation, navigation, or a newer selection can supersede either await.
      if (generation !== selectionGeneration || !enabled) return false;
      if (!entries.some((candidate) => candidate.ordinal === entry.ordinal && candidate.editable))
        return false;
      selectOrdinal(entry.ordinal, focus && canFocusSelection(focusFrom));
      return true;
    } finally {
      if (choosing === generation) choosing = null;
      releaseLayout();
    }
  }
  function startPreview() {
    if (!selected || previewKey === selected.id) return;
    stopPreview();
    previewKey = selected.id;
    const controller = (previewController = new AbortController());
    preparePreview(selected, controller.signal)
      .then((result) => {
        if (controller.signal.aborted || !selected) return;
        ({ image: bitmap, background } = result);
        preview.replaceChildren(background, bitmap);
        layout();
      })
      .catch(() => {
        /* Keep the outline preview if a bitmap cannot be prepared. */
      });
  }
  function setDraft(next) {
    if (!selected) return;
    draft = constrainImage(selected, next);
    startPreview();
    layout();
    onChange();
  }
  function showError(error) {
    const message = properties.querySelector('.image-error');
    if (message) {
      message.hidden = false;
      message.textContent = error.message;
      layout();
    }
  }
  function chooseReplacement() {
    if (!selected || busy || committing) return;
    heldArrows.clear();
    // Keep a pending keyboard move in this replacement transaction while the
    // native picker is open; its debounce must not invalidate the selected file.
    clearTimeout(keyboardTimer);
    const entry = selected,
      generation = selectionGeneration,
      request = ++replacementGeneration;
    const applies = () =>
      selected === entry &&
      selectionGeneration === generation &&
      replacementGeneration === request &&
      enabled &&
      !busy &&
      !committing;
    const input = el('input', { type: 'file', accept: 'image/png,image/jpeg' });
    const resumeNudge = () => {
      if (!applies() || !dirty()) return;
      clearTimeout(keyboardTimer);
      keyboardTimer = setTimeout(
        safe(() => finish()),
        180,
      );
    };
    input.oncancel = resumeNudge;
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return resumeNudge();
      if (!applies()) return;
      try {
        if (file.size > MAX_IMAGE_SIZE) throw new Error('Choose an image smaller than 20 MB.');
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (applies()) await finish(false, undefined, false, bytes);
      } catch (error) {
        if (applies()) showError(error);
      }
    };
    input.click();
  }
  async function finish(remove = false, style, preserveSelection = false, replacement) {
    heldArrows.clear();
    preserveSelection ||= preservingInputSelection;
    clearTimeout(keyboardTimer);
    gesture = null;
    if (!preserveSelection) {
      selectionGeneration++;
      choosing = null;
      selecting = null;
    }
    if (committing) return committing;
    if (!selected || (!remove && !style && !replacement && !dirty())) {
      draft = null;
      stopPreview();
      layout(true);
      onChange();
      return;
    }
    const entry = selected,
      transform = current(),
      priorFocus = document.activeElement;
    // Keep the final transform available to a preview that finishes during the commit.
    // Reload preserves that preview until the replacement page has been painted.
    keepCommitProperties = !remove;
    let focus, focusedLabel;
    settlingFocus = true;
    const focusSettled = new Promise((resolve) => {
      // Observe the destination after the native change/blur/focus event has
      // completed. The transaction itself starts immediately, keeping busy
      // state and action availability consistent from the initiating event.
      setTimeout(() => {
        focus = ownsFocus(document.activeElement);
        focusedLabel = focus ? document.activeElement.getAttribute('aria-label') : null;
        settlingFocus = false;
        setBusy(busy);
        resolve();
      }, 0);
    });
    committing = (async () => {
      try {
        await onCommit(entry, {
          transform,
          remove,
          style,
          ...(replacement ? { replacement } : {}),
        });
        await focusSettled;
        stopPreview();
        if (!remove) {
          selectOrdinal(entry.ordinal);
        }
      } catch (error) {
        await focusSettled;
        stopPreview();
        selectOrdinal(entry.ordinal);
        if (replacement && !same(transform, entry.transform)) setDraft(transform);
        showError(error);
        throw error;
      } finally {
        committing = null;
        keepCommitProperties = false;
        setBusy(busy);
        if (
          focus &&
          !remove &&
          (document.activeElement === document.body || ownsFocus(document.activeElement))
        ) {
          const input = [...properties.querySelectorAll('input, button')].find(
            (input) => input.getAttribute('aria-label') === focusedLabel,
          );
          (input || controls.querySelector('.image-move'))?.focus({ preventScroll: true });
        } else if (document.activeElement === document.body && priorFocus?.isConnected) {
          // A delayed keyboard commit can temporarily disable the toolbar control the
          // user moved to. Restore it only if focus has not moved somewhere else.
          priorFocus.focus({ preventScroll: true });
        }
        onChange();
      }
    })();
    setBusy(busy);
    return committing;
  }
  async function finishInputs(preserveSelection = false) {
    // Save, download, and page actions can run while a numeric edit still has
    // focus. Deliver its native change and await the resulting PDF transaction.
    const field = document.activeElement;
    const focusedInput = properties.contains(field) && field.matches('input');
    const label = focusedInput && field.getAttribute('aria-label');
    if (!committing)
      for (const input of pendingInputs())
        if (!input.reportValidity())
          throw new Error('Choose a valid object property before continuing.');
    if (focusedInput && !committing) {
      preservingInputSelection = preserveSelection;
      try {
        field.blur();
      } finally {
        preservingInputSelection = false;
      }
    }
    try {
      await finish(false, undefined, preserveSelection);
    } finally {
      if (label && document.activeElement === document.body)
        [...properties.querySelectorAll('input')]
          .find((input) => input.getAttribute('aria-label') === label)
          ?.focus({ preventScroll: true });
    }
  }
  const safe =
    (fn) =>
    (...args) =>
      Promise.resolve(fn(...args)).catch(() => {});
  function render(images, nextViewport, key, nextPageKey = key) {
    const restore = key === renderKey ? selected?.ordinal : null;
    const preserveControls = pageKey === nextPageKey;
    // Committing another draft may reload this page while selection is still pending.
    // A different page or viewport invalidates the stored pointer coordinates.
    const preserveSelection =
      choosing !== null &&
      pageKey === nextPageKey &&
      viewport &&
      same(viewport.transform, nextViewport.transform);
    renderKey = key;
    pageKey = nextPageKey;
    close(preserveSelection, { preserveControls });
    entries = images;
    viewport = nextViewport;
    targets.replaceChildren();
    for (const entry of entries) {
      if (!entry.editable) continue;
      const target = el('button', {
        type: 'button',
        class: kind(entry) === 'image' ? 'image-target' : 'path-target',
        'data-ordinal': entry.ordinal,
        'aria-label': `Select ${kind(entry)} ${(entry.labelIndex ?? entry.ordinal) + 1}`,
        'aria-pressed': false,
        ...(entry.invisible
          ? { title: 'Unpainted path. Select to restore its fill or stroke.' }
          : {}),
        onclick: (e) => {
          if (!e.detail && !busy && !committing) safe(choose)(entry, true);
        },
      });
      const corners = setPolygon(target, entry.transform);
      if (entry.svg) {
        target.style.pointerEvents = 'none';
        // The minimum stroke hit area extends past thin or rotated path bounds.
        // Only the SVG geometry takes pointer events, so its empty interior stays
        // available to objects underneath; the page layer still clips at page edges.
        target.style.clipPath = 'none';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        const xs = corners.map((p) => p[0]),
          ys = corners.map((p) => p[1]);
        svg.setAttribute(
          'viewBox',
          `${Math.min(...xs)} ${Math.min(...ys)} ${Math.max(...xs) - Math.min(...xs)} ${Math.max(...ys) - Math.min(...ys)}`,
        );
        svg.style.width = svg.style.height = '100%';
        svg.style.overflow = 'visible';
        // Inline SVG otherwise inherits a text line box, offsetting a hairline's
        // hit target from its visible stroke.
        svg.style.position = 'absolute';
        svg.style.inset = '0';
        const path = document.createElementNS(svg.namespaceURI, 'path');
        path.setAttribute('d', entry.svg);
        const m = matrix(viewport.transform, entry.ctm);
        path.setAttribute('transform', `matrix(${m.join(',')})`);
        path.setAttribute('fill', entry.filled ? 'transparent' : 'none');
        path.setAttribute('fill-rule', entry.fillRule);
        path.setAttribute('stroke', entry.stroked || entry.invisible ? 'transparent' : 'none');
        path.setAttribute('stroke-linecap', ['butt', 'round', 'square'][entry.state.cap]);
        path.setAttribute('stroke-linejoin', ['miter', 'round', 'bevel'][entry.state.join]);
        path.setAttribute('stroke-miterlimit', String(entry.state.miter));
        // A stretched or skewed stroke has different thicknesses by direction.
        // Keep its actual transformed outline, adding the minimum screen-space
        // target only where needed. Ordinary thin paths still use a single SVG path.
        const maxScale =
          (Math.hypot(m[0] + m[3], m[1] - m[2]) + Math.hypot(m[0] - m[3], m[1] + m[2])) / 2;
        const minScale = Math.abs(m[0] * m[3] - m[1] * m[2]) / maxScale;
        if (!entry.stroked || entry.state.width * maxScale <= 8) minimumPathTarget(path);
        else {
          path.setAttribute('stroke-width', String(entry.state.width));
          if (entry.state.width * minScale < 8) {
            const halo = path.cloneNode();
            halo.setAttribute('fill', 'none');
            halo.setAttribute('stroke-linecap', 'round');
            halo.setAttribute('stroke-linejoin', 'round');
            minimumPathTarget(halo);
            halo.style.pointerEvents = 'visiblePainted';
            svg.append(halo);
          }
        }
        path.style.pointerEvents = 'visiblePainted';
        svg.append(path);
        target.append(svg);
      }
      target.addEventListener('pointerdown', (e) => begin(e, entry));
      targets.append(target);
    }
    targets.hidden = !enabled;
    if (restore != null) selectOrdinal(restore);
    if (preserveSelection) controls.hidden = false;
    setBusy(busy);
  }
  function setPolygon(node, transform) {
    const corners = imageCorners(matrix(viewport.transform, transform));
    const xs = corners.map((p) => p[0]),
      ys = corners.map((p) => p[1]);
    const x = Math.min(...xs),
      y = Math.min(...ys),
      width = Math.max(...xs) - x,
      height = Math.max(...ys) - y;
    Object.assign(node.style, {
      left: `${x}px`,
      top: `${y}px`,
      width: `${width}px`,
      height: `${height}px`,
      clipPath: `polygon(${corners.map((p) => `${p[0] - x}px ${p[1] - y}px`).join(',')})`,
    });
    return corners;
  }
  function buildControls() {
    controls.replaceChildren();
    properties.replaceChildren();
    controls.hidden = !enabled || !selected;
    if (!selected) return;
    const move = el('button', {
      type: 'button',
      class: 'image-move',
      'aria-label': `Move selected ${kind()}`,
      title: 'Drag to move. Arrow keys move 1 pt; Shift moves 10 pt.',
    });
    move.addEventListener('pointerdown', (e) => begin(e, selected));
    controls.append(move);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('image-outline');
    svg.setAttribute('aria-hidden', 'true');
    const polygon = document.createElementNS(svg.namespaceURI, 'polygon');
    svg.append(polygon);
    controls.append(svg);
    for (let i = 0; i < 4; i++) {
      const handle = el('button', {
        type: 'button',
        // Saving blocks these handles without fading the selection's corners.
        class: 'image-resize busy-enabled',
        'data-corner': i,
        'aria-label': `Resize ${kind()}, corner ${i + 1}`,
        title: 'Drag to resize',
      });
      handle.addEventListener('pointerdown', (e) => begin(e, selected, i));
      controls.append(handle);
    }
    const width = el('input', {
      type: 'number',
      required: true,
      min: 1,
      max: 10000,
      step: 'any',
      'aria-label': `${title()} width in points`,
    });
    const height = el('input', {
      type: 'number',
      required: true,
      min: 1,
      max: 10000,
      step: 'any',
      'aria-label': `${title()} height in points`,
    });
    const resize = safe(async (input, axis) => {
      if (!input.reportValidity() || busy) return;
      const m = current(),
        old = Math.hypot(...m.slice(axis * 2, axis * 2 + 2)) * viewport.userUnit;
      const scale = Number(input.value) / old;
      const sx = keepRatio || axis === 0 ? scale : 1,
        sy = keepRatio || axis === 1 ? scale : 1;
      setDraft([
        m[0] * sx,
        m[1] * sx,
        m[2] * sy,
        m[3] * sy,
        m[4] + m[2] * (1 - sy),
        m[5] + m[3] * (1 - sy),
      ]);
      await finish();
    });
    width.onchange = () => resize(width, 0);
    height.onchange = () => resize(height, 1);
    const ratio = el('input', {
      type: 'checkbox',
      checked: keepRatio,
      'aria-label': `Keep ${kind()} proportions`,
      onchange: (e) => {
        keepRatio = e.target.checked;
      },
    });
    properties.append(
      el(
        'div',
        { class: 'image-edit-panel', role: 'group', 'aria-label': `Edit ${kind()}` },
        el('label', {}, 'W', width),
        el('label', {}, 'H', height),
        el('label', { class: 'image-ratio' }, ratio, 'Keep proportions'),
        kind() === 'image' && button('Replace image', 'Image', chooseReplacement, 'text-btn'),
        button(
          `Delete ${kind()}`,
          'Trash2',
          safe(() => finish(true)),
          'text-btn',
        ),
        iconButton(
          `Close ${kind()} editor`,
          'X',
          safe(async () => {
            const ordinal = selected.ordinal;
            await finish();
            close();
            if (document.activeElement === document.body)
              targets.querySelector(`[data-ordinal="${ordinal}"]`)?.focus({ preventScroll: true });
          }),
        ),
        el('p', { class: 'image-error', role: 'alert', hidden: true }),
      ),
    );
    if (selected.kind && selected.kind !== 'image') {
      const panel = properties.querySelector('.image-edit-panel'),
        styles = el('div', { class: 'path-style-controls' });
      for (const [key, painted] of [
        ['fill', selected.filled],
        ['stroke', selected.stroked],
      ]) {
        const toggle = el('input', {
          type: 'checkbox',
          checked: painted,
          'aria-label': `${title()} ${key} enabled`,
          onchange: safe((e) =>
            finish(false, { [key === 'fill' ? 'filled' : 'stroked']: e.target.checked }),
          ),
        });
        const row = el(
          'div',
          { class: 'path-paint-control' },
          el('label', {}, toggle, key === 'fill' ? 'Fill' : 'Stroke'),
        );
        if (painted) {
          const input = el('input', {
            type: 'color',
            value: pathColorHex(selected.state[key]),
            'aria-label': `${title()} ${key} color`,
          });
          input.onchange = safe(() => finish(false, { [key]: input.value }));
          const alpha = selected.state[key === 'fill' ? 'alpha' : 'strokeAlpha'];
          const opacity = el('input', {
            type: 'number',
            required: true,
            class: 'path-opacity',
            min: 0,
            max: 100,
            step: 'any',
            value: Number((alpha * 100).toFixed(6)),
            'aria-label': `${title()} ${key} opacity in percent`,
            title: `${key === 'fill' ? 'Fill' : 'Stroke'} opacity`,
          });
          opacity.onchange = safe(() =>
            opacity.value.trim() && opacity.reportValidity()
              ? finish(false, { [`${key}Opacity`]: Number(opacity.value) / 100 })
              : undefined,
          );
          row.append(input, el('label', {}, opacity, '%'));
        }
        styles.append(row);
      }
      if (selected.stroked) {
        const scale =
          Math.sqrt(
            Math.abs(selected.ctm[0] * selected.ctm[3] - selected.ctm[1] * selected.ctm[2]),
          ) * viewport.userUnit;
        const input = el('input', {
          type: 'number',
          min: 0,
          max: 10000,
          step: 'any',
          value: Number((selected.state.width * scale).toFixed(4)),
          required: true,
          'aria-label': `${title()} stroke width in points`,
          title:
            'Stroke width in points. Stretched paths retain their stroke proportions. Zero uses a hairline.',
        });
        input.onchange = safe(() =>
          input.reportValidity()
            ? finish(false, { width: Number(input.value) / scale })
            : undefined,
        );
        styles.append(el('label', {}, 'Stroke width', input));
      }
      panel.insertBefore(styles, panel.querySelector('button'));
    }
    const angle = el('input', {
      type: 'number',
      required: true,
      min: -360,
      max: 360,
      step: 'any',
      'aria-label': `${title()} rotation in degrees`,
      title: 'Clockwise angle on the page. Rotates around the object center.',
    });
    const rotate = safe(async (delta) => {
      if (busy || committing || Math.abs(delta % 360) < 1e-8) return;
      const v = viewport.transform;
      const direction = Math.sign(v[0] * v[3] - v[1] * v[2]);
      // Rotation must remain rigid. Interpolating toward a clipping boundary would
      // shrink or distort the object; let the PDF edit reject an out-of-frame turn.
      draft = rotateAroundCenter(current(), delta * direction);
      layout();
      onChange();
      await finish();
    });
    angle.onchange = () => {
      if (!angle.value.trim() || !angle.reportValidity()) return;
      const value = Number(angle.value),
        previous = rotation();
      if (value === Number(previous.toFixed(4)) % 360) return;
      return rotate(value - previous);
    };
    const rotations = el(
      'div',
      { class: 'object-rotation' },
      el('label', {}, 'Angle', angle, '°'),
      iconButton(`Rotate ${kind()} counterclockwise 90 degrees`, 'RotateCcw', () => rotate(-90)),
      iconButton(`Rotate ${kind()} clockwise 90 degrees`, 'RotateCw', () => rotate(90)),
    );
    const panel = properties.querySelector('.image-edit-panel');
    const styles = panel.querySelector('.path-style-controls');
    if (styles) styles.append(rotations);
    else panel.insertBefore(rotations, panel.querySelector('button'));
    onProperties(properties, title());
    layout();
    setBusy(busy);
  }
  function layout(syncInputs = false) {
    if (!selected || !viewport || !controls.querySelector('.image-move')) return;
    const m = current(),
      corners = setPolygon(controls.querySelector('.image-move'), m);
    const outline = controls.querySelector('svg');
    outline.setAttribute('viewBox', `0 0 ${viewport.width} ${viewport.height}`);
    outline
      .querySelector('polygon')
      .setAttribute('points', corners.map((p) => p.join(',')).join(' '));
    controls.querySelectorAll('.image-resize').forEach((handle, i) => {
      handle.style.left = `${corners[i][0]}px`;
      handle.style.top = `${corners[i][1]}px`;
      const opposite = corners[(i + 2) % 4];
      const angle = Math.atan2(corners[i][1] - opposite[1], corners[i][0] - opposite[0]);
      const direction = ((Math.round(angle / (Math.PI / 4)) % 4) + 4) % 4;
      handle.style.cursor = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][direction];
    });
    const panel = properties.querySelector('.image-edit-panel');
    for (const [i, label] of ['width', 'height'].entries()) {
      const input = panel.querySelector(`[aria-label="${title()} ${label} in points"]`);
      if (syncInputs || document.activeElement !== input)
        input.value = input.defaultValue = String(
          Number((Math.hypot(...m.slice(i * 2, i * 2 + 2)) * viewport.userUnit).toFixed(2)),
        );
    }
    const angle = panel.querySelector(`[aria-label="${title()} rotation in degrees"]`);
    if (angle && (syncInputs || document.activeElement !== angle))
      angle.value = angle.defaultValue = String(Number(rotation().toFixed(4)) % 360);
    preview.hidden = !dirty() || !bitmap;
    if (bitmap && background) {
      background.style.width = `${viewport.width}px`;
      background.style.height = `${viewport.height}px`;
      const css = matrix(matrix(viewport.transform, m), [
        1 / bitmap.width,
        0,
        0,
        -1 / bitmap.height,
        0,
        1,
      ]);
      bitmap.style.transform = `matrix(${css.join(',')})`;
      bitmap.style.opacity = selected.opacity;
      bitmap.style.mixBlendMode =
        { Multiply: 'multiply', Screen: 'screen', Darken: 'darken', Lighten: 'lighten' }[
          selected.blend
        ] || 'normal';
    }
  }
  async function begin(e, entry, corner = null) {
    if (!enabled || busy || committing || gesture || selecting || !e.isPrimary || e.button !== 0)
      return;
    e.preventDefault();
    e.stopPropagation();
    const focusFrom = document.activeElement;
    const request = {
      pointerId: e.pointerId,
      start: pointAt(e),
      event: e,
      startEvent: e,
      ended: false,
    };
    selecting = request;
    controls.hidden = false;
    controls.setPointerCapture(e.pointerId);
    try {
      const chosen = await choose(entry);
      if (!chosen || selecting !== request || !selected || !enabled || busy) {
        if (selecting === request) selecting = null;
        return;
      }
      selecting = null;
      gesture = {
        ...request,
        // Ignore layout shifts caused by opening the dock when deciding whether
        // a press became a drag. Retain the original grab point for actual motion.
        initial: pointAt(request.startEvent),
        original: selected.transform.slice(),
        corner,
      };
      if (canFocusSelection(focusFrom))
        controls.querySelector('.image-move')?.focus({ preventScroll: true });
      updateGesture(pointAt(request.event));
      // A quick drag can finish while the previous draft is being committed for selection.
      // Preserve its final position; an unmoved tap still creates no history.
      if (request.ended) await finish();
    } catch {
      if (selecting === request) selecting = null;
    }
  }
  /** A screen shift of the object limited so at least 16 px of it stays on the page. With
   * `stop`, a shift that would leave more of it off the page stops at the edge rather than
   * pulling an object that is already outside back in. */
  function visibleShift(m, dx, dy, stop = false) {
    const bounds = imageCorners(matrix(viewport.transform, m)),
      limit = (delta, values, size) => {
        const low = 16 - Math.max(...values),
          high = size - 16 - Math.min(...values);
        if (!stop) return Math.max(low, Math.min(high, delta));
        return delta < 0 ? Math.max(delta, Math.min(0, low)) : Math.min(delta, Math.max(0, high));
      };
    return {
      dx: limit(
        dx,
        bounds.map((p) => p[0]),
        viewport.width,
      ),
      dy: limit(
        dy,
        bounds.map((p) => p[1]),
        viewport.height,
      ),
    };
  }
  function updateGesture(position) {
    if (!gesture || !selected) return;
    const g = gesture,
      m = g.original;
    if (Math.hypot(position[0] - g.initial[0], position[1] - g.initial[1]) < 2 && !draft) return;
    if (g.corner == null) {
      const { dx, dy } = visibleShift(m, position[0] - g.start[0], position[1] - g.start[1]);
      const a = pdfPoint(g.start),
        b = pdfPoint([g.start[0] + dx, g.start[1] + dy]);
      setDraft([...m.slice(0, 4), m[4] + b[0] - a[0], m[5] + b[1] - a[1]]);
    } else {
      const local = [
          [0, 1],
          [1, 1],
          [1, 0],
          [0, 0],
        ],
        anchor = local[(g.corner + 2) % 4];
      const knob = local[g.corner];
      // Move the corner by the pointer's displacement, preserving where the handle
      // was grabbed. Using the absolute pointer position snaps the corner to the
      // pointer on the first sample, particularly with larger touch hit targets.
      const start = pdfPoint(g.start),
        current = pdfPoint(position),
        original = point(m, ...knob),
        p = original.map((value, i) => value + current[i] - start[i]);
      const [x, y] = point(inverse(m), ...p);
      let sx = (x - anchor[0]) / (knob[0] - anchor[0]),
        sy = (y - anchor[1]) / (knob[1] - anchor[1]);
      if (keepRatio) {
        const a = point(m, ...anchor),
          k = original;
        const dx = k[0] - a[0],
          dy = k[1] - a[1];
        sx = sy = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy);
      }
      const minX = 1 / (Math.hypot(m[0], m[1]) * viewport.userUnit),
        minY = 1 / (Math.hypot(m[2], m[3]) * viewport.userUnit);
      if (keepRatio) sx = sy = Math.max(minX, minY, Math.min(100, sx));
      else {
        sx = Math.max(minX, Math.min(100, sx));
        sy = Math.max(minY, Math.min(100, sy));
      }
      setDraft([
        m[0] * sx,
        m[1] * sx,
        m[2] * sy,
        m[3] * sy,
        m[4] + m[0] * anchor[0] * (1 - sx) + m[2] * anchor[1] * (1 - sy),
        m[5] + m[1] * anchor[0] * (1 - sx) + m[3] * anchor[1] * (1 - sy),
      ]);
    }
  }
  controls.addEventListener('pointermove', (e) => {
    if (selecting?.pointerId === e.pointerId) {
      selecting.event = e;
    }
    if (gesture?.pointerId === e.pointerId) {
      gesture.event = e;
      updateGesture(pointAt(e));
    }
  });
  controls.addEventListener(
    'pointerup',
    safe(async (e) => {
      if (selecting?.pointerId === e.pointerId) {
        selecting.event = e;
        selecting.ended = true;
        return;
      }
      if (gesture?.pointerId !== e.pointerId) return;
      updateGesture(pointAt(e));
      await finish();
    }),
  );
  controls.addEventListener('pointercancel', (e) => {
    if (gesture?.pointerId === e.pointerId || selecting?.pointerId === e.pointerId) cancel();
  });
  controls.addEventListener('lostpointercapture', (e) => {
    // Normal release can precede an asynchronous selection finishing. That request
    // already owns its final sample; only an interrupted gesture is rolled back.
    if (
      gesture?.pointerId === e.pointerId ||
      (selecting?.pointerId === e.pointerId && !selecting.ended)
    )
      cancel();
  });
  properties.addEventListener(
    'click',
    (e) => {
      // Safari leaves pointer-activated buttons and checkboxes unfocused. Establish the
      // return target before an action rebuilds these controls during its PDF commit.
      const control = e.target.closest('button, input[type="checkbox"]');
      if (control && !control.disabled) control.focus({ preventScroll: true });
    },
    true,
  );
  properties.addEventListener('input', (e) => {
    if (e.target.matches('input[type="number"]')) onChange();
  });
  const onKey = (e) => {
    if (!selected || busy || committing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (dirty() || pendingInputs().length || gesture) cancel();
      else {
        // Closing hides the controls that hold the focus; the object's own target takes it.
        const ordinal = selected.ordinal;
        close();
        targets.querySelector(`[data-ordinal="${ordinal}"]`)?.focus({ preventScroll: true });
      }
      return;
    }
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      safe(() => finish(true))();
      return;
    }
    const vector = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
      e.key
    ];
    if (!vector || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    // The pointer owns its preview until release or cancellation. A keyboard
    // nudge would shift that preview and its release timer would end the drag.
    if (gesture || selecting) return;
    const step = (e.shiftKey ? 10 : 1) * viewport.scale,
      m = current(),
      // Keyboard moves stop where a drag would, so a held arrow cannot push the object out
      // of sight off the page.
      { dx, dy } = visibleShift(m, vector[0] * step, vector[1] * step, true),
      a = pdfPoint([0, 0]),
      b = pdfPoint([dx, dy]);
    setDraft([...m.slice(0, 4), m[4] + b[0] - a[0], m[5] + b[1] - a[1]]);
    heldArrows.add(e.key);
    clearTimeout(keyboardTimer);
  };
  const endKeyboardMove = (e) => {
    if (!heldArrows.size) return;
    if (e.type === 'blur') heldArrows.clear();
    else if (!heldArrows.delete(e.key) || heldArrows.size) return;
    // A held key has a long pause before its first repeat. Debounce only after release,
    // so one continuous movement is one history action while quick nudges still group.
    clearTimeout(keyboardTimer);
    keyboardTimer = setTimeout(
      safe(() => finish()),
      180,
    );
  };
  // Release can arrive after focus leaves a handle; leaving the window ends the hold too.
  window.addEventListener('keyup', endKeyboardMove, true);
  window.addEventListener('blur', endKeyboardMove);
  controls.addEventListener('keydown', onKey);
  properties.addEventListener('keydown', onKey);
  return {
    targets,
    controls,
    preview,
    render,
    selectOrdinal,
    setBusy,
    finish: finishInputs,
    cancel,
    close,
    refresh() {
      if (gesture) updateGesture(pointAt(gesture.event));
    },
    get dirty() {
      return dirty() || pendingInputs().length > 0;
    },
    get active() {
      return !!(gesture || selecting);
    },
    get selected() {
      return !!selected;
    },
    setEnabled(value) {
      enabled = value;
      targets.hidden = !value;
      if (!value) close();
    },
    destroy() {
      window.removeEventListener('keyup', endKeyboardMove, true);
      window.removeEventListener('blur', endKeyboardMove);
      close();
    },
  };
}
