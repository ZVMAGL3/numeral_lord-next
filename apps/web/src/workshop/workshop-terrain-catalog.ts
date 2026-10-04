import type { TerrainModEntry } from "./types";

export function compareModVersions(left: string, right: string): number {
  const parse = (version: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(version);
    return match ? {
      numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4]?.split(".") ?? []
    } : null;
  };
  const a = parse(left), b = parse(right);
  if (!a || !b) return left.localeCompare(right, undefined, { numeric: true });
  for (let index = 0; index < 3; index += 1) {
    const difference = a.numbers[index]! - b.numbers[index]!;
    if (difference) return Math.sign(difference);
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const partA = a.prerelease[index], partB = b.prerelease[index];
    if (partA === undefined || partB === undefined) return partA === partB ? 0 : partA === undefined ? -1 : 1;
    const numberA = /^\d+$/.test(partA) ? Number(partA) : null;
    const numberB = /^\d+$/.test(partB) ? Number(partB) : null;
    if (numberA !== null && numberB !== null && numberA !== numberB) return Math.sign(numberA - numberB);
    if (numberA !== null && numberB === null) return -1;
    if (numberA === null && numberB !== null) return 1;
    const difference = partA.localeCompare(partB);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

/** The public catalog shows one card per Mod ID: its newest published version. */
type VersionedTerrainMod = { readonly id: string; readonly modId?: string; readonly version: string; readonly createdAt?: string };

/** Updates may be checked in the workshop, battle lobby or map preview, never mid-match. */
export function canApplySubscribedModUpdate(
  workshopIsOpen: boolean,
  matchIsActive: boolean,
  battleRoomIsOpen = false,
  mapLibraryIsOpen = false
): boolean {
  return (workshopIsOpen || battleRoomIsOpen || mapLibraryIsOpen) && !matchIsActive;
}

export interface TerrainModUpdateSubscription {
  readonly id: string;
  readonly installedVersion: string;
}

export interface TerrainModUpdateInstallation {
  readonly id: string;
  readonly version: string;
}

/**
 * Find newer published releases for explicit subscriptions and app-bundled
 * Mods. Bundled Mods are checked everywhere in the Workshop, but in a room
 * only when the map actually uses them. The returned definitions remain
 * server-authored; this helper only selects catalog entries to fetch.
 */
export function terrainModUpdateCandidates<T extends VersionedTerrainMod>(
  entries: readonly T[],
  subscriptions: readonly TerrainModUpdateSubscription[],
  installations: readonly TerrainModUpdateInstallation[],
  bundledModIds: ReadonlySet<string>,
  workshopIsOpen: boolean,
  requiredTerrainModIds: readonly string[] = []
): Array<{ readonly id: string; readonly entry: T }> {
  const latestByModId = new Map(latestTerrainModVersions(entries).map((entry) => [entry.modId ?? entry.id, entry]));
  const installedVersions = new Map(installations.map(({ id, version }) => [id, version]));
  const subscriptionsById = new Map(subscriptions.map((subscription) => [subscription.id, subscription]));
  const candidateIds = new Set(subscriptionsById.keys());
  for (const id of bundledModIds) {
    if (installedVersions.has(id) && (workshopIsOpen || requiredTerrainModIds.includes(id))) candidateIds.add(id);
  }

  return [...candidateIds].flatMap((id) => {
    const entry = latestByModId.get(id);
    const installedVersion = installedVersions.get(id) ?? subscriptionsById.get(id)?.installedVersion;
    return entry && installedVersion && compareModVersions(entry.version, installedVersion) > 0
      ? [{ id, entry }]
      : [];
  });
}

/**
 * Map previews only need fresh releases for their own dependencies. In
 * particular, bundled example Mods must be allowed to fetch Workshop artwork
 * even when the player has never subscribed to them.
 */
export function mapTerrainModUpdateCandidates<T extends VersionedTerrainMod>(
  entries: readonly T[],
  subscriptions: readonly TerrainModUpdateSubscription[],
  installations: readonly TerrainModUpdateInstallation[],
  bundledModIds: ReadonlySet<string>,
  requiredTerrainModIds: readonly string[]
): Array<{ readonly id: string; readonly entry: T }> {
  const required = new Set(requiredTerrainModIds);
  return terrainModUpdateCandidates(entries, subscriptions, installations, bundledModIds, false, [...required])
    .filter(({ id }) => required.has(id));
}

export function latestTerrainModVersions<T extends VersionedTerrainMod>(entries: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const entry of entries) {
    const modId = entry.modId ?? entry.id;
    const current = latest.get(modId);
    const versionOrder = current ? compareModVersions(entry.version, current.version) : 1;
    if (!current || versionOrder > 0
      || (versionOrder === 0 && (entry.createdAt ?? "") > (current.createdAt ?? ""))) {
      latest.set(modId, entry);
    }
  }
  return [...latest.values()];
}

/**
 * Keep installed packages visible in the workshop even when its remote catalog
 * cannot be reached. Remote publications remain authoritative when available.
 */
export function mergeWorkshopTerrainCatalog(
  remoteEntries: readonly TerrainModEntry[],
  offlineFallback: readonly TerrainModEntry[],
  installedEntries: readonly TerrainModEntry[]
): TerrainModEntry[] {
  const catalog = [...(remoteEntries.length ? remoteEntries : offlineFallback)];
  const installedByModId = new Map(installedEntries.flatMap((entry) => entry.modId ? [[entry.modId, entry] as const] : []));
  const seen = new Set<string>();
  const merged = catalog.map((entry) => {
    const modId = entry.modId ?? entry.id;
    seen.add(modId);
    const installed = installedByModId.get(modId);
    if (!installed) return entry;
    const exactInstalledRelease = compareModVersions(installed.version, entry.version) === 0
      && (!installed.contentHash || !entry.contentHash || installed.contentHash === entry.contentHash);
    const definition = entry.definition ?? (exactInstalledRelease ? installed.definition : undefined);
    return { ...entry, installed: exactInstalledRelease, ...(definition ? { definition } : {}) };
  });
  for (const entry of installedEntries) {
    const modId = entry.modId ?? entry.id;
    if (!seen.has(modId)) {
      seen.add(modId);
      merged.push(entry);
    }
  }
  return merged;
}
