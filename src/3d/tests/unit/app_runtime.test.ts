// @vitest-environment happy-dom
// App runtime: operators, undo and the Adjust Last Operation panel.
import { describe, it, expect, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app, registerOperator } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';

registerOperator({
  idname: 'test.bump_frame_end',
  label: 'Bump Frame End',
  props: [{ id: 'amount', type: 'int', default: 1 }],
  exec: (ctx, p) => {
    ctx.doc.scene.frame_end += p.amount as number;
    return 'FINISHED';
  },
});

beforeEach(() => {
  setApp(new App(startupDocument()));
});

describe('Adjust Last Operation', () => {
  it('is not offered after another undo step (e.g. a property edit), which repeat still uses', () => {
    const end0 = app.doc.scene.frame_end;
    app.run('test.bump_frame_end', { amount: 5 });
    expect(app.canAdjustLast).toBe(true);
    // a button edit pushes its own undo step
    app.doc.scene.frame_start = 7;
    app.pushUndo('Change Start');
    expect(app.canAdjustLast).toBe(false);
    expect(app.lastOp?.idname).toBe('test.bump_frame_end');
    // adjusting would have dropped the edit and run the operator again on top of it
    app.redoLast({ amount: 10 });
    expect(app.doc.scene.frame_start).toBe(7);
    expect(app.doc.scene.frame_end).toBe(end0 + 5);
  });

  it('re-runs the operator from the state before it', () => {
    const end0 = app.doc.scene.frame_end;
    app.run('test.bump_frame_end', { amount: 5 });
    app.redoLast({ amount: 10 });
    expect(app.doc.scene.frame_end).toBe(end0 + 10);
    // adjusting again still works (the adjusted step is the current one)
    app.redoLast({ amount: 2 });
    expect(app.doc.scene.frame_end).toBe(end0 + 2);
    app.undoStep();
    expect(app.doc.scene.frame_end).toBe(end0);
  });
});
