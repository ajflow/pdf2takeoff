# ScaledDrawingBench v0.1 results: pdf2takeoff reference (deterministic, no model)

2040 questions (seed 20261018); 0 without a prediction; 1929 s.

Accuracy is within 2 percent for scale, length, area, perimeter and dimension_read, exact match for count, and an exact change set for compare; abstentions on answerable questions count as wrong. MAPE is over answered questions. The last column counts numeric or list answers given to questions that are unanswerable by design.

## vector half

| Type | Answerable | Answered | Within 2% | Within 5% | MAPE | Exact | Set F1 | Accuracy | Hallucinated / unanswerable |
|---|---|---|---|---|---|---|---|---|---|
| scale | 95 | 95 | 100% | 100% | 0% | n/a | n/a | 100% | 0/5 |
| length | 190 | 190 | 100% | 100% | 0% | n/a | n/a | 100% | 0/10 |
| area | 234 | 234 | 100% | 100% | 0.7% | n/a | n/a | 100% | 0/12 |
| perimeter | 95 | 95 | 100% | 100% | 0.3% | n/a | n/a | 100% | 0/5 |
| count | 263 | 261 | n/a | n/a | 0% | 99.2% | n/a | 99.2% | n/a |
| dimension_read | 95 | 95 | 100% | 100% | 0% | n/a | n/a | 100% | 0/5 |
| compare | 8 | 8 | n/a | n/a | n/a | n/a | 100% | 100% | n/a |
| all | 980 | 978 | 100% | 100% | 0.2% | 99.2% | 100% | 99.8% | 0/37 |

## raster half

| Type | Answerable | Answered | Within 2% | Within 5% | MAPE | Exact | Set F1 | Accuracy | Hallucinated / unanswerable |
|---|---|---|---|---|---|---|---|---|---|
| scale | 93 | 38 | 34.4% | 34.4% | 36.7% | n/a | n/a | 34.4% | 0/7 |
| length | 186 | 52 | 17.2% | 17.2% | 19.8% | n/a | n/a | 17.2% | 0/14 |
| area | 235 | 71 | 26.4% | 27.7% | 278.5% | n/a | n/a | 26.4% | 0/20 |
| perimeter | 93 | 28 | 26.9% | 26.9% | 33% | n/a | n/a | 26.9% | 0/7 |
| count | 256 | 121 | n/a | n/a | 99.9% | 0% | n/a | 0% | n/a |
| dimension_read | 93 | 14 | 9.7% | 9.7% | 65.8% | n/a | n/a | 9.7% | 0/7 |
| compare | 12 | 12 | n/a | n/a | n/a | n/a | 37.7% | 0% | n/a |
| all | 968 | 336 | 22.9% | 23.3% | 111.5% | 0% | 37.7% | 16.5% | 0/55 |

## Overall

| Type | Answerable | Answered | Within 2% | Within 5% | MAPE | Exact | Set F1 | Accuracy | Hallucinated / unanswerable |
|---|---|---|---|---|---|---|---|---|---|
| scale | 188 | 133 | 67.6% | 67.6% | 10.5% | n/a | n/a | 67.6% | 0/12 |
| length | 376 | 242 | 59% | 59% | 4.2% | n/a | n/a | 59% | 0/24 |
| area | 469 | 305 | 63.1% | 63.8% | 65.4% | n/a | n/a | 63.1% | 0/32 |
| perimeter | 188 | 123 | 63.8% | 63.8% | 7.8% | n/a | n/a | 63.8% | 0/12 |
| count | 519 | 382 | n/a | n/a | 31.7% | 50.3% | n/a | 50.3% | n/a |
| dimension_read | 188 | 109 | 55.3% | 55.3% | 8.4% | n/a | n/a | 55.3% | 0/12 |
| compare | 20 | 20 | n/a | n/a | n/a | n/a | 62.6% | 40% | n/a |
| all | 1948 | 1314 | 61.7% | 61.9% | 28.1% | 50.3% | 62.6% | 58.4% | 0/92 |

## By scale notation

| Notation | Answerable | Accuracy | Within 2% | MAPE | Hallucinated / unanswerable |
|---|---|---|---|---|---|
| bar | 378 | 53.7% | 56% | 101.4% | n/a |
| ratio | 318 | 61.9% | 73.5% | 14.7% | n/a |
| dimension | 402 | 68.2% | 68.2% | 6.6% | n/a |
| engineer | 482 | 61.6% | 64.1% | 9.4% | n/a |
| nts | 30 | 36.7% | n/a | 47.4% | 0/92 |
| imperial | 338 | 46.2% | 46% | 15.1% | n/a |

## By degradation recipe

| Recipe | Answerable | Accuracy | Within 2% | MAPE |
|---|---|---|---|---|
| none | 980 | 99.8% | 100% | 0.2% |
| photocopy | 213 | 25.4% | 35.8% | 37.1% |
| noise | 232 | 14.2% | 19.9% | 47.2% |
| contrast | 139 | 25.9% | 36% | 39.9% |
| rotate | 163 | 12.3% | 16.9% | 413.3% |
| blur | 221 | 7.7% | 10.3% | 55.9% |

## Notes

- SDB-017: fill at LOBBY: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-044: fill at PRINT: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-044: fill at MEETING: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- engine raster path (pdf.js + napi canvas image XObject render) exited with SIGSEGV on SDB-101; raster sheets decoded directly from the embedded image instead (WP1 crash workaround, same pixels at 3 px/pt)
- SDB-101: scan read sideways, turned 270 degrees
- SDB-102: label "OFFICE 3" not found
- SDB-102: legend entry "smoke detector" not found
- SDB-102: legend entry "gpo" not found
- SDB-103: scan read sideways, turned 270 degrees
- SDB-103: legend entry "smoke detector" not found
- SDB-103: legend entry "gpo" not found
- SDB-104: legend entry "switch" not found
- SDB-104: legend entry "gpo" not found
- SDB-105: legend entry "gpo" not found
- SDB-105: legend entry "switch" not found
- SDB-106: scan smoke detector: that symbol is too small or part of a large structure; try a smaller, isolated symbol
- SDB-106: legend entry "downlight" not found
- SDB-107: scan read sideways, turned 270 degrees
- SDB-107: scan smoke detector: that symbol is too small or part of a large structure; try a smaller, isolated symbol
- SDB-107: label "WC" not found
- SDB-107: fill at SERVER: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-107: legend entry "downlight" not found
- SDB-107: legend entry "switch" not found
- SDB-109: scan read sideways, turned 270 degrees
- SDB-109: fill at KITCHEN: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-109: fill at STAFF: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-109: legend entry "switch" not found
- SDB-110: legend entry "downlight" not found
- SDB-110: label "SERVER" not found
- SDB-111: scan read sideways, turned 270 degrees
- SDB-111: label "STUDY" not found
- SDB-112: scan read sideways, turned 270 degrees
- SDB-112: legend entry "downlight" not found
- SDB-112: legend entry "smoke detector" not found
- SDB-113: legend entry "smoke detector" not found
- SDB-113: label "OFFICE 3" not found
- SDB-114: legend entry "gpo" not found
- SDB-114: legend entry "smoke detector" not found
- SDB-115: legend entry "smoke detector" not found
- SDB-115: fill at MEETING: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-116: scan read sideways, turned 270 degrees
- SDB-117: label "STUDY" not found
- SDB-117: label "ARCHIVE" not found
- SDB-117: legend entry "switch" not found
- SDB-117: legend entry "smoke detector" not found
- SDB-117: label "RECEPTION" not found
- SDB-117: legend entry "downlight" not found
- SDB-117: legend entry "gpo" not found
- SDB-117: legend entry "diffuser" not found
- SDB-118: fill at KITCHEN: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-118: fill at PLANT: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-119: scan read sideways, turned 270 degrees
- SDB-120: label "BED 2" not found
- SDB-121: scan read sideways, turned 270 degrees
- SDB-121: legend entry "downlight" not found
- SDB-121: legend entry "gpo" not found
- SDB-122: fill at PRINT: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-122: legend entry "switch" not found
- SDB-122: legend entry "diffuser" not found
- SDB-123: scan read sideways, turned 270 degrees
- SDB-123: legend entry "gpo" not found
- SDB-124: scan read sideways, turned 270 degrees
- SDB-125: label "PRINT" not found
- SDB-125: legend entry "diffuser" not found
- SDB-126: legend entry "gpo" not found
- SDB-126: fill at PLANT: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-126: fill at LAUNDRY: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-127: scan read sideways, turned 270 degrees
- SDB-127: legend entry "downlight" not found
- SDB-127: legend entry "smoke detector" not found
- SDB-128: legend entry "gpo" not found
- SDB-129: legend entry "downlight" not found
- SDB-129: legend entry "gpo" not found
- SDB-129: legend entry "diffuser" not found
- SDB-129: label "BED 1" not found
- SDB-130: legend entry "gpo" not found
- SDB-130: fill at STUDY: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-131: label "OFFICE 1" not found
- SDB-131: label "WC" not found
- SDB-131: legend entry "smoke detector" not found
- SDB-131: legend entry "gpo" not found
- SDB-131: label "OFFICE 2" not found
- SDB-132: scan read sideways, turned 270 degrees
- SDB-132: label "OFFICE 3" not found
- SDB-132: legend entry "downlight" not found
- SDB-132: legend entry "diffuser" not found
- SDB-133: label "WC" not found
- SDB-133: legend entry "gpo" not found
- SDB-134: legend entry "gpo" not found
- SDB-134: fill at LOBBY: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-136: scan smoke detector: that symbol is too small or part of a large structure; try a smaller, isolated symbol
- SDB-136: fill at WC: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-137: fill at BED 2: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-137: fill at LAUNDRY: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-139: legend entry "diffuser" not found
- SDB-139: legend entry "gpo" not found
- SDB-140: label "WC" not found
- SDB-141: scan read sideways, turned 270 degrees
- SDB-141: fill at WC: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-141: fill at MEETING: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-142: legend entry "gpo" not found
- SDB-142: legend entry "switch" not found
- SDB-142: legend entry "diffuser" not found
- SDB-143: legend entry "switch" not found
- SDB-143: legend entry "downlight" not found
- SDB-143: label "WC" not found
- SDB-144: legend entry "gpo" not found
- SDB-145: label "WC" not found
- SDB-146: legend entry "diffuser" not found
- SDB-146: legend entry "gpo" not found
- SDB-146: legend entry "switch" not found
- SDB-148: legend entry "smoke detector" not found
- SDB-149: scan read sideways, turned 270 degrees
- SDB-149: legend entry "diffuser" not found
- SDB-149: legend entry "switch" not found
- SDB-150: scan read sideways, turned 270 degrees
- SDB-150: legend entry "diffuser" not found
- SDB-151: legend entry "switch" not found
- SDB-151: legend entry "gpo" not found
- SDB-151: legend entry "smoke detector" not found
- SDB-151: label "LIVING" not found
- SDB-152: label "STAFF" not found
- SDB-152: label "RECEPTION" not found
- SDB-152: legend entry "downlight" not found
- SDB-152: legend entry "gpo" not found
- SDB-152: legend entry "smoke detector" not found
- SDB-152: label "OFFICE 3" not found
- SDB-153: label "OFFICE 2" not found
- SDB-153: legend entry "gpo" not found
- SDB-154: scan read sideways, turned 270 degrees
- SDB-154: legend entry "smoke detector" not found
- SDB-154: legend entry "switch" not found
- SDB-154: label "WC" not found
- SDB-155: legend entry "switch" not found
- SDB-155: legend entry "downlight" not found
- SDB-155: legend entry "gpo" not found
- SDB-155: label "OFFICE 1" not found
- SDB-156: legend entry "diffuser" not found
- SDB-157: legend entry "gpo" not found
- SDB-157: label "WC" not found
- SDB-158: scan read sideways, turned 270 degrees
- SDB-158: legend entry "gpo" not found
- SDB-159: fill at STAFF: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-161: label "ARCHIVE" not found
- SDB-161: label "STORE" not found
- SDB-161: fill at PLANT: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-161: legend entry "smoke detector" not found
- SDB-161: label "RECEPTION" not found
- SDB-162: legend entry "smoke detector" not found
- SDB-163: legend entry "gpo" not found
- SDB-164: legend entry "gpo" not found
- SDB-165: scan read sideways, turned 270 degrees
- SDB-165: legend entry "diffuser" not found
- SDB-166: fill at OFFICE 1: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-166: fill at ARCHIVE: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-167: legend entry "diffuser" not found
- SDB-167: legend entry "downlight" not found
- SDB-168: scan read sideways, turned 270 degrees
- SDB-168: label "RECEPTION" not found
- SDB-168: label "LOBBY" not found
- SDB-168: label "LAUNDRY" not found
- SDB-168: legend entry "downlight" not found
- SDB-168: legend entry "smoke detector" not found
- SDB-169: label "STORE" not found
- SDB-169: label "LOBBY" not found
- SDB-169: label "KITCHEN" not found
- SDB-169: legend entry "diffuser" not found
- SDB-169: legend entry "smoke detector" not found
- SDB-170: legend entry "diffuser" not found
- SDB-170: legend entry "downlight" not found
- SDB-170: label "LOBBY" not found
- SDB-171: legend entry "smoke detector" not found
- SDB-171: legend entry "downlight" not found
- SDB-173: legend entry "gpo" not found
- SDB-173: fill at RECEPTION: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-174: legend entry "diffuser" not found
- SDB-174: label "OFFICE 3" not found
- SDB-174: label "BED 2" not found
- SDB-175: label "STORE" not found
- SDB-175: label "WC" not found
- SDB-175: label "PRINT" not found
- SDB-175: legend entry "downlight" not found
- SDB-175: legend entry "diffuser" not found
- SDB-176: label "BED 2" not found
- SDB-177: legend entry "gpo" not found
- SDB-177: label "OFFICE 2" not found
- SDB-178: legend entry "diffuser" not found
- SDB-178: legend entry "downlight" not found
- SDB-180: legend entry "gpo" not found
- SDB-180: legend entry "switch" not found
- SDB-181: scan read sideways, turned 270 degrees
- SDB-181: fill at PRINT: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-182: scan read sideways, turned 270 degrees
- SDB-182: fill at SERVER: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-182: fill at STAFF: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-183: scan read sideways, turned 270 degrees
- SDB-183: legend entry "gpo" not found
- SDB-183: legend entry "switch" not found
- SDB-183: legend entry "smoke detector" not found
- SDB-183: legend entry "diffuser" not found
- SDB-184: legend entry "gpo" not found
- SDB-184: label "BED 2" not found
- SDB-187: legend entry "gpo" not found
- SDB-187: legend entry "diffuser" not found
- SDB-187: label "OFFICE 2" not found
- SDB-189: scan read sideways, turned 270 degrees
- SDB-189: label "STUDY" not found
- SDB-189: fill at PLANT: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-189: legend entry "gpo" not found
- SDB-189: legend entry "diffuser" not found
- SDB-189: label "LIVING" not found
- SDB-190: legend entry "diffuser" not found
- SDB-191: legend entry "smoke detector" not found
- SDB-193: scan read sideways, turned 270 degrees
- SDB-194: legend entry "diffuser" not found
- SDB-194: legend entry "smoke detector" not found
- SDB-194: label "WORKSHOP" not found
- SDB-195: legend entry "switch" not found
- SDB-195: legend entry "smoke detector" not found
- SDB-196: legend entry "gpo" not found
- SDB-196: label "LOBBY" not found
- SDB-197: legend entry "gpo" not found
- SDB-198: scan read sideways, turned 270 degrees
- SDB-198: legend entry "smoke detector" not found
- SDB-199: scan read sideways, turned 270 degrees
- SDB-200: fill at ARCHIVE: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-200: fill at SERVER: that region is not bounded by lines on all sides , draw around it with the Area tool instead
