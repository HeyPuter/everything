// Options-bar number fields of the painting, retouching and selection tools.

/** Bind a number field: out-of-range entries clamp (in `set`), a blank or
 * invalid entry keeps the current value, and the field shows what applies. */
export function bindNumberField(el: HTMLElement, selector: string, get: () => number, set: (v: number) => void, after?: () => void) {
  el.querySelector<HTMLInputElement>(selector)?.addEventListener('change', (ev) => {
    const input = ev.target as HTMLInputElement;
    const v = Number(input.value);
    if (input.value.trim() !== '' && Number.isFinite(v)) set(v);
    input.value = String(Math.round(get()));
    after?.();
  });
}
