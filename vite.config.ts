import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Asset base path for GitHub Pages project site (github.io/toolbox/).
  base: process.env.GITHUB_PAGES ? '/toolbox/' : '/',
  // Served from the root of the custom subdomain (toolbox.zacsvae.com), so
  // assets live at '/'. (Was '/toolbox/' when hosted under zacsvae.com/toolbox.)
  // base: '/',
  // Local dev only: proxy backend "functions" calls to the self-hosted Node
  // server so the browser talks to the dev origin (no CORS). Set
  // VITE_FUNCTIONS_URL=/functions/v1 in .env to route through this. Point
  // VITE_DEV_BACKEND elsewhere if the backend isn't on this machine.
  server: {
    proxy: {
      '/functions': {
        target: process.env.VITE_DEV_BACKEND || 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
})
