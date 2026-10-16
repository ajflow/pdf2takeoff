// Scan entry point: picks the best available provider.
//   tier 1  scan-cv.ts    — classic CV template match, always available
//   tier 2  scan-onnx.ts  — trained symbol detector (host-loaded ONNX)
// Tier 2 runs only when the host supplies a detector session; any failure
// falls back to tier 1 in the same call, so scanning never hard-fails
// because of a missing or broken model.

import type { Pt, ScanResult } from './types';
import { RASTER_SCALE, type ScanDeps } from './ports';
import { cvScan } from './scan-cv';
import { detectorScan } from './scan-onnx';

export async function scanForSimilar(pageNum: number, clicked: Pt, deps: ScanDeps): Promise<ScanResult> {
  const detector = await deps.detector();
  const raster = await deps.renderRaster(pageNum, RASTER_SCALE);
  if (detector) {
    try {
      return await detectorScan(raster, clicked, detector);
    } catch (err) {
      deps.warn?.(`tier-2 scan failed, falling back to CV: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return cvScan(raster, clicked);
}
