// Core data types shared by every pdf2takeoff surface (web app, CLI, MCP).
// Pure data — no environment dependencies.

export type Pt = { x: number; y: number };

export type MarkupType = 'length' | 'area' | 'count' | 'perimeter' | 'volume' | 'angle' | 'note';

export interface Markup {
  id: string;
  page: number; // 1-based
  type: MarkupType;
  label: string;
  points: Pt[]; // PDF user space (origin bottom-left)
  createdAt: number;
  /** Volume only: the extrusion depth in metres. */
  depth?: number;
  /** Review status: 'check' = needs verification, 'confirmed' = verified. */
  status?: 'check' | 'confirmed';
  /** Layer name; absent = the default layer. */
  layer?: string;
}

export interface Calibration {
  metersPerPt: number;
  source: string; // e.g. 'measured 12.00 m' or 'preset 1:100'
}

export interface ScanHit {
  x: number; // centre, PDF points
  y: number;
  label?: string; // class name when the provider knows it
  score?: number; // match/confidence 0..1
}

export type ScanResult =
  | {
      hits: ScanHit[];
      provider: 'cv' | 'detector' | 'vector';
      templatePx?: number;
      note?: string;
      truncated?: boolean;
      /** Tier 1 only: set when the line-removal pre-pass produced this result. */
      lineRemoval?: { trigger: string; strokeWidth: number; minRun: number; removedPx: number };
      /** Tier 1 only: the matching stage's settings and what each step did. */
      cv?: {
        /** Signature distance threshold the hits were taken at. */
        matchDistance: number;
        /** 'auto' when read off the sheet's distance distribution, 'option' when passed in, 'default' otherwise. */
        thresholdSource: 'auto' | 'option' | 'default';
        /** Candidate components that passed the size and fill bands (the distribution the threshold was read from). */
        candidates: number;
        /** Template-expansion rounds that added templates (0 = base template only). */
        expansionRounds: number;
        /** Templates matched against after expansion (1 = the clicked symbol). */
        templates: number;
        /** Set when expansion was cut short, and why. */
        expansionStopped?: string;
        /** Text boxes erased from the ink mask before matching. */
        textBoxesMasked?: number;
      };
    }
  | { error: string };
