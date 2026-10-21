// Styles for the Image Editor, render window and viewport render status (injected once).
const css = /* css */ `
.rs-curve-presets { display: flex; gap: 2px; margin: 4px 0 2px; padding-left: 40%; }
.rs-curve-presets > .btn { flex: 1; min-width: 0; padding: 0; height: 20px; justify-content: center; }
.btn.out-swap, .btn.ca-eyedropper { width: 20px; height: 20px; padding: 0; margin-left: 2px; justify-content: center; flex: none; }
.sr-value.rs-checknum { display: flex; align-items: center; gap: 4px; }
.sr-value.rs-checknum > .checkbox { flex: none; }
.sr-value.rs-checknum > .num-field { flex: 1; min-width: 0; }
.ie-root { position: absolute; inset: 0; outline: none; overflow: hidden; background: #2d2e30; }
.ie-canvas { position: absolute; left: 0; top: 0; touch-action: none; }
.ie-ui { position: absolute; inset: 0; pointer-events: none; }
.ie-ui > .ie-sidebar { pointer-events: auto; top: 0; }
.ie-ui > .redo-panel { pointer-events: auto; bottom: 30px; }
.ie-ui > .ie-toolhdr { pointer-events: auto; position: absolute; top: 0; left: 0; right: 0; height: 28px; padding: 0 6px; gap: 6px; background: rgba(37, 38, 39, 0.92); border-bottom: 1px solid #1f2021; overflow: hidden; }
.ie-ui > .ie-toolbar { pointer-events: auto; top: 34px; }
.ie-ui > .ie-toolhdr ~ .ie-sidebar { top: 28px; }
.ie-header > .enum-menu.ie-mode { min-width: 80px; margin-left: 0; margin-right: 4px; }
.scope-box { display: flex; flex-direction: column; gap: 4px; }
.scope-svg { display: block; height: 110px; border-radius: 3px; }
.scope-img { display: block; width: 100%; image-rendering: auto; border-radius: 3px; background: #1a1b1c; }
.ie-samplehdr { gap: 8px; }
.ie-samplehdr .ie-tool-name { display: inline-flex; align-items: center; gap: 4px; color: #e6e7e8; flex: none; }
.ie-samplehdr .ie-tool-label { color: #bbbcbe; flex: none; }
.ie-samplehdr .num-field { width: 90px; flex: none; }
.ie-slot-empty { color: #87888a; font-size: 11px; }
.ie-slot-list { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2px; margin-bottom: 4px; }
.ie-slot { height: 20px; border-radius: 3px; background: #37383a; color: #dedfe1; font-size: 11px; }
.ie-slot.empty { color: #87888a; }
.ie-slot.on { background: var(--accent); color: #ffffff; }
.scope-round { width: 160px; margin: 0 auto; border-radius: 50%; }
.ie-meta { position: absolute; top: 0; left: 0; right: 0; padding: 3px 8px; background: rgba(20, 21, 23, 0.6); color: #e8e9ea; font-family: var(--font); font-size: 11px; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ie-sample { position: absolute; left: 0; right: 0; bottom: 0; display: flex; flex-wrap: wrap; gap: 4px 12px; padding: 3px 8px; background: rgba(20, 21, 23, 0.88); color: #e8e9ea; font-family: var(--mono); font-size: 11px; }
.ie-sample .ie-cm { color: #a4b8db; }
.ie-header { min-width: 0; flex: 1; }
.ie-browse { display: flex; align-items: center; gap: 2px; margin-left: 6px; flex: none; }
.ie-browse .text-field { width: 140px; flex: none; }
.ie-browse .btn { display: inline-flex; align-items: center; gap: 3px; padding: 0 8px; height: 20px; }
.ie-name { padding: 0 8px; color: #e8e9ea; white-space: nowrap; flex: none; }
.ie-header > .enum-menu { flex: none; width: auto; min-width: 96px; max-width: 160px; margin-left: 6px; }
.ie-header { overflow-x: auto; overflow-y: hidden; scrollbar-width: none; }
.ie-header::-webkit-scrollbar { display: none; }
.ie-header > * { flex: none; }
.ie-header > .hdr-spacer { flex: 1 1 0; min-width: 4px; }
.ie-value { color: #d0d1d3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
.ie-color { width: 100%; height: 20px; padding: 0; border: 1px solid #3a3b3d; border-radius: 4px; background: #1a1b1c; }
.ie-dialog .enum-row { flex-wrap: wrap; }
.ie-dialog-buttons { display: flex; justify-content: flex-end; margin-top: 6px; }
.ie-dialog-buttons .btn { padding: 0 14px; height: 22px; }
.rf-window { position: fixed; z-index: 60; display: flex; flex-direction: column; background: #2d2e30; border: 1px solid #0d0e10; border-radius: 6px; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6); resize: both; overflow: hidden; min-width: 560px; min-height: 240px; }
.rf-window.maximized { left: 0 !important; top: 0 !important; width: 100vw !important; height: 100vh !important; border-radius: 0; }
.rf-title { flex: none; height: 22px; line-height: 22px; text-align: center; background: #1f2021; color: #bbbcbe; cursor: move; user-select: none; font-size: 12px; }
.rf-body { position: relative; flex: 1; min-height: 0; }
.rf-viewport-info { position: absolute; color: #f0f1f2; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8); pointer-events: none; line-height: 1.6; white-space: nowrap; }
/* properties: render engine row (the menu takes the remaining width), metadata grid */
.prop-body > .split-row.rs-engine { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin: 6px 10px 8px; }
.split-row.rs-engine .sr-label { flex: 0 0 auto; padding-left: 2px; }
.split-row.rs-engine .sr-value { flex: 1 0 max-content; }
.split-row.rs-engine .enum-menu { min-width: max-content; }
.out-stamp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 8px; padding: 2px 0 4px 8%; }
.out-format-title { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
.out-format-title .out-presets { width: 22px; height: 20px; }
/* colour management curve */
.cm-curve { display: flex; flex-direction: column; gap: 4px; padding: 2px 4px; }
.cm-curve-svg { width: 100%; max-width: 220px; aspect-ratio: 1; align-self: center; touch-action: none; cursor: crosshair; }
.cm-curve-bg { fill: #1c1d1e; stroke: #37383a; }
.cm-curve-grid { stroke: #2c2d2f; stroke-width: 1; fill: none; }
.cm-curve-diag { stroke: #3a3b3d; stroke-width: 1; fill: none; stroke-dasharray: 3 3; }
.cm-curve-line { stroke: #e8e9ea; stroke-width: 1.5; fill: none; }
.cm-curve-pt { fill: #ffffff; stroke: #1f2021; stroke-width: 1; }
/* status bar: render job progress */
.sb-job { display: inline-flex; align-items: center; gap: 6px; margin-right: 12px; color: #dedfe1; }
.sb-job-bar { position: relative; width: 140px; height: 8px; border-radius: 4px; background: #1a1b1c; box-shadow: 0 0 0 1px #393a3c inset; overflow: hidden; }
.sb-job-fill { position: absolute; left: 0; top: 0; bottom: 0; background: var(--accent); border-radius: 4px; transition: width 0.2s linear; }
.sb-job-cancel { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; padding: 0; border-radius: 3px; background: transparent; color: #bbbcbe; }
.sb-job-cancel:hover { background: #48494a; color: #ffffff; }
/* Render ▸ Lock Interface: covers the editors while a render runs */
.render-lock { position: fixed; inset: 0 0 26px 0; z-index: 55; cursor: progress; background: transparent; }
/* animation player */
.rf-player-body { display: flex; align-items: center; justify-content: center; background: #1a1b1c; }
.rf-player-media { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
.rf-player-bar { flex: none; display: flex; align-items: center; gap: 6px; padding: 0 6px; height: 30px; }
.rf-player-scrub { flex: 1; min-width: 60px; accent-color: var(--accent); }
.rf-player-info { color: #cdced0; white-space: nowrap; font-variant-numeric: tabular-nums; }
.rf-player .hdr-toggle.on { background: var(--accent); color: #ffffff; }
`;

if (typeof document !== 'undefined' && !document.getElementById('render-final-style')) {
  const s = document.createElement('style');
  s.id = 'render-final-style';
  s.textContent = css;
  document.head.append(s);
}

export {};
