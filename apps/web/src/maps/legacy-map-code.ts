import { serializeMapCode, type MapDefinition, type MapSoldier, type MapSpecialUnit } from "@numeral-lord/core-content";
import { PLAYER_COLOR_OPTIONS } from "@numeral-lord/game-core";
import { hashModContent } from "@numeral-lord/game-sdk";

const MAX_CODE_LENGTH = 64 * 1024;
const MAX_BINARY_LENGTH = 64 * 1024;

// Explicit format conversion at the import boundary. The shared JSON parser
// and exported maps do not depend on the original game's numeric terrain IDs.
const ORIGINAL_TERRAINS = ["core/void", "core/plain", "core/stronghold", "core/mountain", "core/ocean"] as const;

export interface ImportedMapCode {
  readonly code: string;
  readonly legacy: boolean;
  readonly warnings: readonly string[];
}

/** Accept current JSON or convert an original base64/zlib map to current JSON. */
export async function normalizeImportedMapCode(raw: string): Promise<ImportedMapCode> {
  if (!raw.trim() || raw.length > MAX_CODE_LENGTH) throw new Error("地图码为空或超过 64 KiB。");
  const code = raw.trim();
  // JSON validation, including missing versions, remains the shared parser's
  // responsibility. Broken JSON must not accidentally fall through to binary.
  try {
    JSON.parse(code);
    return { code, legacy: false, warnings: [] };
  } catch {
    if (/^(?:\{|\[|")/.test(code)) return { code, legacy: false, warnings: [] };
  }

  const compact = code.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 === 1
    || (compact.includes("=") && compact.length % 4 !== 0)) {
    throw new Error("地图码不是有效的 JSON 或原版 Base64 地图码。");
  }
  let compressed: Uint8Array<ArrayBuffer>;
  try {
    compressed = Uint8Array.from(atob(compact), (character) => character.charCodeAt(0));
  } catch {
    throw new Error("原版地图码的 Base64 编码无效。");
  }
  const binary = await decompressMap(compressed);
  return convertOriginalMap(binary);
}

async function decompressMap(compressed: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof DecompressionStream === "undefined") throw new Error("当前浏览器不支持原版地图解压，请更新浏览器后重试。");
  // Read with a bound rather than materializing an unbounded inflated Blob.
  const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > MAX_BINARY_LENGTH) {
        await reader.cancel();
        throw new Error("原版地图解压后超过 64 KiB。");
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (length > MAX_BINARY_LENGTH) throw error;
    throw new Error("原版地图码解压失败，内容可能已损坏。");
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

class ByteReader {
  private position = 0;
  private readonly view: DataView;
  constructor(private readonly data: Uint8Array<ArrayBuffer>) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  private require(length: number): void {
    if (this.position + length > this.data.length) throw new Error("原版地图数据不完整。");
  }
  byte(): number {
    this.require(1);
    return this.data[this.position++]!;
  }
  int(): number {
    this.require(4);
    const value = this.view.getUint32(this.position, true);
    this.position += 4;
    return value;
  }
  skip(length: number): void {
    this.require(length);
    this.position += length;
  }
  string(): string {
    // The reference's one/two-byte prefixes match 7-bit byte lengths:
    // 128 -> 80 01, 255 -> FF 01, 256 -> 80 02 (UTF-8 bytes, not characters).
    let length = 0;
    let shift = 0;
    let part: number;
    do {
      if (shift > 14) throw new Error("原版地图的字符串长度无效。");
      part = this.byte();
      length += (part & 0x7f) * 2 ** shift;
      shift += 7;
    } while (part >= 128);
    this.require(length);
    let value: string;
    try {
      value = new TextDecoder("utf-8", { fatal: true }).decode(this.data.subarray(this.position, this.position + length));
    } catch {
      throw new Error("原版地图的文字编码无效。");
    }
    this.position += length;
    return value;
  }
  finish(): void {
    if (this.position !== this.data.length) throw new Error("原版地图含有无法识别的额外数据。");
  }
}

function convertOriginalMap(binary: Uint8Array<ArrayBuffer>): ImportedMapCode {
  const reader = new ByteReader(binary);
  const warnings: string[] = [];
  const version = reader.int();
  if (version !== 1) throw new Error(`不支持的原版地图码版本：${version}。`);
  const title = reader.string();
  reader.string(); // Description and author have no fields in the current map.
  reader.string();
  reader.skip(8); // .NET timestamp, kept out of the current map's identity fields.
  const players = reader.int();
  const rows = reader.int();
  const columns = reader.int();
  if (players < 1 || players > 64) throw new Error("原版地图玩家位数必须在 1 到 64 之间。");
  if (rows < 1 || rows > 64 || columns < 1 || columns > 64) throw new Error("原版地图行列各必须在 1 到 64 之间。");
  reader.skip(4);
  const cylindrical = reader.byte();
  const randomSpawn = reader.byte();
  reader.skip(3); // Reserved byte and two star turn thresholds.
  const starMode = reader.byte();
  reader.skip(4);
  const area = reader.int();
  if (area !== rows * columns) throw new Error("原版地图格数与行列不一致。");

  // The original layout starts at the bottom with odd rows offset right.
  // Our layout starts at the top with even rows offset right. Reflect columns
  // for odd heights as well, so both layouts have exactly the same adjacency.
  const currentIndex = (originalIndex: number): number => {
    const row = Math.floor(originalIndex / columns);
    const column = originalIndex % columns;
    return (rows - 1 - row) * columns + (rows % 2 ? columns - 1 - column : column);
  };

  const cells: { terrain: number; owner: number; strength: number }[] = [];
  const terrainSymbols: string[] = Array(area);
  const terrainLegend: Record<string, string> = {};
  for (let index = 0; index < area; index += 1) {
    const originalTerrain = reader.byte();
    const owner = reader.byte();
    const strength = reader.byte();
    reader.skip(1);
    const terrainId = ORIGINAL_TERRAINS[originalTerrain];
    if (!terrainId) throw new Error(`不支持的原版地形编号：${originalTerrain}（第 ${index + 1} 格）。`);
    const symbol = String(originalTerrain);
    terrainSymbols[currentIndex(index)] = symbol;
    terrainLegend[symbol] = terrainId;
    cells.push({ terrain: originalTerrain, owner, strength });
  }
  reader.skip(24);
  const fogMode = reader.byte();
  reader.skip(8); // Original per-turn/total clocks are configured by current rooms.
  if (reader.int() !== players) throw new Error("原版地图的玩家数量记录不一致。");
  if (cylindrical || randomSpawn || starMode || fogMode) {
    warnings.push("原版的循环地图、随机出生、星星或迷雾设置未导入，使用当前系统的玩法。");
  }

  const seats = new Set<number>();
  const originalPlayers = Array.from({ length: players }, () => {
    const seat = reader.byte();
    const teamMask = reader.int();
    const name = reader.string();
    reader.skip(4); // Original computer type is selected in the current room.
    const flag = reader.int();
    if (seat < 1 || seat >= 128 || seats.has(seat)) throw new Error("原版地图的玩家位置无效或重复。");
    seats.add(seat);
    const teamIndex = Math.log2(teamMask);
    if (!Number.isInteger(teamIndex)) throw new Error("原版地图的队伍编码无效，必须只设置一个队伍位。");
    return { seat, team: teamIndex + 1, name, flag };
  }).sort((left, right) => left.seat - right.seat);
  reader.finish();

  const seatMap = new Map(originalPlayers.map((player, index) => [player.seat, index + 1]));
  const soldiers: MapSoldier[] = [];
  const specialUnits: MapSpecialUnit[] = [];
  for (const [originalIndex, cell] of cells.entries()) {
    const index = currentIndex(originalIndex);
    if (cell.owner === 128 || cell.strength === 0) continue;
    if (cell.terrain === 0 || cell.terrain === 3) throw new Error(`原版地图第 ${index + 1} 格在虚空或山地上放置了单位。`);
    if (cell.owner === 0 || cell.owner === 255) {
      specialUnits.push([index, cell.owner === 0 ? "wild" : "blocker", cell.strength]);
    } else {
      const seat = seatMap.get(cell.owner);
      if (!seat) throw new Error(`原版地图第 ${index + 1} 格引用了不存在的玩家位置。`);
      soldiers.push([index, seat, cell.strength]);
    }
  }
  const shortName = (value: string, limit: number, fallback: string): string => {
    const trimmed = value.trim() || fallback;
    if (trimmed.length <= limit) return trimmed;
    warnings.push("过长的地图或玩家名称已缩短。");
    return trimmed.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "");
  };
  const definition: MapDefinition = {
    version: 1,
    id: `original-${hashModContent(Array.from(binary)).slice(7)}`,
    name: shortName(title, 60, "原版地图"),
    columns,
    terrain: terrainSymbols.join(""),
    terrainLegend,
    requiredTerrainModIds: [],
    players,
    playerNames: originalPlayers.map((player, index) => shortName(player.name, 24, `玩家 ${index + 1}`)),
    playerColors: originalPlayers.map((player, index) => (PLAYER_COLOR_OPTIONS.find((color) => color.id === `legacy-${player.flag - 1000}`)
      ?? PLAYER_COLOR_OPTIONS[index % PLAYER_COLOR_OPTIONS.length]!).value),
    soldiers,
    specialUnits,
    teams: originalPlayers.map((player) => player.team),
    matchConditionIds: ["core/lose-all-survival-anchors", "core/last-team-standing"]
  };
  return { code: serializeMapCode(definition), legacy: true, warnings: [...new Set(warnings)] };
}
