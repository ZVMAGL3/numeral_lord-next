import { Buffer } from "node:buffer";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMatchFromMapCode, parseMapCode, serializeMapCode } from "@numeral-lord/core-content";
import { getHexNeighbours, PLAYER_COLOR_OPTIONS, type HexCoordinate } from "@numeral-lord/game-core";
import { normalizeImportedMapCode } from "./legacy-map-code.js";
import { addMapToLibrary, createPersonalMapSyncRequest, loadMapLibrary } from "./map-library.js";

const SAMPLE_CODE = "eNpjZGBgYHuyY8uzHV0SIRmZxQpAlJtYoJCSWpxclFlQkpmfp8f/fGfjsxnz3+/pebqs6VlL/7m6/RkKyvc5mIB6OaEYApigOBDEaYBgZiBmBGIWBmYwzdyAkANhFiQ1MHkWNDXo8shsZHmwXgZWFDOR1TAxMsH1ImMmJmawPDOaG0BmoZtDjHuI9RfB8EECdlkeQNcA1YI4NkCswwgJbEaQCHocgRS9ZAb5DMhgf9638um6bYZAPsMrIAEAvXdUnQ==";

interface OriginalPlayer {
  readonly seat: number;
  readonly teamMask: number;
  readonly name: string;
  readonly computer?: number;
  readonly flag: number;
}

type OriginalCell = readonly [terrain: number, owner: number, strength: number];

interface FixtureOptions {
  readonly version?: number;
  readonly title?: string;
  readonly description?: string;
  readonly author?: string;
  readonly rows?: number;
  readonly columns?: number;
  readonly players?: readonly OriginalPlayer[];
  readonly playerCount?: number;
  readonly repeatedPlayerCount?: number;
  readonly area?: number;
  readonly cells?: readonly OriginalCell[];
  readonly cylindrical?: number;
  readonly randomSpawn?: number;
  readonly starMode?: number;
  readonly fogMode?: number;
}

const DEFAULT_PLAYERS: readonly OriginalPlayer[] = [
  { seat: 1, teamMask: 1, name: "红方", flag: 1001 },
  { seat: 2, teamMask: 2, name: "蓝方", flag: 1003 }
];

/** Encode the documented original layout independently of the browser decoder. */
function originalBinary(options: FixtureOptions = {}): Buffer {
  const parts: Buffer[] = [];
  const integer = (value: number): void => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(value);
    parts.push(bytes);
  };
  const bytes = (...values: number[]): void => { parts.push(Buffer.from(values)); };
  const reserved = (length: number): void => { parts.push(Buffer.alloc(length)); };
  const string = (value: string): void => {
    const encoded = Buffer.from(value, "utf8");
    let remaining = encoded.length;
    do {
      bytes((remaining & 0x7f) | (remaining >= 128 ? 0x80 : 0));
      remaining = Math.floor(remaining / 128);
    } while (remaining > 0);
    parts.push(encoded);
  };
  const players = options.players ?? DEFAULT_PLAYERS;
  const rows = options.rows ?? 2;
  const columns = options.columns ?? 4;
  const playerCount = options.playerCount ?? players.length;
  const cells = options.cells ?? Array.from({ length: rows * columns }, (): OriginalCell => [2, 128, 0]);
  integer(options.version ?? 1);
  string(options.title ?? "原版测试地图");
  string(options.description ?? "地图描述");
  string(options.author ?? "作者");
  reserved(8); // .NET timestamp
  integer(playerCount);
  integer(rows);
  integer(columns);
  reserved(4);
  bytes(options.cylindrical ?? 0, options.randomSpawn ?? 0, 0, 3, 2, options.starMode ?? 0);
  reserved(4);
  integer(options.area ?? rows * columns);
  for (const [terrain, owner, strength] of cells) bytes(terrain, owner, strength, 0);
  reserved(24);
  bytes(options.fogMode ?? 0);
  integer(30); // Turn clock
  integer(900); // Total clock
  integer(options.repeatedPlayerCount ?? playerCount);
  for (const player of players) {
    bytes(player.seat);
    integer(player.teamMask);
    string(player.name);
    integer(player.computer ?? 0);
    integer(player.flag);
  }
  return Buffer.concat(parts);
}

function compressedCode(binary: Buffer): string {
  return deflateSync(binary).toString("base64");
}

function originalCode(options: FixtureOptions = {}): string {
  return compressedCode(originalBinary(options));
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key) { return values.get(key) ?? null; },
    key(index) { return [...values.keys()][index] ?? null; },
    removeItem(key) { values.delete(key); },
    setItem(key, value) { values.set(key, String(value)); }
  };
}

describe("original map import conversion", () => {
  beforeEach(() => { vi.stubGlobal("localStorage", memoryStorage()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("imports the supplied 临渊 map and retains every occupied unit when starting a match", async () => {
    const result = await normalizeImportedMapCode(SAMPLE_CODE);
    const definition = parseMapCode(result.code);
    expect(result.legacy).toBe(true);
    expect(definition).toMatchObject({
      version: 1,
      name: "临渊",
      columns: 9,
      players: 2,
      playerNames: ["繁星，如意", "玩家1"],
      teams: [1, 2],
      requiredTerrainModIds: [],
      soldiers: [[43, 1, 2], [37, 2, 3]],
      specialUnits: [[76, "wild", 3], [50, "wild", 5], [31, "wild", 5], [4, "wild", 3]]
    });
    expect(definition.terrain).toHaveLength(81);
    expect(definition.terrainLegend["2"]).toBe("core/stronghold");
    expect(definition.terrainLegend["4"]).toBe("core/ocean");
    const match = createMatchFromMapCode(result.code);
    expect(match.board).toEqual({ columns: 9, rows: 9 });
    expect(Object.fromEntries(Object.values(match.units).map(({ id, strength }) => [id, strength]))).toEqual({
      "seat-1-cell-43": 2,
      "seat-2-cell-37": 3,
      "wild-cell-76": 3,
      "wild-cell-50": 5,
      "wild-cell-31": 5,
      "wild-cell-4": 3
    });
  });

  it("translates all five base terrains and remaps original seats, teams, neutral pieces and flags", async () => {
    const result = await normalizeImportedMapCode(originalCode({
      rows: 2,
      columns: 4,
      players: [
        { seat: 7, teamMask: 8, name: "七号", flag: 1009 },
        { seat: 3, teamMask: 8, name: "三号", flag: 1002 }
      ],
      cells: [[0, 128, 0], [1, 3, 2], [2, 7, 9], [3, 128, 0], [4, 0, 5], [2, 255, 7], [1, 7, 0], [2, 128, 8]]
    }));
    expect(parseMapCode(result.code)).toMatchObject({
      terrain: "42120123",
      terrainLegend: { "0": "core/void", "1": "core/plain", "2": "core/stronghold", "3": "core/mountain", "4": "core/ocean" },
      playerNames: ["三号", "七号"],
      playerColors: [PLAYER_COLOR_OPTIONS[1].value, PLAYER_COLOR_OPTIONS[8].value],
      teams: [4, 4],
      soldiers: [[5, 1, 2], [6, 2, 9]],
      specialUnits: [[0, "wild", 5], [1, "blocker", 7]]
    });
  });

  it.each([3, 4])("preserves every original hex adjacency on a %i-by-5 non-square map", async (rows) => {
    const columns = 5;
    // Each unique strength identifies an original cell after conversion.
    const cells = Array.from({ length: rows * columns }, (_, index): OriginalCell => [2, 1, index + 1]);
    const result = await normalizeImportedMapCode(originalCode({
      rows, columns, cells,
      players: [{ seat: 1, teamMask: 1, name: "玩家", flag: 1001 }]
    }));
    const definition = parseMapCode(result.code);
    const coordinates = new Map<number, HexCoordinate>(definition.soldiers.map(([index, _seat, strength]) => [
      strength - 1, { row: Math.floor(index / columns), column: index % columns }
    ]));
    expect(coordinates.get(0)).toEqual({ row: rows - 1, column: rows % 2 ? columns - 1 : 0 });
    expect(coordinates.size).toBe(rows * columns);
    for (let original = 0; original < rows * columns; original += 1) {
      const row = Math.floor(original / columns);
      const column = original % columns;
      const adjacent = getHexNeighbours(coordinates.get(original)!, { rows, columns });
      const actual = [...coordinates].filter(([, coordinate]) => adjacent.some((candidate) => candidate.row === coordinate.row && candidate.column === coordinate.column))
        .map(([index]) => index).sort((left, right) => left - right);
      // Reference centers are x=(column + 0.5*rowParity)*sqrt(3), y=row*1.5.
      // Squared center distance 3 identifies adjacent hexes; integer-scaled
      // geometry avoids copying the converter's index transform into the test.
      const expected = cells.flatMap((_, candidate) => {
        const candidateRow = Math.floor(candidate / columns);
        const candidateColumn = candidate % columns;
        const dx2 = 2 * (candidateColumn - column) + candidateRow % 2 - row % 2;
        const dy = candidateRow - row;
        return 3 * dx2 * dx2 + 9 * dy * dy === 12 ? [candidate] : [];
      });
      expect(actual).toEqual(expected);
    }
  });

  it("imports all nine legacy flag colors from the shared palette", async () => {
    const players = PLAYER_COLOR_OPTIONS.map((_, index) => ({ seat: index + 1, teamMask: 1, name: `玩家${index + 1}`, flag: 1001 + index }));
    const result = await normalizeImportedMapCode(originalCode({ players }));
    expect(parseMapCode(result.code).playerColors).toEqual(PLAYER_COLOR_OPTIONS.map(({ value }) => value));
  });

  it("uses a seat color when the original flag has no legacy palette entry", async () => {
    const result = await normalizeImportedMapCode(originalCode({ players: [{ seat: 9, teamMask: 1, name: "玩家", flag: 9999 }] }));
    expect(parseMapCode(result.code).playerColors).toEqual([PLAYER_COLOR_OPTIONS[0].value]);
  });

  it.each([128, 256])("reads a %i-byte description without shifting the following fields", async (length) => {
    const result = await normalizeImportedMapCode(originalCode({ description: "x".repeat(length), author: "中文作者" }));
    expect(parseMapCode(result.code)).toMatchObject({ name: "原版测试地图", columns: 4, players: 2, playerNames: ["红方", "蓝方"], teams: [1, 2] });
    expect(result.warnings).toEqual([]);
  });

  it("reports unsupported original modes and imports their playable map content", async () => {
    const result = await normalizeImportedMapCode(originalCode({ cylindrical: 1, randomSpawn: 1, starMode: 1, fogMode: 1 }));
    expect(result.warnings.join(" ")).toMatch(/循环地图.*随机出生.*星星.*迷雾/);
    expect(parseMapCode(result.code).matchConditionIds).toEqual(["core/lose-all-survival-anchors", "core/last-team-standing"]);
  });

  it("shortens long map and seat names while warning and preserving valid Unicode", async () => {
    const result = await normalizeImportedMapCode(originalCode({
      title: "图".repeat(59) + "😀尾",
      players: [{ seat: 1, teamMask: 1, name: "玩".repeat(23) + "😀尾", flag: 1001 }]
    }));
    const definition = parseMapCode(result.code);
    expect(definition.name).toBe("图".repeat(59));
    expect(definition.playerNames).toEqual(["玩".repeat(23)]);
    expect(result.warnings.join(" ")).toContain("名称已缩短");
  });

  it("keeps the same map ID across whitespace, omitted padding and alternative zlib streams", async () => {
    const spaced = SAMPLE_CODE.replace(/(.{20})/g, "$1 \n\t");
    const inputs = [SAMPLE_CODE, spaced, SAMPLE_CODE.replace(/=+$/, "")];
    const results = await Promise.all(inputs.map(normalizeImportedMapCode));
    expect(new Set(results.map(({ code }) => parseMapCode(code).id)).size).toBe(1);
    const binary = originalBinary();
    const standard = await normalizeImportedMapCode(compressedCode(binary));
    const high = await normalizeImportedMapCode(deflateSync(binary, { level: 9 }).toString("base64"));
    expect(parseMapCode(standard.code).id).toBe(parseMapCode(high.code).id);
  });

  it("stores converted JSON in the account cache and sync operations and rejects duplicate imports", async () => {
    const converted = await normalizeImportedMapCode(SAMPLE_CODE);
    const maps = addMapToLibrary([], converted.code, " 测试账号 ");
    const sameMap = await normalizeImportedMapCode(SAMPLE_CODE.replace(/=+$/, ""));
    expect(() => addMapToLibrary(maps, sameMap.code, "测试账号")).toThrow(/已经在地图库/);
    expect(loadMapLibrary("测试账号")).toEqual(maps);
    expect(loadMapLibrary("另一账号")).toEqual([]);
    const sync = createPersonalMapSyncRequest("测试账号");
    expect(sync.cachedMaps).toEqual([{ mapId: maps[0]!.definition.id, code: maps[0]!.code }]);
    expect(sync.operations).toMatchObject([{ type: "upsert", code: maps[0]!.code }]);
    expect(JSON.parse(sync.cachedMaps[0]!.code).version).toBe(1);
    expect(serializeMapCode(maps[0]!.definition)).toBe(maps[0]!.code);
    expect(() => parseMapCode(SAMPLE_CODE)).toThrow(/JSON/);
    expect(() => addMapToLibrary([], SAMPLE_CODE)).toThrow(/JSON/);
  });

  it("passes versioned JSON through and continues to import it into the library", async () => {
    const converted = await normalizeImportedMapCode(originalCode());
    const formatted = JSON.stringify(JSON.parse(converted.code), null, 2);
    const result = await normalizeImportedMapCode(` \n${formatted}\n `);
    expect(result).toEqual({ code: formatted, legacy: false, warnings: [] });
    expect(addMapToLibrary([], result.code)[0]!.definition.version).toBe(1);
  });

  it("leaves malformed and unversioned JSON to the shared JSON parser without guessing a legacy format", async () => {
    const unversioned = JSON.parse((await normalizeImportedMapCode(originalCode())).code);
    delete unversioned.version;
    for (const code of [JSON.stringify(unversioned), '{"version":']) {
      const result = await normalizeImportedMapCode(code);
      expect(result).toEqual({ code, legacy: false, warnings: [] });
      expect(() => parseMapCode(result.code)).toThrow();
    }
  });
});

describe("invalid original maps", () => {
  it.each(["", "   ", "A", "AA=A", "A===", "💥", "-_ab", "AA==x"])("rejects malformed map code %j", async (raw) => {
    await expect(normalizeImportedMapCode(raw)).rejects.toThrow();
  });

  it("rejects damaged zlib and truncated binary data", async () => {
    await expect(normalizeImportedMapCode(Buffer.from("not zlib").toString("base64"))).rejects.toThrow(/解压失败/);
    const binary = originalBinary();
    for (const length of [3, 8, binary.length - 1]) {
      await expect(normalizeImportedMapCode(compressedCode(binary.subarray(0, length)))).rejects.toThrow(/不完整/);
    }
  });

  it.each([
    ["unsupported version", { version: 2 }, /版本/],
    ["no players", { playerCount: 0 }, /玩家位数/],
    ["too many players", { playerCount: 65 }, /玩家位数/],
    ["no rows", { rows: 0 }, /行列/],
    ["too many rows", { rows: 65 }, /行列/],
    ["too many columns", { columns: 65 }, /行列/],
    ["inconsistent area", { area: 7 }, /格数/],
    ["inconsistent player counts", { repeatedPlayerCount: 1 }, /玩家数量/],
    ["unknown terrain", { rows: 1, columns: 1, cells: [[5, 128, 0]] }, /地形编号/],
    ["unknown occupied seat", { rows: 1, columns: 1, cells: [[2, 9, 1]] }, /不存在的玩家位置/],
    ["unit on void", { rows: 1, columns: 1, cells: [[0, 1, 1]] }, /虚空或山地/],
    ["unit on mountain", { rows: 1, columns: 1, cells: [[3, 255, 1]] }, /虚空或山地/],
    ["zero team mask", { players: [{ seat: 1, teamMask: 0, name: "玩家", flag: 1001 }] }, /队伍编码/],
    ["multiple team bits", { players: [{ seat: 1, teamMask: 3, name: "玩家", flag: 1001 }] }, /队伍编码/],
    ["zero seat", { players: [{ seat: 0, teamMask: 1, name: "玩家", flag: 1001 }] }, /玩家位置/],
    ["neutral seat", { players: [{ seat: 128, teamMask: 1, name: "玩家", flag: 1001 }] }, /玩家位置/],
    ["duplicate seats", { players: [DEFAULT_PLAYERS[0]!, DEFAULT_PLAYERS[0]!] }, /玩家位置/]
  ] satisfies readonly (readonly [string, FixtureOptions, RegExp])[])("rejects %s", async (_label, options, error) => {
    await expect(normalizeImportedMapCode(originalCode(options))).rejects.toThrow(error);
  });

  it("rejects additional binary data and invalid UTF-8 text", async () => {
    await expect(normalizeImportedMapCode(compressedCode(Buffer.concat([originalBinary(), Buffer.from([0])])))).rejects.toThrow(/额外数据/);
    const brokenText = originalBinary({ title: "x" });
    brokenText[5] = 0xff;
    await expect(normalizeImportedMapCode(compressedCode(brokenText))).rejects.toThrow(/文字编码/);
  });

  it("bounds both pasted code and decompressed data to 64 KiB", async () => {
    await expect(normalizeImportedMapCode("A".repeat(64 * 1024 + 1))).rejects.toThrow(/64 KiB/);
    await expect(normalizeImportedMapCode(compressedCode(Buffer.alloc(64 * 1024 + 1)))).rejects.toThrow(/解压后超过 64 KiB/);
  });
});
