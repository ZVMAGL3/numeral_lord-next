/** Compare numeric semantic-version components. The server catalog is the source of current Mod definitions. */
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

type VersionedTerrainMod = { readonly id: string; readonly modId?: string; readonly version: string; readonly createdAt?: string };

/** Display one current row per Mod ID even while an older database is being cleaned up. */
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
