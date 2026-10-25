import { defineConfig, type Plugin } from 'vite';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

// pdf.js 5 decodes CCITT fax, JBIG2 and JPEG 2000 images (the codecs of most
// scanned PDFs) with WebAssembly it fetches from wasmUrl, and draws the
// standard-14 fonts from standardFontDataUrl. Ship both with the site under
// /pdfjs/ (fetched only when a drawing needs them), and serve them in dev.
const pdfjsRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const PDFJS_ASSETS: [string, (name: string) => boolean][] = [
  ['wasm', (n) => /^(jbig2|openjpeg|qcms)/.test(n) && /\.(wasm|js)$/.test(n)],
  ['standard_fonts', () => true],
];
function pdfjsAssets(): Plugin {
  const files = () =>
    PDFJS_ASSETS.flatMap(([dir, keep]) =>
      readdirSync(join(pdfjsRoot, dir))
        .filter((n) => keep(n) && statSync(join(pdfjsRoot, dir, n)).isFile())
        .map((n): [string, string] => [`pdfjs/${dir}/${n}`, join(pdfjsRoot, dir, n)]),
    );
  return {
    name: 'pdfjs-assets',
    configureServer(server) {
      const map = new Map<string, string>(files());
      server.middlewares.use((req, res, next) => {
        const path = map.get((req.url ?? '').split('?')[0].replace(/^\//, ''));
        if (!path) return next();
        if (path.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
        res.end(readFileSync(path));
      });
    },
    generateBundle() {
      for (const [fileName, path] of files()) this.emitFile({ type: 'asset', fileName, source: readFileSync(path) });
    },
  };
}

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
  plugins: [pdfjsAssets()],
  build: {
    target: 'es2022',
    // pdf.worker is loaded via ?url import; keep chunking predictable
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        compare: resolve(__dirname, 'compare-drawing-revisions.html'),
        count: resolve(__dirname, 'count-symbols-in-pdf-drawing.html'),
        area: resolve(__dirname, 'measure-area-on-pdf.html'),
        scale: resolve(__dirname, 'set-scale-on-pdf-drawing.html'),
        bluebeam: resolve(__dirname, 'free-bluebeam-alternative.html'),
        dxf: resolve(__dirname, 'dxf-takeoff.html'),
        photos: resolve(__dirname, 'takeoff-from-photos-and-scans.html'),
        privacy: resolve(__dirname, 'takeoff-without-uploading-drawings.html'),
        benchmarks: resolve(__dirname, 'takeoff-benchmarks.html'),
        mcp: resolve(__dirname, 'mcp-server-construction-takeoff.html'),
      },
      plugins: [dropOrtWasmAssets()],
    },
  },
});
