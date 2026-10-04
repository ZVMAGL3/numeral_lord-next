<script setup lang="ts">
withDefaults(defineProps<{
  kind: "player" | "wild" | "blocker";
  color?: string;
  size?: number;
}>(), { color: "#c84c63", size: 30 });
</script>

<template>
  <svg class="map-unit-icon" :class="`is-${kind}`" :width="size" :height="size" viewBox="0 0 36 40" aria-hidden="true">
    <polygon points="18,1 34,10 34,30 18,39 2,30 2,10" :fill="kind === 'player' ? color : kind === 'wild' ? '#66413f' : '#66594b'" stroke="rgba(232,242,249,.25)" stroke-width="1" />
    <template v-if="kind === 'wild'">
      <path d="M8 18 11 12l4 3 3-5 3 5 5-3 2 7-3 8H11z" fill="#94706a" />
      <circle cx="14" cy="20" r="1.5" fill="#f2d7af" /><circle cx="22" cy="20" r="1.5" fill="#f2d7af" />
      <path d="M15 25q3 2 6 0" fill="none" stroke="#302631" stroke-width="1.5" stroke-linecap="round" />
    </template>
    <template v-else-if="kind === 'blocker'">
      <path d="m9 16 9-5 9 5v10l-9 5-9-5z" fill="#a09078" />
      <path d="m9 16 9 5 9-5M18 21v10" fill="none" stroke="#514b47" stroke-width="1.5" />
      <path d="m12 14 9 5" fill="none" stroke="#c2b29a" stroke-width="1" />
    </template>
  </svg>
</template>

<style scoped>
.map-unit-icon{display:block;flex:none;overflow:visible}
</style>
