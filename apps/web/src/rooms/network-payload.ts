import type { GameState } from "@numeral-lord/game-core";

/**
 * Colyseus' client message encoder expects each object to inherit
 * Object.prototype.hasOwnProperty. Some game-core dictionaries deliberately
 * use a null prototype to avoid special keys such as `__proto__`; normalize
 * null-prototype values at the network boundary before sending a snapshot.
 * Ordinary immutable objects retain their references; only changed ancestors
 * are copied, avoiding a full allocation-heavy clone on every board action.
 */
export function toNetworkPayload<T>(value: T): T {
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const normalized = toNetworkPayload(item);
      if (normalized !== item) changed = true;
      return normalized;
    });
    return (changed ? items : value) as T;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    let changed = Object.getPrototypeOf(value) === null;
    const normalized = entries.map(([key, nested]) => {
      const item = toNetworkPayload(nested);
      if (item !== nested) changed = true;
      return [key, item] as const;
    });
    return (changed ? Object.fromEntries(normalized) : value) as T;
  }
  return value;
}

/** Normalize the only network-state fields that may use null-prototype dictionaries. */
export function toNetworkGameState(state: GameState): GameState {
  return {
    ...state,
    settings: toNetworkPayload(state.settings)
  };
}
