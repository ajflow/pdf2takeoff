// Core data types shared by every pdf2takeoff surface (web app, CLI, MCP).
// Pure data — no environment dependencies.

export type Pt = { x: number; y: number };

export type MarkupType = 'length' | 'area' | 'count' | 'perimeter' | 'volume' | 'angle' | 'note';

export type ItemKind = 'Door' | 'Window' | 'Space';
export type DoorType = 'swing' | 'double_swing' | 'sliding' | 'pocket' | 'bifold' | 'garage' | 'french_glazed' | 'other';
export type GlazingType = 'unit' | 'sliding_glass_door' | 'french_door' | 'glazed_opening' | 'other';
export type SpaceKind = 'room' | 'open_plan_zone' | 'hallway' | 'closet' | 'storage_utility' | 'wet' | 'stair' | 'outdoor' | 'garage' | 'other';
export type WetKind = 'none' | 'wc' | 'bathroom' | 'shower' | 'sauna' | 'washroom' | 'lavatory';
export type ItemSource = 'model' | 'vector' | 'cv' | 'ocr' | 'user';

export interface ItemAttrs {
  kind: ItemKind;
  source: ItemSource;
  /** Door: construction type, leaf count (double = 2) and whether it serves a closet or wardrobe. */
  doorType?: DoorType;
  leaves?: number;
  closet?: boolean;
  /** Window: glazing type; units sharing a group id on the same page form one Window group. */
  glazingType?: GlazingType;
  group?: string;
  /** Space: kind, printed room name, whether walls enclose it, bedroom by its label, wet-room type. */
  spaceKind?: SpaceKind;
  roomLabel?: string;
  enclosed?: boolean;
  bedroom?: boolean;
  wetKind?: WetKind;
  /** Self-consistency: how many independent runs proposed this item, out of how many. */
  agreement?: { runs: number; of: number };
}

export interface MarkupLink {
  /** The other markup's stable id. */
  markupId: string;
  /** Formula variable used by the parent measurement (A, B, C...). */
  variable?: string;
  /** User-authored description of the relationship or intended QS logic. Never executed automatically. */
  logic?: string;
  /** Legacy field retained as inert text when opening older project files. */
  relation?: string;
  note?: string;
}

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
  /** Optional per-markup display colour; absent uses the automatic type colour. */
  color?: string;
  /** Visual styling is independent of measured geometry and quantity. */
  strokeWidth?: number;
  strokeOpacity?: number;
  fillOpacity?: number;
  lineStyle?: 'solid' | 'dashed' | 'dotted';
  /** Drawing visibility only; hidden quantities remain in schedules and exports. */
  visible?: boolean;
  /** Count markups only: set when this markup is a proposed or confirmed door, Window or space (see inventory.ts). */
  item?: ItemAttrs;
  /** Scale frozen when this measurement was created; later page/viewport scale edits do not alter it. */
  calibration?: Calibration;
  /** Per-entry QS timesing. Defaults to 1 for projects created before this field existed. */
  timesing?: number;
  /** Per-entry quantity sign: +1 adds, -1 deducts. Defaults to +1. */
  sign?: 1 | -1;
  /** User-defined descriptive dimensions/specification fields (e.g. width, height, section, material). */
  parameters?: Record<string, string>;
  /** Optional notes carried into schedules and exports. */
  remarks?: string;
  /** QS bill item code and optional parent row for a parent/sub-item hierarchy. */
  itemCode?: string;
  parentId?: string;
  /** Optional geometry source for a live linked duplicate; absent means independent geometry. */
  sourceId?: string;
  /** Directed take-off relationships to other measurement entries. */
  links?: MarkupLink[];
  /** Optional live quantity formula over linked measurements, e.g. A-B-C. */
  formula?: string;
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


/** Drawing-only annotation. These are deliberately separate from Markup so they never enter quantity schedules. */
export type DrawingAnnotationKind = 'line' | 'arrow' | 'rectangle' | 'ellipse' | 'highlight' | 'cloud' | 'text';
export interface DrawingAnnotation {
  id: string;
  page: number;
  kind: DrawingAnnotationKind;
  points: Pt[];
  text?: string;
  color?: string;
  strokeWidth?: number;
  opacity?: number;
  fillOpacity?: number;
  lineStyle?: 'solid' | 'dashed' | 'dotted';
}
