import { defineConfig } from 'vite';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  root: 'src',
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target:
      process.env.TAURI_ENV_PLATFORM == 'windows'
        ? 'chrome105'
        : 'safari13',
    outDir: '../dist',
    emptyOutDir: true,
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // Split vendor code into separate chunks. Keeps the main app bundle
    // under the 500 kB warn threshold and lets the browser cache vendor
    // chunks across rebuilds (they change much less often than app code).
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-tauri': [
            '@tauri-apps/api/core',
            '@tauri-apps/api/event',
            '@tauri-apps/api/window',
            '@tauri-apps/plugin-dialog',
            '@tauri-apps/plugin-opener',
          ],
          'vendor-i18n': ['i18next'],
        },
      },
    },
  },
});
