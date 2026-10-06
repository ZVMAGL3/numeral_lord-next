<script setup lang="ts">
import { Application, Assets, BitmapFont, BitmapText, Container, Graphics, Rectangle, Sprite, Texture, type FederatedPointerEvent } from "pixi.js";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { CellId, GameState, PlayerId, TerrainCatalog, TerrainVisualSpec, UnitId } from "@numeral-lord/game-core";
import { getBoardWheelZoomFactor, MAX_BOARD_ZOOM, MIN_BOARD_ZOOM, zoomBoardCameraAtPoint } from "../board/board-camera.js";
import { shouldCreateCellHitTarget } from "../board/board-cell-hit-target.js";
import { findBoardCellAtPoint } from "../board/board-hit-test.js";
import { getMovementHintCellIds } from "../board/board-interaction.js";
import { boardLayoutChanged, GAME_BOARD_HEX_RADIUS, getBoardHexRadius, type BoardLayoutSnapshot } from "../board/board-layout.js";
import { BOARD_RENDER_Z_INDEX } from "../board/board-render-order.js";
import { getTerrainArtPlacement, getTerrainHexCoordinates, TERRAIN_ART_FOOTPRINT_SCALE, type TerrainArtPlacement } from "../board/terrain-art-geometry.js";
import { loadTerrainImageTexture } from "../board/terrain-image-texture.js";
import { resolveTerrainArtwork } from "../board/terrain-render-model.js";
import { replaceTerrainScene } from "../board/terrain-scene.js";
import { getUnitRenderScale, getUnitStrengthFontSize, UNIT_BODY_ALPHA, UNIT_DETAIL_ALPHA } from "../board/unit-render-style.js";

const props = withDefaults(defineProps<{
  state: GameState;
  selectedUnitId: UnitId | null;
  legalActionCellIds: readonly CellId[];
  /** 有反击能力的合法进攻目标。 */
  counterattackCellIds?: readonly CellId[];
  /** 因能力、次数限制或行动耗尽而不能反击的合法进攻目标。 */
  noCounterattackCellIds?: readonly CellId[];
  actionableUnitIds: readonly UnitId[];
  /** 需要高亮兵力数字的单位，也可能包含对手下一回合可行动的单位。 */
  highlightedUnitIds?: readonly UnitId[];
  poweredUnitIds: readonly UnitId[];
  /** 大厅地图预览使用的紧凑只读渲染。 */
  preview?: boolean;
  /** 地图编辑器复用实际渲染器，并接收格子点击。 */
  editable?: boolean;
  /** 紧凑地图卡片隐藏兵力数字，但保留棋子图像。 */
  showUnitLabels?: boolean;
  /** 地图编辑器提供的相机参数；与 CSS 变换不同，不会改变布局测量值。 */
  viewZoom?: number;
  viewPan?: Readonly<{ x: number; y: number }>;
  /** 只给指定玩家的单位添加悬停圈，不影响队友。 */
  highlightedPlayerId?: PlayerId | null;
  /** 地图绑定的地形定义与资源，确保固定版本的 Mod 按原样显示。 */
  terrainCatalog?: TerrainCatalog | undefined;
  terrainVisualAssets?: Readonly<Record<string, Readonly<Record<string, string>>>> | undefined;
}>(), { showUnitLabels: true, highlightedPlayerId: null });

const emit = defineEmits<{
  cellClick: [cellId: CellId, hitTestMs?: number];
  backgroundClick: [];
  boardDrawMeasured: [measurement: {
    sequence: number;
    durationMs: number;
    layoutMs: number;
    terrainDrawMs: number;
    unitDrawMs: number;
    labelDrawMs: number;
    cellCount: number;
    unitCount: number;
    unitCellsRebuilt: number;
    unitCellsReused: number;
    pulsesRebuilt: number;
  }];
  interactionDrawMeasured: [measurement: { sequence: number; durationMs: number }];
  cellPressStart: [cellId: CellId];
  cellPressEnd: [cellId: CellId];
  cellPointerEnter: [cellId: CellId];
  cellPointerLeave: [];
}>();
const canvasHost = ref<HTMLDivElement | null>(null);
let app: Application | undefined;
let observer: ResizeObserver | undefined;
let pulseTick: (() => void) | undefined;
let cameraLayer: Container | undefined;
const actionPulses = new Map<UnitId, ActionPulse>();
const renderedUnitCells = new Map<CellId, {
  readonly key: string;
  readonly layers: readonly { readonly layer: Container; readonly container: Container }[];
}>();
let interactionLayers: { legal: Container; counterattack: Container; selection: Container } | undefined;
let terrainLayer: Container | undefined;
let unitLayer: Container | undefined;
let terrainOverlayLayer: Container | undefined;
let unitStrengthLayer: Container | undefined;
let unitArtLayer: Container | undefined;
let unitHoverLayer: Container | undefined;
let actionPulseLayer: Container | undefined;
let layoutColumns = 0;
let layoutRows = 0;
let layoutWidth = 0;
let layoutHeight = 0;
let layoutRevision = 0;
let terrainVisualRevision = "";
let cellCoordinates = new Map<CellId, GameState["cells"][CellId]["coordinate"]>();
let terrainByCell = new Map<CellId, string>();
let occupiedByCell = new Map<CellId, boolean>();
let lastInteractionOverlayDraw: {
  readonly state: GameState;
  readonly selectedUnitId: UnitId | null;
  readonly legalActionCellIds: readonly CellId[];
  readonly counterattackCellIds: readonly CellId[];
  readonly noCounterattackCellIds: readonly CellId[];
  readonly layoutRevision: number;
} | undefined;
const emptyCellIds: readonly CellId[] = [];
const pointers = new Map<number, { x: number; y: number }>();
const pressedCellIds = new Map<number, CellId>();
let cameraZoom = 1;
let cameraPan = { x: 0, y: 0 };
let previewRenderFrame: number | undefined;
let dragOrigin: { x: number; y: number; panX: number; panY: number } | undefined;
let pinchOrigin: { distance: number; zoom: number; x: number; y: number; panX: number; panY: number } | undefined;
let cameraMovedAt = 0;
const cellLayouts = new Map<CellId, { x: number; y: number; radius: number }>();
const powered = computed(() => new Set(props.poweredUnitIds));
const actionableUnits = computed(() => new Set(props.actionableUnitIds));
const UNIT_STRENGTH_BITMAP_FONT = "NumeralLordUnitStrength";
let unitStrengthBitmapFontInstalled = false;

interface ActionPulse {
  readonly graphic: Graphics;
  readonly baseRadius: number;
  readonly phaseOffset: number;
  readonly cellId: CellId;
}

const terrainColors: Record<string, number> = {
  "core/void": 0x101927, "core/mountain": 0x71809c,
  "core/plain": 0x63985d
};
/** 原有地形与棋子素材使用统一的资源地址和缓存。 */
const legacyAssetUrl = (fileName: string): string => `${import.meta.env.BASE_URL}legacy/${fileName}`;
const legacyTextureUrls = {
  plainHex: legacyAssetUrl("TS0_Simple.svg"),
  plainHexMask: legacyAssetUrl("TS0_RoundedHexMask.svg"),
  water: legacyAssetUrl("TS_Water.png"),
  mountain: legacyAssetUrl("TS_Mountain.png"),
  stronghold: legacyAssetUrl("TS_Stronghold.png")
} as const;
/** 内置地形也只声明底图与顶图，随后交给与 Mod 相同的解析和绘制流程。 */
const coreTerrainVisualAssets: Readonly<Record<string, string>> = {
  mountain: legacyTextureUrls.mountain,
  plain: legacyTextureUrls.plainHex,
  strongholdBase: legacyTextureUrls.plainHex,
  strongholdTop: legacyTextureUrls.stronghold,
  water: legacyTextureUrls.water
};
const coreTerrainVisuals: Readonly<Record<string, TerrainVisualSpec>> = {
  "core/mountain": { baseAssetId: "mountain" },
  "core/plain": { baseAssetId: "plain" },
  "core/stronghold": {
    baseAssetId: "strongholdBase",
    overlay: { assetId: "strongholdTop", scale: 1, opacity: 1, offsetX: 0, offsetY: 0 }
  },
  "core/ocean": { baseAssetId: "water" }
};
const loadedLegacyTextures = new Map<string, Texture>();
const loadedTerrainTextures = new Map<string, Texture>();
const loadingTerrainTextures = new Set<string>();
const terrainTextureWaiters = new Map<string, Set<() => void>>();
let loadedTerrainTextureRevision = 0;

function zoomIn(): void {
  if (!app || props.preview || props.editable) return;
  cameraZoom = Math.min(MAX_BOARD_ZOOM, cameraZoom * 1.2);
  applyCamera();
}

function zoomOut(): void {
  if (!app || props.preview || props.editable) return;
  cameraZoom = Math.max(MIN_BOARD_ZOOM, cameraZoom / 1.2);
  applyCamera();
}

function resetZoom(): void {
  if (!app || props.preview || props.editable) return;
  cameraZoom = 1;
  cameraPan = { x: 0, y: 0 };
  applyCamera();
}

defineExpose({ zoomIn, zoomOut, resetZoom });

onMounted(async () => {
  const host = canvasHost.value;
  if (!host) return;
  const instance = new Application();
  app = instance;
  const initialWidth = Math.max(1, host.clientWidth);
  const initialHeight = Math.max(1, host.clientHeight);
  const resolution = Math.min(window.devicePixelRatio || 1, host.clientWidth <= 680 ? 3 : 2);
  let rendererWidth = initialWidth;
  let rendererHeight = initialHeight;
  try {
    await instance.init({
      // 编辑器使用不透明背景，避免不同设备合成 WebGL 透明层时露出画布边界。
      background: props.editable ? "#161c28" : "#182638",
      backgroundAlpha: 1,
      antialias: true,
      width: initialWidth,
      height: initialHeight,
      resolution,
      autoDensity: true,
      // Editor and preview boards are static until data or the camera changes.
      // Avoid redrawing thousands of cells on every idle animation frame.
      autoStart: !props.preview
    });
  } catch (error) {
    if (app === instance) app = undefined;
    console.error("Pixi board initialization failed.", error);
    return;
  }
  // Pixi 或美术资源还在异步加载时组件可能已卸载；已销毁的实例不能继续初始化。
  if (app !== instance || !canvasHost.value) return;
  if (props.editable) {
    host.style.background = "#161c28";
    instance.canvas.style.background = "#161c28";
  }
  // 根舞台固定覆盖整个视口；只移动棋盘容器，拖动时命中区域不会跟着棋盘跑掉。
  instance.stage.eventMode = props.preview && !props.editable ? "none" : "static";
  instance.stage.hitArea = new Rectangle(0, 0, initialWidth, initialHeight);
  cameraLayer = new Container();
  cameraLayer.label = "board-camera";
  cameraLayer.sortableChildren = true;
  cameraLayer.eventMode = "passive";
  terrainLayer = new Container();
  terrainLayer.label = "terrain-and-hit-targets";
  terrainLayer.zIndex = BOARD_RENDER_Z_INDEX.terrainBase;
  terrainLayer.eventMode = props.editable ? "passive" : "none";
  // 同一格的前后关系统一由 board-render-order.ts 管理，不按创建先后碰运气。
  unitLayer = new Container();
  unitLayer.label = "units-and-terrain-effects";
  unitLayer.sortableChildren = true;
  unitLayer.eventMode = "none";
  unitLayer.interactiveChildren = false;
  unitLayer.zIndex = BOARD_RENDER_Z_INDEX.unit;
  terrainOverlayLayer = new Container();
  terrainOverlayLayer.label = "terrain-top-art";
  terrainOverlayLayer.zIndex = BOARD_RENDER_Z_INDEX.terrainTop;
  terrainOverlayLayer.eventMode = "none";
  terrainOverlayLayer.interactiveChildren = false;
  unitStrengthLayer = new Container();
  unitStrengthLayer.label = "unit-strength-numbers";
  unitStrengthLayer.zIndex = BOARD_RENDER_Z_INDEX.unitStrength;
  unitStrengthLayer.eventMode = "none";
  unitStrengthLayer.interactiveChildren = false;
  unitArtLayer = new Container();
  unitArtLayer.label = "unit-bodies-by-cell";
  unitHoverLayer = new Container();
  unitHoverLayer.label = "team-hover-frames";
  unitHoverLayer.zIndex = BOARD_RENDER_Z_INDEX.teamEffect;
  actionPulseLayer = new Container();
  actionPulseLayer.label = "action-pulses";
  actionPulseLayer.zIndex = BOARD_RENDER_Z_INDEX.actionEffect;
  unitLayer.addChild(unitArtLayer);
  cameraLayer.addChild(terrainLayer, unitLayer, terrainOverlayLayer, unitStrengthLayer,
    unitHoverLayer, actionPulseLayer);
  instance.stage.addChild(cameraLayer);
  if (!props.preview) {
    instance.stage.on("pointertap", onBoardBackgroundTap);
    instance.stage.on("pointerdown", onCameraPointerDown);
    instance.stage.on("pointerdown", onBoardCellPressStart);
    instance.stage.on("pointermove", onCameraPointerMove);
    instance.stage.on("pointerup", onCameraPointerUp);
    instance.stage.on("pointerup", onBoardCellPressEnd);
    instance.stage.on("pointerupoutside", onCameraPointerUp);
    instance.stage.on("pointerupoutside", onBoardCellPressEnd);
    instance.stage.on("pointercancel", onCameraPointerUp);
    instance.stage.on("pointercancel", onBoardCellPressEnd);
    instance.stage.on("pointerout", onBoardPointerOut);
  }
  Object.assign(instance.canvas.style, { position: "absolute", inset: "0", zIndex: "0" });
  host.appendChild(instance.canvas);
  // 缓存已经解析的 Texture，重复绘制时不再解析相同地址，也避免无意义的缓存警告。
  try {
    const loaded = await Promise.all(Object.values(legacyTextureUrls).map(async (url) => [
      url,
      await Assets.load<Texture>(url)
    ] as const));
    for (const [url, texture] of loaded) loadedLegacyTextures.set(url, texture);
  } catch (error) {
    // 可选图片缺失时不能影响棋盘规则；地形底色仍会绘制，地图资源修复期间也能继续使用。
    console.warn("Legacy board artwork could not be loaded; using base fills.", error);
  }
  if (app !== instance || !canvasHost.value) return;
  if (props.showUnitLabels !== false && !unitStrengthBitmapFontInstalled) {
    BitmapFont.install({
      name: UNIT_STRENGTH_BITMAP_FONT,
      style: { fontFamily: "Arial, sans-serif", fontWeight: "900", fontSize: 128, fill: "#ffffff" },
      chars: "0123456789",
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      skipKerning: true
    });
    unitStrengthBitmapFontInstalled = true;
  }
  observer = new ResizeObserver(() => {
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    if (app !== instance || (width === rendererWidth && height === rendererHeight)) return;
    rendererWidth = width;
    rendererHeight = height;
    // ResizeObserver 是唯一的尺寸入口，避免 Pixi 的 window.resize 再先清屏、后重绘。
    instance.renderer.resize(width, height);
    draw();
  });
  observer.observe(host);
  if (!props.preview) {
    pulseTick = () => updateActionPulses(performance.now());
    instance.ticker.add(pulseTick);
    window.addEventListener("keydown", onBoardZoomShortcut, true);
  }
  draw();
});
onBeforeUnmount(() => {
  const host = canvasHost.value;
  observer?.disconnect();
  observer = undefined;
  const instance = app;
  app = undefined;
  if (!instance) return;
  if (previewRenderFrame !== undefined) cancelAnimationFrame(previewRenderFrame);
  previewRenderFrame = undefined;
  if (pulseTick) instance.ticker.remove(pulseTick);
  pulseTick = undefined;
  window.removeEventListener("keydown", onBoardZoomShortcut, true);
  instance.stage.off("pointertap", onBoardBackgroundTap);
  instance.stage.off("pointerdown", onCameraPointerDown);
  instance.stage.off("pointerdown", onBoardCellPressStart);
  instance.stage.off("pointermove", onCameraPointerMove);
  instance.stage.off("pointerup", onCameraPointerUp);
  instance.stage.off("pointerup", onBoardCellPressEnd);
  instance.stage.off("pointerupoutside", onCameraPointerUp);
  instance.stage.off("pointerupoutside", onBoardCellPressEnd);
  instance.stage.off("pointercancel", onCameraPointerUp);
  instance.stage.off("pointercancel", onBoardCellPressEnd);
  instance.stage.off("pointerout", onBoardPointerOut);
  pointers.clear();
  pressedCellIds.clear();
  actionPulses.clear();
  renderedUnitCells.clear();
  interactionLayers = undefined;
  terrainLayer = undefined;
  unitLayer = undefined;
  terrainOverlayLayer = undefined;
  unitStrengthLayer = undefined;
  unitArtLayer = undefined;
  unitHoverLayer = undefined;
  actionPulseLayer = undefined;
  cameraLayer = undefined;
  layoutColumns = 0;
  layoutRows = 0;
  layoutWidth = 0;
  layoutHeight = 0;
  layoutRevision = 0;
  terrainVisualRevision = "";
  cellCoordinates.clear();
  terrainByCell.clear();
  occupiedByCell.clear();
  lastInteractionOverlayDraw = undefined;
  cellLayouts.clear();
  for (const waiters of terrainTextureWaiters.values()) waiters.delete(draw);
  try {
    instance.destroy(true);
  } catch {
    // 热更新可能只替换了 Pixi 尺寸插件的一部分；兜底移除旧画布，避免它拦截新组件输入。
    host?.querySelector("canvas")?.remove();
  }
});
// 规则会整体替换不可变的 GameState 快照；无需深度遍历，选择单位也不应重建地形、文字或命中区域。
watch(() => [props.state, props.actionableUnitIds, props.highlightedUnitIds, props.poweredUnitIds], draw);
watch(() => [props.terrainCatalog, props.terrainVisualAssets], draw, { deep: true });
watch(() => props.highlightedPlayerId, draw);
watch(() => [props.selectedUnitId, props.legalActionCellIds, props.counterattackCellIds,
  props.noCounterattackCellIds], drawInteractionOverlay);
watch(() => [props.viewZoom, props.viewPan], () => applyCamera());

function draw(): void {
  if (!app || !canvasHost.value || !terrainLayer || !unitLayer || !terrainOverlayLayer || !unitStrengthLayer
    || !unitArtLayer || !unitHoverLayer || !actionPulseLayer) return;
  const baseTerrainLayer = terrainLayer;
  const topTerrainLayer = terrainOverlayLayer;
  const drawStartedAt = performance.now();
  const { width, height } = canvasHost.value.getBoundingClientRect();
    // 切换标签页或热更新时尺寸可能短暂变成 0；没有有效绘制尺寸前保留上一帧。
  if (width < 1 || height < 1) return;
  const { columns, rows } = props.state.board;
  const cells = Object.values(props.state.cells);
  const nextTerrainVisualRevision = getTerrainVisualRevision();
  const layoutStartedAt = performance.now();
  const layoutChanged = boardLayoutChanged({
    columns: layoutColumns,
    rows: layoutRows,
    width: layoutWidth,
    height: layoutHeight,
    coordinates: cellCoordinates
  } satisfies BoardLayoutSnapshot, { columns, rows, width, height, cells });
  let terrainChanged = layoutChanged || nextTerrainVisualRevision !== terrainVisualRevision;
  let occupiedOverlayChanged = false;
  for (const cell of cells) {
    if (!layoutChanged && terrainByCell.get(cell.id) !== cell.terrainId) terrainChanged = true;
    const occupied = Boolean(cell.unitId && props.state.units[cell.unitId]);
    if (!layoutChanged && occupiedByCell.get(cell.id) !== occupied
      && props.terrainCatalog?.[cell.terrainId]?.visuals?.overlay?.whenOccupied) {
      occupiedOverlayChanged = true;
    }
    if (!layoutChanged) occupiedByCell.set(cell.id, occupied);
  }
  if (layoutChanged) {
    cellLayouts.clear();
    cellCoordinates.clear();
    terrainByCell.clear();
    occupiedByCell.clear();
    layoutColumns = columns;
    layoutRows = rows;
    layoutWidth = width;
    layoutHeight = height;
    layoutRevision += 1;
  }
  terrainVisualRevision = nextTerrainVisualRevision;
  app.stage.hitArea = new Rectangle(0, 0, width, height);
  const horizontalUnit = Math.sqrt(3);
  const padding = props.preview ? 14 : 44;
  // 对局保持固定世界格子尺寸；预览和编辑器先适配画布，再由各自的相机缩放。
  const radius = getBoardHexRadius(width, height, columns, rows, padding, props.preview ?? false, GAME_BOARD_HEX_RADIUS);
  const boardWidth = horizontalUnit * radius * (columns + 0.5);
  const boardHeight = 2 * radius + 1.5 * radius * (rows - 1);
  const offsetX = (width - boardWidth) / 2 + horizontalUnit * radius / 2;
  const offsetY = (height - boardHeight) / 2 + radius;

  if (layoutChanged) {
    for (const cell of cells) {
      // 旧版 getTile() 会把偶数行右移；这里必须与 getHexNeighbours() 一致，避免画面邻格和规则邻格不同。
      const x = offsetX + horizontalUnit * radius * (cell.coordinate.column + ((cell.coordinate.row + 1) % 2) * 0.5);
      const y = offsetY + 1.5 * radius * cell.coordinate.row;
      cellLayouts.set(cell.id, { x, y, radius });
      cellCoordinates.set(cell.id, { column: cell.coordinate.column, row: cell.coordinate.row });
      terrainByCell.set(cell.id, cell.terrainId);
      occupiedByCell.set(cell.id, Boolean(cell.unitId && props.state.units[cell.unitId]));
    }
  } else if (terrainChanged) {
    for (const cell of cells) {
      terrainByCell.set(cell.id, cell.terrainId);
      occupiedByCell.set(cell.id, Boolean(cell.unitId && props.state.units[cell.unitId]));
    }
  }

  const layoutMs = performance.now() - layoutStartedAt;
  const terrainStartedAt = performance.now();
  if (terrainChanged) {
    replaceTerrainScene(baseTerrainLayer, topTerrainLayer, () => {
      for (const cell of cells) {
        const layout = cellLayouts.get(cell.id);
        if (!layout || !shouldCreateCellHitTarget(cell.terrainId, props.editable ?? false)) continue;
        const { x, y } = layout;
        if (cell.terrainId !== "core/void") drawTerrainLayer(baseTerrainLayer, topTerrainLayer, cell.terrainId, x, y, radius,
          props.terrainCatalog?.[cell.terrainId]?.visuals, props.terrainVisualAssets?.[cell.terrainId] ?? {},
          Boolean(cell.unitId && props.state.units[cell.unitId]));
        // 地形点击区域与画面同步重建，但不参与可见绘制。
        const tile = new Graphics().poly(getTerrainHexCoordinates(x, y, radius * TERRAIN_ART_FOOTPRINT_SCALE))
          .fill({ color: 0xffffff, alpha: 0.001 });
        if (props.preview && !props.editable) tile.eventMode = "none";
        else if (props.editable) {
          tile.eventMode = "static";
          tile.cursor = "pointer";
          tile.on("pointertap", () => emit("cellClick", cell.id));
          tile.on("pointerover", () => emit("cellPointerEnter", cell.id));
          tile.on("pointerdown", () => emit("cellPressStart", cell.id));
        } else tile.eventMode = "none";
        baseTerrainLayer.addChild(tile);
      }
    });
  } else if (occupiedOverlayChanged) {
    for (const child of topTerrainLayer.removeChildren()) child.destroy({ children: true });
    for (const cell of cells) {
      const layout = cellLayouts.get(cell.id);
      if (!layout || cell.terrainId === "core/void") continue;
      const definition = getTerrainVisualDefinition(cell.terrainId,
        props.terrainCatalog?.[cell.terrainId]?.visuals,
        props.terrainVisualAssets?.[cell.terrainId] ?? {});
      drawTerrainOverlayVisual(topTerrainLayer, layout.x, layout.y, layout.radius,
        definition.visuals, definition.assets, Boolean(cell.unitId && props.state.units[cell.unitId]));
    }
  }
  const terrainDrawMs = performance.now() - terrainStartedAt;

  const unitsStartedAt = performance.now();
  let unitCellsRebuilt = 0;
  let unitCellsReused = 0;
  let pulsesRebuilt = 0;
  if (layoutChanged) {
    for (const [cellId, rendered] of renderedUnitCells) {
      removeRenderedCellVisual(rendered);
      renderedUnitCells.delete(cellId);
    }
  }
  const poweredUnitIds = powered.value;
  const actionableUnitIdSet = actionableUnits.value;
  const visiblePulseUnitIds = new Set<UnitId>();

  // 移动时保留静态地形和未变化的棋子图像；普通移动只影响起点和终点，不应重建所有 Pixi 对象。
  for (const cell of cells) {
    const unit = cell.unitId ? props.state.units[cell.unitId] : undefined;
    const layout = cellLayouts.get(cell.id);
    if (!layout) continue;
    const { x, y, radius } = layout;
    const player = unit ? props.state.players[unit.ownerId] : undefined;
    const isPowered = unit ? poweredUnitIds.has(unit.id) : false;
    const isHighlighted = Boolean(unit && props.highlightedPlayerId === unit.ownerId);
    const hasCellArtwork = Boolean(unit);
    const visualKey = hasCellArtwork
      ? [cell.terrainId, unit?.id, unit?.ownerId, unit?.definitionId, unit?.strength,
        player?.color, isPowered, isHighlighted].join("\u0000")
      : undefined;
    const previousVisual = renderedUnitCells.get(cell.id);
    if (!hasCellArtwork) {
      if (previousVisual) {
        removeRenderedCellVisual(previousVisual);
        renderedUnitCells.delete(cell.id);
      }
    } else if (!layoutChanged && previousVisual?.key === visualKey) {
      unitCellsReused += 1;
    } else {
      if (previousVisual) {
        removeRenderedCellVisual(previousVisual);
      }
      const layers: Array<{ layer: Container; container: Container }> = [];
      if (unit) {
        const cellArt = new Container();
        cellArt.label = `unit-body-${cell.id}`;
        cellArt.eventMode = "none";
        cellArt.interactiveChildren = false;
        const neutralColor = unit.definitionId === "core/wild" ? 0xc28a4c : 0x8491a4;
        const unitScale = getUnitRenderScale(isPowered);
        const unitPlacement = getTerrainArtPlacement(x, y, radius, unitScale);
        addCellSprite(cellArt, createLegacySprite(legacyTextureUrls.plainHexMask), unitPlacement,
          UNIT_BODY_ALPHA, player ? colorNumber(player.color) : neutralColor);
        addCellSprite(cellArt, createLegacySprite(legacyTextureUrls.plainHex),
          unitPlacement, UNIT_DETAIL_ALPHA, 0xffffff);
        unitArtLayer.addChild(cellArt);
        layers.push({ layer: unitArtLayer, container: cellArt });
      }
      if (isHighlighted) {
        const hoverArt = new Container();
        hoverArt.label = `team-hover-${cell.id}`;
        hoverArt.eventMode = "none";
        hoverArt.interactiveChildren = false;
        const hoverFrame = new Graphics().poly(getTerrainHexCoordinates(x, y, radius * 0.82))
          .stroke({ color: 0xffdc75, width: Math.max(2, radius * 0.075), alpha: 0.96 });
        hoverFrame.eventMode = "none";
        hoverArt.addChild(hoverFrame);
        unitHoverLayer.addChild(hoverArt);
        layers.push({ layer: unitHoverLayer, container: hoverArt });
      }
      renderedUnitCells.set(cell.id, { key: visualKey!, layers });
      unitCellsRebuilt += 1;
    }

    if (!unit || props.preview || !actionableUnitIdSet.has(unit.id)) continue;
    visiblePulseUnitIds.add(unit.id);
    const phaseOffset = (cell.coordinate.column * 0.13 + cell.coordinate.row * 0.07) % 1;
    const previousPulse = actionPulses.get(unit.id);
    if (!previousPulse) {
      const pulse = new Graphics();
      pulse.eventMode = "none";
      pulse.position.set(x, y);
      // 行动脉冲始终显示在地块图案上方，避免被后绘制的六边形遮住。
      pulse.circle(0, 0, radius).stroke({ color: 0xffffff, width: 8 });
      actionPulseLayer.addChild(pulse);
      actionPulses.set(unit.id, { graphic: pulse, cellId: cell.id, baseRadius: radius, phaseOffset });
      pulsesRebuilt += 1;
    } else if (layoutChanged || previousPulse.cellId !== cell.id || previousPulse.baseRadius !== radius) {
      previousPulse.graphic.clear();
      previousPulse.graphic.position.set(x, y);
      previousPulse.graphic.circle(0, 0, radius).stroke({ color: 0xffffff, width: 8 });
      actionPulses.set(unit.id, { graphic: previousPulse.graphic, cellId: cell.id, baseRadius: radius, phaseOffset });
      pulsesRebuilt += 1;
    }
  }
  for (const [cellId, rendered] of renderedUnitCells) {
    if (props.state.cells[cellId]) continue;
    removeRenderedCellVisual(rendered);
    renderedUnitCells.delete(cellId);
  }
  for (const [unitId, pulse] of actionPulses) {
    if (visiblePulseUnitIds.has(unitId)) continue;
    actionPulseLayer.removeChild(pulse.graphic);
    pulse.graphic.destroy();
    actionPulses.delete(unitId);
  }
  const unitDrawMs = performance.now() - unitsStartedAt;

  if (!interactionLayers) {
    const legal = new Container();
    const counterattack = new Container();
    const selection = new Container();
    legal.zIndex = BOARD_RENDER_Z_INDEX.legalEffect;
    counterattack.zIndex = BOARD_RENDER_Z_INDEX.counterattackEffect;
    selection.zIndex = BOARD_RENDER_Z_INDEX.selectionEffect;
    for (const layer of [legal, counterattack, selection]) {
      layer.eventMode = "none";
      layer.interactiveChildren = false;
      cameraLayer?.addChild(layer);
    }
    interactionLayers = { legal, counterattack, selection };
  }
  applyCamera(width, height);
  drawInteractionOverlay();
  const labelStartedAt = performance.now();
  drawUnitStrengthLabels();
  const labelDrawMs = performance.now() - labelStartedAt;
  updateActionPulses(performance.now());
  emit("boardDrawMeasured", {
    sequence: props.state.sequence,
    durationMs: performance.now() - drawStartedAt,
    layoutMs,
    terrainDrawMs,
    unitDrawMs,
    labelDrawMs,
    cellCount: cells.length,
    unitCount: Object.keys(props.state.units).length,
    unitCellsRebuilt,
    unitCellsReused,
    pulsesRebuilt
  });
  requestPreviewRender();
}

function getTerrainVisualRevision(): string {
  const terrainVisuals = Object.entries(props.terrainCatalog ?? {})
    .flatMap(([id, terrain]) => terrain.visuals ? [`${id}:${JSON.stringify(terrain.visuals)}`] : []);
  const assets = Object.entries(props.terrainVisualAssets ?? {}).flatMap(([terrainId, terrainAssets]) =>
    Object.entries(terrainAssets).map(([id, dataUrl]) => `${terrainId}/${id}:${dataUrl.length}:${dataUrl.slice(0, 20)}:${dataUrl.slice(-12)}`));
  return `${loadedTerrainTextureRevision}#${terrainVisuals.join("|")}#${assets.join("|")}`;
}

function removeRenderedCellVisual(rendered: {
  readonly layers: readonly { readonly layer: Container; readonly container: Container }[];
}): void {
  for (const { layer, container } of rendered.layers) {
    layer.removeChild(container);
    container.destroy({ children: true });
  }
}

/** 这里只绘制当前客户端选中的单位及其合法目标。 */
function drawInteractionOverlay(): void {
  if (!interactionLayers) return;
  const counterattackCellIds = props.counterattackCellIds ?? emptyCellIds;
  const noCounterattackCellIds = props.noCounterattackCellIds ?? emptyCellIds;
  const previous = lastInteractionOverlayDraw;
  if (previous
    && previous.state === props.state
    && previous.selectedUnitId === props.selectedUnitId
    && previous.legalActionCellIds === props.legalActionCellIds
    && previous.counterattackCellIds === counterattackCellIds
    && previous.noCounterattackCellIds === noCounterattackCellIds
    && previous.layoutRevision === layoutRevision) return;
  lastInteractionOverlayDraw = {
    state: props.state,
    selectedUnitId: props.selectedUnitId,
    legalActionCellIds: props.legalActionCellIds,
    counterattackCellIds,
    noCounterattackCellIds,
    layoutRevision
  };
  const drawStartedAt = performance.now();
  for (const layer of Object.values(interactionLayers)) {
    layer.removeChildren().forEach((child) => child.destroy());
  }
  const movementHintCellIds = getMovementHintCellIds(
    props.legalActionCellIds,
    counterattackCellIds,
    noCounterattackCellIds
  );
  for (const cellId of movementHintCellIds) {
    const layout = cellLayouts.get(cellId);
    if (!layout) continue;
    const { x, y, radius } = layout;
    const frame = new Graphics().poly(getTerrainHexCoordinates(x, y, radius * TERRAIN_ART_FOOTPRINT_SCALE))
      .stroke({ color: 0x67e8f9, width: 3, alpha: 1 });
    frame.eventMode = "none";
    interactionLayers.legal.addChild(frame);
  }
  // 可反击目标显示红色，不能反击的目标显示白色；这些提示只在本地预览，不发送给房间内其他玩家。
  for (const [cellIds, color] of [
    [noCounterattackCellIds, 0xffffff],
    [counterattackCellIds, 0xf0525f]
  ] as const) {
    for (const cellId of cellIds) {
      const layout = cellLayouts.get(cellId);
      const unitId = props.state.cells[cellId]?.unitId;
      if (!layout || !unitId || !props.state.units[unitId]) continue;
      const { x, y, radius } = layout;
      const frame = new Graphics().poly(getTerrainHexCoordinates(x, y, radius * 0.92))
        .stroke({ color, width: Math.max(3, radius * 0.075), alpha: 1 });
      frame.eventMode = "none";
      interactionLayers.counterattack.addChild(frame);
    }
  }
  const unit = props.selectedUnitId ? props.state.units[props.selectedUnitId] : undefined;
  const layout = unit ? cellLayouts.get(unit.cellId) : undefined;
  if (layout) {
    const { x, y, radius } = layout;
    const frame = new Graphics().poly(getTerrainHexCoordinates(x, y, radius - 4))
      .stroke({ color: 0xfef08a, width: 3, alpha: 0.95 });
    frame.eventMode = "none";
    interactionLayers.selection.addChild(frame);
  }
  emit("interactionDrawMeasured", {
    sequence: props.state.sequence,
    durationMs: performance.now() - drawStartedAt
  });
}

function getCellIdAtPoint(event: { readonly global: Readonly<{ x: number; y: number }> }): CellId | undefined {
  const stage = app?.stage;
  if (!stage) return undefined;
  const point = cameraLayer?.toLocal(event.global) ?? stage.toLocal(event.global);
  return findBoardCellAtPoint(cellLayouts, terrainByCell, point, props.editable ?? false);
}

/** 直接把屏幕坐标换算为棋盘格，不让 Pixi 逐个测试所有六边形图形。 */
function onBoardBackgroundTap(event: FederatedPointerEvent): void {
  if (props.editable) {
    if (event.target === app?.stage) emit("backgroundClick");
    return;
  }
  if (performance.now() - cameraMovedAt < 250) return;
  const hitTestStartedAt = performance.now();
  const cellId = getCellIdAtPoint(event);
  const hitTestMs = performance.now() - hitTestStartedAt;
  if (cellId) emit("cellClick", cellId, hitTestMs);
  else if (event.target === app?.stage) emit("backgroundClick");
}

function onBoardCellPressStart(event: FederatedPointerEvent): void {
  if (props.preview || props.editable) return;
  const cellId = getCellIdAtPoint(event);
  if (!cellId) return;
  pressedCellIds.set(event.pointerId, cellId);
  emit("cellPressStart", cellId);
}

function onBoardCellPressEnd(event: FederatedPointerEvent): void {
  const cellId = pressedCellIds.get(event.pointerId);
  if (!cellId) return;
  pressedCellIds.delete(event.pointerId);
  emit("cellPressEnd", cellId);
}

function onBoardWheel(event: WheelEvent): void {
  if (props.preview || props.editable) return;
  const host = canvasHost.value;
  if (!host) return;
  const bounds = host.getBoundingClientRect();
  const nextCamera = zoomBoardCameraAtPoint(
    { zoom: cameraZoom, pan: cameraPan },
    { width: bounds.width, height: bounds.height },
    { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
    getBoardWheelZoomFactor(event.deltaY)
  );
  if (nextCamera.zoom === cameraZoom) return;
  cameraZoom = nextCamera.zoom;
  cameraPan = { ...nextCamera.pan };
  cameraMovedAt = performance.now();
  applyCamera(bounds.width, bounds.height);
}

/** 对局期间只在棋盘区域处理浏览器缩放快捷键。 */
function onBoardZoomShortcut(event: KeyboardEvent): void {
  if ((!event.ctrlKey && !event.metaKey) || props.preview) return;
  if (event.key === "+" || event.key === "=" || event.code === "NumpadAdd") {
    cameraZoom = Math.min(MAX_BOARD_ZOOM, cameraZoom * 1.12);
  } else if (event.key === "-" || event.key === "_" || event.code === "NumpadSubtract") {
    cameraZoom = Math.max(MIN_BOARD_ZOOM, cameraZoom * 0.89);
  } else if (event.key === "0" || event.code === "Numpad0") {
    cameraZoom = 1;
    cameraPan = { x: 0, y: 0 };
  } else return;
  event.preventDefault();
  cameraMovedAt = performance.now();
  applyCamera();
}

function applyCamera(width?: number, height?: number): void {
  const camera = cameraLayer;
  if (!app || !camera) return;
  // draw() 已经测量过宽高，点击到绘制的同步路径里不要再次触发布局读取。
  const bounds = width === undefined || height === undefined
    ? canvasHost.value?.getBoundingClientRect()
    : undefined;
  const w = width ?? bounds?.width ?? 0, h = height ?? bounds?.height ?? 0;
  const zoom = props.preview && !props.editable ? 1 : props.editable ? props.viewZoom ?? 1 : cameraZoom;
  const pan = props.preview && !props.editable ? { x: 0, y: 0 } : props.editable ? props.viewPan ?? { x: 0, y: 0 } : cameraPan;
  if (!props.preview || props.editable) {
    const offsetX = (1 - zoom) * w / 2 + pan.x;
    const offsetY = (1 - zoom) * h / 2 + pan.y;
    camera.scale.set(zoom);
    camera.position.set(offsetX, offsetY);
  }
  requestPreviewRender();
}

function requestPreviewRender(): void {
  if (!props.preview || !app || previewRenderFrame !== undefined) return;
  const instance = app;
  previewRenderFrame = requestAnimationFrame(() => {
    previewRenderFrame = undefined;
    if (app === instance) instance.render();
  });
}

/** 兵力数字独立成层，始终显示在地形与棋子图像上方。 */
function drawUnitStrengthLabels(): void {
  if (!unitStrengthLayer) return;
  unitStrengthLayer.removeChildren().forEach((child) => child.destroy());
  if (props.showUnitLabels === false) {
    return;
  }
  const highlightedIds = props.highlightedUnitIds === undefined
    ? actionableUnits.value
    : new Set(props.highlightedUnitIds);
  const poweredUnitIds = powered.value;
  for (const cell of Object.values(props.state.cells)) {
    const unit = cell.unitId ? props.state.units[cell.unitId] : undefined;
    const layout = cellLayouts.get(cell.id);
    if (!unit || !layout) continue;
    const highlighted = props.preview || props.editable || highlightedIds.has(unit.id);
    const text = new BitmapText({
      text: String(unit.strength),
      style: {
        fontFamily: UNIT_STRENGTH_BITMAP_FONT,
        fontWeight: "900",
        // Keep labels at a stable world size. The shared 128px bitmap atlas is
        // large enough for camera scaling, so zooming never rebuilds label objects.
        fontSize: getUnitStrengthFontSize(layout.radius, poweredUnitIds.has(unit.id), props.preview && !props.editable),
        fill: "#ffffff",
        align: "center"
      }
    });
    text.alpha = highlighted ? 1 : 0.46;
    text.anchor.set(0.5);
    text.position.set(layout.x, layout.y + layout.radius * 0.02);
    text.eventMode = "none";
    unitStrengthLayer.addChild(text);
  }
}

function onCameraPointerDown(event: { pointerId: number; global: { x: number; y: number } }): void {
  pointers.set(event.pointerId, { x: event.global.x, y: event.global.y });
  if (pointers.size === 1) dragOrigin = { x: event.global.x, y: event.global.y, panX: cameraPan.x, panY: cameraPan.y };
  else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    if (a && b) pinchOrigin = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: cameraZoom,
      x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, panX: cameraPan.x, panY: cameraPan.y };
    dragOrigin = undefined;
  }
}

function onCameraPointerMove(event: { pointerId: number; pointerType?: string; global: { x: number; y: number } }): void {
  if (!pointers.has(event.pointerId)) {
    if (!props.preview && !props.editable && canvasHost.value) {
      canvasHost.value.style.cursor = event.pointerType === "mouse" && getCellIdAtPoint(event) ? "pointer" : "grab";
    }
    return;
  }
  pointers.set(event.pointerId, { x: event.global.x, y: event.global.y });
  const values = [...pointers.values()];
  if (values.length >= 2 && pinchOrigin) {
    const a = values[0]!, b = values[1]!;
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    const centerX = (a.x + b.x) / 2, centerY = (a.y + b.y) / 2;
    const bounds = canvasHost.value?.getBoundingClientRect();
    const nextCamera = bounds && pinchOrigin.distance > 0
      ? zoomBoardCameraAtPoint(
        { zoom: pinchOrigin.zoom, pan: { x: pinchOrigin.panX, y: pinchOrigin.panY } },
        { width: bounds.width, height: bounds.height },
        { x: pinchOrigin.x, y: pinchOrigin.y },
        distance / pinchOrigin.distance
      )
      : { zoom: cameraZoom, pan: cameraPan };
    cameraZoom = nextCamera.zoom;
    cameraPan = {
      x: nextCamera.pan.x + centerX - pinchOrigin.x,
      y: nextCamera.pan.y + centerY - pinchOrigin.y
    };
    cameraMovedAt = performance.now();
    applyCamera();
  } else if (values.length === 1 && dragOrigin) {
    const pointer = values[0]!;
    const dx = pointer.x - dragOrigin.x, dy = pointer.y - dragOrigin.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) {
      cameraMovedAt = performance.now();
      if (canvasHost.value) canvasHost.value.style.cursor = "grabbing";
    }
    cameraPan = { x: dragOrigin.panX + dx, y: dragOrigin.panY + dy };
    applyCamera();
  }
}

function onCameraPointerUp(event: { pointerId: number; pointerType?: string; global?: { x: number; y: number } }): void {
  pointers.delete(event.pointerId);
  if (pointers.size < 2) pinchOrigin = undefined;
  if (pointers.size === 1) {
    const entry = [...pointers.entries()][0];
    const point = entry?.[1];
    if (point) dragOrigin = { x: point.x, y: point.y, panX: cameraPan.x, panY: cameraPan.y };
  } else if (!pointers.size) {
    dragOrigin = undefined;
    if (!props.preview && !props.editable && canvasHost.value && event.global) {
      canvasHost.value.style.cursor = event.pointerType === "mouse" && getCellIdAtPoint({ global: event.global }) ? "pointer" : "grab";
    }
  }
}

/** 内置地形与 Mod 地形都先解析为同一份底图/顶图定义。 */
function drawTerrainLayer(
  target: Container,
  topArtTarget: Container,
  terrainId: string,
  x: number,
  y: number,
  radius: number,
  visuals?: TerrainVisualSpec,
  assets: Readonly<Record<string, string>> = {},
  occupied = false
): void {
  const definition = getTerrainVisualDefinition(terrainId, visuals, assets);
  drawTerrainVisual(target, topArtTarget, x, y, radius, definition.visuals, definition.assets, occupied);
}

function getTerrainVisualDefinition(
  terrainId: string,
  visuals: TerrainVisualSpec | undefined,
  assets: Readonly<Record<string, string>>
): { readonly visuals: TerrainVisualSpec; readonly assets: Readonly<Record<string, string>> } {
  const baseColor = terrainColors[terrainId] ?? 0x475569;
  const definition = visuals ?? coreTerrainVisuals[terrainId] ?? {
    baseColor: `#${baseColor.toString(16).padStart(6, "0")}`
  };
  const visualAssets = visuals || terrainId.startsWith("mod/") ? assets : coreTerrainVisualAssets;
  return { visuals: definition, assets: visualAssets };
}

/** 地形底色保持明亮；旧版图片用于提供纹理，而不是压暗地块。 */
function addHexFill(target: Container, x: number, y: number, radius: number, color: number, alpha = 1): void {
  const fill = new Graphics().poly(getTerrainHexCoordinates(x, y, radius)).fill({ color, alpha });
  fill.eventMode = "none";
  target.addChild(fill);
}

/** 从旧版素材缓存中取图；后续统一由 addCellSprite 设置绘制参数。 */
function createLegacySprite(textureUrl: string): Sprite {
  const texture = loadedLegacyTextures.get(textureUrl);
  return texture ? new Sprite({ texture }) : Sprite.from(textureUrl);
}

function addCellSprite(
  target: Container,
  sprite: Sprite,
  placement: TerrainArtPlacement,
  alpha = 1,
  tint?: number
): void {
  sprite.anchor.set(0.5);
  sprite.width = placement.width;
  sprite.height = placement.height;
  sprite.position.set(placement.x, placement.y);
  if (tint !== undefined) sprite.tint = tint;
  sprite.alpha = alpha;
  sprite.eventMode = "none";
  target.addChild(sprite);
}

/** 核心地块与 Mod 底图/顶图共用同一六边形尺寸、偏移和裁剪。 */
function addTerrainArtSprite(
  target: Container,
  sprite: Sprite,
  x: number,
  y: number,
  radius: number,
  scale = 1,
  alpha = 1,
  offsetX = 0,
  offsetY = 0,
  tint?: number
): void {
  const placement = getTerrainArtPlacement(x, y, radius, scale, offsetX, offsetY);
  const layer = new Container();
  layer.eventMode = "none";
  layer.interactiveChildren = false;
  // 试验：素材按自身透明边缘绘制，暂不额外裁成六边形。
  addCellSprite(layer, sprite, placement, alpha, tint);
  target.addChild(layer);
}

function colorNumber(color: string): number {
  const parsed = Number.parseInt(color.replace("#", ""), 16);
  return Number.isNaN(parsed) ? 0xffffff : parsed;
}

/** 旧版 Ripple 图片会先扩张再消失；这里在 Pixi 中复现相同节奏。 */
function updateActionPulses(now: number): void {
  for (const pulse of actionPulses.values()) {
    // 让脉冲稍快完成并采用缓出运动：圆环先迅速形成提示，再随透明度降低而慢慢减速。
    const progress = ((now / 1_050) + pulse.phaseOffset) % 1;
    // 加强缓出效果，让尾段明显放慢，而不是匀速扩张后突然变淡。
    const eased = 1 - Math.pow(1 - progress, 3.8);
    // 收紧圆环尺寸，并缩短、减弱逐渐淡出的尾段。
    pulse.graphic.scale.set(0.38 + eased * 0.27);
    pulse.graphic.alpha = 0.84 * Math.pow(1 - eased, 0.9);
  }
}

function onBoardPointerOut(event: FederatedPointerEvent): void {
  if (event.target === app?.stage) emit("cellPointerLeave");
}

function drawTerrainVisual(
  target: Container,
  topArtTarget: Container,
  x: number,
  y: number,
  radius: number,
  visuals: TerrainVisualSpec,
  assets: Readonly<Record<string, string>>,
  occupied: boolean
): void {
  const artwork = resolveTerrainArtwork(visuals, assets, occupied);
  if (artwork.useColorFallback) {
    addHexFill(target, x, y, radius * TERRAIN_ART_FOOTPRINT_SCALE,
      colorNumber(visuals.baseColor ?? "#475569"), visuals.baseOpacity ?? 1);
  }

  if (artwork.base) {
    addTerrainVisualSprite(target, artwork.base.src, x, y, radius,
      artwork.base.scale, artwork.base.opacity, artwork.base.offsetX, artwork.base.offsetY);
  }

  if (artwork.overlay) {
    addTerrainVisualSprite(topArtTarget, artwork.overlay.src, x, y, radius,
      artwork.overlay.scale, artwork.overlay.opacity, artwork.overlay.offsetX, artwork.overlay.offsetY);
  }
}

function drawTerrainOverlayVisual(
  target: Container,
  x: number,
  y: number,
  radius: number,
  visuals: TerrainVisualSpec,
  assets: Readonly<Record<string, string>>,
  occupied: boolean
): void {
  const { overlay } = resolveTerrainArtwork(visuals, assets, occupied);
  if (overlay) {
    addTerrainVisualSprite(target, overlay.src, x, y, radius,
      overlay.scale, overlay.opacity, overlay.offsetX, overlay.offsetY);
  }
}

function addTerrainVisualSprite(
  target: Container,
  dataUrl: string,
  x: number,
  y: number,
  radius: number,
  scale: number,
  alpha: number,
  offsetX: number,
  offsetY: number
): void {
  const texture = loadedLegacyTextures.get(dataUrl) ?? loadedTerrainTextures.get(dataUrl);
  if (!texture) {
    let waiters = terrainTextureWaiters.get(dataUrl);
    if (!waiters) terrainTextureWaiters.set(dataUrl, waiters = new Set());
    waiters.add(draw);
    if (!loadingTerrainTextures.has(dataUrl)) {
      loadingTerrainTextures.add(dataUrl);
      void loadTerrainImageTexture(dataUrl).then((loaded) => {
        loadedTerrainTextures.set(dataUrl, loaded);
        loadingTerrainTextures.delete(dataUrl);
        loadedTerrainTextureRevision += 1;
        const callbacks = terrainTextureWaiters.get(dataUrl);
        terrainTextureWaiters.delete(dataUrl);
        callbacks?.forEach((redraw) => redraw());
      }).catch((error: unknown) => {
        loadingTerrainTextures.delete(dataUrl);
        terrainTextureWaiters.delete(dataUrl);
        console.warn("A terrain image could not be decoded for the board.", error);
      });
    }
    return;
  }
  const sprite = new Sprite({ texture });
  addTerrainArtSprite(target, sprite, x, y, radius, scale, alpha, offsetX, offsetY);
}

</script>

<template><div ref="canvasHost" class="board-canvas" :class="{ preview, editable }" :style="editable ? { background: 'transparent' } : undefined" :aria-label="preview ? '当前地图预览' : '本地战棋演示地图'" @wheel.prevent="onBoardWheel"><span v-if="!preview && !editable" class="board-gesture-hint">拖动平移 · 滚轮 / 双指缩放</span></div></template>

<style scoped>
.board-canvas { position:relative; isolation:isolate; width: 100%; height: 100%; min-height: 390px; overflow: hidden; border: 1px solid rgba(160, 191, 223, .42); border-radius: 20px; background: #182638; touch-action: none; cursor: grab; -webkit-tap-highlight-color: transparent; }
.board-canvas.preview { min-height: 0; border-radius: 12px; pointer-events: none; }
.board-canvas.editable { min-height: 0; border: 0; border-radius: 0; pointer-events: auto; }
.board-gesture-hint { position:absolute; z-index:1; top:8px; left:50%; transform:translateX(-50%); padding:4px 8px; border:1px solid rgba(147,177,207,.16); border-radius:999px; color:rgba(178,200,219,.58); background:rgba(11,20,32,.35); font-size:9px; pointer-events:none; white-space:nowrap; }
.board-canvas.preview .board-gesture-hint { display:none; }
.board-canvas :deep(canvas) { display: block; width: 100%; height: 100%; touch-action:none; }
.board-canvas :deep(canvas) { position:relative;z-index:0; }
</style>
