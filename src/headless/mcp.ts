// The pdf2takeoff MCP server: an agent can open drawings, look at them
// (render_page), calibrate, measure, scan symbols, compare revisions and
// export quantities — entirely locally over stdio, nothing uploaded.
//
// Coordinate conventions (stated per tool as well):
//   • All tool coordinates are PDF points (1 pt = 1/72"), origin bottom-left,
//     y up — the space PDF annotations use.
//   • Raster images returned by render_page are top-left origin, y down.
//
// Never write to stdout here — stdio IS the protocol channel. Errors go to
// stderr via thrown Errors (the SDK turns them into tool error results).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { openPdf } from './pdfjs-node.ts';
import { openAny } from './image-node.ts';
import { renderRasterNode } from './raster-node.ts';
import { readMarkups, scanDocAt, scanDocAllPages, compareDocs, compareFolders, vectorDocPage, quantityDelta } from './ops.ts';
import { doorBridgesFor } from '../engine/fill-vector.ts';
import { statSync } from 'node:fs';
import { markupLength, markupArea, markupPerimeter, markupVolume, markupAngle, defaultLabel, nextId, distPt } from '../engine/geometry.ts';
import { buildMatrix, toDelimited, xlsxBytes } from '../engine/export.ts';
import { buildAnnotatedPdf } from '../engine/annotate.ts';
import { METERS_PER_PT, toMeters } from '../engine/units.ts';
import { findScaleRatio, roomLabelPoints, wordsFromTextItem, type TextLayerWord } from '../engine/ocr.ts';
import { dynamicFill } from '../engine/dynamicfill.ts';
import { RASTER_SCALE } from '../engine/ports.ts';
import { scaleVotesFromWords, scaleConsensus, checkAgainstSheet } from '../engine/scale.ts';
import { parseScaleSpec } from './spec.ts';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Calibration, Markup } from '../engine/types.ts';

interface OpenDoc {
  id: string;
  path: string;
  bytes: Uint8Array;
  doc: PDFDocumentProxy;
  calibrations: Map<number, Calibration>;
  markups: Markup[];
}

const docs = new Map<string, OpenDoc>();
let docSeq = 0;

function getDoc(id: string): OpenDoc {
  const d = docs.get(id);
  if (!d) throw new Error(`unknown document id "${id}" — call open_document first`);
  return d;
}

function text(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] };
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function markupRows(d: OpenDoc) {
  return d.markups.map((m) => {
    const cal = d.calibrations.get(m.page);
    const value =
      m.type === 'count'
        ? 1
        : m.type === 'angle'
          ? markupAngle(m)
          : cal
            ? m.type === 'length'
              ? markupLength(m, cal.metersPerPt)
              : m.type === 'perimeter'
                ? markupPerimeter(m, cal.metersPerPt)
                : m.type === 'volume'
                  ? markupVolume(m, cal.metersPerPt)
                  : markupArea(m, cal.metersPerPt)
            : null;
    return {
      id: m.id,
      type: m.type,
      label: m.label,
      page: m.page,
      status: m.status ?? null,
      value: value === null ? null : round(value, 4),
      unit:
        m.type === 'count'
          ? 'each'
          : m.type === 'angle'
            ? 'deg'
            : m.type === 'length' || m.type === 'perimeter'
              ? 'm'
              : m.type === 'volume'
                ? 'm3'
                : 'm2',
    };
  });
}

const ptTuple = z.tuple([z.number(), z.number()]);

export async function runMcpServer(): Promise<void> {
  const server = new McpServer({ name: 'pdf2takeoff', version: '0.1.0' });

  // provenance attached to every numeric result: where the number came from
  const scaleProvenance = (cal: Calibration | undefined) =>
    cal ? { ratio: round(cal.metersPerPt / METERS_PER_PT, 2), source: cal.source } : null;
  const bboxOf = (pts: { x: number; y: number }[]) =>
    pts.length
      ? [
          round(Math.min(...pts.map((p) => p.x))),
          round(Math.min(...pts.map((p) => p.y))),
          round(Math.max(...pts.map((p) => p.x))),
          round(Math.max(...pts.map((p) => p.y))),
        ]
      : null;

  server.registerTool(
    'open_document',
    {
      description:
        'Open a local PDF drawing for takeoff (a PNG or JPG scan works too: it opens as one page of width/3 x height/3 points, so render_page at scale 3 returns the native pixels). Returns a document id, page sizes in PDF points, and any pdf2takeoff markups already embedded in the file (they load back in). Coordinates everywhere are PDF points, origin bottom-left.',
      inputSchema: { path: z.string().describe('path to the PDF (or PNG/JPG) on this machine') },
    },
    async ({ path }) => {
      // images come back wrapped as PDF bytes so save_annotated still works
      const { doc, bytes } = await openAny(path);
      const id = `doc-${++docSeq}`;
      const markups = await readMarkups(doc);
      const pages: { page: number; widthPt: number; heightPt: number }[] = [];
      for (let p = 1; p <= doc.numPages; p++) {
        const vp = (await doc.getPage(p)).getViewport({ scale: 1 });
        pages.push({ page: p, widthPt: Math.round(vp.width), heightPt: Math.round(vp.height) });
      }
      docs.set(id, { id, path, bytes, doc, calibrations: new Map(), markups });
      return text({
        id,
        fileName: basename(path),
        pageCount: doc.numPages,
        pages,
        restoredMarkups: markups.length,
        next: 'render_page to see a sheet, then set_scale before measuring',
      });
    },
  );

  server.registerTool(
    'render_page',
    {
      description:
        "Render a sheet to a PNG so you can look at it. The image is top-left origin (y down); PDF points are bottom-left (y up). For unrotated pages: pdfX = px / scale, pdfY = heightPt - py / scale.",
      inputSchema: {
        id: z.string(),
        page: z.number().int().min(1).default(1),
        scale: z.number().min(0.5).max(4).default(2).describe('raster pixels per PDF point'),
      },
    },
    async ({ id, page, scale }) => {
      const d = getDoc(id);
      if (page > d.doc.numPages) throw new Error(`page ${page} out of range (1..${d.doc.numPages})`);
      const raster = await renderRasterNode(d.doc, page, scale);
      const vp = (await d.doc.getPage(page)).getViewport({ scale: 1 });
      const cnv = createCanvas(raster.width, raster.height);
      const ctx = cnv.getContext('2d');
      const img = ctx.createImageData(raster.width, raster.height);
      img.data.set(raster.data);
      ctx.putImageData(img, 0, 0);
      const png = cnv.toBuffer('image/png');
      return {
        content: [
          { type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' },
          {
            type: 'text' as const,
            text: JSON.stringify({
              page,
              widthPx: raster.width,
              heightPx: raster.height,
              widthPt: Math.round(vp.width),
              heightPt: Math.round(vp.height),
              scale,
              calibrated: d.calibrations.has(page),
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'read_text',
    {
      description:
        'Read the sheet\'s embedded text layer: words with positions in PDF points (bottom-left origin) and each word\'s baseline angle (angleDeg, 90 = vertical text reading bottom to top), optionally clipped to a region. This is the sanctioned way to obtain printed values — scales ("1:100"), dimension strings, labels, title-block fields. Never read numbers off the render_page PNG: transcribe them from this tool (or set_scale/measure) instead, they are exact. Returns few or no words on scanned sheets, which have no text layer.',
      inputSchema: {
        id: z.string(),
        page: z.number().int().min(1).default(1),
        region: z
          .object({
            x0: z.number().describe('left edge, PDF points'),
            y0: z.number().describe('bottom edge, PDF points'),
            x1: z.number().describe('right edge, PDF points'),
            y1: z.number().describe('top edge, PDF points'),
          })
          .optional()
          .describe('clip to this rectangle (e.g. a title block you located on the rendered page)'),
      },
    },
    async ({ id, page, region }) => {
      const d = getDoc(id);
      if (page > d.doc.numPages) throw new Error(`page ${page} out of range (1..${d.doc.numPages})`);
      const pdfPage = await d.doc.getPage(page);
      const tc = await pdfPage.getTextContent();
      // text items → whitespace-split words in PDF-point space. The text
      // layer is exact (born-digital), so confidence is 100 — the point of
      // this tool vs OCR-ing the render is that these numbers are trustworthy.
      const words: TextLayerWord[] = [];
      for (const item of tc.items as { str?: string; transform?: number[]; width?: number; height?: number }[]) {
        words.push(...wordsFromTextItem(typeof item.str === 'string' ? item.str : '', item.transform, item.width, item.height));
      }
      const clipped = region
        ? words.filter(
            (wd) =>
              wd.xPt >= Math.min(region.x0, region.x1) &&
              wd.xPt <= Math.max(region.x0, region.x1) &&
              wd.yPt >= Math.min(region.y0, region.y1) &&
              wd.yPt <= Math.max(region.y0, region.y1),
          )
        : words;
      const scaleHit = findScaleRatio(clipped, 'text layer');
      const { votes, nts } = scaleVotesFromWords(clipped, 'text layer');
      const consensus = scaleConsensus(votes, nts);
      return text({
        page,
        wordCount: clipped.length,
        ...(clipped.length > 200
          ? { note: 'long text layer — pass a region to clip; only the first 200 words are listed' }
          : {}),
        words: clipped.slice(0, 200),
        scaleRatio: scaleHit
          ? { ratio: scaleHit.ratio, source: scaleHit.source, hint: `set_scale with ratio "1:${scaleHit.ratio}"` }
          : null,
        // every scale note found and whether they agree; a conflict usually
        // means viewports at different scales (clip with region) or a misread
        scaleNotes: {
          status: consensus.status,
          nts: consensus.nts,
          notes: votes.map((v) => ({ ratio: round(v.ratio, 3), source: v.source, weight: v.weight, at: v.at })),
          rivals: consensus.rivals,
        },
      });
    },
  );

  server.registerTool(
    'set_scale',
    {
      description:
        'Calibrate the drawing scale — required before length/area values mean anything. Either pick a ratio ("1:100", or a preset like 1/4" = 1\'-0") or measure a known dimension: give both endpoints in PDF points and its true length.',
      inputSchema: {
        id: z.string(),
        page: z.number().int().min(1).default(1),
        all_pages: z.boolean().default(false).describe('apply this scale to every sheet in the set'),
        ratio: z.string().optional().describe('"1:100" or a preset label'),
        from_points: z
          .object({
            a: ptTuple.describe('first end of a known dimension, PDF points'),
            b: ptTuple.describe('other end of the dimension, PDF points'),
            length: z.number().positive().describe('true length of that dimension'),
            unit: z.enum(['mm', 'cm', 'm', 'in', 'ft']).default('m'),
          })
          .optional(),
      },
    },
    async ({ id, page, all_pages, ratio, from_points }) => {
      const d = getDoc(id);
      let metersPerPt: number;
      let source: string;
      if (ratio) {
        metersPerPt = parseScaleSpec(ratio);
        source = `mcp preset ${ratio}`;
      } else if (from_points) {
        const ptDist = distPt(
          { x: from_points.a[0], y: from_points.a[1] },
          { x: from_points.b[0], y: from_points.b[1] },
        );
        if (ptDist === 0) throw new Error('from_points: a and b are the same point');
        metersPerPt = toMeters(from_points.length, from_points.unit) / ptDist;
        source = `mcp measured ${from_points.length} ${from_points.unit}`;
      } else {
        throw new Error('pass either ratio or from_points');
      }
      const pages = all_pages ? Array.from({ length: d.doc.numPages }, (_, i) => i + 1) : [page];
      for (const p of pages) d.calibrations.set(p, { metersPerPt, source });
      // cross-check against the sheet's own scale notes (text layer)
      const tc = await (await d.doc.getPage(page)).getTextContent();
      const words = (tc.items as { str?: string; transform?: number[]; width?: number; height?: number }[]).flatMap((it) =>
        wordsFromTextItem(typeof it.str === 'string' ? it.str : '', it.transform, it.width, it.height),
      );
      const { votes, nts } = scaleVotesFromWords(words, 'text layer');
      const setRatio = metersPerPt / METERS_PER_PT;
      // measured scales carry hand-placement error, typed ratios do not
      const check = checkAgainstSheet(setRatio, votes, nts, from_points ? 0.05 : 0.02);
      return text({
        set: pages,
        metersPerPt: round(metersPerPt, 8),
        ratio: round(setRatio, 2),
        source,
        sheetCheck: {
          status: check.status,
          ...(check.sheetRatio !== undefined ? { sheetRatio: round(check.sheetRatio, 3) } : {}),
          sheetSays: votes.map((v) => ({ ratio: round(v.ratio, 3), source: v.source })),
          ...(check.status === 'disagrees'
            ? { warning: `the sheet's printed scale is 1:${round(check.sheetRatio ?? 0, 2)}${check.likely ? `: likely ${check.likely}` : ''}. Check before measuring` }
            : {}),
        },
      });
    },
  );

  server.registerTool(
    'fill_area',
    {
      description:
        'Measure a room by clicking inside it (Dynamic Fill): flood-fills the bounded region around the point, closing door gaps between wall ends, and records it as an area markup. Uses the page scale (set_scale first for a value) and room labels from the text layer to stop at doorways. Points are PDF points, bottom-left origin. Report the value from this result, never from the rendered image.',
      inputSchema: {
        id: z.string(),
        page: z.number().int().min(1).default(1),
        at: ptTuple.describe('a point inside the room, PDF points'),
        label: z.string().optional(),
      },
    },
    async ({ id, page, at, label }) => {
      const d = getDoc(id);
      if (page > d.doc.numPages) throw new Error(`page ${page} out of range (1..${d.doc.numPages})`);
      const raster = await renderRasterNode(d.doc, page, RASTER_SCALE);
      const items = (await (await d.doc.getPage(page)).getTextContent()).items as { str?: string; transform?: number[]; width?: number; height?: number }[];
      const labels = roomLabelPoints(items);
      const cal = d.calibrations.get(page);
      const bridges = doorBridgesFor(await vectorDocPage(d.doc, page), cal?.metersPerPt);
      const result = dynamicFill(raster, { x: at[0], y: at[1] }, undefined, { labels, bridges, ...(cal ? { metersPerPt: cal.metersPerPt } : {}) });
      if ('error' in result) throw new Error(result.error);
      const markup: Markup = {
        id: nextId('mcp'),
        page,
        type: 'area',
        label: label ?? 'Filled area',
        points: result.points,
        createdAt: Date.now(),
      };
      d.markups.push(markup);
      const gapPt = result.gapPx ? result.gapPx / RASTER_SCALE : 0;
      return text({
        markupId: markup.id,
        label: markup.label,
        value: cal ? round(markupArea(markup, cal.metersPerPt), 4) : null,
        unit: 'm2',
        calibrated: !!cal,
        vertices: result.points.length,
        provenance: {
          method: 'dynamic fill: flood fill from the point, gaps closed only between wall ends; boundary runs along the inner wall faces; gapClosed* present only when a closed gap formed part of this room\'s boundary',
          page,
          scale: scaleProvenance(cal),
          bbox: bboxOf(result.points),
          // only gaps that actually bound this room; absent for a sealed room
          ...(gapPt > 0 ? { gapClosedPt: round(gapPt, 1), ...(cal ? { gapClosedM: round(gapPt * cal.metersPerPt, 3) } : {}) } : {}),
          ...(result.bridged ? { vectorDoorBridgeUsed: true } : {}),
          roomLabelsOnSheet: labels.length,
          vectorDoorBridges: bridges.length,
        },
      });
    },
  );

  server.registerTool(
    'measure',
    {
      description:
        'Record a measurement on a sheet and get its real-world value (length/area/perimeter/volume need set_scale first; count and angle are scale-free). Points are PDF points, bottom-left origin. length: 2+ points (polyline run); area/perimeter/volume: 3+ points (polygon, volume also needs depth in metres); angle: exactly 3 points (vertex first); count: exactly 1 point. Every numeric value you report must come from this tool\'s result (or export/list_markups) — never from your own reading of the rendered image.',
      inputSchema: {
        id: z.string(),
        page: z.number().int().min(1).default(1),
        type: z.enum(['length', 'area', 'count', 'perimeter', 'volume', 'angle']),
        points: z.array(ptTuple).min(1),
        depth: z.number().positive().optional().describe('volume only: extrusion depth in metres'),
        label: z.string().optional(),
      },
    },
    async ({ id, page, type, points, depth, label }) => {
      const d = getDoc(id);
      if (type === 'count' && points.length !== 1) throw new Error('count takes exactly one point');
      if (type === 'length' && points.length < 2) throw new Error('length needs at least 2 points');
      if ((type === 'area' || type === 'perimeter' || type === 'volume') && points.length < 3) {
        throw new Error(`${type} needs at least 3 points`);
      }
      if (type === 'angle' && points.length !== 3) throw new Error('angle takes exactly 3 points (vertex first)');
      if (type === 'volume' && depth === undefined) throw new Error('volume requires depth (metres)');
      const markup: Markup = {
        id: nextId('mcp'),
        page,
        type,
        label: label ?? defaultLabel(type),
        points: points.map(([x, y]) => ({ x, y })),
        createdAt: Date.now(),
        ...(depth !== undefined ? { depth } : {}),
      };
      d.markups.push(markup);
      const cal = d.calibrations.get(page);
      const value =
        type === 'count'
          ? 1
          : type === 'angle'
            ? markupAngle(markup)
            : cal
              ? type === 'length'
                ? markupLength(markup, cal.metersPerPt)
                : type === 'perimeter'
                  ? markupPerimeter(markup, cal.metersPerPt)
                  : type === 'volume'
                    ? markupVolume(markup, cal.metersPerPt)
                    : markupArea(markup, cal.metersPerPt)
              : null;
      return text({
        markupId: markup.id,
        label: markup.label,
        value: value === null ? null : round(value, 4),
        unit: type === 'count' ? 'each' : type === 'angle' ? 'deg' : type === 'length' || type === 'perimeter' ? 'm' : type === 'volume' ? 'm3' : 'm2',
        calibrated: type === 'angle' || type === 'count' ? true : !!cal,
        provenance: {
          method: 'geometry of the points you gave',
          page,
          scale: type === 'angle' || type === 'count' ? null : scaleProvenance(cal),
          bbox: bboxOf(markup.points),
        },
      });
    },
  );

  server.registerTool(
    'scan_symbol',
    {
      description:
        'Click-to-teach auto-count: give one instance of a repeated symbol (its centre in PDF points) and the CV scan finds and counts every match on the sheet, adding each as a count markup. Look at render_page output first to pick a symbol.',
      inputSchema: {
        id: z.string(),
        page: z.number().int().min(1).default(1),
        at: ptTuple.describe('a point on the symbol to teach from, PDF points'),
        label: z.string().optional().describe('label for the count markups'),
        all_pages: z.boolean().default(false).describe('scan every sheet and return a per-page schedule (counts added per page)'),
      },
    },
    async ({ id, page, at, label, all_pages }) => {
      const d = getDoc(id);
      if (all_pages) {
        const schedule = await scanDocAllPages(d.doc, { x: at[0], y: at[1] });
        for (const p of schedule.pages) {
          if (p.count === 0) continue;
          const result = await scanDocAt(d.doc, p.page, { x: at[0], y: at[1] });
          if ('error' in result) continue;
          for (const hit of result.hits) {
            d.markups.push({
              id: nextId('mcp'),
              page: p.page,
              type: 'count',
              label: label ?? 'Scanned symbol',
              points: [{ x: hit.x, y: hit.y }],
              createdAt: Date.now(),
            });
          }
        }
        return text({ schedule, label: label ?? 'Scanned symbol' });
      }
      const result = await scanDocAt(d.doc, page, { x: at[0], y: at[1] });
      if ('error' in result) throw new Error(result.error);
      const fallback = label ?? 'Scanned symbol';
      for (const hit of result.hits) {
        d.markups.push({
          id: nextId('mcp'),
          page,
          type: 'count',
          label: hit.label ?? fallback,
          points: [{ x: hit.x, y: hit.y }],
          createdAt: Date.now(),
        });
      }
      return text({
        count: result.hits.length,
        provider: result.provider,
        label: result.hits[0]?.label ?? fallback,
        hits: result.hits.map((h) => ({ x: round(h.x), y: round(h.y) })),
        provenance: {
          method: result.provider === 'detector' ? 'trained symbol detector' : 'template match of the clicked symbol',
          page,
          bbox: bboxOf(result.hits),
          ...(result.note ? { note: result.note } : {}),
          ...('truncated' in result && result.truncated ? { truncated: true } : {}),
        },
      });
    },
  );

  server.registerTool(
    'compare_revisions',
    {
      description:
        'Compare two revisions: pass two PDF files for per-sheet change fractions and changed regions, or two folders to batch-compare a whole drawing set (sheets paired by filename, added/removed sheets listed). Red-family regions exist only in A (removed), blue-family only in B (added). Born-digital sheets also get an exact vector diff (added/removed regions, moved pieces) and a text-layer diff (printed values changed in place). With quantities: true, the pdf2takeoff markups saved in A are re-run on B (counts re-scanned, areas re-filled) and the deltas returned. Report changes from this result, never by eyeballing two renders.',
      inputSchema: {
        a: z.string().describe('path to the older revision (file or folder)'),
        b: z.string().describe('path to the newer revision (file or folder)'),
        quantities: z.boolean().default(false).describe('files only: re-run the takeoff saved in A on B and report quantity deltas'),
      },
    },
    async ({ a, b, quantities }) => {
      const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
      if (isDir(a) || isDir(b)) {
        if (!isDir(a) || !isDir(b)) throw new Error('folder comparison needs two folders');
        const result = await compareFolders(a, b);
        return text(result);
      }
      const docA = await openPdf(new Uint8Array(readFileSync(a)));
      const docB = await openPdf(new Uint8Array(readFileSync(b)));
      const result = await compareDocs(docA, docB);
      const delta = quantities ? await quantityDelta(docA, docB) : undefined;
      return text({ a: basename(a), b: basename(b), ...result, ...(delta ? { quantities: delta } : {}) });
    },
  );

  server.registerTool(
    'list_markups',
    {
      description: 'List every measurement in the document with values (metres / m² / each), or null when the sheet is not calibrated.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => text({ markups: markupRows(getDoc(id)) }),
  );

  server.registerTool(
    'set_status',
    {
      description:
        "Set a measurement's review status: 'check' (needs human verification), 'confirmed' (verified), or null to clear. The agent-proposes/human-verifies loop: mark your own takeoffs as 'check' and let the estimator confirm them.",
      inputSchema: {
        id: z.string(),
        markup_id: z.string(),
        status: z.enum(['check', 'confirmed']).nullable(),
      },
    },
    async ({ id, markup_id, status }) => {
      const d = getDoc(id);
      const m = d.markups.find((x) => x.id === markup_id);
      if (!m) throw new Error(`no markup with id "${markup_id}"`);
      if (status === null) delete m.status;
      else m.status = status;
      return text({ markupId: m.id, status: m.status ?? null });
    },
  );

  server.registerTool(
    'delete_markup',
    {
      description: 'Delete one measurement by its markup id (see list_markups).',
      inputSchema: { id: z.string(), markup_id: z.string() },
    },
    async ({ id, markup_id }) => {
      const d = getDoc(id);
      const before = d.markups.length;
      d.markups = d.markups.filter((m) => m.id !== markup_id);
      if (d.markups.length === before) throw new Error(`no markup with id "${markup_id}"`);
      return text({ deleted: markup_id, remaining: d.markups.length });
    },
  );

  server.registerTool(
    'export',
    {
      description:
        'Export the quantities table (items + group totals) to a file: csv, tsv or xlsx. The agent passes the output path; nothing is uploaded anywhere.',
      inputSchema: {
        id: z.string(),
        format: z.enum(['csv', 'tsv', 'xlsx']).default('csv'),
        path: z.string().describe('output file path'),
        columns: z
          .array(z.object({ name: z.string(), formula: z.string(), unit: z.string() }))
          .optional()
          .describe('computed columns, e.g. {"name":"Waste +10%","formula":"value * 1.1","unit":"m"}'),
      },
    },
    async ({ id, format, path, columns }) => {
      const d = getDoc(id);
      const matrix = buildMatrix({
        markups: d.markups,
        calibrations: d.calibrations,
        displayUnit: 'm',
        columns,
      });
      if (format === 'xlsx') {
        writeFileSync(path, xlsxBytes(matrix));
      } else {
        writeFileSync(path, '\ufeff' + toDelimited(matrix, format === 'csv' ? ',' : '\t'));
      }
      return text({ path, format, markups: d.markups.length });
    },
  );

  server.registerTool(
    'save_annotated',
    {
      description:
        'Write the markups back into the PDF as standard annotations (Line/PolyLine/Polygon/FreeText) at the given path — the output opens in the web app, Bluebeam Revu and Acrobat for human review.',
      inputSchema: {
        id: z.string(),
        path: z.string().describe('output PDF path'),
      },
    },
    async ({ id, path }) => {
      const d = getDoc(id);
      const bytes = await buildAnnotatedPdf({
        bytes: d.bytes,
        markups: d.markups,
        calibrations: d.calibrations,
        displayUnit: 'm',
      });
      writeFileSync(path, bytes);
      return text({ path, markups: d.markups.length });
    },
  );

  await server.connect(new StdioServerTransport());
  // the transport keeps the process alive until the client closes stdin
}

// direct invocation: node --experimental-strip-types src/headless/mcp.ts
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runMcpServer();
}
