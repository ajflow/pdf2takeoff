// Scan entry point: picks the best available provider.
//   tier 1  scan-cv.ts    — classic CV template match, always available
//   tier 2  scan-onnx.ts  — trained symbol detector (host-loaded ONNX)
// Tier 2 runs only when the host supplies a detector session; any failure
// falls back to tier 1 in the same call, so scanning never hard-fails
// because of a missing or broken model.

import type { Pt, ScanResult } from './types.ts';
import { RASTER_SCALE, type ScanDeps } from './ports.ts';
import { cvScan } from './scan-cv.ts';
import { detectorScan } from './scan-onnx.ts';

export async function scanForSimilar(pageNum: number, clicked: Pt, deps: ScanDeps): Promise<ScanResult> {
  const detector = await deps.detector();
  const raster = await deps.renderRaster(pageNum, RASTER_SCALE);
  if (detector) {
    try {
      const r = await detectorScan(raster, clicked, detector);
      // A zero/one-hit detector run on an out-of-family sheet is a miss, not
      // an answer — hand the same click to the always-available CV tier
      // ("anything fails → automatic fallback"). The CV result wins only
      // when it actually finds repeats; otherwise the detector's honest
      // empty result stands.
      if (!('error' in r) && r.hits.length >= 2) return r;
      const cv = cvScan(raster, clicked);
      if ('error' in cv || cv.hits.length >= 2) return cv;
      return r;
    } catch (err) {
      deps.warn?.(`tier-2 scan failed, falling back to CV: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return cvScan(raster, clicked);
}
