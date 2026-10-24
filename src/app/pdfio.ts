// Save markups back into the PDF as standard annotations (engine builds the
// bytes; this module just triggers the browser download), and read
// pdf2takeoff annotations back out when a file is reopened.

import { state, takeoffData } from './state';
import { getPageAnnotations } from './viewer';
import { buildAnnotatedPdf } from '../engine/annotate';
import { parseMarkups, type AnnotationLike } from '../engine/read';
import { syncUpsertMarkup } from './session';
import { fileStem } from './inputs';
import type { Markup } from '../engine/types';

export async function saveAnnotatedPdf(): Promise<void> {
  if (!state.fileBytes || state.markups.length === 0) return;
  const bytes = await buildAnnotatedPdf({ bytes: state.fileBytes, ...takeoffData() });
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileStem(state.fileName) + '-markups.pdf';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** Read pdf2takeoff-authored annotations from the open document into state. */
export async function importMarkups(): Promise<number> {
  const found: Markup[] = [];
  for (let p = 1; p <= state.pageCount; p++) {
    let annots: Awaited<ReturnType<typeof getPageAnnotations>> = [];
    try {
      annots = await getPageAnnotations(p);
    } catch {
      continue;
    }
    found.push(...parseMarkups(annots as unknown as AnnotationLike[], p, found.length));
  }
  if (found.length) {
    state.markups = found;
    for (const m of found) syncUpsertMarkup(m);
  }
  return found.length;
}
