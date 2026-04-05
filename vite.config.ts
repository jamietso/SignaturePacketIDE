import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Gemini runs on the backend only (`GEMINI_API_KEY`); the client calls `/api/gemini/*`. */
export default defineConfig(() => {
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
        proxy: {
          '/api': {
            target: 'http://localhost:8787',
            changeOrigin: true,
          },
        },
      },
      plugins: [react()],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
