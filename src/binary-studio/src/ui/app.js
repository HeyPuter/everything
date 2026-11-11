import { analyzeBinary } from '../engine/analyze.js';
import { formatAddr } from '../engine/bytes.js';
import {
  deleteSession,
  listSessions,
  loadSession,
  saveSession,
  sha256Hex,
} from '../engine/session.js';

const BYTES_PER_ROW = 16;

/**
 * Mount the Binary Studio workspace into `root`.
 */
export function mountApp(root) {
  const state = {
    analysis: null,
    fileName: '',
    fileBytes: null,
    sha256: null,
    sessionId: null,
    selectedOffset: null,
    activeFunctionId: null,
    sideTab: 'info',
    stringFilter: '',
    error: null,
  };

  root.innerHTML = `
    <header class="app-header">
      <div class="brand">
        <img class="brand-mark" src="./favicon.svg" alt="" width="28" height="28" />
        <div>
          <h1>Binary Studio</h1>
          <p>Static PE / ELF analysis — never executes files</p>
        </div>
      </div>
      <div class="toolbar">
        <button type="button" class="primary" data-action="open">Open binary…</button>
        <button type="button" data-action="demo-pe" title="Load built-in tiny PE fixture">Demo PE</button>
        <button type="button" data-action="demo-elf" title="Load built-in tiny ELF fixture">Demo ELF</button>
        <button type="button" data-action="save" disabled>Save session</button>
        <button type="button" data-action="sessions">Sessions</button>
        <input type="file" accept=".exe,.dll,.sys,.efi,.so,.o,.elf,.bin,application/octet-stream" hidden data-file />
        <span class="status-pill" data-status>No file loaded</span>
      </div>
    </header>
    <div class="error-banner" data-error hidden></div>
    <main class="workspace" data-workspace hidden>
      <section class="panel panel-functions">
        <h2 class="panel-title">Functions</h2>
        <div class="panel-body" data-functions></div>
      </section>
      <section class="panel panel-disasm">
        <h2 class="panel-title">Disassembly</h2>
        <div class="panel-body" data-disasm></div>
      </section>
      <section class="panel panel-hex">
        <h2 class="panel-title">Hex</h2>
        <div class="panel-body" data-hex></div>
      </section>
      <section class="panel panel-side">
        <div class="tabs" role="tablist">
          <button type="button" data-tab="info" class="active">Info</button>
          <button type="button" data-tab="strings">Strings</button>
          <button type="button" data-tab="imports">Imports</button>
          <button type="button" data-tab="annotate">Annotate</button>
        </div>
        <div class="panel-body" data-side></div>
      </section>
    </main>
    <div class="welcome" data-welcome>
      <h2>Binary Studio</h2>
      <p>
        Open a PE or ELF image for client-side static analysis: sections, hex + ASCII,
        x86/x64 disassembly, heuristic functions, and strings. Uploaded binaries are
        never executed.
      </p>
      <ul>
        <li>PE and ELF loaders with safe reject of truncated / malformed input</li>
        <li>Focused x86 / x86-64 decoder (not full Capstone coverage)</li>
        <li>Session annotations stored in localStorage</li>
      </ul>
      <div class="drop-hint">
        Drop a binary here, or use <strong>Open binary…</strong> / the demo buttons.
      </div>
    </div>
  `;

  const els = {
    file: root.querySelector('[data-file]'),
    status: root.querySelector('[data-status]'),
    error: root.querySelector('[data-error]'),
    workspace: root.querySelector('[data-workspace]'),
    welcome: root.querySelector('[data-welcome]'),
    functions: root.querySelector('[data-functions]'),
    disasm: root.querySelector('[data-disasm]'),
    hex: root.querySelector('[data-hex]'),
    side: root.querySelector('[data-side]'),
    saveBtn: root.querySelector('[data-action="save"]'),
  };

  root.addEventListener('click', async (ev) => {
    const action = ev.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'open') els.file.click();
    if (action === 'demo-pe') {
      const { makeTinyPe } = await import('../../tests/fixtures.js');
      await loadBytes(makeTinyPe(), 'demo-tiny.exe');
    }
    if (action === 'demo-elf') {
      const { makeTinyElf } = await import('../../tests/fixtures.js');
      await loadBytes(makeTinyElf(), 'demo-tiny.elf');
    }
    if (action === 'save') persistSession();
    if (action === 'sessions') showSessions();
  });

  root.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.sideTab = btn.dataset.tab;
      root.querySelectorAll('[data-tab]').forEach((b) => {
        b.classList.toggle('active', b.dataset.tab === state.sideTab);
      });
      renderSide();
    });
  });

  els.file.addEventListener('change', async () => {
    const file = els.file.files?.[0];
    if (!file) return;
    const buf = new Uint8Array(await file.arrayBuffer());
    await loadBytes(buf, file.name);
    els.file.value = '';
  });

  ;['dragenter', 'dragover'].forEach((type) => {
    root.addEventListener(type, (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });
  });
  root.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    const file = ev.dataTransfer?.files?.[0];
    if (!file) return;
    const buf = new Uint8Array(await file.arrayBuffer());
    await loadBytes(buf, file.name);
  });

  els.disasm.addEventListener('click', (ev) => {
    const row = ev.target.closest('[data-offset]');
    if (!row) return;
    selectOffset(Number(row.dataset.offset));
  });
  els.hex.addEventListener('click', (ev) => {
    const row = ev.target.closest('[data-offset]');
    if (!row) return;
    selectOffset(Number(row.dataset.offset));
  });
  els.functions.addEventListener('click', (ev) => {
    const row = ev.target.closest('[data-fn]');
    if (!row || !state.analysis) return;
    const fn = state.analysis.functions.find((f) => f.id === row.dataset.fn);
    if (!fn) return;
    state.activeFunctionId = fn.id;
    selectOffset(fn.fileOffset);
    renderFunctions();
  });

  async function loadBytes(bytes, fileName) {
    state.error = null;
    try {
      const analysis = analyzeBinary(bytes);
      state.analysis = analysis;
      state.fileBytes = bytes;
      state.fileName = fileName;
      state.sha256 = await sha256Hex(bytes);
      state.sessionId = null;
      state.selectedOffset = analysis.entryPoint?.fileOffset ?? analysis.instructions[0]?.fileOffset ?? 0;
      state.activeFunctionId =
        analysis.functions.find((f) => f.fileOffset === state.selectedOffset)?.id ||
        analysis.functions[0]?.id ||
        null;
      els.welcome.hidden = true;
      els.workspace.hidden = false;
      els.saveBtn.disabled = false;
      els.status.textContent = `${fileName} · ${analysis.format} ${analysis.arch} · ${bytes.length} bytes`;
      renderAll();
    } catch (err) {
      state.analysis = null;
      state.fileBytes = null;
      els.saveBtn.disabled = true;
      showError(err?.message || String(err));
      els.status.textContent = 'Load failed';
    }
  }

  function showError(message) {
    state.error = message;
    els.error.hidden = !message;
    els.error.textContent = message || '';
  }

  function selectOffset(offset) {
    state.selectedOffset = offset;
    const fn = state.analysis?.functions.find(
      (f) =>
        offset >= f.fileOffset &&
        offset < f.fileOffset + Math.max(f.size, 1),
    );
    if (fn) state.activeFunctionId = fn.id;
    renderDisasm();
    renderHex();
    renderFunctions();
    if (state.sideTab === 'annotate') renderSide();
    const row = els.disasm.querySelector(`[data-offset="${offset}"]`) ||
      els.hex.querySelector(`[data-offset="${offset - (offset % BYTES_PER_ROW)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }

  function renderAll() {
    showError(null);
    renderFunctions();
    renderDisasm();
    renderHex();
    renderSide();
  }

  function renderFunctions() {
    const a = state.analysis;
    if (!a?.functions?.length) {
      els.functions.innerHTML = '<div class="empty">No functions discovered.</div>';
      return;
    }
    els.functions.innerHTML = a.functions
      .map((fn) => {
        const active = fn.id === state.activeFunctionId ? 'active' : '';
        return `<button type="button" class="list-item ${active}" data-fn="${fn.id}">
          <div>${escapeHtml(fn.name)}</div>
          <div class="meta">${formatAddr(fn.fileOffset)} · ${fn.confidence} · ${fn.instructionCount} insn · ${fn.blocks.length} bb</div>
        </button>`;
      })
      .join('');
  }

  function renderDisasm() {
    const a = state.analysis;
    if (!a?.instructions?.length) {
      els.disasm.innerHTML = '<div class="empty">No code regions found.</div>';
      return;
    }
    const comments = a.annotations?.comments || {};
    els.disasm.innerHTML = a.instructions
      .map((ins) => {
        const selected = ins.fileOffset === state.selectedOffset ? 'selected' : '';
        const note = comments[String(ins.fileOffset)];
        const noteHtml = note
          ? `<div class="meta">; ${escapeHtml(note)}</div>`
          : '';
        return `<div class="disasm-row ${selected}" data-offset="${ins.fileOffset}">
          <span class="addr">${escapeHtml(ins.addressLabel)}</span>
          <span class="bytes">${escapeHtml(ins.bytesHex)}</span>
          <span class="mnem">${escapeHtml(ins.text)}${noteHtml}</span>
        </div>`;
      })
      .join('');
  }

  function renderHex() {
    const bytes = state.fileBytes;
    if (!bytes) {
      els.hex.innerHTML = '';
      return;
    }
    const rows = [];
    const focus = state.selectedOffset ?? 0;
    const windowStart = Math.max(0, focus - 256);
    const windowEnd = Math.min(bytes.length, focus + 768);
    const start = windowStart - (windowStart % BYTES_PER_ROW);
    for (let off = start; off < windowEnd; off += BYTES_PER_ROW) {
      const slice = bytes.subarray(off, Math.min(bytes.length, off + BYTES_PER_ROW));
      const hex = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ');
      const ascii = [...slice]
        .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.'))
        .join('');
      const selected =
        state.selectedOffset != null &&
        state.selectedOffset >= off &&
        state.selectedOffset < off + BYTES_PER_ROW
          ? 'selected'
          : '';
      rows.push(`<div class="hex-row ${selected}" data-offset="${off}">
        <span class="addr">${formatAddr(off)}</span>
        <span class="bytes">${hex}</span>
        <span class="ascii">${escapeHtml(ascii)}</span>
      </div>`);
    }
    els.hex.innerHTML = rows.join('') || '<div class="empty">Empty file.</div>';
  }

  function renderSide() {
    const a = state.analysis;
    if (!a) {
      els.side.innerHTML = '';
      return;
    }
    if (state.sideTab === 'info') {
      els.side.innerHTML = `<div class="info-block">
        <dl>
          <dt>File</dt><dd>${escapeHtml(state.fileName)}</dd>
          <dt>Format</dt><dd>${escapeHtml(a.format)}</dd>
          <dt>Arch</dt><dd>${escapeHtml(a.arch)}</dd>
          <dt>Entry</dt><dd>${escapeHtml(a.entryPoint?.label || '—')}</dd>
          <dt>SHA-256</dt><dd>${escapeHtml(state.sha256 || '—')}</dd>
          <dt>Size</dt><dd>${a.bytes.length} bytes</dd>
          <dt>Functions</dt><dd>${a.functions.length}</dd>
          <dt>Instructions</dt><dd>${a.instructions.length}</dd>
          <dt>Strings</dt><dd>${a.strings.length}</dd>
        </dl>
        <h3 style="margin:0 0 0.4rem;font-size:0.85rem;">Sections / segments</h3>
        <div class="panel-body" style="max-height:12rem;border:1px solid var(--line);border-radius:6px;">
          ${renderSections(a)}
        </div>
      </div>`;
      return;
    }
    if (state.sideTab === 'strings') {
      const q = state.stringFilter.trim().toLowerCase();
      const list = a.strings.filter((s) => !q || s.value.toLowerCase().includes(q)).slice(0, 400);
      els.side.innerHTML = `
        <div class="search-row">
          <input type="search" placeholder="Filter strings…" value="${escapeAttr(state.stringFilter)}" data-string-filter />
        </div>
        ${
          list.length
            ? list
                .map(
                  (s) => `<button type="button" class="list-item" data-string-off="${s.offset}">
                    <div>${escapeHtml(s.value.slice(0, 80))}</div>
                    <div class="meta">${formatAddr(s.offset)} · ${s.encoding}</div>
                  </button>`,
                )
                .join('')
            : '<div class="empty">No matching strings.</div>'
        }`;
      els.side.querySelector('[data-string-filter]')?.addEventListener('input', (ev) => {
        state.stringFilter = ev.target.value;
        renderSide();
        els.side.querySelector('[data-string-filter]')?.focus();
      });
      els.side.querySelectorAll('[data-string-off]').forEach((btn) => {
        btn.addEventListener('click', () => selectOffset(Number(btn.dataset.stringOff)));
      });
      return;
    }
    if (state.sideTab === 'imports') {
      const imports = a.imports || [];
      if (a.format === 'PE') {
        els.side.innerHTML = imports.length
          ? imports
              .map(
                (imp) => `<div class="list-item"><div>${escapeHtml(imp.dll || '(unnamed)')}</div>
                <div class="meta">OFTs ${formatAddr(imp.originalFirstThunk)}</div></div>`,
              )
              .join('')
          : '<div class="empty">No import directory.</div>';
      } else {
        els.side.innerHTML = imports.length
          ? imports
              .slice(0, 300)
              .map(
                (sym) => `<div class="list-item"><div>${escapeHtml(sym.name || '?')}</div>
                <div class="meta">${escapeHtml(sym.bind)} · ${escapeHtml(sym.type)}</div></div>`,
              )
              .join('')
          : '<div class="empty">No undefined symbols.</div>';
      }
      const exportsList =
        a.format === 'PE'
          ? a.exports?.functions || []
          : (a.exports || []).slice(0, 200);
      if (exportsList.length) {
        els.side.innerHTML += `<div class="info-block"><strong>Exports</strong></div>` +
          exportsList
            .slice(0, 200)
            .map((ex) => {
              const name = ex.name || `ord_${ex.ordinal ?? '?'}`;
              return `<div class="list-item"><div>${escapeHtml(name)}</div>
                <div class="meta">${ex.rva != null ? 'RVA ' + formatAddr(ex.rva) : formatAddr(ex.value || 0)}</div></div>`;
            })
            .join('');
      }
      return;
    }
    if (state.sideTab === 'annotate') {
      const key = state.selectedOffset != null ? String(state.selectedOffset) : '';
      const existing = key ? a.annotations.comments[key] || '' : '';
      els.side.innerHTML = `<div class="info-block">
        <div>Selected offset: <code>${state.selectedOffset != null ? formatAddr(state.selectedOffset) : '—'}</code></div>
        <label>Comment
          <textarea class="comment-box" data-comment ${state.selectedOffset == null ? 'disabled' : ''}>${escapeHtml(existing)}</textarea>
        </label>
        <div style="margin-top:0.55rem;display:flex;gap:0.4rem;">
          <button type="button" class="primary" data-save-comment ${state.selectedOffset == null ? 'disabled' : ''}>Apply comment</button>
          <button type="button" data-bookmark ${state.selectedOffset == null ? 'disabled' : ''}>Bookmark</button>
        </div>
        <div style="margin-top:1rem;">
          <strong>Bookmarks</strong>
          ${(a.annotations.bookmarks || [])
            .map(
              (b) => `<button type="button" class="list-item" data-bm="${b.offset}">
                <div>${formatAddr(b.offset)}</div>
                <div class="meta">${escapeHtml(b.note || '')}</div>
              </button>`,
            )
            .join('') || '<div class="empty">None yet.</div>'}
        </div>
      </div>`;
      els.side.querySelector('[data-save-comment]')?.addEventListener('click', () => {
        const text = els.side.querySelector('[data-comment]')?.value || '';
        if (state.selectedOffset == null) return;
        if (text.trim()) a.annotations.comments[String(state.selectedOffset)] = text.trim();
        else delete a.annotations.comments[String(state.selectedOffset)];
        renderDisasm();
      });
      els.side.querySelector('[data-bookmark]')?.addEventListener('click', () => {
        if (state.selectedOffset == null) return;
        const note = els.side.querySelector('[data-comment]')?.value?.trim() || '';
        const existingBm = a.annotations.bookmarks.find((b) => b.offset === state.selectedOffset);
        if (existingBm) existingBm.note = note;
        else a.annotations.bookmarks.push({ offset: state.selectedOffset, note });
        renderSide();
      });
      els.side.querySelectorAll('[data-bm]').forEach((btn) => {
        btn.addEventListener('click', () => selectOffset(Number(btn.dataset.bm)));
      });
    }
  }

  function renderSections(a) {
    if (a.format === 'PE') {
      return (a.sections || [])
        .map(
          (s) => `<div class="list-item"><div>${escapeHtml(s.name || '(anon)')}</div>
            <div class="meta">VA ${formatAddr(s.virtualAddress)} · file ${formatAddr(s.pointerToRawData)} · ${s.sizeOfRawData} B</div></div>`,
        )
        .join('');
    }
    return (a.segments || [])
      .map(
        (s) => `<div class="list-item"><div>${s.load ? 'PT_LOAD' : `type ${s.type}`}</div>
          <div class="meta">vaddr ${formatAddr(s.vaddr)} · off ${formatAddr(s.offset)} · ${s.filesz} B · flags ${s.flags}</div></div>`,
      )
      .join('');
  }

  function persistSession() {
    if (!state.analysis) return;
    const entry = saveSession({
      id: state.sessionId || undefined,
      name: state.fileName || 'Untitled',
      format: state.analysis.format,
      arch: state.analysis.arch,
      fileName: state.fileName,
      fileSize: state.fileBytes?.length || 0,
      sha256: state.sha256,
      annotations: state.analysis.annotations,
    });
    state.sessionId = entry.id;
    els.status.textContent = `Session saved · ${entry.id}`;
  }

  function showSessions() {
    const sessions = listSessions();
    if (!sessions.length) {
      window.alert('No saved sessions yet.');
      return;
    }
    const lines = sessions
      .map(
        (s, i) =>
          `${i + 1}. ${s.name} (${s.format || '?'} ${s.arch || '?'}) — ${s.savedAt}`,
      )
      .join('\n');
    const pick = window.prompt(`Saved sessions:\n${lines}\n\nEnter number to load, or type delete N to remove:`, '1');
    if (!pick) return;
    const del = pick.trim().match(/^delete\s+(\d+)$/i);
    if (del) {
      const s = sessions[Number(del[1]) - 1];
      if (s) deleteSession(s.id);
      return;
    }
    const s = sessions[Number(pick) - 1];
    if (!s) return;
    const loaded = loadSession(s.id);
    if (!loaded || !state.analysis) {
      window.alert('Open the matching binary first, then load the session to restore annotations.');
      return;
    }
    if (loaded.sha256 && state.sha256 && loaded.sha256 !== state.sha256) {
      const ok = window.confirm('Session SHA-256 differs from the open file. Apply annotations anyway?');
      if (!ok) return;
    }
    state.analysis.annotations = loaded.annotations || { symbols: {}, bookmarks: [], comments: {} };
    state.sessionId = loaded.id;
    renderAll();
    els.status.textContent = `Session loaded · ${loaded.id}`;
  }

  return { loadBytes, getState: () => state };
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replaceAll("'", '&#39;');
}
