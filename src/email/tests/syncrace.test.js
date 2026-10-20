import { describe, it, expect } from 'vitest';
import { createMailbox } from '../src/lib/mailbox.js';

const OBJECTS = '/user/.mail/objects';
const makeFs = (tree) => {
  const fs = {
    gate: null,
    async readdir(path) {
      if (fs.gate) await fs.gate;
      if (path === OBJECTS) return Object.keys(tree).map((day) => ({ name: day, path: `${OBJECTS}/${day}`, is_dir: true }));
      const day = path.split('/').pop();
      return Object.keys(tree[day]).map((name) => ({ name, path: `${path}/${name}`, is_dir: false }));
    },
  };
  return fs;
};

/**
 * A check for new mail lists what sorts above the newest message held. Mail
 * that "Load older messages" paged in from the catalog while that check was
 * on the wire is already held, and is not listed again.
 */
describe('new mail checked while an older page is loaded from the catalog', () => {
  it('is listed once', async () => {
    const tree = { '2026-08-17': { '01a--x': '', '01b--x': '', '01c--x': '' } };
    const fs = makeFs(tree);
    const box = createMailbox({ fs, objectsPath: OBJECTS, pageSize: 2 });
    await box.open();
    // Mail lands; a conversation is opened before the watch's check runs,
    // which lists the whole folder (history) -- arrival included.
    tree['2026-08-17']['01d--new'] = '';
    await box.listAll();
    // The check starts; its listing is on the wire...
    let release;
    fs.gate = new Promise((resolve) => {
      release = resolve;
    });
    const checking = box.sync();
    // ...and "Load older messages" is pressed meanwhile.
    await box.loadMore();
    fs.gate = null;
    release();
    await checking;
    const names = box.messages.map((m) => m.name);
    expect(names.filter((name) => name === '01d--new')).toHaveLength(1);
  });
});
