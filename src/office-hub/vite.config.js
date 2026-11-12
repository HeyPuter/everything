import { defineConfig } from 'vite';
import puterLocalhost from '../../dev/puter-localhost.mjs';
export default defineConfig({
  plugins: [puterLocalhost('office-hub')],
  base: './',
  build: { target: 'es2022' },
  test: { environment: 'node', include: ['tests/**/*.test.js'] },
});
