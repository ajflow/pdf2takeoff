// Host wiring for the engine's scan port: pdf.js rasterization + the
// optional ONNX detector, both browser-side.

import type { ScanDeps } from '../engine/ports';
import { renderRaster } from './raster';
import { detectorStatus } from './onnx-detector';

export const scanDeps: ScanDeps = {
  renderRaster,
  detector: detectorStatus,
  warn: (message) => console.warn(message),
};
