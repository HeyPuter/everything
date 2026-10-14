import { defineConfig } from 'vite';
import puterLocalhost from '../../dev/puter-localhost.mjs';

export default defineConfig({
  plugins: [puterLocalhost('building-design')],
  base: './',
  build: { target: 'es2022', cssTarget: 'safari15', chunkSizeWarningLimit: 900 },
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
