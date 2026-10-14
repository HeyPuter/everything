// Test setup shared by all suites: browser APIs jsdom lacks.
if (!globalThis.matchMedia) {
  globalThis.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
}
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!globalThis.requestAnimationFrame) {
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 16);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}
