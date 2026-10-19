#!/usr/bin/env node
// Behavioural check for drawing-scale parsing and consensus (engine/scale.ts):
// notation coverage, keyword gating of colon-less guesses, NTS, and the
// consensus statuses with their diagnosis of common misreads.

import { scaleVotesFromWords, scaleConsensus, dimensionVote, diagnoseFactor, checkAgainstSheet, doorWidthCheck } from '../src/engine/scale.ts';
import { metersPerPtForRatio } from '../src/engine/units.ts';

let failed = false;
const check = (label, cond, detail = '') => {
  if (!cond) {
    console.error(`FAIL: ${label} ${detail}`);
    failed = true;
  } else console.log(`ok: ${label}`);
};
const words = (...texts) => texts.map((text, i) => ({ text, conf: 90, xPt: 100 + i * 30, yPt: 50, wPt: 20, hPt: 8 }));
const ratios = (...texts) => scaleVotesFromWords(words(...texts)).votes.map((v) => v.ratio);

const parse = [
  [['1:100'], [100]],
  [['1', ':', '50'], [50]],
  [['SCALE:', '1:5'], [5]],
  [['1:5'], []], // small ratios only next to a keyword
  [['SCALE', '1;100'], [100]],
  [['SCALE', '1', '200'], [200]],
  [['SCALE', '1200'], [200]],
  [['1200'], []],
  [['1;100'], []],
  [['SCALE', '1100'], [100]],
  [['SCALE', '1250'], []], // 1:1250 is itself a standard scale: ambiguous, abstain
  [['1/4"', '=', "1'-0\""], [48]],
  [['SCALE:', '1/8"', '=', "1'-0\""], [96]],
  [['3/16"=1\'-0"'], [64]],
  [['1', '1/2"', '=', "1'-0\""], [8]],
  [['1"', '=', "20'"], [240]],
  [['1"=50\''], [600]],
  [['FULL', 'SIZE'], [1]],
  [['SCALE:', 'HALF', 'SIZE'], [2]],
  // OCR damage on degraded rasters: letter-for-digit slips, and the fraction
  // slash dropped so `1/4" = 1'-0"` reads `14" =1'0"` — repaired, or when a
  // repair cannot reach a printed standard, rejected rather than answered wrong
  [['14"', "=1'0\""], [48]],
  [['18"', '=', "1'0\""], [96]],
  [['34"', '=', "1'-0\""], [16]],
  [['1"', '=', "2O'"], [240]],
  [['1"', '=', "lO'"], [120]],
  [['SCALE', '1:IOO'], [100]],
  [['SCALE:', '1:2SO'], [250]],
  [['13"', '=', "1'-0\""], []], // 12/13 is no printed scale and no repair reaches one
  [['1"', '=', "13'"], []], // 156 feet per inch is no engineer scale
  // the note's right side destroyed by the scan: the keyword'd bare fraction
  // votes alone (reduced weight), and never double-votes beside the full note
  [['SCALE:', '1/4"'], [48]],
  [['SCALE:', '1/8"'], [96]],
  [['1/4"'], []], // without the keyword a bare fraction is just a dimension
  [['SCALE:', '"=10'], [120]], // the note fused: leading 1" and trailing foot mark lost
  [['SCALE:', '"=2O'], [240]],
  [['SCALE:', '"=13'], []], // 13 feet per inch is no engineer scale
];
for (const [input, want] of parse) {
  const got = ratios(...input);
  check(`parse ${JSON.stringify(input)}`, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
check('NTS abstains', scaleVotesFromWords(words('SCALE:', 'NTS')).nts && ratios('SCALE:', 'NTS').length === 0);
check('NOT TO SCALE abstains', scaleVotesFromWords(words('NOT', 'TO', 'SCALE')).nts);
check('guesses carry reduced weight', scaleVotesFromWords(words('SCALE', '1;100')).votes[0].weight < 1);

// consensus
const v = (ratio, weight = 1) => ({ ratio, weight, source: 't', kind: 'ratio', keyword: true });
let c = scaleConsensus([v(100), v(100.8)]);
check('agreed within 2%', c.status === 'agreed' && Math.abs(c.ratio - 100.4) < 0.01, JSON.stringify(c));
c = scaleConsensus([v(200), v(200.5)]);
check('two agreeing notes stay agreed', c.status === 'agreed');
c = scaleConsensus([v(100), v(100), v(600)]);
check('x6 rival reported as conflict with the colon diagnosis', c.status === 'conflict' && c.ratio === 100 && /1200/.test(c.rivals[0]?.likely ?? ''), JSON.stringify(c));
c = scaleConsensus([v(100, 0.5)]);
check('guess alone is insufficient', c.status === 'insufficient');
check('no votes is none', scaleConsensus([]).status === 'none');
check('x10 diagnosed as a unit slip', /unit/.test(diagnoseFactor(10) ?? ''));
check('x2 diagnosed as a reduced print', /reduced/.test(diagnoseFactor(2) ?? ''));

// a printed 3.6 m dimension drawn at 1:50 votes 1:50
const paperPt = 3.6 / metersPerPtForRatio(50);
const dv = dimensionVote(paperPt, 3.6);
check('dimension vote recovers 1:50', dv && Math.abs(dv.ratio - 50) < 1e-6, JSON.stringify(dv));
c = scaleConsensus([v(100), dv]);
check('title-block 1:100 vs measured 1:50 conflicts as a reduced print', c.status === 'conflict' && /reduced/.test(c.rivals[0]?.likely ?? ''), JSON.stringify(c));

// checking a set scale against the sheet: the title-block scale decides
{
  const sheet = scaleVotesFromWords([
    { text: 'DETAIL', conf: 90, xPt: 100, yPt: 400, wPt: 20, hPt: 8 },
    { text: '1:20', conf: 90, xPt: 130, yPt: 400, wPt: 20, hPt: 8 },
    { text: 'SCALE', conf: 90, xPt: 700, yPt: 40, wPt: 20, hPt: 8 },
    { text: '1:100', conf: 90, xPt: 730, yPt: 40, wPt: 20, hPt: 8 },
  ]);
  check('sheet check: correct 1:100 with a 1:20 detail agrees', checkAgainstSheet(100, sheet.votes, sheet.nts, 0.02).status === 'agrees');
  check('sheet check: hand-measured 1:97.4 agrees within 5%', checkAgainstSheet(97.4, sheet.votes, sheet.nts, 0.05).status === 'agrees');
  const wrong = checkAgainstSheet(50, sheet.votes, sheet.nts, 0.02);
  check('sheet check: 1:50 disagrees with the title block, reduced print', wrong.status === 'disagrees' && wrong.sheetRatio === 100 && /reduced/.test(wrong.likely ?? ''), JSON.stringify(wrong));
  const loose = scaleVotesFromWords(words('1:100', 'DETAIL', '1:20'));
  check('sheet check: two unlabelled ratios and neither matches is ambiguous, not a warning', checkAgainstSheet(50, loose.votes, loose.nts).status === 'ambiguous');
  check('sheet check: no note to check against', checkAgainstSheet(100, [], false).status === 'none');
}

// door-width second opinion: 0.9 m doors at 1:100 render 76.5 px at 3 px/pt
{
  const px = 0.9 / metersPerPtForRatio(100) * 3;
  const ok = doorWidthCheck(metersPerPtForRatio(100), px, 3);
  check('door width: 1:100 makes the sheet\'s doors 0.9 m, plausible', ok?.status === 'plausible' && Math.abs(ok.impliedDoorM - 0.9) < 0.01, JSON.stringify(ok));
  const half = doorWidthCheck(metersPerPtForRatio(200), px, 3);
  check('door width: 1:200 on the same sheet makes them 1.8 m, implausible, reduced print', half?.status === 'implausible' && /reduced size/.test(half.likely ?? ''), JSON.stringify(half));
  const tenth = doorWidthCheck(metersPerPtForRatio(10), px, 3);
  check('door width: 1:10 makes them 9 cm, implausible, unit slip', tenth?.status === 'implausible' && /unit slip/.test(tenth.likely ?? ''), JSON.stringify(tenth));
  check('door width: a sheet with no agreed doorways has nothing to check', doorWidthCheck(metersPerPtForRatio(100), 0, 3) === null);
}

if (failed) process.exit(1);
console.log('PASS: scale parsing and consensus');
