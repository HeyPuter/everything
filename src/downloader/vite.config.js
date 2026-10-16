import { defineConfig } from 'vite';
import puterLocalhost from '../../dev/puter-localhost.mjs';

export default defineConfig({
  plugins: [puterLocalhost('downloader')],
  server: {
    host: '127.0.0.1',
    port: 3000,
  },
});
