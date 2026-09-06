import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: '/HonorRoll/',
  plugins: [react()],
  build: {
    // Already Vite's own default (false) — explicit so it reads as a
    // deliberate choice, not something a future config change could
    // silently flip on. This app ships to GitHub Pages, a public host;
    // a source map there would let anyone reconstruct readable source
    // from the minified bundle.
    sourcemap: false,
  },
})
