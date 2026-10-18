# ScaledDrawingBench v0.1 results: pdf2takeoff reference (deterministic, no model)

1023 questions (seed 20261018); 0 without a prediction; 1407 s.

Accuracy is within 2 percent for scale, length, area, perimeter and dimension_read, exact match for count, and an exact change set for compare; abstentions on answerable questions count as wrong. MAPE is over answered questions. The last column counts numeric or list answers given to questions that are unanswerable by design.

## raster half

| Type | Answerable | Answered | Within 2% | Within 5% | MAPE | Exact | Set F1 | Accuracy | Hallucinated / unanswerable |
|---|---|---|---|---|---|---|---|---|---|
| scale | 93 | 36 | 30.1% | 32.3% | 60.8% | n/a | n/a | 30.1% | 0/7 |
| length | 186 | 52 | 17.7% | 19.4% | 33.4% | n/a | n/a | 17.7% | 0/14 |
| area | 235 | 61 | 21.7% | 22.6% | 858.2% | n/a | n/a | 21.7% | 0/20 |
| perimeter | 93 | 27 | 24.7% | 26.9% | 67.1% | n/a | n/a | 24.7% | 0/7 |
| count | 256 | 132 | n/a | n/a | 26.2% | 30.1% | n/a | 30.1% | n/a |
| dimension_read | 93 | 13 | 10.8% | 10.8% | 18.2% | n/a | n/a | 10.8% | 0/7 |
| compare | 12 | 12 | n/a | n/a | n/a | n/a | 36.5% | 8.3% | n/a |
| all | 968 | 333 | 20.7% | 22% | 192.5% | 30.1% | 36.5% | 23% | 0/55 |

## Overall

| Type | Answerable | Answered | Within 2% | Within 5% | MAPE | Exact | Set F1 | Accuracy | Hallucinated / unanswerable |
|---|---|---|---|---|---|---|---|---|---|
| scale | 93 | 36 | 30.1% | 32.3% | 60.8% | n/a | n/a | 30.1% | 0/7 |
| length | 186 | 52 | 17.7% | 19.4% | 33.4% | n/a | n/a | 17.7% | 0/14 |
| area | 235 | 61 | 21.7% | 22.6% | 858.2% | n/a | n/a | 21.7% | 0/20 |
| perimeter | 93 | 27 | 24.7% | 26.9% | 67.1% | n/a | n/a | 24.7% | 0/7 |
| count | 256 | 132 | n/a | n/a | 26.2% | 30.1% | n/a | 30.1% | n/a |
| dimension_read | 93 | 13 | 10.8% | 10.8% | 18.2% | n/a | n/a | 10.8% | 0/7 |
| compare | 12 | 12 | n/a | n/a | n/a | n/a | 36.5% | 8.3% | n/a |
| all | 968 | 333 | 20.7% | 22% | 192.5% | 30.1% | 36.5% | 23% | 0/55 |

## By scale notation

| Notation | Answerable | Accuracy | Within 2% | MAPE | Hallucinated / unanswerable |
|---|---|---|---|---|---|
| bar | 197 | 27.4% | 21.5% | 631.2% | n/a |
| ratio | 217 | 56.7% | 63.7% | 6% | n/a |
| dimension | 128 | 7.8% | 0% | 39% | n/a |
| engineer | 223 | 9% | 3.6% | 19.5% | n/a |
| imperial | 186 | 7% | 5.7% | 51% | n/a |
| nts | 17 | 17.6% | n/a | 59.9% | 0/55 |

## By degradation recipe

| Recipe | Answerable | Accuracy | Within 2% | MAPE |
|---|---|---|---|---|
| photocopy | 213 | 29.1% | 25.8% | 373.2% |
| noise | 232 | 21.6% | 21.7% | 20.1% |
| contrast | 139 | 41.7% | 38% | 9.1% |
| rotate | 163 | 12.3% | 9.3% | 488.5% |
| blur | 221 | 14.9% | 12.7% | 18.3% |

## Notes

- SDB-101: scan read sideways, turned 270 degrees
- SDB-101: label "BED 1" not found
- SDB-101: label "STUDY" not found
- SDB-102: label "LIVING" not found
- SDB-102: legend entry "smoke detector" not found
- SDB-102: legend entry "gpo" not found
- SDB-103: scan read sideways, turned 270 degrees
- SDB-103: legend entry "gpo" not found
- SDB-104: legend entry "switch" not found
- SDB-104: legend entry "gpo" not found
- SDB-105: legend entry "gpo" not found
- SDB-105: legend entry "switch" not found
- SDB-107: scan read sideways, turned 270 degrees
- SDB-107: legend entry "smoke detector" not found
- SDB-107: label "WC" not found
- SDB-107: fill at SERVER: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-107: legend entry "downlight" not found
- SDB-107: legend entry "switch" not found
- SDB-108: legend entry "gpo" not found
- SDB-109: scan read sideways, turned 270 degrees
- SDB-109: fill at KITCHEN: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-109: fill at STAFF: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-109: legend entry "switch" not found
- SDB-110: legend entry "downlight" not found
- SDB-110: fill at SERVER: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-111: scan read sideways, turned 270 degrees
- SDB-112: scan read sideways, turned 270 degrees
- SDB-112: legend entry "downlight" not found
- SDB-112: label "BED 1" not found
- SDB-113: label "OFFICE 3" not found
- SDB-114: label "MEETING" not found
- SDB-114: legend entry "gpo" not found
- SDB-114: legend entry "smoke detector" not found
- SDB-114: legend entry "diffuser" not found
- SDB-115: legend entry "smoke detector" not found
- SDB-115: legend entry "gpo" not found
- SDB-115: fill at MEETING: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-116: scan read sideways, turned 270 degrees
- SDB-117: legend entry "downlight" not found
- SDB-117: legend entry "gpo" not found
- SDB-117: legend entry "diffuser" not found
- SDB-118: legend entry "gpo" not found
- SDB-118: fill at PLANT: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-119: scan read sideways, turned 270 degrees
- SDB-119: legend entry "gpo" not found
- SDB-121: scan read sideways, turned 270 degrees
- SDB-121: label "MEETING" not found
- SDB-121: label "STAFF" not found
- SDB-121: legend entry "downlight" not found
- SDB-121: legend entry "gpo" not found
- SDB-121: label "RECEPTION" not found
- SDB-122: fill at PRINT: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-122: legend entry "gpo" not found
- SDB-122: legend entry "switch" not found
- SDB-122: legend entry "diffuser" not found
- SDB-123: scan read sideways, turned 270 degrees
- SDB-124: scan read sideways, turned 270 degrees
- SDB-124: label "OFFICE 1" not found
- SDB-125: label "PRINT" not found
- SDB-125: legend entry "smoke detector" not found
- SDB-125: legend entry "diffuser" not found
- SDB-127: scan read sideways, turned 270 degrees
- SDB-127: legend entry "downlight" not found
- SDB-127: legend entry "smoke detector" not found
- SDB-128: legend entry "switch" not found
- SDB-128: legend entry "gpo" not found
- SDB-129: legend entry "downlight" not found
- SDB-129: legend entry "gpo" not found
- SDB-129: label "BED 1" not found
- SDB-130: legend entry "gpo" not found
- SDB-130: fill at STUDY: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-131: legend entry "smoke detector" not found
- SDB-131: legend entry "gpo" not found
- SDB-132: scan read sideways, turned 270 degrees
- SDB-132: legend entry "smoke detector" not found
- SDB-132: legend entry "downlight" not found
- SDB-132: legend entry "diffuser" not found
- SDB-133: legend entry "gpo" not found
- SDB-134: legend entry "smoke detector" not found
- SDB-134: legend entry "gpo" not found
- SDB-136: label "WC" not found
- SDB-137: fill at BED 2: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-137: fill at LAUNDRY: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-139: legend entry "gpo" not found
- SDB-139: label "OFFICE 3" not found
- SDB-140: label "WC" not found
- SDB-141: scan read sideways, turned 270 degrees
- SDB-141: fill at WC: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-141: fill at MEETING: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-142: legend entry "smoke detector" not found
- SDB-142: legend entry "downlight" not found
- SDB-142: legend entry "gpo" not found
- SDB-142: legend entry "switch" not found
- SDB-142: legend entry "diffuser" not found
- SDB-143: label "WC" not found
- SDB-145: legend entry "switch" not found
- SDB-145: legend entry "downlight" not found
- SDB-145: fill at STUDY: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-146: legend entry "diffuser" not found
- SDB-146: legend entry "gpo" not found
- SDB-146: legend entry "switch" not found
- SDB-146: label "MEETING" not found
- SDB-148: legend entry "smoke detector" not found
- SDB-149: scan read sideways, turned 270 degrees
- SDB-149: legend entry "diffuser" not found
- SDB-149: legend entry "switch" not found
- SDB-150: scan read sideways, turned 270 degrees
- SDB-150: legend entry "diffuser" not found
- SDB-151: legend entry "switch" not found
- SDB-151: legend entry "gpo" not found
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
- SDB-154: fill at WC: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-155: legend entry "switch" not found
- SDB-155: legend entry "downlight" not found
- SDB-155: legend entry "gpo" not found
- SDB-155: label "OFFICE 1" not found
- SDB-156: legend entry "diffuser" not found
- SDB-157: legend entry "gpo" not found
- SDB-157: label "WC" not found
- SDB-158: scan read sideways, turned 270 degrees
- SDB-158: legend entry "gpo" not found
- SDB-158: label "WC" not found
- SDB-159: fill at STAFF: fill is smaller than any room
- SDB-159: fill at LOBBY: fill is smaller than any room
- SDB-159: legend entry "gpo" not found
- SDB-160: legend entry "switch" not found
- SDB-161: label "ARCHIVE" not found
- SDB-161: label "STORE" not found
- SDB-161: fill at PLANT: fill is smaller than any room
- SDB-161: legend entry "smoke detector" not found
- SDB-161: label "RECEPTION" not found
- SDB-163: legend entry "gpo" not found
- SDB-164: legend entry "gpo" not found
- SDB-165: scan read sideways, turned 270 degrees
- SDB-165: legend entry "diffuser" not found
- SDB-166: legend entry "switch" not found
- SDB-166: fill at ARCHIVE: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-167: legend entry "diffuser" not found
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
- SDB-173: fill at RECEPTION: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-174: legend entry "diffuser" not found
- SDB-174: legend entry "downlight" not found
- SDB-174: label "BED 2" not found
- SDB-175: label "STORE" not found
- SDB-175: label "WC" not found
- SDB-175: label "PRINT" not found
- SDB-175: legend entry "downlight" not found
- SDB-175: legend entry "diffuser" not found
- SDB-176: label "BED 2" not found
- SDB-177: legend entry "gpo" not found
- SDB-178: legend entry "diffuser" not found
- SDB-178: legend entry "downlight" not found
- SDB-180: legend entry "gpo" not found
- SDB-180: legend entry "switch" not found
- SDB-181: scan read sideways, turned 270 degrees
- SDB-181: fill at PRINT: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-182: scan read sideways, turned 270 degrees
- SDB-182: legend entry "switch" not found
- SDB-182: label "SERVER" not found
- SDB-182: fill at STAFF: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-183: scan read sideways, turned 270 degrees
- SDB-183: legend entry "gpo" not found
- SDB-183: legend entry "downlight" not found
- SDB-183: legend entry "switch" not found
- SDB-183: legend entry "smoke detector" not found
- SDB-183: legend entry "diffuser" not found
- SDB-184: legend entry "gpo" not found
- SDB-184: label "BED 2" not found
- SDB-186: legend entry "gpo" not found
- SDB-187: legend entry "gpo" not found
- SDB-187: legend entry "diffuser" not found
- SDB-187: label "OFFICE 2" not found
- SDB-188: legend entry "gpo" not found
- SDB-189: scan read sideways, turned 270 degrees
- SDB-189: label "STUDY" not found
- SDB-189: fill at PLANT: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-189: legend entry "gpo" not found
- SDB-189: legend entry "diffuser" not found
- SDB-189: label "LIVING" not found
- SDB-190: legend entry "smoke detector" not found
- SDB-190: legend entry "diffuser" not found
- SDB-190: label "LOBBY" not found
- SDB-191: legend entry "smoke detector" not found
- SDB-192: legend entry "gpo" not found
- SDB-193: scan read sideways, turned 270 degrees
- SDB-194: legend entry "diffuser" not found
- SDB-196: legend entry "gpo" not found
- SDB-197: legend entry "gpo" not found
- SDB-198: scan read sideways, turned 270 degrees
- SDB-198: label "MEETING" not found
- SDB-198: legend entry "smoke detector" not found
- SDB-199: scan read sideways, turned 270 degrees
- SDB-200: fill at ARCHIVE: that region is not bounded by lines on all sides , draw around it with the Area tool instead
- SDB-200: fill at SERVER: that region is not bounded by lines on all sides , draw around it with the Area tool instead
