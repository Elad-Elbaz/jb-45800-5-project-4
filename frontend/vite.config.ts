import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  server: {
    // Bind on all interfaces so `npm run dev` is reachable if it is ever run
    // from inside a container.
    host: true,
    port: 5173,
    /**
     * Forward /api to the backend during development.
     *
     * This makes the dev server behave exactly like the nginx that serves the
     * production build: same origin, relative URLs, no CORS. Without it, dev
     * and production would differ in the one dimension most likely to hide a
     * bug until deployment.
     */
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
})
