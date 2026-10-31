import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The output is one arrow-function expression: the events worker serializes handlers and refuses free variables,
// so the bundle sits inside the function body and references only standard globals.
export const HANDLER_BANNER = 'async ({ event, ctx, user, fetch }) => {';
export const HANDLER_FOOTER = 'return tripsNotify.handle({ event, ctx, user, fetch });\n}';

const wrap = {
  name: 'trips-notify-wrap',
  generateBundle(_, bundle) {
    for (const chunk of Object.values(bundle)) if (chunk.type === 'chunk') chunk.code = `${HANDLER_BANNER}\n${chunk.code}\n${HANDLER_FOOTER}\n`;
  },
};

export default defineConfig({
  publicDir: false,
  logLevel: 'warn',
  plugins: [wrap],
  build: {
    target: 'es2022', outDir: 'worker-notify/dist', emptyOutDir: true, minify: false,
    lib: { entry: fileURLToPath(new URL('./index.js', import.meta.url)), formats: ['iife'], name: 'tripsNotify', fileName: () => 'trips-notify-handler.js' },
  },
});
