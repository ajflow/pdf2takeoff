// Unit handling and scale maths. All internal lengths are metres; PDF lengths
// arrive in points (1 pt = 1/72 inch).

export type Unit = 'mm' | 'cm' | 'm' | 'in' | 'ft';
export type DisplayUnit = Unit | 'ft-in';

export const METERS_PER_PT = 0.0254 / 72;

const TO_M: Record<Unit, number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  in: 0.0254,
  ft: 0.3048,
};

export const DISPLAY_UNITS: DisplayUnit[] = ['m', 'cm', 'mm', 'ft', 'ft-in', 'in'];

export function unitLabel(u: DisplayUnit): string {
  return u === 'ft-in' ? 'ft-in' : u;
}

export function metersTo(m: number, u: DisplayUnit): number {
  if (u === 'ft-in') return m / TO_M.ft;
  return m / TO_M[u];
}

export function toMeters(v: number, u: Unit): number {
  return v * TO_M[u];
}

function decimalsFor(u: DisplayUnit): number {
  switch (u) {
    case 'mm':
      return 0;
    case 'in':
      return 2;
    case 'cm':
      return 1;
    default:
      return 2;
  }
}

export function formatLength(meters: number, u: DisplayUnit): string {
  if (u === 'ft-in') {
    const totalIn = meters / 0.0254;
    const sign = totalIn < 0 ? '-' : '';
    const absIn = Math.abs(totalIn);
    const ft = Math.floor(absIn / 12);
    const inch = absIn - ft * 12;
    const inchRounded = Math.round(inch * 16) / 16;
    if (inchRounded >= 12) return formatLength(meters + 0.0254 * (12 - inch), u);
    const inchStr =
      inchRounded === Math.trunc(inchRounded)
        ? `${inchRounded}"`
        : `${inchRounded.toFixed(1)}"`;
    return `${sign}${ft}'-${inchStr}`;
  }
  const v = metersTo(meters, u);
  return `${v.toFixed(decimalsFor(u))} ${u}`;
}

export function formatArea(sqMeters: number, u: DisplayUnit): string {
  const base: Unit = u === 'ft-in' ? 'ft' : u;
  const a = sqMeters / (TO_M[base] * TO_M[base]);
  const dec = base === 'mm' || base === 'in' ? 0 : 2;
  return `${a.toFixed(dec)} ${base}²`;
}

/** Parse a user-entered length like "6", "6.5", "6 6" (ft in) into the unit's value. */
export function parseLength(raw: string, u: Unit): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (u === 'ft') {
    // allow 6'6" style
    const m = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft)?\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in)?)?$/i);
    if (!m) return null;
    const ft = parseFloat(m[1]);
    const inch = m[2] ? parseFloat(m[2]) : 0;
    return ft + inch / 12;
  }
  const v = parseFloat(s.replace(',', '.'));
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Common drawing scales: label + real-world size of one paper metre (ratio). */
export const PRESET_SCALES: { label: string; ratio: number }[] = [
  { label: '1:50', ratio: 50 },
  { label: '1:100', ratio: 100 },
  { label: '1:200', ratio: 200 },
  { label: '1:500', ratio: 500 },
  { label: '1/8" = 1\'-0"', ratio: 96 },
  { label: '1/4" = 1\'-0"', ratio: 48 },
  { label: '1/16" = 1\'-0"', ratio: 192 },
  { label: '1" = 10\'', ratio: 120 },
  { label: '1" = 20\'', ratio: 240 },
  { label: '1" = 30\'', ratio: 360 },
];

export function metersPerPtForRatio(ratio: number): number {
  return METERS_PER_PT * ratio;
}

export function ratioForMetersPerPt(mpp: number): number {
  return mpp / METERS_PER_PT;
}
