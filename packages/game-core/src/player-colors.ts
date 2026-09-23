/**
 * The selectable player colors ported from the nine TS1001–TS1009 soldier
 * swatches in the legacy client. Keep this list shared by the lobby relay,
 * browser UI, map loader, and headless game consumers.
 */
export const PLAYER_COLOR_OPTIONS = [
  { id: "legacy-1", name: "绯红", value: "#BB5F5F", sprite: "assets/player-colors/TS1001.png" },
  { id: "legacy-2", name: "翠绿", value: "#7BBB5E", sprite: "assets/player-colors/TS1002.png" },
  { id: "legacy-3", name: "湛蓝", value: "#4769C8", sprite: "assets/player-colors/TS1003.png" },
  { id: "legacy-4", name: "明黄", value: "#C4B43B", sprite: "assets/player-colors/TS1004.png" },
  { id: "legacy-5", name: "青绿", value: "#57AB8A", sprite: "assets/player-colors/TS1005.png" },
  { id: "legacy-6", name: "玫红", value: "#CC3563", sprite: "assets/player-colors/TS1006.png" },
  { id: "legacy-7", name: "湖蓝", value: "#53AEBB", sprite: "assets/player-colors/TS1007.png" },
  { id: "legacy-8", name: "橙金", value: "#CC8138", sprite: "assets/player-colors/TS1008.png" },
  { id: "legacy-9", name: "紫罗兰", value: "#915BBF", sprite: "assets/player-colors/TS1009.png" }
] as const;

export type PlayerColorId = (typeof PLAYER_COLOR_OPTIONS)[number]["id"];

export function getPlayerColor(colorId: string | null | undefined): string | undefined {
  return PLAYER_COLOR_OPTIONS.find((color) => color.id === colorId)?.value;
}

export function getPlayerColorSprite(colorId: string | null | undefined): string | undefined {
  return PLAYER_COLOR_OPTIONS.find((color) => color.id === colorId)?.sprite;
}
