<script setup lang="ts">
import { Application, Assets, Container, Graphics, Rectangle, Sprite, Text, type Texture } from "pixi.js";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { CellId, GameState, UnitId } from "@numeral-lord/game-core";

const props = defineProps<{
  state: GameState;
  selectedUnitId: UnitId | null;
  legalActionCellIds: readonly CellId[];
  /** Occupied legal attack targets with an available reaction. */
  counterattackCellIds?: readonly CellId[];
  /** Occupied legal attack targets that cannot react (capability, limit, or exhausted). */
  noCounterattackCellIds?: readonly CellId[];
  actionableUnitIds: readonly UnitId[];
  poweredUnitIds: readonly UnitId[];
  /** Read-only compact rendering used by the lobby map preview. */
  preview?: boolean;
  /** Use the real terrain/unit renderer while forwarding clicks to a map editor. */
  editable?: boolean;
  /** Hide strength labels in compact map cards while retaining real unit art. */
  showUnitLabels?: boolean;
}>();

const emit = defineEmits<{
  cellClick: [cellId: CellId];
  backgroundClick: [];
  cellPressStart: [cellId: CellId];
  cellPressEnd: [cellId: CellId];
}>();
const canvasHost = ref<HTMLDivElement | null>(null);
let app: Application | undefined;
let observer: ResizeObserver | undefined;
let pulseTick: (() => void) | undefined;
let actionPulses: ActionPulse[] = [];
let interactionLayers: { legal: Container; counterattack: Container; selection: Container } | undefined;
const pointers = new Map<number, { x: number; y: number }>();
let cameraZoom = 1;
let cameraPan = { x: 0, y: 0 };
let dragOrigin: { x: number; y: number; panX: number; panY: number } | undefined;
let pinchOrigin: { distance: number; zoom: number; x: number; y: number; panX: number; panY: number } | undefined;
let cameraMovedAt = 0;
const cellLayouts = new Map<CellId, { x: number; y: number; radius: number }>();
const powered = computed(() => new Set(props.poweredUnitIds));
const actionableUnits = computed(() => new Set(props.actionableUnitIds));

interface ActionPulse {
  readonly graphic: Graphics;
  readonly centerX: number;
  readonly centerY: number;
  readonly baseRadius: number;
  readonly phaseOffset: number;
}

const terrainColors: Record<string, number> = {
  "core/void": 0x101927, "core/mountain": 0x71809c, "core/ocean": 0x2f72c8,
  "core/plain": 0x63985d, "core/stronghold": 0x63985d, "mod/oil-field": 0x9a6338
};
/** Original project artwork, kept as separate terrain / unit / stronghold layers. */
const legacyAssetUrl = (fileName: string): string => `${import.meta.env.BASE_URL}legacy/${fileName}`;
const legacyTextureUrls = {
  plain: legacyAssetUrl("TS0.png"),
  water: legacyAssetUrl("TS_Water.png"),
  mountain: legacyAssetUrl("TS_Mountain.png"),
  stronghold: legacyAssetUrl("TS_Stronghold.png"),
  oilField: legacyAssetUrl("TSF.png")
} as const;
const loadedLegacyTextures = new Map<string, Texture>();
const oilFieldTerrainId = "mod/oil-field";

onMounted(async () => {
  const host = canvasHost.value;
  if (!host) return;
  const instance = new Application();
  app = instance;
  try {
    await instance.init({
      background: props.editable ? "#101927" : "#182638",
      backgroundAlpha: props.editable ? 0 : 1,
      antialias: true,
      resizeTo: host
    });
  } catch (error) {
    if (app === instance) app = undefined;
    console.error("Pixi board initialization failed.", error);
    return;
  }
  // HMR can unmount this component while Pixi or the artwork is awaiting a
  // promise. Do not continue touching an instance already disposed below.
  if (app !== instance || !canvasHost.value) return;
  if (props.editable) {
    // The editor's water texture is the page background; never paint an
    // opaque rectangle behind the transparent hex board.
    host.style.background = "transparent";
    instance.canvas.style.background = "transparent";
  }
  instance.stage.sortableChildren = true;
  instance.stage.eventMode = props.preview && !props.editable ? "none" : "static";
  instance.stage.hitArea = instance.screen;
  if (!props.preview) {
    instance.stage.on("pointertap", onBoardBackgroundTap);
    instance.stage.on("pointerdown", onCameraPointerDown);
    instance.stage.on("pointermove", onCameraPointerMove);
    instance.stage.on("pointerup", onCameraPointerUp);
    instance.stage.on("pointerupoutside", onCameraPointerUp);
    instance.stage.on("pointercancel", onCameraPointerUp);
  }
  host.appendChild(instance.canvas);
  // Keep the resolved Texture objects: repeated redraws must not ask Pixi to
  // resolve the same URL again (which also avoids noisy cache-miss warnings).
  try {
    const loaded = await Promise.all(Object.values(legacyTextureUrls).map(async (url) => [
      url,
      await Assets.load<Texture>(url)
    ] as const));
    for (const [url, texture] of loaded) loadedLegacyTextures.set(url, texture);
  } catch (error) {
    // A missing optional sprite must not remove the rule board. The terrain
    // fills are drawn below the artwork, so the board remains usable while a
    // map asset is being repaired or a preview is offline.
    console.warn("Legacy board artwork could not be loaded; using base fills.", error);
  }
  if (app !== instance || !canvasHost.value) return;
  observer = new ResizeObserver(() => {
    const { width, height } = host.getBoundingClientRect();
    if (width < 1 || height < 1 || app !== instance) return;
    // CSS transforms and editor fullscreen breakpoints can resize the host
    // without a window resize; resize Pixi's backing buffer before redrawing.
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
  if (pulseTick) instance.ticker.remove(pulseTick);
  pulseTick = undefined;
  window.removeEventListener("keydown", onBoardZoomShortcut, true);
  instance.stage.off("pointertap", onBoardBackgroundTap);
  instance.stage.off("pointerdown", onCameraPointerDown);
  instance.stage.off("pointermove", onCameraPointerMove);
  instance.stage.off("pointerup", onCameraPointerUp);
  instance.stage.off("pointerupoutside", onCameraPointerUp);
  instance.stage.off("pointercancel", onCameraPointerUp);
  pointers.clear();
  actionPulses = [];
  interactionLayers = undefined;
  cellLayouts.clear();
  try {
    instance.destroy(true);
  } catch {
    // Vite can dispose a partially replaced Pixi resize plugin during HMR.
    // Remove the canvas as a safe fallback so the next component owns input.
    host?.querySelector("canvas")?.remove();
  }
});
// Rules replace the immutable GameState snapshot. Deep traversal is unnecessary,
// and local selection must not destroy terrain, text, or pointer hit targets.
watch(() => [props.state, props.actionableUnitIds, props.poweredUnitIds], draw);
watch(() => [props.selectedUnitId, props.legalActionCellIds, props.counterattackCellIds,
  props.noCounterattackCellIds], drawInteractionOverlay);

function draw(): void {
  if (!app || !canvasHost.value) return;
  const { width, height } = canvasHost.value.getBoundingClientRect();
  // ResizeObserver can report a transient 0×0 box during tab switches and
  // HMR. Never clear a valid previous frame until a drawable size exists.
  if (width < 1 || height < 1) return;
  actionPulses = [];
  interactionLayers = undefined;
  cellLayouts.clear();
  app.stage.removeChildren().forEach((child) => child.destroy());
  app.stage.hitArea = new Rectangle(0, 0, width, height);
  const { columns, rows } = props.state.board;
  const horizontalUnit = Math.sqrt(3);
  const padding = props.preview ? 14 : 44;
  // Never enforce a gameplay-sized minimum here: on narrow phones that made
  // the board wider than its clipped canvas, hiding the outer columns.
  const radius = Math.max(1, Math.min(
    (width - padding) / (horizontalUnit * (columns + 0.5)),
    (height - padding) / (1.5 * (rows - 1) + 2)
  ));
  const boardWidth = horizontalUnit * radius * (columns + 0.5);
  const boardHeight = 2 * radius + 1.5 * radius * (rows - 1);
  const offsetX = (width - boardWidth) / 2 + horizontalUnit * radius / 2;
  const offsetY = (height - boardHeight) / 2 + radius;

  for (const cell of Object.values(props.state.cells)) {
    // Void is absence of board rather than a dark terrain. Leaving it
    // unrendered lets the canvas background define the map silhouette.
    if (cell.terrainId === "core/void") continue;
    // Legacy getTile() shifts even rows right. This must agree with
    // getHexNeighbours(), otherwise a visual neighbour differs from a rule neighbour.
    const x = offsetX + horizontalUnit * radius * (cell.coordinate.column + ((cell.coordinate.row + 1) % 2) * 0.5);
    const y = offsetY + 1.5 * radius * cell.coordinate.row;
    cellLayouts.set(cell.id, { x, y, radius });
    drawTerrainLayer(cell.terrainId, x, y, radius);
    const unit = cell.unitId ? props.state.units[cell.unitId] : undefined;
    const player = unit ? props.state.players[unit.ownerId] : undefined;
    const neutralColor = unit?.definitionId === "core/wild" ? 0xc28a4c : 0x8491a4;

    // This transparent hit layer stays below the unit / stronghold layers;
    // interactions remain on the hex while the visual layers are noninteractive.
    // Local target outlines use a separate overlay, leaving these hit targets
    // intact while the player selects, cancels, or changes the selected unit.
    const tile = new Graphics().poly(hexagon(x, y, radius * 0.98))
      .fill({ color: 0xffffff, alpha: 0.001 })
      .stroke({
        color: 0x8ba2c1,
        width: 1,
        alpha: 0.45
      });
    if (props.preview && !props.editable) tile.eventMode = "none";
    else if (props.editable) {
      tile.eventMode = "static";
      tile.cursor = "pointer";
      tile.on("pointertap", () => emit("cellClick", cell.id));
    } else bindCellInteraction(tile, cell.id);
    app.stage.addChild(tile);

    const isPowered = unit ? powered.value.has(unit.id) : false;
    const isExhausted = unit ? props.state.turn.exhaustedUnitIds.includes(unit.id) : false;

    // Unit layer: a powered formation fills its cell. A roaming unit uses the
    // same old-system tile texture at 58%, making it readable at a glance.
    if (unit) {
      // Powered units occupy the terrain layer's footprint without spilling
      // over its hex edge; roaming units remain deliberately smaller.
      const unitScale = isPowered ? 0.96 : 0.58;
      addHexFill(x, y, radius * unitScale * 0.98, player ? colorNumber(player.color) : neutralColor, isExhausted ? 0.62 : 0.96);
      addLegacySprite(legacyTextureUrls.plain, x, y, radius, unitScale, 0xffffff, isExhausted ? 0.16 : 0.24);
    }

    // Stronghold is deliberately above the unit layer. Its gameplay rule is
    // composed separately; this is only the castle artwork layer.
    if (cell.terrainId === "core/stronghold") {
      addLegacySprite(legacyTextureUrls.stronghold, x, y, radius, 0.98);
    }

    if (!props.preview && unit && actionableUnits.value.has(unit.id)) {
      const pulse = new Graphics();
      pulse.eventMode = "none";
      // Overlay the whole board: later cells must not cover an expanding ring.
      pulse.zIndex = 10;
      pulse.position.set(x, y);
      // Keep the ring close to the unit. The old 1.2x expansion read like a
      // second hexagon and was especially noisy on a dense mobile board.
      pulse.circle(0, 0, radius).stroke({ color: 0xffffff, width: 8 });
      actionPulses.push({
        graphic: pulse,
        centerX: x,
        centerY: y,
        baseRadius: radius,
        phaseOffset: (cell.coordinate.column * 0.13 + cell.coordinate.row * 0.07) % 1
      });
      app.stage.addChild(pulse);
    }

    if (unit && props.showUnitLabels !== false) {
      const canAct = player ? actionableUnits.value.has(unit.id) : false;
      const strength = new Text({
        text: player ? String(unit.strength) : `${unit.definitionId === "core/wild" ? "野" : "挡"}${unit.strength}`,
        style: {
          // Preserve the old game's `aliceblue` active treatment, but keep
          // inactive units in a dim white rather than a muddy mid-grey.
          fill: canAct ? 0xffffff : 0xdce5ef,
          fontFamily: "Arial",
          fontSize: Math.round(radius * (isPowered ? 0.6 : player ? 0.44 : 0.28)),
          fontWeight: "900",
        }
      });
      strength.anchor.set(0.5); strength.position.set(x, y + radius * 0.05); strength.eventMode = "none";
      strength.zIndex = 20;
      app.stage.addChild(strength);
    }

  }
  const legal = new Container();
  const counterattack = new Container();
  const selection = new Container();
  legal.zIndex = 5;
  counterattack.zIndex = 25;
  selection.zIndex = 30;
  for (const layer of [legal, counterattack, selection]) {
    layer.eventMode = "none";
    layer.interactiveChildren = false;
    app.stage.addChild(layer);
  }
  interactionLayers = { legal, counterattack, selection };
  applyCamera(width, height);
  drawInteractionOverlay();
  updateActionPulses(performance.now());
}

/** Only this client's selected unit and legal targets belong in these layers. */
function drawInteractionOverlay(): void {
  if (!interactionLayers) return;
  for (const layer of Object.values(interactionLayers)) {
    layer.removeChildren().forEach((child) => child.destroy());
  }
  for (const cellId of props.legalActionCellIds) {
    const layout = cellLayouts.get(cellId);
    if (!layout) continue;
    const { x, y, radius } = layout;
    const frame = new Graphics().poly(hexagon(x, y, radius * 0.98))
      .stroke({ color: 0x67e8f9, width: 3, alpha: 1 });
    frame.eventMode = "none";
    interactionLayers.legal.addChild(frame);
  }
  // Available counterattacks remain red; spent/unavailable ones remain white.
  // These hints are private previews, never relayed to other room members.
  for (const [cellIds, color] of [
    [props.noCounterattackCellIds ?? [], 0xffffff],
    [props.counterattackCellIds ?? [], 0xf0525f]
  ] as const) {
    for (const cellId of cellIds) {
      const layout = cellLayouts.get(cellId);
      const unitId = props.state.cells[cellId]?.unitId;
      if (!layout || !unitId || !props.state.units[unitId]) continue;
      const { x, y, radius } = layout;
      const frame = new Graphics().poly(hexagon(x, y, radius * 0.92))
        .stroke({ color, width: Math.max(3, radius * 0.075), alpha: 1 });
      frame.eventMode = "none";
      interactionLayers.counterattack.addChild(frame);
    }
  }
  const unit = props.selectedUnitId ? props.state.units[props.selectedUnitId] : undefined;
  const layout = unit ? cellLayouts.get(unit.cellId) : undefined;
  if (layout) {
    const { x, y, radius } = layout;
    const frame = new Graphics().poly(hexagon(x, y, radius - 4))
      .stroke({ color: 0xfef08a, width: 3, alpha: 0.95 });
    frame.eventMode = "none";
    interactionLayers.selection.addChild(frame);
  }
}

/** Pixi's stage receives taps outside every hex hit layer. */
function onBoardBackgroundTap(event: { readonly target: unknown }): void {
  if (performance.now() - cameraMovedAt < 250) return;
  if (event.target === app?.stage) emit("backgroundClick");
}

function onBoardWheel(event: WheelEvent): void {
  if (props.preview) return;
  cameraZoom = Math.max(0.55, Math.min(3.2, cameraZoom * (event.deltaY < 0 ? 1.12 : 0.89)));
  cameraMovedAt = performance.now();
  applyCamera();
}

/** Keep browser zoom shortcuts scoped to the board while a match is open. */
function onBoardZoomShortcut(event: KeyboardEvent): void {
  if ((!event.ctrlKey && !event.metaKey) || props.preview) return;
  if (event.key === "+" || event.key === "=" || event.code === "NumpadAdd") {
    cameraZoom = Math.min(3.2, cameraZoom * 1.12);
  } else if (event.key === "-" || event.key === "_" || event.code === "NumpadSubtract") {
    cameraZoom = Math.max(0.55, cameraZoom * 0.89);
  } else if (event.key === "0" || event.code === "Numpad0") {
    cameraZoom = 1;
    cameraPan = { x: 0, y: 0 };
  } else return;
  event.preventDefault();
  cameraMovedAt = performance.now();
  applyCamera();
}

function applyCamera(width?: number, height?: number): void {
  if (!app || props.preview) return;
  const { width: hostWidth, height: hostHeight } = canvasHost.value?.getBoundingClientRect() ?? { width: 0, height: 0 };
  const w = width ?? hostWidth, h = height ?? hostHeight;
  app.stage.scale.set(cameraZoom);
  app.stage.position.set((1 - cameraZoom) * w / 2 + cameraPan.x, (1 - cameraZoom) * h / 2 + cameraPan.y);
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

function onCameraPointerMove(event: { pointerId: number; global: { x: number; y: number } }): void {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.global.x, y: event.global.y });
  const values = [...pointers.values()];
  if (values.length >= 2 && pinchOrigin) {
    const a = values[0]!, b = values[1]!;
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    const zoom = pinchOrigin.distance > 0 ? Math.max(0.55, Math.min(3.2, pinchOrigin.zoom * distance / pinchOrigin.distance)) : cameraZoom;
    const centerX = (a.x + b.x) / 2, centerY = (a.y + b.y) / 2;
    cameraZoom = zoom;
    cameraPan = { x: pinchOrigin.panX + centerX - pinchOrigin.x, y: pinchOrigin.panY + centerY - pinchOrigin.y };
    cameraMovedAt = performance.now();
    applyCamera();
  } else if (values.length === 1 && dragOrigin) {
    const pointer = values[0]!;
    const dx = pointer.x - dragOrigin.x, dy = pointer.y - dragOrigin.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) cameraMovedAt = performance.now();
    cameraPan = { x: dragOrigin.panX + dx, y: dragOrigin.panY + dy };
    applyCamera();
  }
}

function onCameraPointerUp(event: { pointerId: number }): void {
  pointers.delete(event.pointerId);
  if (pointers.size < 2) pinchOrigin = undefined;
  if (pointers.size === 1) {
    const entry = [...pointers.entries()][0];
    const point = entry?.[1];
    if (point) dragOrigin = { x: point.x, y: point.y, panX: cameraPan.x, panY: cameraPan.y };
  } else if (!pointers.size) dragOrigin = undefined;
}

/** Draw terrain as a filled legacy sprite, with optional terrain detail above it. */
function drawTerrainLayer(terrainId: string, x: number, y: number, radius: number): void {
  if (terrainId === "core/mountain") {
    addHexFill(x, y, radius * 0.98, terrainColors["core/mountain"] ?? 0x71809c);
    addLegacySprite(legacyTextureUrls.mountain, x, y, radius, 0.98, undefined, 0.8);
    return;
  }
  if (terrainId === oilFieldTerrainId) {
    // Oil fields are an optional Mod and need a stronger visual signature than
    // a recoloured plain: amber border + the legacy oil texture layer.
    addHexFill(x, y, radius * 0.98, 0x9a6338);
    const oilFrame = new Graphics()
      .poly(hexagon(x, y, radius * 0.91))
      .stroke({ color: 0xf7c66b, width: Math.max(3, radius * 0.08), alpha: 0.95 });
    oilFrame.eventMode = "none";
    app?.stage.addChild(oilFrame);
    addLegacySprite(legacyTextureUrls.oilField, x, y, radius, 0.9, undefined, 0.76);
    return;
  }

  const baseColor = terrainId === "core/stronghold"
    ? terrainColors["core/plain"] ?? 0x63985d
    : terrainColors[terrainId] ?? 0x475569;
  addHexFill(x, y, radius * 0.98, baseColor);
  addLegacySprite(legacyTextureUrls.plain, x, y, radius, 0.98, 0xffffff, 0.26);
  if (terrainId === "core/ocean") {
    addLegacySprite(legacyTextureUrls.water, x, y, radius, 0.93, 0xffffff, 0.92);
  }
}

/** Bright base colour; the legacy sprites above it provide texture, not darkness. */
function addHexFill(x: number, y: number, radius: number, color: number, alpha = 1): void {
  const fill = new Graphics().poly(hexagon(x, y, radius)).fill({ color, alpha });
  fill.eventMode = "none";
  app?.stage.addChild(fill);
}

/** Place one old-system sprite without giving it pointer interaction. */
function addLegacySprite(
  textureUrl: string,
  x: number,
  y: number,
  radius: number,
  scale: number,
  tint?: number,
  alpha = 1
): Sprite {
  const texture = loadedLegacyTextures.get(textureUrl);
  const sprite = texture ? new Sprite({ texture }) : Sprite.from(textureUrl);
  sprite.anchor.set(0.5);
  sprite.width = Math.sqrt(3) * radius * scale;
  sprite.height = 2 * radius * scale;
  sprite.position.set(x, y);
  if (tint !== undefined) sprite.tint = tint;
  sprite.alpha = alpha;
  sprite.eventMode = "none";
  app?.stage.addChild(sprite);
  return sprite;
}

function colorNumber(color: string): number {
  const parsed = Number.parseInt(color.replace("#", ""), 16);
  return Number.isNaN(parsed) ? 0xffffff : parsed;
}

/** The old Ripple sprite expanded then vanished; reproduce that timing in Pixi. */
function updateActionPulses(now: number): void {
  for (const pulse of actionPulses) {
    // A slightly faster cycle with ease-out motion: the ring reaches the
    // useful highlight quickly, then gently slows as it fades away.
    const progress = ((now / 1_050) + pulse.phaseOffset) % 1;
    // A stronger ease-out leaves a visibly longer slow tail instead of
    // looking like a uniform-speed ring with a short fade.
    const eased = 1 - Math.pow(1 - progress, 3.8);
    // Keep the ring compact and make its fading tail shorter and quieter.
    pulse.graphic.scale.set(0.38 + eased * 0.27);
    pulse.graphic.alpha = 0.84 * Math.pow(1 - eased, 0.9);
  }
}

function bindCellInteraction(graphic: Graphics, cellId: CellId): void {
  graphic.eventMode = "static";
  graphic.cursor = "pointer";
  graphic.on("pointertap", () => { if (performance.now() - cameraMovedAt >= 250) emit("cellClick", cellId); });
  graphic.on("pointerdown", () => emit("cellPressStart", cellId));
  graphic.on("pointerup", () => emit("cellPressEnd", cellId));
  graphic.on("pointerupoutside", () => emit("cellPressEnd", cellId));
  graphic.on("pointercancel", () => emit("cellPressEnd", cellId));
}

function hexagon(centerX: number, centerY: number, radius: number): number[] {
  const points: number[] = [];
  for (let index = 0; index < 6; index += 1) {
    const angle = (Math.PI / 180) * (60 * index - 30);
    points.push(centerX + radius * Math.cos(angle), centerY + radius * Math.sin(angle));
  }
  return points;
}
</script>

<template><div ref="canvasHost" class="board-canvas" :class="{ preview, editable }" :style="editable ? { background: 'transparent' } : undefined" :aria-label="preview ? '当前地图预览' : '本地战棋演示地图'" @wheel.prevent="onBoardWheel"><span v-if="!preview && !editable" class="board-gesture-hint">拖动平移 · 滚轮 / 双指缩放</span></div></template>

<style scoped>
.board-canvas { position:relative; width: 100%; height: 100%; min-height: 390px; overflow: hidden; border: 1px solid rgba(160, 191, 223, .42); border-radius: 20px; background: #182638; touch-action: none; cursor: grab; }
.board-canvas.preview { min-height: 0; border-radius: 12px; pointer-events: none; }
.board-canvas.editable { min-height: 0; border: 0; border-radius: 0; pointer-events: auto; }
.board-gesture-hint { position:absolute; z-index:1; top:8px; left:50%; transform:translateX(-50%); padding:4px 8px; border:1px solid rgba(147,177,207,.16); border-radius:999px; color:rgba(178,200,219,.58); background:rgba(11,20,32,.35); font-size:9px; pointer-events:none; white-space:nowrap; }
.board-canvas.preview .board-gesture-hint { display:none; }
.board-canvas :deep(canvas) { display: block; width: 100%; height: 100%; }
</style>
