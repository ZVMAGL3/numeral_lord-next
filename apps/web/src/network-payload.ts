/**
 * Colyseus' client message encoder expects each object to inherit
 * Object.prototype.hasOwnProperty. Some game-core dictionaries deliberately
 * use a null prototype to avoid special keys such as `__proto__`; normalize
 * every nested value at the network boundary before sending a snapshot.
 */
export function toNetworkPayload<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => toNetworkPayload(item)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, toNetworkPayload(nested)])
    ) as T;
  }
  return value;
}
