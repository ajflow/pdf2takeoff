// Opening files in the browser: PDFs open as they are; images (one, several,
// or mixed with PDFs) become pages of one PDF through the shared
// engine/inputs.ts, decoded here with the browser's own image support.
// Nothing leaves the device.

import {
  buildDocument,
  sniffInput,
  unsupportedMessage,
  IMAGE_KINDS,
  INPUT_EXTENSIONS,
  MIME_BY_KIND,
  type ImageTranscoder,
  type InputFile,
} from '../engine/inputs';

/** The file pickers' accept list (the bytes decide what a file is, not this). */
export const ACCEPT = ['application/pdf', 'image/*', ...INPUT_EXTENSIONS].join(',');

/** iPhone Safari's canvas limit (4,096 x 4,096 px); bigger desktop canvases fail more quietly. */
const SAFE_AREA = 16_777_216;
/** Chrome's and desktop Safari's canvas area limit. */
const MAX_AREA = 268_435_456;
/** SVGs are drawn so their long side has at least this many pixels (they have no native resolution). */
const SVG_LONG_SIDE = 4000;

async function renderPng(source: CanvasImageSource, w: number, h: number): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  canvas.width = canvas.height = 0; // hand the memory back straight away
  return blob;
}

/** Decode with the browser (EXIF orientation applied), shrinking only when a canvas that big fails. */
const browserTranscoder: ImageTranscoder = async (bytes, kind) => {
  const blob = new Blob([bytes as unknown as BlobPart], { type: MIME_BY_KIND[kind] ?? '' });
  let source: CanvasImageSource;
  let w: number;
  let h: number;
  let release = () => {};
  if (kind === 'svg') {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } finally {
      release = () => URL.revokeObjectURL(url);
    }
    // an SVG without width and height reports the replaced-element default
    w = img.naturalWidth || 300;
    h = img.naturalHeight || 150;
    const up = Math.max(1, SVG_LONG_SIDE / Math.max(w, h));
    w = Math.round(w * up);
    h = Math.round(h * up);
    source = img;
  } else {
    const bitmap = await createImageBitmap(blob); // throws when the browser can't read the format
    source = bitmap;
    w = bitmap.width;
    h = bitmap.height;
    release = () => bitmap.close();
  }
  try {
    let out = w * h <= MAX_AREA ? await renderPng(source, w, h) : null;
    let scale = 1;
    if (!out) {
      scale = Math.min(1, Math.sqrt(SAFE_AREA / (w * h)));
      out = await renderPng(source, Math.floor(w * scale), Math.floor(h * scale));
    }
    if (!out) throw new Error('the image is too large for this browser');
    return { png: new Uint8Array(await out.arrayBuffer()), scale };
  } finally {
    release();
  }
};

export type Prepared =
  | { ok: true; bytes: Uint8Array; name: string; notes: string[] }
  | { ok: false; message: string };

function stem(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, '');
}

/**
 * Read the files and make one PDF of them: a single PDF as it is; images and
 * mixed sets as one document in file-name order (A101 before A102 before
 * A110). Returns what to open, or a plain message saying why it can't.
 */
export async function prepareFiles(files: File[]): Promise<Prepared> {
  const inputs: InputFile[] = await Promise.all(
    files.map(async (f) => {
      const bytes = new Uint8Array(await f.arrayBuffer());
      return { bytes, name: f.name || 'pasted image', kind: sniffInput(bytes, f.name) };
    }),
  );
  inputs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const bad = inputs.find((f) => f.kind !== 'pdf' && !IMAGE_KINDS.has(f.kind!));
  if (bad) return { ok: false, message: unsupportedMessage(bad.kind!, bad.name) };
  if (inputs.length === 1 && inputs[0].kind === 'pdf') return { ok: true, bytes: inputs[0].bytes, name: inputs[0].name, notes: [] };

  // name the file a decode failure belongs to (the transcoder only sees bytes)
  const byBytes = new Map(inputs.map((f) => [f.bytes, f]));
  const transcode: ImageTranscoder = async (bytes, kind) => {
    try {
      return await browserTranscoder(bytes, kind);
    } catch (err) {
      const f = byBytes.get(bytes);
      if (kind === 'tiff' || kind === 'heic') throw new Error(unsupportedMessage(kind, f?.name ?? ''));
      throw new Error(`Couldn't read ${f?.name ?? 'an image'}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  let built;
  try {
    built = await buildDocument(inputs, transcode);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  const notes: string[] = [];
  for (const s of built.shrunk) notes.push(`${s.name} was too big for this browser, so it opened at ${Math.round(s.scale * 100)}% size.`);
  const noPaper = [...built.imagePages.values()].filter((dpi) => !dpi).length;
  if (noPaper) {
    notes.push(
      noPaper === built.imagePages.size && built.imagePages.size === built.pageCount
        ? 'Images have no paper size, so calibrate from a dimension you know (press C).'
        : `${noPaper} image page${noPaper === 1 ? " has" : 's have'} no paper size: calibrate ${noPaper === 1 ? 'it' : 'them'} from a dimension you know.`,
    );
  }
  const name = inputs.length === 1 ? inputs[0].name : `${stem(inputs[0].name)} and ${inputs.length - 1} more`;
  return { ok: true, bytes: built.bytes, name, notes };
}

/** A file name without its extension, for naming exports. */
export function fileStem(name: string): string {
  return stem(name);
}
