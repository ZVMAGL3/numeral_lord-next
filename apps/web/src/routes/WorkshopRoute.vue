<script setup lang="ts">
import { inject, proxyRefs } from "vue";
import WorkshopPanel from "../components/WorkshopPanel.vue";
import { appRuntimeKey } from "../app/app-runtime-key";

const runtime = inject(appRuntimeKey);
if (!runtime) throw new Error("创意工坊未连接应用运行时");
const page = proxyRefs(runtime.workshop);
</script>

<template>
  <WorkshopPanel
    :terrain-mods="page.workshopTerrainMods"
    :terrain-mod-releases="page.remoteTerrainModReleases"
    :map-entries="page.workshopMapWorks"
    :saved-map-ids="page.configuredMaps.map((map) => map.definition.id)"
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
    @install-terrain-mod="page.installWorkshopTerrainMod"
    @cache-terrain-mod-release="page.cacheWorkshopTerrainModRelease"
    @unsubscribe-terrain-mod="page.unsubscribeWorkshopTerrainMod"
    @terrain-mod-opened="page.clearPendingWorkshopTerrainMod"
    @request-terrain-mod-preview="page.requestTerrainModPreview"
  />
</template>
