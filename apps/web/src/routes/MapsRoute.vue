<script setup lang="ts">
import { inject, proxyRefs, ref } from "vue";
import MapLibrary from "../components/MapLibrary.vue";
import { appRuntimeKey } from "../app/app-runtime-key";

const runtime = inject(appRuntimeKey);
if (!runtime) throw new Error("地图页未连接应用运行时");
const page = proxyRefs(runtime.maps);
const mapLibraryRef = ref<InstanceType<typeof MapLibrary> | null>(null);

async function addMap(code: string): Promise<void> {
  if (await page.addConfiguredMap(code)) mapLibraryRef.value?.clearCodeDraft(code);
}
</script>

<template>
  <MapLibrary
    ref="mapLibraryRef"
    :maps="page.configuredMaps"
    :selected-id="page.selectedMapLibraryId"
    :action-message="page.mapActionMessage"
    :action-error="page.mapActionError"
    :importing="page.mapImporting"
    :subscribed-mod-ids="page.subscribedModIds"
    @back="page.requestHome"
    @select="page.selectedMapLibraryId = $event"
    @add="addMap"
    @save="page.saveConfiguredMap"
    @remove="page.removeConfiguredMap"
  />
</template>
