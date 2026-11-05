import { describe, expect, it, vi } from 'vitest';
import { Camera, VIEWS } from '../src/render/camera';
import { qRotate } from '../src/math/vec';
import { CommandRegistry, eventShortcut } from '../src/app/commands';
import { registerCommands } from '../src/app/actions';
import { isMac } from '../src/ui/dom';

const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9));

describe('camera', () => {
  it('has standard views looking along the expected axes', () => {
    close(qRotate(VIEWS.front, [0, 0, 1]), [0, 0, 1]);
    close(qRotate(VIEWS.front, [1, 0, 0]), [1, 0, 0]);
    close(qRotate(VIEWS.top, [0, 0, 1]), [0, 1, 0]);
    close(qRotate(VIEWS.top, [1, 0, 0]), [1, 0, 0]);
    close(qRotate(VIEWS.right, [0, 0, 1]), [1, 0, 0]);
    close(qRotate(VIEWS.right, [0, 1, 0]), [0, 1, 0]);
  });

  it('projects points and casts rays consistently', () => {
    const c = new Camera();
    c.width = 800; c.height = 600;
    for (const ortho of [true, false]) {
      c.ortho = ortho;
      c.setState({ target: [5, 2, -1], distance: 120, rot: VIEWS.isometric, ortho });
      const p: [number, number, number] = [10, -4, 7];
      const [x, y] = c.project(p);
      const r = c.ray(x, y);
      // The point lies on the ray through its own projection.
      const v = [p[0] - r.o[0], p[1] - r.o[1], p[2] - r.o[2]];
      const t = v[0] * r.d[0] + v[1] * r.d[1] + v[2] * r.d[2];
      close([r.o[0] + r.d[0] * t, r.o[1] + r.d[1] * t, r.o[2] + r.d[2] * t], p);
    }
  });

  it('zooms toward the cursor', () => {
    const c = new Camera();
    c.width = 800; c.height = 600;
    c.setState({ target: [0, 0, 0], distance: 100, rot: VIEWS.front, ortho: true });
    const before = c.ray(600, 150);
    c.zoomAt(0.5, 600, 150);
    const after = c.ray(600, 150);
    close([before.o[0], before.o[1]], [after.o[0], after.o[1]]);
    expect(c.distance).toBeCloseTo(50, 9);
  });

  it('reports the end of a running animation as its goal', () => {
    const c = new Camera();
    c.width = 800; c.height = 600;
    c.setState({ target: [0, 0, 0], distance: 100, rot: VIEWS.front, ortho: true });
    expect(c.goal().rot).toEqual(VIEWS.front);
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    c.animateTo({ target: [1, 2, 3], distance: 50, rot: VIEWS.top, ortho: true });
    vi.unstubAllGlobals();
    expect(c.animating).toBe(true);
    expect(c.goal()).toEqual({ target: [1, 2, 3], distance: 50, rot: VIEWS.top, ortho: true });
    expect(c.rot).toEqual(VIEWS.front);
  });

  it('keeps a view animation running through a zoom or pan', () => {
    const c = new Camera();
    c.width = 800; c.height = 600;
    c.setState({ target: [0, 0, 0], distance: 100, rot: VIEWS.isometric, ortho: true });
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    c.animateTo({ target: [0, 0, 0], distance: 80, rot: VIEWS.front, ortho: true }, 200);
    vi.unstubAllGlobals();
    const t0 = performance.now();
    c.tick(t0 + 60);
    const mid = c.state();
    c.zoomAt(0.5, 400, 300);
    // The zoom shows at once...
    expect(c.distance).toBeCloseTo(mid.distance * 0.5, 9);
    expect(c.animating).toBe(true);
    c.pan(10, 0);
    expect(c.animating).toBe(true);
    // ...and the turn still lands on the standard view, zoomed.
    expect(c.tick(t0 + 1000)).toBe(false);
    expect(c.viewName()).toBe('front');
    expect(c.distance).toBeCloseTo(40, 9);
    // A two-finger roll takes the orientation over, as orbiting does.
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    c.animateTo({ target: [0, 0, 0], distance: 80, rot: VIEWS.top, ortho: true }, 200);
    vi.unstubAllGlobals();
    c.roll(0.1);
    expect(c.animating).toBe(false);
  });

  it('recognises the current standard view', () => {
    const c = new Camera();
    c.rot = VIEWS.right;
    expect(c.viewName()).toBe('right');
    c.orbit(10, 0);
    expect(c.viewName()).toBeNull();
  });

  it('keeps a projection switched during a view animation', () => {
    const c = new Camera();
    c.width = 800; c.height = 600;
    c.setState({ target: [0, 0, 0], distance: 100, rot: VIEWS.isometric, ortho: true });
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    c.animateTo({ target: [0, 0, 0], distance: 80, rot: VIEWS.front, ortho: true }, 200);
    vi.unstubAllGlobals();
    const t0 = performance.now();
    c.tick(t0 + 60);
    c.ortho = false;
    c.tick(t0 + 120);
    expect(c.ortho).toBe(false);
    expect(c.tick(t0 + 1000)).toBe(false);
    expect(c.ortho).toBe(false);
    expect(c.viewName()).toBe('front');
  });

  it('keeps everything drawn inside the clip range, not just the model', () => {
    // A 2 m sketch on the Top Plane with no body yet: the model radius is the default.
    const corners: [number, number, number][] = [[0, 0, 0], [2000, 0, 0], [2000, 0, -1500], [0, 0, -1500]];
    const c = new Camera();
    c.width = 800; c.height = 600;
    c.sceneBounds = { center: [1000, 0, -750], radius: 1250 };
    for (const ortho of [true, false]) {
      c.setState({ ...c.fitState([1000, 0, -750], 1250, VIEWS.isometric), ortho });
      for (const p of corners) {
        const z = c.project(p)[2];
        expect(z).toBeGreaterThan(-1);
        expect(z).toBeLessThan(1);
      }
    }
  });
});

describe('camera zoom limits', () => {
  it('zooms a part framed beyond the zoom-out limit smoothly instead of jumping', () => {
    const c = new Camera();
    c.width = 800; c.height = 600;
    // A 10 km part frames at a distance past the 1e7 wheel limit.
    c.setState(c.fitState([0, 0, 0], 5e6, VIEWS.isometric));
    const d0 = c.distance;
    expect(d0).toBeGreaterThan(1e7);
    c.zoomAt(0.9, 400, 300);
    expect(c.distance).toBeCloseTo(d0 * 0.9, 0);
    // Zooming out stops where it is rather than snapping back to the limit.
    const d1 = c.distance;
    c.zoomAt(1.2, 400, 300);
    expect(c.distance).toBe(d1);
    // Ordinary limits are unchanged.
    c.setState({ ...c.state(), distance: 9e6 });
    c.zoomAt(2, 400, 300);
    expect(c.distance).toBe(1e7);
  });
});

describe('command registry', () => {
  it('matches shortcuts and searches labels', () => {
    const reg = new CommandRegistry();
    let ran = '';
    reg.register(
      { id: 'save', label: 'Save', shortcut: 'Ctrl+S', run: () => { ran = 'save'; } },
      { id: 'zoomIn', label: 'Zoom In', shortcut: 'Shift+Z', run: () => { ran = 'zin'; } },
      { id: 'view1', label: 'Front', shortcut: 'Ctrl+1', keywords: 'view', run: () => { ran = 'front'; } },
      { id: 'off', label: 'Disabled', enabled: () => false, run: () => { ran = 'off'; } },
    );
    const ev = (init: KeyboardEventInit & { code?: string }) => ({ key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init }) as KeyboardEvent;
    // "Ctrl" in a shortcut means Cmd on macOS (Node reports navigator.platform there too).
    const primary = isMac ? { metaKey: true } : { ctrlKey: true };
    expect(reg.match(ev({ key: 's', ...primary }))?.id).toBe('save');
    expect(reg.match(ev({ key: 'Z', shiftKey: true }))?.id).toBe('zoomIn');
    expect(reg.match(ev({ key: '!', code: 'Digit1', ...primary }))?.id).toBe('view1');
    expect(eventShortcut(ev({ key: 'Shift' }))).toBeNull();
    expect(reg.run('off')).toBe(false);
    reg.run('save');
    expect(ran).toBe('save');
    expect(reg.search('zoom').map((c) => c.id)).toEqual(['zoomIn']);
    expect(reg.search('view').map((c) => c.id)).toEqual(['view1']);
  });

  it('gives every shortcut of the app to one command only', () => {
    const commands = new CommandRegistry();
    registerCommands({ commands } as never, {} as never);
    const owners = new Map<string, string[]>();
    for (const c of commands.all()) if (c.shortcut) owners.set(c.shortcut.toLowerCase(), [...(owners.get(c.shortcut.toLowerCase()) ?? []), c.id]);
    expect([...owners].filter(([, ids]) => ids.length > 1)).toEqual([]);
  });
});
