// Styles for the Video Sequencer editor (injected once).
const css = /* css */ `
.seq-sb-note { color: var(--text-dim, #999); font-size: 11px; padding: 2px 4px 4px; line-height: 1.35; }
.seq-ed { position: absolute; inset: 0; display: flex; flex-direction: column; background: #1c1c1c; }
.seq-body { flex: 1; display: flex; min-height: 0; }
.seq-left { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.seq-pvwrap { position: relative; min-height: 0; overflow: hidden; }
.seq-pvwrap[hidden], .seq-tlwrap[hidden], .seq-split-grip[hidden] { display: none; }
.seq-pv { position: absolute; inset: 0; background: #000; overflow: hidden; touch-action: none; }
.seq-pv-canvas { position: absolute; left: 0; top: 0; }
.seq-split-grip { height: 4px; flex: none; background: #161616; cursor: ns-resize; }
.seq-tlwrap { display: flex; min-height: 0; position: relative; }
.seq-toolbar { flex: none; width: 40px; display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 4px 0; background: #2b2b2b; border-right: 1px solid #161616; }
.seq-toolbar[hidden] { display: none; }
.seq-pv-toolbar { position: absolute; left: 6px; top: 6px; width: auto; padding: 3px; border-radius: 6px; border: none; background: rgba(40, 40, 40, 0.92); z-index: 2; }
.seq-toolbar .tb-tool { width: 32px; height: 32px; }
.seq-ch { position: relative; flex: none; background: #1c1c1c; border-right: 1px solid #161616; overflow: hidden; cursor: default; }
.seq-ch::after { content: ''; position: absolute; top: 0; bottom: 0; right: 0; width: 5px; cursor: ew-resize; }
.seq-ch-inner { position: absolute; inset: 0; }
.seq-ch-top { position: absolute; left: 0; right: 0; top: 0; background: #1c1c1c; z-index: 1; }
.seq-ch-row { position: absolute; left: 0; right: 0; display: flex; align-items: center; gap: 2px; padding: 0 6px 0 10px; color: #cfcfcf; white-space: nowrap; }
.seq-ch-row.alt { background: #171717; }
.seq-ch-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.seq-ch-tg { width: 18px; height: 18px; display: grid; place-items: center; color: #bdbdbd; border-radius: 3px; }
.seq-ch-tg:hover { background: rgba(255,255,255,0.08); }
.seq-ch-tg.off { color: #8a8a8a; }
.seq-ch-tg.on { color: #e8e8e8; }
.seq-ch-tg .ic svg { width: 14px; height: 14px; }
.seq-main { position: relative; flex: 1; min-width: 0; overflow: hidden; touch-action: none; }
.seq-main canvas { position: absolute; left: 0; top: 0; }
.seq-redo { position: absolute; left: 0; bottom: 0; z-index: 3; }
.seq-redo .redo-panel { bottom: 6px; }
.seq-sb { position: relative; flex: none; width: 300px; display: flex; background: #303030; border-left: 1px solid #161616; }
.seq-sb[hidden] { display: none; }
.seq-sb .sb-body { overflow-y: auto; }
.seq-footer[hidden] { display: none; }
.seq-hdr .seq-overlap { width: auto; min-width: 92px; flex: none; }
.seq-meta-crumb { display: inline-flex; align-items: center; gap: 4px; color: #b9e09a; }
.seq-sb-head { display: flex; align-items: center; gap: 4px; padding: 4px 8px 6px; }
.seq-sb-head .text-field { flex: 1; }
.seq-textarea { width: calc(100% - 16px); margin: 2px 8px 6px; min-height: 52px; resize: vertical; background: #1d1d1d; color: #e6e6e6; border: 1px solid #3d3d3d; border-radius: 4px; padding: 4px 6px; font: inherit; }
.seq-src { color: #bdbdbd; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
.seq-mod-add { padding: 4px 8px 8px; }
.seq-mod-add .seq-add-mod { width: 100%; display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 22px; }
.seq-mod-panel .ph-title { display: none; }
.seq-mod-panel.active { box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.35); }
.seq-mod-panel .panel-header { gap: 4px; }
.seq-mod-hd { display: inline-flex; align-items: center; gap: 3px; flex: 1; min-width: 0; }
.seq-mod-hd .text-field { flex: 1; min-width: 40px; }
.seq-mod-hd .btn { padding: 0 3px; height: 18px; }
.seq-cb { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; padding: 4px 8px; }
.seq-cb-col { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.seq-cb-title { text-align: center; color: #bdbdbd; }
.seq-cb-col .color-swatch { width: 100%; height: 22px; }
`;

let injected = false;
export function injectStyle() {
  if (injected) return;
  injected = true;
  const st = document.createElement('style');
  st.dataset.module = 'sequencer';
  st.textContent = css;
  document.head.append(st);
}
injectStyle();
