// Room-label dictionary: printed room names in several languages, with the
// abbreviations drafters actually use, mapped to a handful of room classes,
// plus the counting rules that schedules and benchmarks apply to them
// (AECV-Bench 1.5 / 1.6: "Lavatory" is not a toilet, "Bath" is). Pure data
// and string matching; hosts supply the words (PDF text layer or OCR).
//
// Matching is on whole tokens after normalisation (upper case, accents
// stripped, punctuation dropped, digits split off), so "W.C.", "wc" and
// "WC 2" all read as the toilet token WC, "Chambre 1" and "CH1" as a
// bedroom, and a token never matches inside a longer word ("S" does not
// fire on "STORE").

import type { OcrWord } from './ocr.ts';
import type { Pt } from './types.ts';

export type RoomClass = 'bedroom' | 'toilet' | 'kitchen' | 'living' | 'hall' | 'closet' | 'other';

export const ROOM_CLASSES: readonly RoomClass[] = ['bedroom', 'toilet', 'kitchen', 'living', 'hall', 'closet', 'other'];

/** Which class wins when one label names several ("HALL BATH" is a bathroom). */
const PRECEDENCE: readonly RoomClass[] = ['toilet', 'bedroom', 'kitchen', 'closet', 'living', 'hall', 'other'];

/**
 * Printed labels per language and class, comma separated. Case, accents and
 * punctuation do not matter (see normalizeLabel). 'other' lists rooms that
 * are recognised as rooms (so a space count can use them) but belong to no
 * counted class.
 */
export const ROOM_LABEL_TABLE: readonly [lang: string, cls: RoomClass, labels: string][] = [
  // English
  ['en', 'bedroom', 'bedroom, bed room, bed, bedrm, bdrm, bdr, br, master bedroom, master bed, m bed, m bedroom, mbr, guest bedroom, kids bedroom, nursery, bunk room'],
  ['en', 'toilet', 'wc, w c, toilet, toilets, bath, bathroom, bathrm, bthrm, bth, ensuite, en suite, shower, shower room, shr, powder, powder room, pwdr, half bath, full bath, master bath, wash room, washroom, restroom, cloakroom'],
  ['en', 'kitchen', 'kitchen, kit, kitchenette, kitch, cooking'],
  ['en', 'living', 'living, living room, lounge, family, family room, great room, dining, dining room, din, sitting room, drawing room, lounge room, rumpus, rumpus room, games room, media room, living dining, open plan living'],
  ['en', 'hall', 'hall, hallway, entry, entrance, entrance hall, foyer, vestibule, corridor, lobby, landing, passage, airlock'],
  ['en', 'closet', 'closet, clo, wic, walk in closet, walk in robe, wardrobe, robe, wir, storage, stor, store, store room, linen, linen closet, pantry, coats, coat closet, utility closet, cupboard'],
  ['en', 'other', 'garage, carport, laundry, ldry, lndry, utility, utility room, porch, deck, patio, balcony, terrace, office, study, den, library, mech, mechanical, plant, plant room, boiler, basement, cellar, attic, loft, stairs, stair, stairwell, lift, elevator, void, sunroom, conservatory, garden, mud room, mudroom, workshop, gym, sauna, veranda, verandah, lavatory, lav'],
  // French
  ['fr', 'bedroom', 'chambre, ch, chb, chbre, chambre a coucher, chambre parentale, suite parentale, chambre enfant'],
  ['fr', 'toilet', 'wc, toilette, toilettes, toil, sdb, salle de bain, salle de bains, sde, salle d eau, bain, bains, douche, sanitaires, cabinet de toilette, wc douche'],
  ['fr', 'kitchen', 'cuisine, cuis, kitchenette, cuisine ouverte, coin cuisine'],
  ['fr', 'living', 'sejour, salon, salle a manger, sam, salon sejour, sejour cuisine, piece de vie, salle de sejour'],
  ['fr', 'hall', 'entree, hall d entree, degagement, degt, dgt, couloir, palier, sas, vestibule'],
  ['fr', 'closet', 'placard, pl, plcd, rangement, rgt, dressing, cellier, debarras, lingerie, reserve'],
  ['fr', 'other', 'garage, buanderie, bureau, terrasse, balcon, loggia, veranda, cave, grenier, combles, local technique, chaufferie, escalier, jardin, abri, atelier, vide, patio, cour'],
  // Finnish
  ['fi', 'bedroom', 'mh, makuuhuone, makuuh, makuuhuone 1, mh1, lastenhuone, lh, vierashuone'],
  ['fi', 'toilet', 'wc, kph, kylpyhuone, kylpyh, ph, pesuhuone, pesuh, suihku, kph wc, wc kph, wc ph, erillinen wc'],
  ['fi', 'kitchen', 'k, kt, keittio, keittotila, keittokomero, kk, tupakeittio'],
  ['fi', 'living', 'oh, olohuone, oloh, tupa, ruokailu, ruokailutila, olohuone keittio, oh k, oh kt, takkahuone'],
  ['fi', 'hall', 'et, eteinen, aula, tk, tuulikaappi, kaytava, halli, eteishalli, porras, porrashuone'],
  ['fi', 'closet', 'vh, vaatehuone, var, varasto, vaatehuone 1, komero, kom, siivouskomero'],
  ['fi', 'other', 'huone, huon, s, sauna, khh, kodinhoitohuone, kodinhoitoh, tekn, tekninen tila, tekninen, kuisti, terassi, parveke, autotalli, autokatos, tyohuone, kirjasto, pukuhuone, ph sauna, lasitettu parveke, ulkovarasto, katos, lampokeskus, pannuhuone, kellari, vintti, portaat, harrastetila, askartelu'],
  // German
  ['de', 'bedroom', 'schlafzimmer, schlafen, schlafraum, sz, kind, kinderzimmer, kinder, zimmer, elternschlafzimmer, eltern, gastezimmer, gast, jugendzimmer'],
  ['de', 'toilet', 'wc, bad, badezimmer, baden, dusche, dusch wc, gaste wc, gaste bad, bad wc, toilette, wasch, waschraum, nasszelle'],
  ['de', 'kitchen', 'kuche, kochen, kochnische, koch, kuche essen'],
  ['de', 'living', 'wohnen, wohnzimmer, wohnraum, essen, esszimmer, essbereich, wohnen essen, wohn essbereich, wohnkuche'],
  ['de', 'hall', 'flur, diele, eingang, windfang, vorraum, gang, treppenhaus, halle, foyer, korridor'],
  ['de', 'closet', 'abstellraum, abstellkammer, abst, schrank, schrankraum, ankleide, ankleidezimmer, garderobe, speisekammer, vorrat, vorratsraum, kammer'],
  ['de', 'other', 'garage, carport, hwr, hauswirtschaftsraum, hausarbeitsraum, waschkuche, buro, arbeiten, arbeitszimmer, terrasse, balkon, loggia, keller, dachboden, speicher, technik, technikraum, heizung, heizraum, treppe, garten, hobby, hobbyraum, sauna, wintergarten, lager'],
  // Italian
  ['it', 'bedroom', 'camera, camera da letto, letto, cameretta, camera matrimoniale, camera singola, camera doppia, stanza da letto, cam'],
  ['it', 'toilet', 'wc, bagno, bagni, doccia, servizi, servizio, antibagno, lavabo, toilette'],
  ['it', 'kitchen', 'cucina, angolo cottura, cottura, cucinino, cuc'],
  ['it', 'living', 'soggiorno, salotto, sala, pranzo, sala da pranzo, soggiorno pranzo, living, salone, zona giorno, sogg'],
  ['it', 'hall', 'ingresso, corridoio, disimpegno, dis, atrio, anticamera, hall, vano scala, pianerottolo'],
  ['it', 'closet', 'ripostiglio, rip, armadio, cabina armadio, guardaroba, sgabuzzino, dispensa, deposito'],
  ['it', 'other', 'garage, box auto, lavanderia, studio, terrazza, terrazzo, balcone, loggia, cantina, soffitta, locale tecnico, centrale termica, scala, giardino, portico, veranda, autorimessa, taverna, magazzino'],
  // Spanish
  ['es', 'bedroom', 'dormitorio, dorm, habitacion, hab, recamara, alcoba, cuarto, dormitorio principal, dormitorio 1, pieza, dormitorios'],
  ['es', 'toilet', 'wc, bano, aseo, ducha, cuarto de bano, bano principal, sanitario, servicio, lavabo, toilet, inodoro'],
  ['es', 'kitchen', 'cocina, coc, cocina comedor'],
  ['es', 'living', 'salon, sala, estar, comedor, sala de estar, salon comedor, estar comedor, living, salon estar'],
  ['es', 'hall', 'vestibulo, recibidor, pasillo, distribuidor, entrada, hall, zaguan, corredor, escalera'],
  ['es', 'closet', 'armario, vestidor, trastero, despensa, ropero, closet, placard, almacen'],
  ['es', 'other', 'garaje, cochera, lavadero, lavanderia, terraza, balcon, patio, porche, despacho, estudio, sotano, bodega, desvan, cuarto de instalaciones, instalaciones, caldera, jardin, galeria, tendedero, azotea, altillo'],
  // Swedish
  ['sv', 'bedroom', 'sovrum, sov, sovr, sovrum 1, barnrum, gastrum, foraldrasovrum'],
  ['sv', 'toilet', 'wc, bad, badrum, dusch, dusch wc, toalett, wc dusch, bad wc, tvattrum'],
  ['sv', 'kitchen', 'kok, k, kokvra, pentry, kok matplats'],
  ['sv', 'living', 'vardagsrum, vardagsr, vrum, allrum, matplats, matrum, matsal, sallskapsrum, vardagsrum kok'],
  ['sv', 'hall', 'hall, entre, entrehall, passage, farstu, kapprum, trapphall, korridor, trapp'],
  ['sv', 'closet', 'kladkammare, klk, forrad, frd, garderob, grd, skafferi, stadskrubb, stad, linneskap'],
  ['sv', 'other', 'garage, carport, tvatt, tvattstuga, kontor, arbetsrum, altan, balkong, terrass, uterum, kallare, vind, teknik, teknikrum, pannrum, trappa, tradgard, bastu, hobbyrum, groventre, forrad kallare'],
];

/**
 * Counting rules that override the plain dictionary, with their source.
 * These are the rules AECV-Bench 1.5 / 1.6 states for its bedroom and
 * toilet fields; "Lavatory" is excluded although it is a washroom word,
 * while every bath / shower / WC label counts as one toilet unit.
 */
export const ROOM_LABEL_RULES: readonly { label: string; cls: RoomClass; rule: string }[] = [
  { label: 'lavatory', cls: 'other', rule: 'AECV-Bench 1.6: Lavatory is not counted as a toilet' },
  { label: 'lav', cls: 'other', rule: 'AECV-Bench 1.6: Lavatory is not counted as a toilet' },
  { label: 'bath', cls: 'toilet', rule: 'AECV-Bench 1.6: Bath counts as a toilet unit' },
  { label: 'bain', cls: 'toilet', rule: 'AECV-Bench 1.6: Bain counts as a toilet unit' },
  { label: 'douche', cls: 'toilet', rule: 'AECV-Bench 1.6: Douche counts as a toilet unit' },
  { label: 'shower', cls: 'toilet', rule: 'AECV-Bench 1.6: Shower counts as a toilet unit' },
  { label: 'sdb', cls: 'toilet', rule: 'AECV-Bench 1.6: SDB counts as a toilet unit' },
  { label: 'zimmer', cls: 'bedroom', rule: 'AECV-Bench 1.5: Zimmer counts as a bedroom' },
  { label: 'camera', cls: 'bedroom', rule: 'AECV-Bench 1.5: Camera counts as a bedroom' },
];

/**
 * Tokens the recogniser produces for a label it cannot read as printed,
 * applied after normalisation. Kept short and specific: a wrong alias
 * invents rooms.
 */
export const OCR_ALIASES: readonly { read: RegExp; term: string; note: string }[] = [
  { read: /^W{1,2}E$/, term: 'WC', note: 'tesseract LSTM reads a printed W.C. as lower-case "we" (sometimes "Wwe")' },
  { read: /^WC{2,3}$/, term: 'WC', note: 'the C of W.C. read twice ("w.Cc")' },
];
const alias = (token: string): string => OCR_ALIASES.find((a) => a.read.test(token))?.term ?? token;

/**
 * Character confusions the LSTM recogniser makes on small, blurred print,
 * as pairs that read for each other (both directions are tried). A short
 * token (two to four letters) one such substitution away from a dictionary
 * term is taken as that term, but only with a confidence penalty and
 * corroboration (fuzzyRoomTerm, countRoomsByClass): the table is for the
 * 8 to 12 px labels of scanned plans, not a licence to invent rooms.
 */
export const OCR_CONFUSIONS: readonly { pair: readonly [string, string]; note: string }[] = [
  { pair: ['M', 'H'], note: 'the middle strokes of a 10 px M blur away ("MH" reads "HH", "MM")' },
  { pair: ['I', 'L'], note: 'the foot of an L is lost, or a serif I grows one' },
  { pair: ['O', '0'], note: 'letter O and zero' },
  { pair: ['C', 'G'], note: 'the bar of a G' },
  { pair: ['W', 'VV'], note: 'a W read as two Vs' },
  { pair: ['N', 'M'], note: 'a blurred N gains a stroke ("HUON" reads "HUOM")' },
  { pair: ['', '.'], note: 'period loss or gain ("W.C" and "WC"); normalizeLabel drops dots, so this entry documents the rule and the matcher skips it' },
];

/** Confidence taken off a label that only reads through OCR_CONFUSIONS or a mixed-case read, by letter count (two letters, or three to four). */
export const CONFUSION_PENALTY = { short: 30, long: 20 } as const;
/** Below this confidence a confusion-rule read is noise even when corroborated. */
const FUZZY_MIN_CONF = 50;

export interface FuzzyRoomMatch {
  cls: RoomClass;
  /** the dictionary term the token was taken for, normalised */
  term: string;
  /** the token as read */
  read: string;
  /** which rule bridged the gap: "H>M" (read H for printed M), or "case" for a mixed-case read of a term */
  via: string;
  /** confidence points to deduct (CONFUSION_PENALTY) */
  penalty: number;
}

/**
 * "Mh", "wC": a two-letter token read in mixed case; abbreviations are
 * printed in capitals, so the recogniser was unsure of one glyph. Longer
 * tokens are left to the strict match ("TolL" for a printed TOIL is an
 * I/L slip, which fuzzyRoomTerm handles after upper-casing).
 */
const MIXED_CASE_SHORT = /^(?:[A-ZÀ-Þ][a-zà-ÿ]|[a-zà-ÿ][A-ZÀ-Þ])$/;

/**
 * A short token (two to four letters or digits, one word) that is not in
 * the dictionary as read but is one OCR_CONFUSIONS substitution away from
 * a term, or is a term read in mixed case ("Mh"). Returns the term with its
 * penalty, or null: when no rule bridges the gap, when the token is longer
 * than four characters, or when candidate terms disagree on the class.
 * Strict matches (classifyRoomLabel) are not reported here.
 */
export function fuzzyRoomTerm(token: string): FuzzyRoomMatch | null {
  const raw = token.trim();
  if (/\s/.test(raw)) return null;
  const base = normalizeLabel(raw).replace(/ /g, '');
  if (base.length < 2 || base.length > 4 || !/[A-Z]/.test(base)) return null;
  const penalty = base.length <= 2 ? CONFUSION_PENALTY.short : CONFUSION_PENALTY.long;
  const strict = TERMS.get(normalizeLabel(base));
  if (strict) return MIXED_CASE_SHORT.test(raw) ? { cls: strict, term: normalizeLabel(base), read: raw, via: 'case', penalty } : null;
  const found: FuzzyRoomMatch[] = [];
  for (const { pair } of OCR_CONFUSIONS) {
    if (!pair[0] || !pair[1]) continue;
    for (const [from, to] of [pair, [pair[1], pair[0]]] as const) {
      for (let i = 0; i <= base.length - from.length; i++) {
        if (!base.startsWith(from, i)) continue;
        const term = normalizeLabel(base.slice(0, i) + to + base.slice(i + from.length));
        const cls = TERMS.get(term);
        if (cls && !found.some((f) => f.term === term)) found.push({ cls, term, read: raw, via: `${from}>${to}`, penalty });
      }
    }
  }
  if (!found.length) return null;
  return found.every((f) => f.cls === found[0].cls) ? found[0] : null;
}

/** Replacements NFD decomposition does not cover. */
const LIGATURES: Record<string, string> = { Ø: 'O', Æ: 'AE', ß: 'SS', Œ: 'OE', Ð: 'D', Þ: 'TH', Ł: 'L' };

/**
 * Canonical form for matching: upper case, accents stripped, dots removed
 * ("W.C." stays one token), other punctuation to spaces, digits split from
 * letters ("CH1" reads "CH 1"), single spaces.
 */
export function normalizeLabel(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[ØÆßŒÐÞŁ]/g, (c) => LIGATURES[c] ?? c)
    .replace(/\./g, '')
    .replace(/([A-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Z])/g, '$1 $2')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/** Longest term in the dictionary, in tokens. */
let maxTermTokens = 1;
const TERMS: Map<string, RoomClass> = (() => {
  const map = new Map<string, RoomClass>();
  const add = (label: string, cls: RoomClass) => {
    const n = normalizeLabel(label);
    if (!n) return;
    map.set(n, cls);
    maxTermTokens = Math.max(maxTermTokens, n.split(' ').length);
  };
  for (const [, cls, labels] of ROOM_LABEL_TABLE) for (const label of labels.split(',')) add(label, cls);
  for (const r of ROOM_LABEL_RULES) add(r.label, r.cls); // rules win over the table
  return map;
})();

/** Dictionary terms as normalised text to class (read-only view, for tests and docs). */
export function roomLabelTerms(): ReadonlyMap<string, RoomClass> {
  return TERMS;
}

export interface RoomLabelMatch {
  cls: RoomClass;
  /** the dictionary term that fired, normalised */
  term: string;
}

/**
 * Every dictionary term in a (normalised) label, leftmost first, longest
 * term first at each position, non-overlapping. Numeric tokens are skipped
 * ("BEDROOM 2" fires once).
 */
export function matchRoomLabel(text: string): RoomLabelMatch[] {
  // a short token read in mixed case ("Mh") is an unsure read: fuzzyRoomTerm's business, not a strict match
  const sure = text
    .split(/\s+/)
    .map((t) => (MIXED_CASE_SHORT.test(t) ? '' : t))
    .join(' ');
  const tokens = normalizeLabel(sure)
    .split(' ')
    .filter(Boolean)
    .map(alias);
  const out: RoomLabelMatch[] = [];
  for (let i = 0; i < tokens.length; ) {
    if (/^\d+$/.test(tokens[i])) {
      i++;
      continue;
    }
    let hit: RoomLabelMatch | null = null;
    let used = 1;
    for (let n = Math.min(maxTermTokens, tokens.length - i); n >= 1; n--) {
      const term = tokens.slice(i, i + n).join(' ');
      const cls = TERMS.get(term);
      if (cls) {
        hit = { cls, term };
        used = n;
        break;
      }
    }
    if (hit) out.push(hit);
    i += used;
  }
  return out;
}

/**
 * The room class a printed label names, or null when it is not a room word
 * ("1200", "SCALE", "DN"). A label naming two classes resolves by
 * PRECEDENCE: "HALL BATH" is a bathroom, "BEDROOM CLOSET" a bedroom.
 */
export function classifyRoomLabel(word: string): RoomClass | null {
  const matches = matchRoomLabel(word);
  if (matches.length === 0) return null;
  for (const cls of PRECEDENCE) if (matches.some((m) => m.cls === cls)) return cls;
  return matches[0].cls;
}

export interface RoomLabelHit {
  /** the label as printed (joined words) */
  text: string;
  cls: RoomClass;
  xPt: number;
  yPt: number;
  conf: number;
  /** set when the label only reads through OCR_CONFUSIONS: the term taken and the rule ("HH as MH via H>M") */
  fuzzy?: string;
}

export interface RoomCount {
  counts: Record<RoomClass, number>;
  labels: RoomLabelHit[];
  /** words considered after the confidence filter */
  wordsUsed: number;
}

export interface CountRoomsOptions {
  /** recogniser confidence below which a three- or four-letter word is ignored (default 60) */
  minConf?: number;
  /** floor for words of five letters or more, which rarely match the dictionary by accident (default 45) */
  minConfLong?: number;
  /** stricter floor for two-letter words, which OCR noise produces freely (default 80; single letters need 90) */
  minConfShort?: number;
  /**
   * Whether a point (PDF pt) lies inside an enclosed room, when the host
   * can tell (a flood fill, a space polygon). A token that only reads as a
   * room through OCR_CONFUSIONS is accepted without its penalty when it sits
   * inside a room; otherwise an area figure stacked against it ("MH" over
   * "5.7") serves as the same corroboration.
   */
  isInsideRoom?: (pt: Pt) => boolean;
}

interface Line {
  words: OcrWord[];
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  h: number;
  text: string;
}

const lineOf = (words: OcrWord[]): Line => {
  const sorted = [...words].sort((a, b) => a.xPt - b.xPt);
  const h = Math.max(...sorted.map((w) => w.hPt));
  return {
    words: sorted,
    x0: Math.min(...sorted.map((w) => w.xPt - w.wPt / 2)),
    x1: Math.max(...sorted.map((w) => w.xPt + w.wPt / 2)),
    y0: Math.min(...sorted.map((w) => w.yPt - w.hPt / 2)),
    y1: Math.max(...sorted.map((w) => w.yPt + w.hPt / 2)),
    h,
    text: sorted.map((w) => w.text.trim()).join(' '),
  };
};

/**
 * Group words into printed lines: same baseline (centres within half a
 * text height) and a gap no wider than about one text height. Words are in
 * PDF points, so lines run left to right along +x.
 */
export function groupWordsIntoLines(words: OcrWord[]): OcrWord[][] {
  const sorted = [...words].sort((a, b) => b.yPt - a.yPt || a.xPt - b.xPt);
  const lines: { words: OcrWord[]; y: number; h: number; right: number }[] = [];
  for (const w of sorted) {
    let best: (typeof lines)[number] | null = null;
    let bestGap = Infinity;
    for (const ln of lines) {
      const h = Math.max(ln.h, w.hPt);
      if (Math.abs(w.yPt - ln.y) > 0.5 * h) continue;
      const gap = w.xPt - w.wPt / 2 - ln.right;
      if (gap < -0.5 * h || gap > 1.2 * h) continue;
      if (gap < bestGap) {
        bestGap = gap;
        best = ln;
      }
    }
    if (best) {
      best.words.push(w);
      best.right = Math.max(best.right, w.xPt + w.wPt / 2);
      best.h = Math.max(best.h, w.hPt);
      best.y = (best.y * (best.words.length - 1) + w.yPt) / best.words.length;
    } else {
      lines.push({ words: [w], y: w.yPt, h: w.hPt, right: w.xPt + w.wPt / 2 });
    }
  }
  return lines.map((ln) => ln.words);
}

/** An area figure as printed under a room label: "5.7", "12,5 m2", "10.2m?" (the recogniser's m squared), or its unit alone. */
const AREA_FIGURE = /^(\d{1,3}([.,]\d{1,2})?\s*(m[2²?*]?)?|m[2²?*])$/i;

const stacked = (upper: Line, lower: Line): boolean => {
  const overlap = Math.min(upper.x1, lower.x1) - Math.max(upper.x0, lower.x0);
  if (overlap <= 0) return false;
  const gap = upper.y0 - lower.y1;
  const h = Math.max(upper.h, lower.h);
  return gap > -0.5 * h && gap < 0.8 * h;
};

/**
 * Count rooms by class from positioned words. Adjacent words are grouped
 * into lines; a line that names no room on its own is merged with the line
 * stacked directly above or below it so split labels ("SALLE DE" / "BAIN",
 * "WALK IN" / "CLOSET") still read, while two complete labels stacked in
 * neighbouring rooms ("WC" over "BATH") stay two labels, as the benchmark
 * rules count them. Each label counts once, whatever its class, even when
 * the label names its class twice ("BATH SHOWER" on one line is one unit).
 */
export function countRoomsByClass(words: OcrWord[], opts: CountRoomsOptions = {}): RoomCount {
  const minConf = opts.minConf ?? 60;
  const minConfLong = opts.minConfLong ?? 45;
  const minConfShort = opts.minConfShort ?? 80;
  const floorFor = (letters: number) => (letters === 1 ? Math.max(minConfShort, 90) : letters === 2 ? minConfShort : letters <= 4 ? minConf : minConfLong);
  const usable = words.filter((w) => {
    const t = w.text.trim();
    if (!/[A-Za-zÀ-ÿ]/.test(t)) return false;
    const letters = t.replace(/[^A-Za-zÀ-ÿ]/g, '').length;
    // a known misread of a printed label ("we" for W.C.) is judged like a longer word
    const token = normalizeLabel(t);
    if (w.conf >= (alias(token) !== token ? minConf : floorFor(letters))) return true;
    // a confusion-rule candidate may come in under the floor; the corroboration below decides
    return letters >= 2 && letters <= 4 && w.conf >= FUZZY_MIN_CONF && fuzzyRoomTerm(t) !== null;
  });
  const lines = groupWordsIntoLines(usable).map(lineOf);
  // area figures printed under labels, for corroborating a confusion-rule read
  const figures = groupWordsIntoLines(words.filter((w) => w.conf >= 50 && AREA_FIGURE.test(w.text.trim()))).map(lineOf);
  const classified = lines.map((ln) => classifyRoomLabel(ln.text));
  const consumed = new Set<number>();
  const labels: RoomLabelHit[] = [];
  const emit = (ls: Line[], cls: RoomClass, fuzzy?: string) => {
    const all = ls.flatMap((l) => l.words);
    labels.push({
      text: ls.map((l) => l.text).join(' '),
      cls,
      xPt: all.reduce((s, w) => s + w.xPt, 0) / all.length,
      yPt: all.reduce((s, w) => s + w.yPt, 0) / all.length,
      conf: Math.round(all.reduce((s, w) => s + w.conf, 0) / all.length),
      ...(fuzzy ? { fuzzy } : {}),
    });
  };
  // complete labels first
  lines.forEach((ln, i) => {
    const cls = classified[i];
    if (!cls) return;
    consumed.add(i);
    emit([ln], cls);
  });
  // confusion-rule reads: a lone short token one known OCR slip away from a
  // term never counts on its own; it counts when corroborated (inside a room
  // per the host, or an area figure stacked against it), and then carries
  // the penalty in its confidence
  lines.forEach((ln, i) => {
    if (consumed.has(i) || ln.words.length !== 1) return;
    const fz = fuzzyRoomTerm(ln.text);
    if (!fz) return;
    const conf = ln.words[0].conf;
    const corroborated = opts.isInsideRoom?.({ x: ln.words[0].xPt, y: ln.words[0].yPt }) === true || figures.some((f) => stacked(ln, f) || stacked(f, ln));
    if (!corroborated || conf < FUZZY_MIN_CONF) return;
    consumed.add(i);
    emit([{ ...ln, words: [{ ...ln.words[0], conf: Math.max(0, conf - fz.penalty) }] }], fz.cls, `${fz.read} as ${fz.term} via ${fz.via}`);
  });
  // fragments: join with an unclassified or classified neighbour stacked against them
  lines.forEach((ln, i) => {
    if (consumed.has(i)) return;
    let partner = -1;
    let partnerGap = Infinity;
    lines.forEach((other, j) => {
      if (j === i) return;
      const [upper, lower] = other.y0 >= ln.y0 ? [other, ln] : [ln, other];
      if (!stacked(upper, lower)) return;
      const gap = Math.abs(upper.y0 - lower.y1);
      if (gap < partnerGap) {
        partnerGap = gap;
        partner = j;
      }
    });
    if (partner < 0) return;
    const other = lines[partner];
    const [upper, lower] = other.y0 >= ln.y0 ? [other, ln] : [ln, other];
    const cls = classifyRoomLabel(`${upper.text} ${lower.text}`);
    if (!cls) return;
    if (consumed.has(partner)) {
      // the neighbour already counted on its own ("MASTER" above "BEDROOM"): the fragment adds nothing
      consumed.add(i);
      return;
    }
    consumed.add(i);
    consumed.add(partner);
    emit([upper, lower], cls);
  });
  const counts = Object.fromEntries(ROOM_CLASSES.map((c) => [c, 0])) as Record<RoomClass, number>;
  for (const l of labels) counts[l.cls]++;
  labels.sort((a, b) => b.yPt - a.yPt || a.xPt - b.xPt);
  return { counts, labels, wordsUsed: usable.length };
}
