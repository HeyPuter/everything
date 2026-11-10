/**
 * 2D canvas layer over the WebGL view for interaction feedback: cursor,
 * snap markers, tracking lines, selection windows, grips, the coordinate
 * system icon and dimension readouts. Redrawn only when the editor asks.
 */
export class Overlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.colors = {};
    this.readColors();
  }

  readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, f) => cs.getPropertyValue(n).trim() || f;
    // color-scheme follows the chosen theme; the media query only knows the system one.
    const scheme = cs.colorScheme;
    const dark = scheme ? scheme.includes('dark') : matchMedia('(prefers-color-scheme: dark)').matches;
    this.colors = {
      cursor: dark ? '#e8ecf2' : '#20262f',
      accent: v('--accent', '#4d8dff'),
      snap: dark ? '#4ade80' : '#0f8a3b',
      track: dark ? 'rgba(74, 222, 128, 0.8)' : 'rgba(15, 138, 59, 0.85)',
      grip: v('--accent', '#4d8dff'),
      gripHover: '#e05ad8',
      gripHot: '#ef4444',
      windowFill: dark ? 'rgba(77, 141, 255, 0.14)' : 'rgba(31, 111, 235, 0.10)',
      windowStroke: v('--accent', '#4d8dff'),
      crossFill: dark ? 'rgba(74, 222, 128, 0.12)' : 'rgba(15, 138, 59, 0.10)',
      crossStroke: dark ? '#4ade80' : '#0f8a3b',
      tipBg: dark ? 'rgba(39, 45, 55, 0.96)' : 'rgba(255, 255, 255, 0.97)',
      tipFg: dark ? '#e5e9ef' : '#1c222b',
      tipBorder: dark ? '#4a5462' : '#b8c0cb',
      axisX: dark ? '#f87171' : '#c93636',
      axisY: dark ? '#4ade80' : '#1e7f45',
      rubber: dark ? 'rgba(232, 236, 242, 0.55)' : 'rgba(32, 38, 47, 0.55)',
    };
  }

  resize(w, h, dpr) {
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.w = w;
    this.h = h;
  }

  /**
   * state = {
   *   cursor: {sx, sy} | null, cursorStyle: 'cross' | 'pick' | 'none', crossSize, pickbox,
   *   snap: {sx, sy, mode, label} | null,
   *   tracks: [{x1, y1, x2, y2}], trackPoints: [{sx, sy}],
   *   window: {x1, y1, x2, y2, crossing} | null,
   *   grips: [{sx, sy, state}], gripSize,
   *   rubber: [{x1, y1, x2, y2}],
   *   readouts: [{sx, sy, text}],
   *   ucs: {sx, sy, angle} | null,
   *   tooltip: { sx, sy, lines } | null
   * }
   */
  draw(s) {
    const c = this.ctx,
      d = this.dpr,
      col = this.colors;
    c.setTransform(d, 0, 0, d, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    c.lineCap = 'butt';
    c.lineJoin = 'miter';

    if (s.ucs) this._ucs(s.ucs);

    if (s.window) {
      const { x1, y1, x2, y2, crossing } = s.window;
      const x = Math.min(x1, x2),
        y = Math.min(y1, y2),
        w = Math.abs(x2 - x1),
        h = Math.abs(y2 - y1);
      c.fillStyle = crossing ? col.crossFill : col.windowFill;
      c.fillRect(x, y, w, h);
      c.strokeStyle = crossing ? col.crossStroke : col.windowStroke;
      c.lineWidth = 1;
      c.setLineDash(crossing ? [5, 4] : []);
      c.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
      c.setLineDash([]);
    }

    if (s.rubber && s.rubber.length) {
      c.strokeStyle = col.rubber;
      c.lineWidth = 1;
      c.setLineDash([6, 4]);
      c.beginPath();
      for (const r of s.rubber) {
        c.moveTo(r.x1, r.y1);
        c.lineTo(r.x2, r.y2);
      }
      c.stroke();
      c.setLineDash([]);
    }

    if (s.tracks && s.tracks.length) {
      c.strokeStyle = col.track;
      c.lineWidth = 1;
      c.setLineDash([2, 4]);
      c.beginPath();
      for (const t of s.tracks) {
        c.moveTo(t.x1, t.y1);
        c.lineTo(t.x2, t.y2);
      }
      c.stroke();
      c.setLineDash([]);
    }
    if (s.trackPoints) {
      c.strokeStyle = col.snap;
      c.lineWidth = 1.2;
      for (const p of s.trackPoints) {
        c.beginPath();
        c.moveTo(p.sx - 4, p.sy);
        c.lineTo(p.sx + 4, p.sy);
        c.moveTo(p.sx, p.sy - 4);
        c.lineTo(p.sx, p.sy + 4);
        c.stroke();
      }
    }

    if (s.grips && s.grips.length) {
      const g = s.gripSize || 5;
      for (const p of s.grips) {
        c.fillStyle = p.state === 'hot' ? col.gripHot : p.state === 'hover' ? col.gripHover : col.grip;
        const x = Math.round(p.sx - g) + 0.5,
          y = Math.round(p.sy - g) + 0.5;
        c.fillRect(x, y, g * 2, g * 2);
        c.strokeStyle = 'rgba(0,0,0,0.45)';
        c.lineWidth = 1;
        c.strokeRect(x, y, g * 2, g * 2);
      }
    }

    if (s.readouts) {
      c.font = '11px system-ui, sans-serif';
      c.textBaseline = 'middle';
      for (const r of s.readouts) this._label(r.sx, r.sy, r.text, r.align || 'center');
    }

    if (s.snap) this._snapMarker(s.snap);

    if (s.cursor && s.cursorStyle !== 'none') this._cursor(s);

    if (s.tooltip) this._tooltip(s.tooltip);
  }

  _cursor(s) {
    const c = this.ctx,
      col = this.colors;
    const x = Math.round(s.cursor.sx) + 0.5,
      y = Math.round(s.cursor.sy) + 0.5;
    c.strokeStyle = col.cursor;
    c.lineWidth = 1;
    const pb = s.pickbox ?? 4;
    if (s.cursorStyle === 'cross' || s.cursorStyle === 'both') {
      const size = s.crossSize ?? 40;
      c.beginPath();
      c.moveTo(x - size, y);
      c.lineTo(x - (s.cursorStyle === 'both' ? pb : 0), y);
      c.moveTo(x + (s.cursorStyle === 'both' ? pb : 0), y);
      c.lineTo(x + size, y);
      c.moveTo(x, y - size);
      c.lineTo(x, y - (s.cursorStyle === 'both' ? pb : 0));
      c.moveTo(x, y + (s.cursorStyle === 'both' ? pb : 0));
      c.lineTo(x, y + size);
      c.stroke();
    }
    if (s.cursorStyle === 'pick' || s.cursorStyle === 'both') c.strokeRect(x - pb, y - pb, pb * 2, pb * 2);
  }

  _snapMarker(sn) {
    const c = this.ctx,
      col = this.colors;
    const x = sn.sx,
      y = sn.sy,
      r = 6;
    c.strokeStyle = col.snap;
    c.lineWidth = 2;
    c.beginPath();
    switch (sn.mode) {
      case 'end':
        c.rect(x - r, y - r, r * 2, r * 2);
        break;
      case 'mid':
        c.moveTo(x, y - r - 1);
        c.lineTo(x + r + 1, y + r);
        c.lineTo(x - r - 1, y + r);
        c.closePath();
        break;
      case 'cen':
        c.arc(x, y, r, 0, Math.PI * 2);
        break;
      case 'gcen':
        c.arc(x, y, r, 0, Math.PI * 2);
        c.moveTo(x - r * 0.7, y - r * 0.7);
        c.lineTo(x + r * 0.7, y + r * 0.7);
        c.moveTo(x + r * 0.7, y - r * 0.7);
        c.lineTo(x - r * 0.7, y + r * 0.7);
        break;
      case 'node':
        c.arc(x, y, r, 0, Math.PI * 2);
        c.moveTo(x - r, y - r);
        c.lineTo(x + r, y + r);
        c.moveTo(x + r, y - r);
        c.lineTo(x - r, y + r);
        break;
      case 'quad':
        c.moveTo(x, y - r - 1);
        c.lineTo(x + r + 1, y);
        c.lineTo(x, y + r + 1);
        c.lineTo(x - r - 1, y);
        c.closePath();
        break;
      case 'int':
        c.moveTo(x - r, y - r);
        c.lineTo(x + r, y + r);
        c.moveTo(x + r, y - r);
        c.lineTo(x - r, y + r);
        break;
      case 'per':
        c.moveTo(x - r, y - r);
        c.lineTo(x - r, y + r);
        c.lineTo(x + r, y + r);
        c.moveTo(x - r, y);
        c.lineTo(x, y);
        c.lineTo(x, y + r);
        break;
      case 'tan':
        c.arc(x, y + 1, r - 1, 0, Math.PI * 2);
        c.moveTo(x - r - 1, y - r + 1);
        c.lineTo(x + r + 1, y - r + 1);
        break;
      case 'nea':
        c.moveTo(x - r, y - r);
        c.lineTo(x + r, y - r);
        c.lineTo(x - r, y + r);
        c.lineTo(x + r, y + r);
        c.closePath();
        break;
      case 'ins':
        c.rect(x - r, y - r, r, r);
        c.rect(x, y, r, r);
        break;
      case 'ext':
        c.moveTo(x - r, y);
        c.lineTo(x + r, y);
        c.moveTo(x - 2, y - 3);
        c.lineTo(x + 2, y - 3);
        break;
      case 'grid':
        c.moveTo(x - r, y);
        c.lineTo(x + r, y);
        c.moveTo(x, y - r);
        c.lineTo(x, y + r);
        break;
      default:
        c.rect(x - r, y - r, r * 2, r * 2);
    }
    c.stroke();
    if (sn.label) {
      c.font = '11px system-ui, sans-serif';
      c.textBaseline = 'middle';
      // Above and to the right, clear of the cursor tooltip below it.
      this._label(x + 14, y - 20, sn.label, 'left');
    }
  }

  _label(x, y, text, align) {
    const c = this.ctx,
      col = this.colors;
    const w = c.measureText(text).width + 10;
    const h = 18;
    let lx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    lx = Math.max(2, Math.min(this.w - w - 2, lx));
    const ly = Math.max(2, Math.min(this.h - h - 2, y - h / 2));
    c.fillStyle = col.tipBg;
    c.strokeStyle = col.tipBorder;
    c.lineWidth = 1;
    c.beginPath();
    c.roundRect ? c.roundRect(lx + 0.5, ly + 0.5, w, h, 3) : c.rect(lx + 0.5, ly + 0.5, w, h);
    c.fill();
    c.stroke();
    c.fillStyle = col.tipFg;
    c.textAlign = 'left';
    c.fillText(text, lx + 5.5, ly + h / 2 + 1);
  }

  _tooltip(t) {
    const c = this.ctx;
    c.font = '12px system-ui, sans-serif';
    c.textBaseline = 'middle';
    let y = t.sy;
    for (const line of t.lines) {
      this._label(t.sx, y, line, 'left');
      y += 22;
    }
  }

  _ucs({ sx, sy }) {
    const c = this.ctx,
      col = this.colors;
    const L = 34;
    c.lineWidth = 1.5;
    c.lineCap = 'round';
    c.strokeStyle = col.axisX;
    c.beginPath();
    c.moveTo(sx, sy);
    c.lineTo(sx + L, sy);
    c.moveTo(sx + L - 6, sy - 4);
    c.lineTo(sx + L, sy);
    c.lineTo(sx + L - 6, sy + 4);
    c.stroke();
    c.strokeStyle = col.axisY;
    c.beginPath();
    c.moveTo(sx, sy);
    c.lineTo(sx, sy - L);
    c.moveTo(sx - 4, sy - L + 6);
    c.lineTo(sx, sy - L);
    c.lineTo(sx + 4, sy - L + 6);
    c.stroke();
    c.font = '600 10px system-ui, sans-serif';
    c.textBaseline = 'middle';
    c.textAlign = 'left';
    c.fillStyle = col.axisX;
    c.fillText('X', sx + L + 4, sy);
    c.fillStyle = col.axisY;
    c.fillText('Y', sx - 3, sy - L - 8);
    c.lineCap = 'butt';
  }
}
