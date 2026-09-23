import type { GameState, PlayerId } from "@numeral-lord/game-core";
import { createMatchFromMapCode, DEFAULT_MAP_CODE } from "./map-code.js";

/**
 * Compatibility entry point for the first built-in map, 昏晓. Keeping this
 * wrapper means previews, browser play, rooms and headless simulations all
 * assemble the map through the same validated map-code path.
 */
export interface DemoMatchOptions {
  /** Map player ids that actually entered from the room; omitted seats start dead. */
  readonly activePlayerIds?: readonly PlayerId[];
  readonly friendlyFire?: boolean;
}

export function createDemoMatch(options: DemoMatchOptions = {}): GameState {
  return createMatchFromMapCode(DEFAULT_MAP_CODE, options);
}
