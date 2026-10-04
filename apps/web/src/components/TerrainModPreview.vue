<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import type { TerrainModDefinition, TerrainModVisualPreview } from "@numeral-lord/content-schema";
import { getTerrainArtClipPoints, getTerrainArtPlacement, getTerrainHexPoints, TERRAIN_ART_FOOTPRINT_SCALE, TERRAIN_ART_VIEWBOX_HEIGHT, type TerrainArtPlacement } from "../board/terrain-art-geometry.js";
import { resolveTerrainArtwork, type ResolvedTerrainArtLayer } from "../board/terrain-render-model.js";
import { shouldRequestWorkshopTerrainPreview } from "../workshop/workshop-preview-request.js";

type PreviewAsset = { readonly id: string; readonly dataUrl: string } | { readonly id: string; readonly url: string };
type PreviewTile = {
  readonly terrainId: string;
  readonly displayName: string;
  readonly visuals?: TerrainModDefinition["terrain"]["visuals"];
  readonly visualAssets: readonly PreviewAsset[];
};

const props = withDefaults(defineProps<{
  terrainId: string;
  name: string;
  definition?: TerrainModDefinition | undefined;
  preview?: TerrainModVisualPreview | undefined;
  publicationId?: string | undefined;
  large?: boolean;
}>(), { large: false });

const emit = defineEmits<{ "preview-requested": [id: string] }>();
const previewElement = ref<HTMLElement>();
let previewObserver: IntersectionObserver | undefined;
let requestedPublicationId: string | undefined;

function observePreviewRequest(): void {
  previewObserver?.disconnect();
  previewObserver = undefined;
  // Local/bundled entries are not workshop publication IDs. Their installed
  // definition already contains all visual assets, so only remote summaries
  // should issue a preview request.
  if (!shouldRequestWorkshopTerrainPreview(props.publicationId, Boolean(props.definition), Boolean(props.preview))) return;
  if (requestedPublicationId !== props.publicationId) requestedPublicationId = undefined;
  if (requestedPublicationId === props.publicationId) return;
  const element = previewElement.value;
  if (!element) return;
  const request = () => {
    requestedPublicationId = props.publicationId;
    emit("preview-requested", props.publicationId!);
  };
  if (typeof IntersectionObserver === "undefined") {
    request();
    return;
  }
  previewObserver = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    request();
    previewObserver?.disconnect();
    previewObserver = undefined;
  }, { rootMargin: "140px" });
  previewObserver.observe(element);
}

onMounted(observePreviewRequest);
watch(() => [props.publicationId, props.preview, props.definition], observePreviewRequest);
onBeforeUnmount(() => previewObserver?.disconnect());

const clipPrefix = `workshop-mod-preview-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
const terrainPreview = computed<PreviewTile>(() => props.preview ?? {
  terrainId: props.terrainId,
  displayName: props.name,
  ...(props.definition?.terrain.visuals ? { visuals: props.definition.terrain.visuals } : {}),
  visualAssets: props.definition?.visualAssets ?? []
});

const terrainClipId = `${clipPrefix}-terrain`;
const artClipPoints = getTerrainArtClipPoints();
const fallbackHexPoints = getTerrainHexPoints(TERRAIN_ART_FOOTPRINT_SCALE);
type PreviewArtLayer = ResolvedTerrainArtLayer & { readonly placement: TerrainArtPlacement };

function artworkFor(tile: PreviewTile) {
  const assets = Object.fromEntries(tile.visualAssets.map((asset) => [asset.id, "url" in asset ? asset.url : asset.dataUrl]));
  // Workshop cards showcase the occupied-state appearance, including a
  // whenOccupied frame. The board still resolves this against real occupancy.
  return resolveTerrainArtwork(tile.visuals, assets, true);
}

function layersFor(tile: PreviewTile): readonly PreviewArtLayer[] {
  const { base, overlay } = artworkFor(tile);
  return [...(base ? [base] : []), ...(overlay ? [overlay] : [])].map((layer) => ({
    ...layer,
    placement: getTerrainArtPlacement(50, TERRAIN_ART_VIEWBOX_HEIGHT / 2, TERRAIN_ART_VIEWBOX_HEIGHT / 2,
      layer.scale, layer.offsetX, layer.offsetY)
  }));
}
</script>

<template>
  <div ref="previewElement" class="terrain-art-collection" :class="{ large }" aria-label="Mod 地块外观">
    <figure class="terrain-art-item">
      <template v-if="terrainPreview.visuals">
      <svg class="terrain-art-svg" :viewBox="`0 0 100 ${TERRAIN_ART_VIEWBOX_HEIGHT}`" preserveAspectRatio="xMidYMid meet" focusable="false" aria-hidden="true">
        <defs>
          <clipPath :id="terrainClipId">
            <polygon :points="artClipPoints" />
          </clipPath>
        </defs>
        <polygon v-if="artworkFor(terrainPreview).useColorFallback" :points="fallbackHexPoints" :fill="terrainPreview.visuals.baseColor" :fill-opacity="terrainPreview.visuals.baseOpacity ?? (terrainPreview.visuals.baseTransparent ? 0 : 1)" />
        <g :clip-path="`url(#${terrainClipId})`">
          <image v-for="(layer, layerIndex) in layersFor(terrainPreview)" :key="`${terrainPreview.terrainId}-${layerIndex}`" :href="layer.src"
            :x="layer.placement.x - layer.placement.width / 2" :y="layer.placement.y - layer.placement.height / 2"
            :width="layer.placement.width" :height="layer.placement.height"
            :opacity="layer.opacity" preserveAspectRatio="none" />
        </g>
        <polygon v-if="artworkFor(terrainPreview).useColorFallback" :points="fallbackHexPoints"
          fill="none" stroke="#26384c" stroke-width="1.4" stroke-linejoin="round" opacity=".9" />
      </svg>
      </template>
      <svg v-else class="terrain-art-svg terrain-art-placeholder" viewBox="0 0 100 115.47" focusable="false" aria-hidden="true">
        <polygon points="50,1.15 99,29.43 99,86.04 50,114.32 1,86.04 1,29.43" fill="#25384b" stroke="#71869a" stroke-width="1.5" />
        <path d="M37 43h26v20H37z M41 58l6-6 5 4 5-5 5 7" fill="none" stroke="#a9bdcc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <text x="50" y="77" text-anchor="middle">未上传外观</text>
      </svg>
      <figcaption>{{ terrainPreview.displayName }}</figcaption>
    </figure>
  </div>
</template>

<style scoped>
.terrain-art-collection{display:flex;justify-content:center;align-items:center;gap:10px;width:100%;height:100%;overflow:auto;padding:10px;box-sizing:border-box}
.terrain-art-item{display:grid;flex:0 0 auto;justify-items:center;gap:5px;width:72px;margin:0;color:#a8bdcb;font-size:9px;text-align:center}
.terrain-art-placeholder{display:block;width:56px;height:65px;overflow:visible;filter:drop-shadow(0 5px 8px rgba(4,12,20,.3))}
.terrain-art-placeholder text{fill:#b4c4d1;font-size:9px;font-family:inherit}
.terrain-art-svg{display:block;width:72px;height:84px;overflow:visible;filter:drop-shadow(0 5px 8px rgba(4,12,20,.3))}
.terrain-art-item figcaption{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.terrain-art-collection.large{flex-wrap:wrap;align-content:center;gap:18px;min-height:176px}
.terrain-art-collection.large .terrain-art-item{width:100px;font-size:11px}
.terrain-art-collection.large .terrain-art-svg{width:100px;height:116px}
.terrain-art-collection.large .terrain-art-placeholder{width:76px;height:88px}
.terrain-preview-empty{color:#8197a9;font-size:11px}
</style>
