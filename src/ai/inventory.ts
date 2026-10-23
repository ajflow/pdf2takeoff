// The floor-plan inventory prompt contract: the exact prompt and JSON schema
// a vision model gets, and a tolerant parser for what weaker models actually
// return (markdown fences, prose around the JSON, bent field values).

import { z } from 'zod';
import type { DoorType, SpaceKind, WetKind } from '../engine/types.ts';
import type { ProposedItem } from '../engine/inventory.ts';

// The prompt validated on AECV-Bench. The items it asks for are
// convention-free — the counting presets decide what counts, not the model —
// and the `counts` field is the model's own tally, kept only as a diagnostic.
export const INVENTORY_PROMPT = `You are an expert floor-plan analyst trained to interpret architectural and engineering drawings in any language.

Your task is to fully understand the drawing first, then count the elements exactly according to the rules below, and then return ONLY the JSON strictly following the provided schema (an itemized inventory plus final counts). Do not use any tools or inspect files; use only the attached image.

1. Counting Rules and Interpretation Guidelines

You must follow these rules precisely—these match the logic used in preparing the ground-truth dataset. All counts MUST be based on the entire floor-plan image.

1.1 General

- Always consider the entire drawing before counting anything.
- Understand the entire drawing as a architectural and/or engineering drawing before counting anything.
Drawings may use different languages, symbols, and conventions; interpret them consistently.

1.2 Doors

- Count only openable doors (swing doors drawn with an arc).
- Do NOT count sliding closet doors, pantry sliders, or furniture-like wooden sliders on internal walls.
- Each leaf counts separately, i.e, a double-leaf door = 2 doors and a triple-leaf door = 3 doors, etc. and so on.
- Garage entrances are NOT doors.

1.3 Windows

- All sliding openings are counted as windows.
- French doors or large glazed openings are counted as windows, NOT doors.
- Multiple adjacent windows (or sliding units) without a gap between them count as ONE single window group.
- Tiny toilet windows must be counted even if very small.
- Garage entrances are NOT windows.

1.4 Spaces / Rooms

- Count all enclosed spaces, even if unlabeled.
- Partnerships of adjacent but separated spaces (e.g., WC next to Bath) are counted individually.

1.5 Bedrooms

A space labeled "Bedroom,","Chambre," "Zimmer," "Camera," etc., or equivalent should be counted as a bedroom.

1.6 Toilets

- The following labels all count as toilet units, each counted individually:
WC, W.C., Bath, Bain, Douche, Shower, SDB, Bathroom, Toilet, etc.
- Lavatory are not counted as toilets.

2. Itemized inventory (required)

Before giving totals, build a complete inventory. Sweep the whole sheet systematically (left to right, top to bottom, in bands). Every item gets x,y = its center in sheet-normalized coordinates (0,0 = top-left of the image, 1000,1000 = bottom-right). If the sheet shows several floors or units, inventory all of them.

2.1 spaces: one entry per distinct area you can see, INCLUDING ones the rules above might not count. For each give:
- label: the text written in it exactly as printed ("" if none).
- kind: room (habitable or named room) | open_plan_zone (a separately labelled zone inside an open area, e.g. "Dining" inside a living/kitchen space) | hallway (hall, corridor, entry, landing, lobby) | closet (wardrobe, linen, built-in cupboard, walk-in closet) | storage_utility (storage, laundry, pantry, technical/plant room, boiler) | wet (WC, bathroom, shower, sauna, washroom) | stair | outdoor (terrace, balcony, porch, deck, patio) | garage (garage, carport, parking) | other.
- enclosed: true if bounded by walls/doors on all sides.
- bedroom_label: true only if the label names a bedroom in any language (Bedroom, Bed, Chambre, Zimmer/Schlafzimmer, Camera, MH/makuuhuone, Habitación, Slaapkamer, etc.).
- wet_kind: none | wc (toilet only) | bathroom (bath and/or shower, may include toilet) | shower | sauna | washroom (Finnish PH/KH/KPH-type washroom) | lavatory (hand-basin only / powder room labelled "lavatory").

2.2 doors: one entry per door opening that has a leaf or panel, INCLUDING ones the rules might not count. type: swing (hinged leaf with arc) | double_swing (two hinged leaves) | sliding | pocket | bifold | garage | french_glazed (glazed double/french door) | other. leaves: number of leaves/panels (integer >= 1). closet: true if it opens only into a closet/wardrobe.

2.3 windows: one entry per window or glazed opening as drawn, INCLUDING ones the rules might not count. type: window | sliding_glass_door | french_door | glazed_opening | other. group: an integer id; give adjacent units with no wall gap between them the same group id.

3. Final counts

counts: Door, Window, Space, Bedroom, Toilet following the counting rules in section 1 exactly, using your inventory. Each count must be consistent with the inventory entries you chose to count.
`;

// The JSON schema handed to structured-output providers (response_format
// json_schema); transcribed from the validated schema so no file read is
// needed at runtime.
export const INVENTORY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['spaces', 'doors', 'windows', 'counts'],
  properties: {
    spaces: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'kind', 'enclosed', 'bedroom_label', 'wet_kind', 'x', 'y'],
        properties: {
          label: { type: 'string' },
          kind: { type: 'string', enum: ['room', 'open_plan_zone', 'hallway', 'closet', 'storage_utility', 'wet', 'stair', 'outdoor', 'garage', 'other'] },
          enclosed: { type: 'boolean' },
          bedroom_label: { type: 'boolean' },
          wet_kind: { type: 'string', enum: ['none', 'wc', 'bathroom', 'shower', 'sauna', 'washroom', 'lavatory'] },
          x: { type: 'integer', minimum: 0, maximum: 1000 },
          y: { type: 'integer', minimum: 0, maximum: 1000 },
        },
      },
    },
    doors: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'leaves', 'closet', 'x', 'y'],
        properties: {
          type: { type: 'string', enum: ['swing', 'double_swing', 'sliding', 'pocket', 'bifold', 'garage', 'french_glazed', 'other'] },
          leaves: { type: 'integer', minimum: 1 },
          closet: { type: 'boolean' },
          x: { type: 'integer', minimum: 0, maximum: 1000 },
          y: { type: 'integer', minimum: 0, maximum: 1000 },
        },
      },
    },
    windows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'group', 'x', 'y'],
        properties: {
          type: { type: 'string', enum: ['window', 'sliding_glass_door', 'french_door', 'glazed_opening', 'other'] },
          group: { type: 'integer', minimum: 0 },
          x: { type: 'integer', minimum: 0, maximum: 1000 },
          y: { type: 'integer', minimum: 0, maximum: 1000 },
        },
      },
    },
    counts: {
      type: 'object',
      additionalProperties: false,
      required: ['Door', 'Window', 'Space', 'Bedroom', 'Toilet'],
      properties: {
        Door: { type: 'integer', minimum: 0 },
        Window: { type: 'integer', minimum: 0 },
        Space: { type: 'integer', minimum: 0 },
        Bedroom: { type: 'integer', minimum: 0 },
        Toilet: { type: 'integer', minimum: 0 },
      },
    },
  },
};

export const INVENTORY_SCHEMA_NAME = 'floor_plan_inventory';

export interface InventoryResponse {
  spaces: { label: string; kind: SpaceKind; enclosed: boolean; bedroom_label: boolean; wet_kind: WetKind; x: number; y: number }[];
  doors: { type: DoorType; leaves: number; closet: boolean; x: number; y: number }[];
  windows: { type: 'window' | 'sliding_glass_door' | 'french_door' | 'glazed_opening' | 'other'; group: number; x: number; y: number }[];
  counts: { Door: number; Window: number; Space: number; Bedroom: number; Toilet: number };
}

export class InventoryParseError extends Error {}

const SPACE_KINDS = ['room', 'open_plan_zone', 'hallway', 'closet', 'storage_utility', 'wet', 'stair', 'outdoor', 'garage', 'other'] as const;
const WET_KINDS = ['none', 'wc', 'bathroom', 'shower', 'sauna', 'washroom', 'lavatory'] as const;
const DOOR_TYPES = ['swing', 'double_swing', 'sliding', 'pocket', 'bifold', 'garage', 'french_glazed', 'other'] as const;
const WINDOW_TYPES = ['window', 'sliding_glass_door', 'french_door', 'glazed_opening', 'other'] as const;

// Lenient item schemas: unknown enum values fall back, missing booleans take
// defaults (enclosed true — the default reading of an area drawn indoors),
// missing labels go empty, coordinates are rounded and clamped to 0..1000.
// Items that are not objects, or lack numeric x/y, fail safeParse and drop.
const coord = z.number().transform((n) => Math.min(1000, Math.max(0, Math.round(n))));
const spaceItem = z.object({
  label: z.string().catch(''),
  kind: z.enum(SPACE_KINDS).catch('other'),
  enclosed: z.boolean().catch(true),
  bedroom_label: z.boolean().catch(false),
  wet_kind: z.enum(WET_KINDS).catch('none'),
  x: coord,
  y: coord,
});
const doorItem = z.object({
  type: z.enum(DOOR_TYPES).catch('other'),
  leaves: z.number().transform((n) => Math.max(1, Math.round(n))).catch(1),
  closet: z.boolean().catch(false),
  x: coord,
  y: coord,
});
const windowItem = z.object({
  type: z.enum(WINDOW_TYPES).catch('other'),
  // missing or non-integer groups are replaced per item after parsing
  group: z.number().int().optional().catch(undefined),
  x: coord,
  y: coord,
});
const countsItem = z
  .object({
    Door: z.number().transform((n) => Math.max(0, Math.round(n))).catch(0),
    Window: z.number().transform((n) => Math.max(0, Math.round(n))).catch(0),
    Space: z.number().transform((n) => Math.max(0, Math.round(n))).catch(0),
    Bedroom: z.number().transform((n) => Math.max(0, Math.round(n))).catch(0),
    Toilet: z.number().transform((n) => Math.max(0, Math.round(n))).catch(0),
  })
  .catch({ Door: 0, Window: 0, Space: 0, Bedroom: 0, Toilet: 0 });

// JSON.parse on what a model actually returned: strip a markdown fence, and
// when the text itself does not parse take the outermost {...} (prose happens)
function parseJsonLoose(text: string): unknown {
  let t = text.trim();
  if (t.startsWith('```')) t = t.replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1));
      } catch {
        // fall through to the error below
      }
    }
  }
  throw new InventoryParseError(`model output is not JSON: ${text.slice(0, 120)}`);
}

const arrayOf = (obj: Record<string, unknown>, field: string): unknown[] => {
  if (Array.isArray(obj[field])) return obj[field] as unknown[];
  throw new InventoryParseError(`model output is missing the "${field}" array`);
};

/**
 * Parse a model's inventory answer: tolerate fences and prose, coerce
 * leniently (unknown kinds → 'other', coordinates clamped, missing booleans
 * defaulted, ungrouped units given unique negative group ids so they never
 * merge), and drop items with no usable position. A missing counts object
 * becomes all zeros — the tally is diagnostic, the items are the product.
 */
export function parseInventory(text: string): InventoryResponse {
  const raw = parseJsonLoose(text);
  const obj = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  let ungrouped = 0;
  const freshGroup = (): number => --ungrouped;
  const spaces: InventoryResponse['spaces'] = [];
  for (const item of arrayOf(obj, 'spaces')) {
    const r = spaceItem.safeParse(item);
    if (r.success) spaces.push(r.data);
  }
  const doors: InventoryResponse['doors'] = [];
  for (const item of arrayOf(obj, 'doors')) {
    const r = doorItem.safeParse(item);
    if (r.success) doors.push(r.data);
  }
  const windows: InventoryResponse['windows'] = [];
  for (const item of arrayOf(obj, 'windows')) {
    const r = windowItem.safeParse(item);
    if (r.success) windows.push({ ...r.data, group: r.data.group ?? freshGroup() });
  }
  return { spaces, doors, windows, counts: countsItem.parse(obj.counts) };
}

/** Model proposals in PDF points: the sheet-normalised 0..1000 coordinates
 *  are of the rendered image (top-left origin), PDF points are bottom-left. */
export function toProposals(inv: InventoryResponse, page: { widthPt: number; heightPt: number }): ProposedItem[] {
  const at = (x: number, y: number): [number, number] => [
    Math.round((x / 1000) * page.widthPt * 100) / 100,
    Math.round((page.heightPt - (y / 1000) * page.heightPt) * 100) / 100,
  ];
  return [
    ...inv.doors.map((d) => ({ kind: 'Door' as const, at: at(d.x, d.y), doorType: d.type, leaves: d.leaves, closet: d.closet })),
    ...inv.windows.map((w) => ({ kind: 'Window' as const, at: at(w.x, w.y), glazingType: w.type === 'window' ? ('unit' as const) : w.type, group: String(w.group) })),
    ...inv.spaces.map((s) => ({
      kind: 'Space' as const,
      at: at(s.x, s.y),
      spaceKind: s.kind,
      roomLabel: s.label,
      enclosed: s.enclosed,
      bedroom: s.bedroom_label,
      wetKind: s.wet_kind,
    })),
  ];
}
