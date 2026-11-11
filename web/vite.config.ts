import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Milkdown renders document images with a plain <img src>, so a long document downloads
// every picture as soon as it opens. Give them `loading="lazy"` (set before `src`, or the
// download has already started) so only those near the screen are fetched. Production
// builds only: the dev server pre-bundles dependencies without running plugins.
const LAZY_IMAGE_FILE = /@milkdown[\\/]components[\\/]lib[\\/]image-(block|inline)[\\/]index\.js$/
function lazyImages(code: string, id: string) {
  const out = code.replace(/\bsrc: src\.value,/g, 'loading: "lazy", decoding: "async", src: src.value,')
  // fail loudly when an upgrade changes the markup, instead of silently loading eagerly again
  if (out === code) throw new Error(`lazy images: pattern not found in ${id}`)
  return out
}
const lazyImagesPlugin: Plugin = {
  name: 'qj-lazy-milkdown-images',
  transform: (code, id) => (LAZY_IMAGE_FILE.test(id) ? { code: lazyImages(code, id), map: null } : undefined),
}

export default defineConfig({
  plugins: [react(), lazyImagesPlugin],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/files': 'http://localhost:8080',
      // single icons rendered by the server; the icon set files themselves come from public/
      '^/icons/[^/]+/[^/]+\\.svg$': 'http://localhost:8080',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
    target: 'es2022',
  },
})
