<script setup lang="ts">
import { inject, proxyRefs } from "vue";
import WorkshopPanel from "../components/WorkshopPanel.vue";
import { appRuntimeKey } from "../app/app-runtime-key";
import type { ConfiguredMap } from "../maps/map-library";

const runtime = inject(appRuntimeKey);
if (!runtime) throw new Error("创意工坊未连接应用运行时");
const page = proxyRefs(runtime.workshop);
</script>

<template>
  <WorkshopPanel
    :terrain-mods="page.workshopTerrainMods"
    :map-entries="page.workshopMapWorks"
    :saved-map-ids="page.configuredMaps.map((map: ConfiguredMap) => map.definition.id)"
    :subscribed-terrain-mod-ids="page.subscribedTerrainModIds"
    :current-author-name="page.playerName"
    :pending-terrain-mod-id="page.pendingWorkshopTerrainModId"
    :action-message="page.workshopActionMessage"
    :action-error="page.workshopActionError"
    :working="page.workshopWorking"
    :publishing-enabled="page.workshopPublishingEnabled"
    :upload-terrain-asset="page.uploadTerrainAsset"
    :download-terrain-asset="page.downloadTerrainAsset"
    @back="page.returnFromWorkshop"
    @select-map="page.selectWorkshopMap"
    @select-terrain-mod="page.selectWorkshopTerrainMod"
    @save-map="page.saveWorkshopMap"
    @publish-map="page.publishWorkshopMap"
    @publish-terrain-mod="page.publishWorkshopTerrainMod"
    @subscribe-terrain-mod="page.subscribeWorkshopTerrainMod"
    @unsubscribe-terrain-mod="page.unsubscribeWorkshopTerrainMod"
    @terrain-mod-opened="page.clearPendingWorkshopTerrainMod"
    @request-terrain-mod-preview="page.requestTerrainModPreview"
  />
</template>
