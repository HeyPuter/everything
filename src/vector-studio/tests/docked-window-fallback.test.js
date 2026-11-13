import { expect, it } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { setArrangement } from '../src/features/workspace/window.js';

async function closeAll(app) {
  for (const ed of [...app.editors]) await app.closeDocument(ed, { force: true });
}

it('shows an available docked document behind a newly floated active window', async () => {
  const app = await bootAppWithFeatures();
  try {
    const docked = app.newDocument();
    const floating = app.newDocument();
    setArrangement(app, null, { float: true });
    expect(app.editor).toBe(floating);
    expect(app.views.get(floating).host.hidden).toBe(false);
    expect(app.views.get(docked).host.hidden).toBe(false);
    expect(app.lastDocked).toBe(docked);
  } finally {
    await closeAll(app);
  }
});

it('chooses a remaining docked document after the visible background tab closes', async () => {
  const app = await bootAppWithFeatures();
  try {
    const remaining = app.newDocument();
    const background = app.newDocument();
    const floating = app.newDocument();
    setArrangement(app, null, { float: true });
    app.activate(background);
    app.activate(floating);
    expect(app.views.get(background).host.hidden).toBe(false);
    await app.closeDocument(background, { force: true });
    expect(app.editor).toBe(floating);
    expect(app.views.get(remaining).host.hidden).toBe(false);
    expect(app.lastDocked).toBe(remaining);
  } finally {
    await closeAll(app);
  }
});

it('remembers a window docked while active when another floating window gains focus', async () => {
  const app = await bootAppWithFeatures();
  try {
    const original = app.newDocument();
    const toDock = app.newDocument();
    setArrangement(app, null, { float: true });
    const other = app.newDocument();
    setArrangement(app, null, { float: true });
    app.activate(original);
    app.activate(toDock);
    app.views.get(toDock).host.querySelector('.float-head button').click();
    app.activate(other);
    expect(app.views.get(toDock).host.hidden).toBe(false);
    expect(app.views.get(original).host.hidden).toBe(true);
    expect(app.lastDocked).toBe(toDock);
  } finally {
    await closeAll(app);
  }
});

it('releases the last docked editor after all documents close', async () => {
  const app = await bootAppWithFeatures();
  app.newDocument();
  await closeAll(app);
  expect(app.lastDocked === null).toBe(true);
});
