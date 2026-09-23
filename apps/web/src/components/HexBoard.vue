<script setup lang="ts">
import { Application, Assets, Graphics, Rectangle, Sprite, Text } from "pixi.js";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { CellId, GameState, UnitId } from "@numeral-lord/game-core";

const props = defineProps<{
  state: GameState;
  selectedUnitId: UnitId | null;
  legalActionCellIds: readonly CellId[];
  actionableUnitIds: readonly UnitId[];
  poweredUnitIds: readonly UnitId[];
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
const powered = computed(() => new Set(props.poweredUnitIds));
const legalActions = computed(() => new Set(props.legalActionCellIds));
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
const legacyTextureUrls = {
  plain: "/legacy/TS0.png",
  water: "/legacy/TS_Water.png",
  mountain: "/legacy/TS_Mountain.png",
  stronghold: "/legacy/TS_Stronghold.png",
  oilField: "/legacy/TSF.png"
} as const;
const oilFieldTerrainId = "mod/oil-field";

onMounted(async () => {
  const host = canvasHost.value;
  if (!host) return;
  const instance = new Application();
  app = instance;
  try {
    await instance.init({ background: "#182638", antialias: true, resizeTo: host });
  } catch (error) {
    if (app === instance) app = undefined;
    console.error("Pixi board initialization failed.", error);
    return;
  }
  // HMR can unmount this component while Pixi or the artwork is awaiting a
  // promise. Do not continue touching an instance already disposed below.
  if (app !== instance || !canvasHost.value) return;
  instance.stage.sortableChildren = true;
  instance.stage.eventMode = "static";
  instance.stage.hitArea = instance.screen;
  instance.stage.on("pointertap", onBoardBackgroundTap);
  host.appendChild(instance.canvas);
  // Preload before drawing. Sprite.from() then reuses Pixi's cache on every state update.
  try {
    await Assets.load(Object.values(legacyTextureUrls));
  } catch (error) {
    // A missing optional sprite must not remove the rule board. The terrain
    // fills are drawn below the artwork, so the board remains usable while a
    // map asset is being repaired or a preview is offline.
    console.warn("Legacy board artwork could not be loaded; using base fills.", error);
  }
  if (app !== instance || !canvasHost.value) return;
  observer = new ResizeObserver(() => draw());
  observer.observe(host);
  pulseTick = () => updateActionPulses(performance.now());
  instance.ticker.add(pulseTick);
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
  instance.stage.off("pointertap", onBoardBackgroundTap);
  actionPulses = [];
  try {
    instance.destroy(true);
  } catch {
    // Vite can dispose a partially replaced Pixi resize plugin during HMR.
    // Remove the canvas as a safe fallback so the next component owns input.
    host?.querySelector("canvas")?.remove();
  }
});
watch(() => [props.state, props.selectedUnitId, props.legalActionCellIds, props.actionableUnitIds, props.poweredUnitIds], draw, { deep: true });

function draw(): void {
  if (!app || !canvasHost.value) return;
  const { width, height } = canvasHost.value.getBoundingClientRect();
  // ResizeObserver can report a transient 0×0 box during tab switches and
  // HMR. Never clear a valid previous frame until a drawable size exists.
  if (width < 1 || height < 1) return;
  actionPulses = [];
  app.stage.removeChildren().forEach((child) => child.destroy());
  app.stage.hitArea = new Rectangle(0, 0, width, height);
  const { columns, rows } = props.state.board;
  const horizontalUnit = Math.sqrt(3);
  const radius = Math.max(21, Math.min((width - 44) / (horizontalUnit * (columns + 0.5)), (height - 44) / (1.5 * (rows - 1) + 2)));
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
    drawTerrainLayer(cell.terrainId, x, y, radius);

    // This transparent hit layer stays below the unit / stronghold layers;
    // interactions remain on the hex while the visual layers are noninteractive.
    // Legal action outline follows the same 0.98 terrain footprint, instead
    // of the previous radius-1 inset that made attack targets look smaller.
    const tile = new Graphics().poly(hexagon(x, y, radius * 0.98))
      .fill({ color: 0xffffff, alpha: 0.001 })
      .stroke({ color: legalActions.value.has(cell.id) ? 0x67e8f9 : 0x8ba2c1, width: legalActions.value.has(cell.id) ? 3 : 1, alpha: legalActions.value.has(cell.id) ? 1 : 0.45 });
    bindCellInteraction(tile, cell.id);
    app.stage.addChild(tile);

    const unit = cell.unitId ? props.state.units[cell.unitId] : undefined;
    const player = unit ? props.state.players[unit.ownerId] : undefined;
    const isPowered = unit ? powered.value.has(unit.id) : false;
    const isExhausted = unit ? props.state.turn.exhaustedUnitIds.includes(unit.id) : false;

    // Unit layer: a powered formation fills its cell. A roaming unit uses the
    // same old-system tile texture at 58%, making it readable at a glance.
    if (unit && player) {
      // Powered units occupy the terrain layer's footprint without spilling
      // over its hex edge; roaming units remain deliberately smaller.
      const unitScale = isPowered ? 0.96 : 0.58;
      addHexFill(x, y, radius * unitScale * 0.98, colorNumber(player.color), isExhausted ? 0.62 : 0.96);
      addLegacySprite(legacyTextureUrls.plain, x, y, radius, unitScale, 0xffffff, isExhausted ? 0.16 : 0.24);
    }

    // Stronghold is deliberately above the unit layer. Its gameplay rule is
    // composed separately; this is only the castle artwork layer.
    if (cell.terrainId === "core/stronghold") {
      addLegacySprite(legacyTextureUrls.stronghold, x, y, radius, 0.98);
    }

    if (unit && actionableUnits.value.has(unit.id)) {
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

    if (unit && player) {
      const canAct = actionableUnits.value.has(unit.id);
      const strength = new Text({
        text: String(unit.strength),
        style: {
          // Preserve the old game's `aliceblue` active treatment, but keep
          // inactive units in a dim white rather than a muddy mid-grey.
          fill: canAct ? 0xffffff : 0xdce5ef,
          fontFamily: "Arial",
          fontSize: Math.round(radius * (isPowered ? 0.6 : 0.44)),
          fontWeight: "900",
        }
      });
      strength.anchor.set(0.5); strength.position.set(x, y + radius * 0.05); strength.eventMode = "none";
      strength.zIndex = 20;
      app.stage.addChild(strength);
    }

    if (cell.unitId && props.state.units[cell.unitId]?.id === props.selectedUnitId) {
      const selection = new Graphics().poly(hexagon(x, y, radius - 4))
        .stroke({ color: 0xfef08a, width: 3, alpha: 0.95 });
      selection.zIndex = 30;
      selection.eventMode = "none";
      app.stage.addChild(selection);
    }
  }
  updateActionPulses(performance.now());
}

/** Pixi's stage receives taps outside every hex hit layer. */
function onBoardBackgroundTap(event: { readonly target: unknown }): void {
  if (event.target === app?.stage) emit("backgroundClick");
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
  const sprite = Sprite.from(textureUrl);
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
  graphic.on("pointertap", () => emit("cellClick", cellId));
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

<template><div ref="canvasHost" class="board-canvas" aria-label="本地战棋演示地图" /></template>

<style scoped>
.board-canvas { width: 100%; height: 100%; min-height: 390px; overflow: hidden; border: 1px solid rgba(160, 191, 223, .42); border-radius: 20px; background: #182638; }
.board-canvas :deep(canvas) { display: block; width: 100%; height: 100%; }
</style>
