// Find walls: the wall runs on the current sheet, read off its CAD wall
// layers and named from its legend (engine/wall-runs.ts), proposed as
// flagged length markups for the person to confirm or delete. Labels like
// "Walls (proposed partition)" roll up into a trade template's Walls line.

import { state, emit, nextId, calibrationFor, type Markup } from './state';
import { getPageTextItems, getPageVector, getWallVector, hasDoc } from './viewer';
import { wordsFromTextItem } from '../engine/ocr';
import { wallRuns, readWallLegend, wallLabel, classesToPropose } from '../engine/wall-runs';
import { renderMarkups } from './render';
import { syncUpsertMarkup } from './session';
import { showHint } from './tools';

export async function findWalls(): Promise<void> {
  if (!hasDoc()) return;
  const page = state.pageNum;
  showHint('Reading the wall layers…');
  const walls = await getWallVector(page).catch(() => null);
  if (!walls) {
    showHint('This drawing has no CAD wall layers to read. Measure walls with the Length tool (L).');
    return;
  }
  const [items, all] = await Promise.all([getPageTextItems(page).catch(() => []), getPageVector(page).catch(() => null)]);
  const words = items.flatMap((it) => wordsFromTextItem(it.str ?? '', it.transform, it.width, it.height));
  const classes = wallRuns(walls, all ? readWallLegend(words, all) : []);
  const chosen = classesToPropose(classes);
  if (!chosen.length) {
    showHint("This sheet's wall layers hold no filled wall pieces (its walls are drawn as outlines). Measure walls with the Length tool (L).");
    return;
  }
  const cal = calibrationFor(page);
  let runs = 0;
  for (const c of chosen) {
    for (const piece of c.pieces) {
      const m: Markup = { id: nextId('mk'), page, type: 'length', label: wallLabel(c), points: piece.points, createdAt: Date.now(), status: 'check' };
      state.markups.push(m);
      syncUpsertMarkup(m);
      runs++;
    }
  }
  renderMarkups();
  emit();
  const parts = chosen.map((c) => `${c.name.toLowerCase()} ${cal ? `${(c.lengthPt * cal.metersPerPt).toFixed(1)} m` : `${c.pieces.length} runs`}`);
  showHint(`Proposed ${runs} wall runs from the drawing (${parts.join(', ')}). Check each one and delete any out of scope.`);
}
