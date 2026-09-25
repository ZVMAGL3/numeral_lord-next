<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(defineProps<{
  terrainId: string;
  color: string;
  size?: number;
}>(), { size: 28 });

const baseTexture = computed(() => {
  const file = props.terrainId === "core/ocean" ? "TS_Water.png"
    : props.terrainId === "core/mountain" ? "TS_Mountain.png"
    : props.terrainId === "mod/oil-field" ? "TSF.png"
    : props.terrainId === "core/void" ? undefined : "TS0.png";
  return file ? `${import.meta.env.BASE_URL}legacy/${file}` : undefined;
});
const strongholdTexture = computed(() => props.terrainId === "core/stronghold"
  ? `${import.meta.env.BASE_URL}legacy/TS_Stronghold.png` : undefined);
const variantClass = computed(() => props.terrainId.startsWith("mod/") ? "terrain-icon--mod" : `terrain-icon--${props.terrainId.replace("/", "-")}`);
</script>

<template>
  <span class="terrain-icon" :class="variantClass" :style="{ '--terrain-color': color, '--icon-size': `${size}px` }" aria-hidden="true">
    <img v-if="baseTexture" :src="baseTexture" alt="" draggable="false" />
    <img v-if="strongholdTexture" class="stronghold-detail" :src="strongholdTexture" alt="" draggable="false" />
  </span>
</template>

<style scoped>
.terrain-icon{position:relative;display:inline-grid;place-items:center;width:var(--icon-size)!important;min-width:var(--icon-size);max-width:var(--icon-size);height:calc(var(--icon-size) * 1.155);flex:0 0 var(--icon-size)!important;overflow:hidden;background:var(--terrain-color);clip-path:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%);filter:drop-shadow(0 1px 1px rgba(0,0,0,.35))}
.terrain-icon img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.83;pointer-events:none;user-select:none}
.terrain-icon--core-plain img{opacity:.38}
.terrain-icon--core-stronghold img{opacity:.35}
.terrain-icon .stronghold-detail{opacity:.92}
.terrain-icon--core-void{box-shadow:inset 0 0 0 1px rgba(164,187,205,.42)}
.terrain-icon--mod::after{position:absolute;inset:0;content:"";background:repeating-linear-gradient(135deg,transparent 0 5px,rgba(255,255,255,.12) 5px 7px)}
</style>
