// A split can retain only a portion of a fade. `length` is the visible
// portion; `duration` and `offset` retain progress along its original curve.

/** An explicitly edited fade starts at the clip's own edge again. */
export function restartFade(fade) {
  const { duration, offset, ...plain } = fade;
  return plain;
}

/** Keep a fade's exact curve over [start, end), measured from its edge. */
export function sliceFade(fade, start, end) {
  const length = Math.max(0, Math.min(end, fade.length) - start);
  if (!length) return start === 0 ? { ...restartFade(fade), length: 0 } : { length: 0, curve: fade.curve };
  const duration = fade.duration ?? fade.length;
  const offset = (fade.offset || 0) + start;
  const result = { ...restartFade(fade), length };
  if (offset || length !== duration) Object.assign(result, { duration, offset });
  return result;
}
