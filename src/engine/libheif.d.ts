// The parts of libheif-js (LGPL-3.0, catdad-experiments/libheif-js, an
// Emscripten build of libheif) the HEIC reader uses.
declare module 'libheif-js/libheif-wasm/libheif-bundle.mjs' {
  interface HeifImage {
    get_width(): number;
    get_height(): number;
    display(target: { data: Uint8ClampedArray; width: number; height: number }, done: (result: { data: Uint8ClampedArray } | null) => void): void;
  }
  interface LibHeif {
    HeifDecoder: new () => { decode(bytes: Uint8Array): HeifImage[] };
  }
  const factory: () => LibHeif;
  export default factory;
}
