# AEC-Geometric-Bench sheet_02 — P0 geometry-fix verification

One post-fix verification using the same 16 assisted seeds as B6/B6b/B6d, with no parameter changes and no post-score tuning. The run tests the P0 fixes only: horizontal closing indexing, pixel-cell-edge tracing, explicit closure and simple-ring validation.

All **4 returned polygons are valid Shapely polygons** and remain 4 scored instances; the scorer performs no validity repair or component multiplication. The previous B6d assisted output submitted 7 rings but scored 11 instances after invalid-ring repair.

| metric | B6d assisted | P0 fix assisted |
| --- | ---: | ---: |
| submitted / scored area instances | 7 / 11 | **4 / 4** |
| valid submitted rings | not all | **4 / 4** |
| TP / FP / FN | 2 / 9 / 20 | **2 / 2 / 20** |
| area-instance F1 | 0.121 | **0.154** |
| area-pixel P / R / F1 | 0.859 / 0.392 / 0.539 | **0.973 / 0.091 / 0.167** |

The lower coverage is deliberate rejection of four invalid-boundary results plus other failed seeds. This establishes that the geometry defect is fixed safely; it does not solve room coverage or partitioning. The unassisted 442-seed sweep was not rerun because it previously took 3296 seconds and P0's acceptance contract was already falsified and verified directly. A future room-partition candidate should receive its own final frozen unassisted run.

Seeds in manifest pixels, unchanged from B6: `460,395; 660,385; 480,565; 680,560; 585,575; 470,705; 665,715; 600,855; 1130,410; 1345,365; 1130,565; 1285,545; 1290,580; 1120,720; 1335,725; 1250,865`.

Engine: pdf2takeoff 0.1.0, fill raster 3 px/pt, adapter gap ladder `[0,16,32,48,80,112]`, default threshold ladder. Benchmark input and scorer are external and unchanged. Assisted single sheet, single run, one machine; not repeatability or corpus evidence.
