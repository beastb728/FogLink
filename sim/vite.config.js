import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  server: {
    host: true,
    fs: { allow: ['..'] }, // road lines live in ../data/roads
    proxy: { '/ws': { target: 'ws://localhost:8080', ws: true }, '/stats': 'http://localhost:8080' },
  },
  build: {
    rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), phone: resolve(import.meta.dirname, 'phone.html') } },
  },
});
