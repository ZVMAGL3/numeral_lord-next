/**
 * 同一格共用一套从底到顶的绘制层级，避免各类地形和单位自行决定前后关系。
 * 底部地形 → 棋子 → Mod 顶部图案 → 兵力数字 → 特效。
 */
export const BOARD_RENDER_Z_INDEX = {
  terrainBase: 0, // 格子底色与地形底图；位于棋子下方。
  unit: 10, // 棋子主体。
  terrainTop: 20, // 地形顶层图案（包括 Mod 图案）；位于棋子上方，但低于数字。
  unitStrength: 30, // 棋子兵力数字。
  teamEffect: 40, // 队伍高亮框。
  actionEffect: 50, // 可行动单位的脉冲效果。
  legalEffect: 60, // 合法移动格提示。
  counterattackEffect: 65, // 反击提示，高于合法移动提示。
  selectionEffect: 70 // 当前选中单位的边框，保持在最上层。
} as const;

export const BOARD_RENDER_STACK = [
  "terrainBase",
  "unit",
  "terrainTop",
  "unitStrength",
  "teamEffect",
  "actionEffect",
  "legalEffect",
  "counterattackEffect",
  "selectionEffect"
] as const satisfies readonly (keyof typeof BOARD_RENDER_Z_INDEX)[];

export function isBoardRenderStackOrdered(): boolean {
  return BOARD_RENDER_STACK.every((layer, index) => index === 0
    || BOARD_RENDER_Z_INDEX[BOARD_RENDER_STACK[index - 1]!] < BOARD_RENDER_Z_INDEX[layer]);
}
