// Styles of the Bake panel (injected once).
const css = /* css */ `
.bake-btn-row { margin: 2px 0 6px; }
.bake-button { width: 100%; display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 26px; font-weight: 600; }
.bake-run { display: flex; gap: 4px; align-items: center; margin: 2px 0 6px; }
.bake-progress { position: relative; flex: 1; height: 24px; border-radius: 4px; background: var(--widget-bg, #2b2c2e); overflow: hidden; }
.bake-progress-fill { position: absolute; left: 0; top: 0; bottom: 0; background: var(--accent); opacity: 0.85; transition: width 0.2s linear; }
.bake-progress-label { position: relative; display: block; text-align: center; line-height: 24px; font-size: 11px; color: #f2f3f4; }
.bake-run .btn { display: inline-flex; align-items: center; gap: 3px; height: 24px; padding: 0 8px; }
.prop-note.warn { color: #e0b25c; }
.prop-note.bake-into { color: var(--t-99, #999a9b); }
.bake-swizzle { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; }
.bake-swizzle > .enum-menu { min-width: 0; }
`;

if (typeof document !== 'undefined') {
  const el = document.createElement('style');
  el.dataset.module = 'bake';
  el.textContent = css;
  document.head.append(el);
}

export {};
