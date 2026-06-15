/**
 * Island-related script generation for SSR
 *
 * Generates the island-specific scripts for hydration data.
 *
 * NOTE: Core streaming scripts (generateStreamingScript, generateReplacementScript)
 * live in @sigx/server-renderer/server/streaming.ts. This module only contains
 * island-specific utilities to avoid duplication.
 */

import { escapeJsonForScript } from '@sigx/server-renderer/server';
import type { IslandInfo } from '../types';

export { escapeJsonForScript };

/**
 * Generate hydration data JSON for a set of islands
 */
export function generateIslandDataScript(islandData: Record<number, IslandInfo>): string {
    if (Object.keys(islandData).length === 0) return '';
    return `\n<script type="application/json" id="__SIGX_ISLANDS__">${escapeJsonForScript(JSON.stringify(islandData))}</script>`;
}
