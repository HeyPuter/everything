// Styles for the Image Editor, render window and viewport render status (injected once).
const css = /* css */ `
.ie-root { position: absolute; inset: 0; outline: none; overflow: hidden; background: #303030; }
.ie-canvas { position: absolute; left: 0; top: 0; touch-action: none; }
.ie-ui { position: absolute; inset: 0; pointer-events: none; }
.ie-ui > .ie-sidebar { pointer-events: auto; top: 0; }
.ie-ui > .redo-panel { pointer-events: auto; bottom: 30px; }
.ie-ui > .ie-toolhdr { pointer-events: auto; position: absolute; top: 0; left: 0; right: 0; height: 28px; padding: 0 6px; gap: 6px; background: rgba(40, 40, 40, 0.92); border-bottom: 1px solid #222; overflow: hidden; }
.ie-ui > .ie-toolbar { pointer-events: auto; top: 34px; }
.ie-ui > .ie-toolhdr ~ .ie-sidebar { top: 28px; }
.ie-header > .enum-menu.ie-mode { min-width: 80px; margin-left: 0; margin-right: 4px; }
.scope-box { display: flex; flex-direction: column; gap: 4px; }
.scope-svg { display: block; height: 110px; border-radius: 3px; }
.scope-img { display: block; width: 100%; image-rendering: auto; border-radius: 3px; background: #1d1d1d; }
.ie-slot-list { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2px; margin-bottom: 4px; }
.ie-slot { height: 20px; border-radius: 3px; background: #3a3a3a; color: #ddd; font-size: 11px; }
.ie-slot.empty { color: #888; }
.ie-slot.on { background: var(--accent); color: #fff; }
.scope-round { width: 160px; margin: 0 auto; border-radius: 50%; }
.ie-meta { position: absolute; top: 0; left: 0; right: 0; padding: 3px 8px; background: rgba(24, 24, 24, 0.6); color: #e6e6e6; font-family: var(--font); font-size: 11px; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ie-sample { position: absolute; left: 0; right: 0; bottom: 0; display: flex; flex-wrap: wrap; gap: 4px 12px; padding: 3px 8px; background: rgba(24, 24, 24, 0.88); color: #e6e6e6; font-family: var(--mono); font-size: 11px; }
.ie-sample .ie-cm { color: #9fb7da; }
.ie-header { min-width: 0; flex: 1; }
.ie-browse { display: flex; align-items: center; gap: 2px; margin-left: 6px; flex: none; }
.ie-browse .text-field { width: 140px; flex: none; }
.ie-browse .btn { display: inline-flex; align-items: center; gap: 3px; padding: 0 8px; height: 20px; }
.ie-name { padding: 0 8px; color: #e6e6e6; white-space: nowrap; flex: none; }
.ie-header > .enum-menu { flex: none; width: auto; min-width: 96px; max-width: 160px; margin-left: 6px; }
.ie-header { overflow-x: auto; overflow-y: hidden; scrollbar-width: none; }
.ie-header::-webkit-scrollbar { display: none; }
.ie-header > * { flex: none; }
.ie-header > .hdr-spacer { flex: 1 1 0; min-width: 4px; }
.ie-value { color: #cfcfcf; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
.ie-color { width: 100%; height: 20px; padding: 0; border: 1px solid #3d3d3d; border-radius: 4px; background: #1d1d1d; }
.ie-dialog .enum-row { flex-wrap: wrap; }
.ie-dialog-buttons { display: flex; justify-content: flex-end; margin-top: 6px; }
.ie-dialog-buttons .btn { padding: 0 14px; height: 22px; }
.rf-window { position: fixed; z-index: 60; display: flex; flex-direction: column; background: #303030; border: 1px solid #111; border-radius: 6px; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6); resize: both; overflow: hidden; min-width: 560px; min-height: 240px; }
.rf-window.maximized { left: 0 !important; top: 0 !important; width: 100vw !important; height: 100vh !important; border-radius: 0; }
.rf-title { flex: none; height: 22px; line-height: 22px; text-align: center; background: #222; color: #bbb; cursor: move; user-select: none; font-size: 12px; }
.rf-body { position: relative; flex: 1; min-height: 0; }
.rf-viewport-info { position: absolute; color: #eee; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8); pointer-events: none; line-height: 1.6; white-space: nowrap; }
/* properties: render engine row (the menu takes the remaining width), metadata grid */
.prop-body > .split-row.rs-engine { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin: 6px 10px 8px; }
.split-row.rs-engine .sr-label { flex: 0 0 auto; padding-left: 2px; }
.split-row.rs-engine .sr-value { flex: 1 0 max-content; }
.split-row.rs-engine .enum-menu { min-width: max-content; }
.out-stamp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 8px; padding: 2px 0 4px 8%; }
/* status bar: render job progress */
.sb-job { display: inline-flex; align-items: center; gap: 6px; margin-right: 12px; color: #ddd; }
.sb-job-bar { position: relative; width: 140px; height: 8px; border-radius: 4px; background: #1d1d1d; box-shadow: 0 0 0 1px #3c3c3c inset; overflow: hidden; }
.sb-job-fill { position: absolute; left: 0; top: 0; bottom: 0; background: var(--accent); border-radius: 4px; transition: width 0.2s linear; }
.sb-job-cancel { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; padding: 0; border-radius: 3px; background: transparent; color: #bbb; }
.sb-job-cancel:hover { background: #4a4a4a; color: #fff; }
/* Render ▸ Lock Interface: covers the editors while a render runs */
.render-lock { position: fixed; inset: 0 0 26px 0; z-index: 55; cursor: progress; background: transparent; }
/* animation player */
.rf-player-body { display: flex; align-items: center; justify-content: center; background: #1d1d1d; }
.rf-player-media { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
.rf-player-bar { flex: none; display: flex; align-items: center; gap: 6px; padding: 0 6px; height: 30px; }
.rf-player-scrub { flex: 1; min-width: 60px; accent-color: var(--accent); }
.rf-player-info { color: #ccc; white-space: nowrap; font-variant-numeric: tabular-nums; }
.rf-player .hdr-toggle.on { background: var(--accent); color: #fff; }
`;

if (typeof document !== 'undefined' && !document.getElementById('render-final-style')) {
  const s = document.createElement('style');
  s.id = 'render-final-style';
  s.textContent = css;
  document.head.append(s);
}

export {};
