import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'node:path';

// onnxruntime-web's dynamic import drags its 28 MB wasm binary into dist/,
// even though scan-onnx.ts loads the runtime from the CDN at runtime
// (wasmPaths) — and 28 MB breaks Cloudflare Pages' 25 MB per-file limit.
function dropOrtWasmAssets(): Plugin {
  return {
    name: 'drop-ort-wasm-assets',
    generateBundle(_, bundle) {
      for (const file of Object.keys(bundle)) {
        if (file.endsWith('.wasm') && file.includes('ort-')) delete bundle[file];
      }
    },
  };
}

export default defineConfig({
  build: {
    target: 'es2022',
    // pdf.worker is loaded via ?url import; keep chunking predictable
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        compare: resolve(__dirname, 'compare-drawing-revisions.html'),
        count: resolve(__dirname, 'count-symbols-in-pdf-drawing.html'),
      },
      plugins: [dropOrtWasmAssets()],
    },
  },
});
