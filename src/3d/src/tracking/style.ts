// Styles for the Movie Clip Editor (injected once).
const css = /* css */ `
.clip-root { position: absolute; inset: 0; outline: none; overflow: hidden; background: #2d2e30; }
.clip-canvas { position: absolute; left: 0; top: 0; touch-action: none; }
.clip-ui { position: absolute; inset: 0; pointer-events: none; }
.clip-ui > * { pointer-events: auto; }
.clip-redo { position: absolute; bottom: 0; }
.clip-redo .redo-panel { left: 0; bottom: 8px; }
.clip-toolbar, .clip-sidebar { position: absolute; top: 0; bottom: 0; display: flex; background: rgba(45, 46, 48, 0.96); }
.clip-toolbar { left: 0; width: 230px; border-right: 1px solid #1f2021; }
.clip-sidebar { right: 0; width: 290px; border-left: 1px solid #1f2021; }
.clip-toolbar .sb-body, .clip-sidebar .sb-body { flex: 1; overflow-y: auto; padding: 4px 0; min-width: 0; }
.clip-toolbar .sb-tabs { order: -1; }
.clip-header { min-width: 0; flex: 1; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; }
.clip-header::-webkit-scrollbar { display: none; }
.clip-header > * { flex: none; }
.clip-header > .hdr-spacer { flex: 1 1 0; min-width: 4px; }
.clip-header > .enum-menu { width: auto; }
.clip-browse { display: flex; align-items: center; gap: 2px; margin: 0 6px; }
.clip-browse .text-field { width: 150px; flex: none; }
.clip-browse .btn { display: inline-flex; align-items: center; gap: 3px; padding: 0 8px; height: 20px; }
.clip-overlays { display: inline-flex; align-items: center; }
.clip-value { color: #d0d1d3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
.clip-info { color: #9a9b9c; font-size: 11px; padding: 2px 10px 4px; }
.clip-tool-row { display: flex; align-items: center; gap: 6px; padding: 2px 8px; }
.clip-tool-label { width: 52px; flex: none; color: #bbbcbe; text-align: right; }
.clip-tool-row .row-aligned { display: flex; flex: 1; }
.clip-tool-row .row-aligned > .btn { flex: 1; min-width: 0; justify-content: center; display: inline-flex; align-items: center; height: 22px; }
.clip-tool-row .btn-col { flex: 1; }
.clip-toolbar .btn-col, .clip-sidebar .btn-col, .clip-toolbar .btn-row, .clip-sidebar .btn-row { display: flex; gap: 2px; padding: 2px 8px; }
.clip-toolbar .btn-col, .clip-sidebar .btn-col { flex-direction: column; }
.clip-toolbar .btn-row > .btn, .clip-sidebar .btn-row > .btn { flex: 1; }
.clip-toolbar .btn, .clip-sidebar .btn { height: 22px; }
.clip-rgb { display: flex; }
.clip-rgb > .tbtn { flex: 1; min-width: 26px; }
.clip-name-row { display: flex; gap: 4px; padding: 2px 8px; align-items: center; }
.clip-name-row .text-field { flex: 1; }
.clip-preview-row { display: flex; gap: 6px; padding: 2px 8px; }
.clip-preview-row .clip-rgb { flex: 1; }
.clip-pattern-preview { display: block; width: calc(100% - 16px); margin: 4px 8px; aspect-ratio: 3 / 2; height: auto; background: #1a1b1c; border-radius: 3px; image-rendering: pixelated; }
.clip-color-row { display: flex; gap: 4px; align-items: center; }
.clip-color-row .color-swatch { flex: 1; }
.clip-list-wrap { display: flex; gap: 4px; padding: 2px 8px; }
.clip-list { flex: 1; min-height: 60px; max-height: 140px; overflow-y: auto; background: #252627; border: 1px solid #1a1b1c; border-radius: 3px; }
.clip-list-item { display: flex; align-items: center; gap: 4px; padding: 1px 6px; cursor: default; color: #dedfe1; }
.clip-list-item.on { background: #4b70b5; color: #ffffff; }
.clip-list-empty { color: #767778; padding: 4px 6px; }
.clip-list-btns { display: flex; flex-direction: column; gap: 2px; }
.clip-list-btns .btn { width: 24px; height: 22px; padding: 0; display: grid; place-items: center; }
.icon-btn { display: inline-grid; place-items: center; padding: 0 4px; }
.panel-check { display: inline-flex; margin-right: 4px; }
.clip-refine-col { display: flex; flex-direction: column; gap: 3px; padding: 2px 0; min-width: 0; }
.clip-refine-col .checkbox { white-space: nowrap; }
.clip-solve-status { color: #d6d7d9; font-size: 11px; padding: 3px 10px 4px; font-variant-numeric: tabular-nums; }
.clip-objects { min-height: 44px; }
.clip-obj-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.clip-obj-err { color: #9a9b9c; font-size: 10px; font-variant-numeric: tabular-nums; }
.clip-list-item.on .clip-obj-err { color: #e2e7f2; }
.clip-proxy-sizes { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 6px; }
.clip-header-error { color: #c8c9cb; font-size: 11px; margin: 0 8px; white-space: nowrap; font-variant-numeric: tabular-nums; }
`;

if (typeof document !== 'undefined' && !document.getElementById('tracking-style')) {
  const s = document.createElement('style');
  s.id = 'tracking-style';
  s.textContent = css;
  document.head.append(s);
}

export {};
