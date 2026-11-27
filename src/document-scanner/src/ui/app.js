import { defaultQuad, outputSizeForQuad, warpPerspective } from '../engine/perspective.js';
import { applyFilter } from '../engine/filters.js';
import { buildPdfFromJpegs } from '../engine/pdf.js';
import { rgbaToJpeg } from '../engine/jpeg.js';
import { createSession, addPage, removePage } from '../engine/session.js';

export function mount(root) {
  const state = {
    session: createSession(),
    image: null, // { rgba, width, height, bitmapUrl }
    corners: null,
    filter: 'document',
    flash: null,
    dragCorner: -1,
  };

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  function flash(kind, text) {
    state.flash = { kind, text };
    renderChrome();
  }

  async function loadFile(file) {
    const bmp = await createImageBitmap(file);
    const w = bmp.width;
    const h = bmp.height;
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const octx = off.getContext('2d');
    octx.drawImage(bmp, 0, 0);
    const { data } = octx.getImageData(0, 0, w, h);
    state.image = { rgba: data, width: w, height: h };
    state.corners = defaultQuad(w, h);
    bmp.close?.();
    draw();
    flash('ok', `Loaded ${w}×${h} image`);
  }

  function draw() {
    if (!state.image) {
      canvas.width = 640;
      canvas.height = 400;
      ctx.fillStyle = '#0a0c10';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#9aa7b8';
      ctx.font = '16px sans-serif';
      ctx.fillText('Open an image or use the camera to begin.', 24, 48);
      return;
    }
    const { width, height, rgba } = state.image;
    canvas.width = width;
    canvas.height = height;
    const img = new ImageData(new Uint8ClampedArray(rgba), width, height);
    ctx.putImageData(img, 0, 0);
    // corners
    const c = state.corners;
    ctx.strokeStyle = '#6bc2ff';
    ctx.lineWidth = Math.max(2, Math.round(Math.min(width, height) / 400));
    ctx.beginPath();
    ctx.moveTo(c[0].x, c[0].y);
    for (let i = 1; i < 4; i += 1) ctx.lineTo(c[i].x, c[i].y);
    ctx.closePath();
    ctx.stroke();
    for (const p of c) {
      ctx.fillStyle = '#6bc2ff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#041018';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function hitCorner(x, y) {
    if (!state.corners) return -1;
    const r = Math.max(12, Math.min(state.image.width, state.image.height) / 40);
    return state.corners.findIndex((p) => Math.hypot(p.x - x, p.y - y) <= r);
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!state.image) return;
    const { x, y } = canvasPoint(e);
    state.dragCorner = hitCorner(x, y);
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (state.dragCorner < 0 || !state.corners) return;
    const { x, y } = canvasPoint(e);
    state.corners[state.dragCorner] = {
      x: clamp(x, 0, state.image.width - 1),
      y: clamp(y, 0, state.image.height - 1),
    };
    draw();
  });
  canvas.addEventListener('pointerup', () => {
    state.dragCorner = -1;
  });

  function canvasPoint(e) {
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  }

  async function capturePage() {
    if (!state.image || !state.corners) {
      flash('err', 'Load an image first');
      return;
    }
    const { width: ow, height: oh } = outputSizeForQuad(state.corners);
    const warped = warpPerspective(
      state.image.rgba,
      state.image.width,
      state.image.height,
      state.corners,
      ow,
      oh,
    );
    const filtered = applyFilter(warped.data, warped.width, warped.height, state.filter);
    addPage(state.session, {
      width: warped.width,
      height: warped.height,
      rgba: filtered,
      filter: state.filter,
    });
    flash('ok', `Added page ${state.session.pages.length}`);
    renderSidebar();
  }

  async function exportPdf() {
    if (!state.session.pages.length) {
      flash('err', 'Add at least one page');
      return;
    }
    const pages = [];
    for (const p of state.session.pages) {
      const jpeg = await rgbaToJpeg(p.rgba, p.width, p.height);
      pages.push({ jpeg, width: p.width, height: p.height });
    }
    const pdf = buildPdfFromJpegs(pages);
    const blob = new Blob([pdf], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.session.name || 'scan'}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
    flash('ok', `Exported ${pages.length} page PDF`);
  }

  let flashEl;
  let pagesEl;

  function renderChrome() {
    if (flashEl) {
      if (!state.flash) flashEl.hidden = true;
      else {
        flashEl.hidden = false;
        flashEl.className = `flash ${state.flash.kind}`;
        flashEl.textContent = state.flash.text;
      }
    }
  }

  function renderSidebar() {
    if (!pagesEl) return;
    pagesEl.innerHTML = '';
    if (!state.session.pages.length) {
      pagesEl.append(el('div', { class: 'muted' }, ['No pages yet. Adjust the corners and click Add page.']));
      return;
    }
    for (const page of state.session.pages) {
      const thumb = document.createElement('canvas');
      thumb.width = page.width;
      thumb.height = page.height;
      thumb.getContext('2d').putImageData(
        new ImageData(new Uint8ClampedArray(page.rgba), page.width, page.height),
        0,
        0,
      );
      const card = el('div', { class: 'page-card' }, [
        thumb,
        el('div', { class: 'row' }, [
          el('span', { class: 'muted' }, [`${page.width}×${page.height}`]),
          el('button', {
            class: 'danger',
            type: 'button',
            onclick: () => {
              removePage(state.session, page.id);
              renderSidebar();
            },
          }, ['Remove']),
        ]),
      ]);
      pagesEl.append(card);
    }
  }

  function build() {
    root.innerHTML = '';
    const top = el('header', { class: 'topbar' }, [
      el('div', { class: 'brand' }, ['Document ', el('span', {}, ['Scanner'])]),
      fileButton(),
      cameraButton(),
      el('label', { class: 'inline' }, [
        'Filter',
        (() => {
          const sel = el('select', {
            onchange: (e) => {
              state.filter = e.target.value;
            },
          });
          for (const [v, label] of [
            ['document', 'Document'],
            ['grayscale', 'Grayscale'],
            ['contrast', 'Contrast'],
            ['threshold', 'Threshold'],
            ['original', 'Original'],
          ]) {
            const opt = el('option', { value: v }, [label]);
            if (v === state.filter) opt.selected = true;
            sel.append(opt);
          }
          return sel;
        })(),
      ]),
      el('button', { class: 'primary', type: 'button', onclick: () => capturePage() }, ['Add page']),
      el('button', { class: 'primary', type: 'button', onclick: () => exportPdf() }, ['Export PDF']),
      el('div', { class: 'spacer' }),
    ]);
    flashEl = el('div', { class: 'flash', hidden: true });
    pagesEl = el('div', { class: 'pages' });
    const side = el('aside', { class: 'sidebar' }, [
      el('h2', {}, ['Pages']),
      pagesEl,
      el('p', { class: 'muted' }, [
        'Drag the blue corners to match the page edges, then add the page. Export builds a multi-page PDF.',
      ]),
    ]);
    const stage = el('div', { class: 'stage' }, [canvas]);
    root.append(top, flashEl, el('div', { class: 'workspace' }, [stage, side]));
    draw();
    renderSidebar();
    renderChrome();
  }

  function fileButton() {
    const input = el('input', { type: 'file', accept: 'image/*', hidden: true });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (file) await loadFile(file);
      input.value = '';
    });
    const btn = el('button', {
      type: 'button',
      onclick: () => input.click(),
    }, ['Open image']);
    const wrap = el('span', {}, [btn, input]);
    return wrap;
  }

  function cameraButton() {
    return el('button', {
      type: 'button',
      onclick: async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' },
            audio: false,
          });
          const video = document.createElement('video');
          video.srcObject = stream;
          await video.play();
          const w = video.videoWidth || 1280;
          const h = video.videoHeight || 720;
          const off = document.createElement('canvas');
          off.width = w;
          off.height = h;
          off.getContext('2d').drawImage(video, 0, 0);
          stream.getTracks().forEach((t) => t.stop());
          const blob = await new Promise((r) => off.toBlob(r, 'image/jpeg', 0.95));
          await loadFile(blob);
        } catch (err) {
          flash('err', err.message || 'Camera unavailable');
        }
      },
    }, ['Camera']);
  }

  build();
  return { state, loadFile, capturePage, exportPdf };
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2), v);
    } else if (k === 'class') node.className = v;
    else if (k === 'hidden') node.hidden = !!v;
    else if (v != null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
