// Revision overlay blend: the pure pixel math behind compare mode.
// Red appears only in revision A (removed), blue only in revision B (added),
// dark ink in both (unchanged); "changes only" fades unchanged ink to grey.
// Loading, sizing and display belong to the host.

/** An RGBA raster: row-major bytes, 4 per pixel, top-left origin. */
export interface RGBA {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

/**
 * Blend revision B over revision A (both rasters of the same page region).
 * `dxPx`/`dyPx` shift B in A-raster pixels (+x right, +y down); the result is
 * written into `out` (an RGBA buffer of a.width × a.height) and returned.
 */
export function blendOverlay(
  a: RGBA,
  b: RGBA,
  dxPx: number,
  dyPx: number,
  fadeUnchanged: boolean,
  out: Uint8ClampedArray,
): Uint8ClampedArray {
  const o = out;
  for (let y = 0; y < a.height; y++) {
    const by = Math.round(y - dyPx);
    const rowInB = by >= 0 && by < b.height;
    const rowA = y * a.width * 4;
    const rowB = by * b.width * 4;
    const rowO = y * a.width * 4;
    for (let x = 0; x < a.width; x++) {
      const ai = rowA + x * 4;
      const rA = a.data[ai];
      const gA = a.data[ai + 1];
      const bA_ = a.data[ai + 2];
      const inkA = 255 - (rA * 299 + gA * 587 + bA_ * 114) / 1000;

      let inkB = 0;
      if (rowInB) {
        const bx = Math.round(x - dxPx);
        if (bx >= 0 && bx < b.width) {
          const bi = rowB + bx * 4;
          const rB = b.data[bi];
          const gB = b.data[bi + 1];
          const bB_ = b.data[bi + 2];
          inkB = 255 - (rB * 299 + gB * 587 + bB_ * 114) / 1000;
        }
      }

      let r: number, g: number, bl: number, m: number;
      if (fadeUnchanged) {
        const both = Math.min(inkA, inkB);
        const onlyA = inkA - both;
        const onlyB = inkB - both;
        const gray = both * 0.22;
        r = gray + onlyA;
        g = gray + onlyB;
        bl = gray + onlyB;
        m = Math.max(r, g, bl);
      } else {
        r = inkA;
        g = inkB;
        bl = inkB;
        m = Math.max(inkA, inkB);
      }

      // composite the tint over white
      const oi = rowO + x * 4;
      o[oi] = 255 - (m * (255 - r)) / 255;
      o[oi + 1] = 255 - (m * (255 - g)) / 255;
      o[oi + 2] = 255 - (m * (255 - bl)) / 255;
      o[oi + 3] = 255;
    }
  }
  return o;
}
