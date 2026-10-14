import './styles/tokens.css';
import './styles/base.css';
import './styles/chrome.css';
import './styles/panels.css';
import './styles/dialogs.css';
import { App } from './app.js';
import { showAlphaNotice } from './ui/alpha.js';

const root = document.getElementById('app');
const app = new App(root);
if (import.meta.env.DEV) window.bd = app;
app
  .start()
  .catch((err) => {
    console.error(err);
    const msg = /WebGL2/.test(err?.message) ? 'This browser does not support WebGL2, which Building Design needs for drawing. Try a recent version of Chrome, Edge, Firefox or Safari.' : 'Something went wrong while starting. Reload the page to try again.';
    root.textContent = msg;
    root.classList.add('fatal');
  })
  .finally(() => showAlphaNotice());

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .then(() => navigator.serviceWorker.ready)
      .then((reg) => {
        // Hand the worker this build's files so the app works offline.
        const urls = performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .filter((u) => u.startsWith(location.origin) && u.includes('/assets/'));
        reg.active?.postMessage({ type: 'precache', urls });
      })
      .catch(() => {});
  });
}
