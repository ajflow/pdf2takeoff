// Inventory counting: deterministic quantities from proposed door, Window and
// space items. A detector or an agent proposes one item per physical object —
// a count markup carrying an `item` payload — and how much each item adds to
// Door, Window, Space, Bedroom and Toilet is decided here, not by the
// proposer, under an explicit counting preset. Switching preset recounts the
// same items with no new model call, and every number traces back to one
// markup a reviewer can confirm or delete: each item gets a decision naming
// the field it counted in, or why it added nothing. Markups in, counts and
// decisions out; environment-agnostic like the rest of engine/.

import type { DoorType, GlazingType, ItemAttrs, ItemKind, ItemSource, Markup, SpaceKind, WetKind } from './types.ts';

export type CountField = 'Door' | 'Window' | 'Space' | 'Bedroom' | 'Toilet';
export const COUNT_FIELDS: readonly CountField[] = ['Door', 'Window', 'Space', 'Bedroom', 'Toilet'];

export interface CountPreset {
  id: string;
  name: string;
  description: string;
  door: { types: DoorType[]; countLeaves: boolean; includeCloset: boolean };
  glazing: { types: GlazingType[]; grouped: boolean; doorTypesAsGlazing: DoorType[] };
  space: { kinds: SpaceKind[]; requireLabel: boolean; requireEnclosed: boolean; mergeOpenPlan: boolean };
  toilet: { wetKinds: WetKind[] };
}

// AECV-Bench: swing leaves are doors; French glazed doors, sliding glass
// doors and glazed openings read as glazing, adjacent units as one group;
// other sliding doors count nowhere; rooms count, open-plan zones merge.
export const AECV_PRESET: CountPreset = {
  id: 'aecv',
  name: 'AECV-Bench',
  description: 'The AECV-Bench counting rules: swing doors only, each leaf counts; sliding, French and glazed openings count as Windows, adjacent units as one group; labelled and unlabelled rooms count, open-plan zones merge into one, closets, stairs and outdoor areas do not.',
  door: { types: ['swing', 'double_swing'], countLeaves: true, includeCloset: true },
  glazing: { types: ['unit', 'sliding_glass_door', 'french_door', 'glazed_opening'], grouped: true, doorTypesAsGlazing: ['french_glazed'] },
  space: { kinds: ['room', 'open_plan_zone', 'wet', 'storage_utility', 'hallway', 'garage', 'other'], requireLabel: false, requireEnclosed: false, mergeOpenPlan: true },
  toilet: { wetKinds: ['wc', 'bathroom', 'shower', 'washroom'] },
};

// Schedule style: one row per doorset whatever the leaves, every door type
// but garage; every Window unit on its own line; spaces kept separate.
export const SCHEDULE_PRESET: CountPreset = {
  id: 'schedule',
  name: 'Door and Window schedule',
  description: 'Schedule-style counting: one per doorset whatever the leaf count, every door type except garage doors; every Window unit counted separately; every space except outdoor areas, open-plan zones kept separate.',
  door: { types: ['swing', 'double_swing', 'sliding', 'pocket', 'bifold', 'french_glazed', 'other'], countLeaves: false, includeCloset: true },
  glazing: { types: ['unit', 'sliding_glass_door', 'french_door', 'glazed_opening', 'other'], grouped: false, doorTypesAsGlazing: [] },
  space: { kinds: ['room', 'open_plan_zone', 'hallway', 'closet', 'storage_utility', 'wet', 'stair', 'garage', 'other'], requireLabel: false, requireEnclosed: false, mergeOpenPlan: false },
  toilet: { wetKinds: ['wc', 'bathroom', 'shower', 'washroom'] },
};

export const COUNT_PRESETS: readonly CountPreset[] = [AECV_PRESET, SCHEDULE_PRESET];

export function presetById(id: string): CountPreset | undefined {
  return COUNT_PRESETS.find((p) => p.id === id);
}

export interface ItemDecision {
  id: string; // markup id
  page: number;
  kind: ItemKind;
  field: CountField | null; // null = excluded from every field
  counted: number; // what this item added to `field` (0 when excluded, merged or grouped)
  reason: string; // always non-empty when counted is 0
}

export interface CountResult {
  preset: string; // preset id
  counts: Record<CountField, number>;
  /** Item markups still awaiting review (status 'check') that added to at least one count. */
  unconfirmed: number;
  decisions: ItemDecision[];
}

// defaults for ItemAttrs fields left unset (see types.ts)
const DOOR_TYPE_DEFAULT: DoorType = 'other';
const GLAZING_TYPE_DEFAULT: GlazingType = 'other';
const SPACE_KIND_DEFAULT: SpaceKind = 'other';
const WET_KIND_DEFAULT: WetKind = 'none';

const spaced = (s: string) => s.replace(/_/g, ' ');
const hasText = (s: string | undefined) => !!s && s.trim().length > 0;

// Item attributes ride in the PDF annotation's comment as a tag such as
// "[item:k=Door;dt=double_swing;lv=2;src=model]", so a takeoff saved to PDF
// reopens with its types and recounts under any preset. Values are
// URI-encoded (room labels may hold any character); short keys keep the
// comment readable in Revu and Acrobat.
const ITEM_KINDS: readonly ItemKind[] = ['Door', 'Window', 'Space'];
const ITEM_SOURCES: readonly ItemSource[] = ['model', 'vector', 'cv', 'ocr', 'user'];
const DOOR_TYPES: readonly DoorType[] = ['swing', 'double_swing', 'sliding', 'pocket', 'bifold', 'garage', 'french_glazed', 'other'];
const GLAZING_TYPES: readonly GlazingType[] = ['unit', 'sliding_glass_door', 'french_door', 'glazed_opening', 'other'];
const SPACE_KINDS: readonly SpaceKind[] = ['room', 'open_plan_zone', 'hallway', 'closet', 'storage_utility', 'wet', 'stair', 'outdoor', 'garage', 'other'];
const WET_KINDS: readonly WetKind[] = ['none', 'wc', 'bathroom', 'shower', 'sauna', 'washroom', 'lavatory'];

/** The "[item:...]" comment tag for an item. */
export function itemTag(item: ItemAttrs): string {
  const parts: [string, string | number | boolean | undefined][] = [
    ['k', item.kind],
    ['src', item.source],
    ['dt', item.doorType],
    ['lv', item.leaves],
    ['cl', item.closet],
    ['gt', item.glazingType],
    ['g', item.group],
    ['sk', item.spaceKind],
    ['rl', item.roomLabel],
    ['en', item.enclosed],
    ['bd', item.bedroom],
    ['wk', item.wetKind],
    ['ag', item.agreement ? `${item.agreement.runs}/${item.agreement.of}` : undefined],
  ];
  const fields = parts
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(typeof v === 'boolean' ? (v ? '1' : '0') : String(v))}`);
  return `[item:${fields.join(';')}]`;
}

/** Attributes from the inside of an "[item:...]" tag; undefined when the kind
 *  is missing or unknown. Unknown values are dropped, never guessed. */
export function parseItemTag(payload: string): ItemAttrs | undefined {
  const f = new Map<string, string>();
  for (const part of payload.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    try {
      f.set(part.slice(0, eq), decodeURIComponent(part.slice(eq + 1)));
    } catch {
      // a malformed escape: skip the field
    }
  }
  const pick = <T extends string>(key: string, allowed: readonly T[]): T | undefined => {
    const v = f.get(key);
    return v !== undefined && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
  };
  const flag = (key: string): boolean | undefined => (f.get(key) === '1' ? true : f.get(key) === '0' ? false : undefined);
  const kind = pick('k', ITEM_KINDS);
  if (!kind) return undefined;
  const item: ItemAttrs = { kind, source: pick('src', ITEM_SOURCES) ?? 'user' };
  const leaves = Number(f.get('lv'));
  const ag = /^(\d+)\/(\d+)$/.exec(f.get('ag') ?? '');
  const extra: Partial<ItemAttrs> = {
    doorType: pick('dt', DOOR_TYPES),
    leaves: Number.isInteger(leaves) && leaves >= 1 ? leaves : undefined,
    closet: flag('cl'),
    glazingType: pick('gt', GLAZING_TYPES),
    group: f.get('g'),
    spaceKind: pick('sk', SPACE_KINDS),
    roomLabel: f.get('rl'),
    enclosed: flag('en'),
    bedroom: flag('bd'),
    wetKind: pick('wk', WET_KINDS),
    agreement: ag && +ag[1] <= +ag[2] ? { runs: +ag[1], of: +ag[2] } : undefined,
  };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) (item as unknown as Record<string, unknown>)[k] = v;
  return item;
}

export function itemLabel(item: ItemAttrs): string {
  if (item.kind === 'Door') return `Door (${spaced(item.doorType ?? DOOR_TYPE_DEFAULT)})`;
  if (item.kind === 'Window') return `Window (${spaced(item.glazingType ?? GLAZING_TYPE_DEFAULT)})`;
  if (hasText(item.roomLabel)) return `Space: ${item.roomLabel}`;
  return `Space (${spaced(item.spaceKind ?? SPACE_KIND_DEFAULT)})`;
}

/** One proposed item as an agent or model gives it: kind, centre in PDF
 *  points, and the kind's attributes. `label` names the markup itself
 *  (itemLabel decides when absent); everything else lands in the item attrs. */
export interface ProposedItem {
  kind: ItemKind;
  at: [number, number];
  doorType?: DoorType;
  leaves?: number;
  closet?: boolean;
  glazingType?: GlazingType;
  group?: string;
  spaceKind?: SpaceKind;
  roomLabel?: string;
  enclosed?: boolean;
  bedroom?: boolean;
  wetKind?: WetKind;
  label?: string;
  agreement?: { runs: number; of: number };
}

// drop keys explicitly set to undefined, so attrs carry only real fields
function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** Flagged (status 'check') count markups for proposed items, one per item.
 *  The shared proposal→markup path: however items arrive (an agent over MCP,
 *  a vision model over the CLI), the markups they become are identical, and
 *  counting stays a job for countItems under an explicit preset. */
export function proposalMarkups(items: readonly ProposedItem[], page: number, source: ItemSource, makeId: () => string, now: number = Date.now()): Markup[] {
  return items.map((it) => {
    const { kind, at, label, agreement, ...flags } = it;
    const attrs: ItemAttrs = { kind, source, ...defined(flags), ...(agreement ? { agreement } : {}) };
    return {
      id: makeId(),
      page,
      type: 'count',
      label: label ?? itemLabel(attrs),
      points: [{ x: at[0], y: at[1] }],
      createdAt: now,
      status: 'check',
      item: attrs,
    };
  });
}

export function countItems(markups: readonly Markup[], preset: CountPreset): CountResult {
  const counts: Record<CountField, number> = { Door: 0, Window: 0, Space: 0, Bedroom: 0, Toilet: 0 };
  const decisions: ItemDecision[] = [];
  const awaitingReview = new Set<string>();
  // glazing groups and open-plan merges run per page
  const seenGroups = new Set<string>();
  const openPlanSeen = new Set<number>();

  // one decision per item and field; counts stay the exact sum of the decisions
  const decide = (m: Markup, kind: ItemKind, field: CountField | null, counted: number, reason: string) => {
    decisions.push({ id: m.id, page: m.page, kind, field, counted, reason });
    if (field) counts[field] += counted;
    if (counted > 0 && m.status === 'check') awaitingReview.add(m.id);
  };

  for (const m of markups) {
    if (m.type !== 'count' || !m.item) continue;
    const item = m.item;
    if (item.kind === 'Door') {
      const doorType = item.doorType ?? DOOR_TYPE_DEFAULT;
      const closet = item.closet ?? false;
      const leaves = item.leaves ?? 1;
      if (preset.glazing.doorTypesAsGlazing.includes(doorType) && !closet) {
        // a glazed leaf (french_glazed under AECV-Bench) counts as glazing
        decide(m, item.kind, 'Window', 1, '');
      } else if (preset.door.types.includes(doorType) && (preset.door.includeCloset || !closet)) {
        decide(m, item.kind, 'Door', preset.door.countLeaves ? Math.max(1, leaves) : 1, '');
      } else {
        const closetBlocked = preset.door.types.includes(doorType) && !preset.door.includeCloset && closet;
        decide(
          m,
          item.kind,
          null,
          0,
          closetBlocked ? `closet door excluded by preset ${preset.id}` : `door type ${doorType} not counted by preset ${preset.id}`,
        );
      }
    } else if (item.kind === 'Window') {
      const glazingType = item.glazingType ?? GLAZING_TYPE_DEFAULT;
      if (!preset.glazing.types.includes(glazingType)) {
        decide(m, item.kind, null, 0, `glazing type ${glazingType} not counted by preset ${preset.id}`);
      } else if (preset.glazing.grouped && item.group) {
        const key = `${m.page}/${item.group}`;
        if (seenGroups.has(key)) decide(m, item.kind, 'Window', 0, `grouped with Window group ${item.group}`);
        else {
          seenGroups.add(key);
          decide(m, item.kind, 'Window', 1, '');
        }
      } else {
        decide(m, item.kind, 'Window', 1, '');
      }
    } else {
      // Space: always a Space decision; Bedroom and Toilet are independent of it
      const spaceKind = item.spaceKind ?? SPACE_KIND_DEFAULT;
      const why: string[] = [];
      if (!preset.space.kinds.includes(spaceKind)) why.push(`space kind ${spaceKind} not counted by preset ${preset.id}`);
      if (preset.space.requireLabel && !hasText(item.roomLabel)) why.push(`no room label (preset ${preset.id} requires one)`);
      if (preset.space.requireEnclosed && !(item.enclosed ?? true)) why.push(`not enclosed (preset ${preset.id} requires it)`);
      if (why.length > 0) {
        decide(m, item.kind, 'Space', 0, why.join('; '));
      } else if (preset.space.mergeOpenPlan && spaceKind === 'open_plan_zone') {
        if (openPlanSeen.has(m.page)) decide(m, item.kind, 'Space', 0, 'merged into one open-plan space');
        else {
          openPlanSeen.add(m.page);
          decide(m, item.kind, 'Space', 1, '');
        }
      } else {
        decide(m, item.kind, 'Space', 1, '');
      }
      if (item.bedroom) decide(m, item.kind, 'Bedroom', 1, '');
      const wetKind = item.wetKind ?? WET_KIND_DEFAULT;
      if (wetKind !== 'none') {
        if (preset.toilet.wetKinds.includes(wetKind)) decide(m, item.kind, 'Toilet', 1, '');
        else decide(m, item.kind, 'Toilet', 0, `wet room ${wetKind} not counted as Toilet by preset ${preset.id}`);
      }
    }
  }
  return { preset: preset.id, counts, unconfirmed: awaitingReview.size, decisions };
}
