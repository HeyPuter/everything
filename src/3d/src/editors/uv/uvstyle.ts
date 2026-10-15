// Styles for the UV editor and operator dialogs (injected once).
const css = /* css */ `
.uv-header { min-width: 0; flex: 1; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; }
.uv-header::-webkit-scrollbar { display: none; }
.uv-header > * { flex: none; }
.uv-header > .hdr-spacer { flex: 1 1 0; min-width: 4px; }
.uv-header > .enum-menu { width: auto; }
.uv-tool-name { display: flex; align-items: center; gap: 6px; padding: 6px 8px; color: #e6e6e6; font-weight: 500; }
.uv-tool-name svg { width: 16px; height: 16px; }
.op-dialog .prop-line { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
.op-dialog .pl-label { flex: 0 0 34%; color: #bbb; text-align: right; }
.op-dialog .enum-row { flex: 1; flex-wrap: wrap; }
`;

if (typeof document !== 'undefined' && !document.getElementById('uv-editor-style')) {
  const s = document.createElement('style');
  s.id = 'uv-editor-style';
  s.textContent = css;
  document.head.append(s);
}

export {};
