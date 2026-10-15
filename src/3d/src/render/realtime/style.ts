// Styles of the realtime engine's properties (injected once).
const css = /* css */ `
.panel.rt-off > .panel-body { opacity: 0.5; }
.rt-probe-bake { display: flex; gap: 4px; }
.rt-probe-bake > .btn { flex: 1; }
`;

if (typeof document !== 'undefined' && !document.getElementById('rt-style')) {
  const el = document.createElement('style');
  el.id = 'rt-style';
  el.textContent = css;
  document.head.append(el);
}
