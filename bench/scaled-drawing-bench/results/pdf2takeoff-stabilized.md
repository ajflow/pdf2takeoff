# ScaledDrawingBench v0.1 results: pdf2takeoff reference (deterministic, no model)

2040 questions (seed 20261018); 0 without a prediction; 884 s.

Accuracy is within 2 percent for scale, length, area, perimeter and dimension_read, exact match for count, and an exact change set for compare; abstentions on answerable questions count as wrong. MAPE is over answered questions. The last column counts numeric or list answers given to questions that are unanswerable by design.

## vector half

| Type | Answerable | Answered | Within 2% | Within 5% | MAPE | Exact | Set F1 | Accuracy | Hallucinated / unanswerable |
|---|---|---|---|---|---|---|---|---|---|
| scale | 95 | 95 | 100% | 100% | 0% | n/a | n/a | 100% | 0/5 |
| length | 190 | 190 | 100% | 100% | 0% | n/a | n/a | 100% | 0/10 |
| area | 234 | 234 | 100% | 100% | 0.2% | n/a | n/a | 100% | 0/12 |
| perimeter | 95 | 95 | 100% | 100% | 0.1% | n/a | n/a | 100% | 0/5 |
| count | 263 | 261 | n/a | n/a | 0% | 99.2% | n/a | 99.2% | n/a |
| dimension_read | 95 | 95 | 100% | 100% | 0% | n/a | n/a | 100% | 0/5 |
| compare | 8 | 8 | n/a | n/a | n/a | n/a | 100% | 100% | n/a |
| all | 980 | 978 | 100% | 100% | 0% | 99.2% | 100% | 99.8% | 0/37 |

## raster half

| Type | Answerable | Answered | Within 2% | Within 5% | MAPE | Exact | Set F1 | Accuracy | Hallucinated / unanswerable |
|---|---|---|---|---|---|---|---|---|---|
| scale | 93 | 50 | 49.5% | 49.5% | 5.1% | n/a | n/a | 49.5% | 0/7 |
| length | 186 | 74 | 23.7% | 23.7% | 16.6% | n/a | n/a | 23.7% | 0/14 |
| area | 235 | 103 | 40.4% | 40.4% | 5.7% | n/a | n/a | 40.4% | 0/20 |
| perimeter | 93 | 44 | 43% | 44.1% | 2.3% | n/a | n/a | 43% | 0/7 |
| count | 256 | 167 | n/a | n/a | 18.8% | 43.4% | n/a | 43.4% | n/a |
| dimension_read | 93 | 24 | 22.6% | 23.7% | 27.3% | n/a | n/a | 22.6% | 0/7 |
| compare | 12 | 12 | n/a | n/a | n/a | n/a | 66.7% | 33.3% | n/a |
| all | 968 | 474 | 35.1% | 35.4% | 12.9% | 43.4% | 66.7% | 37.3% | 0/55 |

## Overall

| Type | Answerable | Answered | Within 2% | Within 5% | MAPE | Exact | Set F1 | Accuracy | Hallucinated / unanswerable |
|---|---|---|---|---|---|---|---|---|---|
| scale | 188 | 145 | 75% | 75% | 1.8% | n/a | n/a | 75% | 0/12 |
| length | 376 | 264 | 62.2% | 62.2% | 4.6% | n/a | n/a | 62.2% | 0/24 |
| area | 469 | 337 | 70.1% | 70.1% | 1.9% | n/a | n/a | 70.1% | 0/32 |
| perimeter | 188 | 139 | 71.8% | 72.3% | 0.8% | n/a | n/a | 71.8% | 0/12 |
| count | 519 | 428 | n/a | n/a | 7.3% | 71.7% | n/a | 71.7% | n/a |
| dimension_read | 188 | 119 | 61.7% | 62.2% | 5.5% | n/a | n/a | 61.7% | 0/12 |
| compare | 20 | 20 | n/a | n/a | n/a | n/a | 80% | 60% | n/a |
| all | 1948 | 1452 | 67.8% | 67.9% | 4.2% | 71.7% | 80% | 68.7% | 0/92 |

## By scale notation

| Notation | Answerable | Accuracy | Within 2% | MAPE | Hallucinated / unanswerable |
|---|---|---|---|---|---|
| bar | 378 | 78.6% | 79.4% | 5.7% | n/a |
| ratio | 318 | 70.1% | 73.5% | 6% | n/a |
| dimension | 402 | 71.1% | 68.2% | 1.9% | n/a |
| engineer | 482 | 64.9% | 60.7% | 2.4% | n/a |
| nts | 30 | 53.3% | n/a | 14% | 0/92 |
| imperial | 338 | 60.4% | 59.1% | 4.8% | n/a |

## By degradation recipe

| Recipe | Answerable | Accuracy | Within 2% | MAPE |
|---|---|---|---|---|
| none | 980 | 99.8% | 100% | 0% |
| photocopy | 213 | 45.5% | 47% | 8.9% |
| noise | 232 | 40.5% | 41% | 18.5% |
| contrast | 139 | 44.6% | 37% | 9.8% |
| rotate | 163 | 38% | 39.8% | 14.9% |
| blur | 221 | 20.8% | 13.9% | 10.3% |

## Notes

- SDB-017: fill at LOBBY: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-044: fill at PRINT: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-044: fill at MEETING: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-101: scan read sideways, turned 270 degrees
- SDB-101: label "OFFICE 1" not found
- SDB-103: scan read sideways, turned 270 degrees
- SDB-103: legend entry "smoke detector" not found
- SDB-103: legend entry "gpo" not found
- SDB-104: legend entry "gpo" not found
- SDB-105: legend entry "gpo" not found
- SDB-105: legend entry "switch" not found
- SDB-106: legend entry "smoke detector" not found
- SDB-106: label "BED 2" not found
- SDB-107: scan read sideways, turned 270 degrees
- SDB-107: label "OFFICE 3" not found
- SDB-107: legend entry "downlight" not found
- SDB-107: legend entry "switch" not found
- SDB-109: scan read sideways, turned 270 degrees
- SDB-109: fill at KITCHEN: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-109: fill at STAFF: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-109: legend entry "switch" not found
- SDB-111: scan read sideways, turned 270 degrees
- SDB-111: fill at STUDY: fill is smaller than any room
- SDB-111: fill at ARCHIVE: fill is smaller than any room
- SDB-111: label "STAFF" not found
- SDB-112: scan read sideways, turned 270 degrees
- SDB-112: legend entry "downlight" not found
- SDB-112: legend entry "smoke detector" not found
- SDB-112: label "BED 1" not found
- SDB-113: legend entry "smoke detector" not found
- SDB-114: legend entry "gpo" not found
- SDB-114: legend entry "smoke detector" not found
- SDB-115: legend entry "smoke detector" not found
- SDB-116: scan read sideways, turned 270 degrees
- SDB-116: legend entry "smoke detector" not found
- SDB-117: label "PRINT" not found
- SDB-117: legend entry "smoke detector" not found
- SDB-117: legend entry "downlight" not found
- SDB-117: legend entry "gpo" not found
- SDB-117: legend entry "diffuser" not found
- SDB-118: legend entry "gpo" not found
- SDB-118: fill at PLANT: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-119: scan read sideways, turned 270 degrees
- SDB-120: label "BED 2" not found
- SDB-120: label "OFFICE 1" not found
- SDB-120: legend entry "smoke detector" not found
- SDB-121: scan read sideways, turned 270 degrees
- SDB-121: legend entry "downlight" not found
- SDB-122: legend entry "downlight" not found
- SDB-122: fill at PRINT: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-122: legend entry "switch" not found
- SDB-122: legend entry "diffuser" not found
- SDB-123: scan read sideways, turned 270 degrees
- SDB-124: scan read sideways, turned 270 degrees
- SDB-124: legend entry "smoke detector" not found
- SDB-125: label "WORKSHOP" not found
- SDB-127: scan read sideways, turned 270 degrees
- SDB-127: legend entry "downlight" not found
- SDB-127: legend entry "smoke detector" not found
- SDB-128: legend entry "smoke detector" not found
- SDB-129: legend entry "downlight" not found
- SDB-129: label "BED 1" not found
- SDB-130: legend entry "downlight" not found
- SDB-130: legend entry "gpo" not found
- SDB-130: fill at STUDY: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-131: label "RECEPTION" not found
- SDB-131: label "OFFICE 2" not found
- SDB-132: scan read sideways, turned 270 degrees
- SDB-132: legend entry "downlight" not found
- SDB-132: legend entry "diffuser" not found
- SDB-133: label "LIVING" not found
- SDB-134: label "BED 1" not found
- SDB-134: label "LOBBY" not found
- SDB-135: label "BED 1" not found
- SDB-136: label "OFFICE 2" not found
- SDB-136: fill at WC: you clicked on a line , click inside the region
- SDB-137: fill at BED 2: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-137: fill at LAUNDRY: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-139: legend entry "gpo" not found
- SDB-140: label "MEETING" not found
- SDB-140: label "WC" not found
- SDB-140: label "BED 1" not found
- SDB-141: scan read sideways, turned 270 degrees
- SDB-141: fill at WC: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-141: fill at MEETING: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-142: label "OFFICE 1" not found
- SDB-142: legend entry "gpo" not found
- SDB-142: legend entry "switch" not found
- SDB-142: legend entry "diffuser" not found
- SDB-143: label "WC" not found
- SDB-145: legend entry "downlight" not found
- SDB-145: fill at STUDY: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-147: legend entry "downlight" not found
- SDB-148: legend entry "smoke detector" not found
- SDB-149: scan read sideways, turned 270 degrees
- SDB-150: scan read sideways, turned 270 degrees
- SDB-152: label "RECEPTION" not found
- SDB-152: legend entry "gpo" not found
- SDB-152: legend entry "smoke detector" not found
- SDB-152: label "OFFICE 3" not found
- SDB-154: scan read sideways, turned 270 degrees
- SDB-154: legend entry "downlight" not found
- SDB-154: legend entry "smoke detector" not found
- SDB-154: label "STAFF" not found
- SDB-154: fill at WC: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-155: label "LAUNDRY" not found
- SDB-155: label "OFFICE 1" not found
- SDB-157: legend entry "gpo" not found
- SDB-158: scan read sideways, turned 270 degrees
- SDB-158: legend entry "gpo" not found
- SDB-160: label "OFFICE 3" not found
- SDB-161: label "PRINT" not found
- SDB-161: label "RECEPTION" not found
- SDB-162: legend entry "smoke detector" not found
- SDB-162: legend entry "downlight" not found
- SDB-165: scan read sideways, turned 270 degrees
- SDB-165: legend entry "diffuser" not found
- SDB-166: fill at OFFICE 1: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-166: fill at ARCHIVE: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-167: legend entry "diffuser" not found
- SDB-167: label "BED 2" not found
- SDB-168: scan read sideways, turned 270 degrees
- SDB-168: fill at LAUNDRY: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-168: label "RECEPTION" not found
- SDB-169: legend entry "smoke detector" not found
- SDB-169: label "LOBBY" not found
- SDB-170: legend entry "downlight" not found
- SDB-171: label "OFFICE 3" not found
- SDB-171: label "OFFICE 1" not found
- SDB-171: legend entry "smoke detector" not found
- SDB-171: legend entry "downlight" not found
- SDB-173: fill at RECEPTION: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-174: label "OFFICE 3" not found
- SDB-175: legend entry "diffuser" not found
- SDB-175: fill at PRINT: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-176: legend entry "downlight" not found
- SDB-177: legend entry "gpo" not found
- SDB-178: legend entry "smoke detector" not found
- SDB-180: legend entry "gpo" not found
- SDB-180: legend entry "switch" not found
- SDB-181: scan read sideways, turned 270 degrees
- SDB-182: scan read sideways, turned 270 degrees
- SDB-182: label "SERVER" not found
- SDB-182: fill at STAFF: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-183: scan read sideways, turned 270 degrees
- SDB-183: legend entry "switch" not found
- SDB-183: legend entry "smoke detector" not found
- SDB-183: legend entry "diffuser" not found
- SDB-184: legend entry "gpo" not found
- SDB-187: legend entry "gpo" not found
- SDB-187: legend entry "diffuser" not found
- SDB-187: fill at OFFICE 2: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-189: scan read sideways, turned 270 degrees
- SDB-189: legend entry "gpo" not found
- SDB-189: label "LIVING" not found
- SDB-190: legend entry "smoke detector" not found
- SDB-191: label "OFFICE 2" not found
- SDB-191: legend entry "smoke detector" not found
- SDB-192: fill at LAUNDRY: fill is smaller than any room
- SDB-192: fill at WC: fill is smaller than any room
- SDB-192: fill at OFFICE 1: fill is smaller than any room
- SDB-193: scan read sideways, turned 270 degrees
- SDB-193: label "OFFICE 1" not found
- SDB-195: label "OFFICE 3" not found
- SDB-195: legend entry "smoke detector" not found
- SDB-197: legend entry "gpo" not found
- SDB-198: scan read sideways, turned 270 degrees
- SDB-198: label "OFFICE 1" not found
- SDB-198: legend entry "smoke detector" not found
- SDB-199: scan read sideways, turned 270 degrees
- SDB-200: legend entry "downlight" not found
