import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Asset base path for GitHub Pages project site (github.io/toolbox/).
  base: process.env.GITHUB_PAGES ? '/toolbox/' : '/',
})
