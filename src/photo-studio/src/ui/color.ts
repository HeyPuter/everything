// HSV keeps the hue stable while selecting shades of the same foreground color.
export class ColorControls {
  private hue = 0;
  private saturation = 0;
  private value = 0;
  constructor(
    private root: HTMLElement,
    private change: (color: string) => void,
  ) {
    const plane = this.el('#color-plane');
    const pick = (event: PointerEvent) => {
      const bounds = plane.getBoundingClientRect();
      this.saturation = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
      this.value = 1 - Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
      this.commit();
    };
    plane.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      plane.setPointerCapture(event.pointerId);
      plane.focus();
      pick(event);
    });
    plane.addEventListener('pointermove', (event) => {
      if (plane.hasPointerCapture(event.pointerId)) pick(event);
    });
    plane.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 0.1 : 0.01;
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'ArrowLeft') this.saturation = Math.max(0, this.saturation - step);
      if (event.key === 'ArrowRight') this.saturation = Math.min(1, this.saturation + step);
      if (event.key === 'ArrowDown') this.value = Math.max(0, this.value - step);
      if (event.key === 'ArrowUp') this.value = Math.min(1, this.value + step);
      this.commit();
    });
    this.el<HTMLInputElement>('#color-hue').addEventListener('input', (event) => {
      this.hue = Number((event.target as HTMLInputElement).value);
      this.commit();
    });
    this.el<HTMLInputElement>('#color-value').addEventListener('change', (event) => {
      const input = event.target as HTMLInputElement;
      let value = input.value.trim();
      if (!value.startsWith('#')) value = '#' + value;
      if (/^#[0-9a-f]{3}$/i.test(value))
        value = '#' + [...value.slice(1)].map((c) => c + c).join('');
      if (/^#[0-9a-f]{6}$/i.test(value)) {
        this.sync(value.toLowerCase());
        this.change(value.toLowerCase());
      } else this.paint();
    });
    root.querySelectorAll<HTMLButtonElement>('[data-color]').forEach((button) =>
      button.addEventListener('click', () => {
        this.sync(button.dataset.color!);
        this.change(button.dataset.color!);
      }),
    );
  }
  private el<T extends HTMLElement = HTMLElement>(selector: string) {
    return this.root.querySelector<T>(selector)!;
  }
  sync(color: string) {
    // The color these controls just produced comes back through the editor:
    // keep the exact hue, saturation and brightness rather than re-deriving
    // them from 8-bit values (the hue drifts at low saturation and black
    // forgets the saturation).
    if (color.toLowerCase() === this.hex()) return this.paint();
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b),
      delta = max - min;
    if (delta)
      this.hue =
        ((max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) *
          60 +
          360) %
        360;
    this.saturation = max ? delta / max : 0;
    this.value = max;
    this.paint();
  }
  private hex() {
    const c = this.value * this.saturation,
      h = this.hue / 60;
    const x = c * (1 - Math.abs((h % 2) - 1)),
      m = this.value - c;
    const rgb =
      h < 1
        ? [c, x, 0]
        : h < 2
          ? [x, c, 0]
          : h < 3
            ? [0, c, x]
            : h < 4
              ? [0, x, c]
              : h < 5
                ? [x, 0, c]
                : [c, 0, x];
    return (
      '#' +
      rgb
        .map((v) =>
          Math.round((v + m) * 255)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')
    );
  }
  private commit() {
    this.paint();
    this.change(this.hex());
  }
  private paint() {
    const hex = this.hex();
    const plane = this.el('#color-plane');
    plane.style.setProperty('--hue', String(this.hue));
    plane.setAttribute('aria-valuenow', String(Math.round(this.saturation * 100)));
    plane.setAttribute(
      'aria-valuetext',
      `Saturation ${Math.round(this.saturation * 100)}%, brightness ${Math.round(this.value * 100)}%. Use left and right for saturation, up and down for brightness.`,
    );
    this.el('#color-marker').style.left = `${this.saturation * 100}%`;
    this.el('#color-marker').style.top = `${(1 - this.value) * 100}%`;
    this.el<HTMLInputElement>('#color-hue').value = String(Math.round(this.hue));
    this.el<HTMLInputElement>('#color-value').value = hex;
    const fg = document.querySelector<HTMLInputElement>('#foreground');
    if (fg) fg.value = hex;
    this.el('#color-preview').style.background = hex;
  }
}
