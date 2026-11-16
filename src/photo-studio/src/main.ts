import './style.css';
import { Editor } from './editor';
import { emitAppEvent } from './app/app-events';
import { installLaunchOpen } from './features/files/launch';
const root = document.querySelector<HTMLElement>('#app')!;
const editor = new Editor(root);
if (import.meta.env.DEV) (window as unknown as { photoStudio: Editor }).photoStudio = editor;
void editor.start().then(() => {
  void emitAppEvent('start');
  installLaunchOpen(editor);
}, (error) => {
  console.error(error);
  editor.el('#engine-status').textContent = 'Graphics unavailable';
  editor.message(error instanceof Error ? error.message : String(error));
});
