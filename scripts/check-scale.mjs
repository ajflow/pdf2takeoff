#!/usr/bin/env node
// Behavioural check for drawing-scale parsing and consensus (engine/scale.ts):
// notation coverage, keyword gating of colon-less guesses, NTS, and the
// consensus statuses with their diagnosis of common misreads.

import { scaleVotesFromWords, scaleConsensus, dimensionVote, diagnoseFactor } from '../src/engine/scale.ts';
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

if (failed) process.exit(1);
console.log('PASS: scale parsing and consensus');
