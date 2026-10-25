import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the gateway runs on :4000; in the cluster the Ingress routes /api and /mcp to it.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:4000',
      '/mcp': 'http://localhost:4000',
    },
  },
});
