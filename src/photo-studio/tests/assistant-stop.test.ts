// Stop pressed while the Assistant is still loading the settings of a plan's
// commands: the plan that arrives afterwards is dropped, not shown after
// "Stopped.".
import { describe, expect, it, vi } from 'vitest';
import { DocumentSession } from '../src/app/session';
import { newDocument } from '../src/model/document';
import { registerCommand } from '../src/app/registry';
import type { Editor } from '../src/editor';
import { ask, cancelAsk, conversation, setChat } from '../src/features/assistant/controller';

// The filter catalog loads on first use; the test decides when it arrives.
let release!: () => void;
const loaded = new Promise<void>((r) => (release = r));
let loading = false;
vi.mock('../src/features/filters/catalog', async () => {
  loading = true;
  await loaded;
  return { filterOp: () => undefined };
});

describe('stopping the Assistant', () => {
  it('drops a plan whose command settings were still loading', async () => {
    const s = new DocumentSession(newDocument(40, 30, 'Doc'));
    s.hasDocument = true;
    const e = {
      sessions: [s],
      session: s,
      tool: 'move',
      color: '#000000',
      background: '#ffffff',
      hasDocument: true,
      get doc() {
        return s.doc;
      },
      get assets() {
        return s.assets;
      },
      get selectedIds() {
        return s.selectedIds;
      },
      message() {},
    } as unknown as Editor;
    registerCommand({ id: 'filter.apply.test-blur', label: 'Test Blur', run: () => {} });
    (globalThis as { puter?: unknown }).puter = { auth: { isSignedIn: () => true } };
    setChat(async () => ({ text: '', calls: [{ id: 'c0', name: 'propose_plan', args: { title: 'Blur', steps: [{ action: 'filter.apply.test-blur' }] } }] }));
    const pending = ask(e, 'blur it');
    await vi.waitFor(() => expect(loading).toBe(true));
    cancelAsk(e);
    release();
    await pending;
    const messages = conversation(e).messages;
    expect(messages.map((m) => (m.role === 'user' ? 'user' : m.kind))).toEqual(['user', 'text']);
    expect(messages.at(-1)).toMatchObject({ text: 'Stopped.' });
  });
});
