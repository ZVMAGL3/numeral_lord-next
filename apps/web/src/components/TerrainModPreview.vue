<script setup lang="ts">
withDefaults(defineProps<{
  terrainIds: readonly string[];
  imageUrl?: string | undefined;
  large?: boolean;
}>(), { large: false });
</script>

<template>
  <span class="terrain-art-tile" :class="{ large, oil: !imageUrl && terrainIds.includes('mod/oil-field') }" aria-hidden="true">
    <img v-if="imageUrl" class="custom-art" :src="imageUrl" alt="" />
    <svg v-else-if="terrainIds.includes('mod/oil-field')" class="oil-art" viewBox="0 0 100 112" focusable="false">
      <path class="tile" d="M50 3 92 27v50l-42 25L8 77V27z" />
      <g class="derrick">
        <path d="m50 20-23 59h46z" />
        <path d="M38 67h24M42 55h16M46 43h8M50 20v59M34 79l16-16 16 16" />
        <path d="m29 79 21-8 21 8" />
      </g>
      <circle class="well" cx="50" cy="85" r="4" />
      <path class="glint" d="m50 9 35 20v3L50 12 15 32v-3z" />
    </svg>
    <span v-else class="generic-art">⬡</span>
  </span>
</template>

<style scoped>
.terrain-art-tile{position:relative;display:grid;place-items:center;flex:none;width:72px;height:80px;overflow:hidden}
.terrain-art-tile.oil{filter:drop-shadow(0 5px 8px rgba(4,12,20,.3))}
.terrain-art-tile.large{width:112px;height:126px}
.custom-art{display:block;max-width:100%;max-height:100%;object-fit:contain}
.oil-art{display:block;width:100%;height:100%;overflow:visible}
.tile{fill:#9a6338;stroke:#f7c66b;stroke-width:3}
.derrick{fill:none;stroke:#ffe0a0;stroke-width:4;stroke-linecap:round;stroke-linejoin:round}
.well{fill:#f4c46d;stroke:#613d27;stroke-width:2}
.glint{fill:#f9d591;opacity:.5}
.generic-art{color:#d9c99b;font-size:48px;line-height:1}
.large .generic-art{font-size:76px}
</style>
