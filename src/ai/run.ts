// One inventory run: the validated prompt/schema pair from inventory.ts
// through the provider adapter, then tolerant parse and conversion to engine
// proposals. The CLI's ai-count command is a thin wrapper around this.

import { completeVision, type ProviderConfig, type VisionImage, type VisionResult } from './providers.ts';
import { INVENTORY_PROMPT, INVENTORY_SCHEMA, INVENTORY_SCHEMA_NAME, parseInventory, toProposals, type InventoryResponse } from './inventory.ts';
import type { ProposedItem } from '../engine/inventory.ts';

export interface InventoryRun {
  items: ProposedItem[];
  inventory: InventoryResponse;
  result: VisionResult;
}

/** Ask the configured model for a floor-plan inventory of one page and turn
 *  the answer into proposed items in that page's PDF points. */
export async function runInventory(
  cfg: ProviderConfig,
  image: VisionImage,
  page: { widthPt: number; heightPt: number },
  opts: { maxTokens?: number; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<InventoryRun> {
  const result = await completeVision(
    cfg,
    {
      prompt: INVENTORY_PROMPT,
      schema: INVENTORY_SCHEMA,
      schemaName: INVENTORY_SCHEMA_NAME,
      image,
      maxTokens: opts.maxTokens,
      signal: opts.signal,
    },
    opts.fetchImpl,
  );
  const inventory = parseInventory(result.text);
  return { items: toProposals(inventory, page), inventory, result };
}
