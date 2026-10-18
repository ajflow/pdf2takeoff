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
  ['fi', 'other', 's, sauna, khh, kodinhoitohuone, kodinhoitoh, tekn, tekninen tila, tekninen, kuisti, terassi, parveke, autotalli, autokatos, tyohuone, kirjasto, pukuhuone, ph sauna, lasitettu parveke, ulkovarasto, katos, lampokeskus, pannuhuone, kellari, vintti, portaat, harrastetila, askartelu'],
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
  const tokens = normalizeLabel(text)
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
  const usable = words.filter((w) => {
    const t = w.text.trim();
    if (!/[A-Za-zÀ-ÿ]/.test(t)) return false;
    const letters = t.replace(/[^A-Za-zÀ-ÿ]/g, '').length;
    const floor = letters === 1 ? Math.max(minConfShort, 90) : letters === 2 ? minConfShort : letters <= 4 ? minConf : minConfLong;
    return w.conf >= floor;
  });
  const lines = groupWordsIntoLines(usable).map(lineOf);
  const classified = lines.map((ln) => classifyRoomLabel(ln.text));
  const consumed = new Set<number>();
  const labels: RoomLabelHit[] = [];
  const emit = (ls: Line[], cls: RoomClass) => {
    const all = ls.flatMap((l) => l.words);
    labels.push({
      text: ls.map((l) => l.text).join(' '),
      cls,
      xPt: all.reduce((s, w) => s + w.xPt, 0) / all.length,
      yPt: all.reduce((s, w) => s + w.yPt, 0) / all.length,
      conf: Math.round(all.reduce((s, w) => s + w.conf, 0) / all.length),
    });
  };
  // complete labels first
  lines.forEach((ln, i) => {
    const cls = classified[i];
    if (!cls) return;
    consumed.add(i);
    emit([ln], cls);
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
