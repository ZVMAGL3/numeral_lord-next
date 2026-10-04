<script setup lang="ts">
import { computed } from "vue";
import { getTerrainArtPlacement, TERRAIN_ART_FOOTPRINT_SCALE, TERRAIN_ART_VIEWBOX_HEIGHT } from "../board/terrain-art-geometry.js";

export interface MapTerrainIconLayer {
  readonly src: string;
  readonly scale: number;
  readonly opacity: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

const props = withDefaults(defineProps<{
  terrainId: string;
  color: string;
  baseOpacity?: number;
  size?: number;
  transparent?: boolean;
  artwork?: readonly MapTerrainIconLayer[];
}>(), { size: 28, baseOpacity: 1, transparent: false });

const backgroundColor = computed(() => {
  if (props.transparent) return "transparent";
  const match = /^#([0-9a-f]{6})$/i.exec(props.color);
  if (!match) return props.color;
  const color = match[1]!;
  const red = Number.parseInt(color.slice(0, 2), 16);
  const green = Number.parseInt(color.slice(2, 4), 16);
  const blue = Number.parseInt(color.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${Math.min(1, Math.max(0, props.baseOpacity))})`;
});

const baseTexture = computed(() => {
  if (props.transparent) return undefined;
  if (!props.terrainId.startsWith("core/")) return undefined;
  const file = props.terrainId === "core/ocean" ? "TS_Water.png"
    : props.terrainId === "core/mountain" ? "TS_Mountain.png"
    : props.terrainId === "core/void" ? undefined : "TS0.png";
  return file ? `${import.meta.env.BASE_URL}legacy/${file}` : undefined;
});
const strongholdTexture = computed(() => props.terrainId === "core/stronghold"
  ? `${import.meta.env.BASE_URL}legacy/TS_Stronghold.png` : undefined);
const variantClasses = computed(() => props.terrainId.startsWith("mod/")
  ? ["terrain-icon--mod"]
  : [`terrain-icon--${props.terrainId.replace("/", "-")}`]);

function artPlacementStyle(scale = 1, offsetX = 0, offsetY = 0): Record<string, string> {
  const placement = getTerrainArtPlacement(50, TERRAIN_ART_VIEWBOX_HEIGHT / 2, TERRAIN_ART_VIEWBOX_HEIGHT / 2,
    scale, offsetX, offsetY);
  return {
    left: `${placement.x - placement.width / 2}%`,
    top: `${(placement.y - placement.height / 2) / TERRAIN_ART_VIEWBOX_HEIGHT * 100}%`,
    width: `${placement.width}%`,
    height: `${placement.height / TERRAIN_ART_VIEWBOX_HEIGHT * 100}%`,
    transform: "none"
  };
}
</script>

<template>
  <span class="terrain-icon" :class="[...variantClasses, { 'terrain-icon--transparent': transparent, 'terrain-icon--custom-art': artwork?.length }]" :style="{ '--terrain-color': color, '--icon-size': `${size}px`, '--terrain-art-scale': TERRAIN_ART_FOOTPRINT_SCALE, backgroundColor }" aria-hidden="true">
    <img v-if="baseTexture" class="terrain-base-art" :src="baseTexture" alt="" draggable="false" :style="artPlacementStyle()" />
    <img v-for="(layer, index) in artwork" :key="index" class="custom-layer" :src="layer.src" alt="" draggable="false"
      :style="{ ...artPlacementStyle(layer.scale, layer.offsetX, layer.offsetY), opacity: layer.opacity }" />
    <img v-if="strongholdTexture" class="stronghold-detail" :src="strongholdTexture" alt="" draggable="false" />
  </span>
</template>

<style scoped>
.terrain-icon{position:relative;display:inline-grid;place-items:center;width:var(--icon-size)!important;min-width:var(--icon-size);max-width:var(--icon-size);height:calc(var(--icon-size) * 1.155);flex:0 0 var(--icon-size)!important;overflow:hidden;background:var(--terrain-color);clip-path:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%);filter:drop-shadow(0 1px 1px rgba(0,0,0,.35))}
.terrain-icon img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.83;pointer-events:none;user-select:none}
.terrain-icon .stronghold-detail{transform:scale(var(--terrain-art-scale))}
.terrain-icon--core-plain img{opacity:.38}
.terrain-icon--core-stronghold img{opacity:.35}
.terrain-icon .stronghold-detail{opacity:.92}
.terrain-icon--core-void{box-shadow:inset 0 0 0 1px rgba(164,187,205,.42)}
.terrain-icon--transparent{background:transparent!important;box-shadow:none!important;filter:none!important}
.terrain-icon--mod:not(.terrain-icon--custom-art)::after{position:absolute;inset:0;content:"";background:repeating-linear-gradient(135deg,transparent 0 5px,rgba(255,255,255,.12) 5px 7px)}
.terrain-icon--custom-art::after{display:none}
.terrain-icon--transparent::after{display:none}
</style>
