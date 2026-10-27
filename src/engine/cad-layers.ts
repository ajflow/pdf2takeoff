// CAD layers (PDF optional-content groups) by what they hold. Architectural
// exports keep the architect's layers ("800 A Furniture|Loose",
// "220 A Wall_Internal", "C0259_XR_Ground|I-FURN"). Magic Fill floods the
// floor between the walls, so loose furniture, finish hatching, annotation
// and services drawn over the floor stop it short of the walls. Those layers
// are left out of the fill's own render; walls, doors, glazing and anything
// unrecognised always stay, so a fill can only lose clutter, never a wall.

export type LayerRole = 'structure' | 'furniture' | 'finish' | 'annotation' | 'services' | 'overhead' | 'other';

const STRUCTURE = /wall|partition|(?<![a-z])doors?(?![a-z])|win(?:dow)|glaz|column|struct|stair|rail|balustrade|core|lift|shaft|opening|frame|cladding|facade|roof|slab|beam|lintel/i;
// beams, bulkheads and structure above the cut plane: drawn dashed across rooms, never a floor boundary
const OVERHEAD = /above|overhead|over[\s_-]?head|bulkhead|soffit/i;
const FURNITURE = /furn|joinery|fixture|fitment|loose|\bff&?e\b|equip|appliance|sanitary|fitout|workstation|seating|desk|chair|bench/i;
const FINISH = /floor|finish|hatch|cover|tile|carpet|vinyl|timber|pattern|paving|\barea\b|zone|poche/i;
const ANNOTATION = /text|dim|anno|tag|label|marker|note|title|symbol|grid|level|leader|keynote|callout|revision|border|sheet|viewport|north|legend|section|elevation/i;
const SERVICES = /elec|light|power|data|comms|hydraul|plumb|mech|hvac|duct|fire|sprink|security|switch|\bgpo\b|\brcp\b|ceiling|services|drainage|sewer/i;

// US National CAD Standard layer codes ("A-WALL", "I-FURN", "Q-SPCQ"):
// discipline letter, then a four-letter major group
const NCS = /(?:^|[|_\s-])([A-Z])-([A-Z]{4})(?![A-Z])/;
const NCS_GROUP: Record<string, LayerRole> = {
  WALL: 'structure', DOOR: 'structure', GLAZ: 'structure', COLS: 'structure', STRS: 'structure', ROOF: 'structure',
  FURN: 'furniture', EQPM: 'furniture', FIXT: 'furniture', CASE: 'furniture', SPCQ: 'furniture', FLOR: 'finish', PATT: 'finish', HTCH: 'finish', FNSH: 'finish',
  ANNO: 'annotation', DIMS: 'annotation', IDEN: 'annotation', TEXT: 'annotation', NOTE: 'annotation', SYMB: 'annotation', TTLB: 'annotation', GRID: 'annotation',
  LITE: 'services', POWR: 'services', COMM: 'services', DUCT: 'services', PIPE: 'services', SPRN: 'services', CLNG: 'services',
};
/** Disciplines whose layers are services or equipment whatever the group: electrical, plumbing, mechanical, fire, telecoms, equipment. */
const NCS_DISCIPLINE: Record<string, LayerRole> = { E: 'services', P: 'services', M: 'services', F: 'services', T: 'services', Q: 'furniture' };

/** What a layer holds, judged from its name. Structure wins over everything, so "Wall finishes" stays. */
export function layerRole(name: string): LayerRole {
  const ncs = NCS.exec(name);
  if (ncs) {
    const byGroup = NCS_GROUP[ncs[2]];
    if (byGroup === 'structure') return 'structure';
    const byDiscipline = NCS_DISCIPLINE[ncs[1]];
    if (byGroup ?? byDiscipline) return (byGroup ?? byDiscipline)!;
  }
  if (OVERHEAD.test(name)) return 'overhead';
  if (STRUCTURE.test(name)) return 'structure';
  if (FURNITURE.test(name)) return 'furniture';
  if (FINISH.test(name)) return 'finish';
  if (SERVICES.test(name)) return 'services';
  if (ANNOTATION.test(name)) return 'annotation';
  return 'other';
}

/** Roles Magic Fill leaves out of its render. */
const HIDDEN_FOR_FILL = new Set<LayerRole>(['furniture', 'finish', 'annotation', 'services', 'overhead']);

/**
 * The layers to hide for a fill, from the PDF's groups (id and name).
 * Empty when the PDF has no recognisable clutter layers.
 */
export function layersToHideForFill(groups: Iterable<{ id: string; name: string | null }>): { id: string; name: string; role: LayerRole }[] {
  const out: { id: string; name: string; role: LayerRole }[] = [];
  for (const g of groups) {
    const name = g.name ?? '';
    const role = layerRole(name);
    if (HIDDEN_FOR_FILL.has(role)) out.push({ id: g.id, name, role });
  }
  return out;
}

/**
 * Text that is not a room name, for the merged-rooms test: finish and
 * material notes ("VINYL PLANK"), construction notes ("REFER TO DETAIL",
 * "EXISTING CEILING RETAINED") and anything longer than three words. Room
 * names are short: "OFFICE 1", "BOARDROOM", "STAFF ROOM".
 */
export const NOT_A_ROOM_NAME =
  /vinyl|tile|carpet|timber|plank|paint|epoxy|concrete|ceramic|porcelain|stone|laminate|finish|floor|ceiling|wall|refer|see |detail|new |existing|typ|confirm|retain|suppl|fixed|panel|access|note|^\S+(\s+\S+){3,}$/i;

/**
 * Whether a fill took in more than one labelled room. A fill without the
 * clutter layers can lose a door swing or jamb those layers carried and run
 * through a doorway; when it covers two room labels, the host fills again on
 * every layer instead.
 */
export function fillMergesRooms(points: { x: number; y: number }[], labels: { x: number; y: number }[]): boolean {
  let inside = 0;
  for (const l of labels) {
    let c = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i];
      const b = points[j];
      if (a.y > l.y !== b.y > l.y && l.x < ((b.x - a.x) * (l.y - a.y)) / (b.y - a.y) + a.x) c = !c;
    }
    if (c && ++inside > 1) return true;
  }
  return false;
}
