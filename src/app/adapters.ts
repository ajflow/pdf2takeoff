// Host wiring for the engine's scan port: pdf.js rasterization + the
// optional ONNX detector, both browser-side, plus the page's vector geometry.

import type { ScanDeps } from '../engine/ports';
import { renderRaster } from './raster';
import { detectorStatus } from './onnx-detector';
import { getPageVector } from './viewer';

export const scanDeps: ScanDeps = {
  renderRaster,
  detector: detectorStatus,
  vector: getPageVector,
  warn: (message) => console.warn(message),
};
