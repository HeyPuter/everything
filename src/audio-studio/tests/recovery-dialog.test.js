import { describe, it, expect, vi } from 'vitest';
import { recoveryDialog } from '../src/storage/autosave-controller.js';

const manifests = [
  { key: 'take-a', name: 'Take A.wav', frames: 100, sampleRate: 48000, bytes: 444, savedAt: 1000 },
  { key: 'take-b', name: 'Take B.wav', frames: 100, sampleRate: 48000, bytes: 444, savedAt: 2000 },
];
const app = () => ({ formatTime: () => '0:00', notify: vi.fn() });
const controller = () => ({ recover: vi.fn(async () => [{}]), discard: vi.fn(async () => {}) });
const click = (label) => [...document.querySelectorAll('.dialog-foot button')].find((b) => b.textContent === label).click();

describe('recovery choices', () => {
  it('recovers only checked files and leaves unchecked recovery copies intact', async () => {
    const ctl = controller();
    const pending = recoveryDialog(app(), ctl, manifests);
    document.querySelectorAll('input[type=checkbox]')[1].click();
    click('Recover');
    await pending;
    expect(ctl.recover).toHaveBeenCalledWith([manifests[0]]);
    expect(ctl.discard).not.toHaveBeenCalled();
  });

  it('does not delete any recovery copies when no files are checked', async () => {
    const ctl = controller();
    const pending = recoveryDialog(app(), ctl, manifests);
    document.querySelectorAll('input[type=checkbox]').forEach((el) => el.click());
    click('Recover');
    await pending;
    expect(ctl.discard).not.toHaveBeenCalled();
  });

  it('keeps all files on Not Now and deletes them on explicit Discard', async () => {
    const ctl = controller();
    let pending = recoveryDialog(app(), ctl, manifests);
    click('Not Now');
    await pending;
    expect(ctl.recover).not.toHaveBeenCalled();
    expect(ctl.discard).not.toHaveBeenCalled();
    pending = recoveryDialog(app(), ctl, manifests);
    click('Discard');
    await pending;
    expect(ctl.discard).toHaveBeenCalledWith(manifests);
  });
});
