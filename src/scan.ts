// Scan entry point: picks the best available provider.
//   tier 1  src/scan-cv.ts   — classic CV template match, always available
//   tier 2  src/scan-onnx.ts — trained symbol detector (ONNX in WASM)
// Tier 2 is used only when a model + manifest are served from /models/;
// any failure falls back to tier 1 in the same call, so scanning never
// hard-fails because of a missing or broken model.

import type { Pt } from './state';
import { cvScan } from './scan-cv';
import { detectorScan, detectorStatus, DetectorDown } from './scan-onnx';

export interface ScanHit {
  x: number; // centre, PDF points
  y: number;
  label?: string; // class name when the provider knows it
  score?: number; // match/confidence 0..1
}

export type ScanResult =
  | { hits: ScanHit[]; provider: 'cv' | 'detector'; templatePx?: number; note?: string }
  | { error: string };

export async function scanForSimilar(pageNum: number, clicked: Pt): Promise<ScanResult> {
  if (await detectorStatus()) {
    try {
      return await detectorScan(pageNum, clicked);
    } catch (e) {
      if (!(e instanceof DetectorDown)) console.warn('tier-2 scan failed, falling back to CV', e);
    }
  }
  return cvScan(pageNum, clicked);
}
